import { getDatabase } from './src/db/connection.js';

const db = getDatabase();

console.log('--- A) ACTIVE TIMETABLE VERSION ---');
const allVersions = db.prepare('SELECT * FROM timetable_versions').all();
console.log('All versions in DB:', allVersions);
const activeVersion = db.prepare("SELECT * FROM timetable_versions WHERE status = 'active' LIMIT 1").get();
console.log('Active version:', activeVersion);

console.log('\n--- B) USERS & MAPPING ---');
const studentUsers = db.prepare("SELECT * FROM users WHERE role = 'student' OR username IN ('student', 'jhenkhar')").all();
console.log('Student users:', studentUsers);

const manjulaUser = db.prepare("SELECT * FROM users WHERE username = 'manjula' OR email = 'manjula@gmail.com'").all();
console.log('Manjula user row:', manjulaUser);

const allFaculty = db.prepare("SELECT * FROM faculty").all();
console.log('Total faculty in DB:', allFaculty.length);
const manjulaFaculty = db.prepare("SELECT * FROM faculty WHERE name LIKE '%Manjula%' OR email LIKE '%manjula%'").all();
console.log('Manjula in faculty table:', manjulaFaculty);

console.log('\n--- C) DATE COMPUTATION ---');
// Test date: 2026-11-12 (Thursday)
const testDate = '2026-11-12';
const [y, m, d] = testDate.split('-').map(Number);
const dateUtc = new Date(Date.UTC(y, m - 1, d));
console.log('Date:', testDate, 'getUTCDay():', dateUtc.getUTCDay(), '(0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat)');
const workingDays = db.prepare('SELECT * FROM working_days').all();
console.log('Working days:', workingDays);

console.log('\n--- D) SQL JOINS ON TIMETABLE ENTRIES ---');
const totalEntries = db.prepare('SELECT count(*) as count FROM timetable_entries WHERE version_id = ?').get(activeVersion.id).count;
console.log('Total entries in active version:', totalEntries);

const nullSection = db.prepare('SELECT count(*) as count FROM timetable_entries WHERE version_id = ? AND section_id IS NULL').get(activeVersion.id).count;
const nullRoom = db.prepare('SELECT count(*) as count FROM timetable_entries WHERE version_id = ? AND room_id IS NULL').get(activeVersion.id).count;
const nullSubject = db.prepare('SELECT count(*) as count FROM timetable_entries WHERE version_id = ? AND subject_id IS NULL').get(activeVersion.id).count;
const nullFaculty = db.prepare('SELECT count(*) as count FROM timetable_entries WHERE version_id = ? AND faculty_id IS NULL').get(activeVersion.id).count;
console.log('Null counts - section:', nullSection, 'room:', nullRoom, 'subject:', nullSubject, 'faculty:', nullFaculty);

// Check student route query with INNER JOIN vs LEFT JOIN for CSE-5B (id 15)
const sec5B = db.prepare("SELECT id, name FROM sections WHERE name = 'CSE-5B'").get();
console.log('CSE-5B section:', sec5B);
if (sec5B) {
  const rawCount = db.prepare('SELECT count(*) as count FROM timetable_entries WHERE version_id = ? AND section_id = ?').get(activeVersion.id, sec5B.id).count;
  console.log('Raw entries for CSE-5B:', rawCount);

  const studentRouteEntries = db.prepare(`
    SELECT te.*, s.name as subject_name, s.code as subject_code, s.type as subject_type,
           f.id as original_faculty_id, f.name as faculty_name, f.email as faculty_email,
           r.name as room_name, r.type as room_type,
           wd.id as day_id, wd.day_name, wd.day_index,
           ts.slot_no, ts.start_time, ts.end_time, ts.label as slot_label
    FROM timetable_entries te
    JOIN timetable_versions tv ON te.version_id = tv.id AND tv.status = 'active'
    JOIN subjects s ON te.subject_id = s.id
    JOIN faculty f ON te.faculty_id = f.id
    JOIN rooms r ON te.room_id = r.id
    JOIN working_days wd ON te.day_id = wd.id
    JOIN time_slots ts ON te.slot_id = ts.id
    WHERE te.section_id = ?
    ORDER BY wd.day_index, ts.slot_no
  `).all(sec5B.id);
  console.log('Student route query count for CSE-5B:', studentRouteEntries.length);
}

console.log('\n--- E) FACULTY LOAD & ENTRIES FOR MANJULA ---');
if (manjulaFaculty.length > 0) {
  for (const fac of manjulaFaculty) {
    console.log(`Faculty ID ${fac.id} (${fac.name}, ${fac.email}, weekly_hours=${fac.weekly_hours}, classes_taught=${fac.classes_taught}):`);
    const facEntries = db.prepare(`
      SELECT te.*, s.name as subject_name, s.code as subject_code, sec.name as section_name,
             r.name as room_name, wd.day_name, wd.day_index, ts.slot_no
      FROM timetable_entries te
      JOIN timetable_versions tv ON te.version_id = tv.id AND tv.status = 'active'
      JOIN subjects s ON te.subject_id = s.id
      JOIN sections sec ON te.section_id = sec.id
      JOIN rooms r ON te.room_id = r.id
      JOIN working_days wd ON te.day_id = wd.id
      JOIN time_slots ts ON te.slot_id = ts.id
      WHERE te.faculty_id = ?
      ORDER BY wd.day_index, ts.slot_no
    `).all(fac.id);
    console.log(`  Entries in active timetable for faculty ${fac.id}:`, facEntries.length);
    console.log('  Sections taught:', [...new Set(facEntries.map(e => e.section_name))]);
    console.log('  Subjects taught:', [...new Set(facEntries.map(e => e.subject_code + ' - ' + e.subject_name))]);
    console.log('  Days taught:', [...new Set(facEntries.map(e => e.day_name))]);
    console.log('  Details of all entries:');
    for (const e of facEntries) {
      console.log(`    Day ${e.day_name} P${e.slot_no} Sec:${e.section_name} Batch:${e.batch} Subj:${e.subject_code} Room:${e.room_name}`);
    }
  }

  // Also check faculty_sessions for Manjula!
  const sessions = db.prepare("SELECT * FROM faculty_sessions WHERE faculty_id = ? OR faculty_name LIKE '%Manjula%'").all(manjulaFaculty[0].id);
  console.log('Faculty sessions for Manjula in faculty_sessions table:', sessions.length);
  for (const s of sessions) {
    console.log(`    Session ${s.id}: Day:${s.day} Start:${s.start}-${s.end} P${s.period_start}-${s.period_end} Subj:${s.subject_code} Sec:${s.section} Batch:${s.batch} Room:${s.room_name}`);
  }
}
