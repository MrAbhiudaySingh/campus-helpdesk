const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'helpdesk.sqlite');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------------------------------------------------------------------------
// Schema. This mirrors the MySQL schema in /server/db/schema.mysql.sql
// (Appendix B of the project spec, extended with the remaining core tables
// plus the Smart Visit / Key Management tables). SQLite is used at runtime
// so the project runs with zero external DB setup; swap to MySQL using the
// .sql file + a mysql2 connector if your faculty requires MySQL specifically.
// ---------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('STUDENT','STAFF','LEAD','ADMIN','CUSTODIAN')) DEFAULT 'STUDENT',
  department_id INTEGER,
  status TEXT NOT NULL CHECK(status IN ('ACTIVE','INACTIVE')) DEFAULT 'ACTIVE',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (department_id) REFERENCES departments(id)
);

CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  default_department_id INTEGER,
  active INTEGER DEFAULT 1,
  FOREIGN KEY (default_department_id) REFERENCES departments(id)
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_no TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  location TEXT,
  location_type TEXT,   -- required on creation: Hostel Room / Academic / Admin Block / Library / Transport / Campus Grounds / Other. Decides Hostel-* vs Campus Facilities routing.
  category_id INTEGER,
  priority TEXT CHECK(priority IN ('LOW','MEDIUM','HIGH','CRITICAL')) DEFAULT 'MEDIUM',
  department_id INTEGER,
  assigned_to INTEGER,
  status TEXT CHECK(status IN ('OPEN','ASSIGNED','IN_PROGRESS','AWAITING_USER','AWAITING_REVIEW','RESOLVED','CLOSED','REOPENED')) DEFAULT 'OPEN',
  ai_summary TEXT,
  ai_reason TEXT,
  ai_confidence REAL,
  physical_visit_required INTEGER DEFAULT 0,
  access_mode_recommendation TEXT,
  resolution_notes TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (category_id) REFERENCES categories(id),
  FOREIGN KEY (department_id) REFERENCES departments(id),
  FOREIGN KEY (assigned_to) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  message TEXT NOT NULL,
  visibility TEXT CHECK(visibility IN ('PUBLIC','INTERNAL')) DEFAULT 'PUBLIC',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  file_name TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER,
  uploaded_by INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id),
  FOREIGN KEY (uploaded_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS ticket_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  actor_id INTEGER,
  action TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id),
  FOREIGN KEY (actor_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  ticket_id INTEGER,
  type TEXT,
  title TEXT,
  message TEXT,
  is_read INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (ticket_id) REFERENCES tickets(id)
);

-- Smart Visit & Availability (spec section 6.3A / 10.8)
CREATE TABLE IF NOT EXISTS visit_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  proposed_by INTEGER,
  student_windows TEXT,          -- JSON array of student-provided available windows
  technician_slot TEXT,          -- chosen/proposed slot (ISO datetime string)
  status TEXT CHECK(status IN ('PROPOSED','SCHEDULED','CHECKED_IN','MISSED','RESCHEDULE_REQUESTED','COMPLETED','CANCELLED')) DEFAULT 'PROPOSED',
  outcome_notes TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id),
  FOREIGN KEY (proposed_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_priority ON tickets(priority);
CREATE INDEX IF NOT EXISTS idx_tickets_dept_status ON tickets(department_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_assigned_status ON tickets(assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_tickets_created ON tickets(created_at);
CREATE INDEX IF NOT EXISTS idx_comments_ticket ON comments(ticket_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
`);

// Migration-safe: add tickets.location_type to DBs created before the real
// routing chart / Location Type field landed.
if (!db.prepare('PRAGMA table_info(tickets)').all().some((c) => c.name === 'location_type')) {
  db.exec('ALTER TABLE tickets ADD COLUMN location_type TEXT');
}

module.exports = db;
