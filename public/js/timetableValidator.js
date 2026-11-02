/**
 * Shared Timetable Conflict Validator for CTAS
 * Used uniformly across:
 * 1. Studio Header Conflict Counter
 * 2. Studio Toolbar Resolve Button (live count badge)
 * 3. Studio Interactive Grid Cell Highlighting & Tooltips
 * 4. Conflict Resolver Engine (Min-Conflicts Local Search)
 *
 * Detects all 8 required constraint violations:
 * 1. Faculty double-booked
 * 2. Room double-booked
 * 3. Section double-booked
 * 4. Faculty unavailable
 * 5. Faculty exceeding daily limit
 * 6. Lab consecutive period block & lab room requirement
 * 7. Subject weekly hours mismatch (too few / too many)
 * 8. Room type or capacity mismatch
 */

export function evaluateTimetableConflicts(entries = [], masterData = {}, options = {}) {
  const violations = [];
  const conflictsByEntryId = {};
  const conflictsByCellKey = {};

  const {
    workingDays = [],
    timeSlots = [],
    faculty = [],
    rooms = [],
    sections = [],
    subjects = [],
    facultyAvailability = [],
    sectionSubjects = [],
    facultySubjects = []
  } = masterData;

  // Lookup maps for quick entity resolution
  const dayMap = new Map(workingDays.map(d => [d.id, d]));
  const slotMap = new Map(timeSlots.map(s => [s.id, s]));
  const facultyMap = new Map(faculty.map(f => [f.id, f]));
  const roomMap = new Map(rooms.map(r => [r.id, r]));
  const sectionMap = new Map(sections.map(s => [s.id, s]));
  const subjectMap = new Map(subjects.map(s => [s.id, s]));

  // Availability fast lookup: `facultyId_dayId_slotId` -> true/false
  const availMap = new Map();
  if (Array.isArray(facultyAvailability)) {
    for (const a of facultyAvailability) {
      availMap.set(`${a.faculty_id}_${a.day_id}_${a.slot_id}`, Number(a.is_available) === 1);
    }
  }

  // Maps to detect simultaneous bookings
  const facultySlotMap = new Map(); // key: `facultyId_dayId_slotId` -> entries[]
  const roomSlotMap = new Map();    // key: `roomId_dayId_slotId` -> entries[]
  const sectionSlotMap = new Map(); // key: `sectionId_dayId_slotId` -> entries[]

  // Aggregation maps
  const facultyDayCountMap = new Map();     // key: `facultyId_dayId` -> entries[]
  const sectionSubjectCountMap = new Map(); // key: `sectionId_subjectId` -> entries[]
  const labBlocksMap = new Map();           // key: `sectionId_subjectId_dayId` -> entries[]

  let conflictSequence = 1;

  function registerViolation(v) {
    v.id = `cnf_${conflictSequence++}`;
    violations.push(v);

    if (Array.isArray(v.involvedEntryIds)) {
      for (const eid of v.involvedEntryIds) {
        if (!conflictsByEntryId[eid]) conflictsByEntryId[eid] = [];
        conflictsByEntryId[eid].push(v);
      }
    }

    if (v.dayId && v.slotId) {
      // Cell keys for section, faculty, room grids
      if (v.sectionId) {
        const kSec = `${v.dayId}_${v.slotId}_sec_${v.sectionId}`;
        if (!conflictsByCellKey[kSec]) conflictsByCellKey[kSec] = [];
        conflictsByCellKey[kSec].push(v);
      }
      if (v.facultyId) {
        const kFac = `${v.dayId}_${v.slotId}_fac_${v.facultyId}`;
        if (!conflictsByCellKey[kFac]) conflictsByCellKey[kFac] = [];
        conflictsByCellKey[kFac].push(v);
      }
      if (v.roomId) {
        const kRoom = `${v.dayId}_${v.slotId}_room_${v.roomId}`;
        if (!conflictsByCellKey[kRoom]) conflictsByCellKey[kRoom] = [];
        conflictsByCellKey[kRoom].push(v);
      }
    }
  }

  // Step 1: Scan individual entries & populate slot maps
  for (const e of entries) {
    const day = dayMap.get(e.day_id) || { id: e.day_id, day_name: e.day_name || `Day ${e.day_id}` };
    const slot = slotMap.get(e.slot_id) || { id: e.slot_id, slot_no: e.slot_no, label: e.slot_label || `Period ${e.slot_no}`, is_break: e.is_break || 0 };
    const fac = facultyMap.get(e.faculty_id) || { id: e.faculty_id, name: e.faculty_name || `Faculty ${e.faculty_id}`, max_periods_per_day: e.max_periods_per_day || 4 };
    const rm = roomMap.get(e.room_id) || { id: e.room_id, name: e.room_name || `Room ${e.room_id}`, type: e.room_type || 'classroom', capacity: e.room_capacity || 40 };
    const sec = sectionMap.get(e.section_id) || { id: e.section_id, name: e.section_name || `Section ${e.section_id}`, strength: e.section_strength || 40 };
    const sub = subjectMap.get(e.subject_id) || { id: e.subject_id, code: e.subject_code || 'SUB', name: e.subject_name || 'Subject', type: e.subject_type || 'theory', weekly_periods: e.weekly_periods || 4, lab_block_length: e.lab_block_length || 1 };

    // Fill denormalized attributes on the entry if missing
    e.day_name = day.day_name;
    e.slot_no = slot.slot_no;
    e.slot_label = slot.label;
    e.faculty_name = fac.name;
    e.room_name = rm.name;
    e.room_type = rm.type;
    e.room_capacity = rm.capacity;
    e.section_name = sec.name;
    e.section_strength = sec.strength;
    e.subject_code = sub.code;
    e.subject_name = sub.name;
    e.subject_type = sub.type;
    e.lab_block_length = sub.lab_block_length;
    e.weekly_periods = sub.weekly_periods;

    // Check Break Slot
    if (slot.is_break === 1) {
      registerViolation({
        type: 'BREAK_SLOT_USED',
        day: day.day_name,
        dayId: day.id,
        period: slot.label,
        slotId: slot.id,
        section: sec.name,
        sectionId: sec.id,
        faculty: fac.name,
        facultyId: fac.id,
        room: rm.name,
        roomId: rm.id,
        message: `Class for Section '${sec.name}' (${sub.code}) scheduled during designated break period '${slot.label}'.`,
        suggestedFix: `Move this class to a regular teaching time slot.`,
        involvedEntryIds: [e.id]
      });
    }

    // Check 4: Faculty Availability
    const availKey = `${e.faculty_id}_${e.day_id}_${e.slot_id}`;
    if (availMap.has(availKey) && availMap.get(availKey) === false) {
      registerViolation({
        type: 'FACULTY_UNAVAILABLE',
        day: day.day_name,
        dayId: day.id,
        period: slot.label,
        slotId: slot.id,
        section: sec.name,
        sectionId: sec.id,
        faculty: fac.name,
        facultyId: fac.id,
        room: rm.name,
        roomId: rm.id,
        message: `${fac.name} is marked unavailable on ${day.day_name} during ${slot.label}.`,
        suggestedFix: `Reassign ${sub.code} to another qualified instructor or reschedule to when ${fac.name} is available.`,
        involvedEntryIds: [e.id]
      });
    }

    // Check 8a: Room Type Mismatch (e.g. Lab in regular classroom)
    const isLabSubject = sub.type === 'lab' || Number(e.is_lab_block) === 1 || Number(sub.lab_block_length) > 1;
    if (isLabSubject && rm.type !== 'lab') {
      registerViolation({
        type: 'ROOM_TYPE_MISMATCH',
        day: day.day_name,
        dayId: day.id,
        period: slot.label,
        slotId: slot.id,
        section: sec.name,
        sectionId: sec.id,
        faculty: fac.name,
        facultyId: fac.id,
        room: rm.name,
        roomId: rm.id,
        message: `Practical lab course '${sub.code}' requires a laboratory room, but is assigned to standard classroom '${rm.name}'.`,
        suggestedFix: `Reassign to a laboratory venue (e.g. Computer Lab or Science Lab).`,
        involvedEntryIds: [e.id]
      });
    }

    // Check 8b: Room Capacity Mismatch
    if (rm.capacity && sec.strength && rm.capacity < sec.strength) {
      registerViolation({
        type: 'ROOM_CAPACITY_INSUFFICIENT',
        day: day.day_name,
        dayId: day.id,
        period: slot.label,
        slotId: slot.id,
        section: sec.name,
        sectionId: sec.id,
        faculty: fac.name,
        facultyId: fac.id,
        room: rm.name,
        roomId: rm.id,
        message: `Room '${rm.name}' capacity (${rm.capacity} seats) is insufficient for Section '${sec.name}' (${sec.strength} students).`,
        suggestedFix: `Move section to a room with at least ${sec.strength} seats.`,
        involvedEntryIds: [e.id]
      });
    }

    // Populate maps for pairwise collision checks
    const fKey = `${e.faculty_id}_${e.day_id}_${e.slot_id}`;
    if (!facultySlotMap.has(fKey)) facultySlotMap.set(fKey, []);
    facultySlotMap.get(fKey).push(e);

    const rKey = `${e.room_id}_${e.day_id}_${e.slot_id}`;
    if (!roomSlotMap.has(rKey)) roomSlotMap.set(rKey, []);
    roomSlotMap.get(rKey).push(e);

    const sKey = `${e.section_id}_${e.day_id}_${e.slot_id}`;
    if (!sectionSlotMap.has(sKey)) sectionSlotMap.set(sKey, []);
    sectionSlotMap.get(sKey).push(e);

    // Faculty Day count
    const fDayKey = `${e.faculty_id}_${e.day_id}`;
    if (!facultyDayCountMap.has(fDayKey)) facultyDayCountMap.set(fDayKey, []);
    facultyDayCountMap.get(fDayKey).push(e);

    // Section Subject count
    const secSubKey = `${e.section_id}_${e.subject_id}`;
    if (!sectionSubjectCountMap.has(secSubKey)) sectionSubjectCountMap.set(secSubKey, []);
    sectionSubjectCountMap.get(secSubKey).push(e);

    // Lab blocks grouping
    if (isLabSubject) {
      const labKey = `${e.section_id}_${e.subject_id}_${e.day_id}`;
      if (!labBlocksMap.has(labKey)) labBlocksMap.set(labKey, []);
      labBlocksMap.get(labKey).push(e);
    }
  }

  // Check 1: Faculty Double-Booked
  for (const [, booked] of facultySlotMap) {
    if (booked.length > 1) {
      for (let i = 0; i < booked.length; i++) {
        for (let j = i + 1; j < booked.length; j++) {
          const e1 = booked[i];
          const e2 = booked[j];
          registerViolation({
            type: 'FACULTY_DOUBLE_BOOKED',
            day: e1.day_name,
            dayId: e1.day_id,
            period: e1.slot_label,
            slotId: e1.slot_id,
            section: `${e1.section_name} & ${e2.section_name}`,
            sectionId: e1.section_id,
            faculty: e1.faculty_name,
            facultyId: e1.faculty_id,
            room: `${e1.room_name} / ${e2.room_name}`,
            roomId: e1.room_id,
            message: `${e1.faculty_name} is double-booked teaching '${e1.subject_code}' (Sec ${e1.section_name}) and '${e2.subject_code}' (Sec ${e2.section_name}) on ${e1.day_name} at ${e1.slot_label}.`,
            suggestedFix: `Move one of the sections to another period or assign a co-faculty.`,
            involvedEntryIds: [e1.id, e2.id]
          });
        }
      }
    }
  }

  // Check 2: Room Double-Booked
  for (const [, booked] of roomSlotMap) {
    if (booked.length > 1) {
      for (let i = 0; i < booked.length; i++) {
        for (let j = i + 1; j < booked.length; j++) {
          const e1 = booked[i];
          const e2 = booked[j];
          registerViolation({
            type: 'ROOM_DOUBLE_BOOKED',
            day: e1.day_name,
            dayId: e1.day_id,
            period: e1.slot_label,
            slotId: e1.slot_id,
            section: `${e1.section_name} & ${e2.section_name}`,
            sectionId: e1.section_id,
            faculty: `${e1.faculty_name} & ${e2.faculty_name}`,
            facultyId: e1.faculty_id,
            room: e1.room_name,
            roomId: e1.room_id,
            message: `Room '${e1.room_name}' is booked for two classes simultaneously ('${e1.subject_code}' and '${e2.subject_code}') on ${e1.day_name} at ${e1.slot_label}.`,
            suggestedFix: `Move one class to another vacant room or reschedule.`,
            involvedEntryIds: [e1.id, e2.id]
          });
        }
      }
    }
  }

  // Check 3: Section Double-Booked
  for (const [, booked] of sectionSlotMap) {
    if (booked.length > 1) {
      for (let i = 0; i < booked.length; i++) {
        for (let j = i + 1; j < booked.length; j++) {
          const e1 = booked[i];
          const e2 = booked[j];
          registerViolation({
            type: 'SECTION_DOUBLE_BOOKED',
            day: e1.day_name,
            dayId: e1.day_id,
            period: e1.slot_label,
            slotId: e1.slot_id,
            section: e1.section_name,
            sectionId: e1.section_id,
            faculty: `${e1.faculty_name} & ${e2.faculty_name}`,
            facultyId: e1.faculty_id,
            room: `${e1.room_name} & ${e2.room_name}`,
            roomId: e1.room_id,
            message: `Section '${e1.section_name}' has two simultaneous classes ('${e1.subject_code}' and '${e2.subject_code}') on ${e1.day_name} at ${e1.slot_label}.`,
            suggestedFix: `Relocate one of the conflicting subjects to an open period on another day.`,
            involvedEntryIds: [e1.id, e2.id]
          });
        }
      }
    }
  }

  // Check 5: Faculty Exceeding Max Periods Per Day
  for (const [key, classList] of facultyDayCountMap) {
    const [facId, dayId] = key.split('_').map(Number);
    const fac = facultyMap.get(facId) || { name: `Faculty ${facId}`, max_periods_per_day: 4 };
    const day = dayMap.get(dayId) || { day_name: `Day ${dayId}` };
    const limit = fac.max_periods_per_day || 4;

    if (classList.length > limit) {
      registerViolation({
        type: 'FACULTY_OVERLOAD_DAY',
        day: day.day_name,
        dayId,
        period: null,
        slotId: null,
        section: classList.map(c => c.section_name).filter((v, i, a) => a.indexOf(v) === i).join(', '),
        sectionId: classList[0]?.section_id,
        faculty: fac.name,
        facultyId: fac.id,
        room: classList.map(c => c.room_name).filter((v, i, a) => a.indexOf(v) === i).join(', '),
        roomId: classList[0]?.room_id,
        message: `${fac.name} is scheduled for ${classList.length} periods on ${day.day_name}, exceeding maximum daily teaching limit of ${limit}.`,
        suggestedFix: `Redistribute one or more periods to other weekdays or assign substitute instructors.`,
        involvedEntryIds: classList.map(c => c.id)
      });
    }
  }

  // Check 6: Lab Consecutive Periods & Contiguity Check
  for (const [, labEntries] of labBlocksMap) {
    if (labEntries.length > 1) {
      const sorted = [...labEntries].sort((a, b) => a.slot_no - b.slot_no);
      for (let i = 0; i < sorted.length - 1; i++) {
        const cur = sorted[i];
        const next = sorted[i + 1];
        const isConsecutiveSlot = next.slot_no === cur.slot_no + 1;
        const isSameRoom = cur.room_id === next.room_id;

        if (!isConsecutiveSlot || !isSameRoom) {
          registerViolation({
            type: 'LAB_BLOCK_NOT_CONTIGUOUS',
            day: cur.day_name,
            dayId: cur.day_id,
            period: `${cur.slot_label} & ${next.slot_label}`,
            slotId: cur.slot_id,
            section: cur.section_name,
            sectionId: cur.section_id,
            faculty: cur.faculty_name,
            facultyId: cur.faculty_id,
            room: isSameRoom ? cur.room_name : `${cur.room_name} vs ${next.room_name}`,
            roomId: cur.room_id,
            message: `Laboratory block for '${cur.subject_code}' on ${cur.day_name} is not contiguous (split across slots ${cur.slot_no} & ${next.slot_no}${!isSameRoom ? ' in different rooms' : ''}).`,
            suggestedFix: `Schedule lab sessions back-to-back in consecutive periods within the same laboratory room.`,
            involvedEntryIds: [cur.id, next.id]
          });
        }
      }
    }
  }

  // Check 7: Subject Weekly Periods Mismatch (Too few or too many)
  if (!options.skipWeeklyHoursCheck) {
    // If sectionSubjects master data is available, verify against it
    if (Array.isArray(sectionSubjects) && sectionSubjects.length > 0) {
      for (const req of sectionSubjects) {
        const scheduled = sectionSubjectCountMap.get(`${req.section_id}_${req.subject_id}`) || [];
        const sec = sectionMap.get(req.section_id) || { name: `Section ${req.section_id}` };
        const sub = subjectMap.get(req.subject_id) || { code: req.subject_code || 'SUB', weekly_periods: req.weekly_periods || 4 };
        const required = req.weekly_periods || sub.weekly_periods || 4;

        if (scheduled.length !== required) {
          registerViolation({
            type: 'SUBJECT_PERIODS_MISMATCH',
            day: null,
            dayId: null,
            period: null,
            slotId: null,
            section: sec.name,
            sectionId: req.section_id,
            faculty: req.faculty_name || 'Assigned Instructor',
            facultyId: req.faculty_id,
            room: null,
            roomId: null,
            message: `Section '${sec.name}' requires ${required} weekly periods of '${sub.code}', but has ${scheduled.length} scheduled (${scheduled.length < required ? 'too few' : 'too many'}).`,
            suggestedFix: scheduled.length < required
              ? `Schedule ${required - scheduled.length} additional period(s) for ${sub.code}.`
              : `Remove ${scheduled.length - required} excess period(s) for ${sub.code}.`,
            involvedEntryIds: scheduled.map(e => e.id)
          });
        }
      }
    }
  }

  return {
    isValid: violations.length === 0,
    errorCount: violations.length,
    conflicts: violations,
    conflictsByEntryId,
    conflictsByCellKey
  };
}

export const validateTimetableConflict = evaluateTimetableConflicts;
export default {
  evaluateTimetableConflicts,
  validateTimetableConflict
};
