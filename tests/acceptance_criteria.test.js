import test from 'node:test';
import assert from 'node:assert/strict';
import { getDatabase } from '../src/db/connection.js';
import { generateTimetable } from '../src/services/scheduler.js';
import { validateTimetable } from '../src/services/validator.js';
import {
  reportAbsence,
  findEligibleSubstitutes,
  assignSubstitution,
  reassignSubstitution,
  cancelSubstitution,
  autoAssignAllSubstitutions,
  getSubstitutionHistory,
  getAbsenceBoard
} from '../src/services/substitution.js';

test('Acceptance Suite: Timetable Generation & Absence Substitution', async (t) => {
  const db = getDatabase();

  await t.test('1. Master-data validation: Validates working days and slots', () => {
    const totalSlots = db.prepare("SELECT COUNT(*) as cnt FROM time_slots WHERE is_break = 0").get().cnt;
    const workingDays = db.prepare("SELECT COUNT(*) as cnt FROM working_days").get().cnt;
    assert.ok(totalSlots * workingDays > 0, 'Master data has defined working days and teaching periods');
  });

  let genResult;
  await t.test('2. Conflict-free generation: Solves CSP with zero hard conflicts', () => {
    genResult = generateTimetable({ name: 'Verification Timetable Run', adminUserId: 1 });
    assert.ok(genResult && genResult.versionId, 'Generated timetable version ID exists');
    assert.ok(genResult.entriesCount > 0, 'Generated collision-free entries');

    const validation = validateTimetable(genResult.versionId);
    assert.strictEqual(validation.errorCount, 0, '0 hard conflicts found');
  });

  await t.test('3. Studio display & view switcher data: Section, Faculty, and Room sets', () => {
    const entries = db.prepare('SELECT * FROM timetable_entries WHERE version_id = ?').all(genResult.versionId);
    const sectionsCovered = new Set(entries.map(e => e.section_id));
    const facultyCovered = new Set(entries.map(e => e.faculty_id));
    const roomsCovered = new Set(entries.map(e => e.room_id));
    assert.ok(sectionsCovered.size > 0, 'Entries grouped by Section');
    assert.ok(facultyCovered.size > 0, 'Entries grouped by Faculty');
    assert.ok(roomsCovered.size > 0, 'Entries grouped by Room');
  });

  await t.test('4. Manual edit & constraint violation detection', () => {
    const entries = db.prepare('SELECT * FROM timetable_entries WHERE version_id = ?').all(genResult.versionId);
    const mutatedEntries = entries.map(e => ({ ...e }));
    const entryA = mutatedEntries[0];
    const idxSameSlot = mutatedEntries.findIndex(e => e.id !== entryA.id && e.day_id === entryA.day_id && e.slot_id === entryA.slot_id);
    if (idxSameSlot !== -1) {
      mutatedEntries[idxSameSlot].faculty_id = entryA.faculty_id;
      const conflictValidation = validateTimetable(mutatedEntries);
      const hasFacultyDoubleBooked = conflictValidation.violations.some(v => v.code === 'FACULTY_DOUBLE_BOOKED');
      assert.ok(hasFacultyDoubleBooked, 'Hard constraint violation detected on double-booking');
    }
  });

  let activeVer;
  await t.test('5. Regeneration & Publish: New alternative version activated', () => {
    const regenResult = generateTimetable({ name: 'Regenerated Schedule', regenerate: true, adminUserId: 1 });
    assert.ok(regenResult && regenResult.versionId !== genResult.versionId, 'Alternative version ID created');

    db.prepare("UPDATE timetable_versions SET status = 'archived' WHERE status = 'active'").run();
    db.prepare("UPDATE timetable_versions SET status = 'active' WHERE id = ?").run(regenResult.versionId);
    activeVer = db.prepare("SELECT * FROM timetable_versions WHERE status = 'active'").get();
    assert.strictEqual(activeVer.id, regenResult.versionId, 'New version successfully published and set as active');
  });

  let testClass;
  const testDate = '2026-11-09';
  await t.test('6. Report absence & affected classes flagged', () => {
    testClass = db.prepare(`
      SELECT te.*, f.id as fac_id, f.name as fac_name
      FROM timetable_entries te
      JOIN faculty f ON te.faculty_id = f.id
      WHERE te.version_id = ? AND te.day_id = 1
      LIMIT 1
    `).get(activeVer.id);
    assert.ok(testClass, 'Found scheduled class for testing absence');

    const absenceReport = reportAbsence({
      facultyId: testClass.fac_id,
      date: testDate,
      type: 'absent',
      reason: 'Conference attendance',
      reportedByUserId: 1
    });
    assert.ok(absenceReport && absenceReport.affectedClasses?.length > 0, 'Affected classes marked pending substitute');
  });

  let candidates;
  await t.test('7. Ranked substitute candidates computed by heuristic score', () => {
    candidates = findEligibleSubstitutes(testClass.id, testDate);
    assert.ok(Array.isArray(candidates), 'Candidates list returned');
    assert.ok(candidates.length > 0, 'Found eligible substitute candidate(s)');
    assert.ok(candidates[0].score >= candidates[candidates.length - 1].score, 'Candidates ranked by score');
  });

  let assignResult;
  await t.test('8. Substitution assignment & cover duty reflection', () => {
    const chosenCandidate = candidates[0];
    assignResult = assignSubstitution({
      timetableEntryId: testClass.id,
      dateStr: testDate,
      substituteFacultyId: chosenCandidate.facultyId,
      adminUserId: 1
    });
    assert.ok(assignResult && assignResult.substitutionId, 'Assigned substitute');

    const board = getAbsenceBoard(testDate);
    const affectedSlot = board.flatMap(b => b.affectedClasses).find(ac => ac.timetable_entry_id === testClass.id);
    assert.ok(affectedSlot && (affectedSlot.sub_status === 'assigned' || affectedSlot.sub_status === 'accepted'), 'Covered on absence board');
  });

  await t.test('9. Reassign, cancel, and auto-assign all pending', () => {
    if (candidates.length > 1) {
      const altCandidate = candidates[1];
      const reassignRes = reassignSubstitution({
        substitutionId: assignResult.substitutionId,
        substituteFacultyId: altCandidate.facultyId,
        adminUserId: 1
      });
      assert.strictEqual(reassignRes.substituteFacultyId, altCandidate.facultyId, 'Reassigned substitute');
    }

    const cancelRes = cancelSubstitution({
      substitutionId: assignResult.substitutionId,
      adminUserId: 1
    });
    assert.strictEqual(cancelRes.status, 'requested', 'Substitution reset to requested state');

    const autoAssignRes = autoAssignAllSubstitutions({
      dateStr: testDate,
      adminUserId: 1
    });
    assert.ok(autoAssignRes.assignedCount >= 1, 'Auto-assigned pending substitutions');

    const history = getSubstitutionHistory(10);
    assert.ok(history && history.length > 0, 'Substitution history logged');
  });
});
