/**
 * Deterministic Min-Conflicts Local Search Timetable Resolver for CTAS
 *
 * Resolves conflicts automatically while strictly respecting:
 * - Locked classes (`locked === 1`)
 * - Working draft isolation (never mutates published/active versions directly)
 * - Priority order:
 *   (a) Swap with another period of same section
 *   (b) Move to empty conflict-free slot
 *   (c) Reassign qualified available faculty
 *   (d) Reassign suitable available room
 *   (e) Ejection chain (depth 2)
 *   (f) Tabu list & randomized restarts
 * - Real-time step-by-step watchable animation:
 *   - Cell highlighting (amber for source, blue for target)
 *   - Speed control: Slow (850ms) / Normal (500ms) / Fast (150ms)
 *   - Live Resolution Log of each step
 *   - Live badge countdown (13 -> 12 -> ... -> 0)
 *   - Pause, Step (single-step while paused), Skip-to-End, and Cancel
 * - Safety cutoff: 30,000ms or 20,000 iterations
 */

import { evaluateTimetableConflicts } from './timetableValidator.js';

export class TimetableResolver {
  constructor(entries, masterData, options = {}) {
    // Clone entries to guarantee working draft copy isolation
    this.entries = JSON.parse(JSON.stringify(entries || []));
    this.originalEntries = JSON.parse(JSON.stringify(entries || []));
    this.masterData = masterData || {};

    this.validator = options.validator || ((entries, mData) => {
      if (typeof window !== 'undefined' && typeof window.calculateTimetableConflicts === 'function') {
        return window.calculateTimetableConflicts(entries, mData);
      }
      return evaluateTimetableConflicts(entries, mData);
    });

    this.onProgress = options.onProgress || (() => {});
    this.onStep = options.onStep || (() => {});
    this.onComplete = options.onComplete || (() => {});
    this.onError = options.onError || (() => {});

    this.maxDurationMs = options.maxDurationMs || 30000;
    this.maxIterations = options.maxIterations || 20000;
    this.stepDelayMs = options.stepDelayMs !== undefined ? options.stepDelayMs : (typeof window !== 'undefined' ? 500 : 0);

    this.isCancelled = false;
    this.isRunning = false;
    this.isPaused = false;
    this.skipToEndActive = false;
    this.startTime = null;
    this.iterations = 0;
    this.stepCount = 0;
    this.restarts = 0;
    this.maxRestarts = 5;

    // Tabu list of state signatures to avoid cycles
    this.tabuSet = new Set();
    this.resolutionLog = [];
    this.timerHandle = null;
  }

  evaluateConflicts(entries) {
    if (this.validator) {
      return this.validator(entries, this.masterData);
    }
    return evaluateTimetableConflicts(entries, this.masterData);
  }

  setSpeed(speedName) {
    if (speedName === 'slow') this.stepDelayMs = 850;
    else if (speedName === 'fast') this.stepDelayMs = 150;
    else this.stepDelayMs = 500; // normal
  }

  pause() {
    this.isPaused = true;
  }

  resume() {
    if (!this.isRunning) return;
    this.isPaused = false;
    this.scheduleNextStep(50);
  }

  singleStep() {
    if (!this.isRunning) return;
    this.executeOneStep();
  }

  skipToEnd() {
    this.skipToEndActive = true;
    this.stepDelayMs = 0;
    if (this.isPaused) {
      this.isPaused = false;
    }
    // Run remaining steps synchronously/rapidly
    this.runRapidCompletion();
  }

  solve() {
    return new Promise((resolve) => {
      this.stepDelayMs = 0;
      this.skipToEndActive = true;
      const initialVal = this.evaluateConflicts(this.entries);
      const initialCount = initialVal.errorCount;
      const done = (res) => {
        const finalVal = this.evaluateConflicts(this.entries);
        const rem = (res && typeof res.conflictsRemaining === 'number')
          ? res.conflictsRemaining
          : finalVal.errorCount;
        resolve({
          ...res,
          initialConflicts: initialCount,
          remainingConflicts: rem,
          stepsExecuted: this.stepCount || this.iterations || (res?.stepCount ?? 0)
        });
      };
      this.onComplete = done;
      this.onError = done;
      this.start();
      this.skipToEnd();
    });
  }

  cancel() {
    this.isCancelled = true;
    this.isRunning = false;
    if (this.timerHandle) {
      clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
  }

  getStateSignature(entries) {
    return entries
      .map(e => `${e.id}:${e.day_id}:${e.slot_id}:${e.faculty_id}:${e.room_id}`)
      .sort()
      .join('|');
  }

  getDayName(dayId) {
    const d = this.masterData.workingDays?.find(w => w.id === dayId);
    return d ? d.day_name.slice(0, 3) : `Day ${dayId}`;
  }

  getSlotLabel(slotId) {
    const s = this.masterData.timeSlots?.find(ts => ts.id === slotId);
    return s ? (s.label || `P${s.slot_no}`) : `Slot ${slotId}`;
  }

  getFacultyName(facId) {
    const f = this.masterData.faculty?.find(fac => fac.id === facId);
    return f ? f.name : `Faculty #${facId}`;
  }

  getRoomName(roomId) {
    const r = this.masterData.rooms?.find(rm => rm.id === roomId);
    return r ? r.name : `Room #${roomId}`;
  }

  start() {
    this.isRunning = true;
    this.isCancelled = false;
    this.isPaused = false;
    this.skipToEndActive = false;
    this.startTime = Date.now();
    this.iterations = 0;
    this.stepCount = 0;
    this.restarts = 0;
    this.tabuSet.clear();
    this.resolutionLog = [];

    const initialVal = this.evaluateConflicts(this.entries);
    this.onProgress({
      iterations: 0,
      conflictsCount: initialVal.errorCount,
      violations: initialVal.conflicts,
      entries: this.entries,
      phase: 'Initialized conflict resolution engine'
    });

    if (initialVal.isValid) {
      this.isRunning = false;
      this.onComplete({
        success: true,
        conflictsRemaining: 0,
        entries: this.entries,
        originalEntries: this.originalEntries,
        iterations: 0,
        stepCount: 0,
        resolutionLog: [],
        durationMs: 0
      });
      return;
    }

    this.scheduleNextStep(this.stepDelayMs);
  }

  scheduleNextStep(delay) {
    if (this.isCancelled || !this.isRunning) return;
    if (this.timerHandle) clearTimeout(this.timerHandle);

    this.timerHandle = setTimeout(() => {
      if (this.isCancelled || !this.isRunning || this.isPaused) return;
      this.executeOneStep();
    }, delay);
  }

  executeOneStep() {
    if (this.isCancelled || !this.isRunning) return;

    // Safety checks
    if (Date.now() - this.startTime > this.maxDurationMs) {
      const val = this.evaluateConflicts(this.entries);
      this.finishWithRemaining(val, `Time limit reached (${Math.round(this.maxDurationMs / 1000)}s)`);
      return;
    }

    if (this.iterations >= this.maxIterations) {
      const val = this.evaluateConflicts(this.entries);
      this.finishWithRemaining(val, `Iteration limit reached (${this.maxIterations.toLocaleString()} iterations)`);
      return;
    }

    this.iterations++;
    let currentVal = this.evaluateConflicts(this.entries);

    if (currentVal.errorCount === 0) {
      this.isRunning = false;
      this.onComplete({
        success: true,
        conflictsRemaining: 0,
        entries: this.entries,
        originalEntries: this.originalEntries,
        iterations: this.iterations,
        stepCount: this.stepCount,
        resolutionLog: this.resolutionLog,
        durationMs: Date.now() - this.startTime
      });
      return;
    }

    // Pick a conflicted unlocked entry
    const conflictedEntry = this.selectConflictedEntry(currentVal);
    if (!conflictedEntry) {
      this.finishWithRemaining(currentVal, 'All remaining conflicting entries are locked by administrator.');
      return;
    }

    // Heuristically evaluate best move
    const bestMove = this.findBestMove(conflictedEntry, currentVal);

    if (bestMove && bestMove.delta < 0) {
      this.stepCount++;
      const stepRecord = this.applyMoveAndDescribe(bestMove, currentVal);
      const afterVal = this.evaluateConflicts(this.entries);
      stepRecord.conflictsAfter = afterVal.errorCount;
      this.tabuSet.add(this.getStateSignature(this.entries));
      this.resolutionLog.push(stepRecord);

      // Notify UI of step animation
      this.onStep({
        stepNo: this.stepCount,
        step: stepRecord,
        conflictsRemaining: afterVal.errorCount,
        conflictsCount: afterVal.errorCount,
        entries: this.entries,
        iterations: this.iterations,
        log: this.resolutionLog
      });

      this.onProgress({
        iterations: this.iterations,
        stepCount: this.stepCount,
        conflictsCount: afterVal.errorCount,
        violations: afterVal.conflicts,
        entries: this.entries,
        phase: `Applied move: ${stepRecord.description}`
      });

      if (afterVal.errorCount === 0) {
        this.isRunning = false;
        this.onComplete({
          success: true,
          conflictsRemaining: 0,
          entries: this.entries,
          originalEntries: this.originalEntries,
          iterations: this.iterations,
          stepCount: this.stepCount,
          resolutionLog: this.resolutionLog,
          durationMs: Date.now() - this.startTime
        });
        return;
      }
    } else {
      // Local minimum: perturb or try ejection chain
      if (this.restarts < this.maxRestarts) {
        this.restarts++;
        this.perturbRandomUnlockedEntries();
        const pertVal = this.evaluateConflicts(this.entries);
        this.onProgress({
          iterations: this.iterations,
          stepCount: this.stepCount,
          conflictsCount: pertVal.errorCount,
          violations: pertVal.conflicts,
          entries: this.entries,
          phase: `Perturbing schedule to escape local minimum (Restart ${this.restarts}/${this.maxRestarts})...`
        });
      } else {
        this.finishWithRemaining(currentVal, 'Local minimum reached; no single swap or reassignment strictly reduced conflicts.');
        return;
      }
    }

    if (!this.isPaused && this.isRunning) {
      this.scheduleNextStep(this.skipToEndActive ? 0 : this.stepDelayMs);
    }
  }

  runRapidCompletion() {
    while (this.isRunning && !this.isCancelled) {
      let currentVal = this.evaluateConflicts(this.entries);
      if (currentVal.errorCount === 0) {
        this.isRunning = false;
        this.onComplete({
          success: true,
          conflictsRemaining: 0,
          entries: this.entries,
          originalEntries: this.originalEntries,
          iterations: this.iterations,
          stepCount: this.stepCount,
          resolutionLog: this.resolutionLog,
          durationMs: Date.now() - this.startTime
        });
        return;
      }

      if (Date.now() - this.startTime > this.maxDurationMs || this.iterations >= this.maxIterations) {
        this.finishWithRemaining(currentVal, 'Safety cutoff reached during resolution.');
        return;
      }

      this.iterations++;
      const conflictedEntry = this.selectConflictedEntry(currentVal);
      if (!conflictedEntry) {
        this.finishWithRemaining(currentVal, 'All remaining conflicting entries are locked by administrator.');
        return;
      }

      const bestMove = this.findBestMove(conflictedEntry, currentVal);
      if (bestMove && bestMove.delta < 0) {
        this.stepCount++;
        const stepRecord = this.applyMoveAndDescribe(bestMove, currentVal);
        const afterVal = this.evaluateConflicts(this.entries);
        stepRecord.conflictsAfter = afterVal.errorCount;
        this.tabuSet.add(this.getStateSignature(this.entries));
        this.resolutionLog.push(stepRecord);

        this.onStep({
          stepNo: this.stepCount,
          step: stepRecord,
          conflictsRemaining: afterVal.errorCount,
          conflictsCount: afterVal.errorCount,
          entries: this.entries,
          iterations: this.iterations,
          log: this.resolutionLog
        });
      } else {
        if (this.restarts < this.maxRestarts) {
          this.restarts++;
          this.perturbRandomUnlockedEntries();
        } else {
          this.finishWithRemaining(currentVal, 'Local minimum reached.');
          return;
        }
      }
    }
  }

  selectConflictedEntry(val) {
    const conflictedIds = new Set();
    for (const v of val.conflicts) {
      if (Array.isArray(v.involvedEntryIds)) {
        for (const id of v.involvedEntryIds) conflictedIds.add(id);
      }
    }

    const candidates = this.entries.filter(e => conflictedIds.has(e.id) && !e.locked && e.is_locked !== 1);
    if (!candidates.length) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  findBestMove(targetEntry, currentVal) {
    const currentScore = currentVal.errorCount;
    let bestMove = null;
    let minScore = currentScore;

    const { workingDays = [], timeSlots = [], rooms = [], faculty = [], facultySubjects = [] } = this.masterData;
    const teachingSlots = timeSlots.filter(s => s.is_break === 0);

    // Heuristic (a): Swap slot of the SAME section
    const sameSectionEntries = this.entries.filter(e => e.section_id === targetEntry.section_id && e.id !== targetEntry.id && !e.locked && e.is_locked !== 1);
    for (const other of sameSectionEntries) {
      const score = this.evaluateHypothetical([
        { id: targetEntry.id, day_id: other.day_id, slot_id: other.slot_id },
        { id: other.id, day_id: targetEntry.day_id, slot_id: targetEntry.slot_id }
      ]);
      if (score < minScore) {
        minScore = score;
        bestMove = {
          type: 'swap_slots',
          entry1Id: targetEntry.id,
          entry2Id: other.id,
          day1: other.day_id,
          slot1: other.slot_id,
          day2: targetEntry.day_id,
          slot2: targetEntry.slot_id,
          delta: score - currentScore
        };
      }
    }

    // Heuristic (b): Move to an empty slot for this section
    const occupiedSectionSlots = new Set(
      this.entries.filter(e => e.section_id === targetEntry.section_id).map(e => `${e.day_id}_${e.slot_id}`)
    );

    for (const d of workingDays) {
      for (const s of teachingSlots) {
        const slotKey = `${d.id}_${s.id}`;
        if (!occupiedSectionSlots.has(slotKey)) {
          const score = this.evaluateHypothetical([
            { id: targetEntry.id, day_id: d.id, slot_id: s.id }
          ]);
          if (score < minScore) {
            minScore = score;
            bestMove = {
              type: 'move_slot',
              entryId: targetEntry.id,
              targetDayId: d.id,
              targetSlotId: s.id,
              delta: score - currentScore
            };
          }
        }
      }
    }

    // Heuristic (c): Reassign faculty if this class has a faculty clash
    const isFacClash = currentVal.conflicts.some(v =>
      (v.type === 'FACULTY_DOUBLE_BOOKED' || v.type === 'FACULTY_UNAVAILABLE' || v.type === 'FACULTY_OVERLOAD_DAY') &&
      v.involvedEntryIds?.includes(targetEntry.id)
    );

    if (isFacClash) {
      const qualified = faculty.filter(f => {
        if (f.id === targetEntry.faculty_id) return false;
        const hasSkill = Array.isArray(facultySubjects) && facultySubjects.length > 0
          ? facultySubjects.some(fs => fs.faculty_id === f.id && fs.subject_id === targetEntry.subject_id)
          : true;
        return hasSkill;
      });

      for (const altFac of qualified) {
        const score = this.evaluateHypothetical([
          { id: targetEntry.id, faculty_id: altFac.id }
        ]);
        if (score < minScore) {
          minScore = score;
          bestMove = {
            type: 'reassign_faculty',
            entryId: targetEntry.id,
            newFacultyId: altFac.id,
            delta: score - currentScore
          };
        }
      }
    }

    // Heuristic (d): Reassign room if this class has a room clash
    const isRoomClash = currentVal.conflicts.some(v =>
      (v.type === 'ROOM_DOUBLE_BOOKED' || v.type === 'ROOM_TYPE_MISMATCH' || v.type === 'ROOM_CAPACITY_INSUFFICIENT') &&
      v.involvedEntryIds?.includes(targetEntry.id)
    );

    if (isRoomClash) {
      const isLab = targetEntry.subject_type === 'lab' || targetEntry.is_lab_block === 1;
      const suitableRooms = rooms.filter(r => {
        if (r.id === targetEntry.room_id) return false;
        if (isLab && r.type !== 'lab') return false;
        if (r.capacity && targetEntry.section_strength && r.capacity < targetEntry.section_strength) return false;
        return true;
      });

      for (const altRoom of suitableRooms) {
        const score = this.evaluateHypothetical([
          { id: targetEntry.id, room_id: altRoom.id }
        ]);
        if (score < minScore) {
          minScore = score;
          bestMove = {
            type: 'reassign_room',
            entryId: targetEntry.id,
            newRoomId: altRoom.id,
            delta: score - currentScore
          };
        }
      }
    }

    // Heuristic (e): Ejection chain (depth 2)
    if (!bestMove && sameSectionEntries.length > 0) {
      for (const bumpTarget of sameSectionEntries.slice(0, 5)) {
        for (const d of workingDays.slice(0, 4)) {
          for (const s of teachingSlots.slice(0, 4)) {
            const slotKey = `${d.id}_${s.id}`;
            if (!occupiedSectionSlots.has(slotKey)) {
              const score = this.evaluateHypothetical([
                { id: targetEntry.id, day_id: bumpTarget.day_id, slot_id: bumpTarget.slot_id },
                { id: bumpTarget.id, day_id: d.id, slot_id: s.id }
              ]);
              if (score < minScore) {
                minScore = score;
                bestMove = {
                  type: 'ejection_chain',
                  targetId: targetEntry.id,
                  bumpId: bumpTarget.id,
                  targetDay: bumpTarget.day_id,
                  targetSlot: bumpTarget.slot_id,
                  bumpDay: d.id,
                  bumpSlot: s.id,
                  delta: score - currentScore
                };
              }
            }
          }
        }
      }
    }

    return bestMove;
  }

  evaluateHypothetical(mutations) {
    const mutated = this.entries.map(e => {
      const mut = mutations.find(m => m.id === e.id);
      if (mut) return { ...e, ...mut };
      return e;
    });

    const sig = this.getStateSignature(mutated);
    if (this.tabuSet.has(sig)) return 99999;

    const val = this.evaluateConflicts(mutated);
    return val.errorCount;
  }

  applyMoveAndDescribe(move, currentVal) {
    const step = {
      stepNo: this.stepCount,
      type: move.type,
      description: '',
      sectionId: null,
      sectionName: '',
      sourceDayId: null,
      sourceSlotId: null,
      sourceEntryId: null,
      targetDayId: null,
      targetSlotId: null,
      targetEntryId: null,
      conflictsBefore: currentVal.errorCount,
      conflictsAfter: currentVal.errorCount + move.delta
    };

    if (move.type === 'swap_slots') {
      const e1 = this.entries.find(e => e.id === move.entry1Id);
      const e2 = this.entries.find(e => e.id === move.entry2Id);
      if (e1 && e2) {
        step.sectionId = e1.section_id;
        step.sectionName = e1.section_name || `Section ${e1.section_id}`;
        step.sourceDayId = e1.day_id;
        step.sourceSlotId = e1.slot_id;
        step.sourceEntryId = e1.id;
        step.targetDayId = e2.day_id;
        step.targetSlotId = e2.slot_id;
        step.targetEntryId = e2.id;

        const d1 = this.getDayName(e1.day_id);
        const s1 = this.getSlotLabel(e1.slot_id);
        const d2 = this.getDayName(e2.day_id);
        const s2 = this.getSlotLabel(e2.slot_id);

        step.description = `Swapped ${d1} ${s1} (${e1.subject_code}, ${this.getFacultyName(e1.faculty_id)}) ↔ ${d2} ${s2} (${e2.subject_code}, ${this.getFacultyName(e2.faculty_id)}) in ${step.sectionName}`;

        e1.day_id = move.day1;
        e1.slot_id = move.slot1;
        e2.day_id = move.day2;
        e2.slot_id = move.slot2;
      }
    } else if (move.type === 'move_slot') {
      const e = this.entries.find(entry => entry.id === move.entryId);
      if (e) {
        step.sectionId = e.section_id;
        step.sectionName = e.section_name || `Section ${e.section_id}`;
        step.sourceDayId = e.day_id;
        step.sourceSlotId = e.slot_id;
        step.sourceEntryId = e.id;
        step.targetDayId = move.targetDayId;
        step.targetSlotId = move.targetSlotId;

        const dOrig = this.getDayName(e.day_id);
        const sOrig = this.getSlotLabel(e.slot_id);
        const dTarget = this.getDayName(move.targetDayId);
        const sTarget = this.getSlotLabel(move.targetSlotId);

        step.description = `Moved ${e.subject_code} in ${step.sectionName} from ${dOrig} ${sOrig} → ${dTarget} ${sTarget}`;

        e.day_id = move.targetDayId;
        e.slot_id = move.targetSlotId;
      }
    } else if (move.type === 'reassign_faculty') {
      const e = this.entries.find(entry => entry.id === move.entryId);
      if (e) {
        step.sectionId = e.section_id;
        step.sectionName = e.section_name || `Section ${e.section_id}`;
        step.sourceDayId = e.day_id;
        step.sourceSlotId = e.slot_id;
        step.sourceEntryId = e.id;
        step.targetDayId = e.day_id;
        step.targetSlotId = e.slot_id;

        const oldFac = this.getFacultyName(e.faculty_id);
        const newFac = this.getFacultyName(move.newFacultyId);
        const d = this.getDayName(e.day_id);
        const s = this.getSlotLabel(e.slot_id);

        step.description = `Reassigned ${e.subject_code} (${step.sectionName}) at ${d} ${s} from ${oldFac} → ${newFac}`;

        e.faculty_id = move.newFacultyId;
        e.faculty_name = newFac;
      }
    } else if (move.type === 'reassign_room') {
      const e = this.entries.find(entry => entry.id === move.entryId);
      if (e) {
        step.sectionId = e.section_id;
        step.sectionName = e.section_name || `Section ${e.section_id}`;
        step.sourceDayId = e.day_id;
        step.sourceSlotId = e.slot_id;
        step.sourceEntryId = e.id;
        step.targetDayId = e.day_id;
        step.targetSlotId = e.slot_id;

        const oldRoom = this.getRoomName(e.room_id);
        const newRoom = this.getRoomName(move.newRoomId);
        const d = this.getDayName(e.day_id);
        const s = this.getSlotLabel(e.slot_id);

        step.description = `Relocated ${e.subject_code} (${step.sectionName}) at ${d} ${s} from ${oldRoom} → ${newRoom}`;

        e.room_id = move.newRoomId;
        e.room_name = newRoom;
      }
    } else if (move.type === 'ejection_chain') {
      const t = this.entries.find(entry => entry.id === move.targetId);
      const b = this.entries.find(entry => entry.id === move.bumpId);
      if (t && b) {
        step.sectionId = t.section_id;
        step.sectionName = t.section_name || `Section ${t.section_id}`;
        step.sourceDayId = t.day_id;
        step.sourceSlotId = t.slot_id;
        step.sourceEntryId = t.id;
        step.targetDayId = move.targetDay;
        step.targetSlotId = move.targetSlot;
        step.targetEntryId = b.id;

        step.description = `Ejection Chain: Moved ${t.subject_code} to ${this.getDayName(move.targetDay)} ${this.getSlotLabel(move.targetSlot)} and displaced ${b.subject_code} to ${this.getDayName(move.bumpDay)} ${this.getSlotLabel(move.bumpSlot)}`;

        t.day_id = move.targetDay;
        t.slot_id = move.targetSlot;
        b.day_id = move.bumpDay;
        b.slot_id = move.bumpSlot;
      }
    }

    return step;
  }

  perturbRandomUnlockedEntries() {
    const unlocked = this.entries.filter(e => !e.locked && e.is_locked !== 1);
    if (unlocked.length < 2) return;

    const sections = [...new Set(unlocked.map(e => e.section_id))];
    const randSec = sections[Math.floor(Math.random() * sections.length)];
    const secEntries = unlocked.filter(e => e.section_id === randSec);

    if (secEntries.length >= 2) {
      const i = Math.floor(Math.random() * secEntries.length);
      let j = Math.floor(Math.random() * secEntries.length);
      while (j === i) j = Math.floor(Math.random() * secEntries.length);

      const dTemp = secEntries[i].day_id;
      const sTemp = secEntries[i].slot_id;
      secEntries[i].day_id = secEntries[j].day_id;
      secEntries[i].slot_id = secEntries[j].slot_id;
      secEntries[j].day_id = dTemp;
      secEntries[j].slot_id = sTemp;
    }
  }

  finishWithRemaining(val, reason) {
    this.isRunning = false;
    this.onError({
      success: false,
      reason,
      conflictsRemaining: val.errorCount,
      violations: val.conflicts,
      entries: this.entries,
      originalEntries: this.originalEntries,
      durationMs: Date.now() - this.startTime,
      iterations: this.iterations,
      stepCount: this.stepCount,
      resolutionLog: this.resolutionLog
    });
  }
}
