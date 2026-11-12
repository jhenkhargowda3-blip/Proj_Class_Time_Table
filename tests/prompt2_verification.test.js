import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { getDatabase } from '../src/db/connection.js';
import { importReferenceData } from '../src/services/referenceDataService.js';
import { validateTimetable } from '../src/services/validator.js';
import { evaluateTimetableConflicts } from '../public/js/timetableValidator.js';
import { generateDraftWithConflicts } from '../src/services/scheduler.js';
import { TimetableResolver } from '../public/js/timetableResolver.js';

describe('Prompt 2 Verification Suite: Conflict-Free Imported Timetable & Dynamic Conflict Detection', () => {
  let db;
  let importedVersionId;
  let initialSessionsDigest;
  let initialEntriesDigest;
  let masterData;

  function computeDigest(data) {
    return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
  }

  before(() => {
    db = getDatabase();
    // Ensure reference data is cleanly imported
    importReferenceData(db);

    const activeVer = db.prepare("SELECT * FROM timetable_versions WHERE source = 'imported_verified' OR status = 'active' ORDER BY id ASC LIMIT 1").get();
    assert(activeVer, 'Active/imported version should exist');
    importedVersionId = activeVer.id;

    // Snapshot baseline sessions and entries
    const sessions = db.prepare('SELECT * FROM faculty_sessions ORDER BY id ASC').all();
    const entries = db.prepare('SELECT * FROM timetable_entries WHERE version_id = ? ORDER BY id ASC').all(importedVersionId);

    initialSessionsDigest = computeDigest(sessions);
    initialEntriesDigest = computeDigest(entries);

    const workingDays = db.prepare('SELECT * FROM working_days').all();
    const timeSlots = db.prepare('SELECT * FROM time_slots').all();
    const faculty = db.prepare('SELECT * FROM faculty').all();
    const rooms = db.prepare('SELECT * FROM rooms').all();
    const sections = db.prepare('SELECT * FROM sections').all();
    const subjects = db.prepare('SELECT * FROM subjects').all();
    const facultyAvailability = db.prepare('SELECT * FROM faculty_availability').all();
    const sectionSubjects = db.prepare('SELECT * FROM section_subjects').all();

    masterData = {
      workingDays,
      timeSlots,
      faculty,
      rooms,
      sections,
      subjects,
      facultyAvailability,
      sectionSubjects
    };
  });

  test('Test 1: Violations on imported version (expected 0 new)', () => {
    // 1a. Server-side validator
    const serverResult = validateTimetable(importedVersionId);
    console.log(`[Test 1 Server Result] isValid: ${serverResult.isValid}, errorCount: ${serverResult.errorCount}, warningCount: ${serverResult.warningCount}`);
    assert.strictEqual(serverResult.errorCount, 0, 'Server-side validator must report 0 errors on imported version');

    // 1b. Client-side validator (used in Studio Grid and Header)
    const entries = db.prepare(`
      SELECT te.*, s.name as subject_name, s.code as subject_code, s.type as subject_type, s.lab_block_length, s.weekly_periods,
             sec.name as section_name, sec.strength as section_strength, sec.batches as batches,
             f.name as faculty_name, f.max_periods_per_day,
             r.name as room_name, r.type as room_type, r.capacity as room_capacity,
             wd.day_name, ts.slot_no, ts.label as slot_label, ts.is_break
      FROM timetable_entries te
      JOIN subjects s ON te.subject_id = s.id
      JOIN sections sec ON te.section_id = sec.id
      JOIN faculty f ON te.faculty_id = f.id
      JOIN rooms r ON te.room_id = r.id
      JOIN working_days wd ON te.day_id = wd.id
      JOIN time_slots ts ON te.slot_id = ts.id
      WHERE te.version_id = ?
    `).all(importedVersionId);

    const clientResult = evaluateTimetableConflicts(entries, masterData, {
      isImportedBaseline: true,
      baselineFingerprint: []
    });
    console.log(`[Test 1 Client Result] isValid: ${clientResult.isValid}, errorCount: ${clientResult.errorCount}, warningCount: ${clientResult.warningCount}`);
    assert.strictEqual(clientResult.errorCount, 0, 'Client-side validator must report 0 errors on imported version');
  });

  test('Test 2: After moving one class onto an occupied room, count increases by exactly the new clash', () => {
    const entries = db.prepare(`
      SELECT te.*, s.name as subject_name, s.code as subject_code, s.type as subject_type, s.lab_block_length, s.weekly_periods,
             sec.name as section_name, sec.strength as section_strength, sec.batches as batches,
             f.name as faculty_name, f.max_periods_per_day,
             r.name as room_name, r.type as room_type, r.capacity as room_capacity,
             wd.day_name, ts.slot_no, ts.label as slot_label, ts.is_break
      FROM timetable_entries te
      JOIN subjects s ON te.subject_id = s.id
      JOIN sections sec ON te.section_id = sec.id
      JOIN faculty f ON te.faculty_id = f.id
      JOIN rooms r ON te.room_id = r.id
      JOIN working_days wd ON te.day_id = wd.id
      JOIN time_slots ts ON te.slot_id = ts.id
      WHERE te.version_id = ?
    `).all(importedVersionId);

    // Baseline count
    const baseline = evaluateTimetableConflicts(entries, masterData, { baselineFingerprint: [] });
    assert.strictEqual(baseline.errorCount, 0, 'Baseline error count is 0');

    // Find two entries at the same day and slot in DIFFERENT classrooms (theory)
    const candidates = [];
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const e1 = entries[i];
        const e2 = entries[j];
        if (e1.day_id === e2.day_id && e1.slot_id === e2.slot_id && e1.room_id !== e2.room_id && e1.faculty_id !== e2.faculty_id && e1.subject_type === 'theory' && e2.subject_type === 'theory') {
          candidates.push({ e1, e2 });
          break;
        }
      }
      if (candidates.length > 0) break;
    }

    assert(candidates.length > 0, 'Found pair of distinct theory entries in different rooms at same slot');
    const { e1, e2 } = candidates[0];

    // Create clash by moving e1 into e2's room
    const clashedEntries = entries.map(e => {
      if (e.id === e1.id) {
        return {
          ...e,
          room_id: e2.room_id,
          room_name: e2.room_name,
          room_type: e2.room_type,
          room_capacity: e2.room_capacity
        };
      }
      return { ...e };
    });

    const clashedResult = evaluateTimetableConflicts(clashedEntries, masterData, {
      isGeneratingOrEditing: true,
      baselineFingerprint: []
    });

    console.log(`[Test 2 Result] Baseline errors: ${baseline.errorCount} -> Clashed errors: ${clashedResult.errorCount}`);
    const roomClashes = clashedResult.conflicts.filter(c => c.type === 'ROOM_DOUBLE_BOOKED');
    console.log(`[Test 2 Result] Room double-booked clashes created: ${roomClashes.length}`);

    assert.strictEqual(clashedResult.errorCount, 1, 'Error count must increase by exactly 1 clash');
    assert.strictEqual(roomClashes.length, 1, 'Exactly one ROOM_DOUBLE_BOOKED clash occurred');
  });

  test('Test 3: After undo, back to 0', () => {
    const entries = db.prepare(`
      SELECT te.*, s.name as subject_name, s.code as subject_code, s.type as subject_type, s.lab_block_length, s.weekly_periods,
             sec.name as section_name, sec.strength as section_strength, sec.batches as batches,
             f.name as faculty_name, f.max_periods_per_day,
             r.name as room_name, r.type as room_type, r.capacity as room_capacity,
             wd.day_name, ts.slot_no, ts.label as slot_label, ts.is_break
      FROM timetable_entries te
      JOIN subjects s ON te.subject_id = s.id
      JOIN sections sec ON te.section_id = sec.id
      JOIN faculty f ON te.faculty_id = f.id
      JOIN rooms r ON te.room_id = r.id
      JOIN working_days wd ON te.day_id = wd.id
      JOIN time_slots ts ON te.slot_id = ts.id
      WHERE te.version_id = ?
    `).all(importedVersionId);

    // Save undo snapshot
    const undoSnapshot = JSON.parse(JSON.stringify(entries));

    // Simulate move that creates conflict
    const modified = JSON.parse(JSON.stringify(entries));
    modified[0].room_id = modified[1].room_id;
    modified[0].room_name = modified[1].room_name;
    modified[0].day_id = modified[1].day_id;
    modified[0].slot_id = modified[1].slot_id;

    const clashed = evaluateTimetableConflicts(modified, masterData, {
      isGeneratingOrEditing: true,
      baselineFingerprint: []
    });
    assert(clashed.errorCount > 0, 'Modified timetable has conflicts');

    // Simulate Undo restoring undoSnapshot
    const restored = undoSnapshot;
    const restoredResult = evaluateTimetableConflicts(restored, masterData, {
      isImportedBaseline: true,
      baselineFingerprint: []
    });

    console.log(`[Test 3 Result] After undo restored, errorCount: ${restoredResult.errorCount}`);
    assert.strictEqual(restoredResult.errorCount, 0, 'Error count must return to exactly 0 after undo');
  });

  test('Test 4: Generate New on a copy shows conflicts and the resolver reduces them', async () => {
    // Generate new draft copy
    const draftRes = generateDraftWithConflicts({
      name: 'Test Draft for Resolver',
      createdBy: 1
    });

    assert(draftRes.versionId, 'Generated draft version ID should exist');
    assert(draftRes.conflictCount > 0, 'Generated draft should exhibit conflicts on creation');
    console.log(`[Test 4 Draft Created] Version ID: ${draftRes.versionId}, Initial conflicts: ${draftRes.conflictCount}`);

    const draftEntries = db.prepare(`
      SELECT te.*, s.name as subject_name, s.code as subject_code, s.type as subject_type, s.lab_block_length, s.weekly_periods,
             sec.name as section_name, sec.strength as section_strength, sec.batches as batches,
             f.name as faculty_name, f.max_periods_per_day,
             r.name as room_name, r.type as room_type, r.capacity as room_capacity,
             wd.day_name, ts.slot_no, ts.label as slot_label, ts.is_break
      FROM timetable_entries te
      JOIN subjects s ON te.subject_id = s.id
      JOIN sections sec ON te.section_id = sec.id
      JOIN faculty f ON te.faculty_id = f.id
      JOIN rooms r ON te.room_id = r.id
      JOIN working_days wd ON te.day_id = wd.id
      JOIN time_slots ts ON te.slot_id = ts.id
      WHERE te.version_id = ?
    `).all(draftRes.versionId);

    // Run resolver heuristic on copy
    const initialValidation = evaluateTimetableConflicts(draftEntries, masterData, { isGeneratingOrEditing: true });
    const initialErrors = initialValidation.errorCount;
    assert(initialErrors > 0, 'Initial error count should be > 0');

    const resolver = new TimetableResolver(draftEntries, masterData, {
      validator: (entries) => evaluateTimetableConflicts(entries, masterData, { isGeneratingOrEditing: true }),
      maxDurationMs: 4000,
      maxIterations: 1000,
      stepDelayMs: 0
    });

    const resolveResult = await resolver.solve();
    console.log(`[Test 4 Resolver Result] Initial errors: ${initialErrors} -> Resolved errors: ${resolveResult.remainingConflicts}, Steps executed: ${resolveResult.stepsExecuted}`);

    assert(resolveResult.remainingConflicts < initialErrors, 'Resolver must reduce the number of conflicts');
  });

  test('Test 5: Imported version sessions are byte-identical afterwards', () => {
    const currentSessions = db.prepare('SELECT * FROM faculty_sessions ORDER BY id ASC').all();
    const currentEntries = db.prepare('SELECT * FROM timetable_entries WHERE version_id = ? ORDER BY id ASC').all(importedVersionId);

    const currentSessionsDigest = computeDigest(currentSessions);
    const currentEntriesDigest = computeDigest(currentEntries);

    console.log(`[Test 5 Sessions SHA-256] Initial: ${initialSessionsDigest} == Current: ${currentSessionsDigest}`);
    console.log(`[Test 5 Entries SHA-256]  Initial: ${initialEntriesDigest} == Current: ${currentEntriesDigest}`);

    assert.strictEqual(currentSessionsDigest, initialSessionsDigest, 'faculty_sessions table must be byte-identical');
    assert.strictEqual(currentEntriesDigest, initialEntriesDigest, 'Imported timetable_entries must be byte-identical');
  });
});
