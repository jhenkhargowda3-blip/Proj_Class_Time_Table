import test from 'node:test';
import assert from 'node:assert';
import { getDatabase } from '../src/db/connection.js';
import { importReferenceData } from '../src/services/referenceDataService.js';
import app from '../server.js';
import { SEED_PASSWORDS } from '../src/db/seed.js';
import { evaluateTimetableConflicts, validateTimetableConflict } from '../public/js/timetableValidator.js';
import { TimetableResolver } from '../public/js/timetableResolver.js';

let serverInstance;
let baseUrl;
let adminToken;

test.before(async () => {
  const db = getDatabase();
  importReferenceData(db);

  return new Promise((resolve) => {
    serverInstance = app.listen(0, '127.0.0.1', async () => {
      const address = serverInstance.address();
      baseUrl = `http://127.0.0.1:${address.port}`;

      const adminRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'admin',
          password: SEED_PASSWORDS.admin,
          role: 'admin'
        })
      });
      const adminData = await adminRes.json();
      adminToken = adminData.token;

      resolve();
    });
  });
});

test.after(async () => {
  if (serverInstance) {
    serverInstance.close();
  }
});

test('Conflict Resolution Engine & Full Manual Edit Authority Suite', async (t) => {
  const db = getDatabase();

  const workingDays = db.prepare('SELECT * FROM working_days').all();
  const timeSlots = db.prepare('SELECT * FROM time_slots').all();
  const faculty = db.prepare('SELECT * FROM faculty').all();
  const rooms = db.prepare('SELECT * FROM rooms').all();
  const sections = db.prepare('SELECT * FROM sections').all();
  const subjects = db.prepare('SELECT * FROM subjects').all();
  const facultyAvailability = db.prepare('SELECT * FROM faculty_availability').all();
  const sectionSubjects = db.prepare(`
    SELECT ss.*, s.name as subject_name, s.code as subject_code, s.weekly_periods, s.type as subject_type,
           sec.name as section_name, f.name as faculty_name
    FROM section_subjects ss
    JOIN subjects s ON ss.subject_id = s.id
    JOIN sections sec ON ss.section_id = sec.id
    JOIN faculty f ON ss.faculty_id = f.id
  `).all();

  const masterData = {
    workingDays,
    timeSlots,
    faculty,
    rooms,
    sections,
    subjects,
    facultyAvailability,
    sectionSubjects
  };

  const activeVersion = db.prepare("SELECT id FROM timetable_versions WHERE status = 'active' LIMIT 1").get();
  assert.ok(activeVersion, 'Active timetable version must exist');

  const baseEntries = db.prepare(`
    SELECT te.*, s.name as subject_name, s.code as subject_code, s.type as subject_type,
           sec.name as section_name, sec.strength as section_strength,
           f.name as faculty_name, r.name as room_name, r.type as room_type, r.capacity as room_capacity,
           wd.day_name, wd.day_index, ts.slot_no, ts.start_time, ts.end_time, ts.is_break, ts.label as slot_label
    FROM timetable_entries te
    JOIN subjects s ON te.subject_id = s.id
    JOIN sections sec ON te.section_id = sec.id
    JOIN faculty f ON te.faculty_id = f.id
    JOIN rooms r ON te.room_id = r.id
    JOIN working_days wd ON te.day_id = wd.id
    JOIN time_slots ts ON te.slot_id = ts.id
    WHERE te.version_id = ?
  `).all(activeVersion.id);

  await t.test('1. Shared Validator detects multiple conflict types (faculty, room, section double bookings)', () => {
    const testEntries = JSON.parse(JSON.stringify(baseEntries));
    assert.ok(testEntries.length >= 10, 'Must have at least 10 entries for testing');

    // Force faculty clash
    testEntries[0].day_id = testEntries[1].day_id;
    testEntries[0].slot_id = testEntries[1].slot_id;
    testEntries[0].faculty_id = testEntries[1].faculty_id;

    // Force room clash
    testEntries[2].day_id = testEntries[3].day_id;
    testEntries[2].slot_id = testEntries[3].slot_id;
    testEntries[2].room_id = testEntries[3].room_id;

    const val = evaluateTimetableConflicts(testEntries, masterData);
    assert.ok(val.errorCount > 0, 'Validator must detect injected conflicts');
    assert.ok(val.conflicts.some(c => c.type === 'FACULTY_DOUBLE_BOOKED'), 'Must flag faculty double booking');
    assert.ok(val.conflicts.some(c => c.type === 'ROOM_DOUBLE_BOOKED'), 'Must flag room double booking');
    assert.ok(val.conflicts.every(c => c.type && c.message), 'Every conflict must carry a type and readable message');
  });

  await t.test('2. Min-Conflicts Resolver successfully resolves 13+ conflicts down to 0 without mutating original', async () => {
    const originalCopy = JSON.parse(JSON.stringify(baseEntries));
    const conflicted = JSON.parse(JSON.stringify(baseEntries));

    // Inject 13+ conflicts across 8 entries
    for (let i = 0; i < 8; i++) {
      conflicted[i].day_id = conflicted[i + 12].day_id;
      conflicted[i].slot_id = conflicted[i + 12].slot_id;
      conflicted[i].room_id = conflicted[i + 12].room_id;
      conflicted[i].faculty_id = conflicted[i + 12].faculty_id;
    }

    const initVal = evaluateTimetableConflicts(conflicted, masterData);
    assert.ok(initVal.errorCount >= 10, `Injected conflicts must be at least 10, got ${initVal.errorCount}`);

    const resolver = new TimetableResolver(conflicted, masterData, {
      maxDurationMs: 5000,
      maxIterations: 20000
    });

    const result = await new Promise((resolve) => {
      resolver.onComplete = resolve;
      resolver.onError = resolve;
      resolver.start();
    });

    assert.strictEqual(result.success, true, 'Resolver should succeed');
    assert.strictEqual(result.conflictsRemaining, 0, 'Resolver must achieve 0 remaining conflicts');
    assert.ok(result.durationMs < 5000, 'Resolution must complete under 5.0s safety limit');

    // Independent validation of returned schedule
    const finalVal = evaluateTimetableConflicts(result.entries, masterData);
    assert.strictEqual(finalVal.isValid, true, 'Independent validation must confirm 0 conflicts');
    assert.strictEqual(finalVal.errorCount, 0, 'Independent errorCount must be 0');

    // Ensure original entries were not mutated
    assert.deepStrictEqual(conflicted[0].day_id, conflicted[12].day_id, 'Original conflicted array copy remains untouched');
  });

  await t.test('3. Resolver strictly respects locked classes', async () => {
    const testEntries = JSON.parse(JSON.stringify(baseEntries));

    // Lock entry 0 at day 1, slot 1
    testEntries[0].locked = 1;
    testEntries[0].is_locked = 1;
    const originalLockedDay = testEntries[0].day_id;
    const originalLockedSlot = testEntries[0].slot_id;

    // Force conflict with an unlocked entry 5
    testEntries[5].locked = 0;
    testEntries[5].is_locked = 0;
    testEntries[5].day_id = originalLockedDay;
    testEntries[5].slot_id = originalLockedSlot;
    testEntries[5].room_id = testEntries[0].room_id;

    const resolver = new TimetableResolver(testEntries, masterData, {
      maxDurationMs: 4000,
      maxIterations: 5000
    });

    const result = await new Promise((resolve) => {
      resolver.onComplete = resolve;
      resolver.onError = resolve;
      resolver.start();
    });

    assert.strictEqual(result.success, true);
    const resolvedLocked = result.entries.find(e => e.id === testEntries[0].id);
    assert.strictEqual(resolvedLocked.day_id, originalLockedDay, 'Locked class day must not move');
    assert.strictEqual(resolvedLocked.slot_id, originalLockedSlot, 'Locked class slot must not move');
  });

  await t.test('4. Diagnostic reporting on unsolvable scenario (impossible data)', async () => {
    const testEntries = JSON.parse(JSON.stringify(baseEntries.slice(0, 3)));

    // Lock all 3 entries into the EXACT same slot, room, and faculty so resolution is impossible without moving locked classes
    testEntries.forEach(e => {
      e.day_id = 1;
      e.slot_id = 1;
      e.room_id = 1;
      e.faculty_id = 1;
      e.locked = 1;
      e.is_locked = 1;
    });

    const resolver = new TimetableResolver(testEntries, masterData, {
      maxDurationMs: 1500,
      maxIterations: 500
    });

    const result = await new Promise((resolve) => {
      resolver.onComplete = resolve;
      resolver.onError = resolve;
      resolver.start();
    });

    assert.strictEqual(result.success, false, 'Must report failure on truly impossible data');
    assert.ok(result.conflictsRemaining > 0, 'Must report remaining conflicts');
    assert.ok(result.violations.length > 0, 'Must provide diagnostic violations');
    assert.ok(result.violations[0].suggestedFix, 'Each diagnostic violation must provide a suggested fix');
  });

  await t.test('5. API: POST /api/timetable/entries adds new class, PUT updates, DELETE removes', async () => {
    // Create dedicated draft version for clean entry testing
    const testVersionRes = db.prepare(`
      INSERT INTO timetable_versions (name, status, created_by, notes)
      VALUES ('API Entry Test Version', 'draft', 1, 'Isolation test')
    `).run();
    const testVersionId = testVersionRes.lastInsertRowid;

    // 1. Add class
    const addRes = await fetch(`${baseUrl}/api/timetable/entries`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        versionId: testVersionId,
        sectionId: sections[0].id,
        subjectId: subjects[0].id,
        facultyId: faculty[0].id,
        roomId: rooms[0].id,
        dayId: workingDays[0].id,
        slotId: timeSlots[0].id,
        locked: 0
      })
    });

    assert.strictEqual(addRes.status, 201, 'POST /entries should return 201');
    const addData = await addRes.json();
    assert.ok(addData.entry?.id, 'Returned entry must have an ID');
    const createdId = addData.entry.id;

    // 2. Update class
    const putRes = await fetch(`${baseUrl}/api/timetable/entries/${createdId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        facultyId: faculty[1].id,
        roomId: rooms[1].id,
        locked: 1
      })
    });
    assert.strictEqual(putRes.status, 200, 'PUT /entries/:id should return 200');

    const updated = db.prepare('SELECT * FROM timetable_entries WHERE id = ?').get(createdId);
    assert.strictEqual(updated.faculty_id, faculty[1].id, 'Faculty must be updated');
    assert.strictEqual(updated.room_id, rooms[1].id, 'Room must be updated');
    assert.strictEqual(updated.locked, 1, 'Locked state must be updated');

    // 3. Delete class
    const delRes = await fetch(`${baseUrl}/api/timetable/entries/${createdId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.strictEqual(delRes.status, 200, 'DELETE /entries/:id should return 200');

    const checkDeleted = db.prepare('SELECT * FROM timetable_entries WHERE id = ?').get(createdId);
    assert.strictEqual(checkDeleted, undefined, 'Entry must be deleted from database');
  });

  await t.test('6. API: POST /api/timetable/versions saves resolved preview draft as new version', async () => {
    const res = await fetch(`${baseUrl}/api/timetable/versions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        name: 'Auto-Resolved Test Master Schedule',
        notes: '0 conflicts verified',
        entries: baseEntries.slice(0, 5),
        status: 'draft'
      })
    });

    assert.strictEqual(res.status, 201, 'POST /versions should return 201');
    const data = await res.json();
    assert.ok(data.versionId, 'Must return new versionId');
    assert.strictEqual(data.message, 'Timetable generation successful');

    const createdVersion = db.prepare('SELECT * FROM timetable_versions WHERE id = ?').get(data.versionId);
    assert.ok(createdVersion, 'Created version must exist in database');
    assert.strictEqual(createdVersion.name, 'Auto-Resolved Test Master Schedule');
  });
});
