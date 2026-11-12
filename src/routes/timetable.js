import { Router } from 'express';
import { getDatabase } from '../db/connection.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/role.js';
import { generateTimetable, generateDraftWithConflicts, isGenerationInProgress, getGenerationState } from '../services/scheduler.js';
import { validateTimetable, validateMove } from '../services/validator.js';
import { broadcast } from '../services/sse.js';
import { getProjectedTimetableEntries, getUnassignedSessions, assignSessionSection, assignSessionRoom } from '../services/referenceDataService.js';

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

    let result;
    if (req.body.regenerate) {
      result = generateTimetable({
        createdBy: req.user.id,
        name: req.body.name,
        sectionId: req.body.sectionId ? parseInt(req.body.sectionId, 10) : null,
        currentVersionId: req.body.currentVersionId ? parseInt(req.body.currentVersionId, 10) : null,
        regenerate: true,
        maxDurationMs: req.body.maxDurationMs || 20000,
        maxAttempts: req.body.maxAttempts || 5
      });
    } else {
      result = generateDraftWithConflicts({
        createdBy: req.user.id,
        name: req.body.name,
        sectionId: req.body.sectionId ? parseInt(req.body.sectionId, 10) : null
      });
    }

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

    if (req.body.publishNow && result.versionId && !result.hasConflicts && (!result.conflictsCount || result.conflictsCount === 0)) {
      const db = getDatabase();
      db.prepare("UPDATE timetable_versions SET status = 'archived' WHERE status = 'active'").run();
      db.prepare("UPDATE timetable_versions SET status = 'active' WHERE id = ?").run(result.versionId);
      result.status = 'active';

      broadcast('timetable.updated', {
        type: 'version_activated',
        versionId: result.versionId,
        versionName: result.versionName
      });
    } else {
      // Broadcast real-time update
      broadcast('timetable.updated', {
        type: 'version_generated',
        versionId: result.versionId,
        versionName: result.versionName
      });
    }

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
           CASE
             WHEN COUNT(te.id) > 0 THEN COUNT(te.id)
             WHEN tv.source = 'imported_verified' THEN (SELECT COUNT(*) FROM faculty_sessions)
             ELSE 0
           END as entries_count
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

  let entries = db.prepare(`
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

  // If timetable_entries is empty, populate and read imported sessions from faculty_sessions
  if (entries.length === 0) {
    entries = getProjectedTimetableEntries(db, versionId);
  }

  const unassignedSessions = getUnassignedSessions(db);
  const validation = validateTimetable(entries, { skipPeriodCountCheck: true });

  res.json({
    version,
    entries,
    unassignedSessions,
    validation
  });
});

// 3.1 Get Unassigned Sessions
router.get('/unassigned-sessions', requireAuth, (req, res) => {
  const db = getDatabase();
  res.json({ sessions: getUnassignedSessions(db) });
});

// 3.2 Assign Section permanently to a session
router.put('/sessions/:id/assign-section', requireAuth, requireRole('admin'), (req, res) => {
  const sessionId = req.params.id;
  const { section } = req.body;
  if (!section) {
    return res.status(400).json({ error: 'Section is required' });
  }

  const db = getDatabase();
  const updated = assignSessionSection(sessionId, section, db);

  broadcast('timetable.updated', {
    type: 'session_assigned',
    sessionId,
    section
  });

  res.json({
    success: true,
    message: `Session ${sessionId} permanently assigned to Section ${section}`,
    session: updated
  });
});

// 3.3 Assign Room to a session
router.put('/sessions/:id/assign-room', requireAuth, requireRole('admin'), (req, res) => {
  const sessionId = req.params.id;
  const { roomId, roomName } = req.body;

  const db = getDatabase();
  const updated = assignSessionRoom(sessionId, roomId, roomName, db);

  broadcast('timetable.updated', {
    type: 'room_assigned',
    sessionId,
    roomName
  });

  res.json({
    success: true,
    message: `Session ${sessionId} assigned to Room ${roomName || 'TBD'}`,
    session: updated
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
    // Activate target version and ensure is_draft = 0
    db.prepare("UPDATE timetable_entries SET is_draft = 0 WHERE version_id = ?").run(versionId);
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

// 5.5 Create New Timetable Version directly (e.g. from resolved preview draft)
router.post('/versions', requireAuth, requireRole('admin'), (req, res) => {
  const { name, notes, entries, status = 'draft', activateNow } = req.body;
  const db = getDatabase();

  if (!name) {
    return res.status(400).json({ error: 'Version name is required' });
  }

  const createTx = db.transaction(() => {
    const newVersion = db.prepare(`
      INSERT INTO timetable_versions (name, status, created_by, notes)
      VALUES (?, ?, ?, ?)
    `).run(name, status, req.user.id, notes || 'Generated / Resolved Timetable');

    const newVersionId = newVersion.lastInsertRowid;

    if (Array.isArray(entries) && entries.length > 0) {
      const isDraftVal = (activateNow || status === 'active') ? 0 : 1;
      const insertEntry = db.prepare(`
        INSERT INTO timetable_entries (version_id, section_id, subject_id, faculty_id, room_id, day_id, slot_id, is_lab_block, locked, is_draft)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const e of entries) {
        insertEntry.run(
          newVersionId,
          e.section_id,
          e.subject_id,
          e.faculty_id,
          e.room_id,
          e.day_id,
          e.slot_id,
          e.is_lab_block || 0,
          e.locked || 0,
          isDraftVal
        );
      }
    }

    if (activateNow) {
      db.prepare("UPDATE timetable_versions SET status = 'archived' WHERE status = 'active'").run();
      db.prepare("UPDATE timetable_versions SET status = 'active' WHERE id = ?").run(newVersionId);
    }

    return { versionId: newVersionId, name };
  });

  const result = createTx();

  broadcast('timetable.updated', {
    type: 'version_generated',
    versionId: result.versionId,
    versionName: result.name
  });

  res.status(201).json({
    success: true,
    message: 'Timetable generation successful',
    versionId: result.versionId,
    versionName: result.name
  });
});

// 6. Execute Move or Cell Update (Supports Swapping & Non-blocking Admin Edits)
router.post('/entries/:id/move', requireAuth, requireRole('admin'), (req, res) => {
  const entryId = parseInt(req.params.id, 10);
  const { targetDayId, targetSlotId, targetRoomId, targetFacultyId, swapWithEntryId, overrideWarnings, force } = req.body;
  const db = getDatabase();

  const entry = db.prepare('SELECT * FROM timetable_entries WHERE id = ?').get(entryId);
  if (!entry) {
    return res.status(404).json({ error: 'Timetable entry not found' });
  }

  let swappedEntry = null;
  if (swapWithEntryId) {
    swappedEntry = db.prepare('SELECT * FROM timetable_entries WHERE id = ? AND version_id = ?').get(swapWithEntryId, entry.version_id);
  }

  const tx = db.transaction(() => {
    if (swappedEntry) {
      // Move swapped entry to the source entry's slot
      db.prepare(`
        UPDATE timetable_entries
        SET day_id = ?, slot_id = ?
        WHERE id = ?
      `).run(entry.day_id, entry.slot_id, swappedEntry.id);
    }

    // Move source entry to target slot
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
  });

  tx();

  const validation = validateTimetable(entry.version_id);

  broadcast('timetable.updated', {
    type: 'entry_moved',
    entryId,
    versionId: entry.version_id
  });

  res.json({
    success: true,
    message: swappedEntry ? 'Timetable entries swapped successfully' : 'Timetable entry moved successfully',
    validation,
    swapped: !!swappedEntry
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

// 9.5 Create New Timetable Entry (Admin Only - Unrestricted Manual Edit Authority)
router.post('/entries', requireAuth, requireRole('admin'), (req, res) => {
  const { versionId, sectionId, subjectId, facultyId, roomId, dayId, slotId, isLabBlock, locked } = req.body;
  const db = getDatabase();

  if (!versionId || !sectionId || !subjectId || !facultyId || !roomId || !dayId || !slotId) {
    return res.status(400).json({ error: 'Missing required entry fields (versionId, sectionId, subjectId, facultyId, roomId, dayId, slotId)' });
  }

  const result = db.prepare(`
    INSERT INTO timetable_entries (
      version_id, section_id, subject_id, faculty_id, room_id, day_id, slot_id, is_lab_block, locked
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    versionId,
    sectionId,
    subjectId,
    facultyId,
    roomId,
    dayId,
    slotId,
    isLabBlock ? 1 : 0,
    locked ? 1 : 0
  );

  const newEntry = db.prepare(`
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
    WHERE te.id = ?
  `).get(result.lastInsertRowid);

  broadcast('timetable.updated', {
    type: 'entry_created',
    entryId: result.lastInsertRowid,
    versionId
  });

  res.status(201).json({
    success: true,
    message: 'Timetable entry added successfully',
    entry: newEntry
  });
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

  broadcast('timetable.updated', {
    type: 'entry_updated',
    entryId,
    versionId: entry.version_id
  });

  res.json({ success: true, message: 'Entry updated successfully' });
});

// 11. Delete Single Timetable Entry
router.delete('/entries/:id', requireAuth, requireRole('admin'), (req, res) => {
  const entryId = parseInt(req.params.id, 10);
  const db = getDatabase();

  const entry = db.prepare('SELECT * FROM timetable_entries WHERE id = ?').get(entryId);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });

  db.prepare('DELETE FROM timetable_entries WHERE id = ?').run(entryId);

  broadcast('timetable.updated', {
    type: 'entry_deleted',
    entryId,
    versionId: entry.version_id
  });

  res.json({ success: true, message: 'Timetable entry removed' });
});

// 12. Export Version to iCalendar (ICS)
router.get('/versions/:id/export.ics', requireAuth, (req, res) => {
  const versionId = parseInt(req.params.id, 10);
  const db = getDatabase();

  const version = db.prepare('SELECT * FROM timetable_versions WHERE id = ?').get(versionId);
  if (!version) return res.status(404).send('Version not found');

  const entries = db.prepare(`
    SELECT te.*, s.name as subject_name, s.code as subject_code,
           f.name as faculty_name, r.name as room_name,
           sec.name as section_name,
           wd.day_name, wd.day_index,
           ts.slot_no, ts.start_time, ts.end_time
    FROM timetable_entries te
    JOIN subjects s ON te.subject_id = s.id
    JOIN faculty f ON te.faculty_id = f.id
    JOIN rooms r ON te.room_id = r.id
    JOIN sections sec ON te.section_id = sec.id
    JOIN working_days wd ON te.day_id = wd.id
    JOIN time_slots ts ON te.slot_id = ts.id
    WHERE te.version_id = ?
    ORDER BY wd.day_index, ts.slot_no
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
    `X-WR-CALNAME:${version.name} Timetable`,
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

