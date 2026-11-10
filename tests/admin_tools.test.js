import test from 'node:test';
import assert from 'node:assert';
import { getDatabase } from '../src/db/connection.js';
import app from '../server.js';
import { SEED_PASSWORDS, seedDatabase } from '../src/db/seed.js';

let serverInstance;
let baseUrl;
let adminToken;
let studentToken;

test.before(async () => {
  const db = getDatabase();
  seedDatabase(db);
  return new Promise((resolve) => {
    serverInstance = app.listen(0, '127.0.0.1', async () => {
      const address = serverInstance.address();
      baseUrl = `http://127.0.0.1:${address.port}`;

      // Login as admin
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

      // Login as student
      const studentRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'student',
          password: SEED_PASSWORDS.student,
          role: 'student'
        })
      });
      const studentData = await studentRes.json();
      studentToken = studentData.token;

      resolve();
    });
  });
});

test.after(async () => {
  if (serverInstance) {
    serverInstance.close();
  }
});

test('Batch 2: Admin Tools (Backup System JSON Download & Faculty Search Filter)', async (t) => {
  const db = getDatabase();

  await t.test('1. Security check: Student role is rejected from GET /api/admin/backup with 403', async () => {
    const res = await fetch(`${baseUrl}/api/admin/backup`, {
      headers: { Authorization: `Bearer ${studentToken}` }
    });
    assert.strictEqual(res.status, 403, 'Non-admin must be forbidden');
  });

  await t.test('2. Backup System: GET /api/admin/backup exports complete JSON snapshot with metadata and tables', async () => {
    const res = await fetch(`${baseUrl}/api/admin/backup`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    assert.strictEqual(res.status, 200);
    const contentType = res.headers.get('content-type');
    assert.ok(contentType.includes('application/json'), 'Content-Type must be application/json');

    const disposition = res.headers.get('content-disposition');
    assert.ok(disposition.includes('ctas_backup_snapshot_'), 'Attachment disposition should have timestamped filename');

    const snapshot = await res.json();
    assert.strictEqual(snapshot.app, 'Class Timetable Automation System (CTAS)');
    assert.strictEqual(snapshot.format, 'CTAS-DATABASE-SNAPSHOT-v1');
    assert.ok(snapshot.exportedAt);
    assert.strictEqual(snapshot.exportedBy.role, 'admin');

    // Verify all snapshot tables
    const tables = snapshot.tables;
    assert.ok(Array.isArray(tables.departments) && tables.departments.length > 0);
    assert.ok(Array.isArray(tables.faculty) && tables.faculty.length > 0);
    assert.ok(Array.isArray(tables.subjects) && tables.subjects.length > 0);
    assert.ok(Array.isArray(tables.sections) && tables.sections.length > 0);
    assert.ok(Array.isArray(tables.rooms) && tables.rooms.length > 0);
    assert.ok(Array.isArray(tables.working_days) && tables.working_days.length > 0);
    assert.ok(Array.isArray(tables.time_slots) && tables.time_slots.length > 0);
    assert.ok(Array.isArray(tables.timetable_versions) && tables.timetable_versions.length > 0);
    assert.ok(Array.isArray(tables.timetable_entries) && tables.timetable_entries.length > 0);

    // Verify stats object
    assert.ok(snapshot.stats.totalFaculty >= tables.faculty.length);
    assert.ok(snapshot.stats.totalTimetableEntries >= tables.timetable_entries.length);

    // Verify audit log entry was created
    const log = db.prepare("SELECT * FROM audit_log WHERE action = 'DATABASE_BACKUP_SNAPSHOT' ORDER BY created_at DESC LIMIT 1").get();
    assert.ok(log, 'Audit trail entry must be recorded');
  });

  await t.test('3. Master Data & Faculty Management: Faculty search query filters correctly by name, department, and email', async () => {
    // Verify API endpoint GET /api/admin/faculty?search=...
    const nameRes = await fetch(`${baseUrl}/api/admin/faculty?search=turing`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.strictEqual(nameRes.status, 200);
    const nameData = await nameRes.json();
    assert.ok(nameData.faculty.length >= 1, 'Should find Dr. Alan Turing by name');
    assert.ok(nameData.faculty.some(f => f.name === 'Dr. Alan Turing'));

    // Test department search (both code and full department name)
    const deptCodeRes = await fetch(`${baseUrl}/api/admin/faculty?search=cse`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const deptCodeData = await deptCodeRes.json();
    assert.ok(deptCodeData.faculty.length >= 1, 'Should find CSE faculty by department code');

    const deptNameRes = await fetch(`${baseUrl}/api/admin/faculty?search=${encodeURIComponent('Computer Science')}`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const deptNameData = await deptNameRes.json();
    assert.ok(deptNameData.faculty.length >= 1, 'Should find faculty by full department name');

    // Test email search
    const emailRes = await fetch(`${baseUrl}/api/admin/faculty?search=${encodeURIComponent('turing@college.edu')}`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const emailData = await emailRes.json();
    assert.strictEqual(emailData.faculty.length, 1, 'Should find exact faculty by email');
    assert.strictEqual(emailData.faculty[0].email, 'turing@college.edu');

    // Test nonexistent query
    const zeroRes = await fetch(`${baseUrl}/api/admin/faculty?search=nonexistent_prof_xyz`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const zeroData = await zeroRes.json();
    assert.strictEqual(zeroData.faculty.length, 0, 'No match for nonexistent query');
  });
});
