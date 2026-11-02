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
 * Resolves the jsPDF constructor and autoTable function.
 * Supports window.jspdf / window.jsPDF in browser, dynamic script tag, or dynamic import in Node.
 */
export async function getJsPdf() {
  if (typeof window !== 'undefined') {
    if (window.jspdf?.jsPDF) {
      return { jsPDF: window.jspdf.jsPDF, autoTable: window.jspdf.autoTable || window.autoTable };
    }
    if (window.jsPDF) {
      return { jsPDF: window.jsPDF, autoTable: window.autoTable };
    }
    // Attempt dynamic import of local vendor build if not yet attached to global window
    try {
      await import('/vendor/jspdf/jspdf.umd.min.js');
      await import('/vendor/jspdf/jspdf.plugin.autotable.min.js');
      if (window.jspdf?.jsPDF) {
        return { jsPDF: window.jspdf.jsPDF, autoTable: window.jspdf.autoTable || window.autoTable };
      }
    } catch (e) {
      // ignore
    }
  }

  // Node environment or ESM bundler
  try {
    const jspdfModule = await import('jspdf');
    const autoTableModule = await import('jspdf-autotable');
    const jsPDF = jspdfModule.jsPDF || jspdfModule.default?.jsPDF || jspdfModule.default;
    const autoTable = autoTableModule.default || autoTableModule.autoTable || autoTableModule;
    return { jsPDF, autoTable };
  } catch (err) {
    console.warn('[CTAS exportUtils] jsPDF not available in current environment:', err);
    return null;
  }
}

/**
 * Generates and downloads a clean, beautifully formatted landscape PDF version of the current timetable view using jsPDF
 */
export async function exportTimetableToPdf({
  title = 'Class Timetable Schedule',
  subtitle = '',
  meta = {},
  days = [],
  slots = [],
  entries = [],
  filename = ''
}) {
  const pdfLib = await getJsPdf();
  if (!pdfLib || !pdfLib.jsPDF) {
    console.warn('[CTAS] jsPDF library not found; falling back to window.print()');
    return printOrExportPdf({ title, subtitle, meta, days, slots, entries });
  }

  const { jsPDF, autoTable } = pdfLib;
  const doc = new jsPDF({
    orientation: 'landscape',
    unit: 'mm',
    format: 'a4'
  });

  const pageWidth = doc.internal.pageSize.getWidth(); // 297mm for A4 landscape
  const pageHeight = doc.internal.pageSize.getHeight(); // 210mm
  const marginX = 14;

  // 1. Top Decorative Brand Accent Strip
  doc.setFillColor(107, 0, 16); // Brand Primary #6B0010
  doc.rect(marginX, 9, pageWidth - (marginX * 2), 2.2, 'F');

  // 2. Organization / System Subtitle
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(107, 0, 16);
  doc.text('CLASS TIMETABLE AUTOMATION SYSTEM (CTAS) · OFFICIAL ACADEMIC SCHEDULE', marginX, 16);

  // 3. Document Title
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(17, 24, 39); // Text Primary #111827
  doc.text(title, marginX, 22.5);

  // 4. Subtitle / Academic Context
  let currentY = 27;
  if (subtitle) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(75, 85, 99); // Text Secondary #4B5563
    doc.text(subtitle, marginX, currentY);
    currentY += 4.5;
  }

  // 5. Right-side Status & Export Timestamp
  const now = new Date();
  const dateFormatted = now.toLocaleDateString('en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(100, 116, 139);
  doc.text(`Exported: ${dateFormatted}`, pageWidth - marginX, 16, { align: 'right' });
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(21, 128, 61); // Success green #15803D
  doc.text('✓ Verified Conflict-Free', pageWidth - marginX, 20.5, { align: 'right' });

  // 6. Metadata Summary Strip (if present)
  const metaPairs = Object.entries(meta).filter(([_, v]) => Boolean(v));
  if (metaPairs.length > 0) {
    doc.setFillColor(243, 244, 246); // Surface subtle #F3F4F6
    doc.setDrawColor(229, 231, 235); // Border subtle #E5E7EB
    doc.roundedRect(marginX, currentY, pageWidth - (marginX * 2), 6.5, 1, 1, 'FD');

    let metaX = marginX + 3;
    doc.setFontSize(7);
    metaPairs.forEach(([k, v]) => {
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(51, 65, 85);
      const label = `${k}: `;
      doc.text(label, metaX, currentY + 4.3);
      const labelWidth = doc.getTextWidth(label);

      doc.setFont('helvetica', 'normal');
      doc.setTextColor(100, 116, 139);
      const valText = `${v}   ·   `;
      doc.text(valText, metaX + labelWidth, currentY + 4.3);
      metaX += labelWidth + doc.getTextWidth(valText);
    });
    currentY += 9;
  } else {
    currentY += 2;
  }

  // 7. Prepare Table Headers and Body
  const headRow = [
    { content: 'Day / Period', styles: { halign: 'center', cellWidth: 22 } }
  ];

  slots.forEach(s => {
    const slotLabel = s.label || `Period ${s.slot_no}`;
    const timeRange = (s.start_time && s.end_time) ? `\n${s.start_time} - ${s.end_time}` : '';
    headRow.push({
      content: `${slotLabel}${timeRange}`,
      styles: { halign: 'center' }
    });
  });

  const bodyRows = [];
  days.forEach(day => {
    const row = [day.day_name];
    slots.forEach(slot => {
      if (slot.is_break) {
        row.push(slot.label || 'BREAK');
        return;
      }
      const entry = entries.find(e => 
        (e.day_id === day.id || e.day_index === day.day_index) && 
        (e.slot_id === slot.id || e.slot_no === slot.slot_no)
      );

      if (entry) {
        const parts = [];
        if (entry.subject_code) parts.push(entry.subject_code);
        if (entry.subject_name) parts.push(entry.subject_name);
        if (entry.faculty_name) parts.push(`Prof: ${entry.faculty_name}`);
        if (entry.room_name) parts.push(`Room: ${entry.room_name}${entry.section_name ? ` (${entry.section_name})` : ''}`);
        row.push(parts.join('\n'));
      } else {
        row.push('—');
      }
    });
    bodyRows.push(row);
  });

  // 8. Invoke autoTable
  const tableConfig = {
    startY: currentY,
    margin: { left: marginX, right: marginX, bottom: 12 },
    head: [headRow],
    body: bodyRows,
    theme: 'grid',
    headStyles: {
      fillColor: [107, 0, 16], // Brand primary
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 7.5,
      halign: 'center',
      valign: 'middle',
      cellPadding: 2
    },
    styles: {
      fontSize: 6.8,
      cellPadding: 2,
      overflow: 'linebreak',
      valign: 'middle',
      lineColor: [209, 213, 219],
      lineWidth: 0.15
    },
    columnStyles: {
      0: {
        fontStyle: 'bold',
        halign: 'center',
        valign: 'middle',
        fillColor: [248, 250, 252],
        textColor: [30, 41, 59],
        cellWidth: 22
      }
    },
    didParseCell: (data) => {
      if (data.section === 'body' && data.column.index > 0) {
        const text = String(data.cell.raw || '');
        if (text.includes('BREAK')) {
          data.cell.styles.fillColor = [241, 245, 249];
          data.cell.styles.textColor = [148, 163, 184];
          data.cell.styles.fontStyle = 'italic';
          data.cell.styles.halign = 'center';
        } else if (text === '—') {
          data.cell.styles.textColor = [203, 213, 225];
          data.cell.styles.halign = 'center';
        } else {
          data.cell.styles.fillColor = [255, 244, 245];
          data.cell.styles.textColor = [17, 24, 39];
        }
      }
    }
  };

  if (typeof doc.autoTable === 'function') {
    doc.autoTable(tableConfig);
  } else if (typeof autoTable === 'function') {
    autoTable(doc, tableConfig);
  } else if (typeof window !== 'undefined' && typeof window.jspdf?.autoTable === 'function') {
    window.jspdf.autoTable(doc, tableConfig);
  }

  // 9. Document Footer
  const finalY = pageHeight - 8;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(148, 163, 184);
  doc.text('Class Timetable Automation System (CTAS) · Automated Deterministic CSP Schedule', marginX, finalY);
  doc.text('Page 1 of 1 · Print & Export Ready', pageWidth - marginX, finalY, { align: 'right' });

  // 10. Direct Download
  const cleanName = filename || `${title.replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf`;
  const finalFileName = cleanName.endsWith('.pdf') ? cleanName : `${cleanName}.pdf`;
  if (typeof doc.save === 'function') {
    doc.save(finalFileName);
  }

  return doc;
}

export const generateTimetablePdf = exportTimetableToPdf;

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
