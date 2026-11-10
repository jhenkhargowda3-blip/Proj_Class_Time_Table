import bcrypt from 'bcryptjs';
import { getDatabase, initSchema } from './connection.js';

// Configured credentials for admin, faculty, and student roles
export const SEED_PASSWORDS = {
  admin: process.env.ADMIN_SEED_PASSWORD || 'sharmajii',
  faculty: process.env.FACULTY_SEED_PASSWORD || 'man2112',
  student: process.env.STUDENT_SEED_PASSWORD || 'rocky(Jg)'
};

export function seedDatabase(customDb, options = {}) {
  const db = customDb || getDatabase();
  initSchema(db);

  const isTestDb = Boolean(process.env.DB_PATH && process.env.DB_PATH.includes('test'));
  const isTestRun = Boolean(options.includeDemo || (isTestDb && process.env.NODE_TEST_CONTEXT && !options.clean));
  console.log(`[CTAS Seeder] Starting database initialization (${isTestRun ? 'test fixtures mode' : 'clean academic data mode'})...`);

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

    // 1. Working Days (Mon to Sat)
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

    // 2. Time Slots (7 Teaching Periods + 2 Breaks)
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

    // 3. User accounts (Admin + Student)
    const passwordSaltRounds = 10;
    const adminHash = bcrypt.hashSync(SEED_PASSWORDS.admin, passwordSaltRounds);
    const studentHash = bcrypt.hashSync(SEED_PASSWORDS.student, passwordSaltRounds);

    const insertUser = db.prepare(`
      INSERT INTO users (username, password_hash, role, full_name, email, faculty_id, student_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

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

    // Insert Student accounts for schedule viewing
    insertUser.run(
      'jhenkhar',
      studentHash,
      'student',
      'Student Account',
      'student@college.edu',
      null,
      null
    );

    insertUser.run(
      'student',
      studentHash,
      'student',
      'Student Account',
      'student@college.edu',
      null,
      null
    );

    insertUser.run(
      'student1',
      studentHash,
      'student',
      'Student Account (CSE-4A)',
      'student1@college.edu',
      null,
      null
    );

    // 4. Timetable Version (Active Master Version)
    const insertVersion = db.prepare(`
      INSERT INTO timetable_versions (name, status, created_by, notes)
      VALUES (?, ?, ?, ?)
    `);
    const activeVersionId = insertVersion.run(
      'Master Academic Timetable',
      'active',
      adminUserId,
      'Official active timetable version ready for course and faculty scheduling.'
    ).lastInsertRowid;

    if (!isTestRun) {
      // Ensure CSE Department exists
      let cseDept = db.prepare("SELECT * FROM departments WHERE code = 'CSE'").get();
      if (!cseDept) {
        const insertDept = db.prepare('INSERT INTO departments (name, code) VALUES (?, ?)');
        const cseId = insertDept.run('Computer Science & Engineering', 'CSE').lastInsertRowid;
        cseDept = { id: cseId, name: 'Computer Science & Engineering', code: 'CSE' };
      }

      // Ensure Mrs. Manjula H S exists with her exact credentials and details
      let manjulaUser = db.prepare("SELECT * FROM users WHERE username = 'manjula'").get();
      let manjulaFaculty = db.prepare("SELECT * FROM faculty WHERE name LIKE '%Manjula%'").get();
      if (!manjulaFaculty && manjulaUser?.faculty_id) {
        manjulaFaculty = db.prepare('SELECT * FROM faculty WHERE id = ?').get(manjulaUser.faculty_id);
      }

      const facultyPass = process.env.FACULTY_SEED_PASSWORD || 'man2112';
      const facultyHash = bcrypt.hashSync(facultyPass, passwordSaltRounds);

      if (!manjulaFaculty) {
        const insertFaculty = db.prepare(`
          INSERT INTO faculty (name, department_id, email, phone, max_periods_per_day, max_periods_per_week, is_active)
          VALUES (?, ?, ?, ?, ?, ?, 1)
        `);
        const facId = insertFaculty.run('Mrs. Manjula H S', cseDept.id, 'manjula@gmail.com', '7374619852', 4, 18).lastInsertRowid;
        manjulaFaculty = { id: facId };
      }

      if (!manjulaUser) {
        const insertUser = db.prepare(`
          INSERT INTO users (username, password_hash, role, full_name, email, faculty_id)
          VALUES (?, ?, 'faculty', ?, ?, ?)
        `);
        const uId = insertUser.run('manjula', facultyHash, 'Mrs. Manjula H S', 'manjula@gmail.com', manjulaFaculty.id).lastInsertRowid;
        manjulaUser = { id: uId };
      }

      db.prepare('UPDATE faculty SET user_id = ? WHERE id = ?').run(manjulaUser.id, manjulaFaculty.id);
      db.prepare('UPDATE users SET faculty_id = ? WHERE id = ?').run(manjulaFaculty.id, manjulaUser.id);

      // Populate availability for Mrs. Manjula H S across active slots
      const days = db.prepare('SELECT id FROM working_days WHERE is_active = 1').all();
      const slots = db.prepare('SELECT id FROM time_slots WHERE is_break = 0').all();
      const existingAvail = db.prepare('SELECT count(*) as count FROM faculty_availability WHERE faculty_id = ?').get(manjulaFaculty.id);
      if (!existingAvail || existingAvail.count === 0) {
        const insertAvail = db.prepare('INSERT INTO faculty_availability (faculty_id, day_id, slot_id, is_available) VALUES (?, ?, ?, 1)');
        for (const d of days) {
          for (const s of slots) {
            insertAvail.run(manjulaFaculty.id, d.id, s.id);
          }
        }
      }

      const insertAudit = db.prepare('INSERT INTO audit_log (user_id, action, details_json) VALUES (?, ?, ?)');
      insertAudit.run(adminUserId, 'SYSTEM_INITIALIZED', JSON.stringify({
        version: 'Master Academic Timetable',
        status: 'active',
        departmentsCount: 1,
        sectionsCount: 0,
        roomsCount: 0,
        holidaysCount: 0,
        facultyCount: 1,
        subjectsCount: 0,
        entriesCount: 0,
        message: 'Clean academic database ready with CSE department and Mrs. Manjula H S.'
      }));

      console.log('\n========================================================================');
      console.log(' [CTAS Seeder] 100% CLEAN MASTER DATABASE INITIALIZED');
      console.log('========================================================================');
      console.log(' - Departments: 1 (Computer Science & Engineering [CSE])');
      console.log(' - Faculty: 1 (Mrs. Manjula H S)');
      console.log(' - Sections: 0 (Empty - ready for real student sections)');
      console.log(' - Rooms: 0 (Empty - ready for real classrooms & labs)');
      console.log(' - Holidays: 0 (Empty - ready for real academic calendar)');
      console.log(' - Subjects: 0 (Empty - ready for real subject records)');
      console.log(' - Timetable Entries: 0 (All periods showing "+ Free")');
      console.log(' - Absences & Substitutions: 0 (Clean history)');
      console.log('------------------------------------------------------------------------');
      console.log(' Administrator Credentials:');
      console.log('    Username: sharma (alias: admin)');
      console.log(`    Password: ${SEED_PASSWORDS.admin}`);
      console.log(' Faculty Credentials:');
      console.log('    Username: manjula');
      console.log(`    Password: ${SEED_PASSWORDS.faculty}`);
      console.log('========================================================================\n');
      return true;
    }

    // --- TEST FIXTURES ONLY (Included exclusively when isTestRun === true) ---
    const insertDept = db.prepare('INSERT INTO departments (name, code) VALUES (?, ?)');
    const cseDept = insertDept.run('Computer Science & Engineering', 'CSE').lastInsertRowid;
    const itDept = insertDept.run('Information Technology', 'IT').lastInsertRowid;
    const eceDept = insertDept.run('Electronics & Communication', 'ECE').lastInsertRowid;

    const insertRoom = db.prepare('INSERT INTO rooms (name, type, capacity, is_active) VALUES (?, ?, ?, ?)');
    const roomIds = { classrooms: [], labs: [] };
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

    const insertSection = db.prepare('INSERT INTO sections (name, semester, department_id, strength) VALUES (?, ?, ?, ?)');
    const sectionIds = {
      csea: insertSection.run('CSE-4A', 4, cseDept, 45).lastInsertRowid,
      cseb: insertSection.run('CSE-4B', 4, cseDept, 42).lastInsertRowid,
      ita: insertSection.run('IT-4A', 4, itDept, 38).lastInsertRowid,
      ecea: insertSection.run('ECE-4A', 4, eceDept, 40).lastInsertRowid
    };

    // Associate student users with default section in test fixtures mode
    db.prepare("UPDATE users SET student_id = ? WHERE role = 'student'").run(sectionIds.csea);

    const insertHoliday = db.prepare('INSERT INTO holidays (date, description) VALUES (?, ?)');
    insertHoliday.run('2026-01-26', 'Republic Day');
    insertHoliday.run('2026-03-20', 'Spring Equinox & Founder Day');
    insertHoliday.run('2026-05-01', 'International Workers Day');
    insertHoliday.run('2026-08-15', 'Independence Day');

    // --- TEST FIXTURES ONLY (Included exclusively when isTestRun === true) ---
    const facultyHash = bcrypt.hashSync(SEED_PASSWORDS.faculty, passwordSaltRounds);
    const insertFaculty = db.prepare(`
      INSERT INTO faculty (user_id, name, department_id, email, phone, max_periods_per_day, max_periods_per_week, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updateUserFacultyId = db.prepare('UPDATE users SET faculty_id = ? WHERE id = ?');
    const updateFacultyUserId = db.prepare('UPDATE faculty SET user_id = ? WHERE id = ?');

    const insertSubject = db.prepare(`
      INSERT INTO subjects (code, name, type, weekly_periods, lab_block_length, department_id, semester)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const subjectsData = [
      { code: 'CS201', name: 'Data Structures & Algorithms', type: 'theory', weekly: 4, labLen: 1, dept: cseDept, sem: 4 },
      { code: 'CS202', name: 'Operating Systems Principles', type: 'theory', weekly: 3, labLen: 1, dept: cseDept, sem: 4 },
      { code: 'CS203', name: 'Database Management Systems', type: 'theory', weekly: 3, labLen: 1, dept: cseDept, sem: 4 },
      { code: 'CS204', name: 'Computer Networks & Protocols', type: 'theory', weekly: 3, labLen: 1, dept: cseDept, sem: 4 },
      { code: 'CS205', name: 'Discrete Mathematics', type: 'theory', weekly: 3, labLen: 1, dept: cseDept, sem: 4 },
      { code: 'CS206', name: 'Software Engineering', type: 'theory', weekly: 3, labLen: 1, dept: cseDept, sem: 4 },
      { code: 'IT201', name: 'Web Application Technologies', type: 'theory', weekly: 4, labLen: 1, dept: itDept, sem: 4 },
      { code: 'IT202', name: 'Cloud Infrastructure & DevOps', type: 'theory', weekly: 3, labLen: 1, dept: itDept, sem: 4 },
      { code: 'EC201', name: 'Microprocessors & Embedded Systems', type: 'theory', weekly: 4, labLen: 1, dept: eceDept, sem: 4 },
      { code: 'CS201L', name: 'Data Structures Lab', type: 'lab', weekly: 2, labLen: 2, dept: cseDept, sem: 4 },
      { code: 'CS203L', name: 'Database Systems Lab', type: 'lab', weekly: 2, labLen: 2, dept: cseDept, sem: 4 },
      { code: 'CS204L', name: 'Computer Networks Lab', type: 'lab', weekly: 2, labLen: 2, dept: cseDept, sem: 4 }
    ];
    const subjectIds = {};
    for (const sub of subjectsData) {
      subjectIds[sub.code] = insertSubject.run(sub.code, sub.name, sub.type, sub.weekly, sub.labLen, sub.dept, sub.sem).lastInsertRowid;
    }

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
      const userId = insertUser.run(f.username, facultyHash, 'faculty', f.name, f.email, null, null).lastInsertRowid;
      const facId = insertFaculty.run(userId, f.name, f.dept, f.email, f.phone, f.maxDay, f.maxWeek, 1).lastInsertRowid;
      updateUserFacultyId.run(facId, userId);
      facultyIds[f.username] = facId;
    }

    const alanUserId = insertUser.run('alan', facultyHash, 'faculty', 'Dr. Alan Turing', 'turing@college.edu', facultyIds['faculty1'], null).lastInsertRowid;
    updateUserFacultyId.run(facultyIds['faculty1'], alanUserId);
    updateFacultyUserId.run(alanUserId, facultyIds['faculty1']);

    const donaldHash = bcrypt.hashSync('donald@123$', passwordSaltRounds);
    const donaldUserId = insertUser.run('donald', donaldHash, 'faculty', 'Prof. Donald Knuth', 'knuth@college.edu', facultyIds['faculty3'], null).lastInsertRowid;
    updateUserFacultyId.run(facultyIds['faculty3'], donaldUserId);
    updateFacultyUserId.run(donaldUserId, facultyIds['faculty3']);

    insertUser.run('faculty', facultyHash, 'faculty', 'Dr. Alan Turing', 'faculty@college.edu', facultyIds['faculty1'], null);

    // Register Mrs. Manjula H S (username: manjula, password: man2112, CSE Department)
    const manjulaHash = bcrypt.hashSync(process.env.FACULTY_SEED_PASSWORD || 'man2112', passwordSaltRounds);
    const manjulaUserId = insertUser.run(
      'manjula',
      manjulaHash,
      'faculty',
      'Mrs. Manjula H S',
      'manjula@gmail.com',
      null,
      null
    ).lastInsertRowid;

    const manjulaFacId = insertFaculty.run(
      manjulaUserId,
      'Mrs. Manjula H S',
      cseDept,
      'manjula@gmail.com',
      '7374619852',
      4,
      18,
      1
    ).lastInsertRowid;

    updateUserFacultyId.run(manjulaFacId, manjulaUserId);
    facultyIds['manjula'] = manjulaFacId;

    const insertFacSub = db.prepare('INSERT INTO faculty_subjects (faculty_id, subject_id) VALUES (?, ?)');
    const qualifications = [
      { f: 'faculty1', subs: ['CS201', 'CS205', 'CS201L'] },
      { f: 'faculty2', subs: ['CS202', 'CS206'] },
      { f: 'faculty3', subs: ['CS201', 'CS205', 'CS201L'] },
      { f: 'faculty4', subs: ['CS203', 'CS203L', 'CS206'] },
      { f: 'faculty5', subs: ['CS204', 'CS204L', 'EC201'] },
      { f: 'faculty6', subs: ['IT201', 'IT202'] },
      { f: 'faculty7', subs: ['CS202', 'IT202'] },
      { f: 'faculty8', subs: ['EC201', 'CS206'] },
      { f: 'faculty9', subs: ['EC201', 'CS205'] },
      { f: 'faculty10', subs: ['CS203', 'CS203L', 'CS201'] },
      { f: 'manjula', subs: ['CS201', 'CS203', 'CS201L'] }
    ];
    for (const q of qualifications) {
      const fId = facultyIds[q.f];
      for (const subCode of q.subs) {
        insertFacSub.run(fId, subjectIds[subCode]);
      }
    }

    const insertSecSub = db.prepare('INSERT INTO section_subjects (section_id, subject_id, faculty_id) VALUES (?, ?, ?)');
    insertSecSub.run(sectionIds.csea, subjectIds['CS201'], facultyIds['faculty1']);
    insertSecSub.run(sectionIds.csea, subjectIds['CS202'], facultyIds['faculty2']);
    insertSecSub.run(sectionIds.csea, subjectIds['CS203'], facultyIds['faculty4']);
    insertSecSub.run(sectionIds.csea, subjectIds['CS204'], facultyIds['faculty5']);
    insertSecSub.run(sectionIds.csea, subjectIds['CS205'], facultyIds['faculty3']);
    insertSecSub.run(sectionIds.csea, subjectIds['CS206'], facultyIds['faculty10']);
    insertSecSub.run(sectionIds.csea, subjectIds['CS201L'], facultyIds['faculty1']);
    insertSecSub.run(sectionIds.csea, subjectIds['CS203L'], facultyIds['faculty4']);

    insertSecSub.run(sectionIds.cseb, subjectIds['CS201'], facultyIds['faculty3']);
    insertSecSub.run(sectionIds.cseb, subjectIds['CS202'], facultyIds['faculty7']);
    insertSecSub.run(sectionIds.cseb, subjectIds['CS203'], facultyIds['faculty10']);
    insertSecSub.run(sectionIds.cseb, subjectIds['CS204'], facultyIds['faculty5']);
    insertSecSub.run(sectionIds.cseb, subjectIds['CS205'], facultyIds['faculty1']);
    insertSecSub.run(sectionIds.cseb, subjectIds['CS201L'], facultyIds['faculty3']);
    insertSecSub.run(sectionIds.cseb, subjectIds['CS204L'], facultyIds['faculty5']);

    insertSecSub.run(sectionIds.ita, subjectIds['IT201'], facultyIds['faculty6']);
    insertSecSub.run(sectionIds.ita, subjectIds['IT202'], facultyIds['faculty7']);
    insertSecSub.run(sectionIds.ita, subjectIds['CS203'], facultyIds['faculty4']);
    insertSecSub.run(sectionIds.ita, subjectIds['CS204'], facultyIds['faculty5']);

    insertSecSub.run(sectionIds.ecea, subjectIds['EC201'], facultyIds['faculty8']);
    insertSecSub.run(sectionIds.ecea, subjectIds['CS205'], facultyIds['faculty9']);

    const insertAvail = db.prepare('INSERT INTO faculty_availability (faculty_id, day_id, slot_id, is_available) VALUES (?, ?, ?, ?)');
    for (const facKey of Object.keys(facultyIds)) {
      const fId = facultyIds[facKey];
      for (const dId of dayIds) {
        for (const slot of slotsConfig) {
          if (!slot.isBreak) {
            const isAvail = (facKey === 'faculty3' && dId === dayIds[5]) ? 0 : 1;
            insertAvail.run(fId, dId, slotIds[slot.no], isAvail);
          }
        }
      }
    }

    const insertEntry = db.prepare(`
      INSERT INTO timetable_entries 
      (version_id, section_id, subject_id, faculty_id, room_id, day_id, slot_id, is_lab_block, locked)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertEntry.run(activeVersionId, sectionIds.csea, subjectIds['CS201'], facultyIds['faculty1'], roomIds.classrooms[0], dayIds[0], slotIds[1], 0, 0);
    insertEntry.run(activeVersionId, sectionIds.csea, subjectIds['CS202'], facultyIds['faculty2'], roomIds.classrooms[0], dayIds[0], slotIds[2], 0, 0);
    insertEntry.run(activeVersionId, sectionIds.csea, subjectIds['CS201L'], facultyIds['faculty1'], roomIds.labs[0], dayIds[0], slotIds[4], 1, 0);
    insertEntry.run(activeVersionId, sectionIds.csea, subjectIds['CS201L'], facultyIds['faculty1'], roomIds.labs[0], dayIds[0], slotIds[5], 1, 0);
    insertEntry.run(activeVersionId, sectionIds.csea, subjectIds['CS203'], facultyIds['faculty4'], roomIds.classrooms[0], dayIds[0], slotIds[7], 0, 0);

    insertEntry.run(activeVersionId, sectionIds.csea, subjectIds['CS204'], facultyIds['faculty5'], roomIds.classrooms[0], dayIds[1], slotIds[1], 0, 0);
    insertEntry.run(activeVersionId, sectionIds.csea, subjectIds['CS205'], facultyIds['faculty3'], roomIds.classrooms[0], dayIds[1], slotIds[2], 0, 0);
    insertEntry.run(activeVersionId, sectionIds.csea, subjectIds['CS201'], facultyIds['faculty1'], roomIds.classrooms[0], dayIds[1], slotIds[4], 0, 0);

    insertEntry.run(activeVersionId, sectionIds.csea, subjectIds['CS206'], facultyIds['faculty10'], roomIds.classrooms[0], dayIds[2], slotIds[1], 0, 0);
    insertEntry.run(activeVersionId, sectionIds.csea, subjectIds['CS202'], facultyIds['faculty2'], roomIds.classrooms[0], dayIds[2], slotIds[2], 0, 0);
    insertEntry.run(activeVersionId, sectionIds.csea, subjectIds['CS203L'], facultyIds['faculty4'], roomIds.labs[1], dayIds[2], slotIds[4], 1, 0);
    insertEntry.run(activeVersionId, sectionIds.csea, subjectIds['CS203L'], facultyIds['faculty4'], roomIds.labs[1], dayIds[2], slotIds[5], 1, 0);

    insertEntry.run(activeVersionId, sectionIds.csea, subjectIds['CS203'], facultyIds['faculty4'], roomIds.classrooms[0], dayIds[3], slotIds[1], 0, 0);
    insertEntry.run(activeVersionId, sectionIds.csea, subjectIds['CS204'], facultyIds['faculty5'], roomIds.classrooms[0], dayIds[3], slotIds[2], 0, 0);
    insertEntry.run(activeVersionId, sectionIds.csea, subjectIds['CS205'], facultyIds['faculty3'], roomIds.classrooms[0], dayIds[3], slotIds[4], 0, 0);

    insertEntry.run(activeVersionId, sectionIds.csea, subjectIds['CS201'], facultyIds['faculty1'], roomIds.classrooms[0], dayIds[4], slotIds[1], 0, 0);
    insertEntry.run(activeVersionId, sectionIds.csea, subjectIds['CS206'], facultyIds['faculty10'], roomIds.classrooms[0], dayIds[4], slotIds[2], 0, 0);

    insertEntry.run(activeVersionId, sectionIds.cseb, subjectIds['CS201'], facultyIds['faculty3'], roomIds.classrooms[1], dayIds[0], slotIds[1], 0, 0);
    insertEntry.run(activeVersionId, sectionIds.cseb, subjectIds['CS202'], facultyIds['faculty7'], roomIds.classrooms[1], dayIds[0], slotIds[2], 0, 0);
    insertEntry.run(activeVersionId, sectionIds.ita, subjectIds['IT201'], facultyIds['faculty6'], roomIds.classrooms[2], dayIds[0], slotIds[1], 0, 0);
    insertEntry.run(activeVersionId, sectionIds.ecea, subjectIds['EC201'], facultyIds['faculty8'], roomIds.classrooms[3], dayIds[0], slotIds[1], 0, 0);

    const insertAudit = db.prepare('INSERT INTO audit_log (user_id, action, details_json) VALUES (?, ?, ?)');
    insertAudit.run(adminUserId, 'DATABASE_SEEDED', JSON.stringify({
      version: 'Spring 2026 Master Timetable (Test Fixtures)',
      status: 'active',
      facultyCount: 10,
      sectionsCount: 4,
      subjectsCount: 12
    }));
  });

  seedTransaction();
  return true;
}

// Auto-run if executed directly
if (process.argv[1] && (process.argv[1].endsWith('seed.js') || process.argv[1].includes('seed.js'))) {
  seedDatabase();
}

export default seedDatabase;

