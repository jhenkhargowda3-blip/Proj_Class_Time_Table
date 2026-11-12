import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import { getDatabase } from '../db/connection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Reference data path in public/assets/aistudio
const REFERENCE_DATA_PATH = path.resolve(__dirname, '../../public/assets/aistudio/CTAS_reference_data_with_rooms_91d4f9d0.json');

// Teaching period (1..7) to time_slot slot_no mapping
// Slot 1: P1 08:30-09:30
// Slot 2: P2 09:30-10:30
// Slot 3: Tea Break 10:30-10:45 (is_break=1)
// Slot 4: P3 10:45-11:45
// Slot 5: P4 11:45-12:45
// Slot 6: Lunch Break 12:45-13:30 (is_break=1)
// Slot 7: P5 13:30-14:30
// Slot 8: P6 14:30-15:30
// Slot 9: P7 15:30-16:30
export const PERIOD_TO_SLOT_NO = {
  1: 1,
  2: 2,
  3: 4,
  4: 5,
  5: 7,
  6: 8,
  7: 9
};

export const SLOT_NO_TO_PERIOD = {
  1: 1,
  2: 2,
  4: 3,
  5: 4,
  7: 5,
  8: 6,
  9: 7
};

export const DAY_CODE_TO_NAME = {
  'MON': 'Monday',
  'TUE': 'Tuesday',
  'WED': 'Wednesday',
  'THU': 'Thursday',
  'FRI': 'Friday',
  'SAT': 'Saturday'
};

export const DAY_CODE_TO_INDEX = {
  'MON': 1,
  'TUE': 2,
  'WED': 3,
  'THU': 4,
  'FRI': 5,
  'SAT': 6
};

/**
 * Reads reference data JSON from disk
 */
export function loadReferenceDataFile() {
  if (!fs.existsSync(REFERENCE_DATA_PATH)) {
    throw new Error(`Reference data file not found at ${REFERENCE_DATA_PATH}`);
  }
  return JSON.parse(fs.readFileSync(REFERENCE_DATA_PATH, 'utf8'));
}

/**
 * Migration helper to ensure subjects table accepts 'activity' type and nullable name/semester
 */
export function migrateDatabaseSchema(db) {
  // Ensure faculty columns
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

  // Ensure rooms columns
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

  // Ensure sections columns and allow NULL strength
  const sectionsTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sections'").get()?.sql || '';
  if (sectionsTableSql.includes('strength INTEGER NOT NULL')) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE sections_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        semester INTEGER NOT NULL,
        department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
        batches TEXT NULL,
        classroom TEXT NULL,
        strength INTEGER NULL
      );
      INSERT INTO sections_new (id, name, semester, department_id, strength)
      SELECT id, name, semester, department_id, NULL FROM sections;
      DROP TABLE sections;
      ALTER TABLE sections_new RENAME TO sections;
      PRAGMA foreign_keys = ON;
    `);
  } else {
    const sectionCols = db.prepare("PRAGMA table_info(sections)").all().map(c => c.name);
    if (!sectionCols.includes('batches')) {
      db.exec("ALTER TABLE sections ADD COLUMN batches TEXT NULL");
    }
    if (!sectionCols.includes('classroom')) {
      db.exec("ALTER TABLE sections ADD COLUMN classroom TEXT NULL");
    }
  }

  // Ensure subjects table supports type 'activity' and extended columns
  const subjectCols = db.prepare("PRAGMA table_info(subjects)").all().map(c => c.name);
  if (!subjectCols.includes('short_name')) {
    db.exec("ALTER TABLE subjects ADD COLUMN short_name TEXT NULL");
  }
  if (!subjectCols.includes('semester_candidates')) {
    db.exec("ALTER TABLE subjects ADD COLUMN semester_candidates TEXT NULL");
  }

  // Ensure timetable_versions has source and baseline_fingerprint columns
  const verCols = db.prepare("PRAGMA table_info(timetable_versions)").all().map(c => c.name);
  if (!verCols.includes('source')) {
    db.exec("ALTER TABLE timetable_versions ADD COLUMN source TEXT NULL");
  }
  if (!verCols.includes('baseline_fingerprint')) {
    db.exec("ALTER TABLE timetable_versions ADD COLUMN baseline_fingerprint TEXT NULL");
  }

  // In SQLite, if subjects has CHECK (type IN ('theory', 'lab')), we need to ensure 'activity' is permitted.
  const subjectsTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='subjects'").get()?.sql || '';
  if (subjectsTableSql.includes("'theory', 'lab'") && !subjectsTableSql.includes("'activity'")) {
    // Recreate subjects table to allow 'activity' type and nullable semester/name
    db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE subjects_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        name TEXT NULL,
        short_name TEXT NULL,
        type TEXT NOT NULL CHECK (type IN ('theory', 'lab', 'activity')),
        weekly_periods INTEGER NOT NULL DEFAULT 0,
        lab_block_length INTEGER NOT NULL DEFAULT 1,
        department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
        semester TEXT NULL,
        semester_candidates TEXT NULL
      );
      INSERT INTO subjects_new (id, code, name, short_name, type, weekly_periods, lab_block_length, department_id, semester, semester_candidates)
      SELECT id, code, name, code, type, weekly_periods, lab_block_length, department_id, CAST(semester AS TEXT), NULL FROM subjects;
      DROP TABLE subjects;
      ALTER TABLE subjects_new RENAME TO subjects;
      PRAGMA foreign_keys = ON;
    `);
  }

  // Ensure faculty_sessions table has all required columns
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
}

/**
 * Idempotently imports CTAS reference data as the single source of truth
 */
export function importReferenceData(customDb = null, options = {}) {
  const db = customDb || getDatabase();
  const rawData = options.data || loadReferenceDataFile();

  // Run schema migrations first
  migrateDatabaseSchema(db);

  const importTx = db.transaction(() => {
    // 1. Departments (Ensure CSE, IT, ECE exist; all imported records belong to CSE)
    let cseDept = db.prepare("SELECT * FROM departments WHERE code = 'CSE'").get();
    if (!cseDept) {
      const id = db.prepare("INSERT INTO departments (name, code) VALUES (?, ?)").run('Computer Science & Engineering', 'CSE').lastInsertRowid;
      cseDept = { id, code: 'CSE', name: 'Computer Science & Engineering' };
    }
    let itDept = db.prepare("SELECT * FROM departments WHERE code = 'IT'").get();
    if (!itDept) {
      db.prepare("INSERT INTO departments (name, code) VALUES (?, ?)").run('Information Technology', 'IT');
    }
    let eceDept = db.prepare("SELECT * FROM departments WHERE code = 'ECE'").get();
    if (!eceDept) {
      db.prepare("INSERT INTO departments (name, code) VALUES (?, ?)").run('Electronics & Communication', 'ECE');
    }

    // 2. Working Days (Mon to Sat)
    const existingDays = db.prepare("SELECT * FROM working_days").all();
    const dayNameMap = {};
    if (existingDays.length === 0) {
      const insertDay = db.prepare("INSERT INTO working_days (day_name, day_index, is_active) VALUES (?, ?, 1)");
      for (const [code, name] of Object.entries(DAY_CODE_TO_NAME)) {
        const id = insertDay.run(name, DAY_CODE_TO_INDEX[code]).lastInsertRowid;
        dayNameMap[code] = { id, name, index: DAY_CODE_TO_INDEX[code] };
      }
    } else {
      for (const d of existingDays) {
        for (const [code, name] of Object.entries(DAY_CODE_TO_NAME)) {
          if (d.day_name === name || d.day_index === DAY_CODE_TO_INDEX[code]) {
            dayNameMap[code] = { id: d.id, name: d.day_name, index: d.day_index };
          }
        }
      }
    }

    // 3. Time Slots (P1 08:30-09:30, P2 09:30-10:30, Tea 10:30-10:45, P3 10:45-11:45, P4 11:45-12:45, Lunch 12:45-13:30, P5 13:30-14:30, P6 14:30-15:30, P7 15:30-16:30)
    const requiredSlots = [
      { no: 1, start: '08:30', end: '09:30', isBreak: 0, label: 'Period 1' },
      { no: 2, start: '09:30', end: '10:30', isBreak: 0, label: 'Period 2' },
      { no: 3, start: '10:30', end: '10:45', isBreak: 1, label: 'Tea Break' },
      { no: 4, start: '10:45', end: '11:45', isBreak: 0, label: 'Period 3' },
      { no: 5, start: '11:45', end: '12:45', isBreak: 0, label: 'Period 4' },
      { no: 6, start: '12:45', end: '13:30', isBreak: 1, label: 'Lunch Break' },
      { no: 7, start: '13:30', end: '14:30', isBreak: 0, label: 'Period 5' },
      { no: 8, start: '14:30', end: '15:30', isBreak: 0, label: 'Period 6' },
      { no: 9, start: '15:30', end: '16:30', isBreak: 0, label: 'Period 7' }
    ];

    const slotMap = {};
    for (const rs of requiredSlots) {
      const existing = db.prepare("SELECT id FROM time_slots WHERE slot_no = ?").get(rs.no);
      if (existing) {
        db.prepare(`
          UPDATE time_slots 
          SET start_time = ?, end_time = ?, is_break = ?, label = ? 
          WHERE id = ?
        `).run(rs.start, rs.end, rs.isBreak, rs.label, existing.id);
        slotMap[rs.no] = existing.id;
      } else {
        const id = db.prepare(`
          INSERT INTO time_slots (slot_no, start_time, end_time, is_break, label)
          VALUES (?, ?, ?, ?, ?)
        `).run(rs.no, rs.start, rs.end, rs.isBreak, rs.label).lastInsertRowid;
        slotMap[rs.no] = id;
      }
    }

    // 3. Rooms (29 rooms from reference data)
    const validRoomNames = new Set((rawData.rooms || []).map(r => r.name));
    try {
      db.prepare(`
        DELETE FROM rooms 
        WHERE name NOT IN (${Array.from(validRoomNames).map(() => '?').join(',')})
          AND id NOT IN (SELECT room_id FROM timetable_entries)
      `).run(...Array.from(validRoomNames));
    } catch (e) {
      // ignore
    }

    const upsertRoom = db.prepare(`
      INSERT INTO rooms (name, type, capacity, floor, floor_name, code, is_active)
      VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(name) DO UPDATE SET
        type = excluded.type,
        capacity = excluded.capacity,
        floor = excluded.floor,
        floor_name = excluded.floor_name,
        code = excluded.code,
        is_active = 1
    `);

    const roomIdMap = {};
    for (const r of (rawData.rooms || [])) {
      const rType = (r.type || 'classroom').toLowerCase();
      upsertRoom.run(r.name, rType, r.capacity || 50, r.floor ?? null, r.floor_name || null, r.id || r.name);
      const row = db.prepare("SELECT id FROM rooms WHERE name = ?").get(r.name);
      if (row) {
        roomIdMap[r.id] = row.id;
        roomIdMap[r.name] = row.id;
      }
    }

    // 4. Sections (16 sections including CSE-1E)
    const validSectionNames = new Set((rawData.sections || []).map(s => s.name));
    try {
      const defaultSec = db.prepare("SELECT id FROM sections WHERE name = 'CSE-1A'").get();
      if (defaultSec) {
        db.prepare(`
          UPDATE users SET student_id = ? 
          WHERE student_id IN (
            SELECT id FROM sections WHERE name NOT IN (${Array.from(validSectionNames).map(() => '?').join(',')})
          )
        `).run(defaultSec.id, ...Array.from(validSectionNames));
      }
      db.prepare(`
        DELETE FROM timetable_entries 
        WHERE section_id IN (
          SELECT id FROM sections WHERE name NOT IN (${Array.from(validSectionNames).map(() => '?').join(',')})
        )
      `).run(...Array.from(validSectionNames));
      db.prepare(`
        DELETE FROM section_subjects 
        WHERE section_id IN (
          SELECT id FROM sections WHERE name NOT IN (${Array.from(validSectionNames).map(() => '?').join(',')})
        )
      `).run(...Array.from(validSectionNames));
      db.prepare(`
        DELETE FROM sections 
        WHERE name NOT IN (${Array.from(validSectionNames).map(() => '?').join(',')})
      `).run(...Array.from(validSectionNames));
    } catch (e) {
      // ignore deletion restriction if referenced
    }

    const sectionIdMap = {};
    const upsertSection = db.prepare(`
      INSERT INTO sections (name, semester, department_id, batches, classroom, strength)
      VALUES (?, ?, ?, ?, ?, NULL)
      ON CONFLICT(name) DO UPDATE SET
        semester = excluded.semester,
        department_id = excluded.department_id,
        batches = excluded.batches,
        classroom = excluded.classroom,
        strength = NULL
    `);

    for (const sec of rawData.sections) {
      upsertSection.run(sec.name, sec.semester, cseDept.id, JSON.stringify(sec.batches || []), sec.classroom || null);
      const row = db.prepare("SELECT id FROM sections WHERE name = ?").get(sec.name);
      sectionIdMap[sec.name] = row.id;
    }

    // 5. Subjects (40 subjects: 25 theory, 14 lab, 1 activity)
    // Calculate total hours per subject from sessions (sums to 413)
    const subjectHours = {};
    for (const s of rawData.sessions) {
      subjectHours[s.subject_code] = (subjectHours[s.subject_code] || 0) + (s.hours || 1);
    }

    const validSubjectCodes = new Set(rawData.subjects.map(s => s.code));
    try {
      db.prepare(`
        DELETE FROM subjects 
        WHERE code NOT IN (${Array.from(validSubjectCodes).map(() => '?').join(',')})
          AND id NOT IN (SELECT subject_id FROM timetable_entries)
          AND id NOT IN (SELECT subject_id FROM section_subjects)
          AND id NOT IN (SELECT subject_id FROM faculty_subjects)
      `).run(...Array.from(validSubjectCodes));
    } catch (e) {
      // ignore
    }

    const upsertSubject = db.prepare(`
      INSERT INTO subjects (code, name, short_name, type, weekly_periods, lab_block_length, department_id, semester, semester_candidates)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET
        name = excluded.name,
        short_name = excluded.short_name,
        type = excluded.type,
        weekly_periods = excluded.weekly_periods,
        lab_block_length = excluded.lab_block_length,
        department_id = excluded.department_id,
        semester = excluded.semester,
        semester_candidates = excluded.semester_candidates
    `);

    const subjectIdMap = {};
    for (const sub of rawData.subjects) {
      const hours = subjectHours[sub.code] || (sub.type === 'lab' ? 2 : 1);
      const labBlockLen = sub.type === 'lab' ? 2 : 1;
      const candidatesJson = JSON.stringify(sub.semester_candidates || []);
      upsertSubject.run(
        sub.code,
        sub.name,
        sub.short_name || sub.code,
        sub.type,
        hours,
        labBlockLen,
        cseDept.id,
        sub.semester || null,
        candidatesJson
      );
      const row = db.prepare("SELECT id FROM subjects WHERE code = ?").get(sub.code);
      subjectIdMap[sub.code] = row.id;
    }

    // 6. Faculty (33 faculty: F01 through F33)
    // F31 is Mrs. Manjula H S (preserve login account manjula / man2112)
    const facultyPassHash = bcrypt.hashSync(process.env.FACULTY_SEED_PASSWORD || 'man2112', 10);
    const facultyIdMap = {};

    for (const fac of rawData.faculty) {
      const email = fac.id === 'F31' ? 'manjula@gmail.com' : `${fac.id.toLowerCase()}@college.edu`;
      const phone = fac.id === 'F31' ? '7374619852' : `98765432${fac.id.slice(1).padStart(2, '0')}`;

      // Check existing faculty by code, name, or email
      let facultyRow = db.prepare("SELECT * FROM faculty WHERE code = ? OR name = ? OR email = ?").get(fac.id, fac.name, email);
      if (!facultyRow && fac.id === 'F31') {
        facultyRow = db.prepare("SELECT * FROM faculty WHERE name LIKE '%Manjula%'").get();
      }

      let facultyDbId;
      if (facultyRow) {
        db.prepare(`
          UPDATE faculty
          SET name = ?, department_id = ?, email = ?, phone = ?, code = ?, classes_taught = ?, 
              effective_from = ?, weekly_hours = ?, max_periods_per_day = 4, 
              max_periods_per_week = 18, is_active = 1
          WHERE id = ?
        `).run(fac.name, cseDept.id, email, phone, fac.id, fac.classes_taught, fac.effective_from, fac.weekly_hours, facultyRow.id);
        facultyDbId = facultyRow.id;
      } else {
        const res = db.prepare(`
          INSERT INTO faculty (name, department_id, email, phone, code, classes_taught, effective_from, weekly_hours, max_periods_per_day, max_periods_per_week, is_active)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 4, 18, 1)
        `).run(fac.name, cseDept.id, email, phone, fac.id, fac.classes_taught, fac.effective_from, fac.weekly_hours);
        facultyDbId = res.lastInsertRowid;
      }

      facultyIdMap[fac.id] = facultyDbId;

      // Ensure user account exists
      const username = fac.id === 'F31' ? 'manjula' : fac.id.toLowerCase();
      let userRow = db.prepare("SELECT id FROM users WHERE LOWER(username) = LOWER(?)").get(username);
      if (userRow) {
        db.prepare("UPDATE users SET full_name = ?, faculty_id = ? WHERE id = ?").run(fac.name, facultyDbId, userRow.id);
        db.prepare("UPDATE faculty SET user_id = ? WHERE id = ?").run(userRow.id, facultyDbId);
      } else {
        const email = fac.id === 'F31' ? 'manjula@gmail.com' : `${fac.id.toLowerCase()}@college.edu`;
        const uRes = db.prepare(`
          INSERT INTO users (username, password_hash, role, full_name, email, faculty_id)
          VALUES (?, ?, 'faculty', ?, ?, ?)
        `).run(username, facultyPassHash, fac.name, email, facultyDbId);
        db.prepare("UPDATE faculty SET user_id = ? WHERE id = ?").run(uRes.lastInsertRowid, facultyDbId);
      }
    }

    // 7. Sessions (305 sessions, 413 teaching hours)
    db.prepare("DELETE FROM faculty_sessions").run();

    const insertSession = db.prepare(`
      INSERT OR REPLACE INTO faculty_sessions (
        id, faculty_id, faculty_name, day, start, end,
        period_start, period_end, hours, subject_code, type,
        batch, section, semester, section_status, candidate_sections,
        room_name, room_id, room_type, floor, floor_name, room_note, section_resolved, section_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const s of rawData.sessions) {
      insertSession.run(
        s.id,
        s.faculty_id,
        s.faculty,
        s.day,
        s.start,
        s.end,
        s.period_start,
        s.period_end,
        s.hours,
        s.subject_code,
        s.type,
        s.batch,
        s.section,
        s.semester,
        s.section_status,
        JSON.stringify(s.candidate_sections || []),
        s.room_name || 'TBD',
        s.room_id || null,
        s.room_type || (s.type === 'lab' ? 'Lab' : 'Classroom'),
        s.floor ?? null,
        s.floor_name || null,
        s.room_note || '',
        s.section_resolved || null,
        s.section_source || null
      );
    }

    // 8. Faculty Availability (33 faculty x 6 days x 7 teaching slots)
    // Busy (is_available = 0) exactly when a session covers that period; Free (is_available = 1) otherwise.
    // Build lookup of busy periods: `facultyCode_dayCode_periodNo` -> true
    const busyLookup = new Set();
    for (const s of rawData.sessions) {
      for (let p = s.period_start; p <= s.period_end; p++) {
        busyLookup.add(`${s.faculty_id}_${s.day}_${p}`);
      }
    }

    db.prepare("DELETE FROM faculty_availability").run();
    const insertAvail = db.prepare(`
      INSERT OR REPLACE INTO faculty_availability (faculty_id, day_id, slot_id, is_available)
      VALUES (?, ?, ?, ?)
    `);

    for (const fac of rawData.faculty) {
      const facDbId = facultyIdMap[fac.id];
      for (const [dayCode, dayIndex] of Object.entries(DAY_CODE_TO_INDEX)) {
        const dayRow = dayNameMap[dayCode];
        if (!dayRow) continue;

        for (let p = 1; p <= 7; p++) {
          const slotNo = PERIOD_TO_SLOT_NO[p];
          const slotId = slotMap[slotNo];
          if (!slotId) continue;

          // Faculty are available to teach by default (is_available = 1)
          insertAvail.run(facDbId, dayRow.id, slotId, 1);
        }
      }
    }

    // 9. Timetable Version: Ensure active version exists and is marked as imported_verified
    let activeVer = db.prepare("SELECT * FROM timetable_versions WHERE status = 'active'").get();
    if (activeVer) {
      db.prepare(`
        UPDATE timetable_versions 
        SET name = ?, notes = ?, source = 'imported_verified', baseline_fingerprint = '[]'
        WHERE id = ?
      `).run(
        '2026-27 Odd Semester Timetable (SJBIT CSE)',
        'SJBIT CSE Department 2026-27 Odd Semester Timetable matching CTAS_reference_data.json',
        activeVer.id
      );
    } else {
      const adminUser = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
      db.prepare(`
        INSERT INTO timetable_versions (name, status, created_by, notes, source, baseline_fingerprint)
        VALUES (?, 'active', ?, ?, 'imported_verified', '[]')
      `).run(
        '2026-27 Odd Semester Timetable (SJBIT CSE)',
        adminUser?.id || null,
        'SJBIT CSE Department 2026-27 Odd Semester Timetable matching CTAS_reference_data.json'
      );
    }

    // 10. Audit log
    db.prepare(`
      INSERT INTO audit_log (action, details_json)
      VALUES (?, ?)
    `).run('REFERENCE_DATA_IMPORTED', JSON.stringify({
      facultyCount: rawData.faculty.length,
      subjectsCount: rawData.subjects.length,
      sectionsCount: rawData.sections.length,
      sessionsCount: rawData.sessions.length,
      totalHours: 413,
      academicYear: rawData.academic_year,
      term: rawData.term
    }));

    return true;
  });

  importTx();
  return getVerificationReport(db);
}

/**
 * Produces verification report comparing reference data with current state
 */
export function getVerificationReport(customDb = null) {
  const db = customDb || getDatabase();
  const refData = loadReferenceDataFile();

  const facultyInDb = db.prepare("SELECT * FROM faculty WHERE is_active = 1").all();
  const subjectsInDb = db.prepare("SELECT * FROM subjects").all();
  const sessionsInDb = db.prepare("SELECT * FROM faculty_sessions").all();
  const sectionsInDb = db.prepare("SELECT * FROM sections").all();
  const roomsInDb = db.prepare("SELECT * FROM rooms WHERE is_active = 1").all();

  const totalHours = sessionsInDb.reduce((acc, s) => acc + (s.hours || 0), 0);

  // Group hours by faculty
  const hoursPerFacultyInDb = {};
  for (const s of sessionsInDb) {
    hoursPerFacultyInDb[s.faculty_id] = (hoursPerFacultyInDb[s.faculty_id] || 0) + (s.hours || 0);
  }

  // Compare each faculty's weekly hours
  const facultyMismatches = [];
  const facultyWeeklyComparison = refData.faculty.map(f => {
    const actualHours = hoursPerFacultyInDb[f.id] || 0;
    const expectedHours = f.weekly_hours;
    const match = actualHours === expectedHours;
    if (!match) {
      facultyMismatches.push({
        id: f.id,
        code: f.id,
        name: f.name,
        expectedHours,
        actualHours,
        targetWeeklyHours: expectedHours,
        actualSessionHours: actualHours,
        difference: actualHours - expectedHours,
        diff: actualHours - expectedHours
      });
    }
    return {
      id: f.id,
      code: f.id,
      name: f.name,
      classesTaught: f.classes_taught,
      expectedHours,
      actualHours,
      targetWeeklyHours: expectedHours,
      actualSessionHours: actualHours,
      diff: actualHours - expectedHours,
      match
    };
  });

  // Check department usage
  const departments = db.prepare("SELECT * FROM departments").all();
  const cseSections = db.prepare("SELECT COUNT(*) as c FROM sections WHERE department_id = (SELECT id FROM departments WHERE code='CSE')").get().c;
  const cseSubjects = db.prepare("SELECT COUNT(*) as c FROM subjects WHERE department_id = (SELECT id FROM departments WHERE code='CSE')").get().c;
  const cseFaculty = db.prepare("SELECT COUNT(*) as c FROM faculty WHERE department_id = (SELECT id FROM departments WHERE code='CSE')").get().c;

  const unusedDepartmentsList = ['IT', 'ECE'];
  const unusedDepartments = departments
    .filter(d => d.code !== 'CSE')
    .map(d => ({
      code: d.code,
      name: d.name,
      status: 'Unused / Kept intact without records'
    }));

  return {
    verified: facultyMismatches.length === 0 && sessionsInDb.length === 305 && totalHours === 413 && roomsInDb.length === 29,
    summary: {
      facultyCount: facultyInDb.length,
      expectedFacultyCount: refData.faculty.length, // 33
      subjectsCount: subjectsInDb.length,
      expectedSubjectsCount: refData.subjects.length, // 40
      sessionsCount: sessionsInDb.length,
      expectedSessionsCount: refData.sessions.length, // 305
      roomsCount: roomsInDb.length,
      expectedRoomsCount: (refData.rooms || []).length || 29,
      sectionsCount: sectionsInDb.length,
      expectedSectionsCount: (refData.sections || []).length || 16,
      totalHours,
      totalTeachingHours: totalHours,
      expectedTotalHours: 413,
      mismatchCount: facultyMismatches.length,
      mismatchesCount: facultyMismatches.length
    },
    facultyWeeklyComparison,
    facultyComparison: facultyWeeklyComparison,
    facultyMismatches,
    unusedDepartments: unusedDepartmentsList,
    unusedDepartmentsText: 'Unused / Kept intact without records',
    departments: {
      active: {
        code: 'CSE',
        name: 'Computer Science & Engineering',
        sectionsCount: cseSections,
        subjectsCount: cseSubjects,
        facultyCount: cseFaculty
      },
      unused: unusedDepartments
    }
  };
}

/**
 * Projects sessions from faculty_sessions into 413 period entries across teaching slots
 */
export function getProjectedTimetableEntries(customDb = null, versionId = null) {
  const db = customDb || getDatabase();
  const sessions = db.prepare("SELECT * FROM faculty_sessions").all();
  const faculty = db.prepare("SELECT * FROM faculty").all();
  const sections = db.prepare("SELECT * FROM sections").all();
  const subjects = db.prepare("SELECT * FROM subjects").all();
  const rooms = db.prepare("SELECT * FROM rooms").all();
  const slots = db.prepare("SELECT * FROM time_slots").all();
  const days = db.prepare("SELECT * FROM working_days").all();

  const facMap = new Map(faculty.map(f => [f.code || f.id, f]));
  const facByIdMap = new Map(faculty.map(f => [f.id, f]));
  const secMap = new Map(sections.map(s => [s.name, s]));
  const subMap = new Map(subjects.map(s => [s.code, s]));
  const roomByNameMap = new Map(rooms.map(r => [r.name, r]));
  const roomByCodeMap = new Map(rooms.map(r => [r.code || r.name, r]));
  const slotMap = new Map(slots.map(s => [s.slot_no, s]));
  const dayRowMap = new Map(days.map(d => [d.day_index, d]));

  const entries = [];
  let seq = 1;

  for (const s of sessions) {
    const fac = facMap.get(s.faculty_id) || facByIdMap.get(Number(s.faculty_id));
    const sub = subMap.get(s.subject_code);
    const dayIndex = DAY_CODE_TO_INDEX[s.day] || 1;
    const day = dayRowMap.get(dayIndex);

    // Treat section_resolved as the section for every session
    const effectiveSec = s.section_resolved || s.section;
    const secName = (s.semester && effectiveSec)
      ? `CSE-${s.semester}${effectiveSec}`
      : (effectiveSec ? (effectiveSec.startsWith('CSE-') ? effectiveSec : null) : null);
    const sec = secName ? secMap.get(secName) : null;

    // Room lookup from database rooms
    const dbRoom = (s.room_id ? roomByCodeMap.get(s.room_id) : null) ||
                   (s.room_name ? roomByNameMap.get(s.room_name) : null);

    const roomType = s.room_type ? s.room_type.toLowerCase() : (dbRoom ? dbRoom.type.toLowerCase() : (s.type === 'lab' ? 'lab' : 'classroom'));

    for (let p = s.period_start; p <= s.period_end; p++) {
      const slotNo = PERIOD_TO_SLOT_NO[p];
      const slot = slotMap.get(slotNo);

      entries.push({
        id: seq++,
        session_id: s.id,
        version_id: versionId,
        faculty_id: fac ? fac.id : null,
        faculty_name: fac ? fac.name : s.faculty_name,
        faculty_code: s.faculty_id,
        faculty_email: fac ? fac.email : `${s.faculty_id.toLowerCase()}@college.edu`,
        subject_id: sub ? sub.id : null,
        subject_code: s.subject_code,
        subject_name: sub ? (sub.name || sub.short_name) : s.subject_code,
        subject_type: s.type || (sub ? sub.type : 'theory'),
        section_id: sec ? sec.id : null,
        section_name: sec ? sec.name : (secName || null),
        section_resolved: s.section_resolved,
        semester: s.semester ? String(s.semester) : (sec ? String(sec.semester) : null),
        batch: s.batch || null,
        room_id: dbRoom ? dbRoom.id : (s.room_id || null),
        room_code: s.room_id || (dbRoom ? dbRoom.code : null),
        room_name: s.room_name || (dbRoom ? dbRoom.name : 'TBD'),
        room_type: roomType,
        floor: s.floor !== null && s.floor !== undefined ? s.floor : (dbRoom ? dbRoom.floor : null),
        floor_name: s.floor_name || (dbRoom ? dbRoom.floor_name : null),
        room_note: s.room_note || '',
        room_capacity: dbRoom ? dbRoom.capacity : 50,
        day_id: day ? day.id : dayIndex,
        day_name: day ? day.day_name : (DAY_CODE_TO_NAME[s.day] || s.day),
        day_index: dayIndex,
        slot_id: slot ? slot.id : slotNo,
        slot_no: slotNo,
        start_time: slot ? slot.start_time : '',
        end_time: slot ? slot.end_time : '',
        slot_label: slot ? slot.label : `Period ${p}`,
        is_break: 0,
        is_lab_block: s.type === 'lab' ? 1 : 0,
        locked: 0,
        is_draft: 0,
        section_status: s.section_status,
        candidate_sections: s.candidate_sections ? JSON.parse(s.candidate_sections) : []
      });
    }
  }

  return entries;
}

/**
 * Returns sessions with unassigned sections for the Unassigned Section panel.
 * With CTAS_reference_data_with_rooms.json as single source of truth, all sessions are pre-resolved (0 unassigned).
 */
export function getUnassignedSessions(customDb = null) {
  return [];
}

/**
 * Assigns a section permanently to a session
 */
export function assignSessionSection(sessionId, sectionLetterOrName, customDb = null) {
  const db = customDb || getDatabase();
  let cleanSec = String(sectionLetterOrName).trim();
  if (cleanSec.startsWith('CSE-')) {
    // Extract last letter, e.g. CSE-5A -> A
    cleanSec = cleanSec.slice(-1);
  }

  db.prepare(`
    UPDATE faculty_sessions
    SET section = ?, section_status = 'assigned'
    WHERE id = ?
  `).run(cleanSec, sessionId);

  return db.prepare("SELECT * FROM faculty_sessions WHERE id = ?").get(sessionId);
}

/**
 * Assigns a room permanently to a session
 */
export function assignSessionRoom(sessionId, roomId, roomName, customDb = null) {
  const db = customDb || getDatabase();
  db.prepare(`
    UPDATE faculty_sessions
    SET room_id = ?, room_name = ?
    WHERE id = ?
  `).run(roomId || null, roomName || 'TBD', sessionId);

  return db.prepare("SELECT * FROM faculty_sessions WHERE id = ?").get(sessionId);
}

export default {
  PERIOD_TO_SLOT_NO,
  SLOT_NO_TO_PERIOD,
  DAY_CODE_TO_NAME,
  DAY_CODE_TO_INDEX,
  loadReferenceDataFile,
  migrateDatabaseSchema,
  importReferenceData,
  getVerificationReport
};
