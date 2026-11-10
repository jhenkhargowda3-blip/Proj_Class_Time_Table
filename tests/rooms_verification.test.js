import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDatabase } from '../src/db/connection.js';
import { importReferenceData, getProjectedTimetableEntries, getUnassignedSessions } from '../src/services/referenceDataService.js';
import { evaluateTimetableConflicts } from '../public/js/timetableValidator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function runRoomsVerification() {
  const jsonPath = path.resolve(__dirname, '../public/assets/aistudio/CTAS_reference_data_with_rooms_91d4f9d0.json');
  const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

  // Ensure DB is synced with reference data
  const db = getDatabase();
  importReferenceData(db, { data: json });

  const sessions = db.prepare('SELECT * FROM faculty_sessions').all();
  const rooms = db.prepare('SELECT * FROM rooms WHERE is_active = 1').all();
  const sections = db.prepare('SELECT * FROM sections').all();
  const projectedEntries = getProjectedTimetableEntries(db);
  const unassigned = getUnassignedSessions(db);

  // 1. Session count
  const sessionCount = sessions.length;

  // 2. Room count
  const roomCount = rooms.length;

  // 3. Section count
  const sectionCount = sections.length;

  // 4. Room double-bookings (Rule 1)
  const roomSlots = new Map();
  let roomDoubleBookings = 0;
  for (const s of sessions) {
    if (s.room_id && s.room_name && s.room_name !== 'TBD') {
      for (let p = s.period_start; p <= s.period_end; p++) {
        const key = `${s.room_id}_${s.day}_${p}`;
        if (roomSlots.has(key)) {
          roomDoubleBookings++;
        } else {
          roomSlots.set(key, s);
        }
      }
    }
  }

  // 5. Faculty double-bookings (Rule 2)
  const facultySlots = new Map();
  let facultyDoubleBookings = 0;
  for (const s of sessions) {
    if (s.faculty_id) {
      for (let p = s.period_start; p <= s.period_end; p++) {
        const key = `${s.faculty_id}_${s.day}_${p}`;
        if (facultySlots.has(key)) {
          facultyDoubleBookings++;
        } else {
          facultySlots.set(key, s);
        }
      }
    }
  }

  // 6. Lab-in-classroom errors (Rule 3)
  let labInClassroomErrors = 0;
  for (const s of sessions) {
    const isLab = s.type === 'lab';
    const isLabRoom = (s.room_type || '').toLowerCase() === 'lab' || (s.room_id && String(s.room_id).startsWith('LAB'));
    if (isLab && !isLabRoom) {
      labInClassroomErrors++;
    } else if (!isLab && isLabRoom) {
      labInClassroomErrors++;
    }
  }

  // 7. Same-floor same-section lab pairs (Rule 5)
  let sameFloorSameSectionLabPairs = 0;
  const sectionLabSlots = new Map();
  for (const s of sessions) {
    if (s.type === 'lab') {
      const effectiveSec = s.section_resolved || s.section;
      const secKey = (s.semester && effectiveSec) ? `CSE-${s.semester}${effectiveSec}` : null;
      if (!secKey) continue;

      for (let p = s.period_start; p <= s.period_end; p++) {
        const slotKey = `${secKey}_${s.day}_${p}`;
        if (!sectionLabSlots.has(slotKey)) {
          sectionLabSlots.set(slotKey, []);
        }
        sectionLabSlots.get(slotKey).push(s);
      }
    }
  }

  for (const [, labs] of sectionLabSlots) {
    if (labs.length > 1) {
      for (let i = 0; i < labs.length; i++) {
        for (let j = i + 1; j < labs.length; j++) {
          if (labs[i].floor !== null && labs[i].floor !== undefined && labs[i].floor === labs[j].floor) {
            sameFloorSameSectionLabPairs++;
          }
        }
      }
    }
  }

  // 8. Unassigned sessions
  const unassignedSessions = unassigned.length;

  // 9. Diff count: verify no timetable fields modified
  let diffCount = 0;
  const jsonSessionMap = new Map(json.sessions.map(s => [s.id, s]));
  for (const dbSession of sessions) {
    const orig = jsonSessionMap.get(dbSession.id);
    if (!orig) {
      diffCount++;
      continue;
    }
    if (
      orig.day !== dbSession.day ||
      orig.start !== dbSession.start ||
      orig.end !== dbSession.end ||
      orig.period_start !== dbSession.period_start ||
      orig.period_end !== dbSession.period_end ||
      orig.hours !== dbSession.hours ||
      orig.subject_code !== dbSession.subject_code ||
      orig.type !== dbSession.type ||
      orig.batch !== dbSession.batch ||
      orig.faculty_id !== dbSession.faculty_id ||
      String(orig.semester || '') !== String(dbSession.semester || '') ||
      orig.section !== dbSession.section
    ) {
      diffCount++;
    }
  }

  // Print exact requested verification output
  console.log(`session count: ${sessionCount}`);
  console.log(`room count: ${roomCount}`);
  console.log(`section count: ${sectionCount}`);
  console.log(`room double-bookings: ${roomDoubleBookings}`);
  console.log(`faculty double-bookings: ${facultyDoubleBookings}`);
  console.log(`lab-in-classroom errors: ${labInClassroomErrors}`);
  console.log(`same-floor same-section lab pairs: ${sameFloorSameSectionLabPairs}`);
  console.log(`unassigned sessions: ${unassignedSessions}`);
  console.log(`diff count: ${diffCount}`);

  return {
    sessionCount,
    roomCount,
    sectionCount,
    roomDoubleBookings,
    facultyDoubleBookings,
    labInClassroomErrors,
    sameFloorSameSectionLabPairs,
    unassignedSessions,
    diffCount
  };
}

// Execute if run directly
if (process.argv[1] && process.argv[1].endsWith('rooms_verification.test.js')) {
  runRoomsVerification();
}
