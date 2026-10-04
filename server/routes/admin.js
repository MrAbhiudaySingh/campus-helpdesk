const express = require('express');
const db = require('../db/db');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/admin/metrics — dashboard aggregates (Section 20.3)
router.get('/metrics', authenticate, requireRole('ADMIN'), (req, res) => {
  const byStatus = db.prepare('SELECT status, COUNT(*) AS count FROM tickets GROUP BY status').all();
  const byPriority = db.prepare('SELECT priority, COUNT(*) AS count FROM tickets GROUP BY priority').all();
  const byDepartment = db
    .prepare(
      `SELECT d.name AS department, COUNT(t.id) AS count
       FROM departments d LEFT JOIN tickets t ON t.department_id = d.id
       GROUP BY d.id ORDER BY count DESC`
    )
    .all();
  const totals = db.prepare('SELECT COUNT(*) AS total FROM tickets').get();
  const avgConfidence = db.prepare('SELECT AVG(ai_confidence) AS avg FROM tickets WHERE ai_confidence IS NOT NULL').get();

  // Ticket creation counts for the last 7 calendar days (UTC), oldest first,
  // WITH zero-count days filled in. The "New tickets" line chart renders this
  // array verbatim — no client-side computation, no gap-skipping.
  const dayRows = db
    .prepare(
      `SELECT date(created_at) AS day, COUNT(*) AS count
       FROM tickets
       WHERE date(created_at) >= date('now', '-6 days')
       GROUP BY date(created_at)`
    )
    .all();
  const dayCounts = Object.fromEntries(dayRows.map((r) => [r.day, r.count]));
  const last7Days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    last7Days.push({ date: key, count: dayCounts[key] || 0 });
  }

  res.json({
    totalTickets: totals.total,
    byStatus,
    byPriority,
    byDepartment,
    last7Days,
    avgAiConfidence: avgConfidence.avg ? Number(avgConfidence.avg.toFixed(2)) : null,
  });
});

// GET /api/admin/users
router.get('/users', authenticate, requireRole('ADMIN'), (req, res) => {
  const rows = db
    .prepare(
      `SELECT u.id, u.name, u.email, u.role, u.status, u.created_at, d.name AS department_name
       FROM users u LEFT JOIN departments d ON d.id = u.department_id ORDER BY u.created_at DESC`
    )
    .all();
  res.json({ users: rows });
});

// PATCH /api/admin/users/:id — change role/department/status
router.patch('/users/:id', authenticate, requireRole('ADMIN'), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const { role, department_id, status } = req.body || {};
  const allowedRoles = ['STUDENT', 'STAFF', 'LEAD', 'ADMIN', 'CUSTODIAN'];
  if (role && !allowedRoles.includes(role)) return res.status(400).json({ error: 'Invalid role.' });

  db.prepare(
    'UPDATE users SET role = COALESCE(?, role), department_id = COALESCE(?, department_id), status = COALESCE(?, status) WHERE id = ?'
  ).run(role || null, department_id || null, status || null, user.id);

  res.json({ user: db.prepare('SELECT id, name, email, role, department_id, status FROM users WHERE id = ?').get(user.id) });
});

module.exports = router;
