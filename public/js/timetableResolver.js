/**
 * Deterministic Min-Conflicts Local Search Timetable Resolver for CTAS
 *
 * Resolves conflicts automatically while strictly respecting:
 * - Locked classes (`locked === 1`)
 * - Working draft isolation (never mutates published/active versions directly)
 * - Move priority:
 *   (a) Swap with another period of same section
 *   (b) Move to empty conflict-free slot
 *   (c) Reassign qualified available faculty
 *   (d) Reassign suitable available room
 *   (e) Ejection chain (depth 2)
 *   (f) Tabu list & randomized restarts
 * - Non-blocking asynchronous batching with live progress countdown
 * - Safety cutoff: 5,000ms or 20,000 iterations
 */

import { evaluateTimetableConflicts } from './timetableValidator.js';

export class TimetableResolver {
  constructor(entries, masterData, options = {}) {
    // Clone entries to guarantee draft copy isolation
    this.entries = JSON.parse(JSON.stringify(entries || []));
    this.originalEntries = JSON.parse(JSON.stringify(entries || []));
    this.masterData = masterData;

    this.onProgress = options.onProgress || (() => {});
    this.onComplete = options.onComplete || (() => {});
    this.onError = options.onError || (() => {});

    this.maxDurationMs = options.maxDurationMs || 5000;
    this.maxIterations = options.maxIterations || 20000;
    this.batchSize = options.batchSize || 35; // moves per frame

    this.isCancelled = false;
    this.isRunning = false;
    this.startTime = null;
    this.iterations = 0;
    this.restarts = 0;
    this.maxRestarts = 3;

    // Tabu list of state signatures to prevent cycles
    this.tabuSet = new Set();
  }

  cancel() {
    this.isCancelled = true;
    this.isRunning = false;
  }

  // Generate a compact hash signature of current schedule state
  getStateSignature(entries) {
    return entries
      .map(e => `${e.id}:${e.day_id}:${e.slot_id}:${e.faculty_id}:${e.room_id}`)
      .sort()
      .join('|');
  }

  start() {
    this.isRunning = true;
    this.isCancelled = false;
    this.startTime = Date.now();
    this.iterations = 0;
    this.restarts = 0;
    this.tabuSet.clear();

    const initialVal = evaluateTimetableConflicts(this.entries, this.masterData);
    this.onProgress({
      iterations: 0,
      conflictsCount: initialVal.errorCount,
      violations: initialVal.conflicts,
      entries: this.entries,
      phase: 'Analyzing conflicts...'
    });

    if (initialVal.isValid) {
      this.isRunning = false;
      this.onComplete({
        success: true,
        conflictsRemaining: 0,
        entries: this.entries,
        originalEntries: this.originalEntries,
        iterations: 0,
        durationMs: 0
      });
      return;
    }

    this.runBatch();
  }

  runBatch() {
    if (this.isCancelled || !this.isRunning) return;

    const batchStart = Date.now();
    let currentVal = evaluateTimetableConflicts(this.entries, this.masterData);

    while (this.iterations < this.maxIterations && (Date.now() - batchStart) < 25) {
      if (currentVal.errorCount === 0) {
        // Success!
        this.isRunning = false;
        this.onProgress({
          iterations: this.iterations,
          conflictsCount: 0,
          violations: [],
          entries: this.entries,
          phase: 'Done'
        });
        this.onComplete({
          success: true,
          conflictsRemaining: 0,
          entries: this.entries,
          originalEntries: this.originalEntries,
          iterations: this.iterations,
          durationMs: Date.now() - this.startTime
        });
        return;
      }

      // Check timeout
      if (Date.now() - this.startTime > this.maxDurationMs) {
        this.finishWithRemaining(currentVal, 'Time limit reached (5.0s)');
        return;
      }

      this.iterations++;

      // Pick a conflicted unlocked entry
      const conflictedEntry = this.selectConflictedEntry(currentVal);
      if (!conflictedEntry) {
        // No unlocked conflicted entry found to move
        this.finishWithRemaining(currentVal, 'All remaining conflicting entries are locked by administrator.');
        return;
      }

      // Find best move that minimizes conflicts
      const bestMove = this.findBestMove(conflictedEntry, currentVal);

      if (bestMove && bestMove.delta < 0) {
        // Apply move
        this.applyMove(bestMove);
        currentVal = evaluateTimetableConflicts(this.entries, this.masterData);
        this.tabuSet.add(this.getStateSignature(this.entries));
      } else {
        // Local minimum reached: try randomized restart perturbation
        if (this.restarts < this.maxRestarts) {
          this.restarts++;
          this.perturbRandomUnlockedEntries();
          currentVal = evaluateTimetableConflicts(this.entries, this.masterData);
        } else {
          // Bounded depth reached
          this.finishWithRemaining(currentVal, 'Local minimum reached; no single swap or re-assignment reduced disputes.');
          return;
        }
      }
    }

    // Report intermediate progress to UI
    this.onProgress({
      iterations: this.iterations,
      conflictsCount: currentVal.errorCount,
      violations: currentVal.conflicts,
      entries: this.entries,
      phase: `Resolving (${currentVal.errorCount} conflicts remaining)...`
    });

    if (this.iterations >= this.maxIterations) {
      this.finishWithRemaining(currentVal, `Iteration safety limit reached (${this.maxIterations.toLocaleString()} iterations)`);
      return;
    }

    // Continue asynchronously in next macrotask
    setTimeout(() => this.runBatch(), 0);
  }

  selectConflictedEntry(val) {
    const conflictedIds = new Set();
    for (const v of val.conflicts) {
      if (Array.isArray(v.involvedEntryIds)) {
        for (const id of v.involvedEntryIds) conflictedIds.add(id);
      }
    }

    // Filter to unlocked entries only
    const candidates = this.entries.filter(e => conflictedIds.has(e.id) && !e.locked && e.is_locked !== 1);
    if (!candidates.length) return null;

    // Pick random candidate among the conflicted ones
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  findBestMove(targetEntry, currentVal) {
    const currentScore = currentVal.errorCount;
    let bestMove = null;
    let minScore = currentScore;

    const { workingDays = [], timeSlots = [], rooms = [], faculty = [], sectionSubjects = [], facultySubjects = [] } = this.masterData;
    const teachingSlots = timeSlots.filter(s => s.is_break === 0);

    // Heuristic (a): Swap slot of the SAME section
    const sameSectionEntries = this.entries.filter(e => e.section_id === targetEntry.section_id && e.id !== targetEntry.id && !e.locked && e.is_locked !== 1);
    for (const other of sameSectionEntries) {
      // Evaluate trial swap
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
      // Find candidate faculty qualified for this subject
      const qualified = faculty.filter(f => {
        if (f.id === targetEntry.faculty_id) return false;
        // Check facultySubjects mapping if present
        const hasSkill = Array.isArray(facultySubjects) && facultySubjects.length > 0
          ? facultySubjects.some(fs => fs.faculty_id === f.id && fs.subject_id === targetEntry.subject_id)
          : true; // fallback to department / general
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
    // If no single move strictly improved score, try moving targetEntry to slot X and bumping slot X's occupant
    if (!bestMove && sameSectionEntries.length > 0) {
      for (const bumpTarget of sameSectionEntries.slice(0, 5)) {
        for (const d of workingDays.slice(0, 4)) {
          for (const s of teachingSlots.slice(0, 4)) {
            const slotKey = `${d.id}_${s.id}`;
            if (!occupiedSectionSlots.has(slotKey)) {
              // TargetEntry moves to bumpTarget's slot, bumpTarget moves to (d, s)
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
    // Quick in-memory copy
    const mutated = this.entries.map(e => {
      const mut = mutations.find(m => m.id === e.id);
      if (mut) {
        return { ...e, ...mut };
      }
      return e;
    });

    // Check tabu signature
    const sig = this.getStateSignature(mutated);
    if (this.tabuSet.has(sig)) {
      return 99999; // heavily penalize tabu state
    }

    const val = evaluateTimetableConflicts(mutated, this.masterData);
    return val.errorCount;
  }

  applyMove(move) {
    if (move.type === 'swap_slots') {
      const e1 = this.entries.find(e => e.id === move.entry1Id);
      const e2 = this.entries.find(e => e.id === move.entry2Id);
      if (e1 && e2) {
        e1.day_id = move.day1;
        e1.slot_id = move.slot1;
        e2.day_id = move.day2;
        e2.slot_id = move.slot2;
      }
    } else if (move.type === 'move_slot') {
      const e = this.entries.find(entry => entry.id === move.entryId);
      if (e) {
        e.day_id = move.targetDayId;
        e.slot_id = move.targetSlotId;
      }
    } else if (move.type === 'reassign_faculty') {
      const e = this.entries.find(entry => entry.id === move.entryId);
      if (e) {
        e.faculty_id = move.newFacultyId;
        const fac = this.masterData.faculty?.find(f => f.id === move.newFacultyId);
        if (fac) e.faculty_name = fac.name;
      }
    } else if (move.type === 'reassign_room') {
      const e = this.entries.find(entry => entry.id === move.entryId);
      if (e) {
        e.room_id = move.newRoomId;
        const rm = this.masterData.rooms?.find(r => r.id === move.newRoomId);
        if (rm) {
          e.room_name = rm.name;
          e.room_type = rm.type;
          e.room_capacity = rm.capacity;
        }
      }
    } else if (move.type === 'ejection_chain') {
      const t = this.entries.find(entry => entry.id === move.targetId);
      const b = this.entries.find(entry => entry.id === move.bumpId);
      if (t && b) {
        t.day_id = move.targetDay;
        t.slot_id = move.targetSlot;
        b.day_id = move.bumpDay;
        b.slot_id = move.bumpSlot;
      }
    }
  }

  perturbRandomUnlockedEntries() {
    const unlocked = this.entries.filter(e => !e.locked && e.is_locked !== 1);
    if (unlocked.length < 2) return;

    // Swap 2 random unlocked entries of same section
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
      iterations: this.iterations
    });
  }
}
