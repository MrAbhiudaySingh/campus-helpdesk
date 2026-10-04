const db = require('../db/db');
const { logHistory, notify } = require('./helpers');

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const VISIT_STATUSES = ['PROPOSED', 'SCHEDULED', 'CHECKED_IN', 'MISSED', 'RESCHEDULE_REQUESTED', 'COMPLETED', 'CANCELLED'];

// -------------------- Smart Visit --------------------

/** Propose a visit slot / windows for a ticket. Shared by the route + seed. */
function proposeVisit({ ticket_id, proposed_by, student_windows, technician_slot }) {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket_id);
  if (!ticket) throw httpError(404, 'Ticket not found.');

  const info = db
    .prepare(
      `INSERT INTO visit_requests (ticket_id, proposed_by, student_windows, technician_slot, status)
       VALUES (?,?,?,?,'PROPOSED')`
    )
    .run(ticket.id, proposed_by, student_windows ? JSON.stringify(student_windows) : null, technician_slot || null);

  logHistory(ticket.id, proposed_by, 'VISIT_PROPOSED', null, technician_slot || 'windows submitted');
  if (proposed_by !== ticket.user_id) {
    notify(ticket.user_id, ticket.id, 'VISIT', 'Visit slot proposed', `A visit slot was proposed for ticket ${ticket.ticket_no}.`);
  }
  return db.prepare('SELECT * FROM visit_requests WHERE id = ?').get(info.lastInsertRowid);
}

/** Move a visit through its state machine (SCHEDULED / CHECKED_IN / MISSED / COMPLETED …). */
function updateVisit({ visit_id, status, technician_slot, outcome_notes, actor_id }) {
  const visit = db.prepare('SELECT * FROM visit_requests WHERE id = ?').get(visit_id);
  if (!visit) throw httpError(404, 'Visit request not found.');
  if (status && !VISIT_STATUSES.includes(status)) throw httpError(400, 'Invalid status.');

  db.prepare(
    `UPDATE visit_requests SET
       status = COALESCE(?, status),
       technician_slot = COALESCE(?, technician_slot),
       outcome_notes = COALESCE(?, outcome_notes),
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(status || null, technician_slot || null, outcome_notes || null, visit.id);

  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(visit.ticket_id);
  logHistory(visit.ticket_id, actor_id, 'VISIT_UPDATED', visit.status, status || visit.status);

  if (status === 'MISSED') {
    notify(ticket.user_id, ticket.id, 'VISIT', 'Visit attempt missed', `Technician attempted a visit for ${ticket.ticket_no} but you were unavailable. Rescheduling will follow.`);
  } else if (status === 'SCHEDULED') {
    notify(ticket.user_id, ticket.id, 'VISIT', 'Visit scheduled', `A visit for ${ticket.ticket_no} has been scheduled.`);
  } else if (status === 'COMPLETED') {
    notify(ticket.user_id, ticket.id, 'VISIT', 'Visit completed', `The technician visit for ${ticket.ticket_no} is complete.`);
  }
  return db.prepare('SELECT * FROM visit_requests WHERE id = ?').get(visit.id);
}

module.exports = { proposeVisit, updateVisit };
