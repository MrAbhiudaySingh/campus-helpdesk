-- =============================================================================
-- Campus AI Helpdesk Ticketing System — MySQL reference schema
-- Matches Appendix B of the project spec, extended with the remaining core
-- tables (comments, attachments, ticket_history, notifications) and the
-- Smart Visit / Key Management tables (Section 6.3A / 10.8).
--
-- The application runs on SQLite by default (server/db/db.js) so it works
-- with zero external setup. If your course specifically requires MySQL,
-- run this file against MySQL 8.x and swap db.js for a mysql2 connection
-- pool using the same table/column names.
-- =============================================================================

CREATE TABLE users (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(180) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('STUDENT','STAFF','LEAD','ADMIN','CUSTODIAN') NOT NULL DEFAULT 'STUDENT',
  department_id INT NULL,
  status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE departments (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL UNIQUE,
  description TEXT,
  active BOOLEAN DEFAULT TRUE
);

ALTER TABLE users ADD CONSTRAINT fk_users_department FOREIGN KEY (department_id) REFERENCES departments(id);

CREATE TABLE categories (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL UNIQUE,
  description TEXT,
  default_department_id INT NULL,
  active BOOLEAN DEFAULT TRUE,
  FOREIGN KEY (default_department_id) REFERENCES departments(id)
);

CREATE TABLE tickets (
  id INT PRIMARY KEY AUTO_INCREMENT,
  ticket_no VARCHAR(30) NOT NULL UNIQUE,
  user_id INT NOT NULL,
  title VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  location VARCHAR(200),
  location_type ENUM('Hostel Room','Academic / Admin Block','Library','Transport / Campus Grounds','Other'),
  category_id INT,
  priority ENUM('LOW','MEDIUM','HIGH','CRITICAL') DEFAULT 'MEDIUM',
  department_id INT,
  assigned_to INT,
  status ENUM('OPEN','ASSIGNED','IN_PROGRESS','AWAITING_USER','AWAITING_REVIEW','RESOLVED','CLOSED','REOPENED') DEFAULT 'OPEN',
  ai_summary TEXT,
  ai_reason TEXT,
  ai_confidence DECIMAL(5,4),
  physical_visit_required BOOLEAN DEFAULT FALSE,
  access_mode_recommendation VARCHAR(60),
  resolution_notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (category_id) REFERENCES categories(id),
  FOREIGN KEY (department_id) REFERENCES departments(id),
  FOREIGN KEY (assigned_to) REFERENCES users(id)
);

CREATE TABLE comments (
  id INT PRIMARY KEY AUTO_INCREMENT,
  ticket_id INT NOT NULL,
  user_id INT NOT NULL,
  message TEXT NOT NULL,
  visibility ENUM('PUBLIC','INTERNAL') DEFAULT 'PUBLIC',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE attachments (
  id INT PRIMARY KEY AUTO_INCREMENT,
  ticket_id INT NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  stored_path VARCHAR(500) NOT NULL,
  mime_type VARCHAR(120),
  size_bytes BIGINT,
  uploaded_by INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id),
  FOREIGN KEY (uploaded_by) REFERENCES users(id)
);

CREATE TABLE ticket_history (
  id INT PRIMARY KEY AUTO_INCREMENT,
  ticket_id INT NOT NULL,
  actor_id INT,
  action VARCHAR(60) NOT NULL,
  old_value TEXT,
  new_value TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id),
  FOREIGN KEY (actor_id) REFERENCES users(id)
);

CREATE TABLE notifications (
  id INT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL,
  ticket_id INT,
  type VARCHAR(40),
  title VARCHAR(200),
  message TEXT,
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (ticket_id) REFERENCES tickets(id)
);

-- Smart Visit, Availability & Key Management (Section 6.3A / 10.8 / 12.3)
CREATE TABLE visit_requests (
  id INT PRIMARY KEY AUTO_INCREMENT,
  ticket_id INT NOT NULL,
  proposed_by INT,
  student_windows JSON,
  technician_slot DATETIME,
  status ENUM('PROPOSED','SCHEDULED','CHECKED_IN','MISSED','RESCHEDULE_REQUESTED','COMPLETED','CANCELLED') DEFAULT 'PROPOSED',
  outcome_notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id),
  FOREIGN KEY (proposed_by) REFERENCES users(id)
);

CREATE INDEX idx_tickets_status ON tickets(status);
CREATE INDEX idx_tickets_priority ON tickets(priority);
CREATE INDEX idx_tickets_dept_status ON tickets(department_id, status);
CREATE INDEX idx_tickets_assigned_status ON tickets(assigned_to, status);
CREATE INDEX idx_tickets_created ON tickets(created_at);
CREATE INDEX idx_comments_ticket ON comments(ticket_id, created_at);
CREATE INDEX idx_notifications_user ON notifications(user_id, is_read);
