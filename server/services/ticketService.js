const db = require('../db/db');
const { runTriage, ALLOWED_LOCATION_TYPES } = require('./triage');
const { logHistory, notify, generateTicketNo } = require('./helpers');

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
const badRequest = (m) => httpError(400, m);
const notFound = (m) => httpError(404, m);

/**
 * The single place a ticket is created. Validate -> auto-triage (LLM first,
 * rule-engine fallback — `runTriage` never rejects) -> insert the row -> write
 * the CREATED + AI_TRIAGE + AI_TRIAGE_SOURCE ticket_history entries.
 *
 * Both `POST /api/tickets` and `db/seed.js` call this, so the seeded demo
 * tickets are classified by the exact same live triage engine as a real
 * ticket and can never drift out of sync with the current taxonomy.
 *
 * Throws an Error with `.status` on invalid input. `runTriage` always
 * resolves, so any other throw here is a genuine bug (the caller should 500).
 *
 * @returns {Promise<{ticketId:number, ticketNo:string, triage:object, triageSource:'llm'|'rules'}>}
 */
async function createTicket({ user_id, title, description, location, location_type, category_id }) {
  if (!user_id) throw badRequest('A reporter (user_id) is required.');
  if (!title || !title.trim()) throw badRequest('Title is required.');
  if (!description || !description.trim()) throw badRequest('Description is required.');
  if (!ALLOWED_LOCATION_TYPES.includes(location_type)) {
    throw badRequest(`location_type is required and must be one of: ${ALLOWED_LOCATION_TYPES.join(', ')}.`);
  }

  const ticketNo = generateTicketNo();
  const triage = await runTriage({ title, description, location, location_type });
  const triageSource = triage._source || 'rules';
  delete triage._source;

  const cat = category_id
    ? db.prepare('SELECT * FROM categories WHERE id = ?').get(category_id)
    : db.prepare('SELECT * FROM categories WHERE name = ?').get(triage.category);
  const dept = db.prepare('SELECT * FROM departments WHERE name = ?').get(triage.department);

  const info = db
    .prepare(
      `INSERT INTO tickets
        (ticket_no, user_id, title, description, location, location_type, category_id, priority, department_id,
         status, ai_summary, ai_reason, ai_confidence, physical_visit_required, access_mode_recommendation)
       VALUES (@ticket_no,@user_id,@title,@description,@location,@location_type,@category_id,@priority,@department_id,
               'OPEN',@ai_summary,@ai_reason,@ai_confidence,@physical_visit_required,@access_mode_recommendation)`
    )
    .run({
      ticket_no: ticketNo,
      user_id,
      title: title.trim(),
      description: description.trim(),
      location: location || null,
      location_type,
      category_id: cat ? cat.id : null,
      priority: triage.priority,
      department_id: dept ? dept.id : null,
      ai_summary: triage.summary,
      ai_reason: triage.reason,
      ai_confidence: triage.confidence,
      physical_visit_required: triage.physical_visit_required ? 1 : 0,
      access_mode_recommendation: triage.access_mode_recommendation,
    });

  const ticketId = info.lastInsertRowid;
  logHistory(ticketId, user_id, 'CREATED', null, 'OPEN');
  logHistory(ticketId, user_id, 'AI_TRIAGE', null, JSON.stringify(triage));
  logHistory(ticketId, user_id, 'AI_TRIAGE_SOURCE', null, triageSource);

  return { ticketId, ticketNo, triage, triageSource };
}

/**
 * Assign a ticket to a user and move it to ASSIGNED. Shared by
 * `POST /api/tickets/:id/assign` and `db/seed.js`.
 */
function assignTicket({ ticket_id, assigned_to, actor_id }) {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket_id);
  if (!ticket) throw notFound('Ticket not found.');
  if (!assigned_to) throw badRequest('assigned_to is required.');

  db.prepare("UPDATE tickets SET assigned_to = ?, status = 'ASSIGNED', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(
    assigned_to,
    ticket.id
  );
  logHistory(ticket.id, actor_id, 'ASSIGNED', ticket.assigned_to, assigned_to);
  notify(assigned_to, ticket.id, 'ASSIGNMENT', 'New ticket assigned', `Ticket ${ticket.ticket_no} has been assigned to you.`);
  notify(ticket.user_id, ticket.id, 'STATUS_CHANGE', 'Ticket assigned', `Your ticket ${ticket.ticket_no} has been assigned.`);

  return db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket.id);
}

/**
 * Add a comment to a ticket. `actorRole` gates INTERNAL visibility (students
 * can only post PUBLIC); a PUBLIC comment by someone other than the reporter
 * notifies the reporter. Shared by `POST /api/tickets/:id/comments` and seed.
 */
function addComment({ ticket_id, user_id, message, visibility, actorRole, actorName }) {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket_id);
  if (!ticket) throw notFound('Ticket not found.');
  if (!message || !message.trim()) throw badRequest('message is required.');

  let vis = 'PUBLIC';
  if (visibility === 'INTERNAL' && ['STAFF', 'LEAD', 'CUSTODIAN', 'ADMIN'].includes(actorRole)) vis = 'INTERNAL';

  const info = db
    .prepare('INSERT INTO comments (ticket_id, user_id, message, visibility) VALUES (?,?,?,?)')
    .run(ticket.id, user_id, message.trim(), vis);

  if (vis === 'PUBLIC' && user_id !== ticket.user_id) {
    notify(ticket.user_id, ticket.id, 'COMMENT', 'New reply on your ticket', `${actorName} replied to ${ticket.ticket_no}.`);
  }

  return db
    .prepare('SELECT cm.*, u.name AS author_name, u.role AS author_role FROM comments cm JOIN users u ON u.id = cm.user_id WHERE cm.id = ?')
    .get(info.lastInsertRowid);
}

/**
 * A department worker submitting completed work, OR an admin signing it off.
 * Same call, role decides the outcome:
 *   actorRole ADMIN  -> ticket becomes RESOLVED (final), reporter notified.
 *   otherwise        -> ticket becomes AWAITING_REVIEW, all admins notified.
 * `resolution_notes` is required either way and is stored on the ticket.
 * Shared by `POST /api/tickets/:id/resolve` and `db/seed.js`.
 */
function submitOrResolve({ ticket_id, actor_id, actorRole, actorName, resolution_notes }) {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket_id);
  if (!ticket) throw notFound('Ticket not found.');
  if (!resolution_notes || !resolution_notes.trim()) throw badRequest('resolution_notes is required.');

  const isAdmin = actorRole === 'ADMIN';
  const newStatus = isAdmin ? 'RESOLVED' : 'AWAITING_REVIEW';

  db.prepare('UPDATE tickets SET status = ?, resolution_notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
    newStatus,
    resolution_notes.trim(),
    ticket.id
  );
  logHistory(ticket.id, actor_id, isAdmin ? 'RESOLVED' : 'SUBMITTED_FOR_REVIEW', ticket.status, newStatus);

  if (isAdmin) {
    notify(ticket.user_id, ticket.id, 'STATUS_CHANGE', 'Ticket resolved', `Your ticket ${ticket.ticket_no} has been marked resolved.`);
  } else {
    // the reporter is the primary reviewer — they have 24h to confirm
    notify(ticket.user_id, ticket.id, 'STATUS_CHANGE', 'Is your problem solved?',
      `The team says ${ticket.ticket_no} is fixed. Open it to confirm, or let us know it still is not.`);
    for (const a of db.prepare("SELECT id FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE'").all()) {
      notify(a.id, ticket.id, 'STATUS_CHANGE', 'Ticket awaiting reporter confirmation',
        `${actorName} marked ${ticket.ticket_no} completed — waiting on the reporter (24h).`);
    }
  }
  return db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket.id);
}

module.exports = { createTicket, assignTicket, addComment, submitOrResolve };
