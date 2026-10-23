import config from '../../config/env.js';
import { getDatabase } from '../../db/connection.js';
import { callGrok } from './grokClient.js';
import { getGeminiClient, generateContentWithTimeout } from './geminiClient.js';
import { findEligibleSubstitutes, assignSubstitution } from '../substitution.js';
import { validateTimetable } from '../validator.js';
import { broadcast } from '../sse.js';

/**
 * Rank substitute candidates using Grok Decision model or deterministic scoring
 */
export async function rankSubstituteOptions(timetableEntryId, dateStr, adminUserId = null) {
  const db = getDatabase();

  const entry = db.prepare(`
    SELECT te.*, s.name as subject_name, s.code as subject_code, s.type as subject_type,
           sec.name as section_name, f.name as absent_faculty_name,
           r.name as room_name, ts.start_time, ts.end_time, ts.slot_no
    FROM timetable_entries te
    JOIN subjects s ON te.subject_id = s.id
    JOIN sections sec ON te.section_id = sec.id
    JOIN faculty f ON te.faculty_id = f.id
    JOIN rooms r ON te.room_id = r.id
    JOIN time_slots ts ON te.slot_id = ts.id
    WHERE te.id = ?
  `).get(timetableEntryId);

  if (!entry) {
    throw new Error(`Timetable entry ${timetableEntryId} not found`);
  }

  // Find deterministically verified eligible candidates
  const eligibleCandidates = findEligibleSubstitutes(timetableEntryId, dateStr);

  if (eligibleCandidates.length === 0) {
    return {
      success: true,
      hasCandidates: false,
      timetableEntryId,
      dateStr,
      entry,
      rankedOptions: [],
      justification: 'No faculty member is free and eligible for this time slot without causing a collision or exceeding daily limits.',
      risks: ['Class will remain uncovered unless rescheduled to another period or taken as self-study.']
    };
  }

  const gemini = getGeminiClient();
  const isGrokActive = Boolean(config.grok.decisionApiKey);

  const prompt = `
You are the Chief Academic Scheduling Officer.
Evaluate these candidate faculty members to substitute for an absent colleague's class.
All candidates have already passed hard conflict checks.

Course: ${entry.subject_code} - ${entry.subject_name} (${entry.subject_type})
Section: ${entry.section_name}
Date: ${dateStr} (Period ${entry.slot_no}, ${entry.start_time}-${entry.end_time})
Absent Instructor: ${entry.absent_faculty_name}

Candidates:
${JSON.stringify(eligibleCandidates, null, 2)}

Rank all candidates from best to worst. Weigh:
1. Subject qualification match (highest priority)
2. Department affinity
3. Faculty weekly workload balance (prevent burnout)
4. Expressed slot availability preference

Return JSON ONLY with this schema:
{
  "chosenOptionId": <facultyId of top candidate>,
  "rankedOptions": [
    {
      "facultyId": <number>,
      "name": "<string>",
      "rank": <number 1..N>,
      "score": <number 0..100>,
      "aiSummary": "<brief summary of suitability>"
    }
  ],
  "justification": "<plain English explanation of why the top candidate is the optimal choice>",
  "risks": [
    "<any potential risk e.g. approaching weekly teaching load limit>"
  ]
}
`;

  // 1. Try Gemini
  if (gemini) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await gemini.models.generateContent({
          model: 'gemini-3.8-flash',
          contents: prompt,
          config: {
            responseMimeType: 'application/json'
          }
        });

        const parsed = JSON.parse(response.text?.trim() || '{}');
        if (parsed.rankedOptions && Array.isArray(parsed.rankedOptions)) {
          const rankedOptions = parsed.rankedOptions.map((ro, idx) => {
            const cand = eligibleCandidates.find(c => c.facultyId === ro.facultyId) || eligibleCandidates[idx];
            return {
              ...cand,
              aiRank: ro.rank || idx + 1,
              aiScore: ro.score,
              aiSummary: ro.aiSummary
            };
          });

          return {
            success: true,
            hasCandidates: true,
            mode: 'gemini_decision',
            modelUsed: 'gemini-3.8-flash',
            timetableEntryId,
            dateStr,
            entry,
            chosenOptionId: parsed.chosenOptionId || rankedOptions[0]?.facultyId,
            rankedOptions,
            justification: parsed.justification || 'Candidate selected based on optimal qualification and workload balancing.',
            risks: parsed.risks || []
          };
        }
      } catch (err) {
        if (attempt === 0 && (err.status === 503 || err.message?.includes('503') || err.message?.includes('high demand'))) {
          await new Promise(r => setTimeout(r, 600));
          continue;
        }
        break;
      }
    }
  }

  // 2. Try Grok if configured and active
  if (isGrokActive) {
    try {
      const rawResponse = await callGrok({
        apiKey: config.grok.decisionApiKey,
        model: config.grok.decisionModel,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1
      });

      let clean = rawResponse.trim();
      if (clean.startsWith('```json')) clean = clean.slice(7);
      if (clean.startsWith('```')) clean = clean.slice(3);
      if (clean.endsWith('```')) clean = clean.slice(0, -3);
      const parsed = JSON.parse(clean.trim());

      // Merge AI ranking with candidate details
      const rankedOptions = (parsed.rankedOptions || []).map((ro, idx) => {
        const cand = eligibleCandidates.find(c => c.facultyId === ro.facultyId) || eligibleCandidates[idx];
        return {
          ...cand,
          aiRank: ro.rank || idx + 1,
          aiScore: ro.score,
          aiSummary: ro.aiSummary
        };
      });

      return {
        success: true,
        hasCandidates: true,
        mode: 'grok_decision',
        modelUsed: config.grok.decisionModel,
        timetableEntryId,
        dateStr,
        entry,
        chosenOptionId: parsed.chosenOptionId || rankedOptions[0]?.facultyId,
        rankedOptions,
        justification: parsed.justification || 'Candidate selected based on optimal qualification and workload balancing.',
        risks: parsed.risks || []
      };

    } catch (err) {
      console.warn('[DecisionManager] Grok Decision API call failed, falling back to deterministic heuristic:', err.message);
    }
  }

  // Deterministic Fallback: Rank by deterministic candidate score
  const sorted = [...eligibleCandidates].sort((a, b) => b.score - a.score);
  const top = sorted[0];

  const risks = [];
  if (top.currentDailyPeriods + 1 >= top.maxPeriodsPerDay) {
    risks.push(`Top candidate will reach their daily teaching limit of ${top.maxPeriodsPerDay} periods today.`);
  }
  if (!top.isQualified) {
    risks.push('Top candidate is from the same department but is not explicitly marked as qualified for this syllabus.');
  }

  return {
    success: true,
    hasCandidates: true,
    mode: 'deterministic_fallback',
    timetableEntryId,
    dateStr,
    entry,
    chosenOptionId: top.facultyId,
    rankedOptions: sorted.map((cand, idx) => ({
      ...cand,
      aiRank: idx + 1,
      aiSummary: `${cand.isQualified ? 'Qualified' : 'Same Dept'} · ${cand.weeklyPeriods} weekly periods`
    })),
    justification: `Selected ${top.name} because they score highest (${top.score} pts) combining ${top.isQualified ? 'subject qualification, ' : ''}department match, and current workload balance (${top.weeklyPeriods} periods).`,
    risks
  };
}

/**
 * Reschedule an uncovered class by finding conflict-free alternative slots
 */
export async function suggestRescheduleSlots(timetableEntryId, dateStr) {
  const db = getDatabase();

  const entry = db.prepare(`
    SELECT te.*, s.name as subject_name, s.code as subject_code, s.type as subject_type,
           sec.name as section_name, f.name as faculty_name,
           r.name as room_name, tv.id as version_id
    FROM timetable_entries te
    JOIN subjects s ON te.subject_id = s.id
    JOIN sections sec ON te.section_id = sec.id
    JOIN faculty f ON te.faculty_id = f.id
    JOIN rooms r ON te.room_id = r.id
    JOIN timetable_versions tv ON te.version_id = tv.id
    WHERE te.id = ?
  `).get(timetableEntryId);

  if (!entry) {
    throw new Error('Timetable entry not found');
  }

  const allDays = db.prepare('SELECT * FROM working_days WHERE is_active = 1 ORDER BY day_index').all();
  const allSlots = db.prepare('SELECT * FROM time_slots WHERE is_break = 0 ORDER BY slot_no').all();

  // Find candidate free slots where neither section, faculty, nor room is busy
  const candidateSlots = [];

  for (const d of allDays) {
    for (const sl of allSlots) {
      if (d.id === entry.day_id && sl.id === entry.slot_id) continue;

      // Check section busy
      const secBusy = db.prepare(`
        SELECT COUNT(*) as cnt FROM timetable_entries
        WHERE version_id = ? AND section_id = ? AND day_id = ? AND slot_id = ?
      `).get(entry.version_id, entry.section_id, d.id, sl.id).cnt > 0;
      if (secBusy) continue;

      // Check faculty busy
      const facBusy = db.prepare(`
        SELECT COUNT(*) as cnt FROM timetable_entries
        WHERE version_id = ? AND faculty_id = ? AND day_id = ? AND slot_id = ?
      `).get(entry.version_id, entry.faculty_id, d.id, sl.id).cnt > 0;
      if (facBusy) continue;

      // Check room busy
      const roomBusy = db.prepare(`
        SELECT COUNT(*) as cnt FROM timetable_entries
        WHERE version_id = ? AND room_id = ? AND day_id = ? AND slot_id = ?
      `).get(entry.version_id, entry.room_id, d.id, sl.id).cnt > 0;
      if (roomBusy) continue;

      candidateSlots.push({
        dayId: d.id,
        dayName: d.day_name,
        slotId: sl.id,
        slotNo: sl.slot_no,
        startTime: sl.start_time,
        endTime: sl.end_time,
        label: sl.label
      });
    }
  }

  return {
    success: true,
    entry,
    candidateSlots: candidateSlots.slice(0, 5),
    recommendation: candidateSlots[0] || null
  };
}

export default {
  rankSubstituteOptions,
  suggestRescheduleSlots
};
