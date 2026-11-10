import bcrypt from 'bcryptjs';
import { getDatabase } from '../db/connection.js';

/**
 * Register or update a teacher in the system.
 * Initializes their faculty profile, sets their credentials,
 * links them to the specified department (defaults to CSE),
 * populates weekly availability matrix, and ensures their full name
 * and profile details are established.
 *
 * @param {Object} options
 * @param {string} options.username - Login username (e.g. 'manjula')
 * @param {string} options.password - Login password (e.g. 'man2112')
 * @param {string} [options.fullName] - Full display name (e.g. 'Mrs. Manjula H S')
 * @param {string} [options.name] - Alias for fullName
 * @param {string} [options.email] - Email address (e.g. 'manjula@gmail.com')
 * @param {string} [options.phone] - Phone number (e.g. '7374619852')
 * @param {number|string} [options.departmentId] - Department ID
 * @param {string} [options.departmentCode] - Department Code (e.g. 'CSE')
 * @param {string} [options.departmentName] - Department Name (e.g. 'Computer Science & Engineering')
 * @param {number} [options.maxPeriodsPerDay=4] - Max periods per day
 * @param {number} [options.maxPeriodsPerWeek=18] - Max periods per week
 * @param {Object} [customDb] - Optional SQLite database instance
 * @returns {Object} Resulting registration summary
 */
export function registerTeacher(options = {}, customDb = null) {
  const db = customDb || getDatabase();

  const username = (options.username || 'manjula').trim();
  const password = options.password || 'man2112';
  const fullName = (options.fullName || options.name || 'Mrs. Manjula H S').trim();
  const email = (options.email || 'manjula@gmail.com').trim().toLowerCase();
  const phone = (options.phone || '7374619852').trim();
  const maxPeriodsPerDay = options.maxPeriodsPerDay || 4;
  const maxPeriodsPerWeek = options.maxPeriodsPerWeek || 18;

  // 1. Resolve CSE Department (or specified department)
  let deptId = null;
  let departmentRecord = null;

  if (options.departmentId) {
    departmentRecord = db.prepare('SELECT id, name, code FROM departments WHERE id = ?').get(options.departmentId);
    if (departmentRecord) deptId = departmentRecord.id;
  }

  if (!deptId) {
    const targetCode = options.departmentCode || 'CSE';
    departmentRecord = db.prepare(`
      SELECT id, name, code FROM departments 
      WHERE UPPER(code) = UPPER(?) 
         OR LOWER(name) LIKE '%computer science%' 
      LIMIT 1
    `).get(targetCode);

    if (departmentRecord) {
      deptId = departmentRecord.id;
    } else {
      // Create CSE department if not existing
      const insertDept = db.prepare('INSERT INTO departments (name, code) VALUES (?, ?)');
      deptId = insertDept.run(options.departmentName || 'Computer Science & Engineering', targetCode).lastInsertRowid;
      departmentRecord = { id: deptId, name: options.departmentName || 'Computer Science & Engineering', code: targetCode };
    }
  }

  // 2. Hash Password
  const passwordSaltRounds = 10;
  const passwordHash = bcrypt.hashSync(password, passwordSaltRounds);

  // 3. Atomically upsert faculty profile & user login account
  const tx = db.transaction(() => {
    // Check existing records
    let userRow = db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)').get(username);
    let facRow = db.prepare('SELECT * FROM faculty WHERE LOWER(email) = LOWER(?)').get(email);

    if (!facRow && userRow?.faculty_id) {
      facRow = db.prepare('SELECT * FROM faculty WHERE id = ?').get(userRow.faculty_id);
    }

    let facultyId = facRow?.id;
    let userId = userRow?.id;

    // A. Upsert Faculty Profile
    if (facultyId) {
      db.prepare(`
        UPDATE faculty 
        SET name = ?, department_id = ?, email = ?, phone = ?, 
            max_periods_per_day = ?, max_periods_per_week = ?, is_active = 1
        WHERE id = ?
      `).run(fullName, deptId, email, phone, maxPeriodsPerDay, maxPeriodsPerWeek, facultyId);
    } else {
      const facResult = db.prepare(`
        INSERT INTO faculty (name, department_id, email, phone, max_periods_per_day, max_periods_per_week, is_active)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `).run(fullName, deptId, email, phone, maxPeriodsPerDay, maxPeriodsPerWeek);
      facultyId = facResult.lastInsertRowid;
    }

    // B. Upsert User Account
    if (userId) {
      db.prepare(`
        UPDATE users 
        SET password_hash = ?, role = 'faculty', full_name = ?, email = ?, faculty_id = ?
        WHERE id = ?
      `).run(passwordHash, fullName, email, facultyId, userId);
    } else {
      const userResult = db.prepare(`
        INSERT INTO users (username, password_hash, role, full_name, email, faculty_id)
        VALUES (?, ?, 'faculty', ?, ?, ?)
      `).run(username, passwordHash, fullName, email, facultyId);
      userId = userResult.lastInsertRowid;
    }

    // Link faculty.user_id = users.id
    db.prepare('UPDATE faculty SET user_id = ? WHERE id = ?').run(userId, facultyId);

    // C. Initialize Availability Matrix (Mon to Sat for non-break periods)
    const days = db.prepare('SELECT id FROM working_days WHERE is_active = 1').all();
    const slots = db.prepare('SELECT id FROM time_slots WHERE is_break = 0').all();

    const existingAvail = db.prepare('SELECT count(*) as count FROM faculty_availability WHERE faculty_id = ?').get(facultyId);
    if (!existingAvail || existingAvail.count === 0) {
      const insertAvail = db.prepare('INSERT INTO faculty_availability (faculty_id, day_id, slot_id, is_available) VALUES (?, ?, ?, 1)');
      for (const d of days) {
        for (const s of slots) {
          insertAvail.run(facultyId, d.id, s.id);
        }
      }
    }

    return {
      facultyId,
      userId,
      username,
      fullName,
      email,
      phone,
      departmentId: deptId,
      departmentName: departmentRecord?.name,
      departmentCode: departmentRecord?.code
    };
  });

  const registered = tx();
  console.log(`[CTAS] Registered faculty profile: ${registered.fullName} (@${registered.username}) in ${registered.departmentName}`);
  return {
    success: true,
    ...registered
  };
}

export const registerFaculty = registerTeacher;

export default {
  registerTeacher,
  registerFaculty
};
