import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { getDatabase } from '../db/connection.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/role.js';
import { registerTeacher } from '../services/teacherService.js';

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

export default router;

