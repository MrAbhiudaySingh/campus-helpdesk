const db = require('../db/db');

function logHistory(ticketId, actorId, action, oldValue, newValue) {
  db.prepare(
    'INSERT INTO ticket_history (ticket_id, actor_id, action, old_value, new_value) VALUES (?,?,?,?,?)'
  ).run(ticketId, actorId || null, action, oldValue != null ? String(oldValue) : null, newValue != null ? String(newValue) : null);
}

function notify(userId, ticketId, type, title, message) {
  if (!userId) return;
  db.prepare(
    'INSERT INTO notifications (user_id, ticket_id, type, title, message) VALUES (?,?,?,?,?)'
  ).run(userId, ticketId || null, type, title, message);
}

function generateTicketNo() {
  const row = db.prepare('SELECT COUNT(*) AS c FROM tickets').get();
  const seq = row.c + 1001;
  return `TCK-${String(seq).padStart(5, '0')}`;
}

function canAccessTicket(user, ticket) {
  if (user.role === 'ADMIN') return true;
  if (user.role === 'STUDENT') return ticket.user_id === user.id;
  // STAFF / LEAD / CUSTODIAN are all department workers: their own
  // department's tickets, or ones assigned to them.
  if (['STAFF', 'LEAD', 'CUSTODIAN'].includes(user.role)) {
    return ticket.department_id === user.department_id || ticket.assigned_to === user.id;
  }
  return false;
}

module.exports = { logHistory, notify, generateTicketNo, canAccessTicket };
