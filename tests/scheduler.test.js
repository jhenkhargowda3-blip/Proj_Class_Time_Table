import test from 'node:test';
import assert from 'node:assert';
import { generateTimetable } from '../src/services/scheduler.js';
import { validateTimetable } from '../src/services/validator.js';
import { getDatabase } from '../src/db/connection.js';
import { seedDatabase } from '../src/db/seed.js';

test('Phase 4: Scheduling Engine (CSP Solver & Optimizer)', async (t) => {
  const db = getDatabase();
  seedDatabase(db, { includeDemo: true });

  await t.test('1. Solves and generates complete conflict-free draft in under 20s', () => {
    const start = Date.now();
    const result = generateTimetable({
      name: 'Automated Test Draft 1',
      maxDurationMs: 20000,
      maxAttempts: 3
    });

    const elapsed = Date.now() - start;
    assert.strictEqual(result.success, true);
    assert.ok(result.versionId > 0, 'Expected generated version ID');
    assert.ok(result.entriesCount > 0, 'Expected positive entry count');
    assert.ok(elapsed < 20000, `Expected generation under 20s, took ${elapsed}ms`);

    // Verify 0 hard errors in validator
    const validation = validateTimetable(result.versionId);
    assert.strictEqual(validation.isValid, true);
    assert.strictEqual(validation.errorCount, 0);
  });

  await t.test('2. Lab block continuity constraint is respected', () => {
    // Check that every lab entry has an adjacent contiguous slot companion
    const result = generateTimetable({
      name: 'Automated Test Draft 2',
      maxDurationMs: 20000,
      maxAttempts: 2
    });

    assert.strictEqual(result.success, true);

    const labEntries = db.prepare(`
      SELECT te.*, s.type, s.code, ts.slot_no, ts.is_break
      FROM timetable_entries te
      JOIN subjects s ON te.subject_id = s.id
      JOIN time_slots ts ON te.slot_id = ts.id
      WHERE te.version_id = ? AND s.type = 'lab'
      ORDER BY te.section_id, te.day_id, ts.slot_no
    `).all(result.versionId);

    assert.ok(labEntries.length > 0, 'Expected lab entries in generated schedule');

    // Group by section & day
    const grouped = {};
    for (const e of labEntries) {
      const k = `${e.section_id}_${e.day_id}_${e.subject_id}`;
      grouped[k] = grouped[k] || [];
      grouped[k].push(e);
    }

    for (const k in grouped) {
      const items = grouped[k];
      assert.strictEqual(items.length % 2, 0, 'Lab entries must occur in pairs');
      for (let i = 0; i < items.length; i += 2) {
        const slot1 = items[i].slot_no;
        const slot2 = items[i + 1].slot_no;
        assert.strictEqual(slot2 - slot1, 1, 'Lab slots must be contiguous without breaks');
      }
    }
  });

  await t.test('3. Detects infeasible requests upfront', () => {
    // Insert an impossible subject requirement (99 periods for 1 section)
    const impossibleDept = db.prepare('SELECT id FROM departments LIMIT 1').get().id;
    const impossibleSub = db.prepare(`
      INSERT INTO subjects (code, name, type, weekly_periods, lab_block_length, department_id, semester)
      VALUES ('IMP999', 'Impossible Heavy Subject', 'theory', 99, 1, ?, 4)
    `).run(impossibleDept);

    const sec = db.prepare('SELECT id FROM sections LIMIT 1').get();
    const fac = db.prepare('SELECT id FROM faculty LIMIT 1').get();

    db.prepare(`
      INSERT INTO section_subjects (section_id, subject_id, faculty_id)
      VALUES (?, ?, ?)
    `).run(sec.id, impossibleSub.lastInsertRowid, fac.id);

    const infeasibleResult = generateTimetable();
    assert.strictEqual(infeasibleResult.success, false);
    assert.strictEqual(infeasibleResult.infeasible, true);
    assert.ok(infeasibleResult.reason.includes('requires'));

    // Clean up temporary impossible subject
    db.prepare('DELETE FROM section_subjects WHERE subject_id = ?').run(impossibleSub.lastInsertRowid);
    db.prepare('DELETE FROM subjects WHERE id = ?').run(impossibleSub.lastInsertRowid);
  });
});
