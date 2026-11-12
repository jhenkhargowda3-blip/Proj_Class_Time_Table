import { getDatabase } from '../db/connection.js';

/**
 * Calendar Service for CTAS
 * Maps calendar dates to weekdays, overlays active timetable version,
 * subtracts holidays, and overlays date-specific absences and accepted substitutions.
 */

export function getFacultyCalendar(facultyId, year, month) {
  const db = getDatabase();

  // Active timetable version
  const activeVersion = db.prepare("SELECT id FROM timetable_versions WHERE status = 'active' LIMIT 1").get();
  const versionId = activeVersion ? activeVersion.id : null;

  // Working days and slots
  const workingDays = db.prepare('SELECT * FROM working_days WHERE is_active = 1').all();
  const timeSlots = db.prepare('SELECT * FROM time_slots ORDER BY slot_no ASC').all();
  const teachingSlots = timeSlots.filter(s => s.is_break === 0);

  // Month bounds
  const startDate = new Date(Date.UTC(year, month, 1));
  const endDate = new Date(Date.UTC(year, month + 1, 0));
  const daysInMonth = endDate.getUTCDate();

  // Fetch holidays within the month
  const startStr = `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const endStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;
  const holidays = db.prepare('SELECT * FROM holidays WHERE date BETWEEN ? AND ?').all(startStr, endStr);
  const holidayMap = new Map();
  for (const h of holidays) holidayMap.set(h.date, h.description);

  // Fetch absences for this faculty within the month
  const absences = db.prepare('SELECT * FROM absences WHERE faculty_id = ? AND date BETWEEN ? AND ?').all(facultyId, startStr, endStr);
  const absenceMap = new Map();
  for (const a of absences) absenceMap.set(a.date, a);

  // Fetch substitutions for this faculty (both classes covered by someone else, and classes covered by this faculty)
  const coveredByOthers = db.prepare(`
    SELECT sub.*, f.name as substitute_name
    FROM substitutions sub
    JOIN absences a ON sub.absence_id = a.id
    JOIN faculty f ON sub.substitute_faculty_id = f.id
    WHERE a.faculty_id = ? AND sub.date BETWEEN ? AND ? AND sub.status IN ('accepted', 'assigned')
  `).all(facultyId, startStr, endStr);
  const coveredByOthersMap = new Map();
  for (const c of coveredByOthers) coveredByOthersMap.set(`${c.date}_${c.timetable_entry_id}`, c);

  const coveringForOthers = db.prepare(`
    SELECT sub.id as substitution_id, sub.date, sub.status as sub_status,
           te.id, te.id as timetable_entry_id, te.section_id, te.subject_id, te.room_id, te.day_id, te.slot_id, te.is_lab_block, te.batch,
           s.name as subject_name, s.code as subject_code, s.type as subject_type,
           COALESCE(sec.name, te.room_note, 'All Batches') as section_name, r.name as room_name,
           abs_fac.name as absent_faculty_name
    FROM substitutions sub
    JOIN timetable_entries te ON sub.timetable_entry_id = te.id
    JOIN subjects s ON te.subject_id = s.id
    LEFT JOIN sections sec ON te.section_id = sec.id
    JOIN rooms r ON te.room_id = r.id
    JOIN absences a ON sub.absence_id = a.id
    JOIN faculty abs_fac ON a.faculty_id = abs_fac.id
    WHERE sub.substitute_faculty_id = ? AND sub.date BETWEEN ? AND ? AND sub.status IN ('accepted', 'assigned')
  `).all(facultyId, startStr, endStr);
  const coveringForOthersMap = new Map();
  for (const cov of coveringForOthers) {
    if (!coveringForOthersMap.has(cov.date)) coveringForOthersMap.set(cov.date, []);
    coveringForOthersMap.get(cov.date).push(cov);
  }

  // Base timetable entries for this faculty in active version
  let baseEntries = [];
  if (versionId) {
    baseEntries = db.prepare(`
      SELECT te.*, s.name as subject_name, s.code as subject_code, s.type as subject_type,
             COALESCE(sec.name, te.room_note, 'All Batches') as section_name, r.name as room_name,
             wd.day_index, wd.day_name,
             ts.slot_no, ts.start_time, ts.end_time, ts.is_break, ts.label as slot_label
      FROM timetable_entries te
      JOIN subjects s ON te.subject_id = s.id
      LEFT JOIN sections sec ON te.section_id = sec.id
      JOIN rooms r ON te.room_id = r.id
      JOIN working_days wd ON te.day_id = wd.id
      JOIN time_slots ts ON te.slot_id = ts.id
      WHERE te.version_id = ? AND te.faculty_id = ?
      ORDER BY wd.day_index, ts.slot_no, te.batch
    `).all(versionId, facultyId);
  }

  const daysList = [];

  for (let day = 1; day <= daysInMonth; day++) {
    const curDate = new Date(Date.UTC(year, month, day));
    const dayOfWeek = curDate.getUTCDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    // Map JS getUTCDay to working_days day_index (1=Mon ... 6=Sat)
    const activeWorkingDay = workingDays.find(w => w.day_index === dayOfWeek);

    const isHoliday = holidayMap.has(dateStr);
    const holidayDesc = holidayMap.get(dateStr) || null;
    const isWeekend = dayOfWeek === 0 || !activeWorkingDay;
    const absence = absenceMap.get(dateStr) || null;

    // Filter base classes for this weekday
    const dayBaseClasses = activeWorkingDay && !isHoliday
      ? baseEntries.filter(e => e.day_index === dayOfWeek)
      : [];

    // Add classes this faculty is covering as a substitute on this date
    const substitutedIn = coveringForOthersMap.get(dateStr) || [];

    // Format all classes for this date
    const classes = [];
    for (const bc of dayBaseClasses) {
      const subInfo = coveredByOthersMap.get(`${dateStr}_${bc.id}`);
      classes.push({
        id: bc.id,
        slotId: bc.slot_id,
        slotNo: bc.slot_no,
        startTime: bc.start_time,
        endTime: bc.end_time,
        slotLabel: bc.slot_label,
        subjectCode: bc.subject_code,
        subjectName: bc.subject_name,
        subjectType: bc.subject_type,
        sectionName: bc.section_name,
        roomName: bc.room_name,
        batch: bc.batch || null,
        isLab: bc.is_lab_block === 1,
        isCoveredByColleague: Boolean(subInfo),
        substituteFacultyName: subInfo ? subInfo.substitute_name : null
      });
    }

    for (const sc of substitutedIn) {
      const slot = timeSlots.find(s => s.id === sc.slot_id) || {};
      classes.push({
        id: sc.id,
        slotId: sc.slot_id,
        slotNo: slot.slot_no,
        startTime: slot.start_time,
        endTime: slot.end_time,
        slotLabel: slot.label,
        subjectCode: sc.subject_code,
        subjectName: sc.subject_name,
        subjectType: sc.subject_type,
        sectionName: sc.section_name,
        roomName: sc.room_name,
        isLab: sc.is_lab_block === 1,
        isSubstituteDuty: true,
        originalFacultyName: sc.absent_faculty_name
      });
    }

    // Sort classes chronologically
    classes.sort((a, b) => a.slotNo - b.slotNo);

    // Determine day status and color
    let status = 'present'; // default working/present
    let colorClass = 'green'; // green = present & has scheduled classes / is working that day

    if (isHoliday) {
      status = 'holiday';
      colorClass = 'grey';
    } else if (isWeekend) {
      status = 'non-working';
      colorClass = 'grey';
    } else if (absence) {
      if (absence.type === 'absent') {
        status = 'absent';
        colorClass = 'soft-red';
      } else if (absence.type === 'late') {
        status = 'late';
        colorClass = 'amber';
      }
    }

    daysList.push({
      date: dateStr,
      dayNumber: day,
      dayOfWeek,
      dayName: activeWorkingDay ? activeWorkingDay.day_name : 'Sunday',
      status,
      colorClass,
      holidayDesc,
      absence: absence ? { type: absence.type, expectedArrival: absence.expected_arrival, reason: absence.reason } : null,
      classesCount: classes.length,
      classes
    });
  }

  return {
    year,
    month,
    days: daysList
  };
}

/**
 * Get detailed day schedule breakdown including free slots (marked available for substitution)
 */
export function getFacultyDaySchedule(facultyId, dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const cal = getFacultyCalendar(facultyId, year, month - 1);
  const dayInfo = cal.days.find(d => d.date === dateStr);

  const db = getDatabase();
  const allSlots = db.prepare('SELECT * FROM time_slots ORDER BY slot_no ASC').all();

  const scheduleSlots = [];
  for (const s of allSlots) {
    if (s.is_break === 1) {
      scheduleSlots.push({
        slotNo: s.slot_no,
        startTime: s.start_time,
        endTime: s.end_time,
        label: s.label,
        isBreak: true
      });
      continue;
    }

    const matchingClasses = dayInfo?.classes.filter(c => c.slotNo === s.slot_no) || [];
    if (matchingClasses.length > 0) {
      for (const scheduled of matchingClasses) {
        scheduleSlots.push({
          slotNo: s.slot_no,
          startTime: s.start_time,
          endTime: s.end_time,
          label: s.label,
          isBreak: false,
          isFree: false,
          ...scheduled
        });
      }
    } else {
      scheduleSlots.push({
        slotNo: s.slot_no,
        startTime: s.start_time,
        endTime: s.end_time,
        label: s.label,
        isBreak: false,
        isFree: true,
        freeLabel: 'Free Slot (Available for Substitution)'
      });
    }
  }

  return {
    date: dateStr,
    dayName: dayInfo?.dayName || '',
    status: dayInfo?.status || 'present',
    colorClass: dayInfo?.colorClass || 'green',
    holidayDesc: dayInfo?.holidayDesc || null,
    absence: dayInfo?.absence || null,
    schedule: scheduleSlots
  };
}

export default {
  getFacultyCalendar,
  getFacultyDaySchedule
};
