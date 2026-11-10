import test from 'node:test';
import assert from 'node:assert';
import { getDatabase } from '../src/db/connection.js';
import { seedDatabase } from '../src/db/seed.js';
import { getFacultyCalendar, getFacultyDaySchedule } from '../src/services/calendar.js';

test('Phase 7: Faculty Module and Calendar Logic', async (t) => {
  const db = getDatabase();
  seedDatabase(db);
  db.prepare('DELETE FROM substitutions').run();
  db.prepare('DELETE FROM absences').run();

  // Find Turing (faculty1)
  const turing = db.prepare("SELECT id, name FROM faculty WHERE email LIKE 'turing%' LIMIT 1").get();
  assert.ok(turing, 'Expected Dr. Alan Turing in database');

  // Find Knuth (faculty3)
  const knuth = db.prepare("SELECT id, name FROM faculty WHERE email LIKE 'knuth%' LIMIT 1").get();
  assert.ok(knuth, 'Expected Prof. Donald Knuth in database');

  await t.test('1. Calendar date mapping accurately reflects active timetable entries', () => {
    // Check October 2026 calendar (month 9 in 0-indexed JS Date)
    const cal = getFacultyCalendar(turing.id, 2026, 9);
    assert.strictEqual(cal.year, 2026);
    assert.strictEqual(cal.month, 9);
    assert.strictEqual(cal.days.length, 31);

    // Find a Monday in Oct 2026 (e.g. 2026-10-05 or 2026-10-12)
    const monday = cal.days.find(d => d.dayOfWeek === 1);
    assert.ok(monday, 'Expected Monday in October 2026');
    assert.strictEqual(monday.colorClass, 'green', 'Teaching day must follow green-present convention');
    assert.ok(monday.classesCount > 0, 'Expected Turing to have scheduled Monday classes');
  });

  await t.test('2. Holidays are recognized and marked grey', () => {
    // 2026-01-26 was seeded as Republic Day holiday
    const cal = getFacultyCalendar(turing.id, 2026, 0); // January 2026
    const holidayDay = cal.days.find(d => d.date === '2026-01-26');
    assert.ok(holidayDay, 'Expected Jan 26 in calendar');
    assert.strictEqual(holidayDay.status, 'holiday');
    assert.strictEqual(holidayDay.colorClass, 'grey');
    assert.strictEqual(holidayDay.holidayDesc, 'Republic Day');
    assert.strictEqual(holidayDay.classes.length, 0, 'No regular classes should be scheduled on a holiday');
  });

  await t.test('3. Absence and Lateness overlay alters day status to soft-red / amber', () => {
    const testDate = '2026-10-27';

    // Insert mock absence for Turing
    db.prepare(`
      INSERT INTO absences (faculty_id, date, type, reason, status)
      VALUES (?, ?, 'absent', 'Medical leave', 'open')
    `).run(turing.id, testDate);

    const calAfterAbsence = getFacultyCalendar(turing.id, 2026, 9);
    const absentDay = calAfterAbsence.days.find(d => d.date === testDate);

    assert.strictEqual(absentDay.status, 'absent');
    assert.strictEqual(absentDay.colorClass, 'soft-red');
    assert.strictEqual(absentDay.absence.reason, 'Medical leave');

    // Clean up mock absence
    db.prepare('DELETE FROM absences WHERE faculty_id = ? AND date = ?').run(turing.id, testDate);
  });
  await t.test('4. Accepted substitution reflects on both absent and substitute faculty schedules', () => {
    // Find an active class of Turing where Knuth is free
    const turingEntry = db.prepare(`
      SELECT te.id, te.day_id, te.slot_id, wd.day_index FROM timetable_entries te
      JOIN timetable_versions tv ON te.version_id = tv.id AND tv.status = 'active'
      JOIN working_days wd ON te.day_id = wd.id
      WHERE te.faculty_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM timetable_entries ke
          WHERE ke.version_id = te.version_id
            AND ke.faculty_id = ?
            AND ke.day_id = te.day_id
            AND ke.slot_id = te.slot_id
        )
      LIMIT 1
    `).get(turing.id, knuth.id);

    assert.ok(turingEntry, 'Expected active timetable entry for Turing where Knuth is free');

    // Pick a date in Oct 2026 with matching day_index (1=Mon..6=Sat). Oct 4, 2026 is Sunday (0).
    const dayOfMonth = 4 + turingEntry.day_index;
    const subDate = `2026-10-${String(dayOfMonth).padStart(2, '0')}`;

    // 1. Create absence for Turing on that matching day
    const absRes = db.prepare(`
      INSERT INTO absences (faculty_id, date, type, reason, status)
      VALUES (?, ?, 'absent', 'Attending academic conference', 'covered')
    `).run(turing.id, subDate);

    const absenceId = absRes.lastInsertRowid;

    // 2. Assign Knuth as substitute
    db.prepare(`
      INSERT INTO substitutions (absence_id, timetable_entry_id, date, substitute_faculty_id, status)
      VALUES (?, ?, ?, ?, 'accepted')
    `).run(absenceId, turingEntry.id, subDate, knuth.id);

    // 3. Inspect Turing's day schedule: should show covered by Knuth
    const turingDay = getFacultyDaySchedule(turing.id, subDate);
    const coveredClass = turingDay.schedule.find(s => s.id === turingEntry.id);
    assert.ok(coveredClass, 'Expected scheduled entry in Turing schedule');
    assert.strictEqual(coveredClass.isCoveredByColleague, true);
    assert.strictEqual(coveredClass.substituteFacultyName, knuth.name);

    // 4. Inspect Knuth's day schedule: should show class as substitute duty
    const knuthDay = getFacultyDaySchedule(knuth.id, subDate);
    const knuthCoveredClass = knuthDay.schedule.find(s => s.id === turingEntry.id);
    assert.ok(knuthCoveredClass, 'Expected substitute class in Knuth schedule');
    assert.strictEqual(knuthCoveredClass.isSubstituteDuty, true);
    assert.strictEqual(knuthCoveredClass.originalFacultyName, turing.name);

    // Clean up
    db.prepare('DELETE FROM substitutions WHERE absence_id = ?').run(absenceId);
    db.prepare('DELETE FROM absences WHERE id = ?').run(absenceId);
  });

  await t.test('5. Day schedule clearly distinguishes free periods for substitution', () => {
    const daySchedule = getFacultyDaySchedule(turing.id, '2026-10-19'); // Monday
    assert.ok(daySchedule.schedule.length >= 9, 'Expected 9 slots (7 periods + 2 breaks)');

    const freeSlots = daySchedule.schedule.filter(s => s.isFree);
    assert.ok(freeSlots.length > 0, 'Expected free slots in day schedule');
    for (const f of freeSlots) {
      assert.strictEqual(f.freeLabel, 'Free Slot (Available for Substitution)');
    }

    const breakSlots = daySchedule.schedule.filter(s => s.isBreak);
    assert.strictEqual(breakSlots.length, 2, 'Expected exactly 2 break slots');
  });
});
