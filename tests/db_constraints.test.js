import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { closeDatabase, getDatabase, initSchema } from '../src/db/connection.js';
import config from '../src/config/env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const bakDbPath = path.resolve(__dirname, '../data/timetable.db.bak');
const liveDbPath = path.resolve(__dirname, '../data/timetable.db');
const sourceDbPath = fs.existsSync(bakDbPath) ? bakDbPath : liveDbPath;
const testDbPath = path.resolve(__dirname, '../data/db_constraints_test.db');

test('Database Hard Constraints & Collision Prevention', async (t) => {
  assert.ok(fs.existsSync(sourceDbPath), `Source database not found at ${sourceDbPath}`);

  // Create isolated copy of database
  fs.copyFileSync(sourceDbPath, testDbPath);
  const origDbPath = config.dbPath;
  closeDatabase();
  config.dbPath = testDbPath;
  const db = getDatabase();
  initSchema(db);
  db.pragma('foreign_keys = ON');

  // Verify target version exists with 413 entries and set is_draft = 0 to enforce unique partial indexes
  const targetVersion = db.prepare("SELECT * FROM timetable_versions WHERE source = 'imported_verified' OR id = 1").get();
  assert.ok(targetVersion, 'Target imported timetable version must exist');
  const versionId = targetVersion.id;

  db.prepare("UPDATE timetable_versions SET status = 'active' WHERE id = ?").run(versionId);
  db.prepare("UPDATE timetable_entries SET is_draft = 0 WHERE version_id = ?").run(versionId);

  // Retrieve an existing entry with valid section and room from the active version
  const existing = db.prepare(`
    SELECT * FROM timetable_entries 
    WHERE version_id = ? AND section_id IS NOT NULL AND room_id IS NOT NULL
    LIMIT 1
  `).get(versionId);

  assert.ok(existing, 'Expected at least one seeded timetable entry');

  await t.test('Prevents faculty double-booking via UNIQUE constraint', () => {
    // Attempt to insert an entry with the same version, same faculty, same day, and same slot, but different section/room
    const otherSection = db.prepare('SELECT id FROM sections WHERE id != ? LIMIT 1').get(existing.section_id);
    const otherRoom = db.prepare("SELECT id FROM rooms WHERE id != ? AND type = 'classroom' LIMIT 1").get(existing.room_id);

    assert.throws(
      () => {
        db.prepare(`
          INSERT INTO timetable_entries 
          (version_id, section_id, subject_id, faculty_id, room_id, day_id, slot_id, is_lab_block, locked, is_draft)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0)
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
          (version_id, section_id, subject_id, faculty_id, room_id, day_id, slot_id, is_lab_block, locked, is_draft, batch)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?)
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
          (version_id, section_id, subject_id, faculty_id, room_id, day_id, slot_id, is_lab_block, locked, is_draft)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0)
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
    // Choose a valid room, section, day and slot not occupied by a duplicate check
    const slot = db.prepare("SELECT id FROM time_slots WHERE is_break = 0 LIMIT 1").get();
    const day = db.prepare("SELECT id FROM working_days WHERE is_active = 1 LIMIT 1").get();
    const room = db.prepare("SELECT id FROM rooms WHERE id NOT IN (SELECT room_id FROM timetable_entries WHERE day_id = ? AND slot_id = ?) LIMIT 1").get(day.id, slot.id);
    const section = db.prepare("SELECT id FROM sections WHERE id NOT IN (SELECT section_id FROM timetable_entries WHERE day_id = ? AND slot_id = ?) LIMIT 1").get(day.id, slot.id);
    const subject = db.prepare("SELECT id FROM subjects LIMIT 1").get();

    assert.throws(
      () => {
        db.prepare(`
          INSERT INTO timetable_entries 
          (version_id, section_id, subject_id, faculty_id, room_id, day_id, slot_id, is_lab_block, locked, is_draft)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0)
        `).run(
          existing.version_id,
          section ? section.id : existing.section_id,
          subject ? subject.id : existing.subject_id,
          999999, // Non-existent faculty ID
          room ? room.id : existing.room_id,
          day.id,
          slot.id
        );
      },
      (err) => {
        return err.message.includes('FOREIGN KEY constraint failed');
      },
      'Expected foreign key failure with non-existent faculty_id'
    );
  });

  // Cleanup test database
  closeDatabase();
  config.dbPath = origDbPath;
  try {
    fs.unlinkSync(testDbPath);
    if (fs.existsSync(`${testDbPath}-shm`)) fs.unlinkSync(`${testDbPath}-shm`);
    if (fs.existsSync(`${testDbPath}-wal`)) fs.unlinkSync(`${testDbPath}-wal`);
  } catch (e) {}
});
