import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/role.js';
import config from '../config/env.js';
import { getDatabase } from '../db/connection.js';
import { parseTimetableImage } from '../services/ai/visionImport.js';
import { explainClashes, getIssuesForVersion } from '../services/ai/clashReasoner.js';
import { rankSubstituteOptions, suggestRescheduleSlots } from '../services/ai/decisionManager.js';
import { validateTimetable } from '../services/validator.js';
import { broadcast } from '../services/sse.js';

const router = Router();

// Ensure uploads dir exists
if (!fs.existsSync(config.uploadsDir)) {
  fs.mkdirSync(config.uploadsDir, { recursive: true });
}

// Multer upload setup with 8MB limit and image filter
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `timetable-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid image format. Allowed formats: PNG, JPG, WEBP'));
    }
  }
});

/**
 * GET /api/ai/status
 * Returns current Grok AI model configuration and status
 */
router.get('/status', requireAuth, (req, res) => {
  res.json({
    configured: {
      gemini: Boolean(config.geminiApiKey),
      vision: Boolean(config.grok.visionApiKey || config.geminiApiKey),
      reasoning: Boolean(config.grok.reasoningApiKey || config.geminiApiKey),
      decision: Boolean(config.grok.decisionApiKey || config.geminiApiKey)
    },
    models: {
      gemini: config.geminiModel,
      vision: config.grok.visionApiKey ? config.grok.visionModel : config.geminiModel,
      reasoning: config.grok.reasoningApiKey ? config.grok.reasoningModel : config.geminiModel,
      decision: config.grok.decisionApiKey ? config.grok.decisionModel : config.geminiModel
    },
    apiBase: config.grok.apiBase
  });
});

/**
 * POST /api/ai/vision-import
 * Phase 10: Upload timetable screenshot/image and extract structured grid
 */
router.post('/vision-import', requireAuth, requireRole('admin', 'faculty'), upload.single('image'), async (req, res, next) => {
  let tempFilePath = null;
  try {
    const sectionId = req.body.sectionId ? parseInt(req.body.sectionId, 10) : null;
    const sectionName = req.body.sectionName || 'CSE-4A';

    let result;
    if (req.file) {
      tempFilePath = req.file.path;
      result = await parseTimetableImage(tempFilePath, req.file.mimetype, { sectionId, sectionName });
    } else if (req.body.useSample === 'true' || req.body.useSample === true) {
      // Direct sample import without file upload
      result = await parseTimetableImage(null, 'image/png', { sectionId, sectionName });
    } else {
      return res.status(400).json({ error: 'Please upload an image file or choose sample extraction' });
    }

    res.json(result);
  } catch (err) {
    next(err);
  } finally {
    // Delete temp file after processing
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch (e) {
        console.warn('Failed to remove temp upload:', e.message);
      }
    }
  }
});

/**
 * POST /api/ai/import-confirm
 * Phase 10: Confirm reviewed timetable cells and save as a new DRAFT timetable version
 */
router.post('/import-confirm', requireAuth, requireRole('admin'), (req, res, next) => {
  try {
    const { versionName, cells, notes } = req.body;
    if (!cells || !Array.isArray(cells) || cells.length === 0) {
      return res.status(400).json({ error: 'No cells provided for timetable draft creation' });
    }

    const db = getDatabase();

    // 1. Create a draft version
    const insertVersion = db.prepare(`
      INSERT INTO timetable_versions (name, status, created_by, notes)
      VALUES (?, 'draft', ?, ?)
    `);

    const versionTitle = versionName || `Imported Draft ${new Date().toLocaleDateString()}`;
    const versionNotes = notes || 'Extracted via CTAS Vision Import module with user verification.';

    const newVersionId = insertVersion.run(versionTitle, req.user.id, versionNotes).lastInsertRowid;

    // 2. Insert valid timetable entries as draft (is_draft = 1)
    const insertEntry = db.prepare(`
      INSERT INTO timetable_entries 
      (version_id, section_id, subject_id, faculty_id, room_id, day_id, slot_id, is_lab_block, locked, is_draft)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1)
    `);

    const insertTx = db.transaction(() => {
      for (const cell of cells) {
        // Skip cells with incomplete mappings or break slots
        if (!cell.sectionId || !cell.subjectId || !cell.facultyId || !cell.roomId || !cell.dayId || !cell.slotId) {
          continue;
        }
        insertEntry.run(
          newVersionId,
          cell.sectionId,
          cell.subjectId,
          cell.facultyId,
          cell.roomId,
          cell.dayId,
          cell.slotId,
          cell.isLabBlock ? 1 : 0
        );
      }
    });

    insertTx();

    // 3. Run validator on newly imported draft
    const validation = validateTimetable(newVersionId);

    // 4. Audit log
    db.prepare(`
      INSERT INTO audit_log (user_id, action, details_json)
      VALUES (?, 'VISION_IMPORT_CONFIRM', ?)
    `).run(req.user.id, JSON.stringify({
      versionId: newVersionId,
      versionName: versionTitle,
      cellCount: cells.length,
      errorsCount: validation.errorCount,
      warningsCount: validation.warningCount
    }));

    broadcast('timetable.updated', { versionId: newVersionId });

    res.json({
      success: true,
      message: `Draft version "${versionTitle}" created successfully.`,
      versionId: newVersionId,
      validation
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/ai/analyze-version
 * Phase 11: Analyze timetable version conflicts with Grok Reasoning (or expert fallback)
 */
router.post('/analyze-version', requireAuth, requireRole('admin', 'faculty'), async (req, res, next) => {
  try {
    const { versionId } = req.body;
    const db = getDatabase();

    const targetVersionId = versionId ? parseInt(versionId, 10) : db.prepare("SELECT id FROM timetable_versions WHERE status = 'active'").get()?.id;

    if (!targetVersionId) {
      return res.status(404).json({ error: 'No active or target timetable version found' });
    }

    // Run deterministic validator
    const validation = validateTimetable(targetVersionId);
    const violations = validation.violations || [];

    const version = db.prepare('SELECT * FROM timetable_versions WHERE id = ?').get(targetVersionId);

    // Run clash reasoner
    const reasoningResult = await explainClashes(targetVersionId, violations, {
      versionName: version?.name,
      errorCount: validation.errorCount,
      warningCount: validation.warningCount
    });

    res.json(reasoningResult);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/ai/issues
 * Phase 11: Get logged issues for a timetable version
 */
router.get('/issues', requireAuth, (req, res, next) => {
  try {
    const db = getDatabase();
    const versionId = req.query.versionId
      ? parseInt(req.query.versionId, 10)
      : db.prepare("SELECT id FROM timetable_versions WHERE status = 'active'").get()?.id;

    if (!versionId) {
      return res.json({ issues: [] });
    }

    const issues = getIssuesForVersion(versionId, req.user.role === 'faculty' ? req.user.facultyId : null);
    res.json({ issues, versionId });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/ai/decision/rank-substitutes
 * Phase 12: Rank eligible substitute options with Grok Decision model
 */
router.post('/decision/rank-substitutes', requireAuth, requireRole('admin', 'faculty'), async (req, res, next) => {
  try {
    const { timetableEntryId, dateStr } = req.body;
    if (!timetableEntryId || !dateStr) {
      return res.status(400).json({ error: 'timetableEntryId and dateStr are required' });
    }

    const result = await rankSubstituteOptions(parseInt(timetableEntryId, 10), dateStr, req.user.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/ai/decision/reschedule-slots
 * Phase 12: Find and rank candidate slots to reschedule an uncovered class
 */
router.post('/decision/reschedule-slots', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { timetableEntryId, dateStr } = req.body;
    if (!timetableEntryId || !dateStr) {
      return res.status(400).json({ error: 'timetableEntryId and dateStr are required' });
    }

    const result = await suggestRescheduleSlots(parseInt(timetableEntryId, 10), dateStr);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
