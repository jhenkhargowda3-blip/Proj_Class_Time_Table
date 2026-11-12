import test from 'node:test';
import assert from 'node:assert';
import { getDatabase } from '../src/db/connection.js';

test('Database Hard Constraints & Collision Prevention', async (t) => {
  const db = getDatabase();
  db.pragma('foreign_keys = ON');

  // Retrieve an existing entry from the active version
  const existing = db.prepare(`
    SELECT * FROM timetable_entries LIMIT 1
  `).get();

  assert.ok(existing, 'Expected at least one seeded timetable entry');

  await t.test('Prevents faculty double-booking via UNIQUE constraint', () => {
    // Attempt to insert an entry with the same version, same faculty, same day, and same slot, but different section/room
    const otherSection = db.prepare('SELECT id FROM sections WHERE id != ? LIMIT 1').get(existing.section_id);
    const otherRoom = db.prepare("SELECT id FROM rooms WHERE id != ? AND type = 'classroom' LIMIT 1").get(existing.room_id);

    assert.throws(
      () => {
        db.prepare(`
          INSERT INTO timetable_entries 
          (version_id, section_id, subject_id, faculty_id, room_id, day_id, slot_id, is_lab_block, locked)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)
        `).run(
          existing.version_id,
          otherSection.id,
          existing.subject_id,
          existing.faculty_id, // SAME FACULTY
          otherRoom.id,
          existing.day_id,     // SAME DAY
          existing.slot_id     // SAME SLOT
        );
      },
      (err) => {
        return err.message.includes('UNIQUE constraint failed');
      },
      'Expected insertion to fail due to faculty double-booking constraint'
    );
  });

  await t.test('Prevents section double-booking via UNIQUE constraint (identical room and batch)', () => {
    const otherFaculty = db.prepare('SELECT id FROM faculty WHERE id != ? LIMIT 1').get(existing.faculty_id);

    assert.throws(
      () => {
        db.prepare(`
          INSERT INTO timetable_entries 
          (version_id, section_id, subject_id, faculty_id, room_id, day_id, slot_id, is_lab_block, locked, batch)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
        `).run(
          existing.version_id,
          existing.section_id, // SAME SECTION
          existing.subject_id,
          otherFaculty.id,
          existing.room_id,    // SAME ROOM
          existing.day_id,     // SAME DAY
          existing.slot_id,    // SAME SLOT
          existing.batch || null
        );
      },
      (err) => {
        return err.message.includes('UNIQUE constraint failed');
      },
      'Expected insertion to fail due to section double-booking constraint'
    );
  });

  await t.test('Allows parallel batches for the same section in the same slot with different room or batch', () => {
    const otherRoom = db.prepare('SELECT id FROM rooms WHERE id != ? LIMIT 1').get(existing.room_id);
    const otherFaculty = db.prepare('SELECT id FROM faculty WHERE id != ? LIMIT 1').get(existing.faculty_id);

    const info = db.prepare(`
      INSERT INTO timetable_entries 
      (version_id, section_id, subject_id, faculty_id, room_id, day_id, slot_id, is_lab_block, locked, is_draft, batch)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 1, ?)
    `).run(
      existing.version_id,
      existing.section_id,
      existing.subject_id,
      otherFaculty.id,
      otherRoom.id,
      existing.day_id,
      existing.slot_id,
      'BATCH_PARALLEL_TEST'
    );

    assert.ok(info.lastInsertRowid > 0);
    db.prepare('DELETE FROM timetable_entries WHERE id = ?').run(info.lastInsertRowid);
  });

  await t.test('Prevents room double-booking via UNIQUE constraint', () => {
    const otherFaculty = db.prepare('SELECT id FROM faculty WHERE id != ? LIMIT 1').get(existing.faculty_id);
    const otherSection = db.prepare('SELECT id FROM sections WHERE id != ? LIMIT 1').get(existing.section_id);

    assert.throws(
      () => {
        db.prepare(`
          INSERT INTO timetable_entries 
          (version_id, section_id, subject_id, faculty_id, room_id, day_id, slot_id, is_lab_block, locked)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)
        `).run(
          existing.version_id,
          otherSection.id,
          existing.subject_id,
          otherFaculty.id,
          existing.room_id,    // SAME ROOM
          existing.day_id,     // SAME DAY
          existing.slot_id     // SAME SLOT
        );
      },
      (err) => {
        return err.message.includes('UNIQUE constraint failed');
      },
      'Expected insertion to fail due to room double-booking constraint'
    );
  });

  await t.test('Enforces single active timetable version via partial UNIQUE index', () => {
    assert.throws(
      () => {
        db.prepare(`
          INSERT INTO timetable_versions (name, status, notes)
          VALUES (?, 'active', 'Duplicate active version test')
        `).run('Second Active Version');
      },
      (err) => {
        return err.message.includes('UNIQUE constraint failed');
      },
      'Expected inserting a second active timetable version to fail'
    );
  });

  await t.test('Enforces foreign key referential integrity', () => {
    // Choose an unused slot so it doesn't fail on unique constraint
    const unusedSlot = db.prepare(`
      SELECT id FROM time_slots 
      WHERE is_break = 0 
      AND id NOT IN (SELECT slot_id FROM timetable_entries WHERE version_id = ? AND day_id = ?)
      LIMIT 1
    `).get(existing.version_id, existing.day_id);

    assert.throws(
      () => {
        db.prepare(`
          INSERT INTO timetable_entries 
          (version_id, section_id, subject_id, faculty_id, room_id, day_id, slot_id, is_lab_block, locked)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)
        `).run(
          existing.version_id,
          existing.section_id,
          existing.subject_id,
          999999, // Non-existent faculty ID
          existing.room_id,
          existing.day_id,
          unusedSlot.id
        );
      },
      (err) => {
        return err.message.includes('FOREIGN KEY constraint failed');
      },
      'Expected foreign key failure with non-existent faculty_id'
    );
  });
});
