import bcrypt from 'bcryptjs';
import { getDatabase, initSchema } from './connection.js';

// Configured credentials for admin, faculty, and student roles
export const SEED_PASSWORDS = {
  admin: 'sharmajii',
  faculty: 'alan2112',
  student: 'rocky(Jg)'
};

export function seedDatabase(customDb) {
  const db = customDb || getDatabase();
  initSchema(db);
  console.log('[CTAS Seeder] Starting database seeding with realistic academic college data...');

  // Wrap everything in a database transaction for atomicity and speed
  const seedTransaction = db.transaction(() => {
  // Clear existing records in child-to-parent order
  db.exec(`
    DELETE FROM substitutions;
    DELETE FROM absences;
    DELETE FROM timetable_entries;
    DELETE FROM timetable_versions;
    DELETE FROM faculty_availability;
    DELETE FROM section_subjects;
    DELETE FROM faculty_subjects;
    DELETE FROM password_reset_tokens;
    DELETE FROM users;
    DELETE FROM faculty;
    DELETE FROM sections;
    DELETE FROM subjects;
    DELETE FROM rooms;
    DELETE FROM time_slots;
    DELETE FROM working_days;
    DELETE FROM departments;
    DELETE FROM holidays;
    DELETE FROM notifications;
    DELETE FROM audit_log;
    DELETE FROM ai_issue_log;
    DELETE FROM sqlite_sequence;
  `);

  console.log('[CTAS Seeder] Cleaned existing tables.');

  // 1. Departments
  const insertDept = db.prepare('INSERT INTO departments (name, code) VALUES (?, ?)');
  const cseDept = insertDept.run('Computer Science & Engineering', 'CSE').lastInsertRowid;
  const itDept = insertDept.run('Information Technology', 'IT').lastInsertRowid;
  const eceDept = insertDept.run('Electronics & Communication', 'ECE').lastInsertRowid;

  // 2. Working Days (Mon to Sat)
  const insertDay = db.prepare('INSERT INTO working_days (day_name, day_index, is_active) VALUES (?, ?, ?)');
  const days = [
    { name: 'Monday', index: 1 },
    { name: 'Tuesday', index: 2 },
    { name: 'Wednesday', index: 3 },
    { name: 'Thursday', index: 4 },
    { name: 'Friday', index: 5 },
    { name: 'Saturday', index: 6 }
  ];
  const dayIds = [];
  for (const d of days) {
    dayIds.push(insertDay.run(d.name, d.index, 1).lastInsertRowid);
  }

  // 3. Time Slots (7 Teaching Periods + 2 Breaks)
  const insertSlot = db.prepare(`
    INSERT INTO time_slots (slot_no, start_time, end_time, is_break, label)
    VALUES (?, ?, ?, ?, ?)
  `);
  const slotsConfig = [
    { no: 1, start: '09:00', end: '09:50', isBreak: 0, label: 'Period 1' },
    { no: 2, start: '09:50', end: '10:40', isBreak: 0, label: 'Period 2' },
    { no: 3, start: '10:40', end: '11:00', isBreak: 1, label: 'Tea Break' },
    { no: 4, start: '11:00', end: '11:50', isBreak: 0, label: 'Period 3' },
    { no: 5, start: '11:50', end: '12:40', isBreak: 0, label: 'Period 4' },
    { no: 6, start: '12:40', end: '13:30', isBreak: 1, label: 'Lunch Break' },
    { no: 7, start: '13:30', end: '14:20', isBreak: 0, label: 'Period 5' },
    { no: 8, start: '14:20', end: '15:10', isBreak: 0, label: 'Period 6' },
    { no: 9, start: '15:10', end: '16:00', isBreak: 0, label: 'Period 7' }
  ];
  const slotIds = {};
  for (const s of slotsConfig) {
    slotIds[s.no] = insertSlot.run(s.no, s.start, s.end, s.isBreak, s.label).lastInsertRowid;
  }

  // 4. Rooms (8 Classrooms and 3 Labs)
  const insertRoom = db.prepare('INSERT INTO rooms (name, type, capacity, is_active) VALUES (?, ?, ?, ?)');
  const roomIds = {
    classrooms: [],
    labs: []
  };

  const classrooms = [
    { name: 'CR-101', cap: 50 }, { name: 'CR-102', cap: 50 },
    { name: 'CR-103', cap: 50 }, { name: 'CR-104', cap: 50 },
    { name: 'CR-201', cap: 60 }, { name: 'CR-202', cap: 60 },
    { name: 'CR-203', cap: 60 }, { name: 'CR-204', cap: 60 }
  ];
  for (const cr of classrooms) {
    roomIds.classrooms.push(insertRoom.run(cr.name, 'classroom', cr.cap, 1).lastInsertRowid);
  }

  const labs = [
    { name: 'Computing Lab A', cap: 45 },
    { name: 'Computing Lab B', cap: 45 },
    { name: 'Advanced Systems Lab', cap: 40 }
  ];
  for (const lab of labs) {
    roomIds.labs.push(insertRoom.run(lab.name, 'lab', lab.cap, 1).lastInsertRowid);
  }

  // 5. Sections (4 Sections)
  const insertSection = db.prepare('INSERT INTO sections (name, semester, department_id, strength) VALUES (?, ?, ?, ?)');
  const sectionIds = {
    csea: insertSection.run('CSE-4A', 4, cseDept, 45).lastInsertRowid,
    cseb: insertSection.run('CSE-4B', 4, cseDept, 42).lastInsertRowid,
    ita: insertSection.run('IT-4A', 4, itDept, 38).lastInsertRowid,
    ecea: insertSection.run('ECE-4A', 4, eceDept, 40).lastInsertRowid
  };

  // 6. Subjects (12 Subjects: 9 Theory + 3 Labs with 2-period contiguous blocks)
  const insertSubject = db.prepare(`
    INSERT INTO subjects (code, name, type, weekly_periods, lab_block_length, department_id, semester)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const subjectsData = [
    // Theory Subjects
    { code: 'CS201', name: 'Data Structures & Algorithms', type: 'theory', weekly: 4, labLen: 1, dept: cseDept, sem: 4 },
    { code: 'CS202', name: 'Operating Systems Principles', type: 'theory', weekly: 3, labLen: 1, dept: cseDept, sem: 4 },
    { code: 'CS203', name: 'Database Management Systems', type: 'theory', weekly: 3, labLen: 1, dept: cseDept, sem: 4 },
    { code: 'CS204', name: 'Computer Networks & Protocols', type: 'theory', weekly: 3, labLen: 1, dept: cseDept, sem: 4 },
    { code: 'CS205', name: 'Discrete Mathematics', type: 'theory', weekly: 3, labLen: 1, dept: cseDept, sem: 4 },
    { code: 'CS206', name: 'Software Engineering', type: 'theory', weekly: 3, labLen: 1, dept: cseDept, sem: 4 },
    { code: 'IT201', name: 'Web Application Technologies', type: 'theory', weekly: 4, labLen: 1, dept: itDept, sem: 4 },
    { code: 'IT202', name: 'Cloud Infrastructure & DevOps', type: 'theory', weekly: 3, labLen: 1, dept: itDept, sem: 4 },
    { code: 'EC201', name: 'Microprocessors & Embedded Systems', type: 'theory', weekly: 4, labLen: 1, dept: eceDept, sem: 4 },
    // Labs (2-period blocks)
    { code: 'CS201L', name: 'Data Structures Lab', type: 'lab', weekly: 2, labLen: 2, dept: cseDept, sem: 4 },
    { code: 'CS203L', name: 'Database Systems Lab', type: 'lab', weekly: 2, labLen: 2, dept: cseDept, sem: 4 },
    { code: 'CS204L', name: 'Computer Networks Lab', type: 'lab', weekly: 2, labLen: 2, dept: cseDept, sem: 4 }
  ];
  const subjectIds = {};
  for (const sub of subjectsData) {
    subjectIds[sub.code] = insertSubject.run(sub.code, sub.name, sub.type, sub.weekly, sub.labLen, sub.dept, sub.sem).lastInsertRowid;
  }

  // 7. Users & Faculty (1 Admin + 10 Faculty + 4 Students)
  const passwordSaltRounds = 10;
  const adminHash = bcrypt.hashSync(SEED_PASSWORDS.admin, passwordSaltRounds);
  const facultyHash = bcrypt.hashSync(SEED_PASSWORDS.faculty, passwordSaltRounds);
  const studentHash = bcrypt.hashSync(SEED_PASSWORDS.student, passwordSaltRounds);

  const insertUser = db.prepare(`
    INSERT INTO users (username, password_hash, role, full_name, email, faculty_id, student_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertFaculty = db.prepare(`
    INSERT INTO faculty (user_id, name, department_id, email, phone, max_periods_per_day, max_periods_per_week, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateUserFacultyId = db.prepare('UPDATE users SET faculty_id = ? WHERE id = ?');

  // Insert Admin (Primary: sharma, with alias: admin)
  const adminUserId = insertUser.run(
    'sharma',
    adminHash,
    'admin',
    'System Administrator (Sharma)',
    'sharma@college.edu',
    null,
    null
  ).lastInsertRowid;

  insertUser.run(
    'admin',
    adminHash,
    'admin',
    'System Administrator',
    'admin@college.edu',
    null,
    null
  );

  // Insert 10 Faculty members
  const facultyRoster = [
    { username: 'faculty1', name: 'Dr. Alan Turing', dept: cseDept, email: 'turing@college.edu', phone: '+1-555-0101', maxDay: 4, maxWeek: 18 },
    { username: 'faculty2', name: 'Dr. Grace Hopper', dept: cseDept, email: 'hopper@college.edu', phone: '+1-555-0102', maxDay: 4, maxWeek: 18 },
    { username: 'faculty3', name: 'Prof. Donald Knuth', dept: cseDept, email: 'knuth@college.edu', phone: '+1-555-0103', maxDay: 3, maxWeek: 16 },
    { username: 'faculty4', name: 'Dr. Ada Lovelace', dept: cseDept, email: 'lovelace@college.edu', phone: '+1-555-0104', maxDay: 4, maxWeek: 18 },
    { username: 'faculty5', name: 'Prof. Claude Shannon', dept: itDept, email: 'shannon@college.edu', phone: '+1-555-0105', maxDay: 4, maxWeek: 18 },
    { username: 'faculty6', name: 'Dr. Tim Berners-Lee', dept: itDept, email: 'bernerslee@college.edu', phone: '+1-555-0106', maxDay: 4, maxWeek: 16 },
    { username: 'faculty7', name: 'Prof. Linus Torvalds', dept: itDept, email: 'torvalds@college.edu', phone: '+1-555-0107', maxDay: 4, maxWeek: 18 },
    { username: 'faculty8', name: 'Dr. Margaret Hamilton', dept: eceDept, email: 'hamilton@college.edu', phone: '+1-555-0108', maxDay: 4, maxWeek: 18 },
    { username: 'faculty9', name: 'Prof. John von Neumann', dept: eceDept, email: 'neumann@college.edu', phone: '+1-555-0109', maxDay: 3, maxWeek: 15 },
    { username: 'faculty10', name: 'Dr. Barbara Liskov', dept: cseDept, email: 'liskov@college.edu', phone: '+1-555-0110', maxDay: 4, maxWeek: 18 }
  ];

  const facultyIds = {};
  for (const f of facultyRoster) {
    const userId = insertUser.run(
      f.username,
      facultyHash,
      'faculty',
      f.name,
      f.email,
      null,
      null
    ).lastInsertRowid;

    const facId = insertFaculty.run(
      userId,
      f.name,
      f.dept,
      f.email,
      f.phone,
      f.maxDay,
      f.maxWeek,
      1
    ).lastInsertRowid;

    updateUserFacultyId.run(facId, userId);
    facultyIds[f.username] = facId;
  }

  // Insert primary faculty account: alan (mapped to Dr. Alan Turing)
  const alanUserId = insertUser.run(
    'alan',
    facultyHash,
    'faculty',
    'Dr. Alan Turing',
    'turing@college.edu',
    facultyIds['faculty1'],
    null
  ).lastInsertRowid;
  updateUserFacultyId.run(facultyIds['faculty1'], alanUserId);

  // Insert faculty account: donald (mapped to Prof. Donald Knuth)
  const donaldHash = bcrypt.hashSync('donald@123$', passwordSaltRounds);
  const donaldUserId = insertUser.run(
    'donald',
    donaldHash,
    'faculty',
    'Prof. Donald Knuth',
    'knuth@college.edu',
    facultyIds['faculty3'],
    null
  ).lastInsertRowid;
  updateUserFacultyId.run(facultyIds['faculty3'], donaldUserId);

  // Also insert alias 'faculty'
  insertUser.run(
    'faculty',
    facultyHash,
    'faculty',
    'Dr. Alan Turing',
    'faculty@college.edu',
    facultyIds['faculty1'],
    null
  );

  // Insert 4 Students
  const studentRoster = [
    { username: 'student1', name: 'Alex Mercer', email: 'alex.mercer@student.college.edu', sectionId: sectionIds.csea },
    { username: 'student2', name: 'Beth Harmon', email: 'beth.harmon@student.college.edu', sectionId: sectionIds.cseb },
    { username: 'student3', name: 'Chris Taylor', email: 'chris.taylor@student.college.edu', sectionId: sectionIds.ita },
    { username: 'student4', name: 'Dana Scully', email: 'dana.scully@student.college.edu', sectionId: sectionIds.ecea }
  ];

  for (const s of studentRoster) {
    insertUser.run(
      s.username,
      studentHash,
      'student',
      s.name,
      s.email,
      null,
      s.sectionId
    );
  }

  // Insert primary student account: jhenkhar
  insertUser.run(
    'jhenkhar',
    studentHash,
    'student',
    'Jhenkhar Gowda',
    'jhenkhar@student.college.edu',
    null,
    sectionIds.csea
  );

  // Also insert alias 'student'
  insertUser.run(
    'student',
    studentHash,
    'student',
    'Student Account (Alex Mercer)',
    'student@college.edu',
    null,
    sectionIds.csea
  );

  // 8. Faculty Qualifications (faculty_subjects)
  const insertFacSub = db.prepare('INSERT INTO faculty_subjects (faculty_id, subject_id) VALUES (?, ?)');
  const qualifications = [
    // Dr. Alan Turing -> CS201 (DS), CS205 (Discrete Math), CS201L (DS Lab)
    { f: 'faculty1', subs: ['CS201', 'CS205', 'CS201L'] },
    // Dr. Grace Hopper -> CS202 (OS), CS206 (Software Eng)
    { f: 'faculty2', subs: ['CS202', 'CS206'] },
    // Prof. Donald Knuth -> CS201 (DS), CS205 (Discrete Math), CS201L (DS Lab)
    { f: 'faculty3', subs: ['CS201', 'CS205', 'CS201L'] },
    // Dr. Ada Lovelace -> CS203 (DBMS), CS203L (DBMS Lab), CS206 (Software Eng)
    { f: 'faculty4', subs: ['CS203', 'CS203L', 'CS206'] },
    // Prof. Claude Shannon -> CS204 (Networks), CS204L (Net Lab), EC201 (Microprocessors)
    { f: 'faculty5', subs: ['CS204', 'CS204L', 'EC201'] },
    // Dr. Tim Berners-Lee -> IT201 (Web Tech), IT202 (Cloud)
    { f: 'faculty6', subs: ['IT201', 'IT202'] },
    // Prof. Linus Torvalds -> CS202 (OS), IT202 (Cloud)
    { f: 'faculty7', subs: ['CS202', 'IT202'] },
    // Dr. Margaret Hamilton -> EC201 (Microprocessors), CS206 (Software Eng)
    { f: 'faculty8', subs: ['EC201', 'CS206'] },
    // Prof. John von Neumann -> EC201 (Microprocessors), CS205 (Discrete Math)
    { f: 'faculty9', subs: ['EC201', 'CS205'] },
    // Dr. Barbara Liskov -> CS203 (DBMS), CS203L (DBMS Lab), CS201 (DS)
    { f: 'faculty10', subs: ['CS203', 'CS203L', 'CS201'] }
  ];

  for (const q of qualifications) {
    const fId = facultyIds[q.f];
    for (const subCode of q.subs) {
      insertFacSub.run(fId, subjectIds[subCode]);
    }
  }

  // 9. Section Subject Assignments (section_subjects)
  const insertSecSub = db.prepare('INSERT INTO section_subjects (section_id, subject_id, faculty_id) VALUES (?, ?, ?)');
  
  // Section CSE-4A
  insertSecSub.run(sectionIds.csea, subjectIds['CS201'], facultyIds['faculty1']); // Turing
  insertSecSub.run(sectionIds.csea, subjectIds['CS202'], facultyIds['faculty2']); // Hopper
  insertSecSub.run(sectionIds.csea, subjectIds['CS203'], facultyIds['faculty4']); // Lovelace
  insertSecSub.run(sectionIds.csea, subjectIds['CS204'], facultyIds['faculty5']); // Shannon
  insertSecSub.run(sectionIds.csea, subjectIds['CS205'], facultyIds['faculty3']); // Knuth
  insertSecSub.run(sectionIds.csea, subjectIds['CS206'], facultyIds['faculty10']); // Liskov
  insertSecSub.run(sectionIds.csea, subjectIds['CS201L'], facultyIds['faculty1']); // Turing
  insertSecSub.run(sectionIds.csea, subjectIds['CS203L'], facultyIds['faculty4']); // Lovelace

  // Section CSE-4B
  insertSecSub.run(sectionIds.cseb, subjectIds['CS201'], facultyIds['faculty3']); // Knuth
  insertSecSub.run(sectionIds.cseb, subjectIds['CS202'], facultyIds['faculty7']); // Torvalds
  insertSecSub.run(sectionIds.cseb, subjectIds['CS203'], facultyIds['faculty10']); // Liskov
  insertSecSub.run(sectionIds.cseb, subjectIds['CS204'], facultyIds['faculty5']); // Shannon
  insertSecSub.run(sectionIds.cseb, subjectIds['CS205'], facultyIds['faculty1']); // Turing
  insertSecSub.run(sectionIds.cseb, subjectIds['CS201L'], facultyIds['faculty3']); // Knuth
  insertSecSub.run(sectionIds.cseb, subjectIds['CS204L'], facultyIds['faculty5']); // Shannon

  // Section IT-4A
  insertSecSub.run(sectionIds.ita, subjectIds['IT201'], facultyIds['faculty6']); // Berners-Lee
  insertSecSub.run(sectionIds.ita, subjectIds['IT202'], facultyIds['faculty7']); // Torvalds
  insertSecSub.run(sectionIds.ita, subjectIds['CS203'], facultyIds['faculty4']); // Lovelace
  insertSecSub.run(sectionIds.ita, subjectIds['CS204'], facultyIds['faculty5']); // Shannon

  // Section ECE-4A
  insertSecSub.run(sectionIds.ecea, subjectIds['EC201'], facultyIds['faculty8']); // Hamilton
  insertSecSub.run(sectionIds.ecea, subjectIds['CS205'], facultyIds['faculty9']); // von Neumann

  // 10. Faculty Availability Grid (all teaching slots across all 6 days)
  const insertAvail = db.prepare(`
    INSERT INTO faculty_availability (faculty_id, day_id, slot_id, is_available)
    VALUES (?, ?, ?, ?)
  `);

  for (const facKey of Object.keys(facultyIds)) {
    const fId = facultyIds[facKey];
    for (const dId of dayIds) {
      for (const slot of slotsConfig) {
        if (!slot.isBreak) {
          // Default available; Knuth takes Saturday off
          const isAvail = (facKey === 'faculty3' && dId === dayIds[5]) ? 0 : 1;
          insertAvail.run(fId, dId, slotIds[slot.no], isAvail);
        }
      }
    }
  }

  // 11. Initial Timetable Version ('active')
  const insertVersion = db.prepare(`
    INSERT INTO timetable_versions (name, status, created_by, notes)
    VALUES (?, ?, ?, ?)
  `);
  const activeVersionId = insertVersion.run(
    'Spring 2026 Master Timetable (Verified Active)',
    'active',
    adminUserId,
    'Official conflict-free seed schedule with active constraints verified.'
  ).lastInsertRowid;

  // 12. Conflict-Free Timetable Entries
  const insertEntry = db.prepare(`
    INSERT INTO timetable_entries 
    (version_id, section_id, subject_id, faculty_id, room_id, day_id, slot_id, is_lab_block, locked)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Sample conflict-free placements for CSE-4A across the week
  // Day 1 (Monday):
  // Period 1 (Slot 1): CS201 with Turing in CR-101
  insertEntry.run(activeVersionId, sectionIds.csea, subjectIds['CS201'], facultyIds['faculty1'], roomIds.classrooms[0], dayIds[0], slotIds[1], 0, 0);
  // Period 2 (Slot 2): CS202 with Hopper in CR-101
  insertEntry.run(activeVersionId, sectionIds.csea, subjectIds['CS202'], facultyIds['faculty2'], roomIds.classrooms[0], dayIds[0], slotIds[2], 0, 0);
  // Period 3 & 4 (Slot 4 & 5): CS201L Lab with Turing in Computing Lab A (contiguous block!)
  insertEntry.run(activeVersionId, sectionIds.csea, subjectIds['CS201L'], facultyIds['faculty1'], roomIds.labs[0], dayIds[0], slotIds[4], 1, 0);
  insertEntry.run(activeVersionId, sectionIds.csea, subjectIds['CS201L'], facultyIds['faculty1'], roomIds.labs[0], dayIds[0], slotIds[5], 1, 0);
  // Period 5 (Slot 7): CS203 with Lovelace in CR-101
  insertEntry.run(activeVersionId, sectionIds.csea, subjectIds['CS203'], facultyIds['faculty4'], roomIds.classrooms[0], dayIds[0], slotIds[7], 0, 0);

  // Day 2 (Tuesday):
  insertEntry.run(activeVersionId, sectionIds.csea, subjectIds['CS204'], facultyIds['faculty5'], roomIds.classrooms[0], dayIds[1], slotIds[1], 0, 0);
  insertEntry.run(activeVersionId, sectionIds.csea, subjectIds['CS205'], facultyIds['faculty3'], roomIds.classrooms[0], dayIds[1], slotIds[2], 0, 0);
  insertEntry.run(activeVersionId, sectionIds.csea, subjectIds['CS201'], facultyIds['faculty1'], roomIds.classrooms[0], dayIds[1], slotIds[4], 0, 0);

  // Day 3 (Wednesday):
  insertEntry.run(activeVersionId, sectionIds.csea, subjectIds['CS206'], facultyIds['faculty10'], roomIds.classrooms[0], dayIds[2], slotIds[1], 0, 0);
  insertEntry.run(activeVersionId, sectionIds.csea, subjectIds['CS202'], facultyIds['faculty2'], roomIds.classrooms[0], dayIds[2], slotIds[2], 0, 0);
  // Lab block CS203L
  insertEntry.run(activeVersionId, sectionIds.csea, subjectIds['CS203L'], facultyIds['faculty4'], roomIds.labs[1], dayIds[2], slotIds[4], 1, 0);
  insertEntry.run(activeVersionId, sectionIds.csea, subjectIds['CS203L'], facultyIds['faculty4'], roomIds.labs[1], dayIds[2], slotIds[5], 1, 0);

  // Day 4 (Thursday):
  insertEntry.run(activeVersionId, sectionIds.csea, subjectIds['CS203'], facultyIds['faculty4'], roomIds.classrooms[0], dayIds[3], slotIds[1], 0, 0);
  insertEntry.run(activeVersionId, sectionIds.csea, subjectIds['CS204'], facultyIds['faculty5'], roomIds.classrooms[0], dayIds[3], slotIds[2], 0, 0);
  insertEntry.run(activeVersionId, sectionIds.csea, subjectIds['CS205'], facultyIds['faculty3'], roomIds.classrooms[0], dayIds[3], slotIds[4], 0, 0);

  // Day 5 (Friday):
  insertEntry.run(activeVersionId, sectionIds.csea, subjectIds['CS201'], facultyIds['faculty1'], roomIds.classrooms[0], dayIds[4], slotIds[1], 0, 0);
  insertEntry.run(activeVersionId, sectionIds.csea, subjectIds['CS206'], facultyIds['faculty10'], roomIds.classrooms[0], dayIds[4], slotIds[2], 0, 0);

  // Non-clashing placements for CSE-4B on Day 1 (Monday) using CR-102 and Knuth/Torvalds
  insertEntry.run(activeVersionId, sectionIds.cseb, subjectIds['CS201'], facultyIds['faculty3'], roomIds.classrooms[1], dayIds[0], slotIds[1], 0, 0);
  insertEntry.run(activeVersionId, sectionIds.cseb, subjectIds['CS202'], facultyIds['faculty7'], roomIds.classrooms[1], dayIds[0], slotIds[2], 0, 0);

  // Placements for IT-4A on Day 1 using CR-103 and Berners-Lee
  insertEntry.run(activeVersionId, sectionIds.ita, subjectIds['IT201'], facultyIds['faculty6'], roomIds.classrooms[2], dayIds[0], slotIds[1], 0, 0);

  // Placements for ECE-4A on Day 1 using CR-104 and Margaret Hamilton
  insertEntry.run(activeVersionId, sectionIds.ecea, subjectIds['EC201'], facultyIds['faculty8'], roomIds.classrooms[3], dayIds[0], slotIds[1], 0, 0);

  // 13. Holidays
  const insertHoliday = db.prepare('INSERT INTO holidays (date, description) VALUES (?, ?)');
  insertHoliday.run('2026-01-26', 'Republic Day');
  insertHoliday.run('2026-03-20', 'Spring Equinox & Founder Day');
  insertHoliday.run('2026-05-01', 'International Workers Day');
  insertHoliday.run('2026-08-15', 'Independence Day');

  // 14. Audit log entry
  const insertAudit = db.prepare('INSERT INTO audit_log (user_id, action, details_json) VALUES (?, ?, ?)');
  insertAudit.run(adminUserId, 'DATABASE_SEEDED', JSON.stringify({
    version: 'Spring 2026 Master Timetable',
    status: 'active',
    facultyCount: 10,
    sectionsCount: 4,
    subjectsCount: 12
  }));
});

  // Execute the transaction
  seedTransaction();

  console.log('\n========================================================================');
  console.log(' [CTAS Seeder] DATABASE SEEDED SUCCESSFULLY WITH SAMPLE DATA');
  console.log('========================================================================');
  console.log(' Hard constraints enforced: PRAGMA foreign_keys=ON, journal_mode=WAL');
  console.log(' UNIQUE indexes active:');
  console.log('   - (version_id, section_id, day_id, slot_id)');
  console.log('   - (version_id, faculty_id, day_id, slot_id)');
  console.log('   - (version_id, room_id, day_id, slot_id)');
  console.log('   - Partial index: only one active timetable_version');
  console.log('------------------------------------------------------------------------');
  console.log(' SECURE CREDENTIALS CONFIGURED:');
  console.log('------------------------------------------------------------------------');
  console.log(' 1. Administrator:');
  console.log('    Username: sharma (alias: admin)');
  console.log(`    Password: ${SEED_PASSWORDS.admin}`);
  console.log('');
  console.log(' 2. Faculty:');
  console.log('    Username: alan (aliases: faculty, donald, faculty1..faculty10)');
  console.log(`    Password: ${SEED_PASSWORDS.faculty} (alan) / donald@123$ (donald)`);
  console.log('    Profile:  Dr. Alan Turing / Prof. Donald Knuth');
  console.log('');
  console.log(' 3. Student:');
  console.log('    Username: jhenkhar (aliases: student, student1..student4)');
  console.log(`    Password: ${SEED_PASSWORDS.student}`);
  console.log('    Profile:  Jhenkhar Gowda (CSE-4A)');
  console.log('========================================================================\n');
  return true;
}

// Auto-run if executed directly
if (process.argv[1] && (process.argv[1].endsWith('seed.js') || process.argv[1].includes('seed.js'))) {
  seedDatabase();
}

export default seedDatabase;

