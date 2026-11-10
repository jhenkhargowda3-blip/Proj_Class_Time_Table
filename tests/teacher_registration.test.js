import test from 'node:test';
import assert from 'node:assert';
import app from '../server.js';
import { getDatabase } from '../src/db/connection.js';
import { seedDatabase } from '../src/db/seed.js';
import { registerTeacher } from '../src/services/teacherService.js';

let serverInstance;
let baseUrl;

test.before(async () => {
  const db = getDatabase();
  seedDatabase(db);

  return new Promise((resolve) => {
    serverInstance = app.listen(0, '127.0.0.1', () => {
      const address = serverInstance.address();
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (serverInstance) {
    serverInstance.close();
  }
});

test('Teacher Registration & Faculty Profile (Mrs. Manjula H S)', async (t) => {
  const db = getDatabase();

  await t.test('1. registerTeacher function registers Mrs. Manjula H S linked to CSE department', () => {
    const result = registerTeacher({
      username: 'manjula',
      password: 'man2112',
      fullName: 'Mrs. Manjula H S',
      email: 'manjula@gmail.com',
      phone: '7374619852',
      departmentCode: 'CSE',
      departmentName: 'Computer Science & Engineering'
    }, db);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.username, 'manjula');
    assert.strictEqual(result.fullName, 'Mrs. Manjula H S');
    assert.strictEqual(result.email, 'manjula@gmail.com');
    assert.strictEqual(result.phone, '7374619852');
    assert.ok(result.facultyId > 0);
    assert.ok(result.userId > 0);

    // Verify database faculty record
    const faculty = db.prepare(`
      SELECT f.*, d.name as dept_name, d.code as dept_code 
      FROM faculty f
      JOIN departments d ON f.department_id = d.id
      WHERE f.id = ?
    `).get(result.facultyId);

    assert.strictEqual(faculty.name, 'Mrs. Manjula H S');
    assert.strictEqual(faculty.email, 'manjula@gmail.com');
    assert.strictEqual(faculty.phone, '7374619852');
    assert.strictEqual(faculty.dept_code, 'CSE');

    // Verify user login record
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.userId);
    assert.strictEqual(user.username, 'manjula');
    assert.strictEqual(user.role, 'faculty');
    assert.strictEqual(user.full_name, 'Mrs. Manjula H S');
    assert.strictEqual(user.email, 'manjula@gmail.com');
    assert.strictEqual(user.faculty_id, result.facultyId);

    // Verify availability matrix was populated
    const availCount = db.prepare('SELECT count(*) as count FROM faculty_availability WHERE faculty_id = ?').get(result.facultyId);
    assert.ok(availCount.count > 0, 'Expected availability slots for faculty member');
  });

  let manjulaToken;

  await t.test('2. Teacher can authenticate with login credentials manjula / man2112', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'manjula',
        password: 'man2112',
        role: 'faculty'
      })
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.user.role, 'faculty');
    assert.strictEqual(data.user.username, 'manjula');
    assert.strictEqual(data.user.fullName, 'Mrs. Manjula H S');
    assert.strictEqual(data.user.facultyName, 'Mrs. Manjula H S');
    assert.ok(data.token);
    manjulaToken = data.token;
  });

  await t.test('3. GET /api/auth/me returns Mrs. Manjula H S as full display name', async () => {
    const res = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${manjulaToken}` }
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.user.username, 'manjula');
    assert.strictEqual(data.user.fullName, 'Mrs. Manjula H S');
    assert.strictEqual(data.user.facultyName, 'Mrs. Manjula H S');
    assert.strictEqual(data.user.email, 'manjula@gmail.com');
  });

  await t.test('4. GET /api/faculty/profile displays full name Mrs. Manjula H S on dashboard profile', async () => {
    const res = await fetch(`${baseUrl}/api/faculty/profile`, {
      headers: { Authorization: `Bearer ${manjulaToken}` }
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.faculty);
    assert.strictEqual(data.faculty.name, 'Mrs. Manjula H S');
    assert.strictEqual(data.faculty.email, 'manjula@gmail.com');
    assert.strictEqual(data.faculty.phone, '7374619852');
    assert.strictEqual(data.faculty.department_code, 'CSE');
    assert.strictEqual(data.faculty.username, 'manjula');
  });

  await t.test('5. Idempotent re-registration updates credentials and maintains profile integrity', () => {
    const updated = registerTeacher({
      username: 'manjula',
      password: 'man2112',
      fullName: 'Mrs. Manjula H S',
      email: 'manjula@gmail.com',
      phone: '7374619852',
      departmentCode: 'CSE'
    }, db);

    assert.strictEqual(updated.success, true);
    assert.strictEqual(updated.fullName, 'Mrs. Manjula H S');
  });
});
