import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { getDatabase } from '../db/connection.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/role.js';
import { registerTeacher } from '../services/teacherService.js';
import config from '../config/env.js';

const router = Router();

// Strict RBAC: Admin only for all administration endpoints
router.use(requireAuth, requireRole('admin'));

// 1. Overview Statistics & Recent Feed
router.get('/overview', (req, res) => {
  const db = getDatabase();

  const facultyCount = db.prepare('SELECT COUNT(*) as count FROM faculty WHERE is_active = 1').get().count;
  const subjectsCount = db.prepare('SELECT COUNT(*) as count FROM subjects').get().count;
  const sectionsCount = db.prepare('SELECT COUNT(*) as count FROM sections').get().count;
  const roomsCount = db.prepare('SELECT COUNT(*) as count FROM rooms WHERE is_active = 1').get().count;

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

// 11. Import Timetable from JSON Endpoint
router.post('/import-timetable', (req, res) => {
  const db = getDatabase();
  const importData = req.body?.data || req.body;

  if (!importData || (!importData.faculty && !importData.subjects && !importData.sessions)) {
    return res.status(400).json({ error: 'Invalid import payload: faculty, subjects, or sessions array expected.' });
  }

  // Server-side validation
  const { errors, warnings } = validateTimetablePayload(importData, db);
  if (errors.length > 0) {
    return res.status(400).json({
      error: 'Import blocked due to validation errors',
      errors,
      warnings
    });
  }

  // 1. Take snapshot of current state before applying changes
  const snapshot = {
    timestamp: new Date().toISOString(),
    faculty: db.prepare('SELECT * FROM faculty').all(),
    subjects: db.prepare('SELECT * FROM subjects').all(),
    sections: db.prepare('SELECT * FROM sections').all(),
    rooms: db.prepare('SELECT * FROM rooms').all(),
    timetable_entries: db.prepare('SELECT * FROM timetable_entries').all(),
    timetable_versions: db.prepare('SELECT * FROM timetable_versions').all(),
    faculty_availability: db.prepare('SELECT * FROM faculty_availability').all(),
    faculty_subjects: db.prepare('SELECT * FROM faculty_subjects').all(),
    section_subjects: db.prepare('SELECT * FROM section_subjects').all(),
    users: db.prepare("SELECT * FROM users WHERE role = 'faculty'").all()
  };

  db.prepare('INSERT INTO import_snapshots (snapshot_json) VALUES (?)').run(JSON.stringify(snapshot));

  // 2. Perform import within transaction
  let importedFacultyCount = 0;
  let importedSubjectsCount = 0;
  let importedSessionsCount = 0;

  db.transaction(() => {
    // A. Ensure CSE Department exists
    let cseDept = db.prepare("SELECT id FROM departments WHERE code = 'CSE' LIMIT 1").get();
    if (!cseDept) {
      cseDept = db.prepare("SELECT id FROM departments ORDER BY id ASC LIMIT 1").get();
    }
    const defaultDeptId = cseDept ? cseDept.id : 1;

    // B. Upsert Faculty
    const facultyIdMap = {};
    const inputFaculty = Array.isArray(importData.faculty) ? importData.faculty : [];

    inputFaculty.forEach(f => {
      const facName = String(f.name || 'Unnamed Faculty').trim();
      const facEmail = f.email ? String(f.email).trim() : null;
      const facPhone = f.phone ? String(f.phone).trim() : null;
      const classesTaught = f.classes_taught != null ? String(f.classes_taught) : null;
      const effectiveFrom = f.effective_from != null ? String(f.effective_from) : null;
      const weeklyHours = f.weekly_hours != null ? Number(f.weekly_hours) : null;

      // Check matching by ID or email
      let existingFac = null;
      if (f.id != null) {
        existingFac = db.prepare('SELECT * FROM faculty WHERE id = ?').get(f.id);
      }
      if (!existingFac && facEmail) {
        existingFac = db.prepare('SELECT * FROM faculty WHERE email = ?').get(facEmail);
      }
      if (!existingFac && facName) {
        existingFac = db.prepare('SELECT * FROM faculty WHERE name = ?').get(facName);
      }

      if (existingFac) {
        // Update existing record, preserving ID, user_id, credentials
        db.prepare(`
          UPDATE faculty
          SET name = ?, email = COALESCE(?, email), phone = COALESCE(?, phone),
              classes_taught = ?, effective_from = ?, weekly_hours = ?
          WHERE id = ?
        `).run(facName, facEmail, facPhone, classesTaught, effectiveFrom, weeklyHours, existingFac.id);

        facultyIdMap[String(f.id ?? existingFac.id)] = existingFac.id;
        importedFacultyCount++;
      } else {
        // Create new faculty record with Max Load = 18 for new faculty
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
          INSERT INTO faculty (user_id, name, department_id, email, phone, max_periods_per_day, max_periods_per_week, is_active, classes_taught, effective_from, weekly_hours)
          VALUES (?, ?, ?, ?, ?, 4, 18, 1, ?, ?, ?)
        `).run(userRes.lastInsertRowid, facName, defaultDeptId, facEmail || `${username}@college.edu`, facPhone || '-', classesTaught, effectiveFrom, weeklyHours);

        const newFacId = facRes.lastInsertRowid;
        db.prepare('UPDATE users SET faculty_id = ? WHERE id = ?').run(newFacId, userRes.lastInsertRowid);
        facultyIdMap[String(f.id ?? newFacId)] = newFacId;

        // Initialize faculty availability (available for all slots by default)
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
    });

    // C. Upsert Subjects
    const subjectIdMap = {};
    const inputSubjects = Array.isArray(importData.subjects) ? importData.subjects : [];

    inputSubjects.forEach(s => {
      const subCode = String(s.code || '').trim().toUpperCase();
      if (!subCode) return;
      const subName = String(s.full_name || s.name || subCode).trim();
      const subType = (String(s.type || '').toLowerCase() === 'lab') ? 'lab' : 'theory';
      const sem = Number(s.semester) || 1;
      const weeklyPeriods = (subType === 'lab') ? 2 : 4;
      const labBlockLength = (subType === 'lab') ? 2 : 1;

      let existingSub = db.prepare('SELECT id FROM subjects WHERE code = ?').get(subCode);
      if (existingSub) {
        db.prepare(`
          UPDATE subjects
          SET name = ?, type = ?, semester = ?
          WHERE id = ?
        `).run(subName, subType, sem, existingSub.id);
        subjectIdMap[subCode] = existingSub.id;
      } else {
        const subRes = db.prepare(`
          INSERT INTO subjects (code, name, type, weekly_periods, lab_block_length, department_id, semester)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(subCode, subName, subType, weeklyPeriods, labBlockLength, defaultDeptId, sem);
        subjectIdMap[subCode] = subRes.lastInsertRowid;
      }
      importedSubjectsCount++;
    });

    // D. Ensure default rooms exist
    let defaultClassroom = db.prepare("SELECT id FROM rooms WHERE type = 'classroom' AND is_active = 1 LIMIT 1").get();
    if (!defaultClassroom) {
      const r = db.prepare("INSERT INTO rooms (name, type, capacity, is_active) VALUES ('Classroom 101', 'classroom', 60, 1)").run();
      defaultClassroom = { id: r.lastInsertRowid };
    }
    let defaultLab = db.prepare("SELECT id FROM rooms WHERE type = 'lab' AND is_active = 1 LIMIT 1").get();
    if (!defaultLab) {
      const l = db.prepare("INSERT INTO rooms (name, type, capacity, is_active) VALUES ('Computing Lab A', 'lab', 30, 1)").run();
      defaultLab = { id: l.lastInsertRowid };
    }

    // E. Ensure active timetable version exists
    let activeVer = db.prepare("SELECT id FROM timetable_versions WHERE status = 'active' LIMIT 1").get();
    if (!activeVer) {
      const vRes = db.prepare("INSERT INTO timetable_versions (name, status, notes) VALUES ('Master Academic Timetable', 'active', 'Imported Timetable')").run();
      activeVer = { id: vRes.lastInsertRowid };
    }

    // F. Map Sections
    const sectionIdMap = {};
    const inputSessions = Array.isArray(importData.sessions) ? importData.sessions : [];

    inputSessions.forEach(sess => {
      const secName = sess.section ? String(sess.section).trim() : (sess.semester ? (`Sem ${sess.semester}` + (sess.batch ? `-${sess.batch}` : '')) : 'Section A');
      if (!sectionIdMap[secName]) {
        let existingSec = db.prepare('SELECT id FROM sections WHERE name = ?').get(secName);
        if (!existingSec) {
          const semNum = Number(sess.semester) || 1;
          const sRes = db.prepare('INSERT INTO sections (name, semester, department_id, strength) VALUES (?, ?, ?, 40)').run(secName, semNum, defaultDeptId);
          existingSec = { id: sRes.lastInsertRowid };
        }
        sectionIdMap[secName] = existingSec.id;
      }
    });

    // G. Map Sessions into timetable_entries
    const dayIndexMap = { 'MON': 1, 'TUE': 2, 'WED': 3, 'THU': 4, 'FRI': 5, 'SAT': 6 };
    // Non-break period slots
    const periodSlotMap = { 1: 1, 2: 2, 3: 4, 4: 5, 5: 7, 6: 8, 7: 9 };
    const nonBreakSlots = db.prepare('SELECT * FROM time_slots WHERE is_break = 0 ORDER BY slot_no ASC').all();

    inputSessions.forEach(sess => {
      // Resolve faculty
      const rawFacId = sess.faculty_id != null ? String(sess.faculty_id) : '';
      let facId = facultyIdMap[rawFacId];
      if (!facId && rawFacId) {
        const facRow = db.prepare('SELECT id FROM faculty WHERE id = ?').get(rawFacId);
        facId = facRow ? facRow.id : null;
      }
      if (!facId) return; // skip if cannot resolve

      // Resolve subject
      const subCode = String(sess.subject || '').trim().toUpperCase();
      let subId = subjectIdMap[subCode];
      if (!subId && subCode) {
        const subRow = db.prepare('SELECT id FROM subjects WHERE code = ?').get(subCode);
        if (subRow) {
          subId = subRow.id;
        } else {
          // Auto create subject if needed
          const isLab = String(sess.type || '').toLowerCase() === 'lab';
          const subRes = db.prepare('INSERT INTO subjects (code, name, type, weekly_periods, lab_block_length, department_id, semester) VALUES (?, ?, ?, ?, ?, ?, ?)').run(subCode, subCode, isLab ? 'lab' : 'theory', isLab ? 2 : 4, isLab ? 2 : 1, defaultDeptId, Number(sess.semester) || 1);
          subId = subRes.lastInsertRowid;
          subjectIdMap[subCode] = subId;
        }
      }
      if (!subId) return;

      // Resolve section
      const secName = sess.section ? String(sess.section).trim() : (sess.semester ? (`Sem ${sess.semester}` + (sess.batch ? `-${sess.batch}` : '')) : 'Section A');
      const secId = sectionIdMap[secName];
      if (!secId) return;

      // Resolve day
      const dayCode = normalizeDayCode(sess.day);
      const dayIdx = dayIndexMap[dayCode] || 1;
      const dayRow = db.prepare('SELECT id FROM working_days WHERE day_index = ?').get(dayIdx);
      const dayId = dayRow ? dayRow.id : 1;

      // Resolve room
      const isLab = String(sess.type || '').toLowerCase() === 'lab';
      const roomId = isLab ? defaultLab.id : defaultClassroom.id;

      // Determine slots
      const targetSlots = [];
      if (sess.period_start != null) {
        const pStart = Number(sess.period_start);
        const pEnd = Number(sess.period_end ?? sess.period_start);
        for (let p = pStart; p <= pEnd; p++) {
          if (periodSlotMap[p]) targetSlots.push(periodSlotMap[p]);
        }
      } else if (sess.start && sess.end) {
        const sStart = parseTimeMinutes(sess.start);
        const sEnd = parseTimeMinutes(sess.end);
        nonBreakSlots.forEach(sl => {
          const slStart = parseTimeMinutes(sl.start_time);
          const slEnd = parseTimeMinutes(sl.end_time);
          if (sStart < slEnd && slStart < sEnd) {
            targetSlots.push(sl.id);
          }
        });
      }

      // If no slots matched, fallback to period 1
      if (targetSlots.length === 0) {
        targetSlots.push(1);
      }

      targetSlots.forEach(slotId => {
        // Remove any conflicting entry for this slot in active version to ensure re-import is clean and without duplicates
        db.prepare('DELETE FROM timetable_entries WHERE version_id = ? AND section_id = ? AND day_id = ? AND slot_id = ?').run(activeVer.id, secId, dayId, slotId);
        db.prepare('DELETE FROM timetable_entries WHERE version_id = ? AND faculty_id = ? AND day_id = ? AND slot_id = ?').run(activeVer.id, facId, dayId, slotId);
        db.prepare('DELETE FROM timetable_entries WHERE version_id = ? AND room_id = ? AND day_id = ? AND slot_id = ?').run(activeVer.id, roomId, dayId, slotId);

        db.prepare(`
          INSERT INTO timetable_entries (version_id, section_id, subject_id, faculty_id, room_id, day_id, slot_id, is_lab_block, locked, is_draft)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
        `).run(activeVer.id, secId, subId, facId, roomId, dayId, slotId, isLab ? 1 : 0);

        // Ensure relational mappings
        db.prepare('INSERT OR IGNORE INTO faculty_subjects (faculty_id, subject_id) VALUES (?, ?)').run(facId, subId);
        db.prepare(`
          INSERT INTO section_subjects (section_id, subject_id, faculty_id)
          VALUES (?, ?, ?)
          ON CONFLICT(section_id, subject_id) DO UPDATE SET faculty_id = excluded.faculty_id
        `).run(secId, subId, facId);

        importedSessionsCount++;
      });
    });
  })();

  // Log in audit trail
  db.prepare('INSERT INTO audit_log (user_id, action, details_json) VALUES (?, ?, ?)').run(
    req.user.id,
    'IMPORT_TIMETABLE_JSON',
    JSON.stringify({
      facultyCount: importedFacultyCount,
      subjectsCount: importedSubjectsCount,
      sessionsCount: importedSessionsCount,
      warningsCount: warnings.length
    })
  );

  res.json({
    success: true,
    message: 'Timetable data successfully imported',
    stats: {
      faculty: importedFacultyCount,
      subjects: importedSubjectsCount,
      sessions: importedSessionsCount
    },
    warnings,
    canUndo: true
  });
});

// 12. Undo Last Timetable Import Endpoint
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

  db.transaction(() => {
    db.pragma('foreign_keys = OFF');
    try {
      // 1. Clear affected tables
      db.exec('DELETE FROM timetable_entries');
      db.exec('DELETE FROM section_subjects');
      db.exec('DELETE FROM faculty_subjects');
      db.exec('DELETE FROM faculty_availability');
      db.exec('DELETE FROM faculty');
      db.exec('DELETE FROM subjects');
      db.exec('DELETE FROM sections');
      db.exec('DELETE FROM rooms');
      db.exec('DELETE FROM timetable_versions');

      // 2. Restore rooms
      const insRoom = db.prepare('INSERT INTO rooms (id, name, type, capacity, is_active) VALUES (?, ?, ?, ?, ?)');
      for (const r of snapshot.rooms || []) {
        insRoom.run(r.id, r.name, r.type, r.capacity, r.is_active);
      }

      // 3. Restore sections
      const insSec = db.prepare('INSERT INTO sections (id, name, semester, department_id, strength) VALUES (?, ?, ?, ?, ?)');
      for (const s of snapshot.sections || []) {
        insSec.run(s.id, s.name, s.semester, s.department_id, s.strength);
      }

      // 4. Restore subjects
      const insSub = db.prepare('INSERT INTO subjects (id, code, name, type, weekly_periods, lab_block_length, department_id, semester) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      for (const sub of snapshot.subjects || []) {
        insSub.run(sub.id, sub.code, sub.name, sub.type, sub.weekly_periods, sub.lab_block_length, sub.department_id, sub.semester);
      }

      // 5. Restore faculty
      const insFac = db.prepare('INSERT INTO faculty (id, user_id, name, department_id, email, phone, max_periods_per_day, max_periods_per_week, is_active, classes_taught, effective_from, weekly_hours) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const f of snapshot.faculty || []) {
        insFac.run(f.id, f.user_id, f.name, f.department_id, f.email, f.phone, f.max_periods_per_day, f.max_periods_per_week, f.is_active, f.classes_taught || null, f.effective_from || null, f.weekly_hours || null);
      }

      // 6. Restore timetable_versions
      const insVer = db.prepare('INSERT INTO timetable_versions (id, name, status, created_by, created_at, notes) VALUES (?, ?, ?, ?, ?, ?)');
      for (const v of snapshot.timetable_versions || []) {
        insVer.run(v.id, v.name, v.status, v.created_by, v.created_at, v.notes);
      }

      // 7. Restore timetable_entries
      const insEntry = db.prepare('INSERT INTO timetable_entries (id, version_id, section_id, subject_id, faculty_id, room_id, day_id, slot_id, is_lab_block, locked, is_draft) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const te of snapshot.timetable_entries || []) {
        insEntry.run(te.id, te.version_id, te.section_id, te.subject_id, te.faculty_id, te.room_id, te.day_id, te.slot_id, te.is_lab_block, te.locked, te.is_draft);
      }

      // 8. Restore faculty_availability
      const insAvail = db.prepare('INSERT INTO faculty_availability (faculty_id, day_id, slot_id, is_available) VALUES (?, ?, ?, ?)');
      for (const a of snapshot.faculty_availability || []) {
        insAvail.run(a.faculty_id, a.day_id, a.slot_id, a.is_available);
      }

      // 9. Restore faculty_subjects & section_subjects
      const insFS = db.prepare('INSERT INTO faculty_subjects (faculty_id, subject_id) VALUES (?, ?)');
      for (const fs of snapshot.faculty_subjects || []) {
        insFS.run(fs.faculty_id, fs.subject_id);
      }
      const insSS = db.prepare('INSERT INTO section_subjects (section_id, subject_id, faculty_id) VALUES (?, ?, ?)');
      for (const ss of snapshot.section_subjects || []) {
        insSS.run(ss.section_id, ss.subject_id, ss.faculty_id);
      }

      // 10. Clean up any newly created faculty user accounts
      if (snapshot.users) {
        const snapUserIds = new Set(snapshot.users.map(u => u.id));
        const allFacultyUsers = db.prepare("SELECT id FROM users WHERE role = 'faculty'").all();
        for (const u of allFacultyUsers) {
          if (!snapUserIds.has(u.id)) {
            db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
          }
        }
      }

      // Delete this snapshot record
      db.prepare('DELETE FROM import_snapshots WHERE id = ?').run(snapshotRow.id);
    } finally {
      db.pragma('foreign_keys = ON');
    }
  })();

  // Audit log
  db.prepare('INSERT INTO audit_log (user_id, action, details_json) VALUES (?, ?, ?)').run(
    req.user.id,
    'UNDO_TIMETABLE_IMPORT',
    JSON.stringify({ snapshotId: snapshotRow.id, revertedAt: new Date().toISOString() })
  );

  const remaining = db.prepare('SELECT COUNT(*) as count FROM import_snapshots').get().count;
  res.json({
    success: true,
    message: 'Last import was successfully undone and previous state restored.',
    canUndo: remaining > 0
  });
});

// 13. Undo Status Endpoint
router.get('/undo-status', (req, res) => {
  const db = getDatabase();
  const count = db.prepare('SELECT COUNT(*) as count FROM import_snapshots').get().count;
  res.json({ canUndo: count > 0 });
});

export default router;


