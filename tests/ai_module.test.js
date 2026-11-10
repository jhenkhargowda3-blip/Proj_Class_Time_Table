import test from 'node:test';
import assert from 'node:assert';
import { getDatabase } from '../src/db/connection.js';
import app from '../server.js';
import { SEED_PASSWORDS, seedDatabase } from '../src/db/seed.js';

let serverInstance;
let baseUrl;
let adminToken;

test.before(async () => {
  const db = getDatabase();
  seedDatabase(db);
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

test('Phases 10, 11, 12: Grok AI Services (Vision Import, Clash Reasoning, Decision Support)', async (t) => {
  const db = getDatabase();

  await t.test('1. GET /api/ai/status returns valid model configuration and status flags', async () => {
    const res = await fetch(`${baseUrl}/api/ai/status`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok('configured' in data);
    assert.ok('models' in data);
    assert.ok(data.models.vision);
    assert.ok(data.models.reasoning);
    assert.ok(data.models.decision);
  });

  await t.test('2. POST /api/ai/vision-import extracts structured timetable with fuzzy entity matching', async () => {
    const res = await fetch(`${baseUrl}/api/ai/vision-import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        useSample: true,
        sectionId: 1,
        sectionName: 'CSE-4A'
      })
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.ok(Array.isArray(data.mappedCells));
    assert.ok(data.mappedCells.length > 0);

    // Verify cell contains fuzzy-matched IDs and confidence
    const firstCell = data.mappedCells[0];
    assert.ok(firstCell.dayId);
    assert.ok(firstCell.slotId);
    assert.ok(firstCell.subjectId);
    assert.ok(firstCell.facultyId);
    assert.ok(firstCell.roomId);
    assert.ok(typeof firstCell.confidence === 'number');
  });

  let importedDraftVersionId;

  await t.test('3. POST /api/ai/import-confirm creates a validated draft timetable version', async () => {
    const sampleCells = [
      { sectionId: 1, subjectId: 1, facultyId: 1, roomId: 1, dayId: 1, slotId: 1, isLabBlock: false },
      { sectionId: 1, subjectId: 2, facultyId: 2, roomId: 1, dayId: 1, slotId: 2, isLabBlock: false }
    ];

    const res = await fetch(`${baseUrl}/api/ai/import-confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        versionName: 'AI Digitized Test Draft',
        cells: sampleCells,
        notes: 'Test import draft'
      })
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.ok(data.versionId);
    importedDraftVersionId = data.versionId;

    const row = db.prepare('SELECT * FROM timetable_versions WHERE id = ?').get(importedDraftVersionId);
    assert.strictEqual(row.status, 'draft');
    assert.strictEqual(row.name, 'AI Digitized Test Draft');
  });

  await t.test('4. POST /api/ai/analyze-version diagnoses clashes and persists to ai_issue_log', async () => {
    const activeVersion = db.prepare("SELECT id FROM timetable_versions WHERE status = 'active'").get();
    assert.ok(activeVersion, 'Active version should exist');

    const res = await fetch(`${baseUrl}/api/ai/analyze-version`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({ versionId: activeVersion.id })
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.ok(Array.isArray(data.issues));
  });

  await t.test('5. GET /api/ai/issues retrieves issues with suggested fixes', async () => {
    const activeVersion = db.prepare("SELECT id FROM timetable_versions WHERE status = 'active'").get();

    const res = await fetch(`${baseUrl}/api/ai/issues?versionId=${activeVersion.id}`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.issues));
  });

  await t.test('6. POST /api/ai/decision/rank-substitutes evaluates and ranks candidates', async () => {
    // Find a timetable entry
    const entry = db.prepare('SELECT id FROM timetable_entries LIMIT 1').get();
    assert.ok(entry, 'Timetable entry should exist');

    const res = await fetch(`${baseUrl}/api/ai/decision/rank-substitutes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        timetableEntryId: entry.id,
        dateStr: '2026-10-26'
      })
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.ok(Array.isArray(data.rankedOptions));
    assert.ok(typeof data.justification === 'string');
  });

  await t.test('7. POST /api/ai/decision/reschedule-slots finds conflict-free replacement slots', async () => {
    const entry = db.prepare('SELECT id FROM timetable_entries LIMIT 1').get();
    assert.ok(entry, 'Timetable entry should exist');

    const res = await fetch(`${baseUrl}/api/ai/decision/reschedule-slots`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        timetableEntryId: entry.id,
        dateStr: '2026-10-26'
      })
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.ok(Array.isArray(data.candidateSlots));
  });

  // Cleanup imported test draft
  if (importedDraftVersionId) {
    db.prepare('DELETE FROM timetable_entries WHERE version_id = ?').run(importedDraftVersionId);
    db.prepare('DELETE FROM timetable_versions WHERE id = ?').run(importedDraftVersionId);
  }
});
