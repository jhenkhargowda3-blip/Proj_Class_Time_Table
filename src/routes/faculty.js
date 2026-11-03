import { Router } from 'express';
import { getDatabase } from '../db/connection.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/role.js';
import { getFacultyCalendar, getFacultyDaySchedule } from '../services/calendar.js';

const router = Router();

// Strict RBAC: Faculty or Admin
router.use(requireAuth, requireRole('faculty', 'admin'));

// Helper to resolve target faculty ID
function resolveFacultyId(req) {
  if (req.user.role === 'admin' && req.query.facultyId) {
    return parseInt(req.query.facultyId, 10);
  }
  if (req.user.facultyId || req.user.faculty_id) {
    return req.user.facultyId || req.user.faculty_id;
  }
  const db = getDatabase();
  if (req.user.id) {
    const userRow = db.prepare('SELECT faculty_id FROM users WHERE id = ?').get(req.user.id);
    if (userRow?.faculty_id) return userRow.faculty_id;
    const facRow = db.prepare('SELECT id FROM faculty WHERE user_id = ?').get(req.user.id);
    if (facRow?.id) return facRow.id;
  }
  if (req.user.role === 'admin') {
    const firstFac = db.prepare('SELECT id FROM faculty WHERE is_active = 1 ORDER BY id ASC LIMIT 1').get();
    if (firstFac?.id) return firstFac.id;
  }
  return null;
}

// 1. Faculty Profile & Weekly Load Stats
router.get('/profile', (req, res) => {
  const db = getDatabase();
  const facultyId = resolveFacultyId(req);

  if (!facultyId) {
    return res.status(400).json({ error: 'Faculty profile not associated with this account' });
  }

  const faculty = db.prepare(`
    SELECT f.*, d.name as department_name, d.code as department_code, u.username
    FROM faculty f
    LEFT JOIN departments d ON f.department_id = d.id
    LEFT JOIN users u ON f.user_id = u.id
    WHERE f.id = ?
  `).get(facultyId);

  if (!faculty) {
    return res.status(404).json({ error: 'Faculty record not found' });
  }

  // Assigned subjects
  const subjects = db.prepare(`
    SELECT s.*, ss.section_id, sec.name as section_name
    FROM section_subjects ss
    JOIN subjects s ON ss.subject_id = s.id
    JOIN sections sec ON ss.section_id = sec.id
    WHERE ss.faculty_id = ?
  `).all(facultyId);

  // Active timetable entries for this faculty
  const entries = db.prepare(`
    SELECT te.*, s.name as subject_name, s.code as subject_code, s.type as subject_type,
           sec.name as section_name, r.name as room_name,
           wd.day_name, wd.day_index,
           ts.slot_no, ts.start_time, ts.end_time, ts.label as slot_label
    FROM timetable_entries te
    JOIN timetable_versions tv ON te.version_id = tv.id AND tv.status = 'active'
    JOIN subjects s ON te.subject_id = s.id
    JOIN sections sec ON te.section_id = sec.id
    JOIN rooms r ON te.room_id = r.id
    JOIN working_days wd ON te.day_id = wd.id
    JOIN time_slots ts ON te.slot_id = ts.id
    WHERE te.faculty_id = ?
    ORDER BY wd.day_index, ts.slot_no
  `).all(facultyId);

  res.json({
    faculty,
    assignedSubjects: subjects,
    weeklySchedule: entries
  });
});

// 2. Monthly Interactive Calendar (Green-Present convention + Holiday/Absence overlay)
router.get('/calendar', (req, res) => {
  const facultyId = resolveFacultyId(req);
  if (!facultyId) return res.status(400).json({ error: 'Faculty ID required' });

  const now = new Date();
  const year = req.query.year ? parseInt(req.query.year, 10) : now.getUTCFullYear();
  const month = req.query.month ? parseInt(req.query.month, 10) : now.getUTCMonth();

  const calData = getFacultyCalendar(facultyId, year, month);
  res.json(calData);
});

// 3. Detailed Schedule for a Specific Date (Slide-in Panel breakdown)
router.get('/schedule-date', (req, res) => {
  const facultyId = resolveFacultyId(req);
  if (!facultyId) return res.status(400).json({ error: 'Faculty ID required' });

  const dateStr = req.query.date || new Date().toISOString().split('T')[0];
  const daySchedule = getFacultyDaySchedule(facultyId, dateStr);
  res.json(daySchedule);
});

// 4. Today View with Live Next Class Tracker & Countdown
router.get('/today', (req, res) => {
  const facultyId = resolveFacultyId(req);
  if (!facultyId) return res.status(400).json({ error: 'Faculty ID required' });

  const todayStr = new Date().toISOString().split('T')[0];
  const daySchedule = getFacultyDaySchedule(facultyId, todayStr);

  const now = new Date();
  const curTimeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  // Find current and next teaching class
  const activeClasses = daySchedule.schedule.filter(s => !s.isBreak && !s.isFree);
  let currentClass = null;
  let nextClass = null;

  for (const c of activeClasses) {
    if (curTimeStr >= c.startTime && curTimeStr <= c.endTime) {
      currentClass = c;
    } else if (c.startTime > curTimeStr && !nextClass) {
      nextClass = c;
    }
  }

  res.json({
    date: todayStr,
    currentClass,
    nextClass,
    allClasses: activeClasses,
    daySchedule
  });
});

// 5. Faculty Availability Preferences
router.get('/availability', (req, res) => {
  const facultyId = resolveFacultyId(req);
  const db = getDatabase();

  const availability = db.prepare(`
    SELECT fa.*, wd.day_name, wd.day_index, ts.slot_no, ts.start_time, ts.end_time, ts.label as slot_label
    FROM faculty_availability fa
    JOIN working_days wd ON fa.day_id = wd.id
    JOIN time_slots ts ON fa.slot_id = ts.id
    WHERE fa.faculty_id = ?
    ORDER BY wd.day_index, ts.slot_no
  `).all(facultyId);

  res.json({ availability });
});

router.put('/availability', (req, res) => {
  const facultyId = resolveFacultyId(req);
  const { availability } = req.body;
  const db = getDatabase();

  const updateStmt = db.prepare(`
    INSERT INTO faculty_availability (faculty_id, day_id, slot_id, is_available)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(faculty_id, day_id, slot_id) DO UPDATE SET is_available = excluded.is_available
  `);

  const tx = db.transaction(() => {
    for (const item of availability) {
      updateStmt.run(facultyId, item.dayId, item.slotId, item.isAvailable ? 1 : 0);
    }
  });

  tx();
  res.json({ success: true, message: 'Availability preferences saved.' });
});

export default router;
