import { getDatabase } from '../db/connection.js';

/**
 * Pure, deterministic conflict validator for CTAS
 * Hard constraints are strictly enforced by deterministic code and database constraints.
 * Returns: { isValid: boolean, errorCount: number, warningCount: number, violations: [] }
 */

export function validateTimetable(versionIdOrEntries, context = {}) {
  const db = getDatabase();
  const violations = [];

  let entries = [];
  let versionId = null;

  if (typeof versionIdOrEntries === 'number' || typeof versionIdOrEntries === 'string') {
    versionId = parseInt(versionIdOrEntries, 10);
    entries = db.prepare(`
      SELECT te.*, s.name as subject_name, s.code as subject_code, s.type as subject_type, s.lab_block_length, s.weekly_periods,
             sec.name as section_name, sec.strength as section_strength,
             f.name as faculty_name, f.max_periods_per_day,
             r.name as room_name, r.type as room_type, r.capacity as room_capacity,
             wd.day_name, wd.day_index,
             ts.slot_no, ts.start_time, ts.end_time, ts.is_break, ts.label as slot_label
      FROM timetable_entries te
      JOIN subjects s ON te.subject_id = s.id
      JOIN sections sec ON te.section_id = sec.id
      JOIN faculty f ON te.faculty_id = f.id
      JOIN rooms r ON te.room_id = r.id
      JOIN working_days wd ON te.day_id = wd.id
      JOIN time_slots ts ON te.slot_id = ts.id
      WHERE te.version_id = ?
    `).all(versionId);
  } else if (Array.isArray(versionIdOrEntries)) {
    entries = versionIdOrEntries;
    if (entries.length > 0 && entries[0].version_id) {
      versionId = entries[0].version_id;
    }
  }

  // Double Booking Maps
  const facultySlotMap = new Map();
  const sectionSlotMap = new Map();
  const sectionFloorSlotMap = new Map();
  const roomSlotMap = new Map();

  // Availability map
  const availMap = new Set();
  const availRows = db.prepare('SELECT faculty_id, day_id, slot_id FROM faculty_availability WHERE is_available = 1').all();
  for (const a of availRows) {
    availMap.add(`${a.faculty_id}_${a.day_id}_${a.slot_id}`);
  }

  // Tracking counts
  const facultyDayCounts = new Map();
  const sectionSubjectCounts = new Map();
  const sectionDaySlots = new Map();

  // Group lab entries to test contiguity
  const labGroups = new Map(); // key: `sectionId_dayId_subjectId` -> entries[]

  for (const e of entries) {
    const timeKey = `${e.day_id}_${e.slot_id}`;

    // 1. Break slot used (Hard Error)
    if (e.is_break === 1) {
      violations.push({
        severity: 'error',
        code: 'BREAK_SLOT_USED',
        message: `Class scheduled during break slot '${e.slot_label}' (${e.start_time}-${e.end_time}).`,
        entities: { entryId: e.id, section: e.section_name, faculty: e.faculty_name },
        day: e.day_name,
        slot: e.slot_label
      });
    }

    // 2. Faculty double-booking (Hard Error - Rule 2)
    if (e.faculty_id) {
      const facKey = `${e.faculty_id}_${timeKey}`;
      if (facultySlotMap.has(facKey)) {
        const prior = facultySlotMap.get(facKey);
        violations.push({
          severity: 'error',
          code: 'FACULTY_DOUBLE_BOOKED',
          message: `Faculty '${e.faculty_name}' is double-booked for '${e.subject_code}' and '${prior.subject_code}' on ${e.day_name} at ${e.slot_label}.`,
          entities: { facultyId: e.faculty_id, entryId1: prior.id, entryId2: e.id },
          day: e.day_name,
          slot: e.slot_label
        });
      } else {
        facultySlotMap.set(facKey, e);
      }
    }

    // 3. Section double-booking (Hard Error)
    // Parallel lab batches and parallel electives / activities in different rooms are valid.
    if (e.section_id) {
      const secKey = `${e.section_id}_${timeKey}`;
      if (sectionSlotMap.has(secKey)) {
        const prior = sectionSlotMap.get(secKey);
        const isSharedActivity = (e.subject_code === 'ACTIVITY' && prior.subject_code === 'ACTIVITY');
        const isBothLabs = (e.subject_type === 'lab' && prior.subject_type === 'lab');
        const isParallelElective = (e.room_id !== prior.room_id && (e.room_note || prior.room_note || (e.batch && prior.batch && e.batch !== prior.batch) || (e.subject_code !== prior.subject_code)));

        if (!isSharedActivity && !isBothLabs && !isParallelElective) {
          violations.push({
            severity: 'error',
            code: 'SECTION_DOUBLE_BOOKED',
            message: `Section '${e.section_name}' has two simultaneous classes ('${e.subject_code}' & '${prior.subject_code}') on ${e.day_name} at ${e.slot_label}.`,
            entities: { sectionId: e.section_id, entryId1: prior.id, entryId2: e.id },
            day: e.day_name,
            slot: e.slot_label
          });
        }
      } else {
        sectionSlotMap.set(secKey, e);
      }
    }

    // 4. Same-section lab batches floor conflict (Rule 5)
    // Lab batches of the same section that run at the same time must be on different floors
    if (e.section_id && e.subject_type === 'lab' && e.floor !== null && e.floor !== undefined) {
      const secFloorKey = `${e.section_id}_${timeKey}_fl_${e.floor}`;
      if (sectionFloorSlotMap.has(secFloorKey)) {
        const prior = sectionFloorSlotMap.get(secFloorKey);
        violations.push({
          severity: 'error',
          code: 'FLOOR_CONFLICT',
          message: `Section '${e.section_name}' has two lab batches ('${e.subject_code}' and '${prior.subject_code}') on the same floor (${e.floor_name || 'Floor ' + e.floor}) on ${e.day_name} at ${e.slot_label}.`,
          entities: { sectionId: e.section_id, entryId1: prior.id, entryId2: e.id, floor: e.floor },
          day: e.day_name,
          slot: e.slot_label
        });
      } else {
        sectionFloorSlotMap.set(secFloorKey, e);
      }
    }

    // 5. Room double-booking (Hard Error - Rule 1)
    if (e.room_id && e.room_name && e.room_name !== 'TBD') {
      const roomKey = `${e.room_id}_${timeKey}`;
      if (roomSlotMap.has(roomKey)) {
        const prior = roomSlotMap.get(roomKey);
        violations.push({
          severity: 'error',
          code: 'ROOM_DOUBLE_BOOKED',
          message: `Room '${e.room_name}' is booked for two classes simultaneously on ${e.day_name} at ${e.slot_label}.`,
          entities: { roomId: e.room_id, entryId1: prior.id, entryId2: e.id },
          day: e.day_name,
          slot: e.slot_label
        });
      } else {
        roomSlotMap.set(roomKey, e);
      }
    }

    // 6. Faculty availability check (Hard Error)
    if (!context.skipFacultyAvailabilityCheck && e.faculty_id && availRows.length > 0) {
      if (!availMap.has(`${e.faculty_id}_${e.day_id}_${e.slot_id}`)) {
        violations.push({
          severity: 'error',
          code: 'FACULTY_UNAVAILABLE',
          message: `Faculty '${e.faculty_name}' is marked unavailable on ${e.day_name} during ${e.slot_label}.`,
          entities: { facultyId: e.faculty_id, entryId: e.id },
          day: e.day_name,
          slot: e.slot_label
        });
      }
    }

    // 7. Room type mismatch (Hard Error - Rule 3)
    if (e.room_id && e.room_name && e.room_name !== 'TBD') {
      const isLabRoom = (e.room_type || '').toLowerCase() === 'lab';
      if (e.subject_type === 'lab' && !isLabRoom) {
        violations.push({
          severity: 'error',
          code: 'ROOM_TYPE_MISMATCH',
          message: `Lab subject '${e.subject_code}' is scheduled in regular classroom '${e.room_name}' instead of a laboratory.`,
          entities: { entryId: e.id, roomId: e.room_id, subjectId: e.subject_id },
          day: e.day_name,
          slot: e.slot_label
        });
      } else if (e.subject_type !== 'lab' && isLabRoom) {
        violations.push({
          severity: 'error',
          code: 'ROOM_TYPE_MISMATCH',
          message: `Theory/activity subject '${e.subject_code}' is scheduled in laboratory '${e.room_name}' instead of a classroom.`,
          entities: { entryId: e.id, roomId: e.room_id, subjectId: e.subject_id },
          day: e.day_name,
          slot: e.slot_label
        });
      }

      // 7. Room capacity check (Hard Error)
      if (e.section_strength && e.room_capacity < e.section_strength) {
        violations.push({
          severity: 'error',
          code: 'ROOM_CAPACITY_INSUFFICIENT',
          message: `Room '${e.room_name}' capacity (${e.room_capacity}) is smaller than section '${e.section_name}' strength (${e.section_strength}).`,
          entities: { entryId: e.id, roomId: e.room_id, sectionId: e.section_id },
          day: e.day_name,
          slot: e.slot_label
        });
      }
    }

    // Faculty daily load count
    const facDayKey = `${e.faculty_id}_${e.day_id}`;
    facultyDayCounts.set(facDayKey, (facultyDayCounts.get(facDayKey) || 0) + 1);

    // Section subject count
    const secSubKey = `${e.section_id}_${e.subject_id}`;
    sectionSubjectCounts.set(secSubKey, (sectionSubjectCounts.get(secSubKey) || 0) + 1);

    // Section day slots for gap analysis
    const secDayKey = `${e.section_id}_${e.day_id}`;
    if (!sectionDaySlots.has(secDayKey)) sectionDaySlots.set(secDayKey, []);
    sectionDaySlots.get(secDayKey).push(e);

    // Group labs per session or per batch
    if (e.subject_type === 'lab' && (e.lab_block_length > 1 || e.is_lab_block === 1)) {
      const lk = e.session_id ? `session_${e.session_id}` : `${e.section_id}_${e.day_id}_${e.subject_id}_${e.batch || 'all'}`;
      if (!labGroups.has(lk)) labGroups.set(lk, []);
      labGroups.get(lk).push(e);
    }
  }

  // 8. Lab block continuity check (Hard Error)
  for (const [, labEntries] of labGroups) {
    if (labEntries.length > 1) {
      const sorted = [...labEntries].sort((a, b) => a.slot_no - b.slot_no);
      for (let i = 0; i < sorted.length - 1; i++) {
        const cur = sorted[i];
        const next = sorted[i + 1];
        if (next.slot_no !== cur.slot_no + 1 || cur.room_id !== next.room_id) {
          violations.push({
            severity: 'error',
            code: 'LAB_BLOCK_NOT_CONTIGUOUS',
            message: `Laboratory block for '${cur.subject_code}' on ${cur.day_name} is broken or split across discontinuous slots/rooms.`,
            entities: { sectionId: cur.section_id, subjectId: cur.subject_id, dayId: cur.day_id },
            day: cur.day_name,
            slot: cur.slot_label
          });
        }
      }
    }
  }

  // 9. Faculty daily overload (Warning)
  for (const [facDayKey, count] of facultyDayCounts) {
    const [facultyId, dayId] = facDayKey.split('_').map(Number);
    const fac = db.prepare('SELECT name, max_periods_per_day FROM faculty WHERE id = ?').get(facultyId);
    const day = db.prepare('SELECT day_name FROM working_days WHERE id = ?').get(dayId);
    if (fac && count > fac.max_periods_per_day) {
      violations.push({
        severity: 'warning',
        code: 'FACULTY_OVERLOAD_DAY',
        message: `Faculty '${fac.name}' has ${count} periods on ${day.day_name}, exceeding preferred limit of ${fac.max_periods_per_day}.`,
        entities: { facultyId, dayId, count, max: fac.max_periods_per_day },
        day: day.day_name,
        slot: null
      });
    }
  }

  // 10. Subject period count mismatch (Error if full version check)
  if (versionId && !context.skipPeriodCountCheck) {
    const requiredAssignments = db.prepare(`
      SELECT ss.section_id, ss.subject_id, s.code as subject_code, s.weekly_periods, sec.name as section_name
      FROM section_subjects ss
      JOIN subjects s ON ss.subject_id = s.id
      JOIN sections sec ON ss.section_id = sec.id
    `).all();

    for (const req of requiredAssignments) {
      const scheduledCount = sectionSubjectCounts.get(`${req.section_id}_${req.subject_id}`) || 0;
      if (scheduledCount !== req.weekly_periods) {
        violations.push({
          severity: 'error',
          code: 'SUBJECT_PERIODS_MISMATCH',
          message: `Section '${req.section_name}' requires ${req.weekly_periods} periods of '${req.subject_code}', but ${scheduledCount} are scheduled.`,
          entities: { sectionId: req.section_id, subjectId: req.subject_id, required: req.weekly_periods, actual: scheduledCount },
          day: null,
          slot: null
        });
      }
    }
  }

  // 11. Excessive gaps check (Warning)
  for (const [, dayEntries] of sectionDaySlots) {
    if (dayEntries.length > 1) {
      const sortedSlots = dayEntries.map(e => e.slot_no).sort((a, b) => a - b);
      const span = sortedSlots[sortedSlots.length - 1] - sortedSlots[0] + 1;
      const gaps = span - sortedSlots.length;
      if (gaps >= 3) {
        const first = dayEntries[0];
        violations.push({
          severity: 'warning',
          code: 'EXCESSIVE_GAPS',
          message: `Section '${first.section_name}' has ${gaps} idle gap periods on ${first.day_name}.`,
          entities: { sectionId: first.section_id, dayId: first.day_id, gaps },
          day: first.day_name,
          slot: null
        });
      }
    }
  }

  const errorCount = violations.filter(v => v.severity === 'error').length;
  const warningCount = violations.filter(v => v.severity === 'warning').length;

  return {
    isValid: errorCount === 0,
    errorCount,
    warningCount,
    violations
  };
}

/**
 * Validate a proposed single-cell move or edit (for live Drag & Drop)
 */
export function validateMove(proposal) {
  const { versionId, entryId, targetDayId, targetSlotId, targetRoomId, targetFacultyId } = proposal;
  const db = getDatabase();

  const entries = db.prepare(`
    SELECT te.*, s.name as subject_name, s.code as subject_code, s.type as subject_type, s.lab_block_length, s.weekly_periods,
           sec.name as section_name, sec.strength as section_strength,
           f.name as faculty_name, f.max_periods_per_day,
           r.name as room_name, r.type as room_type, r.capacity as room_capacity,
           wd.day_name, wd.day_index,
           ts.slot_no, ts.start_time, ts.end_time, ts.is_break, ts.label as slot_label
    FROM timetable_entries te
    JOIN subjects s ON te.subject_id = s.id
    JOIN sections sec ON te.section_id = sec.id
    JOIN faculty f ON te.faculty_id = f.id
    JOIN rooms r ON te.room_id = r.id
    JOIN working_days wd ON te.day_id = wd.id
    JOIN time_slots ts ON te.slot_id = ts.id
    WHERE te.version_id = ?
  `).all(versionId);

  // Apply hypothetical move
  const modifiedEntries = entries.map(e => {
    if (e.id === entryId) {
      const newDay = db.prepare('SELECT day_name, day_index FROM working_days WHERE id = ?').get(targetDayId) || {};
      const newSlot = db.prepare('SELECT slot_no, start_time, end_time, is_break, label as slot_label FROM time_slots WHERE id = ?').get(targetSlotId) || {};
      const newRoom = targetRoomId ? db.prepare('SELECT name as room_name, type as room_type, capacity as room_capacity FROM rooms WHERE id = ?').get(targetRoomId) : {};
      const newFac = targetFacultyId ? db.prepare('SELECT name as faculty_name, max_periods_per_day FROM faculty WHERE id = ?').get(targetFacultyId) : {};

      return {
        ...e,
        day_id: targetDayId,
        slot_id: targetSlotId,
        room_id: targetRoomId || e.room_id,
        faculty_id: targetFacultyId || e.faculty_id,
        ...newDay,
        ...newSlot,
        ...newRoom,
        ...newFac
      };
    }
    return e;
  });

  return validateTimetable(modifiedEntries, { skipPeriodCountCheck: true });
}

export default {
  validateTimetable,
  validateMove
};
