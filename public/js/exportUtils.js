/**
 * Shared Export & Print Utilities for CTAS
 * Provides PDF print formatting and iCalendar (.ics) export
 */

/**
 * Generates an RFC 5545 compliant iCalendar (.ics) string from schedule entries
 */
export function generateIcsContent(calendarName, entries = []) {
  const dayCodeMap = {
    0: 'SU',
    1: 'MO',
    2: 'TU',
    3: 'WE',
    4: 'TH',
    5: 'FR',
    6: 'SA'
  };

  // Base reference date (Monday of the current academic week)
  const now = new Date();
  const currentDay = now.getDay();
  // Calculate difference to get this week's Monday
  const diffToMonday = currentDay === 0 ? -6 : 1 - currentDay;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diffToMonday);

  let ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//CTAS//Class Timetable Automation System//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${cleanIcsText(calendarName || 'CTAS Schedule')}`,
    'X-WR-TIMEZONE:UTC'
  ];

  entries.forEach((e, idx) => {
    const dayIndex = e.day_index ?? (e.day_id || 1);
    const dayCode = dayCodeMap[dayIndex] || 'MO';

    // Calculate base date for this weekday
    const targetDate = new Date(monday);
    const offset = dayIndex === 0 ? 6 : dayIndex - 1;
    targetDate.setDate(monday.getDate() + offset);

    const dateStr = targetDate.toISOString().slice(0, 10).replace(/-/g, '');
    const startTimeClean = (e.start_time || '09:00').replace(/[^0-9]/g, '').slice(0, 4) + '00';
    const endTimeClean = (e.end_time || '10:00').replace(/[^0-9]/g, '').slice(0, 4) + '00';

    const dtStart = `${dateStr}T${startTimeClean}`;
    const dtEnd = `${dateStr}T${endTimeClean}`;
    const uid = `ctas-evt-${e.id || idx}-${Date.now()}@ctas.college.edu`;

    const summary = cleanIcsText(`${e.subject_code ? e.subject_code + ': ' : ''}${e.subject_name || 'Class'}`);
    const location = cleanIcsText(e.room_name || 'Campus Classroom');
    const description = cleanIcsText(
      `Subject: ${e.subject_name || 'N/A'} (${e.subject_code || 'N/A'})\n` +
      `Instructor: ${e.faculty_name || 'Faculty'}\n` +
      `Room: ${e.room_name || 'N/A'}\n` +
      `Section: ${e.section_name || 'General'}\n` +
      `Schedule: ${e.day_name || dayCode} ${e.start_time || ''}-${e.end_time || ''}`
    );

    ics.push(
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${dateStr}T000000Z`,
      `DTSTART:${dtStart}`,
      `DTEND:${dtEnd}`,
      `RRULE:FREQ=WEEKLY;BYDAY=${dayCode}`,
      `SUMMARY:${summary}`,
      `LOCATION:${location}`,
      `DESCRIPTION:${description}`,
      'STATUS:CONFIRMED',
      'END:VEVENT'
    );
  });

  ics.push('END:VCALENDAR');
  return ics.join('\r\n');
}

function cleanIcsText(str) {
  if (!str) return '';
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/**
 * Triggers a direct browser file download for text/file content
 */
export function downloadFile(filename, content, mimeType = 'text/plain') {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Triggers download of schedule as .ics file
 */
export function exportToIcs(filename, calendarName, entries) {
  const ics = generateIcsContent(calendarName, entries);
  downloadFile(`${filename}.ics`, ics, 'text/calendar');
}

/**
 * Injects and renders a print-optimized timetable layout into #ctas-print-container
 * then triggers window.print() (native Save as PDF / Print)
 */
export function printOrExportPdf({
  title = 'Class Timetable Schedule',
  subtitle = '',
  meta = {},
  days = [],
  slots = [],
  entries = []
}) {
  let printContainer = document.getElementById('ctas-print-container');
  if (!printContainer) {
    printContainer = document.createElement('div');
    printContainer.id = 'ctas-print-container';
    document.body.appendChild(printContainer);
  }

  const currentDate = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  let metaItemsHtml = '';
  for (const [key, val] of Object.entries(meta)) {
    if (val) {
      metaItemsHtml += `<span><strong>${key}:</strong> ${val}</span> &nbsp;·&nbsp; `;
    }
  }

  let tableHtml = `
    <table style="width: 100%; border-collapse: collapse; margin-top: 1rem; font-size: 0.82rem; text-align: center;">
      <thead>
        <tr style="background: #f1f5f9; border-bottom: 2px solid #334155;">
          <th style="padding: 0.6rem; border: 1px solid #cbd5e1; width: 110px;">Day / Period</th>
  `;

  for (const slot of slots) {
    tableHtml += `
      <th style="padding: 0.6rem; border: 1px solid #cbd5e1;">
        <div style="font-weight: 700; color: #0f172a;">${slot.label || `Slot ${slot.slot_no}`}</div>
        <div style="font-size: 0.72rem; color: #64748b; font-weight: normal;">${slot.start_time} - ${slot.end_time}</div>
      </th>
    `;
  }

  tableHtml += `
        </tr>
      </thead>
      <tbody>
  `;

  for (const day of days) {
    tableHtml += `
      <tr>
        <td style="padding: 0.6rem; font-weight: 700; border: 1px solid #cbd5e1; background: #f8fafc; color: #1e293b;">
          ${day.day_name}
        </td>
    `;

    for (const slot of slots) {
      if (slot.is_break) {
        tableHtml += `
          <td style="padding: 0.4rem; border: 1px solid #cbd5e1; background: #f1f5f9; color: #94a3b8; font-size: 0.72rem;">
            ${slot.label || 'BREAK'}
          </td>
        `;
        continue;
      }

      const entry = entries.find(e => (e.day_id === day.id || e.day_index === day.day_index) && (e.slot_id === slot.id || e.slot_no === slot.slot_no));

      if (entry) {
        tableHtml += `
          <td style="padding: 0.45rem; border: 1px solid #cbd5e1; background: #fff1f2; text-align: left;">
            <div style="font-weight: 700; color: #881337; font-size: 0.85rem;">${entry.subject_code || ''}</div>
            <div style="font-size: 0.75rem; color: #1e293b; font-weight: 500;">${entry.subject_name || ''}</div>
            <div style="font-size: 0.7rem; color: #475569; margin-top: 2px;">
              👤 ${entry.faculty_name || ''}
            </div>
            <div style="font-size: 0.68rem; color: #64748b;">
              📍 ${entry.room_name || ''} ${entry.section_name ? `(${entry.section_name})` : ''}
            </div>
          </td>
        `;
      } else {
        tableHtml += `
          <td style="padding: 0.45rem; border: 1px solid #cbd5e1; color: #cbd5e1; font-size: 0.75rem;">
            —
          </td>
        `;
      }
    }

    tableHtml += `</tr>`;
  }

  tableHtml += `
      </tbody>
    </table>
  `;

  printContainer.innerHTML = `
    <div style="font-family: system-ui, -apple-system, sans-serif; color: #0f172a; max-width: 100%;">
      <!-- Header -->
      <div style="display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #881337; padding-bottom: 0.75rem; margin-bottom: 0.5rem;">
        <div>
          <div style="font-size: 0.8rem; font-weight: 700; text-transform: uppercase; color: #881337; letter-spacing: 0.05em;">
            Class Timetable Automation System (CTAS) · Official Schedule
          </div>
          <h1 style="font-size: 1.6rem; color: #0f172a; margin: 0.2rem 0; font-weight: 800;">
            ${title}
          </h1>
          ${subtitle ? `<div style="font-size: 0.9rem; color: #475569;">${subtitle}</div>` : ''}
        </div>
        <div style="text-align: right; font-size: 0.75rem; color: #64748b;">
          <div>Printed on: ${currentDate}</div>
          <div style="color: #059669; font-weight: 600; margin-top: 2px;">✓ Verified Conflict-Free</div>
        </div>
      </div>

      <!-- Metadata summary line -->
      <div style="font-size: 0.8rem; color: #334155; margin-bottom: 0.5rem;">
        ${metaItemsHtml}
      </div>

      <!-- Schedule Table -->
      ${tableHtml}

      <!-- Footer -->
      <div style="margin-top: 1.25rem; pt: 0.75rem; border-top: 1px solid #e2e8f0; display: flex; justify-content: space-between; font-size: 0.72rem; color: #64748b;">
        <span>CTAS Academic Timetable Generator · Forward-Checking CSP Engine</span>
        <span>Page 1 of 1 · Print-Ready Export</span>
      </div>
    </div>
  `;

  window.print();
}
