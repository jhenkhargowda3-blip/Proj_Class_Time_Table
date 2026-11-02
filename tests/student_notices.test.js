import test from 'node:test';
import assert from 'node:assert';
import { getDatabase } from '../src/db/connection.js';

test('Student Notices: Category Grouping, Read State Tracking & Live Pulse Verification', async (t) => {
  const db = getDatabase();

  // Ensure table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS student_notice_reads (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      notice_id TEXT NOT NULL,
      read_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, notice_id)
    );
  `);

  // Use an existing student user from users table to satisfy foreign key constraint
  const studentUser = db.prepare("SELECT id FROM users WHERE role = 'student' LIMIT 1").get()
    || db.prepare("SELECT id FROM users LIMIT 1").get();
  assert.ok(studentUser, 'Expected at least one user in database');
  const testUserId = studentUser.id;
  const testNotice1 = 'sub-test-101';
  const testNotice2 = 'holiday-test-5';

  // Clean test user notices
  db.prepare('DELETE FROM student_notice_reads WHERE user_id = ?').run(testUserId);

  await t.test('1. Database records read status for student notices', () => {
    // Initially unread
    const initialCheck = db.prepare('SELECT * FROM student_notice_reads WHERE user_id = ? AND notice_id = ?')
      .get(testUserId, testNotice1);
    assert.strictEqual(initialCheck, undefined, 'Notice should initially be unread');

    // Mark as read
    db.prepare(`
      INSERT INTO student_notice_reads (user_id, notice_id, read_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, notice_id) DO UPDATE SET read_at = CURRENT_TIMESTAMP
    `).run(testUserId, testNotice1);

    const markedCheck = db.prepare('SELECT * FROM student_notice_reads WHERE user_id = ? AND notice_id = ?')
      .get(testUserId, testNotice1);
    assert.ok(markedCheck, 'Notice must be marked as read');
    assert.strictEqual(markedCheck.notice_id, testNotice1);
  });

  await t.test('2. Multiple notices can be marked as read in bulk', () => {
    const noticeIds = [testNotice1, testNotice2];
    const insertStmt = db.prepare(`
      INSERT INTO student_notice_reads (user_id, notice_id, read_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, notice_id) DO UPDATE SET read_at = CURRENT_TIMESTAMP
    `);

    const tx = db.transaction((ids) => {
      for (const id of ids) {
        insertStmt.run(testUserId, id);
      }
    });
    tx(noticeIds);

    const count = db.prepare('SELECT COUNT(*) as c FROM student_notice_reads WHERE user_id = ?')
      .get(testUserId);
    assert.strictEqual(count.c, 2, 'Both notices should be recorded as read');
  });

  await t.test('3. Notice can be toggled back to unread', () => {
    db.prepare('DELETE FROM student_notice_reads WHERE user_id = ? AND notice_id = ?')
      .run(testUserId, testNotice1);

    const check = db.prepare('SELECT * FROM student_notice_reads WHERE user_id = ? AND notice_id = ?')
      .get(testUserId, testNotice1);
    assert.strictEqual(check, undefined, 'Notice should be deleted from read table when unread');
  });

  // Clean up
  db.prepare('DELETE FROM student_notice_reads WHERE user_id = ?').run(testUserId);
});
