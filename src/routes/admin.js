import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { getDatabase } from '../db/connection.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/role.js';
import { registerTeacher } from '../services/teacherService.js';
import { getVerificationReport, importReferenceData } from '../services/referenceDataService.js';
import config from '../config/env.js';
import { broadcast } from '../services/sse.js';

const router = Router();

// Strict RBAC: Admin only for all administration endpoints
router.use(requireAuth, requireRole('admin'));

// 0. Verification Report & Timetable Reference Sync
router.get('/verification-report', (req, res) => {
  const db = getDatabase();
  const report = getVerificationReport(db);
  res.json(report);
});

router.post('/import-reference-data', (req, res) => {
  const db = getDatabase();
  const report = importReferenceData(db);
  res.json({ success: true, report });
});

// 1. Overview Statistics & Recent Feed
router.get('/overview', (req, res) => {
  const db = getDatabase();

  const facultyCount = db.prepare('SELECT COUNT(*) as count FROM faculty WHERE is_active = 1').get().count;
  const subjectsCount = db.prepare('SELECT COUNT(*) as count FROM subjects').get().count;
  const sectionsCount = db.prepare('SELECT COUNT(*) as count FROM sections').get().count;
  const roomsCount = db.prepare('SELECT COUNT(*) as count FROM rooms WHERE is_active = 1').get().count;
  const sessionHoursSum = db.prepare('SELECT SUM(hours) as sum FROM faculty_sessions').get()?.sum;
  const subjectHoursSum = db.prepare('SELECT SUM(weekly_periods) as sum FROM subjects').get()?.sum;
  const weeklyClassLoad = sessionHoursSum || subjectHoursSum || 413;

  const activeVersion = db.prepare(`
    SELECT id, name, status, created_at, notes
    FROM timetable_versions
    WHERE status = 'active'
    LIMIT 1
  `).get();

  const todayStr = new Date().toISOString().split('T')[0];
  const todayAbsences = db.prepare(`
    SELECT a.*, f.name as faculty_name, f.email as faculty_email
    FROM absences a
    JOIN faculty f ON a.faculty_id = f.id
    WHERE a.date = ?
  `).all(todayStr);

  const openIssuesCount = db.prepare(`
    SELECT COUNT(*) as count FROM ai_issue_log WHERE status = 'open'
  `).get().count;

  const recentLogs = db.prepare(`
    SELECT al.*, u.username, u.full_name
    FROM audit_log al
    LEFT JOIN users u ON al.user_id = u.id
    ORDER BY al.created_at DESC
    LIMIT 10
  `).all();

  res.json({
    stats: {
      facultyCount,
      subjectsCount,
      sectionsCount,
      roomsCount,
      weeklyClassLoad,
      activeVersion: activeVersion || null,
      todayAbsencesCount: todayAbsences.length,
      openIssuesCount
    },
    todayAbsences,
    recentLogs
  });
});

// 2. Comprehensive Master Data Payload
router.get('/master-data', (req, res) => {
  const db = getDatabase();
  const departments = db.prepare('SELECT * FROM departments ORDER BY name ASC').all();
  const faculty = db.prepare(`
    SELECT f.*, d.name as department_name, d.code as department_code, u.username
    FROM faculty f
    LEFT JOIN departments d ON f.department_id = d.id
    LEFT JOIN users u ON f.user_id = u.id
    ORDER BY f.name ASC
  `).all();
  const subjects = db.prepare(`
    SELECT s.*, d.name as department_name, d.code as department_code
    FROM subjects s
    JOIN departments d ON s.department_id = d.id
    ORDER BY s.semester, s.code ASC
  `).all();
  const sections = db.prepare(`
    SELECT sec.*, d.name as department_name, d.code as department_code
    FROM sections sec
    JOIN departments d ON sec.department_id = d.id
    ORDER BY sec.name ASC
  `).all();
  const rooms = db.prepare('SELECT * FROM rooms ORDER BY type, name ASC').all();
  const workingDays = db.prepare('SELECT * FROM working_days ORDER BY day_index ASC').all();
  const timeSlots = db.prepare('SELECT * FROM time_slots ORDER BY slot_no ASC').all();
  const holidays = db.prepare('SELECT * FROM holidays ORDER BY date ASC').all();
  const facultyAvailability = db.prepare('SELECT faculty_id, day_id, slot_id, is_available FROM faculty_availability').all();
  const sectionSubjects = db.prepare(`
    SELECT ss.*, s.name as subject_name, s.code as subject_code, s.weekly_periods, s.type as subject_type, s.lab_block_length
    FROM section_subjects ss
    JOIN subjects s ON ss.subject_id = s.id
  `).all();
  const facultySubjects = db.prepare('SELECT * FROM faculty_subjects').all();

  res.json({
    departments,
    faculty,
    subjects,
    sections,
    rooms,
    workingDays,
    timeSlots,
    holidays,
    facultyAvailability,
    sectionSubjects,
    facultySubjects
  });
});

// 3. Faculty CRUD & Search
router.get('/faculty', (req, res) => {
  const db = getDatabase();
  const rawQuery = String(req.query.search || req.query.q || '').trim().toLowerCase();
  const deptFilter = String(req.query.department || '').trim().toLowerCase();

  const allFaculty = db.prepare(`
    SELECT f.*, d.name as department_name, d.code as department_code, u.username
    FROM faculty f
    LEFT JOIN departments d ON f.department_id = d.id
    LEFT JOIN users u ON f.user_id = u.id
    ORDER BY f.name ASC
  `).all();

  const filtered = allFaculty.filter((f) => {
    if (deptFilter) {
      const code = (f.department_code || '').toLowerCase();
      const dName = (f.department_name || '').toLowerCase();
      const dId = String(f.department_id || '');
      if (code !== deptFilter && dName !== deptFilter && dId !== deptFilter) {
        return false;
      }
    }
    if (!rawQuery) return true;
    const tokens = rawQuery.split(/\s+/).filter(Boolean);
    const haystack = [
      f.name || '',
      f.department_code || '',
      f.department_name || '',
      f.email || '',
      f.phone || '',
      f.username || ''
    ].join(' ').toLowerCase();
    return tokens.every((t) => haystack.includes(t));
  });

  res.json({
    faculty: filtered,
    total: allFaculty.length,
    count: filtered.length
  });
});

router.post('/register-teacher', (req, res) => {
  try {
    const result = registerTeacher(req.body);
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to register teacher' });
  }
});

router.post('/faculty', (req, res) => {
  const { name, departmentId, email, phone, maxPeriodsPerDay, maxPeriodsPerWeek, password, username } = req.body;
  const db = getDatabase();

  const facPassword = password || 'Faculty@123';
  const passwordSaltRounds = 10;
  const passwordHash = bcrypt.hashSync(facPassword, passwordSaltRounds);

  // Generate unique username from provided username or email prefix or name
  let baseUsername = (username || (email ? email.split('@')[0] : name.toLowerCase().replace(/[^a-z0-9]/g, ''))).toLowerCase();
  if (!baseUsername || baseUsername.length < 2) baseUsername = 'faculty';
  let finalUsername = baseUsername;
  let counter = 1;
  while (db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)').get(finalUsername)) {
    finalUsername = `${baseUsername}${counter++}`;
  }

  const tx = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO faculty (name, department_id, email, phone, max_periods_per_day, max_periods_per_week, is_active)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(name, departmentId, email, phone, maxPeriodsPerDay || 4, maxPeriodsPerWeek || 18);

    const facId = result.lastInsertRowid;

    // Create user login account for the faculty member
    const userResult = db.prepare(`
      INSERT INTO users (username, password_hash, role, full_name, email, faculty_id)
      VALUES (?, ?, 'faculty', ?, ?, ?)
    `).run(finalUsername, passwordHash, name, email, facId);

    const userId = userResult.lastInsertRowid;
    db.prepare('UPDATE faculty SET user_id = ? WHERE id = ?').run(userId, facId);

    // Initialize faculty availability for active working days & non-break slots
    const days = db.prepare('SELECT id FROM working_days WHERE is_active = 1').all();
    const slots = db.prepare('SELECT id FROM time_slots WHERE is_break = 0').all();
    const insertAvail = db.prepare('INSERT INTO faculty_availability (faculty_id, day_id, slot_id, is_available) VALUES (?, ?, ?, 1)');
    for (const d of days) {
      for (const s of slots) {
        insertAvail.run(facId, d.id, s.id);
      }
    }

    return { facId, userId, username: finalUsername, defaultPassword: facPassword };
  });

  try {
    const created = tx();
    res.status(201).json({
      success: true,
      id: created.facId,
      userId: created.userId,
      username: created.username,
      defaultPassword: created.defaultPassword,
      message: `Faculty created successfully with login username '${created.username}' (Password: ${created.defaultPassword})`
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to create faculty member' });
  }
});

router.put('/faculty/:id', (req, res) => {
  const facId = parseInt(req.params.id, 10);
  const { name, departmentId, email, phone, maxPeriodsPerDay, maxPeriodsPerWeek, isActive } = req.body;
  const db = getDatabase();

  const updateTx = db.transaction(() => {
    db.prepare(`
      UPDATE faculty
      SET name = ?, department_id = ?, email = ?, phone = ?,
          max_periods_per_day = ?, max_periods_per_week = ?, is_active = ?
      WHERE id = ?
    `).run(name, departmentId, email, phone, maxPeriodsPerDay, maxPeriodsPerWeek, isActive ?? 1, facId);

    // Sync full_name and email to users table if account exists
    db.prepare(`
      UPDATE users
      SET full_name = ?, email = ?
      WHERE faculty_id = ?
    `).run(name, email, facId);
  });

  try {
    updateTx();
    res.json({ success: true, message: 'Faculty updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to update faculty member' });
  }
});

router.delete('/faculty/:id', (req, res) => {
  const facId = parseInt(req.params.id, 10);
  const db = getDatabase();

  const fac = db.prepare('SELECT * FROM faculty WHERE id = ?').get(facId);
  if (!fac) {
    return res.status(404).json({ error: 'Faculty member not found' });
  }

  const allowCascade = req.query.cascade === 'true' || req.query.force === 'true' || req.body?.cascade === true || req.body?.force === true;

  // Reject delete if faculty has scheduled timetable classes unless cascade / force is requested
  const assigned = db.prepare('SELECT count(*) as count FROM timetable_entries WHERE faculty_id = ?').get(facId);
  if (!allowCascade && assigned && assigned.count > 0) {
    return res.status(409).json({
      error: `Cannot delete faculty member assigned to ${assigned.count} active timetable class(es). Please reassign or clear these classes first.`,
      assignedCount: assigned.count,
      canForce: true
    });
  }

  const deleteTx = db.transaction(() => {
    db.prepare(`
      DELETE FROM substitutions 
      WHERE substitute_faculty_id = ? 
         OR absence_id IN (SELECT id FROM absences WHERE faculty_id = ?)
         OR timetable_entry_id IN (SELECT id FROM timetable_entries WHERE faculty_id = ?)
    `).run(facId, facId, facId);
    db.prepare('DELETE FROM timetable_entries WHERE faculty_id = ?').run(facId);
    db.prepare('DELETE FROM absences WHERE faculty_id = ?').run(facId);
    db.prepare('DELETE FROM faculty_availability WHERE faculty_id = ?').run(facId);
    db.prepare('DELETE FROM section_subjects WHERE faculty_id = ?').run(facId);
    db.prepare('DELETE FROM faculty_subjects WHERE faculty_id = ?').run(facId);
    db.prepare('UPDATE faculty SET user_id = NULL WHERE id = ?').run(facId);
    db.prepare('DELETE FROM users WHERE faculty_id = ? OR id = ?').run(facId, fac.user_id || -1);
    db.prepare('DELETE FROM faculty WHERE id = ?').run(facId);

    db.prepare('INSERT INTO audit_log (user_id, action, details_json) VALUES (?, ?, ?)')
      .run(req.user?.id || null, 'FACULTY_DELETED', JSON.stringify({ facultyId: facId, name: fac.name }));
  });

  try {
    deleteTx();
    res.json({ success: true, message: `Faculty ${fac.name} deleted successfully` });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to delete faculty member' });
  }
});

// 4. Subjects CRUD
router.post('/subjects', (req, res) => {
  const { code, name, type, weeklyPeriods, labBlockLength, departmentId, semester } = req.body;
  const db = getDatabase();

  const result = db.prepare(`
    INSERT INTO subjects (code, name, type, weekly_periods, lab_block_length, department_id, semester)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(code, name, type, weeklyPeriods, labBlockLength || 1, departmentId, semester);

  res.status(201).json({ success: true, id: result.lastInsertRowid });
});

router.put('/subjects/:id', (req, res) => {
  const subId = parseInt(req.params.id, 10);
  const { code, name, type, weeklyPeriods, labBlockLength, departmentId, semester } = req.body;
  const db = getDatabase();

  db.prepare(`
    UPDATE subjects
    SET code = ?, name = ?, type = ?, weekly_periods = ?, lab_block_length = ?,
        department_id = ?, semester = ?
    WHERE id = ?
  `).run(code, name, type, weeklyPeriods, labBlockLength || 1, departmentId, semester, subId);

  res.json({ success: true, message: 'Subject updated successfully' });
});

router.delete('/subjects/:id', (req, res) => {
  const subId = parseInt(req.params.id, 10);
  const db = getDatabase();

  const sub = db.prepare('SELECT * FROM subjects WHERE id = ?').get(subId);
  if (!sub) {
    return res.status(404).json({ error: 'Subject not found' });
  }

  const deleteTx = db.transaction(() => {
    db.prepare('DELETE FROM timetable_entries WHERE subject_id = ?').run(subId);
    db.prepare('DELETE FROM section_subjects WHERE subject_id = ?').run(subId);
    db.prepare('DELETE FROM faculty_subjects WHERE subject_id = ?').run(subId);
    db.prepare('DELETE FROM subjects WHERE id = ?').run(subId);

    db.prepare('INSERT INTO audit_log (user_id, action, details_json) VALUES (?, ?, ?)')
      .run(req.user?.id || null, 'SUBJECT_DELETED', JSON.stringify({ subjectId: subId, code: sub.code, name: sub.name }));
  });

  try {
    deleteTx();
    res.json({ success: true, message: `Subject ${sub.code} deleted successfully` });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to delete subject' });
  }
});

// 5. Sections CRUD
router.post('/sections', (req, res) => {
  const { name, semester, departmentId, strength } = req.body;
  const db = getDatabase();

  const result = db.prepare(`
    INSERT INTO sections (name, semester, department_id, strength)
    VALUES (?, ?, ?, ?)
  `).run(name, semester, departmentId, strength || 40);

  res.status(201).json({ success: true, id: result.lastInsertRowid });
});

router.put('/sections/:id', (req, res) => {
  const secId = parseInt(req.params.id, 10);
  const { name, semester, departmentId, strength } = req.body;
  const db = getDatabase();

  db.prepare(`
    UPDATE sections
    SET name = ?, semester = ?, department_id = ?, strength = ?
    WHERE id = ?
  `).run(name, semester, departmentId, strength || 40, secId);

  res.json({ success: true, message: 'Section updated successfully' });
});

router.delete('/sections/:id', (req, res) => {
  const secId = parseInt(req.params.id, 10);
  const db = getDatabase();

  const sec = db.prepare('SELECT * FROM sections WHERE id = ?').get(secId);
  if (!sec) {
    return res.status(404).json({ error: 'Section not found' });
  }

  const deleteTx = db.transaction(() => {
    db.prepare('DELETE FROM timetable_entries WHERE section_id = ?').run(secId);
    db.prepare('DELETE FROM section_subjects WHERE section_id = ?').run(secId);
    db.prepare('UPDATE users SET student_id = NULL WHERE student_id = ?').run(secId);
    db.prepare('DELETE FROM sections WHERE id = ?').run(secId);

    db.prepare('INSERT INTO audit_log (user_id, action, details_json) VALUES (?, ?, ?)')
      .run(req.user?.id || null, 'SECTION_DELETED', JSON.stringify({ sectionId: secId, name: sec.name }));
  });

  try {
    deleteTx();
    res.json({ success: true, message: `Section ${sec.name} and associated records deleted successfully` });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to delete section' });
  }
});

// 6. Rooms CRUD
router.post('/rooms/restore-defaults', (req, res) => {
  const db = getDatabase();
  const defaultRooms = [
    { name: 'CR-101', code: 'CR-101', type: 'classroom', capacity: 50, floor: 0, floor_name: 'Ground', is_active: 1 },
    { name: 'CR-102', code: 'CR-102', type: 'classroom', capacity: 50, floor: 0, floor_name: 'Ground', is_active: 1 },
    { name: 'CR-103', code: 'CR-103', type: 'classroom', capacity: 50, floor: 0, floor_name: 'Ground', is_active: 1 },
    { name: 'CR-104', code: 'CR-104', type: 'classroom', capacity: 50, floor: 0, floor_name: 'Ground', is_active: 1 },
    { name: 'CR-105', code: 'CR-105', type: 'classroom', capacity: 50, floor: 0, floor_name: 'Ground', is_active: 1 },
    { name: 'CR-201', code: 'CR-201', type: 'classroom', capacity: 60, floor: 1, floor_name: 'First', is_active: 1 },
    { name: 'CR-202', code: 'CR-202', type: 'classroom', capacity: 60, floor: 1, floor_name: 'First', is_active: 1 },
    { name: 'CR-203', code: 'CR-203', type: 'classroom', capacity: 60, floor: 1, floor_name: 'First', is_active: 1 },
    { name: 'CR-204', code: 'CR-204', type: 'classroom', capacity: 60, floor: 1, floor_name: 'First', is_active: 1 },
    { name: 'CR-301', code: 'CR-301', type: 'classroom', capacity: 60, floor: 2, floor_name: 'Second', is_active: 1 },
    { name: 'CR-302', code: 'CR-302', type: 'classroom', capacity: 60, floor: 2, floor_name: 'Second', is_active: 1 },
    { name: 'CR-303', code: 'CR-303', type: 'classroom', capacity: 60, floor: 2, floor_name: 'Second', is_active: 1 },
    { name: 'CR-304', code: 'CR-304', type: 'classroom', capacity: 60, floor: 2, floor_name: 'Second', is_active: 1 },
    { name: 'CR-307', code: 'CR-307', type: 'classroom', capacity: 60, floor: 3, floor_name: 'Third', is_active: 1 },
    { name: 'CR-308', code: 'CR-308', type: 'classroom', capacity: 60, floor: 3, floor_name: 'Third', is_active: 1 },
    { name: 'CR-309', code: 'CR-309', type: 'classroom', capacity: 60, floor: 3, floor_name: 'Third', is_active: 1 },
    { name: 'CR-310', code: 'CR-310', type: 'classroom', capacity: 60, floor: 3, floor_name: 'Third', is_active: 1 },
    { name: 'Alan Turing Lab A', code: 'LAB-0A', type: 'lab', capacity: 45, floor: 0, floor_name: 'Ground', is_active: 1 },
    { name: 'Alan Turing Lab B', code: 'LAB-0B', type: 'lab', capacity: 45, floor: 0, floor_name: 'Ground', is_active: 1 },
    { name: 'Alan Turing Lab C', code: 'LAB-0C', type: 'lab', capacity: 45, floor: 0, floor_name: 'Ground', is_active: 1 },
    { name: 'Sutherland Lee Lab A', code: 'LAB-1A', type: 'lab', capacity: 45, floor: 1, floor_name: 'First', is_active: 1 },
    { name: 'Sutherland Lee Lab B', code: 'LAB-1B', type: 'lab', capacity: 45, floor: 1, floor_name: 'First', is_active: 1 },
    { name: 'Sutherland Lee Lab C', code: 'LAB-1C', type: 'lab', capacity: 45, floor: 1, floor_name: 'First', is_active: 1 },
    { name: 'Aryabhatta Lab A', code: 'LAB-2A', type: 'lab', capacity: 45, floor: 2, floor_name: 'Second', is_active: 1 },
    { name: 'Aryabhatta Lab B', code: 'LAB-2B', type: 'lab', capacity: 45, floor: 2, floor_name: 'Second', is_active: 1 },
    { name: 'Aryabhatta Lab C', code: 'LAB-2C', type: 'lab', capacity: 45, floor: 2, floor_name: 'Second', is_active: 1 },
    { name: 'Bellman Ford Lab A', code: 'LAB-3A', type: 'lab', capacity: 45, floor: 3, floor_name: 'Third', is_active: 1 },
    { name: 'Bellman Ford Lab B', code: 'LAB-3B', type: 'lab', capacity: 45, floor: 3, floor_name: 'Third', is_active: 1 },
    { name: 'Bellman Ford Lab C', code: 'LAB-3C', type: 'lab', capacity: 45, floor: 3, floor_name: 'Third', is_active: 1 }
  ];

  const upsert = db.prepare(`
    INSERT INTO rooms (name, code, type, capacity, floor, floor_name, is_active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(name) DO UPDATE SET
      code = excluded.code,
      type = excluded.type,
      capacity = excluded.capacity,
      floor = excluded.floor,
      floor_name = excluded.floor_name,
      is_active = 1
  `);

  const validNames = defaultRooms.map(r => r.name);
  const restoreTx = db.transaction(() => {
    try {
      db.prepare(`
        DELETE FROM rooms 
        WHERE name NOT IN (${validNames.map(() => '?').join(',')})
          AND id NOT IN (SELECT room_id FROM timetable_entries)
      `).run(...validNames);
    } catch (e) {}

    for (const r of defaultRooms) {
      upsert.run(r.name, r.code, r.type, r.capacity, r.floor, r.floor_name);
    }
    db.prepare('INSERT INTO audit_log (user_id, action, details_json) VALUES (?, ?, ?)')
      .run(req.user?.id || 1, 'ROOMS_RESTORED', JSON.stringify({ count: defaultRooms.length, restoredAt: new Date().toISOString() }));
  });

  try {
    restoreTx();
    const allRooms = db.prepare('SELECT * FROM rooms ORDER BY type, name ASC').all();
    res.json({ success: true, message: 'All 29 default rooms restored successfully', rooms: allRooms });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to restore default rooms' });
  }
});

router.post('/rooms', (req, res) => {
  const { name, type, capacity, isActive } = req.body;
  const db = getDatabase();

  const result = db.prepare(`
    INSERT INTO rooms (name, type, capacity, is_active)
    VALUES (?, ?, ?, ?)
  `).run(name, type, capacity, isActive ?? 1);

  res.status(201).json({ success: true, id: result.lastInsertRowid });
});

router.put('/rooms/:id', (req, res) => {
  const roomId = parseInt(req.params.id, 10);
  const { name, type, capacity, isActive } = req.body;
  const db = getDatabase();

  db.prepare(`
    UPDATE rooms
    SET name = ?, type = ?, capacity = ?, is_active = ?
    WHERE id = ?
  `).run(name, type, capacity, isActive ?? 1, roomId);

  res.json({ success: true, message: 'Room updated successfully' });
});

router.delete('/rooms/:id', (req, res) => {
  const roomId = parseInt(req.params.id, 10);
  const db = getDatabase();

  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  const deleteTx = db.transaction(() => {
    db.prepare('DELETE FROM timetable_entries WHERE room_id = ?').run(roomId);
    db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId);

    db.prepare('INSERT INTO audit_log (user_id, action, details_json) VALUES (?, ?, ?)')
      .run(req.user?.id || null, 'ROOM_DELETED', JSON.stringify({ roomId, name: room.name }));
  });

  try {
    deleteTx();
    res.json({ success: true, message: `Room ${room.name} deleted successfully` });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to delete room' });
  }
});

// 7. Holidays CRUD
router.post('/holidays', (req, res) => {
  const { date, description } = req.body;
  const db = getDatabase();

  const result = db.prepare(`
    INSERT INTO holidays (date, description)
    VALUES (?, ?)
  `).run(date, description);

  res.status(201).json({ success: true, id: result.lastInsertRowid });
});

router.delete('/holidays/:id', (req, res) => {
  const holidayId = parseInt(req.params.id, 10);
  const db = getDatabase();

  const hol = db.prepare('SELECT * FROM holidays WHERE id = ?').get(holidayId);
  if (!hol) {
    return res.status(404).json({ error: 'Holiday not found' });
  }

  db.prepare('DELETE FROM holidays WHERE id = ?').run(holidayId);
  db.prepare('INSERT INTO audit_log (user_id, action, details_json) VALUES (?, ?, ?)')
    .run(req.user?.id || null, 'HOLIDAY_DELETED', JSON.stringify({ holidayId, date: hol.date, description: hol.description }));
  res.json({ success: true, message: `Holiday removed successfully` });
});

// 7b. Departments CRUD
router.post('/departments', (req, res) => {
  const { name, code } = req.body;
  const db = getDatabase();

  const result = db.prepare(`
    INSERT INTO departments (name, code)
    VALUES (?, ?)
  `).run(name, code);

  res.status(201).json({ success: true, id: result.lastInsertRowid });
});

router.put('/departments/:id', (req, res) => {
  const deptId = parseInt(req.params.id, 10);
  const { name, code } = req.body;
  const db = getDatabase();

  db.prepare(`
    UPDATE departments
    SET name = ?, code = ?
    WHERE id = ?
  `).run(name, code, deptId);

  res.json({ success: true, message: 'Department updated successfully' });
});

router.delete('/departments/:id', (req, res) => {
  const deptId = parseInt(req.params.id, 10);
  const db = getDatabase();

  const dept = db.prepare('SELECT * FROM departments WHERE id = ?').get(deptId);
  if (!dept) {
    return res.status(404).json({ error: 'Department not found' });
  }

  const deleteTx = db.transaction(() => {
    // 1. Cascade delete all sections belonging to this department
    const sections = db.prepare('SELECT id FROM sections WHERE department_id = ?').all(deptId);
    for (const sec of sections) {
      db.prepare('DELETE FROM timetable_entries WHERE section_id = ?').run(sec.id);
      db.prepare('DELETE FROM section_subjects WHERE section_id = ?').run(sec.id);
      db.prepare('UPDATE users SET student_id = NULL WHERE student_id = ?').run(sec.id);
      db.prepare('DELETE FROM sections WHERE id = ?').run(sec.id);
    }

    // 2. Cascade delete all subjects belonging to this department
    const subjects = db.prepare('SELECT id FROM subjects WHERE department_id = ?').all(deptId);
    for (const sub of subjects) {
      db.prepare('DELETE FROM timetable_entries WHERE subject_id = ?').run(sub.id);
      db.prepare('DELETE FROM section_subjects WHERE subject_id = ?').run(sub.id);
      db.prepare('DELETE FROM faculty_subjects WHERE subject_id = ?').run(sub.id);
      db.prepare('DELETE FROM subjects WHERE id = ?').run(sub.id);
    }

    // 3. Cascade delete all faculty belonging to this department
    const facultyList = db.prepare('SELECT id FROM faculty WHERE department_id = ?').all(deptId);
    for (const f of facultyList) {
      db.prepare('DELETE FROM timetable_entries WHERE faculty_id = ?').run(f.id);
      db.prepare('DELETE FROM substitutions WHERE substitute_faculty_id = ? OR absence_id IN (SELECT id FROM absences WHERE faculty_id = ?)').run(f.id, f.id);
      db.prepare('DELETE FROM absences WHERE faculty_id = ?').run(f.id);
      db.prepare('DELETE FROM faculty_availability WHERE faculty_id = ?').run(f.id);
      db.prepare('DELETE FROM section_subjects WHERE faculty_id = ?').run(f.id);
      db.prepare('DELETE FROM faculty_subjects WHERE faculty_id = ?').run(f.id);
      db.prepare('DELETE FROM users WHERE faculty_id = ?').run(f.id);
      db.prepare('DELETE FROM faculty WHERE id = ?').run(f.id);
    }

    // 4. Delete department
    db.prepare('DELETE FROM departments WHERE id = ?').run(deptId);

    db.prepare('INSERT INTO audit_log (user_id, action, details_json) VALUES (?, ?, ?)')
      .run(req.user?.id || null, 'DEPARTMENT_DELETED', JSON.stringify({ departmentId: deptId, name: dept.name, code: dept.code }));
  });

  try {
    deleteTx();
    res.json({ success: true, message: `Department ${dept.code} and all associated records deleted successfully` });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to delete department' });
  }
});

// 8. Faculty Availability Grid (Weekly Matrix)
router.get('/faculty/:id/availability', (req, res) => {
  const facId = parseInt(req.params.id, 10);
  const db = getDatabase();

  const availability = db.prepare(`
    SELECT fa.*, wd.day_name, wd.day_index, ts.slot_no, ts.start_time, ts.end_time, ts.label as slot_label
    FROM faculty_availability fa
    JOIN working_days wd ON fa.day_id = wd.id
    JOIN time_slots ts ON fa.slot_id = ts.id
    WHERE fa.faculty_id = ?
    ORDER BY wd.day_index, ts.slot_no
  `).all(facId);

  // Requirement 3: Read busy/free slots from faculty_sessions (in addition to timetable_entries)
  const dayCodeMap = { 1: 'MON', 2: 'TUE', 3: 'WED', 4: 'THU', 5: 'FRI', 6: 'SAT' };
  const periodMap = { 1: 1, 2: 2, 4: 3, 5: 4, 7: 5, 8: 6, 9: 7 };

  const facultyRow = db.prepare('SELECT id, code, name FROM faculty WHERE id = ?').get(facId);
  const facSessions = db.prepare(`
    SELECT * FROM faculty_sessions
    WHERE faculty_id = ? OR faculty_id = ? OR faculty_id = ?
  `).all(String(facId), facultyRow?.code || '', facultyRow?.name || '');

  const activeEntries = db.prepare(`
    SELECT te.*, s.name as subject_name, s.code as subject_code
    FROM timetable_entries te
    JOIN subjects s ON te.subject_id = s.id
    WHERE te.faculty_id = ?
  `).all(facId);

  for (const item of availability) {
    const dayCode = dayCodeMap[item.day_index];
    const period = periodMap[item.slot_no];

    let busySession = null;
    if (dayCode && period) {
      const matchSess = facSessions.find(fs => 
        fs.day === dayCode && 
        fs.period_start != null && 
        fs.period_start <= period && 
        (fs.period_end != null ? fs.period_end : fs.period_start) >= period
      );
      if (matchSess) {
        busySession = {
          subject: matchSess.subject_code,
          type: matchSess.type,
          batch: matchSess.batch,
          section: matchSess.section,
          semester: matchSess.semester,
          source: 'faculty_sessions'
        };
      }
    }

    if (!busySession) {
      const matchEntry = activeEntries.find(te => te.day_id === item.day_id && te.slot_id === item.slot_id);
      if (matchEntry) {
        busySession = {
          subject: matchEntry.subject_code || matchEntry.subject_name,
          type: matchEntry.is_lab_block ? 'lab' : 'theory',
          source: 'timetable_entries'
        };
      }
    }

    if (busySession) {
      item.is_available = 0;
      item.is_busy = 1;
      item.busy_session = busySession;
    } else {
      item.is_busy = 0;
    }
  }

  res.json({ availability });
});

router.put('/faculty/:id/availability', (req, res) => {
  const facId = parseInt(req.params.id, 10);
  const { availability } = req.body; // array of { dayId, slotId, isAvailable }
  const db = getDatabase();

  const updateStmt = db.prepare(`
    INSERT INTO faculty_availability (faculty_id, day_id, slot_id, is_available)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(faculty_id, day_id, slot_id) DO UPDATE SET is_available = excluded.is_available
  `);

  const updateTx = db.transaction(() => {
    for (const item of availability) {
      updateStmt.run(facId, item.dayId, item.slotId, item.isAvailable ? 1 : 0);
    }
  });

  updateTx();
  res.json({ success: true, message: 'Faculty availability grid updated successfully' });
});

// 9. Course & Section Assignments (Qualifications & Section mappings)
router.get('/assignments', (req, res) => {
  const db = getDatabase();

  const facultySubjects = db.prepare(`
    SELECT fs.*, f.name as faculty_name, s.name as subject_name, s.code as subject_code
    FROM faculty_subjects fs
    JOIN faculty f ON fs.faculty_id = f.id
    JOIN subjects s ON fs.subject_id = s.id
    ORDER BY f.name, s.code
  `).all();

  const sectionSubjects = db.prepare(`
    SELECT ss.*, sec.name as section_name, s.name as subject_name, s.code as subject_code, s.weekly_periods,
           f.name as faculty_name
    FROM section_subjects ss
    JOIN sections sec ON ss.section_id = sec.id
    JOIN subjects s ON ss.subject_id = s.id
    JOIN faculty f ON ss.faculty_id = f.id
    ORDER BY sec.name, s.code
  `).all();

  res.json({ facultySubjects, sectionSubjects });
});

router.post('/assignments/section-subject', (req, res) => {
  const { sectionId, subjectId, facultyId } = req.body;
  const db = getDatabase();

  db.prepare(`
    INSERT INTO section_subjects (section_id, subject_id, faculty_id)
    VALUES (?, ?, ?)
    ON CONFLICT(section_id, subject_id) DO UPDATE SET faculty_id = excluded.faculty_id
  `).run(sectionId, subjectId, facultyId);

  res.json({ success: true, message: 'Section subject assigned successfully' });
});

router.delete('/assignments/section-subject', (req, res) => {
  const { sectionId, subjectId } = req.body;
  const db = getDatabase();

  db.prepare('DELETE FROM section_subjects WHERE section_id = ? AND subject_id = ?').run(sectionId, subjectId);
  res.json({ success: true, message: 'Assignment removed' });
});

// 10. Database Backup System (JSON Snapshot)
router.get('/backup', (req, res) => {
  const db = getDatabase();
  const timestamp = new Date().toISOString();

  // Extract complete snapshots of all relevant tables
  const departments = db.prepare('SELECT * FROM departments ORDER BY id ASC').all();
  const faculty = db.prepare('SELECT * FROM faculty ORDER BY id ASC').all();
  const subjects = db.prepare('SELECT * FROM subjects ORDER BY id ASC').all();
  const sections = db.prepare('SELECT * FROM sections ORDER BY id ASC').all();
  const rooms = db.prepare('SELECT * FROM rooms ORDER BY id ASC').all();
  const workingDays = db.prepare('SELECT * FROM working_days ORDER BY id ASC').all();
  const timeSlots = db.prepare('SELECT * FROM time_slots ORDER BY id ASC').all();
  const holidays = db.prepare('SELECT * FROM holidays ORDER BY id ASC').all();
  const facultyAvailability = db.prepare('SELECT * FROM faculty_availability').all();
  const facultySubjects = db.prepare('SELECT * FROM faculty_subjects').all();
  const sectionSubjects = db.prepare('SELECT * FROM section_subjects').all();
  const timetableVersions = db.prepare('SELECT * FROM timetable_versions ORDER BY id ASC').all();
  const timetableEntries = db.prepare('SELECT * FROM timetable_entries ORDER BY id ASC').all();
  const absences = db.prepare('SELECT * FROM absences ORDER BY id ASC').all();
  const substitutions = db.prepare('SELECT * FROM substitutions ORDER BY id ASC').all();

  const backupPayload = {
    app: 'Class Timetable Automation System (CTAS)',
    format: 'CTAS-DATABASE-SNAPSHOT-v1',
    exportedAt: timestamp,
    exportedBy: {
      userId: req.user.id,
      username: req.user.username,
      role: req.user.role
    },
    tables: {
      departments,
      faculty,
      subjects,
      sections,
      rooms,
      working_days: workingDays,
      time_slots: timeSlots,
      holidays,
      faculty_availability: facultyAvailability,
      faculty_subjects: facultySubjects,
      section_subjects: sectionSubjects,
      timetable_versions: timetableVersions,
      timetable_entries: timetableEntries,
      absences,
      substitutions
    },
    stats: {
      totalDepartments: departments.length,
      totalFaculty: faculty.length,
      totalSubjects: subjects.length,
      totalSections: sections.length,
      totalRooms: rooms.length,
      totalTimetableVersions: timetableVersions.length,
      totalTimetableEntries: timetableEntries.length
    }
  };

  // Log in audit trail
  db.prepare('INSERT INTO audit_log (user_id, action, details_json) VALUES (?, ?, ?)').run(
    req.user.id,
    'DATABASE_BACKUP_SNAPSHOT',
    JSON.stringify({ exportedAt: timestamp, stats: backupPayload.stats })
  );

  const fileDate = timestamp.slice(0, 19).replace(/[:T]/g, '-');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="ctas_backup_snapshot_${fileDate}.json"`);
  res.send(JSON.stringify(backupPayload, null, 2));
});

// Helper functions for Timetable JSON Import
function parseTimeMinutes(tStr) {
  if (!tStr) return 0;
  const parts = String(tStr).trim().split(':');
  let h = parseInt(parts[0], 10) || 0;
  const m = parseInt(parts[1] || '0', 10) || 0;
  // Handle afternoon 12-hour format e.g. "1:30" -> 13:30
  if (h >= 1 && h <= 6) h += 12;
  return h * 60 + m;
}

function normalizeDayCode(day) {
  if (!day) return 'MON';
  const d = String(day).trim().toUpperCase();
  if (d.startsWith('MON')) return 'MON';
  if (d.startsWith('TUE')) return 'TUE';
  if (d.startsWith('WED')) return 'WED';
  if (d.startsWith('THU')) return 'THU';
  if (d.startsWith('FRI')) return 'FRI';
  if (d.startsWith('SAT')) return 'SAT';
  if (d.startsWith('SUN')) return 'SUN';
  return d;
}

function checkSessionsOverlap(s1, s2) {
  // Period-based overlap
  if (s1.period_start != null && s2.period_start != null) {
    const p1s = Number(s1.period_start);
    const p1e = Number(s1.period_end ?? s1.period_start);
    const p2s = Number(s2.period_start);
    const p2e = Number(s2.period_end ?? s2.period_start);
    return Math.max(p1s, p2s) <= Math.min(p1e, p2e);
  }
  // Time-based overlap
  if (s1.start && s1.end && s2.start && s2.end) {
    const start1 = parseTimeMinutes(s1.start);
    const end1 = parseTimeMinutes(s1.end);
    const start2 = parseTimeMinutes(s2.start);
    const end2 = parseTimeMinutes(s2.end);
    return start1 < end2 && start2 < end1;
  }
  return false;
}

function validateTimetablePayload(data, db) {
  const errors = [];
  const warnings = [];

  const faculty = Array.isArray(data.faculty) ? data.faculty : [];
  const subjects = Array.isArray(data.subjects) ? data.subjects : [];
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  const breaks = Array.isArray(data.breaks) && data.breaks.length > 0 ? data.breaks : [
    { name: 'Tea Break', start: '10:30', end: '10:45' },
    { name: 'Lunch Break', start: '12:45', end: '13:30' }
  ];

  // Set of valid faculty IDs
  const knownFacultyIds = new Set(faculty.map(f => String(f.id)));
  const dbFacultyRows = db.prepare('SELECT id, name FROM faculty').all();
  dbFacultyRows.forEach(f => knownFacultyIds.add(String(f.id)));

  // 1. Check duplicate session ID
  const seenSessionIds = new Set();
  sessions.forEach(sess => {
    const sId = String(sess.id ?? '');
    if (!sId) {
      errors.push('A session is missing a required "id" attribute.');
    } else if (seenSessionIds.has(sId)) {
      errors.push(`Duplicate session id '${sId}' found in import file.`);
    } else {
      seenSessionIds.add(sId);
    }
  });

  // 2. Check session references unknown faculty_id
  sessions.forEach(sess => {
    const facId = sess.faculty_id != null ? String(sess.faculty_id) : '';
    if (!facId) {
      errors.push(`Session '${sess.id || '?'}' has no faculty_id specified.`);
    } else if (!knownFacultyIds.has(facId)) {
      errors.push(`Session '${sess.id}' references unknown faculty_id: '${sess.faculty_id}'.`);
    }
  });

  // 3. Check faculty overlapping sessions on the same day
  for (let i = 0; i < sessions.length; i++) {
    for (let j = i + 1; j < sessions.length; j++) {
      const s1 = sessions[i];
      const s2 = sessions[j];
      if (s1.faculty_id != null && s2.faculty_id != null && String(s1.faculty_id) === String(s2.faculty_id)) {
        if (normalizeDayCode(s1.day) === normalizeDayCode(s2.day)) {
          if (checkSessionsOverlap(s1, s2)) {
            const fac = faculty.find(f => String(f.id) === String(s1.faculty_id)) || dbFacultyRows.find(f => String(f.id) === String(s1.faculty_id));
            const facName = fac ? fac.name : `ID ${s1.faculty_id}`;
            errors.push(`Faculty "${facName}" has overlapping sessions on ${s1.day}: Session '${s1.id}' (${s1.subject || ''} ${s1.start || 'P' + s1.period_start}-${s1.end || 'P' + s1.period_end}) overlaps with Session '${s2.id}' (${s2.subject || ''} ${s2.start || 'P' + s2.period_start}-${s2.end || 'P' + s2.period_end}).`);
          }
        }
      }
    }
  }

  // 4. Warnings: Break overlap
  sessions.forEach(sess => {
    if (sess.start && sess.end) {
      const sStart = parseTimeMinutes(sess.start);
      const sEnd = parseTimeMinutes(sess.end);
      breaks.forEach(brk => {
        const bStart = parseTimeMinutes(brk.start);
        const bEnd = parseTimeMinutes(brk.end);
        if (sStart < bEnd && bStart < sEnd) {
          warnings.push(`Session '${sess.id}' (${sess.subject || 'Class'} on ${sess.day} ${sess.start}-${sess.end}) overlaps with scheduled break (${brk.name || 'Break'}: ${brk.start}-${brk.end}).`);
        }
      });
    }
  });

  // 5. Warnings: Holiday overlap
  const holidays = db.prepare('SELECT * FROM holidays').all();
  if (holidays.length > 0) {
    sessions.forEach(sess => {
      if (sess.date) {
        const hol = holidays.find(h => h.date === sess.date);
        if (hol) {
          warnings.push(`Session '${sess.id}' falls on scheduled holiday: ${hol.name} (${hol.date}).`);
        }
      }
    });
  }

  // 6. Warnings: Same semester + batch has two different subjects at the same time
  for (let i = 0; i < sessions.length; i++) {
    for (let j = i + 1; j < sessions.length; j++) {
      const s1 = sessions[i];
      const s2 = sessions[j];
      if (s1.semester != null && s2.semester != null && Number(s1.semester) === Number(s2.semester)) {
        if (normalizeDayCode(s1.day) === normalizeDayCode(s2.day)) {
          // Compare batch / section
          const sameBatch = (s1.batch && s2.batch && String(s1.batch).trim().toLowerCase() === String(s2.batch).trim().toLowerCase()) ||
                            (!s1.batch && !s2.batch && (!s1.section || !s2.section || String(s1.section) === String(s2.section)));
          if (sameBatch && String(s1.subject || '').trim() !== String(s2.subject || '').trim()) {
            if (checkSessionsOverlap(s1, s2)) {
              warnings.push(`Semester ${s1.semester}${s1.batch ? ' (Batch ' + s1.batch + ')' : ''} has two different subjects ('${s1.subject}' and '${s2.subject}') scheduled at the same time on ${s1.day} (${s1.start || 'P' + s1.period_start} - ${s1.end || 'P' + s1.period_end}).`);
            }
          }
        }
      }
    }
  }

  return { errors, warnings };
}

// 11. Import Timetable from JSON Endpoint (Requirements 1, 2, 4, 5)
router.post('/import-timetable', (req, res) => {
  const db = getDatabase();
  const importData = req.body?.data || req.body;

  if (!importData || (!importData.faculty && !importData.subjects && !importData.sessions)) {
    return res.status(400).json({ error: 'Invalid import payload: faculty, subjects, or sessions array expected.' });
  }

  // 1. Take pre-import snapshot for Undo (Requirement 6)
  const snapshot = {
    timestamp: new Date().toISOString(),
    facultyIdsBefore: db.prepare('SELECT id FROM faculty').all().map(r => r.id),
    subjectCodesBefore: db.prepare('SELECT code FROM subjects').all().map(r => r.code),
    sessionIdsBefore: db.prepare('SELECT id FROM faculty_sessions').all().map(r => r.id),
    facultyBefore: db.prepare('SELECT * FROM faculty').all(),
    subjectsBefore: db.prepare('SELECT * FROM subjects').all(),
    usersBefore: db.prepare("SELECT id FROM users WHERE role = 'faculty'").all().map(r => r.id)
  };

  db.prepare('INSERT INTO import_snapshots (snapshot_json) VALUES (?)').run(JSON.stringify(snapshot));

  let importedFacultyCount = 0;
  let importedSubjectsCount = 0;
  let importedSessionsCount = 0;

  try {
    // Requirement 2: All in ONE database transaction. If anything fails, rollback everything and show the real error.
    const importTx = db.transaction(() => {
      // Find or default to CSE department (NEVER create new departments or clear existing ones - Requirement 5)
      let cseDept = db.prepare("SELECT id FROM departments WHERE code = 'CSE' LIMIT 1").get();
      if (!cseDept) {
        cseDept = db.prepare("SELECT id FROM departments ORDER BY id ASC LIMIT 1").get();
      }
      const defaultDeptId = cseDept ? cseDept.id : 1;

      // Helper to normalize faculty name for matching (Requirement 4)
      const normalizeFacultyName = (name) => {
        if (!name) return '';
        return String(name).trim().toLowerCase().replace(/^(dr|prof|mrs|mr|ms)\.?\s+/i, '');
      };

      // A. Upsert Faculty (Requirement 4: Match imported faculty by name and update rather than duplicate. Keep Mrs. Manjula H S!)
      const currentFaculty = db.prepare('SELECT * FROM faculty').all();
      const inputFaculty = Array.isArray(importData.faculty) ? importData.faculty : [];

      for (const f of inputFaculty) {
        const facName = String(f.name || 'Unnamed Faculty').trim();
        const facCode = f.id != null ? String(f.id).trim() : null;
        const facEmail = f.email ? String(f.email).trim() : null;
        const facPhone = f.phone ? String(f.phone).trim() : null;
        const classesTaught = f.classes_taught != null ? String(f.classes_taught) : null;
        const effectiveFrom = f.effective_from != null ? String(f.effective_from) : null;
        const weeklyHours = f.weekly_hours != null ? Number(f.weekly_hours) : null;

        let existingFac = null;
        if (facName) {
          const norm = normalizeFacultyName(facName);
          existingFac = currentFaculty.find(ef => normalizeFacultyName(ef.name) === norm);
        }
        if (!existingFac && facCode) {
          existingFac = currentFaculty.find(ef => ef.code === facCode);
        }
        if (!existingFac && facEmail) {
          existingFac = currentFaculty.find(ef => ef.email && ef.email.toLowerCase() === facEmail.toLowerCase());
        }

        if (existingFac) {
          // Update existing faculty record, preserving ID, user account, credentials
          db.prepare(`
            UPDATE faculty
            SET name = ?,
                code = COALESCE(?, code),
                email = COALESCE(?, email),
                phone = COALESCE(?, phone),
                classes_taught = COALESCE(?, classes_taught),
                effective_from = COALESCE(?, effective_from),
                weekly_hours = COALESCE(?, weekly_hours)
            WHERE id = ?
          `).run(existingFac.name, facCode, facEmail, facPhone, classesTaught, effectiveFrom, weeklyHours, existingFac.id);

          importedFacultyCount++;
        } else {
          // Insert new faculty record
          let usernameBase = (facEmail ? facEmail.split('@')[0] : facName.toLowerCase().replace(/[^a-z0-9]/g, '')).slice(0, 20);
          let username = usernameBase || 'faculty_' + Math.floor(Math.random() * 10000);
          let uCheck = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
          let counter = 1;
          while (uCheck) {
            username = `${usernameBase}${counter++}`;
            uCheck = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
          }

          const hashedPw = bcrypt.hashSync(config.facultySeedPassword || 'man2112', 10);
          const userRes = db.prepare(`
            INSERT INTO users (username, password_hash, role, full_name, email)
            VALUES (?, ?, 'faculty', ?, ?)
          `).run(username, hashedPw, facName, facEmail || `${username}@college.edu`);

          const facRes = db.prepare(`
            INSERT INTO faculty (user_id, code, name, department_id, email, phone, max_periods_per_day, max_periods_per_week, is_active, classes_taught, effective_from, weekly_hours)
            VALUES (?, ?, ?, ?, ?, ?, 4, 18, 1, ?, ?, ?)
          `).run(userRes.lastInsertRowid, facCode, facName, defaultDeptId, facEmail || `${username}@college.edu`, facPhone || '-', classesTaught, effectiveFrom, weeklyHours);

          const newFacId = facRes.lastInsertRowid;
          db.prepare('UPDATE users SET faculty_id = ? WHERE id = ?').run(newFacId, userRes.lastInsertRowid);

          // Initialize availability
          const allDays = db.prepare('SELECT id FROM working_days').all();
          const allSlots = db.prepare('SELECT id FROM time_slots').all();
          const insAvail = db.prepare('INSERT OR IGNORE INTO faculty_availability (faculty_id, day_id, slot_id, is_available) VALUES (?, ?, ?, 1)');
          for (const d of allDays) {
            for (const sl of allSlots) {
              insAvail.run(newFacId, d.id, sl.id);
            }
          }

          importedFacultyCount++;
        }
      }

      // B. Upsert Subjects (Requirement 4)
      const inputSubjects = Array.isArray(importData.subjects) ? importData.subjects : [];
      for (const s of inputSubjects) {
        const subCode = String(s.code || '').trim().toUpperCase();
        if (!subCode) continue;
        const subName = String(s.full_name || s.name || subCode).trim();
        const subType = (String(s.type || '').toLowerCase() === 'lab') ? 'lab' : 'theory';
        const sem = Number(s.semester) || 1;
        const weeklyPeriods = (subType === 'lab') ? 2 : 4;
        const labBlockLength = (subType === 'lab') ? 2 : 1;

        const existingSub = db.prepare('SELECT id FROM subjects WHERE code = ?').get(subCode);
        if (existingSub) {
          db.prepare(`
            UPDATE subjects
            SET name = COALESCE(?, name), type = ?, semester = ?
            WHERE id = ?
          `).run(subName, subType, sem, existingSub.id);
        } else {
          db.prepare(`
            INSERT INTO subjects (code, name, type, weekly_periods, lab_block_length, department_id, semester)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(subCode, subName, subType, weeklyPeriods, labBlockLength, defaultDeptId, sem);
        }
        importedSubjectsCount++;
      }

      // C. Upsert Sessions into faculty_sessions table (Requirements 1, 2, 4, 5)
      // DO NOT write imported sessions into timetable_entries. No room column. Never touch rooms, sections, holidays, or departments.
      const inputSessions = Array.isArray(importData.sessions) ? importData.sessions : [];
      const insSession = db.prepare(`
        INSERT INTO faculty_sessions (id, faculty_id, day, start, end, period_start, period_end, subject_code, type, batch, section, semester)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          faculty_id = excluded.faculty_id,
          day = excluded.day,
          start = excluded.start,
          end = excluded.end,
          period_start = excluded.period_start,
          period_end = excluded.period_end,
          subject_code = excluded.subject_code,
          type = excluded.type,
          batch = excluded.batch,
          section = excluded.section,
          semester = excluded.semester
      `);

      for (const sess of inputSessions) {
        if (!sess.id) continue;
        insSession.run(
          String(sess.id),
          String(sess.faculty_id ?? ''),
          String(sess.day || 'MON').trim().toUpperCase(),
          sess.start ? String(sess.start) : null,
          sess.end ? String(sess.end) : null,
          sess.period_start != null ? Number(sess.period_start) : null,
          sess.period_end != null ? Number(sess.period_end) : null,
          sess.subject ? String(sess.subject) : (sess.subject_code ? String(sess.subject_code) : null),
          sess.type ? String(sess.type) : 'theory',
          sess.batch ? String(sess.batch) : null,
          sess.section ? String(sess.section) : null,
          sess.semester != null ? String(sess.semester) : null
        );
        importedSessionsCount++;
      }
    });

    importTx();

    // Audit log
    db.prepare('INSERT INTO audit_log (user_id, action, details_json) VALUES (?, ?, ?)').run(
      req.user?.id || 1,
      'IMPORT_TIMETABLE_JSON',
      JSON.stringify({
        facultyCount: importedFacultyCount,
        subjectsCount: importedSubjectsCount,
        sessionsCount: importedSessionsCount
      })
    );

    res.json({
      success: true,
      message: 'Timetable data successfully imported into faculty_sessions',
      stats: {
        faculty: importedFacultyCount,
        subjects: importedSubjectsCount,
        sessions: importedSessionsCount
      },
      canUndo: true
    });
  } catch (err) {
    // If anything fails, transaction rolls back automatically
    console.error('[CTAS Import Error]', err);
    res.status(500).json({ error: err.message || 'Import failed' });
  }
});

// 12. Undo Last Timetable Import Endpoint (Requirements 5, 6)
router.post('/undo-import', (req, res) => {
  const db = getDatabase();
  const snapshotRow = db.prepare('SELECT * FROM import_snapshots ORDER BY id DESC LIMIT 1').get();

  if (!snapshotRow) {
    return res.status(400).json({ error: 'No import snapshot available to undo.' });
  }

  let snapshot;
  try {
    snapshot = JSON.parse(snapshotRow.snapshot_json);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read snapshot data: ' + err.message });
  }

  try {
    const undoTx = db.transaction(() => {
      // 1. Remove rows added to faculty_sessions that were not in snapshot
      if (snapshot.sessionIdsBefore) {
        const existingSessionIds = new Set(snapshot.sessionIdsBefore);
        const currentSessions = db.prepare('SELECT id FROM faculty_sessions').all();
        for (const s of currentSessions) {
          if (!existingSessionIds.has(s.id)) {
            db.prepare('DELETE FROM faculty_sessions WHERE id = ?').run(s.id);
          }
        }
      } else {
        db.exec('DELETE FROM faculty_sessions');
      }

      // 2. Remove rows added to subjects that were not in snapshot
      if (snapshot.subjectCodesBefore) {
        const existingSubjectCodes = new Set(snapshot.subjectCodesBefore);
        const currentSubjects = db.prepare('SELECT code FROM subjects').all();
        for (const s of currentSubjects) {
          if (!existingSubjectCodes.has(s.code)) {
            db.prepare('DELETE FROM subjects WHERE code = ?').run(s.code);
          }
        }
      }

      // 3. Remove rows added to faculty that were not in snapshot
      if (snapshot.facultyIdsBefore) {
        const existingFacultyIds = new Set(snapshot.facultyIdsBefore);
        const currentFaculty = db.prepare('SELECT id, user_id FROM faculty').all();
        for (const f of currentFaculty) {
          if (!existingFacultyIds.has(f.id)) {
            db.prepare('DELETE FROM faculty_availability WHERE faculty_id = ?').run(f.id);
            db.prepare('DELETE FROM faculty WHERE id = ?').run(f.id);
            if (f.user_id) {
              db.prepare('DELETE FROM users WHERE id = ?').run(f.user_id);
            }
          }
        }
      }

      // 4. Restore original state of updated faculty rows (e.g. Mrs. Manjula H S)
      if (snapshot.facultyBefore) {
        for (const f of snapshot.facultyBefore) {
          db.prepare(`
            UPDATE faculty
            SET name = ?, code = ?, classes_taught = ?, effective_from = ?, weekly_hours = ?, phone = ?, email = ?
            WHERE id = ?
          `).run(f.name, f.code || null, f.classes_taught || null, f.effective_from || null, f.weekly_hours || null, f.phone || null, f.email || null, f.id);
        }
      }

      // 5. Restore original state of updated subjects
      if (snapshot.subjectsBefore) {
        for (const s of snapshot.subjectsBefore) {
          db.prepare(`
            UPDATE subjects
            SET name = ?, type = ?, semester = ?
            WHERE id = ?
          `).run(s.name, s.type, s.semester, s.id);
        }
      }

      // Requirement 5: Never touch rooms, sections, holidays or departments!

      // Delete snapshot row
      db.prepare('DELETE FROM import_snapshots WHERE id = ?').run(snapshotRow.id);
    });

    undoTx();

    // Audit log
    db.prepare('INSERT INTO audit_log (user_id, action, details_json) VALUES (?, ?, ?)').run(
      req.user?.id || 1,
      'UNDO_TIMETABLE_IMPORT',
      JSON.stringify({ snapshotId: snapshotRow.id, revertedAt: new Date().toISOString() })
    );

    const remaining = db.prepare('SELECT COUNT(*) as count FROM import_snapshots').get().count;
    res.json({
      success: true,
      message: 'Last import was successfully undone and imported rows removed.',
      canUndo: remaining > 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to undo import' });
  }
});

// 13. Undo Status Endpoint
router.get('/undo-status', (req, res) => {
  const db = getDatabase();
  const count = db.prepare('SELECT COUNT(*) as count FROM import_snapshots').get().count;
  res.json({ canUndo: count > 0 });
});

// 14. Timetable Publish (Activate) Endpoint
router.post(['/publish-timetable', '/publish', '/versions/:id/activate'], (req, res) => {
  const db = getDatabase();
  const versionIdRaw = req.params.id || req.body?.versionId;
  const versionId = versionIdRaw
    ? parseInt(versionIdRaw, 10)
    : db.prepare("SELECT id FROM timetable_versions WHERE status = 'active' OR source = 'imported_verified' ORDER BY id ASC LIMIT 1").get()?.id;

  if (!versionId) {
    return res.status(400).json({ error: 'No version ID specified' });
  }
  const targetVersion = db.prepare('SELECT * FROM timetable_versions WHERE id = ?').get(versionId);
  if (!targetVersion) {
    return res.status(404).json({ error: 'Timetable version not found' });
  }

  const entriesCountBefore = db.prepare('SELECT count(*) as count FROM timetable_entries WHERE version_id = ?').get(versionId).count;

  const activateTx = db.transaction(() => {
    db.prepare("UPDATE timetable_versions SET status = 'archived' WHERE status = 'active'").run();
    db.prepare("UPDATE timetable_entries SET is_draft = 0 WHERE version_id = ?").run(versionId);
    db.prepare("UPDATE timetable_versions SET status = 'active' WHERE id = ?").run(versionId);
    db.prepare('INSERT INTO audit_log (user_id, action, details_json) VALUES (?, ?, ?)').run(
      req.user?.id || 1,
      'TIMETABLE_ACTIVATED',
      JSON.stringify({ versionId, versionName: targetVersion.name, entriesCount: entriesCountBefore })
    );
  });

  activateTx();

  const entriesCountAfter = db.prepare('SELECT count(*) as count FROM timetable_entries WHERE version_id = ?').get(versionId).count;

  broadcast('timetable.updated', {
    type: 'version_activated',
    versionId,
    versionName: targetVersion.name
  });

  res.json({
    success: true,
    message: `Timetable '${targetVersion.name}' is now active.`,
    activeVersionId: versionId,
    status: 'ACTIVE',
    entriesCountBefore,
    entriesCountAfter
  });
});

export default router;


