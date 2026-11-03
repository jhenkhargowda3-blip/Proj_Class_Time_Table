import test from 'node:test';
import assert from 'node:assert';
import app from '../server.js';
import { getDatabase } from '../src/db/connection.js';
import { SEED_PASSWORDS, seedDatabase } from '../src/db/seed.js';

let serverInstance;
let baseUrl;

test.before(async () => {
  return new Promise((resolve) => {
    // Listen on an ephemeral port for testing
    serverInstance = app.listen(0, '127.0.0.1', () => {
      const address = serverInstance.address();
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

test.after(async () => {
  const db = getDatabase();
  seedDatabase(db);
  if (serverInstance) {
    serverInstance.close();
  }
});

test('Phase 3: Authentication and Role-Based Access Control (RBAC)', async (t) => {
  let adminToken;
  let facultyToken;
  let studentToken;

  await t.test('1. Admin login succeeds with secure admin password', async () => {
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
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.user.role, 'admin');
    assert.ok(data.token, 'Expected JWT token in response');
    adminToken = data.token;
  });

  await t.test('2. Faculty login succeeds with secure faculty password', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'faculty1',
        password: SEED_PASSWORDS.faculty,
        role: 'faculty'
      })
    });

    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.user.role, 'faculty');
    assert.ok(data.user.facultyId > 0, 'Expected valid facultyId');
    facultyToken = data.token;
  });

  await t.test('2b. Faculty login with alan/alan2112 succeeds and links to Dr. Alan Turing', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'alan',
        password: 'alan2112',
        role: 'faculty'
      })
    });

    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.user.role, 'faculty');
    assert.strictEqual(data.user.fullName, 'Dr. Alan Turing');
    assert.strictEqual(data.user.facultyId, 1);
  });

  await t.test('2c. Faculty login with donald/donald@123$ succeeds and links to Prof. Donald Knuth', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'donald',
        password: 'donald@123$',
        role: 'faculty'
      })
    });

    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.user.role, 'faculty');
    assert.strictEqual(data.user.fullName, 'Prof. Donald Knuth');
    assert.strictEqual(data.user.facultyId, 3);
  });

  await t.test('2d. Old faculty credential raj/rajiv2112 fails with 401', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'raj',
        password: 'rajiv2112',
        role: 'faculty'
      })
    });

    assert.strictEqual(res.status, 401);
  });

  await t.test('3. Student login succeeds with secure student password', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'student1',
        password: SEED_PASSWORDS.student,
        role: 'student'
      })
    });

    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.user.role, 'student');
    assert.ok(data.user.studentId > 0, 'Expected valid student section ID');
    studentToken = data.token;
  });

  await t.test('4. Login rejects invalid password with 401', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'admin',
        password: 'WrongPassword!',
        role: 'admin'
      })
    });

    assert.strictEqual(res.status, 401);
  });

  await t.test('5. Role mismatch returns 403 (student trying to login as admin)', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'student1',
        password: SEED_PASSWORDS.student,
        role: 'admin' // Mismatch
      })
    });

    assert.strictEqual(res.status, 403);
    const data = await res.json();
    assert.ok(data.error.includes('Role mismatch'));
  });

  await t.test('6. Unauthenticated requests to protected route return 401', async () => {
    const res = await fetch(`${baseUrl}/api/admin/overview`);
    assert.strictEqual(res.status, 401);
  });

  await t.test('7. Cross-role API calls return 403 (Faculty accessing Admin endpoint)', async () => {
    const res = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Authorization: `Bearer ${facultyToken}` }
    });
    assert.strictEqual(res.status, 403);
  });

  await t.test('8. Cross-role API calls return 403 (Student accessing Admin endpoint)', async () => {
    const res = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Authorization: `Bearer ${studentToken}` }
    });
    assert.strictEqual(res.status, 403);
  });

  await t.test('9. Admin can access Admin overview endpoint', async () => {
    const res = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.stats.facultyCount >= 10);
    assert.ok(data.stats.subjectsCount >= 12);
  });

  await t.test('10. Faculty can access Faculty profile and schedule', async () => {
    const res = await fetch(`${baseUrl}/api/faculty/profile`, {
      headers: { Authorization: `Bearer ${facultyToken}` }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.faculty.name, 'Dr. Alan Turing');
    assert.ok(Array.isArray(data.weeklySchedule));
  });

  await t.test('11. Student can access Student section schedule', async () => {
    const res = await fetch(`${baseUrl}/api/student/schedule`, {
      headers: { Authorization: `Bearer ${studentToken}` }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.section.name, 'CSE-4A');
    assert.ok(Array.isArray(data.schedule));
  });

  // Forgot Password & Secure Reset Flow Tests
  let testResetToken;
  await t.test('12. Forgot password request for registered email generates token and reset link', async () => {
    const res = await fetch(`${baseUrl}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@college.edu' })
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.accountFound, true);
    assert.strictEqual(data.username, 'admin');
    assert.ok(data.token, 'Expected reset token string');
    assert.strictEqual(typeof data.token, 'string');
    assert.strictEqual(data.token.length, 64);
    assert.ok(data.resetUrl.includes(data.token));
    testResetToken = data.token;
  });

  await t.test('13. Forgot password request for unknown email returns safe anti-enumeration message', async () => {
    const res = await fetch(`${baseUrl}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nonexistent.user@unknown-domain.org' })
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.accountFound, false);
    assert.strictEqual(data.token, undefined);
  });

  await t.test('14. Verify reset token succeeds for active token', async () => {
    const res = await fetch(`${baseUrl}/api/auth/verify-reset-token?token=${testResetToken}`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.valid, true);
    assert.strictEqual(data.username, 'admin');
    assert.strictEqual(data.role, 'admin');
  });

  await t.test('15. Verify reset token rejects unknown or corrupted token', async () => {
    const res = await fetch(`${baseUrl}/api/auth/verify-reset-token?token=deadbeefdeadbeef0000111122223333444455556666777788889999aaaabbbb`);
    assert.strictEqual(res.status, 404);
    const data = await res.json();
    assert.strictEqual(data.valid, false);
  });

  await t.test('16. Complete password reset with valid token updates password', async () => {
    const newTestPassword = 'Admin#Reset!2026.NewPassword99';
    const res = await fetch(`${baseUrl}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: testResetToken,
        newPassword: newTestPassword
      })
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.username, 'admin');

    // Verify login with new password succeeds
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'admin',
        password: newTestPassword,
        role: 'admin'
      })
    });

    assert.strictEqual(loginRes.status, 200);
    const loginData = await loginRes.json();
    assert.strictEqual(loginData.success, true);
    assert.strictEqual(loginData.user.username, 'admin');
  });

  await t.test('17. Reusing an already-consumed reset token is rejected', async () => {
    const res = await fetch(`${baseUrl}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: testResetToken,
        newPassword: 'AnotherPassword123'
      })
    });

    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.includes('consumed') || data.error.includes('already'));
  });
});
