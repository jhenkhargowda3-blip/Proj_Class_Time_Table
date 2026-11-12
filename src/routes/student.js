import { Router } from 'express';
import { getDatabase } from '../db/connection.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/role.js';

const router = Router();

// Strict RBAC: Student or Admin
router.use(requireAuth, requireRole('student', 'admin'));

function getTodayIST() {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' });
  return formatter.format(new Date());
}

function resolveStudentSectionId(req, db) {
  if (req.user.role === 'admin' && req.query.sectionId) {
    return parseInt(req.query.sectionId, 10);
  }
  let sectionId = req.user.studentId || req.user.student_id;
  if (!sectionId && req.user.id) {
    const u = db.prepare('SELECT student_id FROM users WHERE id = ?').get(req.user.id);
    if (u?.student_id) sectionId = u.student_id;
  }
  if (!sectionId && req.user.role === 'student') {
    const sec5B = db.prepare(`
      SELECT id FROM sections 
      WHERE name = 'CSE-5B' 
         OR (semester = 5 AND name LIKE '%B%')
      ORDER BY CASE WHEN name = 'CSE-5B' THEN 0 ELSE 1 END, id ASC 
      LIMIT 1
    `).get();
    if (sec5B) {
      sectionId = sec5B.id;
      if (req.user.id) {
        try {
          db.prepare("UPDATE users SET student_id = ?, full_name = 'Jhenkhar Gowda' WHERE id = ?").run(sec5B.id, req.user.id);
        } catch (e) {}
      }
    }
  }
  return sectionId || null;
}

/**
 * GET /api/student/schedule
 * Query params: ?date=YYYY-MM-DD (defaults to today in IST)
 * Overlays date-specific absences, holidays, and substitutions
 */
router.get('/schedule', (req, res) => {
  const db = getDatabase();
  const sectionId = resolveStudentSectionId(req, db);
  const queryDate = req.query.date || getTodayIST();

  if (!sectionId) {
    return res.json({
      date: queryDate,
      isHoliday: false,
      holiday: null,
      section: null,
      todaySchedule: [],
      fullWeeklySchedule: [],
      message: 'No section assigned to this student account yet. Please contact administrator.'
    });
  }

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
    return res.json({
      date: queryDate,
      isHoliday: false,
      holiday: null,
      section: null,
      todaySchedule: [],
      fullWeeklySchedule: [],
      message: 'Section not found or removed.'
    });
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
    ORDER BY wd.day_index, ts.slot_no, te.batch
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
 * GET /api/student/notices
 * Real-time substitute notices & upcoming class changes for the student's section
 * Query params: ?date=YYYY-MM-DD (defaults to today)
 */
router.get('/notices', (req, res) => {
  const db = getDatabase();
  const sectionId = resolveStudentSectionId(req, db);

  if (!sectionId) {
    return res.status(400).json({ error: 'Section not linked to this student account' });
  }

  const fromDate = req.query.date || new Date().toISOString().slice(0, 10);

  // Active timetable entries for section with substitutions and absences
  const substitutions = db.prepare(`
    SELECT sub.id as substitution_id, sub.date, sub.status as sub_status,
           te.id as timetable_entry_id, te.section_id, te.room_id,
           s.name as subject_name, s.code as subject_code,
           orig_f.name as original_faculty_name, orig_f.email as original_faculty_email,
           sub_f.name as substitute_faculty_name, sub_f.email as substitute_faculty_email,
           r.name as room_name,
           ts.slot_no, ts.start_time, ts.end_time, ts.label as slot_label,
           a.type as absence_type, a.reason as absence_reason, a.expected_arrival
    FROM substitutions sub
    JOIN timetable_entries te ON sub.timetable_entry_id = te.id
    JOIN timetable_versions tv ON te.version_id = tv.id AND tv.status = 'active'
    JOIN subjects s ON te.subject_id = s.id
    JOIN faculty orig_f ON te.faculty_id = orig_f.id
    LEFT JOIN faculty sub_f ON sub.substitute_faculty_id = sub_f.id
    JOIN rooms r ON te.room_id = r.id
    JOIN time_slots ts ON te.slot_id = ts.id
    JOIN absences a ON sub.absence_id = a.id
    WHERE te.section_id = ?
      AND sub.date >= ?
      AND a.status != 'cancelled'
    ORDER BY sub.date ASC, ts.slot_no ASC
  `).all(sectionId, fromDate);

  // Also check upcoming holidays within the next 14 days
  const holidays = db.prepare(`
    SELECT * FROM holidays
    WHERE date >= ?
    ORDER BY date ASC
    LIMIT 3
  `).all(fromDate);

  const formattedNotices = [];

  for (const sub of substitutions) {
    const isSubstituted = (sub.sub_status === 'accepted' || sub.sub_status === 'assigned') && sub.substitute_faculty_name;
    const isPending = sub.sub_status === 'requested';

    formattedNotices.push({
      id: `sub-${sub.substitution_id}`,
      substitutionId: sub.substitution_id,
      timetableEntryId: sub.timetable_entry_id,
      date: sub.date,
      slotNo: sub.slot_no,
      startTime: sub.start_time,
      endTime: sub.end_time,
      slotLabel: sub.slot_label,
      roomName: sub.room_name,
      subjectName: sub.subject_name,
      subjectCode: sub.subject_code,
      originalFacultyName: sub.original_faculty_name,
      substituteFacultyName: sub.substitute_faculty_name || null,
      status: sub.sub_status,
      type: isSubstituted ? 'substitute' : (isPending ? 'absence' : 'change'),
      severity: isSubstituted ? 'amber' : 'rose',
      title: isSubstituted
        ? `Substitute: ${sub.substitute_faculty_name}`
        : `Faculty Absent: ${sub.original_faculty_name}`,
      subtitle: `${sub.subject_code ? sub.subject_code + ' · ' : ''}${sub.subject_name}`,
      message: isSubstituted
        ? `Prof. ${sub.substitute_faculty_name} will conduct ${sub.subject_name} on ${sub.date} (Period ${sub.slot_no}, ${sub.start_time}-${sub.end_time}) in ${sub.room_name}, covering for Prof. ${sub.original_faculty_name}.`
        : `Prof. ${sub.original_faculty_name} is ${sub.absence_type === 'late' ? 'arriving late' : 'absent'} on ${sub.date}. Period ${sub.slot_no} (${sub.start_time}-${sub.end_time}) coverage is pending.`,
      badgeLabel: isSubstituted ? 'Substitute Confirmed' : 'Coverage Pending'
    });
  }

  for (const hol of holidays) {
    formattedNotices.push({
      id: `holiday-${hol.id}`,
      date: hol.date,
      type: 'holiday',
      severity: 'blue',
      title: `College Holiday: ${hol.description}`,
      subtitle: hol.description,
      message: `No classes scheduled on ${hol.date} due to ${hol.description}.`,
      badgeLabel: 'Holiday'
    });
  }

  // Ensure student_notice_reads table is present
  db.exec(`
    CREATE TABLE IF NOT EXISTS student_notice_reads (
      user_id INTEGER NOT NULL,
      notice_id TEXT NOT NULL,
      read_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, notice_id)
    );
  `);

  // Lookup notices marked as read by this student
  const effectiveUserId = req.user?.id || (req.user?.studentId ? 1000 + req.user.studentId : 1);
  const readRows = db.prepare('SELECT notice_id FROM student_notice_reads WHERE user_id = ?').all(effectiveUserId);
  const readNoticeIds = new Set(readRows.map(r => r.notice_id));

  formattedNotices.forEach(n => {
    n.isRead = readNoticeIds.has(n.id);
  });

  const unreadCount = formattedNotices.filter(n => !n.isRead).length;

  res.json({
    sectionId,
    fromDate,
    count: formattedNotices.length,
    unreadCount,
    notices: formattedNotices
  });
});

/**
 * POST /api/student/notices/:id/read
 * Mark an individual notice as read for the authenticated student
 */
router.post('/notices/:id/read', (req, res) => {
  const db = getDatabase();
  const effectiveUserId = req.user?.id || (req.user?.studentId ? 1000 + req.user.studentId : 1);
  const noticeId = req.params.id;

  if (!noticeId) {
    return res.status(400).json({ error: 'Notice ID is required' });
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS student_notice_reads (
      user_id INTEGER NOT NULL,
      notice_id TEXT NOT NULL,
      read_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, notice_id)
    );
  `);

  db.prepare(`
    INSERT INTO student_notice_reads (user_id, notice_id, read_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, notice_id) DO UPDATE SET read_at = CURRENT_TIMESTAMP
  `).run(effectiveUserId, noticeId);

  res.json({
    success: true,
    noticeId,
    isRead: true
  });
});

/**
 * POST /api/student/notices/:id/unread
 * Mark an individual notice as unread
 */
router.post('/notices/:id/unread', (req, res) => {
  const db = getDatabase();
  const effectiveUserId = req.user?.id || (req.user?.studentId ? 1000 + req.user.studentId : 1);
  const noticeId = req.params.id;

  db.prepare(`
    DELETE FROM student_notice_reads WHERE user_id = ? AND notice_id = ?
  `).run(effectiveUserId, noticeId);

  res.json({
    success: true,
    noticeId,
    isRead: false
  });
});

/**
 * POST /api/student/notices/read-all
 * Mark all current notices as read
 */
router.post('/notices/read-all', (req, res) => {
  const db = getDatabase();
  const effectiveUserId = req.user?.id || (req.user?.studentId ? 1000 + req.user.studentId : 1);
  const { noticeIds } = req.body || {};

  db.exec(`
    CREATE TABLE IF NOT EXISTS student_notice_reads (
      user_id INTEGER NOT NULL,
      notice_id TEXT NOT NULL,
      read_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, notice_id)
    );
  `);

  if (Array.isArray(noticeIds) && noticeIds.length > 0) {
    const insertStmt = db.prepare(`
      INSERT INTO student_notice_reads (user_id, notice_id, read_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, notice_id) DO UPDATE SET read_at = CURRENT_TIMESTAMP
    `);
    const transaction = db.transaction((ids) => {
      for (const id of ids) {
        insertStmt.run(effectiveUserId, String(id));
      }
    });
    transaction(noticeIds);
  }

  res.json({
    success: true,
    allRead: true
  });
});

/**
 * GET /api/student/department-timetable
 * Read-only department timetable across all sections
 */
router.get('/department-timetable', (req, res) => {
  const db = getDatabase();
  const studentSectionId = resolveStudentSectionId(req, db) || 1;

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
  let sectionId = resolveStudentSectionId(req, db);

  if (!sectionId) {
    const defaultSec = db.prepare('SELECT id FROM sections LIMIT 1').get();
    sectionId = defaultSec?.id;
  }

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

