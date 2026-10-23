import config from '../../config/env.js';
import { getDatabase } from '../../db/connection.js';
import { callGrok } from './grokClient.js';
import { getGeminiClient, generateContentWithTimeout } from './geminiClient.js';

/**
 * Deterministic explanation map for all validator violation codes
 */
const VIOLATION_EXPLANATIONS = {
  BREAK_SLOT_USED: {
    category: 'Institutional Schedule',
    severity: 'error',
    summary: 'Class scheduled during institutional break',
    reasoning: 'The designated slot is set aside for tea break or lunch break. Scheduling instruction during this window disrupts campus logistics and causes student fatigue.',
    suggestions: [
      { action: 'move', description: 'Move class to the next open regular teaching period on the same day.', sideEffect: 'Increases afternoon block density.' },
      { action: 'swap', description: 'Swap with a free period on another weekday.', sideEffect: 'Balances weekly curriculum distribution.' }
    ]
  },
  FACULTY_DOUBLE_BOOKED: {
    category: 'Instructor Conflict',
    severity: 'critical',
    summary: 'Faculty assigned to two classes simultaneously',
    reasoning: 'The professor has two concurrent teaching commitments in different classrooms or sections. One group of students will be left unattended.',
    suggestions: [
      { action: 'reassign_faculty', description: 'Assign another qualified colleague from the same department.', sideEffect: 'Increases substitute colleague teaching hours.' },
      { action: 'move', description: 'Move one of the conflicting sections to an alternate free slot.', sideEffect: 'May introduce a free gap period for the section.' }
    ]
  },
  SECTION_DOUBLE_BOOKED: {
    category: 'Cohort Conflict',
    severity: 'critical',
    summary: 'Student section assigned two simultaneous classes',
    reasoning: 'Students in this section cannot attend two separate courses in the same period. Half the curriculum will be missed.',
    suggestions: [
      { action: 'move', description: 'Reschedule the second course into an open time slot.', sideEffect: 'Extends section daily schedule.' }
    ]
  },
  ROOM_DOUBLE_BOOKED: {
    category: 'Facility Conflict',
    severity: 'critical',
    summary: 'Room assigned to two different classes simultaneously',
    reasoning: 'Two instructors and their respective student cohorts are assigned to the same physical room.',
    suggestions: [
      { action: 'reassign_room', description: 'Relocate one class to an unoccupied classroom with adequate seating capacity.', sideEffect: 'Changes floor or building location.' }
    ]
  },
  FACULTY_UNAVAILABLE: {
    category: 'Faculty Preference',
    severity: 'error',
    summary: 'Class scheduled during instructor unavailable preference window',
    reasoning: 'The professor explicitly marked this weekly slot as unavailable due to research, administrative, or personal commitments.',
    suggestions: [
      { action: 'move', description: 'Shift to a slot where the professor has marked green availability.', sideEffect: 'Better faculty engagement and attendance.' }
    ]
  },
  ROOM_TYPE_MISMATCH: {
    category: 'Pedagogy & Infrastructure',
    severity: 'error',
    summary: 'Lab course scheduled in standard classroom or theory course in lab',
    reasoning: 'Practical lab courses require computing or laboratory hardware; standard lecture halls lack necessary equipment.',
    suggestions: [
      { action: 'reassign_room', description: 'Reassign to an available specialized departmental lab.', sideEffect: 'Requires checking lab station count.' }
    ]
  },
  ROOM_CAPACITY_INSUFFICIENT: {
    category: 'Facility Safety',
    severity: 'error',
    summary: 'Classroom capacity is less than student section strength',
    reasoning: 'Overcrowding violates safety protocols and hampers student learning conditions.',
    suggestions: [
      { action: 'reassign_room', description: 'Move cohort to a larger hall (CR-201..CR-204).', sideEffect: 'Utilizes higher-capacity infrastructure.' }
    ]
  },
  LAB_BLOCK_NOT_CONTIGUOUS: {
    category: 'Curriculum Structure',
    severity: 'error',
    summary: 'Lab session split or interrupted by break',
    reasoning: 'Laboratory experiments require unbroken contiguous blocks (e.g. 2 consecutive periods) without break interruptions to complete practical work.',
    suggestions: [
      { action: 'move', description: 'Relocate lab block to periods 3-4 (before lunch) or periods 5-6 (after lunch).', sideEffect: 'Consolidates practical time.' }
    ]
  },
  SUBJECT_PERIODS_MISMATCH: {
    category: 'Syllabus Compliance',
    severity: 'warning',
    summary: 'Assigned periods do not match required weekly periods',
    reasoning: 'The syllabus prescribes a specific weekly period count. Deviations mean the syllabus may not be completed on time.',
    suggestions: [
      { action: 'generate', description: 'Add missing periods or remove surplus slots to match curriculum syllabus.', sideEffect: 'Alters overall section workload.' }
    ]
  },
  FACULTY_OVERLOAD_DAY: {
    category: 'Faculty Welfare',
    severity: 'warning',
    summary: 'Faculty daily period limit exceeded',
    reasoning: 'Teaching beyond the configured daily threshold induces cognitive fatigue and reduces instructional quality.',
    suggestions: [
      { action: 'move', description: 'Spread teaching load across other working days of the week.', sideEffect: 'Balances daily teaching stamina.' }
    ]
  },
  EXCESSIVE_GAPS: {
    category: 'Schedule Optimization',
    severity: 'warning',
    summary: 'Excessive idle gap between scheduled classes',
    reasoning: 'Long idle gaps between lectures lead to unproductive waiting time for students and faculty.',
    suggestions: [
      { action: 'compact', description: 'Shift afternoon classes earlier into empty morning slots.', sideEffect: 'Creates earlier finish time.' }
    ]
  }
};

/**
 * Explain timetable clashes using Grok Reasoning model (or deterministic engine)
 * and persist into ai_issue_log
 */
export async function explainClashes(versionId, violations = [], timetableContext = {}) {
  const db = getDatabase();
  const gemini = getGeminiClient();
  const isGrokActive = Boolean(config.grok.reasoningApiKey);
  let activeMode = 'deterministic_expert';

  let issues = [];

  if (violations.length > 0) {
    const prompt = `
You are an expert university academic scheduling analyst.
Explain the following timetable constraint violations in plain, actionable language.
Timetable Version ID: ${versionId}
Violations:
${JSON.stringify(violations, null, 2)}
Context:
${JSON.stringify(timetableContext, null, 2)}

Return JSON ONLY with this schema:
{
  "issues": [
    {
      "severity": "critical|error|warning|info",
      "category": "Instructor Conflict|Cohort Conflict|Facility Conflict|Schedule Optimization",
      "summary": "Short title describing the issue",
      "reasoning": "Clear explanation of why this clash matters pedagogically and operationally",
      "suggestedFix": {
        "action": "move|reassign_faculty|reassign_room|swap",
        "description": "Concrete action to take in Timetable Studio",
        "expectedSideEffects": "Expected side effect or tradeoff"
      }
    }
  ]
}
`;

    // Try Gemini first if available
    if (gemini) {
      try {
        const response = await generateContentWithTimeout({
          model: 'gemini-3.8-flash',
          contents: prompt,
          config: {
            responseMimeType: 'application/json'
          }
        }, 4000);
        const parsed = JSON.parse(response.text?.trim() || '{}');
        issues = parsed.issues || [];
        if (issues.length > 0) {
          activeMode = 'gemini_reasoning';
        }
      } catch (err) {
        // Fall through cleanly to Grok or deterministic engine
      }
    }

    // Try Grok if Gemini was not available or failed and a valid Grok key is configured
    if (issues.length === 0 && isGrokActive) {
      try {
        const rawResponse = await callGrok({
          apiKey: config.grok.reasoningApiKey,
          model: config.grok.reasoningModel,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2
        });

        if (rawResponse) {
          let clean = rawResponse.trim();
          if (clean.startsWith('```json')) clean = clean.slice(7);
          if (clean.startsWith('```')) clean = clean.slice(3);
          if (clean.endsWith('```')) clean = clean.slice(0, -3);
          const parsed = JSON.parse(clean.trim());

          issues = parsed.issues || [];
          if (issues.length > 0) {
            activeMode = 'grok_reasoning';
          }
        }
      } catch (err) {
        // Fall back cleanly to deterministic explanation engine without polluting error logs
      }
    }
  }

  // Fallback to deterministic expert explanations if AI is inactive or had an issue
  if (issues.length === 0) {
    issues = violations.map(v => {
      const template = VIOLATION_EXPLANATIONS[v.code] || {
        category: 'General Constraint',
        severity: v.severity || 'error',
        summary: v.message || 'Timetable rule violation',
        reasoning: 'This assignment conflicts with college timetable policies.',
        suggestions: [{ action: 'move', description: 'Reassign or move to a conflict-free slot.', sideEffect: 'None.' }]
      };

      return {
        severity: template.severity,
        category: template.category,
        summary: template.summary,
        reasoning: `${template.reasoning} [Details: ${v.message}]`,
        entities: v.entities || {},
        dayId: v.day,
        slotId: v.slot,
        suggestedFix: {
          action: template.suggestions[0].action,
          description: template.suggestions[0].description,
          expectedSideEffects: template.suggestions[0].sideEffect
        }
      };
    });
  }

  // Save into ai_issue_log table
  if (versionId) {
    const insertStmt = db.prepare(`
      INSERT INTO ai_issue_log (version_id, severity, category, summary, reasoning, suggested_fix_json, status)
      VALUES (?, ?, ?, ?, ?, ?, 'open')
    `);

    // Clean previous open issues for this version
    db.prepare("DELETE FROM ai_issue_log WHERE version_id = ? AND status = 'open'").run(versionId);

    const logTx = db.transaction(() => {
      for (const iss of issues) {
        const normSeverity = (iss.severity === 'critical' || iss.severity === 'error') ? 'error' : (iss.severity === 'warning' ? 'warning' : 'info');
        insertStmt.run(
          versionId,
          normSeverity,
          iss.category || 'General',
          iss.summary || 'Scheduling conflict',
          iss.reasoning || '',
          JSON.stringify(iss.suggestedFix || {})
        );
      }
    });
    logTx();
  }

  return {
    success: true,
    versionId,
    mode: activeMode,
    issues
  };
}

/**
 * Fetch active issues for a version from ai_issue_log
 */
export function getIssuesForVersion(versionId, facultyId = null) {
  const db = getDatabase();

  let query = `
    SELECT id, version_id, severity, category, summary, reasoning, suggested_fix_json, status, created_at
    FROM ai_issue_log
    WHERE version_id = ?
  `;
  const params = [versionId];

  query += ` ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'error' THEN 2 WHEN 'warning' THEN 3 ELSE 4 END, id ASC`;

  const rows = db.prepare(query).all(...params);

  return rows.map(r => ({
    ...r,
    suggestedFix: r.suggested_fix_json ? JSON.parse(r.suggested_fix_json) : null
  }));
}

export default {
  explainClashes,
  getIssuesForVersion
};
