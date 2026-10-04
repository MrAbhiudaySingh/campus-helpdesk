# Campus AI Helpdesk Ticketing System — v2 (Auto-Triage & Smart Visit)

A runnable implementation of the project blueprint: a full-stack campus
support ticketing system with rule-based AI auto-triage, department-scoped
role-based access (Student / Staff / Department Lead / Admin), and the Smart
Visit & Availability module. Tickets are only ever visible to the reporter,
the owning department, and admins.

## Stack

- **Backend:** Node.js + Express, JWT auth, bcrypt password hashing
- **Database:** SQLite (via `better-sqlite3`) at runtime — zero external
  setup required. A full **MySQL** reference schema matching the spec's
  Appendix B (extended with all core tables) is provided
  at `server/db/schema.mysql.sql` if your course requires MySQL specifically.
- **Frontend:** Plain HTML/CSS/JS single-page app served by Express (no
  build step, so `npm start` is all that's needed) — React was optional
  per the spec; this keeps the project trivially runnable for a demo/viva.
- **AI Auto-Triage:** a **local LLM** (Qwen2.5 via [Ollama](https://ollama.com))
  classifies each ticket into the exact JSON contract the spec describes
  (category, priority, department, summary, reason, suggested_next_action,
  confidence, physical_visit_required, access_mode_recommendation). Every
  field the model returns is validated against the DB's configured
  categories/departments/priorities before it's trusted; on any timeout,
  error, or invalid field the engine falls back to a deterministic,
  explainable **rule-based classifier** (`ruleBasedTriage` in
  `server/services/triage.js`) so a ticket is never left un-triaged. Set
  `TRIAGE_MODE=rules` to run fully offline with no model. See
  [Auto-triage configuration](#auto-triage-configuration).

## How AI is integrated

The helpdesk is **local-AI first**. Every AI call goes through one function,
`chat()` in `server/services/llm.js`, which tries providers in this order:

1. **Local model (priority).** Qwen2.5 7B served by [Ollama](https://ollama.com)
   on the same machine. Ticket text never leaves campus, there's no per-call
   cost, and it works offline. The server warms the model into memory on startup.
2. **Cloud API key (fallback).** If the local model is down, times out, or
   returns garbage, and `FALLBACK_API_KEY` is set, the exact same prompt goes
   to any OpenAI-compatible API (OpenAI, Groq, OpenRouter, Gemini's OpenAI
   endpoint…). Leave the key empty to stay 100% local.
3. **Rule engine (last resort).** If every model fails, a deterministic
   keyword classifier (`ruleBasedTriage`) takes over, so a ticket is never
   lost or left un-triaged.

The AI is used in two places:

- **Auto-triage.** Each new ticket is classified into strict JSON (category,
  priority, department, summary, reason, next action, confidence, visit
  needed). Nothing the model says is trusted blindly: every field is checked
  against the live DB taxonomy and location rules (e.g. hostel vs. campus
  routing) before it's saved.
- **Self-help before filing.** When a student hits *Submit*, the AI first
  suggests up to 4 safe quick fixes, e.g. *"Wi-Fi not working" → turn Wi-Fi off
  and on, restart the device, try another device.* If one works, the student
  clicks **That fixed it** and no ticket is filed; otherwise **Still not
  working — create ticket** files it as usual. Safety issues (fire, smoke,
  sparks, intruders…) are caught by the rule engine *before* the AI is asked
  and go straight to a ticket, and physical repairs get no suggestions. If no
  AI is reachable the step is skipped silently.
  (`POST /api/tickets/self-help`)

## Quick start

```bash
cd server
npm install        # already run for you if you unzip this as-is
npm run seed        # routing taxonomy + 5 demo accounts + a small varied set of demo tickets
npm start            # http://localhost:4000
```

Open `http://localhost:4000` in a browser.

### Accounts

The seed creates five accounts — a bootstrap admin plus four demo accounts for
trying each role. **None of them is shown anywhere in the UI**; they are
documented here only. Replace `*at*` with `@` (README-authoring workaround —
the seeded accounts use real `@` addresses, printed by `npm run seed`).

| Role                  | Email                            | Password      | Department                     |
|-----------------------|----------------------------------|---------------|--------------------------------|
| Admin                 | admin *at* campus.edu            | Admin@123     | —                              |
| IT staff              | rahul.it *at* campus.edu         | Staff@123     | Tech Support                   |
| Facilities lead       | priya.facilities *at* campus.edu | Staff@123     | Warden / Hostel Administration |
| Warden (hostel)       | warden *at* campus.edu           | Custodian@123 | Warden / Hostel Administration  |
| Student               | abhiuday.student *at* campus.edu | Student@123   | —                              |

**Anyone else self-registers.** `POST /api/auth/register` (the "Create a
student account" link on the login screen) always creates the account as
`role = STUDENT` — the role is hard-coded server-side and cannot be set or
overridden by the client. To give someone staff / lead / admin access, the
admin opens the **Users** page and changes their role (and assigns a
department) via `PATCH /api/admin/users/:id`. So the real flow is: user
self-registers as a student → admin promotes them.

A small varied set of demo tickets is seeded (Wi-Fi, an AC issue reported in
both a hostel room and an academic block to show the location split, a
safety/CRITICAL one, library, transport, hostel electrical, projector), all
filed as the demo student through the same `ticketService.createTicket()` the
API route uses — so their category / department / priority / AI summary are
whatever the **current** triage engine produces, never hand-written. Two are
then progressed through the real lifecycle via the same service functions the
routes call: one assigned with a public reply and an internal note, one with a
Smart Visit proposed -> scheduled -> checked in. `npm run seed` is idempotent:
re-running it never duplicates the accounts or the tickets.

## Ticket routing (real chart — source of truth)

Auto-triage classifies every new ticket against this table
(`server/services/triage.js`, seeded by `server/db/seed.js`):

| Category              | Example complaints                                              | Department                    |
|-----------------------|----------------------------------------------------------------|-------------------------------|
| Wi-Fi / Network       | Wi-Fi not working, slow internet, LAN, connectivity            | Tech Support                  |
| Account / Software    | Login, LMS, account access, software install, app errors        | Tech Support                  |
| Classroom / AV        | Projector, microphone, speaker/display, classroom equipment     | AV Support                    |
| Hostel – Electrical   | Room light, fan, faulty socket, wiring (in a hostel room)       | Warden / Hostel Administration |
| Hostel – Plumbing     | Water leakage, tap/shower, no water, drainage (in a hostel room)| Warden / Hostel Administration |
| Hostel – Furniture    | Broken bed, chair, table, cupboard (in a hostel room)           | Warden / Hostel Administration |
| Hostel – AC / HVAC    | AC not cooling, AC leakage, ventilation (in a hostel room)      | Warden / Hostel Administration |
| Hostel – Housekeeping  | Room / washroom / common-area cleaning                          | Warden / Hostel Administration |
| Campus Facilities     | Electrical or plumbing in academic/admin blocks, general infra  | Gateway                       |
| Transport             | Bus schedule, shuttle problems                                  | Gateway                       |
| General               | Anything not covered above                                      | Gateway                       |
| Security              | Unauthorized access, suspicious activity, safety                | Campus Security               |
| Library               | Library access, equipment, resource issues                      | Library Services              |

**Departments (exactly six):** Tech Support, AV Support,
Warden / Hostel Administration, Gateway, Campus Security, Library Services.

### Why there's a "Location Type" field

Electrical, plumbing, AC/HVAC, furniture and housekeeping issues route to
**two different departments depending on where they happen** — a hostel room
is the Warden's job, an academic/admin block is Gateway's ("Campus
Facilities"). The description text is identical either way ("the AC is
leaking"), so keyword matching alone can't decide this.

So ticket creation has a required **Location Type** dropdown —
`Hostel Room`, `Academic / Admin Block`, `Library`,
`Transport / Campus Grounds`, `Other` — alongside the free-text location.
The triage engine uses it as the deciding factor:

- Keyword matching still decides the **issue type** (electrical vs plumbing
  vs AC vs furniture vs housekeeping).
- **Location Type** decides which of the two departments it lands in:
  `Hostel Room` + one of those issue types → Warden / Hostel Administration
  under the matching `Hostel – *` category; any other Location Type →
  Gateway under `Campus Facilities`.
- Wi-Fi/Network, Account/Software, Classroom/AV, Transport, Security and
  Library are **not** location-dependent — same routing regardless.
- Safety/security keywords (fire, intruder, unauthorized access, …) still
  short-circuit to Campus Security first, regardless of Location Type
  (Section 12.1 rule order).

Stored on the ticket as `tickets.location_type` (see
`server/db/db.js` / `server/db/schema.mysql.sql`). It's a real reporter-
supplied field, not something inferred from text — this holds whether the
LLM or the rule engine does the classifying.

## Auto-triage configuration

Auto-triage runs a **local LLM first, optional cloud API second, rule engine last**
(`server/services/triage.js` + `server/services/llm.js`). Env vars
(`server/.env`, copy from `server/.env.example`):

| Var            | Default                  | Meaning                                                            |
|----------------|--------------------------|-------------------------------------------------------------------|
| `TRIAGE_MODE`  | `llm`                    | `llm` = call the model then validate/fall back; `rules` = skip the model entirely |
| `OLLAMA_HOST`  | `http://localhost:11434` | Where the Ollama server is listening                              |
| `OLLAMA_MODEL` | `qwen2.5:7b-instruct`    | Model tag to use for `/api/chat` (must be `ollama pull`ed already) |
| `FALLBACK_API_KEY` | *(empty = off)*      | API key for the cloud fallback, used only when the local model fails |
| `FALLBACK_API_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible base URL (e.g. `https://api.groq.com/openai/v1`) |
| `FALLBACK_MODEL`   | `gpt-4o-mini`        | Model name at that provider                                        |

On startup the server sends a one-time warm-up ping to the model so the first
real ticket doesn't pay the cold model-load cost (it logs `Ollama model "..."
warmed up in Xs`, or a fall-back-to-rules warning if Ollama is unreachable).

(`OLLAMA_TIMEOUT_MS`, default `20000` (a warm qwen2.5:7b triage call still takes
~12-15s), is also honoured if you need to
loosen the per-request abort on a slow first call.)

### Running with the LLM (default)

```bash
# one-time: install Ollama (https://ollama.com/download) and pull the model
ollama pull qwen2.5:7b-instruct
ollama serve            # if not already running as a service

cd server && npm start  # TRIAGE_MODE=llm is the default
```

Each new ticket is classified by the model; the create response includes
`"triage_source": "llm"` (or `"rules"` if it fell back), and a
`AI_TRIAGE_SOURCE` / `RE_TRIAGE_SOURCE` row is written to `ticket_history`
so you can see which path handled every ticket.

### Running without the LLM (offline demo / viva)

Set `TRIAGE_MODE=rules` in `server/.env` (or `TRIAGE_MODE=rules npm start`).
No Ollama needed — the deterministic keyword engine handles everything and
`triage_source` is always `"rules"`. This is also what happens
automatically if `TRIAGE_MODE=llm` but Ollama is unreachable or the model
returns something invalid.

## What's implemented (mapped to the spec)

- **Section 6.1** Auth: register/login/logout, bcrypt hashing, JWT,
  role-protected routes, profile update.
- **Section 6.2/6.3** Ticket creation with client+server validation,
  auto-triage run on creation, staff can correct category/priority/
  department/status, every change is timestamped in `ticket_history`.
- **Section 6.3A** Smart Visit & Availability: visit proposals,
  schedule/check-in/miss/reschedule/complete states, full audit trail in
  `ticket_history`.
- **Section 6.4** Full status lifecycle — OPEN / ASSIGNED / IN_PROGRESS /
  AWAITING_USER / RESOLVED / CLOSED / REOPENED. Department staff/leads close
  their own department's tickets (Close button on the ticket, or the status
  field); the reporter can reopen a RESOLVED/CLOSED ticket.
- **Section 6.5** Public comments, internal-only staff notes, resolution
  notes required to resolve, in-app notifications on status/comment/
  assignment events.
- **Section 11/12** Rule-based auto-triage pipeline with the exact output
  contract, rule order (safety first), and DB-validated category/
  department before being saved.
- **Section 14/15** Database design and REST API surface as specified
  (`/api/tickets`, `/api/tickets/:id/triage`, `/api/tickets/:id/assign`,
  `/api/tickets/:id/resolve`, `/api/tickets/:id/reopen`, `/api/departments`,
  `/api/categories`, `/api/admin/metrics`, plus the visit endpoints
  (`/api/tickets/:id/visits`, `/api/visits/:id`) from 6.3A).
- **Section 18/5.1** Backend-enforced authorization on every protected
  route (never relies on the frontend hiding a button).
- **Section 20.3** Admin metrics dashboard (totals, by status / priority /
  department, new-tickets-per-day trend, average AI confidence).

## Not implemented / simplified (good "future enhancements" talking points for the viva)

- File attachments are modeled in the schema (`attachments` table) but
  the upload endpoint isn't wired up in this pass — see spec Section 6.2.
- Password reset / forgot-password flow (Section 6.1) is out of scope
  for this pass.
- The auto-triage LLM is a **local** model (Qwen2.5 via Ollama), not a
  hosted API — no API key, no data leaves the machine. It still falls back
  to the deterministic rule engine on any failure, and `TRIAGE_MODE=rules`
  disables it entirely for a no-dependency demo. See
  [Auto-triage configuration](#auto-triage-configuration).
- Real-time notifications (websockets) — notifications are stored and
  polled via `GET /api/notifications`, not pushed live.

## Folder structure

```
campus-helpdesk/
  server/
    server.js              Express app entrypoint
    db/db.js                SQLite schema + connection (runtime DB)
    db/schema.mysql.sql     Reference MySQL schema (Appendix B, extended)
    db/seed.js               Seeds taxonomy + admin + 4 demo accounts + 1 demo ticket (via ticketService, idempotent)
    services/ticketService.js  createTicket(): validate + triage + insert + history — shared by the API route and seed.js
    middleware/auth.js       JWT auth + role guard
    routes/                  auth, tickets, visits/keys, lookups, admin, notifications
    services/triage.js       Auto-triage: local LLM first, rule engine fallback + DB validation
    services/llm.js          Ollama /api/chat client (Qwen2.5) + startup warm-up; built-in fetch
    services/helpers.js      History logging, notifications, ticket-no generator
  client/
    index.html, css/, js/    Static single-page frontend (no build step)
```

## Switching to MySQL (optional)

1. `mysql < server/db/schema.mysql.sql` against your MySQL instance.
2. Replace `server/db/db.js` with a `mysql2` connection pool using the
   same table/column names — the route files use plain SQL strings via
   `db.prepare(...).get/all/run(...)`, so only that one file needs to change
   (swap to `pool.query`/parameterized queries with `?` placeholders,
   which mysql2 also supports).
