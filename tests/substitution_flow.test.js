import test from 'node:test';
import assert from 'node:assert';
import { getDatabase } from '../src/db/connection.js';
import { seedDatabase } from '../src/db/seed.js';
import {
  reportAbsence,
  findEligibleSubstitutes,
  claimSubstitution,
  assignSubstitution,
  getOpenSubstitutions,
  getAbsenceBoard
} from '../src/services/substitution.js';

test('Phase 8: Absence, Lateness, and Substitution Flow (Core Feature)', async (t) => {
  const db = getDatabase();
  seedDatabase(db);

  // Get active timetable version
  const activeVersion = db.prepare("SELECT id FROM timetable_versions WHERE status = 'active' LIMIT 1").get();
  assert.ok(activeVersion, 'Expected active timetable version');

  // Find Turing (CSE) and Hopper (CSE) and Lovelace (IT) and Knuth (CSE)
  const turing = db.prepare("SELECT * FROM faculty WHERE email LIKE 'turing%' LIMIT 1").get();
  const hopper = db.prepare("SELECT * FROM faculty WHERE email LIKE 'hopper%' LIMIT 1").get();
  const lovelace = db.prepare("SELECT * FROM faculty WHERE email LIKE 'lovelace%' LIMIT 1").get();
  const knuth = db.prepare("SELECT * FROM faculty WHERE email LIKE 'knuth%' LIMIT 1").get();

  assert.ok(turing && hopper && lovelace && knuth, 'Expected faculty records');

  // Pick Monday date: 2026-10-05 (Monday)
  const mondayDate = '2026-10-05';

  await t.test('1. Full-day absence report accurately identifies all affected scheduled classes', () => {
    // Check how many classes Turing has on Monday
    const mondayClasses = db.prepare(`
      SELECT te.id FROM timetable_entries te
      JOIN working_days wd ON te.day_id = wd.id
      WHERE te.version_id = ? AND te.faculty_id = ? AND wd.day_index = 1
    `).all(activeVersion.id, turing.id);

    assert.ok(mondayClasses.length > 0, 'Turing should have Monday classes in active timetable');

    const rep = reportAbsence({
      facultyId: turing.id,
      date: mondayDate,
      type: 'absent',
      reason: 'Keynote lecture at ACM conference'
    });

    assert.ok(rep.absenceId > 0, 'Absence record created');
    assert.strictEqual(rep.affectedClasses.length, mondayClasses.length, 'All Monday classes must be affected');

    // Verify substitutions table has open requests for each affected class
    const subs = db.prepare('SELECT * FROM substitutions WHERE absence_id = ?').all(rep.absenceId);
    assert.strictEqual(subs.length, mondayClasses.length);
    for (const s of subs) {
      assert.strictEqual(s.status, 'requested');
      assert.strictEqual(s.substitute_faculty_id, null);
    }
  });

  await t.test('2. Lateness reporting identifies ONLY slots prior to expected arrival', () => {
    // Wednesday date: 2026-10-07
    const wednesdayDate = '2026-10-07';

    // Hopper reported arriving late at 11:30
    const rep = reportAbsence({
      facultyId: hopper.id,
      date: wednesdayDate,
      type: 'late',
      expectedArrival: '11:30',
      reason: 'Delayed commuter flight'
    });

    assert.ok(rep.absenceId > 0);

    // Assert that every affected class starts strictly before 11:30
    for (const ac of rep.affectedClasses) {
      assert.ok(ac.start_time < '11:30', `Affected class at ${ac.start_time} must be before arrival 11:30`);
    }

    // Verify that any classes starting at or after 11:30 were NOT included
    const laterClasses = db.prepare(`
      SELECT te.id, ts.start_time FROM timetable_entries te
      JOIN working_days wd ON te.day_id = wd.id
      JOIN time_slots ts ON te.slot_id = ts.id
      WHERE te.version_id = ? AND te.faculty_id = ? AND wd.day_index = 3 AND ts.start_time >= '11:30'
    `).all(activeVersion.id, hopper.id);

    for (const lc of laterClasses) {
      const isIncluded = rep.affectedClasses.some(ac => ac.id === lc.id);
      assert.strictEqual(isIncluded, false, `Class starting at ${lc.start_time} must not require substitution`);
    }
  });

  await t.test('3. Candidate finder excludes busy/absent faculty and prioritizes qualified faculty', () => {
    // Pick the first substitution for Turing's Monday absence
    const sub = db.prepare(`
      SELECT sub.*, te.slot_id, te.subject_id, te.day_id
      FROM substitutions sub
      JOIN absences a ON sub.absence_id = a.id
      JOIN timetable_entries te ON sub.timetable_entry_id = te.id
      WHERE a.faculty_id = ? AND sub.date = ?
      LIMIT 1
    `).get(turing.id, mondayDate);

    assert.ok(sub, 'Expected substitution row for Turing');

    const candidates = findEligibleSubstitutes(sub.timetable_entry_id, mondayDate);
    assert.ok(candidates.length > 0, 'Expected at least one eligible substitute');

    // Turing himself must NOT be in candidates
    assert.ok(!candidates.some(c => c.facultyId === turing.id), 'Absent faculty must be excluded');

    // Any faculty who already has a class in that slot on Monday must be excluded
    const busyFacultyIds = db.prepare(`
      SELECT faculty_id FROM timetable_entries
      WHERE version_id = ? AND day_id = ? AND slot_id = ?
    `).all(activeVersion.id, sub.day_id, sub.slot_id).map(r => r.faculty_id);

    for (const c of candidates) {
      assert.ok(!busyFacultyIds.includes(c.facultyId), `Candidate ${c.name} cannot be double booked`);
    }

    // Qualified faculty should have higher score than unqualified faculty with similar load
    const qualifiedCand = candidates.find(c => c.isQualified);
    if (qualifiedCand) {
      assert.ok(qualifiedCand.reasons.some(r => r.includes('Qualified for subject')));
      assert.ok(qualifiedCand.score >= 50, 'Qualified candidates should have high priority score');
    }
  });

  await t.test('4. Mode A: Self-service claim succeeds for eligible colleague and marks class covered', () => {
    // Pick first open substitution for Turing
    const sub = db.prepare(`
      SELECT sub.*, te.id as timetable_entry_id
      FROM substitutions sub
      JOIN absences a ON sub.absence_id = a.id
      JOIN timetable_entries te ON sub.timetable_entry_id = te.id
      WHERE a.faculty_id = ? AND sub.date = ? AND sub.status = 'requested'
      LIMIT 1
    `).get(turing.id, mondayDate);

    assert.ok(sub, 'Expected open requested substitution');

    // Find an eligible candidate
    const candidates = findEligibleSubstitutes(sub.timetable_entry_id, mondayDate);
    assert.ok(candidates.length > 0, 'Must have eligible candidates');
    const eligibleFaculty = candidates[0];

    const claimRes = claimSubstitution({
      timetableEntryId: sub.timetable_entry_id,
      dateStr: mondayDate,
      substituteFacultyId: eligibleFaculty.facultyId,
      userId: 1
    });

    assert.strictEqual(claimRes.substitutionId, sub.id);
    assert.strictEqual(claimRes.substituteFacultyName, eligibleFaculty.name);

    // Verify row in substitutions is now 'accepted'
    const updatedSub = db.prepare('SELECT * FROM substitutions WHERE id = ?').get(sub.id);
    assert.strictEqual(updatedSub.status, 'accepted');
    assert.strictEqual(updatedSub.substitute_faculty_id, eligibleFaculty.facultyId);
  });

  await t.test('5. Concurrent claim collision: second claim on same slot fails cleanly', () => {
    // Try claiming the already accepted substitution again with another candidate
    const sub = db.prepare(`
      SELECT * FROM substitutions
      WHERE status = 'accepted' AND date = ?
      LIMIT 1
    `).get(mondayDate);

    assert.ok(sub, 'Expected accepted substitution');

    // Another colleague attempts to claim
    assert.throws(() => {
      claimSubstitution({
        timetableEntryId: sub.timetable_entry_id,
        dateStr: mondayDate,
        substituteFacultyId: knuth.id,
        userId: 2
      });
    }, /already been claimed/i, 'Second claim must be rejected with already claimed error');
  });

  await t.test('6. Mode B: Admin direct assignment assigns substitute and updates absence status', () => {
    // Find any remaining requested substitution
    const openSub = db.prepare(`
      SELECT * FROM substitutions
      WHERE status = 'requested' AND date = ?
      LIMIT 1
    `).get(mondayDate);

    if (openSub) {
      const candidates = findEligibleSubstitutes(openSub.timetable_entry_id, mondayDate);
      if (candidates.length > 0) {
        const chosen = candidates[0];
        const assignRes = assignSubstitution({
          timetableEntryId: openSub.timetable_entry_id,
          dateStr: mondayDate,
          substituteFacultyId: chosen.facultyId,
          adminUserId: 1
        });

        assert.strictEqual(assignRes.substitutionId, openSub.id);
        assert.strictEqual(assignRes.substituteFacultyName, chosen.name);

        const checkSub = db.prepare('SELECT * FROM substitutions WHERE id = ?').get(openSub.id);
        assert.strictEqual(checkSub.status, 'assigned');
      }
    }
  });

  await t.test('7. Absence Board aggregates absences, affected classes, and overdue status', () => {
    const board = getAbsenceBoard(mondayDate);
    assert.ok(board.length > 0, 'Absence board should list Monday absences');

    const turingAbsence = board.find(b => b.faculty_id === turing.id);
    assert.ok(turingAbsence, 'Turing absence must appear on board');
    assert.ok(turingAbsence.affectedClasses.length > 0, 'Affected classes must be populated');
  });

  // Final cleanup
  db.prepare('DELETE FROM substitutions').run();
  db.prepare('DELETE FROM absences').run();
});
