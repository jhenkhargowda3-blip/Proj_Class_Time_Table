import { Router } from 'express';
import { getDatabase } from '../db/connection.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/role.js';

const router = Router();

// Strict RBAC: Student or Admin
router.use(requireAuth, requireRole('student', 'admin'));

/**
 * GET /api/student/schedule
 * Query params: ?date=YYYY-MM-DD (defaults to today)
 * Overlays date-specific absences, holidays, and substitutions
 */
router.get('/schedule', (req, res) => {
  const db = getDatabase();
  const sectionId = req.user.role === 'admin' && req.query.sectionId
    ? parseInt(req.query.sectionId, 10)
    : req.user.studentId;

  if (!sectionId) {
    return res.status(400).json({ error: 'Section not linked to this student account' });
  }

  const queryDate = req.query.date || new Date().toISOString().slice(0, 10);
  const [y, m, d] = queryDate.split('-').map(Number);
  const dateObj = new Date(Date.UTC(y, m - 1, d));
  const dayOfWeek = dateObj.getUTCDay(); // 0=Sun..6=Sat

  const section = db.prepare(`
    SELECT s.*, d.name as department_name, d.code as department_code
    FROM sections s
    JOIN departments d ON s.department_id = d.id
    WHERE s.id = ?
  `).get(sectionId);

  if (!section) {
    return res.status(404).json({ error: 'Section not found' });
  }

  // Check if date is a holiday
  const holiday = db.prepare('SELECT * FROM holidays WHERE date = ?').get(queryDate);

  // Active timetable entries for this section
  const entries = db.prepare(`
    SELECT te.*, s.name as subject_name, s.code as subject_code, s.type as subject_type,
           f.id as original_faculty_id, f.name as faculty_name, f.email as faculty_email,
           r.name as room_name, r.type as room_type,
           wd.id as day_id, wd.day_name, wd.day_index,
           ts.slot_no, ts.start_time, ts.end_time, ts.label as slot_label
    FROM timetable_entries te
    JOIN timetable_versions tv ON te.version_id = tv.id AND tv.status = 'active'
    JOIN subjects s ON te.subject_id = s.id
    JOIN faculty f ON te.faculty_id = f.id
    JOIN rooms r ON te.room_id = r.id
    JOIN working_days wd ON te.day_id = wd.id
    JOIN time_slots ts ON te.slot_id = ts.id
    WHERE te.section_id = ?
    ORDER BY wd.day_index, ts.slot_no
  `).all(sectionId);

  // Filter entries for selected date's day_index
  const todayEntries = entries.filter(e => e.day_index === dayOfWeek);

  // Fetch substitutions on queryDate for this section
  const substitutions = db.prepare(`
    SELECT sub.*, f.name as substitute_name, f.email as substitute_email
    FROM substitutions sub
    LEFT JOIN faculty f ON sub.substitute_faculty_id = f.id
    WHERE sub.date = ?
  `).all(queryDate);
  const subMap = new Map();
  for (const s of substitutions) subMap.set(s.timetable_entry_id, s);

  // Fetch absences on queryDate
  const absences = db.prepare(`
    SELECT * FROM absences WHERE date = ? AND status != 'cancelled'
  `).all(queryDate);
  const absMap = new Map();
  for (const a of absences) absMap.set(a.faculty_id, a);

  // Map today's schedule with substitution statuses
  const scheduleWithStatus = todayEntries.map(e => {
    if (holiday) {
      return {
        ...e,
        status: 'holiday',
        holidayDesc: holiday.description,
        badgeText: `Holiday: ${holiday.description}`,
        badgeClass: 'grey'
      };
    }

    const facultyAbsence = absMap.get(e.original_faculty_id);
    let isFacultyAbsent = false;

    if (facultyAbsence) {
      if (facultyAbsence.type === 'absent') {
        isFacultyAbsent = true;
      } else if (facultyAbsence.type === 'late' && e.start_time < facultyAbsence.expected_arrival) {
        isFacultyAbsent = true;
      }
    }

    if (isFacultyAbsent) {
      const sub = subMap.get(e.id);
      if (sub && (sub.status === 'accepted' || sub.status === 'assigned') && sub.substitute_name) {
        return {
          ...e,
          status: 'substituted',
          substituteFacultyName: sub.substitute_name,
          badgeText: `Taught today by ${sub.substitute_name} (substitute for ${e.faculty_name})`,
          badgeClass: 'amber',
          currentFacultyName: sub.substitute_name
        };
      } else {
        return {
          ...e,
          status: 'suspended',
          badgeText: 'Period suspended / Self-study in Library',
          badgeClass: 'soft-red',
          currentFacultyName: null
        };
      }
    }

    return {
      ...e,
      status: 'normal',
      badgeText: `Scheduled: ${e.faculty_name}`,
      badgeClass: 'green',
      currentFacultyName: e.faculty_name
    };
  });

  res.json({
    section,
    date: queryDate,
    dayOfWeek,
    isHoliday: Boolean(holiday),
    holidayDescription: holiday?.description || null,
    todaySchedule: scheduleWithStatus,
    schedule: scheduleWithStatus,
    fullWeeklySchedule: entries
  });
});

/**
 * GET /api/student/department-timetable
 * Read-only department timetable across all sections
 */
router.get('/department-timetable', (req, res) => {
  const db = getDatabase();
  const studentSectionId = req.user.studentId;

  const section = db.prepare('SELECT department_id FROM sections WHERE id = ?').get(studentSectionId);
  const deptId = section ? section.department_id : 1;

  const deptSections = db.prepare('SELECT * FROM sections WHERE department_id = ? ORDER BY name ASC').all(deptId);
  const timeSlots = db.prepare('SELECT * FROM time_slots ORDER BY slot_no ASC').all();
  const workingDays = db.prepare('SELECT * FROM working_days WHERE is_active = 1 ORDER BY day_index ASC').all();

  const entries = db.prepare(`
    SELECT te.*, s.name as subject_name, s.code as subject_code, s.type as subject_type,
           f.name as faculty_name, r.name as room_name, sec.name as section_name
    FROM timetable_entries te
    JOIN timetable_versions tv ON te.version_id = tv.id AND tv.status = 'active'
    JOIN subjects s ON te.subject_id = s.id
    JOIN faculty f ON te.faculty_id = f.id
    JOIN rooms r ON te.room_id = r.id
    JOIN sections sec ON te.section_id = sec.id
    WHERE sec.department_id = ?
    ORDER BY te.day_id, te.slot_id
  `).all(deptId);

  res.json({
    sections: deptSections,
    timeSlots,
    workingDays,
    entries
  });
});

/**
 * GET /api/student/export.ics
 * Exports active timetable for student's section as iCalendar file
 */
router.get('/export.ics', (req, res) => {
  const db = getDatabase();
  const sectionId = req.user.role === 'admin' && req.query.sectionId
    ? parseInt(req.query.sectionId, 10)
    : req.user.studentId;

  if (!sectionId) {
    return res.status(400).send('Section not specified');
  }

  const section = db.prepare('SELECT name FROM sections WHERE id = ?').get(sectionId);
  if (!section) return res.status(404).send('Section not found');

  const entries = db.prepare(`
    SELECT te.*, s.name as subject_name, s.code as subject_code,
           f.name as faculty_name, r.name as room_name,
           wd.day_name, wd.day_index,
           ts.slot_no, ts.start_time, ts.end_time
    FROM timetable_entries te
    JOIN timetable_versions tv ON te.version_id = tv.id AND tv.status = 'active'
    JOIN subjects s ON te.subject_id = s.id
    JOIN faculty f ON te.faculty_id = f.id
    JOIN rooms r ON te.room_id = r.id
    JOIN working_days wd ON te.day_id = wd.id
    JOIN time_slots ts ON te.slot_id = ts.id
    WHERE te.section_id = ?
    ORDER BY wd.day_index, ts.slot_no
  `).all(sectionId);

  const dayCodeMap = { 0: 'SU', 1: 'MO', 2: 'TU', 3: 'WE', 4: 'TH', 5: 'FR', 6: 'SA' };
  const now = new Date();
  const currentDay = now.getDay();
  const diffToMonday = currentDay === 0 ? -6 : 1 - currentDay;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diffToMonday);

  const icsLines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//CTAS//Class Timetable Automation System//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:Section ${section.name} Schedule`,
    'X-WR-TIMEZONE:UTC'
  ];

  entries.forEach((e, idx) => {
    const dayCode = dayCodeMap[e.day_index] || 'MO';
    const targetDate = new Date(monday);
    const offset = e.day_index === 0 ? 6 : e.day_index - 1;
    targetDate.setDate(monday.getDate() + offset);

    const dateStr = targetDate.toISOString().slice(0, 10).replace(/-/g, '');
    const startTimeClean = (e.start_time || '09:00').replace(/[^0-9]/g, '').slice(0, 4) + '00';
    const endTimeClean = (e.end_time || '10:00').replace(/[^0-9]/g, '').slice(0, 4) + '00';

    icsLines.push(
      'BEGIN:VEVENT',
      `UID:ctas-sec-${sectionId}-${idx}-${Date.now()}@ctas.college.edu`,
      `DTSTAMP:${dateStr}T000000Z`,
      `DTSTART:${dateStr}T${startTimeClean}`,
      `DTEND:${dateStr}T${endTimeClean}`,
      `RRULE:FREQ=WEEKLY;BYDAY=${dayCode}`,
      `SUMMARY:${(e.subject_code ? e.subject_code + ': ' : '') + e.subject_name}`.replace(/[,;\\]/g, ''),
      `LOCATION:${e.room_name}`.replace(/[,;\\]/g, ''),
      `DESCRIPTION:Instructor: ${e.faculty_name}\\nSection: ${section.name}\\nSubject: ${e.subject_name}`.replace(/[,;\\]/g, ''),
      'STATUS:CONFIRMED',
      'END:VEVENT'
    );
  });

  icsLines.push('END:VCALENDAR');

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="section_${section.name}_schedule.ics"`);
  res.send(icsLines.join('\r\n'));
});

export default router;

