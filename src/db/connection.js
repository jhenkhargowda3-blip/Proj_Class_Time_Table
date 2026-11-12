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

  // Ensure persistent student & faculty data links
  ensureDataLinks(dbInstance);

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

    // 6. Safe Migration: Table rebuild for uq_timetable_entries_slot (parallel lab batches & electives)
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const migrationName = 'rebuild_timetable_entries_uq_slot';
    const alreadyRebuilt = db.prepare("SELECT 1 FROM schema_migrations WHERE name = ?").get(migrationName);
    if (!alreadyRebuilt) {
      const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='timetable_entries'").get();
      if (tableExists) {
        const countBefore = db.prepare("SELECT COUNT(*) as count FROM timetable_entries").get().count;

        db.pragma('foreign_keys = OFF');
        try {
          const rebuildTx = db.transaction(() => {
            db.exec(`
              DROP TABLE IF EXISTS timetable_entries_new;

              CREATE TABLE timetable_entries_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                version_id INTEGER NOT NULL REFERENCES timetable_versions(id) ON DELETE CASCADE,
                section_id INTEGER NULL REFERENCES sections(id) ON DELETE CASCADE,
                subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
                faculty_id INTEGER NOT NULL REFERENCES faculty(id) ON DELETE RESTRICT,
                room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
                day_id INTEGER NOT NULL REFERENCES working_days(id) ON DELETE RESTRICT,
                slot_id INTEGER NOT NULL REFERENCES time_slots(id) ON DELETE RESTRICT,
                is_lab_block INTEGER NOT NULL DEFAULT 0 CHECK (is_lab_block IN (0, 1)),
                locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
                is_draft INTEGER NOT NULL DEFAULT 0 CHECK (is_draft IN (0, 1)),
                batch TEXT NULL,
                room_note TEXT NULL,
                session_id TEXT NULL
              );

              INSERT INTO timetable_entries_new (
                id, version_id, section_id, subject_id, faculty_id, room_id, day_id, slot_id, is_lab_block, locked, is_draft, batch, room_note, session_id
              )
              SELECT 
                id, version_id, section_id, subject_id, faculty_id, room_id, day_id, slot_id, is_lab_block, locked, is_draft, batch, room_note, session_id
              FROM timetable_entries;
            `);

            const countAfter = db.prepare("SELECT COUNT(*) as count FROM timetable_entries_new").get().count;
            if (countBefore !== countAfter) {
              throw new Error(`Migration abort: row count mismatch (before: ${countBefore}, after: ${countAfter})`);
            }

            db.exec(`
              DROP TABLE timetable_entries;
              ALTER TABLE timetable_entries_new RENAME TO timetable_entries;

              DROP INDEX IF EXISTS idx_unique_section_slot;
              DROP INDEX IF EXISTS idx_unique_section_batch_slot;
              DROP INDEX IF EXISTS uq_timetable_entries_slot;
              DROP INDEX IF EXISTS idx_unique_faculty_slot;
              DROP INDEX IF EXISTS idx_unique_room_slot;

              CREATE UNIQUE INDEX uq_timetable_entries_slot 
              ON timetable_entries(version_id, section_id, day_id, slot_id, COALESCE(room_id,0), COALESCE(batch, ''));

              CREATE UNIQUE INDEX idx_unique_faculty_slot 
              ON timetable_entries(version_id, faculty_id, day_id, slot_id)
              WHERE is_draft = 0;

              CREATE UNIQUE INDEX idx_unique_room_slot 
              ON timetable_entries(version_id, room_id, day_id, slot_id)
              WHERE is_draft = 0;

              INSERT OR REPLACE INTO schema_migrations (name, applied_at)
              VALUES ('${migrationName}', CURRENT_TIMESTAMP);
            `);
          });

          rebuildTx();
        } finally {
          db.pragma('foreign_keys = ON');
        }

        const fkErrors = db.pragma('foreign_key_check');
        if (fkErrors && fkErrors.length > 0) {
          throw new Error('Foreign key check failed after rebuild: ' + JSON.stringify(fkErrors));
        }
      }
    }
  } catch (err) {
    console.error('[CTAS Schema Migration Error]', err);
    throw err;
  }
}

export function ensureDataLinks(db) {
  try {
    const hasUsers = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").get();
    const hasSections = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sections'").get();
    const hasFaculty = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='faculty'").get();

    if (!hasUsers) return;

    // 1. Link student accounts to 5th Sem, B Section (CSE-5B) and set full_name to 'Jhenkhar Gowda'
    if (hasSections) {
      const sec5B = db.prepare(`
        SELECT id FROM sections 
        WHERE name = 'CSE-5B' 
           OR (semester = 5 AND name LIKE '%B%')
        ORDER BY CASE WHEN name = 'CSE-5B' THEN 0 ELSE 1 END, id ASC 
        LIMIT 1
      `).get();

      if (sec5B) {
        db.prepare(`
          UPDATE users
          SET student_id = ?, full_name = 'Jhenkhar Gowda'
          WHERE LOWER(username) IN ('jhenkhar', 'student')
        `).run(sec5B.id);

        // Also if any student account has null student_id, fallback to sec5B
        db.prepare(`
          UPDATE users
          SET student_id = ?
          WHERE role = 'student' AND student_id IS NULL
        `).run(sec5B.id);
      }
    }

    // 2. Link every faculty login to its Master Data faculty record using stable key (id, user_id, email)
    if (hasFaculty) {
      const facultyUsers = db.prepare("SELECT id, username, email, faculty_id FROM users WHERE role = 'faculty'").all();
      for (const u of facultyUsers) {
        let fac = null;
        if (u.faculty_id) {
          fac = db.prepare("SELECT id, user_id FROM faculty WHERE id = ?").get(u.faculty_id);
        }
        if (!fac) {
          fac = db.prepare("SELECT id, user_id FROM faculty WHERE user_id = ? OR LOWER(email) = LOWER(?)").get(u.id, u.email);
        }
        if (fac) {
          if (u.faculty_id !== fac.id) {
            db.prepare("UPDATE users SET faculty_id = ? WHERE id = ?").run(fac.id, u.id);
          }
          if (fac.user_id !== u.id) {
            db.prepare("UPDATE faculty SET user_id = ? WHERE id = ?").run(u.id, fac.id);
          }
        }
      }
    }
  } catch (err) {
    console.error('[CTAS Data Links Error]', err);
  }
}

export function closeDatabase() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

export default getDatabase;
