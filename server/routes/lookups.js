const express = require('express');
const db = require('../db/db');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/departments
router.get('/departments', authenticate, (req, res) => {
  const rows = db.prepare('SELECT * FROM departments WHERE active = 1 ORDER BY name').all();
  res.json({ departments: rows });
});

// GET /api/categories
router.get('/categories', authenticate, (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.*, d.name AS default_department_name
       FROM categories c LEFT JOIN departments d ON d.id = c.default_department_id
       WHERE c.active = 1 ORDER BY c.name`
    )
    .all();
  res.json({ categories: rows });
});

// POST /api/departments (Admin only — Section 5, role: Administrator)
router.post('/departments', authenticate, requireRole('ADMIN'), (req, res) => {
  const { name, description } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required.' });
  const info = db.prepare('INSERT INTO departments (name, description) VALUES (?,?)').run(name, description || null);
  res.status(201).json({ department: db.prepare('SELECT * FROM departments WHERE id = ?').get(info.lastInsertRowid) });
});

// POST /api/categories (Admin only)
router.post('/categories', authenticate, requireRole('ADMIN'), (req, res) => {
  const { name, description, default_department_id } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required.' });
  const info = db
    .prepare('INSERT INTO categories (name, description, default_department_id) VALUES (?,?,?)')
    .run(name, description || null, default_department_id || null);
  res.status(201).json({ category: db.prepare('SELECT * FROM categories WHERE id = ?').get(info.lastInsertRowid) });
});

module.exports = router;
