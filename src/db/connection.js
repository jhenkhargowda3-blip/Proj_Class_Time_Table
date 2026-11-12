import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import config from '../config/env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let dbInstance = null;

export function getDatabase() {
  if (dbInstance) return dbInstance;

  const dbDir = path.dirname(config.dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  dbInstance = new Database(config.dbPath);
  
  // Enforce WAL mode, busy timeout, synchronous mode, and foreign key constraints
  dbInstance.pragma('journal_mode = WAL');
  dbInstance.pragma('synchronous = NORMAL');
  dbInstance.pragma('busy_timeout = 10000');
  dbInstance.pragma('foreign_keys = ON');

  // Initialize schema if not present
  initSchema(dbInstance);

  return dbInstance;
}

export function initSchema(db) {
  const schemaPath = path.resolve(__dirname, 'schema.sql');
  if (fs.existsSync(schemaPath)) {
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    db.exec(schemaSql);
  }

  // Ensure all tables support extended columns across schema evolutions
  try {
    // 1. Faculty columns
    const facultyCols = db.prepare("PRAGMA table_info(faculty)").all().map(c => c.name);
    if (!facultyCols.includes('code')) {
      db.exec("ALTER TABLE faculty ADD COLUMN code TEXT NULL");
    }
    if (!facultyCols.includes('classes_taught')) {
      db.exec("ALTER TABLE faculty ADD COLUMN classes_taught TEXT NULL");
    }
    if (!facultyCols.includes('effective_from')) {
      db.exec("ALTER TABLE faculty ADD COLUMN effective_from TEXT NULL");
    }
    if (!facultyCols.includes('weekly_hours')) {
      db.exec("ALTER TABLE faculty ADD COLUMN weekly_hours INTEGER NULL");
    }

    // 2. Rooms columns (critical: code, floor, floor_name)
    const roomCols = db.prepare("PRAGMA table_info(rooms)").all().map(c => c.name);
    if (!roomCols.includes('floor')) {
      db.exec("ALTER TABLE rooms ADD COLUMN floor INTEGER NULL");
    }
    if (!roomCols.includes('floor_name')) {
      db.exec("ALTER TABLE rooms ADD COLUMN floor_name TEXT NULL");
    }
    if (!roomCols.includes('code')) {
      db.exec("ALTER TABLE rooms ADD COLUMN code TEXT NULL");
    }

    // 3. Sections columns
    const sectionCols = db.prepare("PRAGMA table_info(sections)").all().map(c => c.name);
    if (!sectionCols.includes('batches')) {
      db.exec("ALTER TABLE sections ADD COLUMN batches TEXT NULL");
    }
    if (!sectionCols.includes('classroom')) {
      db.exec("ALTER TABLE sections ADD COLUMN classroom TEXT NULL");
    }

    // 4. Subjects columns
    const subjectCols = db.prepare("PRAGMA table_info(subjects)").all().map(c => c.name);
    if (!subjectCols.includes('short_name')) {
      db.exec("ALTER TABLE subjects ADD COLUMN short_name TEXT NULL");
    }
    if (!subjectCols.includes('semester_candidates')) {
      db.exec("ALTER TABLE subjects ADD COLUMN semester_candidates TEXT NULL");
    }

    // 5. Timetable versions columns
    const verCols = db.prepare("PRAGMA table_info(timetable_versions)").all().map(c => c.name);
    if (!verCols.includes('source')) {
      db.exec("ALTER TABLE timetable_versions ADD COLUMN source TEXT NULL");
    }
    if (!verCols.includes('baseline_fingerprint')) {
      db.exec("ALTER TABLE timetable_versions ADD COLUMN baseline_fingerprint TEXT NULL");
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS import_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        snapshot_json TEXT NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS faculty_sessions (
        id TEXT PRIMARY KEY,
        faculty_id TEXT NOT NULL,
        faculty_name TEXT,
        day TEXT NOT NULL,
        start TEXT,
        end TEXT,
        period_start INTEGER,
        period_end INTEGER,
        hours INTEGER,
        subject_code TEXT,
        type TEXT,
        batch TEXT,
        section TEXT,
        semester TEXT,
        section_status TEXT,
        candidate_sections TEXT,
        room_name TEXT DEFAULT 'TBD',
        room_id TEXT NULL,
        room_type TEXT NULL,
        floor INTEGER NULL,
        floor_name TEXT NULL,
        room_note TEXT NULL,
        section_resolved TEXT NULL,
        section_source TEXT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_faculty_sessions_faculty ON faculty_sessions(faculty_id);
      CREATE INDEX IF NOT EXISTS idx_faculty_sessions_day ON faculty_sessions(day);
    `);

    const sessionCols = db.prepare("PRAGMA table_info(faculty_sessions)").all().map(c => c.name);
    if (!sessionCols.includes('hours')) {
      db.exec("ALTER TABLE faculty_sessions ADD COLUMN hours INTEGER");
    }
    if (!sessionCols.includes('faculty_name')) {
      db.exec("ALTER TABLE faculty_sessions ADD COLUMN faculty_name TEXT");
    }
    if (!sessionCols.includes('section_status')) {
      db.exec("ALTER TABLE faculty_sessions ADD COLUMN section_status TEXT");
    }
    if (!sessionCols.includes('candidate_sections')) {
      db.exec("ALTER TABLE faculty_sessions ADD COLUMN candidate_sections TEXT");
    }
    if (!sessionCols.includes('room_name')) {
      db.exec("ALTER TABLE faculty_sessions ADD COLUMN room_name TEXT DEFAULT 'TBD'");
    }
    if (!sessionCols.includes('room_id')) {
      db.exec("ALTER TABLE faculty_sessions ADD COLUMN room_id TEXT NULL");
    }
    if (!sessionCols.includes('room_type')) {
      db.exec("ALTER TABLE faculty_sessions ADD COLUMN room_type TEXT NULL");
    }
    if (!sessionCols.includes('floor')) {
      db.exec("ALTER TABLE faculty_sessions ADD COLUMN floor INTEGER NULL");
    }
    if (!sessionCols.includes('floor_name')) {
      db.exec("ALTER TABLE faculty_sessions ADD COLUMN floor_name TEXT NULL");
    }
    if (!sessionCols.includes('room_note')) {
      db.exec("ALTER TABLE faculty_sessions ADD COLUMN room_note TEXT NULL");
    }
    if (!sessionCols.includes('section_resolved')) {
      db.exec("ALTER TABLE faculty_sessions ADD COLUMN section_resolved TEXT NULL");
    }
    if (!sessionCols.includes('section_source')) {
      db.exec("ALTER TABLE faculty_sessions ADD COLUMN section_source TEXT NULL");
    }
  } catch (err) {
    // ignore migration error if already exists
  }
}

export function closeDatabase() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

export default getDatabase;
