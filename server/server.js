require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

require('./db/db'); // ensures schema is created on boot

const { warmUp } = require('./services/llm');
const authRoutes = require('./routes/auth');
const ticketRoutes = require('./routes/tickets');
const lookupRoutes = require('./routes/lookups');
const visitRoutes = require('./routes/visits');
const adminRoutes = require('./routes/admin');
const notificationRoutes = require('./routes/notifications');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

app.use('/api/auth', authRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api', lookupRoutes); // /api/departments, /api/categories
app.use('/api', visitRoutes); // /api/tickets/:id/visits, /api/visits/:id
app.use('/api/admin', adminRoutes);
app.use('/api/notifications', notificationRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'campus-helpdesk', time: new Date().toISOString() }));

// Serve the frontend (static SPA)
const clientDir = path.join(__dirname, '..', 'client');
app.use(express.static(clientDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(clientDir, 'index.html'));
});

// Central error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

// Warm the local LLM into memory BEFORE we start accepting requests, so the
// first real ticket after a restart doesn't eat a cold-load (~20-30s) and get
// bounced to the rules fallback. This only delays startup; per-request timeout
// budgets are untouched. Skipped entirely when TRIAGE_MODE=rules.
async function start() {
  const mode = (process.env.TRIAGE_MODE || 'llm').toLowerCase();
  if (mode === 'rules') {
    console.log('[triage] TRIAGE_MODE=rules — skipping Ollama warm-up.');
  } else {
    const r = await warmUp();
    if (r.ok) {
      console.log(`[triage] Ollama model "${r.model}" warmed up in ${(r.ms / 1000).toFixed(1)}s.`);
    } else {
      console.warn(`[triage] Ollama unreachable at startup (${r.error}) — will fall back to rules until available.`);
    }
  }
  app.listen(PORT, () => {
    console.log(`Campus AI Helpdesk server running at http://localhost:${PORT}`);
  });
}

start();
