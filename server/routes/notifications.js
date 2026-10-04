const express = require('express');
const db = require('../db/db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// GET /api/notifications — current user's notifications
router.get('/', authenticate, (req, res) => {
  const rows = db
    .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50')
    .all(req.user.id);
  res.json({ notifications: rows });
});

// PATCH /api/notifications/:id/read
router.patch('/:id/read', authenticate, (req, res) => {
  const notif = db.prepare('SELECT * FROM notifications WHERE id = ?').get(req.params.id);
  if (!notif || notif.user_id !== req.user.id) return res.status(404).json({ error: 'Notification not found.' });
  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').run(notif.id);
  res.json({ ok: true });
});

// PATCH /api/notifications/read-all
router.patch('/read-all', authenticate, (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

module.exports = router;
