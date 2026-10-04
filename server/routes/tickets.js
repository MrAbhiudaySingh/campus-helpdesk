const express = require('express');
const db = require('../db/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { runTriage, ruleBasedTriage } = require('../services/triage');
const { selfHelp } = require('../services/llm');
const { logHistory, notify, canAccessTicket } = require('../services/helpers');
const { createTicket, assignTicket, addComment, submitOrResolve } = require('../services/ticketService');

const router = express.Router();

// After a department submits a ticket for review, the reporter gets 24h to
// confirm "fixed" / "not fixed". Only after that window closes may an admin
// close it on the reporter's behalf. The submission time is the newest
// SUBMITTED_FOR_REVIEW history row.
const REPORTER_WINDOW_MS = 24 * 60 * 60 * 1000;
function reviewSubmittedMs(ticketId) {
  const row = db
    .prepare("SELECT created_at FROM ticket_history WHERE ticket_id = ? AND action = 'SUBMITTED_FOR_REVIEW' ORDER BY id DESC LIMIT 1")
    .get(ticketId);
  if (!row || !row.created_at) return null;
  const t = Date.parse(String(row.created_at).replace(' ', 'T') + 'Z');
  return Number.isNaN(t) ? null : t;
}
function reporterWindowOpen(ticket) {
  if (ticket.status !== 'AWAITING_REVIEW') return false;
  const t = reviewSubmittedMs(ticket.id);
  return t != null && Date.now() - t < REPORTER_WINDOW_MS;
}

function getTicketFull(id) {
  const ticket = db
    .prepare(
      `SELECT t.*, u.name AS reporter_name, u.email AS reporter_email,
              c.name AS category_name, d.name AS department_name,
              a.name AS assigned_name
       FROM tickets t
       JOIN users u ON u.id = t.user_id
       LEFT JOIN categories c ON c.id = t.category_id
       LEFT JOIN departments d ON d.id = t.department_id
       LEFT JOIN users a ON a.id = t.assigned_to
       WHERE t.id = ?`
    )
    .get(id);
  return ticket;
}

// GET /api/tickets — list accessible tickets, with role-based scoping + filters
router.get('/', authenticate, (req, res) => {
  const { status, priority, department_id, q } = req.query;
  const clauses = [];
  const params = {};

  if (req.user.role === 'STUDENT') {
    clauses.push('t.user_id = @uid');
    params.uid = req.user.id;
  } else if (req.user.role === 'ADMIN') {
    // ADMIN sees every ticket.
  } else {
    // STAFF / LEAD / CUSTODIAN and any other non-admin role: only their own
    // department's tickets (or ones assigned to them). A user with no
    // department sees only what is assigned to them.
    clauses.push('(t.department_id = @dept OR t.assigned_to = @uid)');
    params.dept = req.user.department_id;
    params.uid = req.user.id;
  }

  if (status) {
    clauses.push('t.status = @status');
    params.status = status;
  }
  if (priority) {
    clauses.push('t.priority = @priority');
    params.priority = priority;
  }
  if (department_id) {
    clauses.push('t.department_id = @department_id');
    params.department_id = department_id;
  }
  if (q) {
    clauses.push('(t.title LIKE @q OR t.description LIKE @q OR t.ticket_no LIKE @q)');
    params.q = `%${q}%`;
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT t.id, t.ticket_no, t.title, t.status, t.priority, t.created_at, t.updated_at,
              t.physical_visit_required, t.location_type,
              u.name AS reporter_name, c.name AS category_name, d.name AS department_name,
              a.name AS assigned_name
       FROM tickets t
       JOIN users u ON u.id = t.user_id
       LEFT JOIN categories c ON c.id = t.category_id
       LEFT JOIN departments d ON d.id = t.department_id
       LEFT JOIN users a ON a.id = t.assigned_to
       ${where}
       ORDER BY t.created_at DESC`
    )
    .all(params);

  res.json({ tickets: rows });
});

// POST /api/tickets/self-help — quick fixes to try BEFORE filing a ticket
// (e.g. "Wi-Fi down" -> toggle Wi-Fi, re-join). Never blocks filing: on any
// AI failure, or for safety issues, it returns no steps and the client files
// the ticket straight away. The deterministic Security check runs first so an
// emergency never waits on (or gets talked out of) by a model.
router.post('/self-help', authenticate, requireRole('STUDENT', 'STAFF', 'ADMIN'), async (req, res) => {
  const { title, description, location_type } = req.body || {};
  if (!String(title || '').trim() && !String(description || '').trim()) return res.json({ steps: [] });
  const rules = ruleBasedTriage({ title, description, location_type });
  if (rules.category === 'Security' || rules.priority === 'CRITICAL') return res.json({ steps: [] });
  if ((process.env.TRIAGE_MODE || 'llm').toLowerCase() === 'rules') return res.json({ steps: [] });
  try {
    res.json(await selfHelp({ title, description }));
  } catch (err) {
    console.warn(`[self-help] no AI available (${err.message}) — skipping.`);
    res.json({ steps: [] });
  }
});

// POST /api/tickets — create ticket + run auto-triage (Sections 6.2, 6.3).
// All the work (validation, triage, insert, history) lives in
// services/ticketService.createTicket, shared with db/seed.js.
router.post('/', authenticate, requireRole('STUDENT', 'STAFF', 'ADMIN'), async (req, res) => {
  const { title, description, location, location_type, category_id } = req.body || {};
  try {
    const { ticketId, ticketNo, triage, triageSource } = await createTicket({
      user_id: req.user.id,
      title,
      description,
      location,
      location_type,
      category_id,
    });

    res.status(201).json({
      ticketNo,
      status: 'OPEN',
      triage_source: triageSource,
      triage: {
        category: triage.category,
        priority: triage.priority,
        department: triage.department,
        summary: triage.summary,
        reason: triage.reason,
        confidence: triage.confidence,
        physical_visit_required: triage.physical_visit_required,
        access_mode_recommendation: triage.access_mode_recommendation,
      },
      ticket: getTicketFull(ticketId),
    });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error('[tickets] create failed:', err);
    res.status(500).json({ error: 'Could not create the ticket — auto-triage failed unexpectedly.' });
  }
});

// GET /api/tickets/:id
router.get('/:id', authenticate, (req, res) => {
  const ticket = getTicketFull(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });
  if (!canAccessTicket(req.user, ticket)) return res.status(403).json({ error: 'Access denied.' });

  const comments = db
    .prepare(
      `SELECT cm.*, u.name AS author_name, u.role AS author_role
       FROM comments cm JOIN users u ON u.id = cm.user_id
       WHERE cm.ticket_id = ? ${req.user.role === 'STUDENT' ? "AND cm.visibility = 'PUBLIC'" : ''}
       ORDER BY cm.created_at ASC`
    )
    .all(ticket.id);
  const history = db
    .prepare(
      `SELECT h.*, u.name AS actor_name FROM ticket_history h
       LEFT JOIN users u ON u.id = h.actor_id WHERE h.ticket_id = ? ORDER BY h.created_at ASC`
    )
    .all(ticket.id);
  const visits = db.prepare('SELECT * FROM visit_requests WHERE ticket_id = ? ORDER BY created_at DESC').all(ticket.id);

  res.json({ ticket, comments, history, visits });
});

// PATCH /api/tickets/:id — department worker / admin correct category / priority /
// department / status (Section 6.3). Only an ADMIN may set RESOLVED or CLOSED —
// a department submits work via POST /:id/resolve, which parks non-admins at
// AWAITING_REVIEW for the admin to sign off.
router.patch('/:id', authenticate, requireRole('STAFF', 'LEAD', 'CUSTODIAN', 'ADMIN'), (req, res) => {
  const ticket = getTicketFull(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });
  if (!canAccessTicket(req.user, ticket)) return res.status(403).json({ error: 'Access denied.' });

  if (['RESOLVED', 'CLOSED'].includes(req.body.status)) {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({
        error: 'Only an admin can resolve or close a ticket. Use "Mark completed — send for review" instead.',
      });
    }
    if (reporterWindowOpen(ticket)) {
      return res.status(403).json({
        error: 'The reporter still has time to confirm this ticket. You can close it after 24 hours with no response.',
      });
    }
  }

  const allowedFields = ['category_id', 'priority', 'department_id', 'status', 'assigned_to'];
  const updates = [];
  const params = {};
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = @${field}`);
      params[field] = req.body[field];
      logHistory(ticket.id, req.user.id, `UPDATED_${field.toUpperCase()}`, ticket[field], req.body[field]);
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'No valid fields to update.' });

  params.id = ticket.id;
  db.prepare(`UPDATE tickets SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = @id`).run(params);

  if (req.body.status) {
    notify(ticket.user_id, ticket.id, 'STATUS_CHANGE', 'Ticket status updated', `Your ticket ${ticket.ticket_no} is now ${req.body.status}.`);
  }

  res.json({ ticket: getTicketFull(ticket.id) });
});

// POST /api/tickets/:id/comments — logic in ticketService.addComment
router.post('/:id/comments', authenticate, (req, res) => {
  const ticket = getTicketFull(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });
  if (!canAccessTicket(req.user, ticket)) return res.status(403).json({ error: 'Access denied.' });

  try {
    const comment = addComment({
      ticket_id: ticket.id,
      user_id: req.user.id,
      message: (req.body || {}).message,
      visibility: (req.body || {}).visibility,
      actorRole: req.user.role,
      actorName: req.user.name,
    });
    res.status(201).json({ comment });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// POST /api/tickets/:id/triage — re-run auto-triage (Section 6.3)
router.post('/:id/triage', authenticate, requireRole('STAFF', 'LEAD', 'CUSTODIAN', 'ADMIN'), async (req, res) => {
  const ticket = getTicketFull(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });

  try {
  const triage = await runTriage({ title: ticket.title, description: ticket.description, location: ticket.location, location_type: ticket.location_type });
  const triageSource = triage._source || 'rules';
  delete triage._source;
  const cat = db.prepare('SELECT * FROM categories WHERE name = ?').get(triage.category);
  const dept = db.prepare('SELECT * FROM departments WHERE name = ?').get(triage.department);

  db.prepare(
    `UPDATE tickets SET category_id=?, priority=?, department_id=?, ai_summary=?, ai_reason=?, ai_confidence=?,
     physical_visit_required=?, access_mode_recommendation=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`
  ).run(
    cat ? cat.id : null,
    triage.priority,
    dept ? dept.id : null,
    triage.summary,
    triage.reason,
    triage.confidence,
    triage.physical_visit_required ? 1 : 0,
    triage.access_mode_recommendation,
    ticket.id
  );
  logHistory(ticket.id, req.user.id, 'RE_TRIAGE', ticket.priority, triage.priority);
  logHistory(ticket.id, req.user.id, 'RE_TRIAGE_SOURCE', null, triageSource);

  res.json({ triage_source: triageSource, triage, ticket: getTicketFull(ticket.id) });
  } catch (err) {
    console.error('[tickets] re-triage failed:', err);
    res.status(500).json({ error: 'Re-triage failed unexpectedly.' });
  }
});

// POST /api/tickets/:id/assign — logic in ticketService.assignTicket
router.post('/:id/assign', authenticate, requireRole('LEAD', 'ADMIN'), (req, res) => {
  try {
    const ticket = assignTicket({
      ticket_id: req.params.id,
      assigned_to: (req.body || {}).assigned_to,
      actor_id: req.user.id,
    });
    res.json({ ticket: getTicketFull(ticket.id) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// POST /api/tickets/:id/resolve — resolution / completion notes required.
//   ADMIN                       -> ticket is RESOLVED (final sign-off).
//   STAFF / LEAD / CUSTODIAN    -> ticket goes to AWAITING_REVIEW; the notes are
//                                 the department's completion summary for the
//                                 admin, who then resolves or returns it.
router.post('/:id/resolve', authenticate, requireRole('STAFF', 'LEAD', 'CUSTODIAN', 'ADMIN'), (req, res) => {
  const ticket = getTicketFull(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });
  if (!canAccessTicket(req.user, ticket)) return res.status(403).json({ error: 'Access denied.' });
  if (req.user.role === 'ADMIN' && reporterWindowOpen(ticket)) {
    return res.status(403).json({
      error: 'The reporter still has time to confirm this ticket. You can resolve it after 24 hours with no response.',
    });
  }
  try {
    submitOrResolve({
      ticket_id: ticket.id,
      actor_id: req.user.id,
      actorRole: req.user.role,
      actorName: req.user.name,
      resolution_notes: (req.body || {}).resolution_notes,
    });
    res.json({ ticket: getTicketFull(ticket.id) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// POST /api/tickets/:id/confirm — the REPORTER confirms the department's fix.
//   { solved: true }  -> ticket is CLOSED, no admin needed.
//   { solved: false } -> ticket goes back to IN_PROGRESS for more work.
// Only valid while the ticket is AWAITING_REVIEW.
router.post('/:id/confirm', authenticate, (req, res) => {
  const ticket = getTicketFull(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });
  if (ticket.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Only the person who reported this ticket can confirm it.' });
  }
  if (ticket.status !== 'AWAITING_REVIEW') {
    return res.status(400).json({ error: 'This ticket is not waiting for your confirmation.' });
  }

  const solved = (req.body || {}).solved === true;
  const newStatus = solved ? 'CLOSED' : 'IN_PROGRESS';

  db.prepare('UPDATE tickets SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newStatus, ticket.id);
  logHistory(ticket.id, req.user.id, solved ? 'REPORTER_CONFIRMED' : 'REPORTER_REJECTED', ticket.status, newStatus);

  const targets = new Set();
  if (ticket.assigned_to) targets.add(ticket.assigned_to);
  for (const a of db.prepare("SELECT id FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE'").all()) targets.add(a.id);
  for (const uid of targets) {
    notify(
      uid,
      ticket.id,
      'STATUS_CHANGE',
      solved ? 'Ticket confirmed fixed' : 'Reporter says it is not fixed',
      solved
        ? `${req.user.name} confirmed ${ticket.ticket_no} is fixed — it has been closed.`
        : `${req.user.name} says ${ticket.ticket_no} is still not fixed — it is back with the department.`
    );
  }

  res.json({ ticket: getTicketFull(ticket.id) });
});

// POST /api/tickets/:id/reopen
router.post('/:id/reopen', authenticate, (req, res) => {
  const ticket = getTicketFull(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });
  if (req.user.role === 'STUDENT' && ticket.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied.' });
  }
  if (!['RESOLVED', 'CLOSED'].includes(ticket.status)) {
    return res.status(400).json({ error: 'Only resolved or closed tickets can be reopened.' });
  }

  db.prepare("UPDATE tickets SET status = 'REOPENED', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(ticket.id);
  logHistory(ticket.id, req.user.id, 'REOPENED', ticket.status, 'REOPENED');
  if (ticket.assigned_to) {
    notify(ticket.assigned_to, ticket.id, 'STATUS_CHANGE', 'Ticket reopened', `Ticket ${ticket.ticket_no} was reopened.`);
  }

  res.json({ ticket: getTicketFull(ticket.id) });
});

module.exports = router;
