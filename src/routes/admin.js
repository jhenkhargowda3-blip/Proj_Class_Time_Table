import { Router } from 'express';
import { getDatabase } from '../db/connection.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/role.js';

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
    JOIN departments d ON f.department_id = d.id
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

  res.json({
    departments,
    faculty,
    subjects,
    sections,
    rooms,
    workingDays,
    timeSlots,
    holidays
  });
});

// 3. Faculty CRUD
router.post('/faculty', (req, res) => {
  const { name, departmentId, email, phone, maxPeriodsPerDay, maxPeriodsPerWeek } = req.body;
  const db = getDatabase();

  const result = db.prepare(`
    INSERT INTO faculty (name, department_id, email, phone, max_periods_per_day, max_periods_per_week, is_active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).run(name, departmentId, email, phone, maxPeriodsPerDay || 4, maxPeriodsPerWeek || 18);

  const facId = result.lastInsertRowid;

  // Initialize faculty availability for active working days & non-break slots
  const days = db.prepare('SELECT id FROM working_days WHERE is_active = 1').all();
  const slots = db.prepare('SELECT id FROM time_slots WHERE is_break = 0').all();
  const insertAvail = db.prepare('INSERT INTO faculty_availability (faculty_id, day_id, slot_id, is_available) VALUES (?, ?, ?, 1)');
  for (const d of days) {
    for (const s of slots) {
      insertAvail.run(facId, d.id, s.id);
    }
  }

  res.status(201).json({ success: true, id: facId, message: 'Faculty created successfully' });
});

router.put('/faculty/:id', (req, res) => {
  const facId = parseInt(req.params.id, 10);
  const { name, departmentId, email, phone, maxPeriodsPerDay, maxPeriodsPerWeek, isActive } = req.body;
  const db = getDatabase();

  db.prepare(`
    UPDATE faculty
    SET name = ?, department_id = ?, email = ?, phone = ?,
        max_periods_per_day = ?, max_periods_per_week = ?, is_active = ?
    WHERE id = ?
  `).run(name, departmentId, email, phone, maxPeriodsPerDay, maxPeriodsPerWeek, isActive ?? 1, facId);

  res.json({ success: true, message: 'Faculty updated successfully' });
});

router.delete('/faculty/:id', (req, res) => {
  const facId = parseInt(req.params.id, 10);
  const db = getDatabase();

  // Delete-safety check: warn if used in timetable entries
  const usage = db.prepare('SELECT COUNT(*) as count FROM timetable_entries WHERE faculty_id = ?').get(facId).count;
  if (usage > 0 && req.query.force !== 'true') {
    return res.status(409).json({
      error: `Faculty is assigned to ${usage} timetable class(es). Remove or reassign them before deleting, or confirm force delete.`
    });
  }

  db.prepare('DELETE FROM faculty WHERE id = ?').run(facId);
  res.json({ success: true, message: 'Faculty deleted successfully' });
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

  const usage = db.prepare('SELECT COUNT(*) as count FROM timetable_entries WHERE subject_id = ?').get(subId).count;
  if (usage > 0 && req.query.force !== 'true') {
    return res.status(409).json({
      error: `Subject is scheduled in ${usage} timetable entry/entries. Remove entries before deleting.`
    });
  }

  db.prepare('DELETE FROM subjects WHERE id = ?').run(subId);
  res.json({ success: true, message: 'Subject deleted successfully' });
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

  const usage = db.prepare('SELECT COUNT(*) as count FROM timetable_entries WHERE section_id = ?').get(secId).count;
  if (usage > 0 && req.query.force !== 'true') {
    return res.status(409).json({
      error: `Section is scheduled in ${usage} timetable entry/entries. Remove entries before deleting.`
    });
  }

  db.prepare('DELETE FROM sections WHERE id = ?').run(secId);
  res.json({ success: true, message: 'Section deleted successfully' });
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

  const usage = db.prepare('SELECT COUNT(*) as count FROM timetable_entries WHERE room_id = ?').get(roomId).count;
  if (usage > 0 && req.query.force !== 'true') {
    return res.status(409).json({
      error: `Room is booked in ${usage} timetable entry/entries. Reassign classes before deleting.`
    });
  }

  db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId);
  res.json({ success: true, message: 'Room deleted successfully' });
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
  db.prepare('DELETE FROM holidays WHERE id = ?').run(holidayId);
  res.json({ success: true, message: 'Holiday removed' });
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

  const facUsage = db.prepare('SELECT COUNT(*) as count FROM faculty WHERE department_id = ?').get(deptId).count;
  const subUsage = db.prepare('SELECT COUNT(*) as count FROM subjects WHERE department_id = ?').get(deptId).count;
  const secUsage = db.prepare('SELECT COUNT(*) as count FROM sections WHERE department_id = ?').get(deptId).count;
  const total = facUsage + subUsage + secUsage;

  if (total > 0 && req.query.force !== 'true') {
    return res.status(409).json({
      error: `Department has ${facUsage} faculty, ${subUsage} subjects, and ${secUsage} sections attached. Cannot delete without force.`
    });
  }

  db.prepare('DELETE FROM departments WHERE id = ?').run(deptId);
  res.json({ success: true, message: 'Department deleted successfully' });
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

