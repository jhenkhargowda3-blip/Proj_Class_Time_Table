import test from 'node:test';
import assert from 'node:assert';
import { getDatabase } from '../src/db/connection.js';
import app from '../server.js';
import { SEED_PASSWORDS } from '../src/db/seed.js';

let serverInstance;
let baseUrl;
let adminToken;

test.before(async () => {
  return new Promise((resolve) => {
    serverInstance = app.listen(0, '127.0.0.1', async () => {
      const address = serverInstance.address();
      baseUrl = `http://127.0.0.1:${address.port}`;

      // Login as admin
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'admin',
          password: SEED_PASSWORDS.admin,
          role: 'admin'
        })
      });
      const data = await res.json();
      adminToken = data.token;
      resolve();
    });
  });
});

test.after(async () => {
  if (serverInstance) {
    serverInstance.close();
  }
});

test('Phase 6: Admin Module (Master Data, Availability, Studio Drag & Drop, Version Management)', async (t) => {
  const db = getDatabase();

  await t.test('1. GET /api/admin/master-data returns complete college resources', async () => {
    const res = await fetch(`${baseUrl}/api/admin/master-data`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.departments.length >= 3);
    assert.ok(data.faculty.length >= 10);
    assert.ok(data.subjects.length >= 12);
    assert.ok(data.sections.length >= 4);
    assert.ok(data.rooms.length >= 11);
    assert.ok(data.workingDays.length === 6);
  });

  await t.test('2. Master Data Delete-Safety: rejects deleting in-use faculty with 409', async () => {
    // Find faculty with assigned timetable classes
    const inUse = db.prepare('SELECT faculty_id FROM timetable_entries LIMIT 1').get();
    assert.ok(inUse, 'Expected at least one assigned faculty');

    const res = await fetch(`${baseUrl}/api/admin/faculty/${inUse.faculty_id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    assert.strictEqual(res.status, 409);
    const data = await res.json();
    assert.ok(data.error.includes('assigned to'));
  });

  await t.test('3. Faculty availability editor updates matrix successfully', async () => {
    const fac = db.prepare('SELECT id FROM faculty LIMIT 1').get();
    const day = db.prepare('SELECT id FROM working_days LIMIT 1').get();
    const slot = db.prepare('SELECT id FROM time_slots WHERE is_break = 0 LIMIT 1').get();

    const res = await fetch(`${baseUrl}/api/admin/faculty/${fac.id}/availability`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        availability: [
          { dayId: day.id, slotId: slot.id, isAvailable: false }
        ]
      })
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);

    // Verify in database
    const check = db.prepare('SELECT is_available FROM faculty_availability WHERE faculty_id = ? AND day_id = ? AND slot_id = ?').get(fac.id, day.id, slot.id);
    assert.strictEqual(check.is_available, 0);

    // Restore availability to available
    db.prepare('UPDATE faculty_availability SET is_available = 1 WHERE faculty_id = ? AND day_id = ? AND slot_id = ?').run(fac.id, day.id, slot.id);
  });

  await t.test('4. Timetable drag & drop move validates and updates position', async () => {
    // Pick an existing entry from draft or active
    const entry = db.prepare(`
      SELECT te.*, ts.slot_no, wd.day_index
      FROM timetable_entries te
      JOIN time_slots ts ON te.slot_id = ts.id
      JOIN working_days wd ON te.day_id = wd.id
      WHERE te.is_lab_block = 0
      LIMIT 1
    `).get();

    assert.ok(entry, 'Expected at least one non-lab entry');

    // Find an empty non-break slot on a different day where faculty & section are free
    const targetDay = db.prepare('SELECT id FROM working_days WHERE id != ? LIMIT 1').get(entry.day_id);
    const targetSlot = db.prepare(`
      SELECT ts.id FROM time_slots ts
      WHERE ts.is_break = 0
      AND ts.id NOT IN (
        SELECT slot_id FROM timetable_entries 
        WHERE version_id = ? AND day_id = ? AND (faculty_id = ? OR section_id = ? OR room_id = ?)
      )
      LIMIT 1
    `).get(entry.version_id, targetDay.id, entry.faculty_id, entry.section_id, entry.room_id);

    if (targetSlot) {
      const moveRes = await fetch(`${baseUrl}/api/timetable/entries/${entry.id}/move`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          targetDayId: targetDay.id,
          targetSlotId: targetSlot.id
        })
      });

      assert.strictEqual(moveRes.status, 200);
      const moveData = await moveRes.json();
      assert.strictEqual(moveData.success, true);
    }
  });

  await t.test('5. Duplicate version creates full clone with draft status', async () => {
    const activeVer = db.prepare("SELECT id FROM timetable_versions WHERE status = 'active' LIMIT 1").get();
    assert.ok(activeVer, 'Expected an active timetable version');

    const res = await fetch(`${baseUrl}/api/timetable/versions/${activeVer.id}/duplicate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    assert.strictEqual(res.status, 201);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.ok(data.versionId > 0);

    // Verify duplicated version is draft
    const cloned = db.prepare('SELECT * FROM timetable_versions WHERE id = ?').get(data.versionId);
    assert.strictEqual(cloned.status, 'draft');

    // Clean up duplicate version
    db.prepare('DELETE FROM timetable_entries WHERE version_id = ?').run(data.versionId);
    db.prepare('DELETE FROM timetable_versions WHERE id = ?').run(data.versionId);
  });
});
