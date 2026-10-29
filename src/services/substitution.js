import { getDatabase } from '../db/connection.js';
import { broadcast } from './sse.js';

/**
 * Substitution & Absence Service for CTAS
 * Deterministic constraint checks, load counting, subject qualification ranking,
 * and concurrency-safe transactional claiming.
 */

/**
 * Report full-day absence or lateness.
 * Automatically identifies affected classes from the active timetable version.
 */
export function reportAbsence({ facultyId, date, type, expectedArrival = null, reason, reportedByUserId = null }) {
  const db = getDatabase();

  if (!facultyId || !date || !type || !reason) {
    throw new Error('facultyId, date, type, and reason are required');
  }

  if (type !== 'absent' && type !== 'late') {
    throw new Error("type must be either 'absent' or 'late'");
  }

  if (type === 'late' && !expectedArrival) {
    throw new Error('expectedArrival is required when reporting lateness');
  }

  // Verify faculty exists
  const faculty = db.prepare('SELECT id, name, department_id FROM faculty WHERE id = ?').get(facultyId);
  if (!faculty) {
    throw new Error(`Faculty not found with id ${facultyId}`);
  }

  // Active timetable version
  const activeVersion = db.prepare("SELECT id FROM timetable_versions WHERE status = 'active' LIMIT 1").get();
  if (!activeVersion) {
    throw new Error('No active timetable version found');
  }

  // Check if date is a holiday
  const holiday = db.prepare('SELECT * FROM holidays WHERE date = ?').get(date);
  if (holiday) {
    throw new Error(`Date ${date} is marked as holiday (${holiday.description}). No classes are scheduled.`);
  }

  // Compute weekday index (1=Mon..6=Sat, 0=Sun). Note JS Date.UTC month is 0-indexed.
  const [y, m, d] = date.split('-').map(Number);
  const dateObj = new Date(Date.UTC(y, m - 1, d));
  const dayOfWeek = dateObj.getUTCDay();

  const workingDay = db.prepare('SELECT * FROM working_days WHERE day_index = ? AND is_active = 1').get(dayOfWeek);
  if (!workingDay) {
    throw new Error(`No working day configured for date ${date} (Day ${dayOfWeek})`);
  }

  // Find all scheduled classes for this faculty on this day
  const scheduledClasses = db.prepare(`
    SELECT te.*, ts.slot_no, ts.start_time, ts.end_time, ts.is_break, ts.label as slot_label,
           s.name as subject_name, s.code as subject_code, s.department_id as subject_dept_id,
           sec.name as section_name, r.name as room_name
    FROM timetable_entries te
    JOIN time_slots ts ON te.slot_id = ts.id
    JOIN subjects s ON te.subject_id = s.id
    JOIN sections sec ON te.section_id = sec.id
    JOIN rooms r ON te.room_id = r.id
    WHERE te.version_id = ? AND te.faculty_id = ? AND te.day_id = ?
    ORDER BY ts.slot_no ASC
  `).all(activeVersion.id, facultyId, workingDay.id);

  // Filter affected classes:
  // For 'absent': all classes that day
  // For 'late': only classes starting strictly before expectedArrival
  const affectedClasses = scheduledClasses.filter(c => {
    if (type === 'absent') return true;
    if (type === 'late') {
      return c.start_time < expectedArrival;
    }
    return false;
  });

  // Execute in transaction
  const insertTx = db.transaction(() => {
    // Insert into absences
    const absRes = db.prepare(`
      INSERT INTO absences (faculty_id, date, type, expected_arrival, reason, status)
      VALUES (?, ?, ?, ?, ?, 'open')
    `).run(facultyId, date, type, expectedArrival, reason);

    const absenceId = absRes.lastInsertRowid;

    // Insert substitution placeholders for each affected class
    const subInsertStmt = db.prepare(`
      INSERT INTO substitutions (absence_id, timetable_entry_id, date, status, requested_by)
      VALUES (?, ?, ?, 'requested', ?)
      ON CONFLICT(timetable_entry_id, date) DO UPDATE SET
        absence_id = excluded.absence_id,
        status = 'requested',
        substitute_faculty_id = NULL
    `);

    for (const ac of affectedClasses) {
      subInsertStmt.run(absenceId, ac.id, date, reportedByUserId);
    }

    // Insert audit log
    db.prepare(`
      INSERT INTO audit_log (user_id, action, details_json)
      VALUES (?, 'REPORT_ABSENCE', ?)
    `).run(reportedByUserId, JSON.stringify({
      absenceId,
      facultyId,
      facultyName: faculty.name,
      date,
      type,
      expectedArrival,
      affectedClassesCount: affectedClasses.length
    }));

    // Create notification for admin
    const adminUser = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
    if (adminUser) {
      db.prepare(`
        INSERT INTO notifications (user_id, title, body, type)
        VALUES (?, ?, ?, 'warning')
      `).run(
        adminUser.id,
        `${type === 'absent' ? 'Absence' : 'Lateness'} Reported: ${faculty.name}`,
        `${faculty.name} reported ${type === 'absent' ? 'full-day absence' : `lateness (arrival: ${expectedArrival})`} on ${date}. ${affectedClasses.length} class(es) require substitution.`
      );
    }

    return { absenceId, affectedClasses };
  });

  const result = insertTx();

  // Broadcast SSE event
  broadcast('absence:created', {
    absenceId: result.absenceId,
    facultyId,
    facultyName: faculty.name,
    date,
    type,
    expectedArrival,
    affectedCount: affectedClasses.length
  });

  return {
    absenceId: result.absenceId,
    facultyId,
    facultyName: faculty.name,
    date,
    type,
    expectedArrival,
    affectedClasses
  };
}

/**
 * Calculate eligible substitutes for a specific class on a date.
 * Enforces hard constraints (busy, absent, daily period overload).
 * Ranks by soft constraints (subject qualification, department match, availability, load balance).
 */
export function findEligibleSubstitutes(timetableEntryId, dateStr) {
  const db = getDatabase();

  const activeVersion = db.prepare("SELECT id FROM timetable_versions WHERE status = 'active' LIMIT 1").get();
  if (!activeVersion) return [];

  // Get entry details
  const entry = db.prepare(`
    SELECT te.*, ts.slot_no, ts.start_time, ts.end_time,
           s.name as subject_name, s.code as subject_code, s.department_id as subject_dept_id,
           sec.name as section_name, r.name as room_name,
           orig_fac.name as original_faculty_name
    FROM timetable_entries te
    JOIN time_slots ts ON te.slot_id = ts.id
    JOIN subjects s ON te.subject_id = s.id
    JOIN sections sec ON te.section_id = sec.id
    JOIN rooms r ON te.room_id = r.id
    JOIN faculty orig_fac ON te.faculty_id = orig_fac.id
    WHERE te.id = ? AND te.version_id = ?
  `).get(timetableEntryId, activeVersion.id);

  if (!entry) return [];

  // Parse date (Note JS Date.UTC month is 0-indexed)
  const [y, m, d] = dateStr.split('-').map(Number);
  const dateObj = new Date(Date.UTC(y, m - 1, d));
  const dayOfWeek = dateObj.getUTCDay();

  // All active faculty excluding original faculty
  const allFaculty = db.prepare(`
    SELECT f.*, d.name as dept_name
    FROM faculty f
    JOIN departments d ON f.department_id = d.id
    WHERE f.is_active = 1 AND f.id != ?
  `).all(entry.faculty_id);

  // Subject qualifications lookup
  const qualifiedRows = db.prepare(`
    SELECT faculty_id FROM faculty_subjects WHERE subject_id = ?
  `).all(entry.subject_id);
  const qualifiedSet = new Set(qualifiedRows.map(r => r.faculty_id));

  // Faculty who have base classes in this slot on this day
  const busyBaseRows = db.prepare(`
    SELECT faculty_id FROM timetable_entries
    WHERE version_id = ? AND day_id = ? AND slot_id = ?
  `).all(activeVersion.id, entry.day_id, entry.slot_id);
  const busyBaseSet = new Set(busyBaseRows.map(r => r.faculty_id));

  // Faculty who already accepted/assigned a substitution in this slot on this date
  const busySubRows = db.prepare(`
    SELECT sub.substitute_faculty_id
    FROM substitutions sub
    JOIN timetable_entries te ON sub.timetable_entry_id = te.id
    WHERE sub.date = ? AND te.slot_id = ? AND sub.status IN ('accepted', 'assigned')
  `).all(dateStr, entry.slot_id);
  const busySubSet = new Set(busySubRows.map(r => r.substitute_faculty_id));

  // Faculty with absences on this date covering this slot
  const absences = db.prepare(`
    SELECT faculty_id, type, expected_arrival FROM absences
    WHERE date = ? AND status != 'cancelled'
  `).all(dateStr);
  const absentSet = new Set();
  for (const a of absences) {
    if (a.type === 'absent') {
      absentSet.add(a.faculty_id);
    } else if (a.type === 'late') {
      // If late and class starts before expected arrival, they are absent for this slot
      if (entry.start_time < a.expected_arrival) {
        absentSet.add(a.faculty_id);
      }
    }
  }

  // Pre-calculate weekly load for each faculty in active timetable
  const weeklyLoads = db.prepare(`
    SELECT faculty_id, COUNT(*) as count
    FROM timetable_entries
    WHERE version_id = ?
    GROUP BY faculty_id
  `).all(activeVersion.id);
  const weeklyLoadMap = new Map();
  for (const w of weeklyLoads) weeklyLoadMap.set(w.faculty_id, w.count);

  // Pre-calculate daily teaching periods for this specific day
  const dailyLoads = db.prepare(`
    SELECT faculty_id, COUNT(*) as count
    FROM timetable_entries
    WHERE version_id = ? AND day_id = ?
    GROUP BY faculty_id
  `).all(activeVersion.id, entry.day_id);
  const dailyLoadMap = new Map();
  for (const dl of dailyLoads) dailyLoadMap.set(dl.faculty_id, dl.count);

  // Substitutions already taken today
  const dailySubLoads = db.prepare(`
    SELECT substitute_faculty_id, COUNT(*) as count
    FROM substitutions
    WHERE date = ? AND status IN ('accepted', 'assigned')
    GROUP BY substitute_faculty_id
  `).all(dateStr);
  const dailySubMap = new Map();
  for (const ds of dailySubLoads) dailySubMap.set(ds.substitute_faculty_id, ds.count);

  // Availability preference rows for this day and slot
  const availRows = db.prepare(`
    SELECT faculty_id, is_available FROM faculty_availability
    WHERE day_id = ? AND slot_id = ?
  `).all(entry.day_id, entry.slot_id);
  const availMap = new Map();
  for (const av of availRows) availMap.set(av.faculty_id, av.is_available);

  const candidates = [];

  for (const fac of allFaculty) {
    // HARD CONSTRAINT 1: Must NOT have a class in that slot on that date
    if (busyBaseSet.has(fac.id)) continue;
    if (busySubSet.has(fac.id)) continue;

    // HARD CONSTRAINT 2: Must NOT be absent/late during this slot
    if (absentSet.has(fac.id)) continue;

    // HARD CONSTRAINT 3: Must NOT exceed max_periods_per_day if assigned this slot
    const basePeriodsToday = dailyLoadMap.get(fac.id) || 0;
    const subPeriodsToday = dailySubMap.get(fac.id) || 0;
    const totalPeriodsToday = basePeriodsToday + subPeriodsToday;

    if (totalPeriodsToday + 1 > fac.max_periods_per_day) {
      continue; // Exceeded daily limit
    }

    // SOFT CONSTRAINTS & SCORING
    let score = 0;
    const reasons = [];

    // Qualification priority (+50 pts)
    const isQualified = qualifiedSet.has(fac.id);
    if (isQualified) {
      score += 50;
      reasons.push('Qualified for subject');
    }

    // Department match priority (+30 pts)
    const isSameDept = fac.department_id === entry.subject_dept_id;
    if (isSameDept) {
      score += 30;
      reasons.push('Same department');
    }

    // Explicit slot availability (+20 pts for available, -15 pts for preferred off)
    const slotAvail = availMap.get(fac.id);
    if (slotAvail === 1) {
      score += 20;
      reasons.push('Marked slot as available');
    } else if (slotAvail === 0) {
      score -= 15;
      reasons.push('Marked slot as unavailable preference');
    } else {
      reasons.push('Slot availability neutral');
    }

    // Workload balancing priority: Lower current load scores higher (+0 to +20)
    const weeklyLoad = weeklyLoadMap.get(fac.id) || 0;
    const loadBonus = Math.max(0, 20 - weeklyLoad);
    score += loadBonus;
    reasons.push(`Weekly load: ${weeklyLoad} periods (load bonus: +${loadBonus})`);

    candidates.push({
      facultyId: fac.id,
      name: fac.name,
      email: fac.email,
      departmentName: fac.dept_name,
      departmentId: fac.department_id,
      isQualified,
      isSameDept,
      currentDailyPeriods: totalPeriodsToday,
      maxPeriodsPerDay: fac.max_periods_per_day,
      weeklyPeriods: weeklyLoad,
      score,
      reasons
    });
  }

  // Sort descending by score, qualified first, then department, then score
  candidates.sort((a, b) => {
    if (b.isQualified !== a.isQualified) return b.isQualified ? 1 : -1;
    if (b.score !== a.score) return b.score - a.score;
    return a.weeklyPeriods - b.weeklyPeriods;
  });

  return candidates;
}

/**
 * Mode A: Self-Service Substitution Claim by Faculty
 * Atomic, concurrency-safe, verified by conflict constraints.
 */
export function claimSubstitution({ timetableEntryId, dateStr, substituteFacultyId, userId }) {
  const db = getDatabase();

  // Find substitution record
  const sub = db.prepare(`
    SELECT sub.*, a.faculty_id as absent_faculty_id,
           te.slot_id, te.day_id, te.subject_id, te.version_id,
           s.name as subject_name, ts.slot_no, ts.start_time, ts.end_time,
           orig_f.name as absent_faculty_name
    FROM substitutions sub
    JOIN absences a ON sub.absence_id = a.id
    JOIN timetable_entries te ON sub.timetable_entry_id = te.id
    JOIN subjects s ON te.subject_id = s.id
    JOIN time_slots ts ON te.slot_id = ts.id
    JOIN faculty orig_f ON a.faculty_id = orig_f.id
    WHERE sub.timetable_entry_id = ? AND sub.date = ?
  `).get(timetableEntryId, dateStr);

  if (!sub) {
    throw new Error(`No substitution request found for timetable entry ${timetableEntryId} on ${dateStr}`);
  }

  if (sub.status === 'accepted' || sub.status === 'assigned') {
    throw new Error('This substitution slot has already been claimed or assigned.');
  }

  if (sub.absent_faculty_id === substituteFacultyId) {
    throw new Error('You cannot substitute for your own class.');
  }

  // Verify substitute faculty is active
  const subFaculty = db.prepare('SELECT * FROM faculty WHERE id = ? AND is_active = 1').get(substituteFacultyId);
  if (!subFaculty) {
    throw new Error('Substitute faculty not found or inactive');
  }

  // Verify candidate is eligible via hard constraints
  const eligibleList = findEligibleSubstitutes(timetableEntryId, dateStr);
  const eligible = eligibleList.find(c => c.facultyId === substituteFacultyId);
  if (!eligible) {
    throw new Error('You are not eligible for this slot due to a timetable clash, absence, or daily load limit.');
  }

  const claimTx = db.transaction(() => {
    // Atomic update with status guard
    const updateRes = db.prepare(`
      UPDATE substitutions
      SET substitute_faculty_id = ?, status = 'accepted'
      WHERE id = ? AND status = 'requested'
    `).run(substituteFacultyId, sub.id);

    if (updateRes.changes === 0) {
      throw new Error('This substitution slot was just claimed by another faculty member.');
    }

    // Check if all classes for this absence are now covered
    const openCount = db.prepare(`
      SELECT COUNT(*) as cnt FROM substitutions
      WHERE absence_id = ? AND status = 'requested'
    `).get(sub.absence_id).cnt;

    if (openCount === 0) {
      db.prepare("UPDATE absences SET status = 'covered' WHERE id = ?").run(sub.absence_id);
    }

    // Log to audit log
    db.prepare(`
      INSERT INTO audit_log (user_id, action, details_json)
      VALUES (?, 'CLAIM_SUBSTITUTION', ?)
    `).run(userId, JSON.stringify({
      substitutionId: sub.id,
      timetableEntryId,
      date: dateStr,
      substituteFacultyId,
      substituteFacultyName: subFaculty.name
    }));

    // Insert notifications
    const absentFacultyUser = db.prepare('SELECT user_id FROM faculty WHERE id = ?').get(sub.absent_faculty_id);
    if (absentFacultyUser?.user_id) {
      db.prepare(`
        INSERT INTO notifications (user_id, title, body, type)
        VALUES (?, 'Substitution Confirmed', ?, 'success')
      `).run(
        absentFacultyUser.user_id,
        `${subFaculty.name} has claimed substitution for your ${sub.subject_name} class on ${dateStr} (Period ${sub.slot_no}).`
      );
    }

    return {
      substitutionId: sub.id,
      date: dateStr,
      subjectName: sub.subject_name,
      slotNo: sub.slot_no,
      substituteFacultyName: subFaculty.name,
      absentFacultyName: sub.absent_faculty_name
    };
  });

  const result = claimTx();

  // SSE broadcast
  broadcast('substitution:claimed', result);

  return result;
}

/**
 * Mode B: Admin Assignment of Substitute Faculty
 */
export function assignSubstitution({ timetableEntryId, dateStr, substituteFacultyId, adminUserId }) {
  const db = getDatabase();

  const sub = db.prepare(`
    SELECT sub.*, a.faculty_id as absent_faculty_id,
           te.slot_id, te.day_id, te.subject_id, te.version_id,
           s.name as subject_name, ts.slot_no,
           orig_f.name as absent_faculty_name
    FROM substitutions sub
    JOIN absences a ON sub.absence_id = a.id
    JOIN timetable_entries te ON sub.timetable_entry_id = te.id
    JOIN subjects s ON te.subject_id = s.id
    JOIN time_slots ts ON te.slot_id = ts.id
    JOIN faculty orig_f ON a.faculty_id = orig_f.id
    WHERE sub.timetable_entry_id = ? AND sub.date = ?
  `).get(timetableEntryId, dateStr);

  if (!sub) {
    throw new Error(`No substitution request found for timetable entry ${timetableEntryId} on ${dateStr}`);
  }

  const subFaculty = db.prepare('SELECT * FROM faculty WHERE id = ? AND is_active = 1').get(substituteFacultyId);
  if (!subFaculty) {
    throw new Error('Selected substitute faculty not found or inactive');
  }

  // Verify candidate is eligible
  const eligibleList = findEligibleSubstitutes(timetableEntryId, dateStr);
  const eligible = eligibleList.find(c => c.facultyId === substituteFacultyId);
  if (!eligible) {
    throw new Error(`Faculty ${subFaculty.name} is not eligible for this slot due to a clash, absence, or daily load limit.`);
  }

  const assignTx = db.transaction(() => {
    db.prepare(`
      UPDATE substitutions
      SET substitute_faculty_id = ?, status = 'assigned', requested_by = ?
      WHERE id = ?
    `).run(substituteFacultyId, adminUserId, sub.id);

    // Check if all classes for this absence are covered
    const openCount = db.prepare(`
      SELECT COUNT(*) as cnt FROM substitutions
      WHERE absence_id = ? AND status = 'requested'
    `).get(sub.absence_id).cnt;

    if (openCount === 0) {
      db.prepare("UPDATE absences SET status = 'covered' WHERE id = ?").run(sub.absence_id);
    }

    // Audit log
    db.prepare(`
      INSERT INTO audit_log (user_id, action, details_json)
      VALUES (?, 'ASSIGN_SUBSTITUTION', ?)
    `).run(adminUserId, JSON.stringify({
      substitutionId: sub.id,
      timetableEntryId,
      date: dateStr,
      substituteFacultyId,
      substituteFacultyName: subFaculty.name
    }));

    // Notifications for both faculty
    const absentFacultyUser = db.prepare('SELECT user_id FROM faculty WHERE id = ?').get(sub.absent_faculty_id);
    const subFacultyUser = db.prepare('SELECT user_id FROM faculty WHERE id = ?').get(substituteFacultyId);

    if (absentFacultyUser?.user_id) {
      db.prepare(`
        INSERT INTO notifications (user_id, title, body, type)
        VALUES (?, 'Substitute Assigned by Admin', ?, 'info')
      `).run(
        absentFacultyUser.user_id,
        `Admin assigned ${subFaculty.name} to substitute your ${sub.subject_name} class on ${dateStr} (Period ${sub.slot_no}).`
      );
    }

    if (subFacultyUser?.user_id) {
      db.prepare(`
        INSERT INTO notifications (user_id, title, body, type)
        VALUES (?, 'Substitute Assignment Duty', ?, 'info')
      `).run(
        subFacultyUser.user_id,
        `You have been assigned to substitute ${sub.absent_faculty_name}'s ${sub.subject_name} class on ${dateStr} (Period ${sub.slot_no}).`
      );
    }

    return {
      substitutionId: sub.id,
      date: dateStr,
      subjectName: sub.subject_name,
      slotNo: sub.slot_no,
      substituteFacultyName: subFaculty.name,
      absentFacultyName: sub.absent_faculty_name
    };
  });

  const result = assignTx();
  broadcast('substitution:assigned', result);
  return result;
}

/**
 * Get Open Substitutions list for upcoming dates
 */
export function getOpenSubstitutions(facultyId = null) {
  const db = getDatabase();
  const todayStr = new Date().toISOString().slice(0, 10);

  const openSubs = db.prepare(`
    SELECT sub.id, sub.date, sub.timetable_entry_id, sub.status,
           a.id as absence_id, a.type as absence_type, a.reason as absence_reason,
           f.id as absent_faculty_id, f.name as absent_faculty_name,
           s.name as subject_name, s.code as subject_code, s.type as subject_type,
           sec.name as section_name, r.name as room_name,
           ts.slot_no, ts.start_time, ts.end_time, ts.label as slot_label
    FROM substitutions sub
    JOIN absences a ON sub.absence_id = a.id
    JOIN timetable_entries te ON sub.timetable_entry_id = te.id
    JOIN faculty f ON a.faculty_id = f.id
    JOIN subjects s ON te.subject_id = s.id
    JOIN sections sec ON te.section_id = sec.id
    JOIN rooms r ON te.room_id = r.id
    JOIN time_slots ts ON te.slot_id = ts.id
    WHERE sub.status = 'requested' AND sub.date >= ?
    ORDER BY sub.date ASC, ts.slot_no ASC
  `).all(todayStr);

  return openSubs.map(os => {
    let isEligible = false;
    let candidatesCount = 0;

    const candidates = findEligibleSubstitutes(os.timetable_entry_id, os.date);
    candidatesCount = candidates.length;

    if (facultyId) {
      isEligible = candidates.some(c => c.facultyId === facultyId);
    }

    return {
      ...os,
      candidatesCount,
      isEligible
    };
  });
}

/**
 * Get Comprehensive Absence Board
 */
export function getAbsenceBoard(dateStr = null) {
  const db = getDatabase();
  const todayStr = new Date().toISOString().slice(0, 10);
  const nowTime = new Date().toTimeString().slice(0, 5); // HH:MM

  let absencesQuery = `
    SELECT a.*, f.name as faculty_name, f.email as faculty_email, d.name as department_name
    FROM absences a
    JOIN faculty f ON a.faculty_id = f.id
    JOIN departments d ON f.department_id = d.id
  `;
  const params = [];

  if (dateStr) {
    absencesQuery += ' WHERE a.date = ?';
    params.push(dateStr);
  } else {
    absencesQuery += ' WHERE a.date >= ?';
    params.push(todayStr);
  }

  absencesQuery += ' ORDER BY a.date DESC, a.created_at DESC';

  const absences = db.prepare(absencesQuery).all(...params);

  return absences.map(a => {
    // Check if lateness is overdue
    let isOverdue = false;
    if (a.type === 'late' && a.status !== 'covered' && a.date === todayStr && a.expected_arrival) {
      if (nowTime > a.expected_arrival) {
        isOverdue = true;
      }
    }

    // Get affected timetable entries and substitution status
    const affected = db.prepare(`
      SELECT sub.id as substitution_id, sub.status as sub_status,
             sub.substitute_faculty_id, sub_f.name as substitute_faculty_name,
             te.id as timetable_entry_id,
             s.name as subject_name, s.code as subject_code,
             sec.name as section_name, r.name as room_name,
             ts.slot_no, ts.start_time, ts.end_time, ts.label as slot_label
      FROM substitutions sub
      JOIN timetable_entries te ON sub.timetable_entry_id = te.id
      JOIN subjects s ON te.subject_id = s.id
      JOIN sections sec ON te.section_id = sec.id
      JOIN rooms r ON te.room_id = r.id
      JOIN time_slots ts ON te.slot_id = ts.id
      LEFT JOIN faculty sub_f ON sub.substitute_faculty_id = sub_f.id
      WHERE sub.absence_id = ?
      ORDER BY ts.slot_no ASC
    `).all(a.id);

    return {
      ...a,
      isOverdue,
      affectedClasses: affected
    };
  });
}

export default {
  reportAbsence,
  findEligibleSubstitutes,
  claimSubstitution,
  assignSubstitution,
  getOpenSubstitutions,
  getAbsenceBoard
};
