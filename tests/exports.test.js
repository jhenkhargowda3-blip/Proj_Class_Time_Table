import test from 'node:test';
import assert from 'node:assert';
import { getDatabase } from '../src/db/connection.js';
import app from '../server.js';
import { SEED_PASSWORDS } from '../src/db/seed.js';

let serverInstance;
let baseUrl;
let adminToken;
let studentToken;

test.before(async () => {
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

test('Batch 1: Exports and Printing (Shared PDF Logic, Timetable Studio & Student Exports, ICS)', async (t) => {
  const db = getDatabase();
  const activeVersion = db.prepare("SELECT id, name FROM timetable_versions WHERE status = 'active' LIMIT 1").get();
  assert.ok(activeVersion, 'An active timetable version must exist');

  await t.test('1. Timetable Studio: GET /api/timetable/versions/:id/export.ics generates valid iCalendar format', async () => {
    const res = await fetch(`${baseUrl}/api/timetable/versions/${activeVersion.id}/export.ics`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    assert.strictEqual(res.status, 200);
    const contentType = res.headers.get('content-type');
    assert.ok(contentType.includes('text/calendar'), 'Content-Type must be text/calendar');
    
    const disposition = res.headers.get('content-disposition');
    assert.ok(disposition.includes(`timetable_v${activeVersion.id}.ics`), 'Disposition should specify filename');

    const text = await res.text();
    assert.ok(text.includes('BEGIN:VCALENDAR'), 'Must contain VCALENDAR start');
    assert.ok(text.includes('VERSION:2.0'), 'Must specify iCalendar VERSION:2.0');
    assert.ok(text.includes('BEGIN:VEVENT'), 'Must contain scheduled VEVENT items');
    assert.ok(text.includes('RRULE:FREQ=WEEKLY'), 'Must declare recurring weekly rule');
    assert.ok(text.includes('END:VCALENDAR'), 'Must contain VCALENDAR end');
  });

  await t.test('2. Student Portal: GET /api/student/export.ics exports section schedule in iCalendar format', async () => {
    const res = await fetch(`${baseUrl}/api/student/export.ics`, {
      headers: { Authorization: `Bearer ${studentToken}` }
    });

    assert.strictEqual(res.status, 200);
    const contentType = res.headers.get('content-type');
    assert.ok(contentType.includes('text/calendar'), 'Content-Type must be text/calendar');

    const text = await res.text();
    assert.ok(text.includes('BEGIN:VCALENDAR'), 'Must contain VCALENDAR start');
    assert.ok(text.includes('VERSION:2.0'), 'Must specify VERSION:2.0');
    assert.ok(text.includes('BEGIN:VEVENT'), 'Must contain events for student section');
    assert.ok(text.includes('END:VCALENDAR'), 'Must contain VCALENDAR end');
  });

  await t.test('3. Client-side exportUtils module loads correctly and generates ICS strings', async () => {
    // Dynamically import the ES module in node
    const exportUtils = await import('../public/js/exportUtils.js');
    assert.ok(typeof exportUtils.generateIcsContent === 'function', 'generateIcsContent should be exported');
    assert.ok(typeof exportUtils.printOrExportPdf === 'function', 'printOrExportPdf should be exported');

    const sampleEntries = [
      {
        id: 101,
        day_index: 1,
        day_name: 'Monday',
        slot_no: 1,
        start_time: '09:00',
        end_time: '10:00',
        subject_code: 'CS301',
        subject_name: 'Data Structures',
        faculty_name: 'Dr. Turing',
        room_name: 'Room 101',
        section_name: 'CSE-5A'
      }
    ];

    const icsResult = exportUtils.generateIcsContent('CSE-5A Schedule', sampleEntries);
    assert.ok(icsResult.includes('BEGIN:VCALENDAR'));
    assert.ok(icsResult.includes('CS301: Data Structures'));
    assert.ok(icsResult.includes('Room 101'));
    assert.ok(icsResult.includes('Dr. Turing'));
    assert.ok(icsResult.includes('END:VCALENDAR'));
  });
});
