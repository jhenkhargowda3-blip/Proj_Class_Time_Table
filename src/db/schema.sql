-- ============================================================================
-- Class Timetable Automation System (CTAS)
-- SQLite Database Schema with Strict Relational Integrity
-- ============================================================================

PRAGMA foreign_keys = ON;

-- 1. Users Table
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'faculty', 'student')),
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  faculty_id INTEGER NULL REFERENCES faculty(id) ON DELETE SET NULL,
  student_id INTEGER NULL REFERENCES sections(id) ON DELETE SET NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. Departments Table
CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE
);

-- 3. Faculty Table
CREATE TABLE IF NOT EXISTS faculty (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER UNIQUE NULL REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL,
  max_periods_per_day INTEGER NOT NULL DEFAULT 4,
  max_periods_per_week INTEGER NOT NULL DEFAULT 18,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);

-- 4. Subjects Table
CREATE TABLE IF NOT EXISTS subjects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('theory', 'lab')),
  weekly_periods INTEGER NOT NULL,
  lab_block_length INTEGER NOT NULL DEFAULT 1,
  department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
  semester INTEGER NOT NULL
);

-- 5. Faculty Subjects (Who is qualified to teach what)
CREATE TABLE IF NOT EXISTS faculty_subjects (
  faculty_id INTEGER NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  PRIMARY KEY (faculty_id, subject_id)
);

-- 6. Sections Table
CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  semester INTEGER NOT NULL,
  department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
  strength INTEGER NOT NULL DEFAULT 40
);

-- 7. Section Subjects (Which faculty teaches which subject to which section)
CREATE TABLE IF NOT EXISTS section_subjects (
  section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  faculty_id INTEGER NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
  PRIMARY KEY (section_id, subject_id)
);

-- 8. Rooms Table
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('classroom', 'lab')),
  capacity INTEGER NOT NULL DEFAULT 50,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);

-- 9. Working Days Table (Default Monday to Saturday)
CREATE TABLE IF NOT EXISTS working_days (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day_name TEXT NOT NULL UNIQUE,
  day_index INTEGER NOT NULL UNIQUE, -- 1=Monday, 6=Saturday
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);

-- 10. Time Slots Table (Configurable teaching & break slots)
CREATE TABLE IF NOT EXISTS time_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_no INTEGER NOT NULL UNIQUE,
  start_time TEXT NOT NULL, -- 24-hr HH:MM
  end_time TEXT NOT NULL,   -- 24-hr HH:MM
  is_break INTEGER NOT NULL DEFAULT 0 CHECK (is_break IN (0, 1)),
  label TEXT NOT NULL
);

-- 11. Faculty Availability Table
CREATE TABLE IF NOT EXISTS faculty_availability (
  faculty_id INTEGER NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
  day_id INTEGER NOT NULL REFERENCES working_days(id) ON DELETE CASCADE,
  slot_id INTEGER NOT NULL REFERENCES time_slots(id) ON DELETE CASCADE,
  is_available INTEGER NOT NULL DEFAULT 1 CHECK (is_available IN (0, 1)),
  PRIMARY KEY (faculty_id, day_id, slot_id)
);

-- 12. Timetable Versions Table
CREATE TABLE IF NOT EXISTS timetable_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'archived')),
  created_by INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  notes TEXT NULL
);

-- Partial UNIQUE index: Only one version may be active at any given time
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_timetable_version 
ON timetable_versions(status) WHERE status = 'active';

-- 13. Timetable Entries Table
CREATE TABLE IF NOT EXISTS timetable_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES timetable_versions(id) ON DELETE CASCADE,
  section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  faculty_id INTEGER NOT NULL REFERENCES faculty(id) ON DELETE RESTRICT,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
  day_id INTEGER NOT NULL REFERENCES working_days(id) ON DELETE RESTRICT,
  slot_id INTEGER NOT NULL REFERENCES time_slots(id) ON DELETE RESTRICT,
  is_lab_block INTEGER NOT NULL DEFAULT 0 CHECK (is_lab_block IN (0, 1)),
  locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
  is_draft INTEGER NOT NULL DEFAULT 0 CHECK (is_draft IN (0, 1))
);

-- ============================================================================
-- MANDATORY HARD-CONSTRAINT UNIQUE INDEXES (Database-Level Conflict Prevention)
-- Enforced for committed/active timetables (is_draft = 0).
-- ============================================================================

-- A. A section cannot have two classes at the same time in the same version
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_section_slot 
ON timetable_entries(version_id, section_id, day_id, slot_id)
WHERE is_draft = 0;

-- B. A faculty cannot teach two classes at the same time in the same version
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_faculty_slot 
ON timetable_entries(version_id, faculty_id, day_id, slot_id)
WHERE is_draft = 0;

-- C. A room cannot host two classes at the same time in the same version
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_room_slot 
ON timetable_entries(version_id, room_id, day_id, slot_id)
WHERE is_draft = 0;

-- 14. Absences Table
CREATE TABLE IF NOT EXISTS absences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  faculty_id INTEGER NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
  date TEXT NOT NULL, -- ISO YYYY-MM-DD
  slot_id INTEGER NULL REFERENCES time_slots(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('absent', 'late')),
  expected_arrival TEXT NULL, -- HH:MM
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'covered', 'cancelled')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 15. Substitutions Table (Date-specific, never changes base timetable)
CREATE TABLE IF NOT EXISTS substitutions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  absence_id INTEGER NOT NULL REFERENCES absences(id) ON DELETE CASCADE,
  timetable_entry_id INTEGER NOT NULL REFERENCES timetable_entries(id) ON DELETE CASCADE,
  date TEXT NOT NULL, -- ISO YYYY-MM-DD
  substitute_faculty_id INTEGER NULL REFERENCES faculty(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'accepted', 'declined', 'assigned')),
  requested_by INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (timetable_entry_id, date)
);

-- 16. Holidays Table
CREATE TABLE IF NOT EXISTS holidays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT UNIQUE NOT NULL, -- ISO YYYY-MM-DD
  description TEXT NOT NULL
);

-- 17. Notifications Table
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'general',
  is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 18. Audit Log Table
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  details_json TEXT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 19. AI Issue Log Table
CREATE TABLE IF NOT EXISTS ai_issue_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES timetable_versions(id) ON DELETE CASCADE,
  severity TEXT NOT NULL CHECK (severity IN ('error', 'warning', 'info')),
  category TEXT NOT NULL,
  summary TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  suggested_fix_json TEXT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 20. Password Reset Tokens Table (Secure Time-Limited Tokens)
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,
  expires_at DATETIME NOT NULL,
  used INTEGER NOT NULL DEFAULT 0 CHECK (used IN (0, 1)),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_reset_token ON password_reset_tokens(token);

-- 21. Student Notice Reads Table (Persistent Read Status Tracking)
CREATE TABLE IF NOT EXISTS student_notice_reads (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notice_id TEXT NOT NULL,
  read_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, notice_id)
);
CREATE INDEX IF NOT EXISTS idx_student_notice_reads_user ON student_notice_reads(user_id);

-- 22. Faculty Sessions Table (Imported Timetable Sessions without Room Collisions)
CREATE TABLE IF NOT EXISTS faculty_sessions (
  id TEXT PRIMARY KEY,
  faculty_id TEXT NOT NULL,
  day TEXT NOT NULL,
  start TEXT,
  end TEXT,
  period_start INTEGER,
  period_end INTEGER,
  subject_code TEXT,
  type TEXT,
  batch TEXT,
  section TEXT,
  semester TEXT
);
CREATE INDEX IF NOT EXISTS idx_faculty_sessions_faculty ON faculty_sessions(faculty_id);
CREATE INDEX IF NOT EXISTS idx_faculty_sessions_day ON faculty_sessions(day);


