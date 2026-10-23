import { Router } from 'express';
import { getDatabase } from '../db/connection.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/role.js';
import { generateTimetable, isGenerationInProgress, getGenerationState } from '../services/scheduler.js';
import { validateTimetable, validateMove } from '../services/validator.js';
import { broadcast } from '../services/sse.js';

const router = Router();

// 0. Generation Status Tracker (Admin/Faculty/Student)
router.get('/generation-status', requireAuth, (req, res) => {
  res.json(getGenerationState());
});

// 1. Generate New Timetable (Admin Only)
router.post('/generate', requireAuth, requireRole('admin'), (req, res) => {
  try {
    if (isGenerationInProgress()) {
      return res.status(409).json({
        error: 'A timetable generation computation is currently active in the background. Please wait for completion.',
        state: getGenerationState()
      });
    }

    const result = generateTimetable({
      createdBy: req.user.id,
      name: req.body.name,
      maxDurationMs: req.body.maxDurationMs || 20000,
      maxAttempts: req.body.maxAttempts || 5
    });

    if (!result.success) {
      if (result.alreadyRunning) {
        return res.status(409).json({
          error: result.reason || 'A timetable generation computation is currently active in the background. Please wait for completion.',
          state: result.state || getGenerationState()
        });
      }
      return res.status(422).json({
        error: result.reason || 'Failed to generate feasible timetable',
        infeasible: result.infeasible || false
      });
    }

    // Broadcast real-time update
    broadcast('timetable.updated', {
      type: 'version_generated',
      versionId: result.versionId,
      versionName: result.versionName
    });

    res.status(201).json(result);
  } catch (err) {
    console.error('[CTAS Scheduler Error]', err);
    res.status(500).json({ error: err.message || 'Generation failed' });
  }
});

// 2. List Timetable Versions
router.get('/versions', requireAuth, (req, res) => {
  const db = getDatabase();
  const versions = db.prepare(`
    SELECT tv.*, u.full_name as created_by_name,
           COUNT(te.id) as entries_count
    FROM timetable_versions tv
    LEFT JOIN users u ON tv.created_by = u.id
    LEFT JOIN timetable_entries te ON tv.id = te.version_id
    GROUP BY tv.id
    ORDER BY tv.created_at DESC
  `).all();

  res.json({ versions });
});

// 3. Get Full Timetable Version Details & Grid Entries
router.get('/versions/:id', requireAuth, (req, res) => {
  const db = getDatabase();
  const versionId = parseInt(req.params.id, 10);

  const version = db.prepare(`
    SELECT tv.*, u.full_name as created_by_name
    FROM timetable_versions tv
    LEFT JOIN users u ON tv.created_by = u.id
    WHERE tv.id = ?
  `).get(versionId);

  if (!version) {
    return res.status(404).json({ error: 'Timetable version not found' });
  }

  const entries = db.prepare(`
    SELECT te.*, s.name as subject_name, s.code as subject_code, s.type as subject_type,
           sec.name as section_name, sec.semester,
           f.name as faculty_name, f.email as faculty_email,
           r.name as room_name, r.type as room_type, r.capacity as room_capacity,
           wd.day_name, wd.day_index,
           ts.slot_no, ts.start_time, ts.end_time, ts.is_break, ts.label as slot_label
    FROM timetable_entries te
    JOIN subjects s ON te.subject_id = s.id
    JOIN sections sec ON te.section_id = sec.id
    JOIN faculty f ON te.faculty_id = f.id
    JOIN rooms r ON te.room_id = r.id
    JOIN working_days wd ON te.day_id = wd.id
    JOIN time_slots ts ON te.slot_id = ts.id
    WHERE te.version_id = ?
    ORDER BY wd.day_index, ts.slot_no
  `).all(versionId);

  const validation = validateTimetable(versionId);

  res.json({
    version,
    entries,
    validation
  });
});

// 4. Activate Timetable Version (Admin Only - Validated Before Activation)
router.post('/versions/:id/activate', requireAuth, requireRole('admin'), (req, res) => {
  const db = getDatabase();
  const versionId = parseInt(req.params.id, 10);

  const targetVersion = db.prepare('SELECT * FROM timetable_versions WHERE id = ?').get(versionId);
  if (!targetVersion) {
    return res.status(404).json({ error: 'Timetable version not found' });
  }

  // Pre-activation hard constraint check
  const validation = validateTimetable(versionId);
  if (!validation.isValid) {
    return res.status(400).json({
      error: 'Cannot activate timetable: Validator found hard constraint violations.',
      violations: validation.violations
    });
  }

  // Atomic activation transaction
  const activateTx = db.transaction(() => {
    // Archive currently active version
    db.prepare("UPDATE timetable_versions SET status = 'archived' WHERE status = 'active'").run();
    // Activate target version
    db.prepare("UPDATE timetable_versions SET status = 'active' WHERE id = ?").run(versionId);

    db.prepare('INSERT INTO audit_log (user_id, action, details_json) VALUES (?, ?, ?)').run(
      req.user.id,
      'TIMETABLE_ACTIVATED',
      JSON.stringify({ versionId, versionName: targetVersion.name })
    );
  });

  activateTx();

  broadcast('timetable.updated', {
    type: 'version_activated',
    versionId,
    versionName: targetVersion.name
  });

  res.json({
    success: true,
    message: `Timetable '${targetVersion.name}' is now active.`,
    activeVersionId: versionId
  });
});

// 5. Live Drag & Drop Move Validation Endpoint
router.post('/validate-move', requireAuth, requireRole('admin'), (req, res) => {
  const { versionId, entryId, targetDayId, targetSlotId, targetRoomId, targetFacultyId } = req.body;
  if (!versionId || !entryId || !targetDayId || !targetSlotId) {
    return res.status(400).json({ error: 'Missing required parameters for move validation' });
  }

  const result = validateMove({
    versionId,
    entryId,
    targetDayId,
    targetSlotId,
    targetRoomId,
    targetFacultyId
  });

  res.json(result);
});

// 6. Execute Move or Cell Update
router.post('/entries/:id/move', requireAuth, requireRole('admin'), (req, res) => {
  const entryId = parseInt(req.params.id, 10);
  const { targetDayId, targetSlotId, targetRoomId, targetFacultyId, overrideWarnings } = req.body;
  const db = getDatabase();

  const entry = db.prepare('SELECT * FROM timetable_entries WHERE id = ?').get(entryId);
  if (!entry) {
    return res.status(404).json({ error: 'Timetable entry not found' });
  }

  const validation = validateMove({
    versionId: entry.version_id,
    entryId,
    targetDayId,
    targetSlotId,
    targetRoomId: targetRoomId || entry.room_id,
    targetFacultyId: targetFacultyId || entry.faculty_id
  });

  if (!validation.isValid) {
    return res.status(400).json({
      error: 'Move rejected by deterministic conflict validator',
      violations: validation.violations
    });
  }

  if (validation.warningCount > 0 && !overrideWarnings) {
    return res.status(409).json({
      warning: true,
      message: 'Move creates soft constraint warnings. Confirm override to proceed.',
      violations: validation.violations
    });
  }

  // Update entry in database
  db.prepare(`
    UPDATE timetable_entries
    SET day_id = ?, slot_id = ?, room_id = ?, faculty_id = ?
    WHERE id = ?
  `).run(
    targetDayId,
    targetSlotId,
    targetRoomId || entry.room_id,
    targetFacultyId || entry.faculty_id,
    entryId
  );

  broadcast('timetable.updated', {
    type: 'entry_moved',
    entryId,
    versionId: entry.version_id
  });

  res.json({
    success: true,
    message: 'Timetable entry moved successfully',
    validation
  });
});

// 7. Duplicate Timetable Version
router.post('/versions/:id/duplicate', requireAuth, requireRole('admin'), (req, res) => {
  const sourceId = parseInt(req.params.id, 10);
  const db = getDatabase();

  const source = db.prepare('SELECT * FROM timetable_versions WHERE id = ?').get(sourceId);
  if (!source) return res.status(404).json({ error: 'Version not found' });

  const cloneTx = db.transaction(() => {
    const newVersionName = `${source.name} (Copy)`;
    const newVersion = db.prepare(`
      INSERT INTO timetable_versions (name, status, created_by, notes)
      VALUES (?, 'draft', ?, ?)
    `).run(newVersionName, req.user.id, `Cloned from Version #${sourceId}`);

    const newId = newVersion.lastInsertRowid;

    // Clone all entries
    const sourceEntries = db.prepare('SELECT * FROM timetable_entries WHERE version_id = ?').all(sourceId);
    const insertEntry = db.prepare(`
      INSERT INTO timetable_entries (version_id, section_id, subject_id, faculty_id, room_id, day_id, slot_id, is_lab_block, locked)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const e of sourceEntries) {
      insertEntry.run(newId, e.section_id, e.subject_id, e.faculty_id, e.room_id, e.day_id, e.slot_id, e.is_lab_block, e.locked);
    }

    return { newId, newVersionName, count: sourceEntries.length };
  });

  const result = cloneTx();
  res.status(201).json({
    success: true,
    message: `Created duplicate version '${result.newVersionName}' with ${result.count} entries.`,
    versionId: result.newId
  });
});

// 8. Archive Timetable Version
router.post('/versions/:id/archive', requireAuth, requireRole('admin'), (req, res) => {
  const versionId = parseInt(req.params.id, 10);
  const db = getDatabase();

  db.prepare("UPDATE timetable_versions SET status = 'archived' WHERE id = ?").run(versionId);
  res.json({ success: true, message: 'Version archived successfully' });
});

// 9. Delete Timetable Version (Draft or Archived only)
router.delete('/versions/:id', requireAuth, requireRole('admin'), (req, res) => {
  const versionId = parseInt(req.params.id, 10);
  const db = getDatabase();

  const version = db.prepare('SELECT * FROM timetable_versions WHERE id = ?').get(versionId);
  if (!version) return res.status(404).json({ error: 'Version not found' });

  if (version.status === 'active') {
    return res.status(400).json({ error: 'Cannot delete the active timetable version. Activate another version first.' });
  }

  db.prepare('DELETE FROM timetable_versions WHERE id = ?').run(versionId);
  res.json({ success: true, message: 'Version deleted successfully' });
});

// 10. Update or Lock Single Entry
router.put('/entries/:id', requireAuth, requireRole('admin'), (req, res) => {
  const entryId = parseInt(req.params.id, 10);
  const { facultyId, roomId, subjectId, locked } = req.body;
  const db = getDatabase();

  const entry = db.prepare('SELECT * FROM timetable_entries WHERE id = ?').get(entryId);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });

  db.prepare(`
    UPDATE timetable_entries
    SET faculty_id = COALESCE(?, faculty_id),
        room_id = COALESCE(?, room_id),
        subject_id = COALESCE(?, subject_id),
        locked = COALESCE(?, locked)
    WHERE id = ?
  `).run(facultyId ?? null, roomId ?? null, subjectId ?? null, locked ?? null, entryId);

  res.json({ success: true, message: 'Entry updated successfully' });
});

// 11. Delete Single Timetable Entry
router.delete('/entries/:id', requireAuth, requireRole('admin'), (req, res) => {
  const entryId = parseInt(req.params.id, 10);
  const db = getDatabase();

  db.prepare('DELETE FROM timetable_entries WHERE id = ?').run(entryId);
  res.json({ success: true, message: 'Timetable entry removed' });
});

// 12. Export Version to CSV
router.get('/versions/:id/export.csv', requireAuth, (req, res) => {
  const versionId = parseInt(req.params.id, 10);
  const db = getDatabase();

  const version = db.prepare('SELECT name FROM timetable_versions WHERE id = ?').get(versionId);
  if (!version) return res.status(404).send('Version not found');

  const entries = db.prepare(`
    SELECT wd.day_name, ts.slot_no, ts.start_time, ts.end_time,
           sec.name as section_name, s.code as subject_code, s.name as subject_name,
           f.name as faculty_name, r.name as room_name, s.type as subject_type
    FROM timetable_entries te
    JOIN working_days wd ON te.day_id = wd.id
    JOIN time_slots ts ON te.slot_id = ts.id
    JOIN sections sec ON te.section_id = sec.id
    JOIN subjects s ON te.subject_id = s.id
    JOIN faculty f ON te.faculty_id = f.id
    JOIN rooms r ON te.room_id = r.id
    WHERE te.version_id = ?
    ORDER BY wd.day_index, ts.slot_no, sec.name
  `).all(versionId);

  let csv = 'Day,Period,Start Time,End Time,Section,Subject Code,Subject Name,Faculty,Room,Type\n';
  for (const e of entries) {
    csv += `"${e.day_name}","Period ${e.slot_no}","${e.start_time}","${e.end_time}","${e.section_name}","${e.subject_code}","${e.subject_name.replace(/"/g, '""')}","${e.faculty_name}","${e.room_name}","${e.subject_type}"\n`;
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="timetable_v${versionId}_export.csv"`);
  res.send(csv);
});

// 13. Export Version to ICS (iCalendar)
router.get('/versions/:id/export.ics', requireAuth, (req, res) => {
  const versionId = parseInt(req.params.id, 10);
  const db = getDatabase();

  const version = db.prepare('SELECT name FROM timetable_versions WHERE id = ?').get(versionId);
  if (!version) return res.status(404).send('Version not found');

  const entries = db.prepare(`
    SELECT wd.day_name, wd.day_index, ts.slot_no, ts.start_time, ts.end_time,
           sec.name as section_name, s.code as subject_code, s.name as subject_name,
           f.name as faculty_name, r.name as room_name, s.type as subject_type
    FROM timetable_entries te
    JOIN working_days wd ON te.day_id = wd.id
    JOIN time_slots ts ON te.slot_id = ts.id
    JOIN sections sec ON te.section_id = sec.id
    JOIN subjects s ON te.subject_id = s.id
    JOIN faculty f ON te.faculty_id = f.id
    JOIN rooms r ON te.room_id = r.id
    WHERE te.version_id = ?
    ORDER BY wd.day_index, ts.slot_no, sec.name
  `).all(versionId);

  const dayCodeMap = { 0: 'SU', 1: 'MO', 2: 'TU', 3: 'WE', 4: 'TH', 5: 'FR', 6: 'SA' };
  const now = new Date();
  const currentDay = now.getDay();
  const diffToMonday = currentDay === 0 ? -6 : 1 - currentDay;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diffToMonday);

  const icsLines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//CTAS//Class Timetable Automation System//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${version.name.replace(/[,;\\]/g, '')}`,
    'X-WR-TIMEZONE:UTC'
  ];

  entries.forEach((e, idx) => {
    const dayCode = dayCodeMap[e.day_index] || 'MO';
    const targetDate = new Date(monday);
    const offset = e.day_index === 0 ? 6 : e.day_index - 1;
    targetDate.setDate(monday.getDate() + offset);

    const dateStr = targetDate.toISOString().slice(0, 10).replace(/-/g, '');
    const startTimeClean = (e.start_time || '09:00').replace(/[^0-9]/g, '').slice(0, 4) + '00';
    const endTimeClean = (e.end_time || '10:00').replace(/[^0-9]/g, '').slice(0, 4) + '00';

    icsLines.push(
      'BEGIN:VEVENT',
      `UID:ctas-v${versionId}-${idx}-${Date.now()}@ctas.college.edu`,
      `DTSTAMP:${dateStr}T000000Z`,
      `DTSTART:${dateStr}T${startTimeClean}`,
      `DTEND:${dateStr}T${endTimeClean}`,
      `RRULE:FREQ=WEEKLY;BYDAY=${dayCode}`,
      `SUMMARY:${(e.subject_code ? e.subject_code + ': ' : '') + e.subject_name}`.replace(/[,;\\]/g, ''),
      `LOCATION:${e.room_name}`.replace(/[,;\\]/g, ''),
      `DESCRIPTION:Instructor: ${e.faculty_name}\\nSection: ${e.section_name}\\nSubject: ${e.subject_name}`.replace(/[,;\\]/g, ''),
      'STATUS:CONFIRMED',
      'END:VEVENT'
    );
  });

  icsLines.push('END:VCALENDAR');

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="timetable_v${versionId}.ics"`);
  res.send(icsLines.join('\r\n'));
});

export default router;

