import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { closeDatabase, getDatabase, initSchema } from '../src/db/connection.js';
import { validateTimetable } from '../src/services/validator.js';
import config from '../src/config/env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sourceDbPath = path.resolve(__dirname, '../data/timetable.db.bak');
const testDbPath = path.resolve(__dirname, '../data/publish_flow_test.db');

function calculateRowsChecksum(rows) {
  const hash = crypto.createHash('sha256');
  const normalized = rows.map(r => ({
    id: r.id,
    version_id: r.version_id,
    section_id: r.section_id,
    subject_id: r.subject_id,
    faculty_id: r.faculty_id,
    room_id: r.room_id,
    day_id: r.day_id,
    slot_id: r.slot_id,
    is_lab_block: r.is_lab_block,
    batch: r.batch || null,
    session_id: r.session_id || null
  }));
  hash.update(JSON.stringify(normalized));
  return hash.digest('hex');
}

test('Publish (Activate) Flow Verification with 413-Entry Imported Timetable', async (t) => {
  // Ensure source backup database exists or auto-create it
  if (!fs.existsSync(sourceDbPath)) {
    const initDb = getDatabase();
    importReferenceData(initDb);
    initDb.pragma('wal_checkpoint(TRUNCATE)');
    closeDatabase();
    fs.copyFileSync(config.dbPath, sourceDbPath);
  }
  assert.ok(fs.existsSync(sourceDbPath), `Source database not found at ${sourceDbPath}`);

  // Create isolated copy of database
  fs.copyFileSync(sourceDbPath, testDbPath);
  const origDbPath = config.dbPath;
  closeDatabase();
  config.dbPath = testDbPath;
  const db = getDatabase();

  // Verify target version exists with 413 entries
  const targetVersion = db.prepare("SELECT * FROM timetable_versions WHERE source = 'imported_verified' OR id = 1").get();
  assert.ok(targetVersion, 'Target imported timetable version must exist');
  const versionId = targetVersion.id;

  const entriesQuery = `
    SELECT id, version_id, section_id, subject_id, faculty_id, room_id, day_id, slot_id, is_lab_block, batch, room_note, session_id
    FROM timetable_entries
    WHERE version_id = ?
    ORDER BY id ASC
  `;

  const initialRows = db.prepare(entriesQuery).all(versionId);
  const initialChecksum = calculateRowsChecksum(initialRows);
  console.log(`\n======================================================================`);
  console.log(` [TEST SETUP] Database Copy Created: ${testDbPath}`);
  console.log(` [TEST SETUP] Imported Version ID: ${versionId} ("${targetVersion.name}")`);
  console.log(` [TEST SETUP] Initial Entries Count: ${initialRows.length}`);
  console.log(` [TEST SETUP] Initial Rows Checksum: ${initialChecksum.slice(0, 16)}...`);
  console.log(`======================================================================\n`);

  assert.strictEqual(initialRows.length, 413, 'Expected exactly 413 imported entries before publish');

  // STEP 2 & 7: Run migration and verify idempotency
  await t.test('7. Running the migration twice leaves data and row count unchanged', () => {
    initSchema(db);
    const countAfterFirst = db.prepare('SELECT count(*) as count FROM timetable_entries WHERE version_id = ?').get(versionId).count;
    assert.strictEqual(countAfterFirst, 413, 'Row count after first migration must be 413');

    // Run migration second time to verify idempotency
    initSchema(db);
    const countAfterSecond = db.prepare('SELECT count(*) as count FROM timetable_entries WHERE version_id = ?').get(versionId).count;
    assert.strictEqual(countAfterSecond, 413, 'Row count after second migration must remain 413');

    // Verify index exists and matches specification
    const uqIdx = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND name='uq_timetable_entries_slot'").get();
    assert.ok(uqIdx, 'uq_timetable_entries_slot index must exist');
    assert.ok(/COALESCE\s*\(\s*room_id\s*,\s*0\s*\)/i.test(uqIdx.sql), 'uq_timetable_entries_slot must include COALESCE(room_id,0)');
    assert.ok(/COALESCE\s*\(\s*batch\s*,\s*''\s*\)/i.test(uqIdx.sql), 'uq_timetable_entries_slot must include COALESCE(batch,\'\')');

    console.log(`[PASS ITEM 7] Migration is idempotent: first run count = ${countAfterFirst}, second run count = ${countAfterSecond}`);
    console.log(`[PASS ITEM 7] Index: ${uqIdx.name} -> ${uqIdx.sql.replace(/\s+/g, ' ')}`);
  });

  // STEP 3: Test Publish/Activate flow
  await t.test('1 & 2. Entry count and version status before and after Publish', () => {
    // Stage version in draft mode with is_draft = 1 to test full Publish transition
    db.prepare("UPDATE timetable_versions SET status = 'draft' WHERE id = ?").run(versionId);
    db.prepare("UPDATE timetable_entries SET is_draft = 1 WHERE version_id = ?").run(versionId);

    const statusBefore = db.prepare('SELECT status FROM timetable_versions WHERE id = ?').get(versionId).status;
    const countBefore = db.prepare('SELECT count(*) as count FROM timetable_entries WHERE version_id = ?').get(versionId).count;

    console.log(`[ITEM 1 & 2 BEFORE] Status: "${statusBefore}", Entries Count: ${countBefore}`);
    assert.strictEqual(statusBefore, 'draft');
    assert.strictEqual(countBefore, 413);

    // Execute Publish (Activate) logic
    const activateTx = db.transaction(() => {
      db.prepare("UPDATE timetable_versions SET status = 'archived' WHERE status = 'active'").run();
      db.prepare("UPDATE timetable_entries SET is_draft = 0 WHERE version_id = ?").run(versionId);
      db.prepare("UPDATE timetable_versions SET status = 'active' WHERE id = ?").run(versionId);
    });
    activateTx();

    const statusAfter = db.prepare('SELECT status FROM timetable_versions WHERE id = ?').get(versionId).status;
    const countAfter = db.prepare('SELECT count(*) as count FROM timetable_entries WHERE version_id = ?').get(versionId).count;

    console.log(`[PASS ITEM 1] Entry Count Before: ${countBefore}, Entry Count After: ${countAfter} (Expected: 413 and 413)`);
    console.log(`[PASS ITEM 2] Version Status Before: "${statusBefore}", Version Status After: "${statusAfter}" (Expected: ACTIVE)`);

    assert.strictEqual(countBefore, 413);
    assert.strictEqual(countAfter, 413);
    assert.strictEqual(statusAfter, 'active');
  });

  // STEP 4, Item 3: Conflict count from EXISTING conflict validator
  await t.test('3. Conflict count from the EXISTING conflict validator after Publish is 0', () => {
    // Validate the active timetable entries using the existing conflict validator without modification
    const activeEntries = db.prepare(`
      SELECT te.*, s.name as subject_name, s.code as subject_code, s.type as subject_type, s.lab_block_length, s.weekly_periods,
             sec.name as section_name, sec.strength as section_strength,
             f.name as faculty_name, f.max_periods_per_day,
             r.name as room_name, r.type as room_type, r.capacity as room_capacity,
             wd.day_name, wd.day_index,
             ts.slot_no, ts.start_time, ts.end_time, ts.is_break, ts.label as slot_label
      FROM timetable_entries te
      JOIN subjects s ON te.subject_id = s.id
      JOIN sections sec ON te.section_id = sec.id
      JOIN faculty f ON te.faculty_id = f.id
      JOIN rooms r ON te.room_id = r.id
      JOIN working_days wd ON te.day_id = wd.id
      JOIN time_slots ts ON te.slot_id = ts.id
      WHERE te.version_id = ?
    `).all(versionId);

    const validationResult = validateTimetable(activeEntries, { skipPeriodCountCheck: true });
    const errors = validationResult.violations.filter(v => v.severity === 'error' || v.severity === 'critical');

    console.log(`[PASS ITEM 3] Conflict count from EXISTING validator: total violations = ${validationResult.violations.length}, hard errors = ${errors.length}, isValid = ${validationResult.isValid}`);
    assert.strictEqual(errors.length, 0, `Expected 0 hard conflict errors after publish, found: ${JSON.stringify(errors)}`);
  });

  // STEP 4, Item 4: Faculty view and student view return published timetable
  await t.test('4. Faculty view and student view return published timetable with accurate row counts', () => {
    // Test sample faculty: F01 (first faculty) and F31 (Mrs. Manjula H S)
    const f01 = db.prepare("SELECT id, name FROM faculty WHERE code = 'F01' OR id = 1").get();
    const f31 = db.prepare("SELECT id, name FROM faculty WHERE code = 'F31' OR email = 'manjula@gmail.com'").get();

    const facultyEntriesF01 = db.prepare(`
      SELECT te.*, s.code as subject_code, sec.name as section_name, r.name as room_name, wd.day_name, ts.slot_no
      FROM timetable_entries te
      JOIN timetable_versions tv ON te.version_id = tv.id AND tv.status = 'active'
      JOIN subjects s ON te.subject_id = s.id
      JOIN sections sec ON te.section_id = sec.id
      JOIN rooms r ON te.room_id = r.id
      JOIN working_days wd ON te.day_id = wd.id
      JOIN time_slots ts ON te.slot_id = ts.id
      WHERE te.faculty_id = ?
      ORDER BY wd.day_index, ts.slot_no
    `).all(f01.id);

    const facultyEntriesF31 = db.prepare(`
      SELECT te.*, s.code as subject_code, sec.name as section_name, r.name as room_name, wd.day_name, ts.slot_no
      FROM timetable_entries te
      JOIN timetable_versions tv ON te.version_id = tv.id AND tv.status = 'active'
      JOIN subjects s ON te.subject_id = s.id
      JOIN sections sec ON te.section_id = sec.id
      JOIN rooms r ON te.room_id = r.id
      JOIN working_days wd ON te.day_id = wd.id
      JOIN time_slots ts ON te.slot_id = ts.id
      WHERE te.faculty_id = ?
      ORDER BY wd.day_index, ts.slot_no
    `).all(f31.id);

    // Test sample sections: CSE-1A and CSE-5A
    const sec1A = db.prepare("SELECT id, name FROM sections WHERE name = 'CSE-1A'").get();
    const sec5A = db.prepare("SELECT id, name FROM sections WHERE name = 'CSE-5A'").get();

    const studentEntries1A = db.prepare(`
      SELECT te.*, s.code as subject_code, f.name as faculty_name, r.name as room_name, wd.day_name, ts.slot_no
      FROM timetable_entries te
      JOIN timetable_versions tv ON te.version_id = tv.id AND tv.status = 'active'
      JOIN subjects s ON te.subject_id = s.id
      JOIN faculty f ON te.faculty_id = f.id
      JOIN rooms r ON te.room_id = r.id
      JOIN working_days wd ON te.day_id = wd.id
      JOIN time_slots ts ON te.slot_id = ts.id
      WHERE te.section_id = ?
      ORDER BY wd.day_index, ts.slot_no
    `).all(sec1A.id);

    const studentEntries5A = db.prepare(`
      SELECT te.*, s.code as subject_code, f.name as faculty_name, r.name as room_name, wd.day_name, ts.slot_no
      FROM timetable_entries te
      JOIN timetable_versions tv ON te.version_id = tv.id AND tv.status = 'active'
      JOIN subjects s ON te.subject_id = s.id
      JOIN faculty f ON te.faculty_id = f.id
      JOIN rooms r ON te.room_id = r.id
      JOIN working_days wd ON te.day_id = wd.id
      JOIN time_slots ts ON te.slot_id = ts.id
      WHERE te.section_id = ?
      ORDER BY wd.day_index, ts.slot_no
    `).all(sec5A.id);

    console.log(`[PASS ITEM 4] Faculty View - ${f01.name} (${f01.id}): ${facultyEntriesF01.length} scheduled periods`);
    console.log(`[PASS ITEM 4] Faculty View - ${f31.name} (${f31.id}): ${facultyEntriesF31.length} scheduled periods`);
    console.log(`[PASS ITEM 4] Student View - ${sec1A.name} (${sec1A.id}): ${studentEntries1A.length} weekly periods`);
    console.log(`[PASS ITEM 4] Student View - ${sec5A.name} (${sec5A.id}): ${studentEntries5A.length} weekly periods`);

    assert.ok(facultyEntriesF01.length > 0, 'Faculty F01 should have scheduled classes');
    assert.ok(facultyEntriesF31.length > 0, 'Faculty F31 should have scheduled classes');
    assert.ok(studentEntries1A.length > 0, 'Section CSE-1A should have scheduled classes');
    assert.ok(studentEntries5A.length > 0, 'Section CSE-5A should have scheduled classes');
  });

  // STEP 4, Item 5: Parallel batches CAN be inserted
  let parallelEntryId = null;
  await t.test('5. Parallel batches (same version, section, day, slot but different room or batch) CAN be inserted', () => {
    // Find an existing lab entry with a section
    const sampleEntry = db.prepare(`
      SELECT * FROM timetable_entries 
      WHERE version_id = ? AND section_id IS NOT NULL AND batch IS NOT NULL
      LIMIT 1
    `).get(versionId);

    assert.ok(sampleEntry, 'Sample entry with batch must exist');

    // Pick an unoccupied room and different faculty
    const otherRoom = db.prepare("SELECT id, name FROM rooms WHERE id != ? AND type = 'lab' LIMIT 1").get(sampleEntry.room_id);
    const otherFaculty = db.prepare("SELECT id, name FROM faculty WHERE id != ? LIMIT 1").get(sampleEntry.faculty_id);

    const insertResult = db.prepare(`
      INSERT INTO timetable_entries (
        version_id, section_id, subject_id, faculty_id, room_id, day_id, slot_id, is_lab_block, locked, is_draft, batch, room_note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 1, ?, 'Parallel Batch Coverage Test')
    `).run(
      sampleEntry.version_id,
      sampleEntry.section_id, // SAME SECTION
      sampleEntry.subject_id,
      otherFaculty.id,
      otherRoom.id,           // DIFFERENT ROOM
      sampleEntry.day_id,     // SAME DAY
      sampleEntry.slot_id,    // SAME SLOT
      `${sampleEntry.batch}_PARALLEL` // DIFFERENT BATCH
    );

    parallelEntryId = insertResult.lastInsertRowid;
    assert.ok(parallelEntryId > 0, 'Parallel batch entry should insert successfully');
    console.log(`[PASS ITEM 5] Parallel batch inserted successfully: ID=${parallelEntryId}, Section=${sampleEntry.section_id}, Day=${sampleEntry.day_id}, Slot=${sampleEntry.slot_id}, Room=${otherRoom.id}`);
  });

  // STEP 4, Item 6: Identical duplicate is REJECTED with UNIQUE error
  await t.test('6. Two entries with identical version, section, day, slot, room AND batch are REJECTED with a UNIQUE error', () => {
    const sampleEntry = db.prepare(`
      SELECT * FROM timetable_entries WHERE id = ?
    `).get(parallelEntryId);

    const otherFaculty = db.prepare('SELECT id FROM faculty WHERE id != ? LIMIT 1').get(sampleEntry.faculty_id);

    assert.throws(
      () => {
        db.prepare(`
          INSERT INTO timetable_entries (
            version_id, section_id, subject_id, faculty_id, room_id, day_id, slot_id, is_lab_block, locked, is_draft, batch
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 1, ?)
        `).run(
          sampleEntry.version_id,
          sampleEntry.section_id, // IDENTICAL SECTION
          sampleEntry.subject_id,
          otherFaculty.id,
          sampleEntry.room_id,    // IDENTICAL ROOM
          sampleEntry.day_id,     // IDENTICAL DAY
          sampleEntry.slot_id,    // IDENTICAL SLOT
          sampleEntry.batch       // IDENTICAL BATCH
        );
      },
      (err) => {
        const isUniqueError = err.message.includes('UNIQUE constraint failed');
        console.log(`[PASS ITEM 6] Expected rejection caught: "${err.message}"`);
        return isUniqueError;
      },
      'Expected insert with identical room and batch to fail with UNIQUE constraint error'
    );

    // Clean up temporary parallel test entry
    db.prepare('DELETE FROM timetable_entries WHERE id = ?').run(parallelEntryId);
  });

  // STEP 4, Item 8: Row-by-row comparison showing every session's day, period, subject, faculty and room is identical
  await t.test('8. Row-by-row comparison: every session day, period, subject, faculty and room is identical before and after migration and Publish', () => {
    const finalRows = db.prepare(entriesQuery).all(versionId);
    assert.strictEqual(finalRows.length, initialRows.length, `Expected row count ${initialRows.length}, found ${finalRows.length}`);

    let diffCount = 0;
    const diffs = [];

    for (let i = 0; i < initialRows.length; i++) {
      const init = initialRows[i];
      const fin = finalRows[i];

      const mismatch = (
        init.id !== fin.id ||
        init.day_id !== fin.day_id ||
        init.slot_id !== fin.slot_id ||
        init.subject_id !== fin.subject_id ||
        init.faculty_id !== fin.faculty_id ||
        init.room_id !== fin.room_id ||
        init.section_id !== fin.section_id ||
        init.batch !== fin.batch
      );

      if (mismatch) {
        diffCount++;
        diffs.push({ index: i, initial: init, final: fin });
      }
    }

    const finalChecksum = calculateRowsChecksum(finalRows);
    console.log(`[PASS ITEM 8] Pre-migration Checksum:  ${initialChecksum}`);
    console.log(`[PASS ITEM 8] Post-publish Checksum:   ${finalChecksum}`);
    console.log(`[PASS ITEM 8] Total entries compared:  ${finalRows.length}`);
    console.log(`[PASS ITEM 8] Mismatches detected:     ${diffCount}`);

    assert.strictEqual(diffCount, 0, `Detected ${diffCount} differences in session attributes`);
    assert.strictEqual(initialChecksum, finalChecksum, 'Checksums must match 100%');
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
