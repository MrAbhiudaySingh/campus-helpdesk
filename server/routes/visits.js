const express = require('express');
const { authenticate, requireRole } = require('../middleware/auth');
const { proposeVisit, updateVisit } = require('../services/visitService');

const router = express.Router();

// Thin wrappers: auth guard + parse body + call the shared service in
// services/visitService.js (also used by db/seed.js) + map any thrown
// `err.status` to the HTTP response. No SQL / history / notify logic here.

// POST /api/tickets/:id/visits — student provides windows, or staff proposes a slot
router.post('/tickets/:id/visits', authenticate, (req, res) => {
  const { student_windows, technician_slot } = req.body || {};
  try {
    const visit = proposeVisit({
      ticket_id: req.params.id,
      proposed_by: req.user.id,
      student_windows,
      technician_slot,
    });
    res.status(201).json({ visit });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// PATCH /api/visits/:visitId — schedule / check-in / miss / complete
router.patch('/visits/:visitId', authenticate, requireRole('STAFF', 'LEAD', 'CUSTODIAN', 'ADMIN'), (req, res) => {
  const { status, technician_slot, outcome_notes } = req.body || {};
  try {
    const visit = updateVisit({
      visit_id: req.params.visitId,
      status,
      technician_slot,
      outcome_notes,
      actor_id: req.user.id,
    });
    res.json({ visit });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

module.exports = router;
