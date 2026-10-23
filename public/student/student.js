import { apiRequest } from '/js/api.js';
import { checkSession, logout } from '/js/auth.js';
import { showToast } from '/js/toast.js';
import { initSSE, onEvent } from '/js/sse.js';
import { printOrExportPdf, exportToIcs } from '/js/exportUtils.js';

let currentDateStr = new Date().toISOString().split('T')[0];
let currentSection = null;
let currentScheduleData = null;
let activeTab = 'my-section'; // 'my-section' | 'department'


document.addEventListener('DOMContentLoaded', async () => {
  const user = await checkSession('student');
  if (!user) return;

  // Initialize SSE for live schedule and substitution updates
  initSSE('/api/events');
  onEvent('timetable.updated', () => loadSchedule(currentDateStr));
  onEvent('absence:created', () => {
    showToast('Faculty update reported: checking schedule adjustments...', 'info');
    loadSchedule(currentDateStr);
  });
  onEvent('substitution:claimed', (data) => {
    showToast(`Substitute coverage confirmed: ${data.substituteFacultyName} taking ${data.subjectName}`, 'success');
    loadSchedule(currentDateStr);
  });
  onEvent('substitution:assigned', (data) => {
    showToast(`Substitute update: ${data.substituteFacultyName} assigned for ${data.subjectName}`, 'info');
    loadSchedule(currentDateStr);
  });

  setupControls();
  await loadSchedule(currentDateStr);
});

function setupControls() {
  document.getElementById('logout-btn')?.addEventListener('click', logout);

  // Tab switching
  document.querySelectorAll('[data-student-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-student-tab]').forEach(b => {
        b.classList.remove('btn-primary');
        b.classList.add('btn-secondary');
      });
      btn.classList.add('btn-primary');
      btn.classList.remove('btn-secondary');

      activeTab = btn.getAttribute('data-student-tab');
      document.querySelectorAll('.student-view-panel').forEach(p => p.style.display = 'none');
      const target = document.getElementById(`panel-${activeTab}`);
      if (target) target.style.display = 'block';

      if (activeTab === 'department') loadDepartmentTimetable();
    });
  });

  // Date selection
  const dateInput = document.getElementById('student-date-picker');
  if (dateInput) {
    dateInput.value = currentDateStr;
    dateInput.addEventListener('change', () => {
      currentDateStr = dateInput.value;
      loadSchedule(currentDateStr);
    });
  }

  document.getElementById('btn-date-prev')?.addEventListener('click', () => {
    const d = new Date(currentDateStr);
    d.setDate(d.getDate() - 1);
    currentDateStr = d.toISOString().split('T')[0];
    if (dateInput) dateInput.value = currentDateStr;
    loadSchedule(currentDateStr);
  });

  document.getElementById('btn-date-today')?.addEventListener('click', () => {
    currentDateStr = new Date().toISOString().split('T')[0];
    if (dateInput) dateInput.value = currentDateStr;
    loadSchedule(currentDateStr);
  });

  document.getElementById('btn-date-next')?.addEventListener('click', () => {
    const d = new Date(currentDateStr);
    d.setDate(d.getDate() + 1);
    currentDateStr = d.toISOString().split('T')[0];
    if (dateInput) dateInput.value = currentDateStr;
    loadSchedule(currentDateStr);
  });

  // Export to PDF / Print Schedule
  const triggerPdfOrPrint = () => {
    if (!currentScheduleData || !currentScheduleData.fullWeeklySchedule) {
      showToast('No schedule data loaded to print', 'warning');
      return;
    }

    const days = [
      { id: 1, day_name: 'Monday', day_index: 1 },
      { id: 2, day_name: 'Tuesday', day_index: 2 },
      { id: 3, day_name: 'Wednesday', day_index: 3 },
      { id: 4, day_name: 'Thursday', day_index: 4 },
      { id: 5, day_name: 'Friday', day_index: 5 },
      { id: 6, day_name: 'Saturday', day_index: 6 }
    ];

    const slotMap = new Map();
    (currentScheduleData.fullWeeklySchedule || []).forEach(e => {
      if (!slotMap.has(e.slot_no)) {
        slotMap.set(e.slot_no, {
          id: e.slot_id,
          slot_no: e.slot_no,
          label: e.slot_label || `Period ${e.slot_no}`,
          start_time: e.start_time,
          end_time: e.end_time,
          is_break: false
        });
      }
    });

    const slots = Array.from(slotMap.values()).sort((a, b) => a.slot_no - b.slot_no);
    const sec = currentScheduleData.section || {};

    printOrExportPdf({
      title: `Student Timetable · Section ${sec.name || 'General'}`,
      subtitle: `${sec.department_name || ''} · Semester ${sec.semester || ''} · Academic Year 2026`,
      meta: {
        'Section': sec.name || 'N/A',
        'Department': sec.department_name || 'N/A',
        'Total Weekly Periods': `${(currentScheduleData.fullWeeklySchedule || []).length} classes`
      },
      days,
      slots,
      entries: currentScheduleData.fullWeeklySchedule || []
    });
  };

  document.getElementById('btn-student-export-pdf')?.addEventListener('click', triggerPdfOrPrint);
  document.getElementById('btn-student-print-schedule')?.addEventListener('click', triggerPdfOrPrint);

  // Export ICS
  document.getElementById('btn-student-export-ics')?.addEventListener('click', () => {
    if (!currentScheduleData || !currentScheduleData.fullWeeklySchedule) {
      showToast('No schedule data loaded to export', 'warning');
      return;
    }
    const secName = currentScheduleData.section?.name || 'My_Section';
    exportToIcs(
      `section_${secName}_schedule`,
      `Section ${secName} Academic Schedule`,
      currentScheduleData.fullWeeklySchedule || []
    );
    showToast('ICS Calendar file generated and downloaded', 'success');
  });
}

async function loadSchedule(dateStr) {
  try {
    const data = await apiRequest(`/api/student/schedule?date=${dateStr}`);
    currentScheduleData = data;
    currentSection = data.section;

    if (data.section) {
      document.getElementById('section-title-header').textContent = `Section ${data.section.name} Schedule`;
      document.getElementById('section-dept-line').textContent = `${data.section.department_name} · Semester ${data.section.semester} · Strength: ${data.section.strength} students`;
    }

    renderTodaySchedule(data);
    renderNextClassTracker(data.todaySchedule || []);
    renderWeeklyBreakdown(data.fullWeeklySchedule || []);

  } catch (err) {
    console.error('Failed to load student schedule:', err);
  }
}

function renderTodaySchedule(data) {
  const container = document.getElementById('today-classes-container');
  const dateHeading = document.getElementById('selected-date-heading');
  if (!container) return;

  if (dateHeading) {
    const d = new Date(data.date + 'T00:00:00');
    dateHeading.textContent = `${d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })}`;
  }

  if (data.isHoliday) {
    container.innerHTML = `
      <div style="padding: 2.5rem; text-align: center; background: var(--bg-surface-subtle); border-radius: var(--radius-md); border: 1px dashed var(--border-subtle);">
        <div style="font-size: 2.5rem; margin-bottom: 0.5rem;">🎉</div>
        <h4 style="font-size: 1.25rem; font-weight: 700; color: var(--color-brand-primary); margin-bottom: 0.25rem;">Campus Holiday</h4>
        <p style="font-size: 0.95rem; color: var(--text-secondary);">${data.holidayDescription} · No classes scheduled today.</p>
      </div>
    `;
    return;
  }

  const classes = data.todaySchedule || [];

  if (classes.length === 0) {
    container.innerHTML = `
      <div style="padding: 2rem; text-align: center; color: var(--text-muted); background: var(--bg-surface-subtle); border-radius: var(--radius-md);">
        No classes scheduled for this section on this day.
      </div>
    `;
    return;
  }

  container.innerHTML = classes.map(c => {
    let badgeBg = 'var(--color-success-bg)';
    let badgeColor = 'var(--color-success)';
    let borderLeft = '4px solid var(--color-success)';

    if (c.status === 'substituted') {
      badgeBg = 'var(--color-warning-bg)';
      badgeColor = 'var(--color-warning)';
      borderLeft = '4px solid var(--color-warning)';
    } else if (c.status === 'suspended') {
      badgeBg = 'var(--color-error-bg)';
      badgeColor = 'var(--color-error)';
      borderLeft = '4px solid var(--color-error)';
    }

    return `
      <div class="card animate-fade-in" style="border-left: ${borderLeft}; margin-bottom: 0.75rem; padding: 1.1rem; background: var(--bg-surface); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.75rem;">
        <div>
          <div style="display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; margin-bottom: 0.35rem;">
            <span style="font-weight: 700; font-size: 1.15rem; color: var(--color-brand-primary);">${c.subject_name}</span>
            <span style="font-size: 0.75rem; background: var(--bg-surface-subtle); border: 1px solid var(--border-subtle); padding: 0.2rem 0.5rem; border-radius: 4px; font-weight: 600;">${c.subject_code}</span>
            <span style="font-size: 0.75rem; background: var(--bg-surface-subtle); border: 1px solid var(--border-subtle); padding: 0.2rem 0.5rem; border-radius: 4px;">Room: ${c.room_name}</span>
            <span style="font-size: 0.75rem; font-weight: 700; background: ${badgeBg}; color: ${badgeColor}; padding: 0.2rem 0.6rem; border-radius: 4px;">
              ${c.badgeText}
            </span>
          </div>
          <div style="font-size: 0.85rem; color: var(--text-secondary);">
            Regular Faculty: <strong>${c.faculty_name}</strong>
            ${c.substituteFacultyName ? `· Substitute Faculty: <strong style="color: var(--color-warning);">${c.substituteFacultyName}</strong>` : ''}
          </div>
        </div>

        <div style="text-align: right;">
          <div style="font-size: 0.95rem; font-weight: 700; color: var(--text-primary);">${c.slot_label}</div>
          <div style="font-size: 0.8rem; color: var(--text-muted);" class="tabular-nums">${c.start_time} - ${c.end_time}</div>
        </div>
      </div>
    `;
  }).join('');
}

function renderNextClassTracker(todayClasses) {
  const container = document.getElementById('next-class-tracker-box');
  if (!container) return;

  if (!todayClasses.length) {
    container.innerHTML = `
      <div style="font-size: 0.85rem; color: var(--text-muted);">No classes scheduled for today.</div>
    `;
    return;
  }

  const nowTime = new Date().toTimeString().slice(0, 5); // HH:MM
  let upcoming = todayClasses.find(c => c.end_time > nowTime);

  if (!upcoming) {
    container.innerHTML = `
      <div style="font-size: 0.85rem; color: var(--text-muted); text-transform: uppercase; font-weight: 700; margin-bottom: 0.35rem;">Today's Classes Complete</div>
      <div style="font-size: 1.15rem; font-weight: 700; color: var(--color-brand-primary);">All Lectures Finished 🎉</div>
      <div style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 0.25rem;">Enjoy your evening or visit the library for self-study.</div>
    `;
    return;
  }

  const isOngoing = upcoming.start_time <= nowTime && upcoming.end_time > nowTime;

  container.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.5rem;">
      <span style="font-size: 0.75rem; font-weight: 700; text-transform: uppercase; color: ${isOngoing ? 'var(--color-success)' : 'var(--color-brand-primary)'};">
        ${isOngoing ? '● NOW IN PROGRESS' : 'NEXT UPCOMING PERIOD'}
      </span>
      <span style="font-size: 0.8rem; font-weight: 700; color: var(--text-muted);" class="tabular-nums">
        ${upcoming.start_time} - ${upcoming.end_time}
      </span>
    </div>

    <div style="font-size: 1.35rem; font-weight: 700; color: var(--color-brand-primary); margin-bottom: 0.25rem;">
      ${upcoming.subject_name}
    </div>

    <div style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 0.5rem;">
      Room: <strong>${upcoming.room_name}</strong> · ${upcoming.slot_label}
    </div>

    <div style="font-size: 0.8rem; padding: 0.4rem 0.65rem; border-radius: var(--radius-sm); background: var(--bg-surface); border: 1px solid var(--border-subtle); display: inline-block;">
      ${upcoming.badgeText}
    </div>
  `;
}

function renderWeeklyBreakdown(fullSchedule) {
  const container = document.getElementById('student-schedule-list');
  if (!container) return;

  if (!fullSchedule.length) {
    container.innerHTML = `<div style="color: var(--text-muted);">No entries found in active timetable.</div>`;
    return;
  }

  // Group by weekday
  const byDay = new Map();
  for (const c of fullSchedule) {
    if (!byDay.has(c.day_name)) byDay.set(c.day_name, []);
    byDay.get(c.day_name).push(c);
  }

  let html = '';
  for (const [dayName, dayClasses] of byDay) {
    html += `
      <div style="margin-bottom: 1.25rem;">
        <h4 style="font-size: 1rem; color: var(--color-brand-primary); margin-bottom: 0.5rem; font-weight: 700; border-bottom: 1px solid var(--border-subtle); padding-bottom: 0.3rem;">
          ${dayName} (${dayClasses.length} Periods)
        </h4>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 0.6rem;">
          ${dayClasses.map(dc => `
            <div style="padding: 0.65rem 0.85rem; background: var(--bg-surface-subtle); border: 1px solid var(--border-subtle); border-radius: var(--radius-md);">
              <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.2rem;">
                <span style="font-weight: 700; font-size: 0.9rem; color: var(--color-brand-primary);">${dc.subject_code}</span>
                <span style="font-size: 0.75rem; color: var(--text-muted);" class="tabular-nums">${dc.start_time}</span>
              </div>
              <div style="font-size: 0.85rem; font-weight: 600; color: var(--text-primary); margin-bottom: 0.2rem;">${dc.subject_name}</div>
              <div style="font-size: 0.75rem; color: var(--text-secondary);">
                ${dc.faculty_name} · Room ${dc.room_name}
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  container.innerHTML = html;
}

async function loadDepartmentTimetable() {
  const container = document.getElementById('department-timetable-container');
  if (!container) return;

  container.innerHTML = `<div style="color: var(--text-muted); font-size: 0.85rem;">Loading full department schedule...</div>`;

  try {
    const data = await apiRequest('/api/student/department-timetable');
    const sections = data.sections || [];
    const workingDays = data.workingDays || [];
    const timeSlots = (data.timeSlots || []).filter(s => s.is_break === 0);
    const entries = data.entries || [];

    if (!sections.length) {
      container.innerHTML = `<div style="color: var(--text-muted);">No department sections found.</div>`;
      return;
    }

    let html = `
      <div style="overflow-x: auto;">
        <table style="width: 100%; border-collapse: collapse; text-align: center; border: 1px solid var(--border-subtle); font-size: 0.8rem;">
          <thead>
            <tr style="background: var(--bg-surface-subtle); border-bottom: 2px solid var(--border-subtle);">
              <th style="padding: 0.6rem; border: 1px solid var(--border-subtle);">Section</th>
              <th style="padding: 0.6rem; border: 1px solid var(--border-subtle);">Day</th>
    `;

    for (const ts of timeSlots) {
      html += `<th style="padding: 0.6rem; border: 1px solid var(--border-subtle);">${ts.label}<br><span style="font-weight: 400; font-size: 0.7rem; color: var(--text-muted);">${ts.start_time}</span></th>`;
    }
    html += `</tr></thead><tbody>`;

    for (const sec of sections) {
      for (let i = 0; i < workingDays.length; i++) {
        const wd = workingDays[i];
        html += `<tr>`;
        if (i === 0) {
          html += `<td rowspan="${workingDays.length}" style="padding: 0.6rem; font-weight: 700; border: 1px solid var(--border-subtle); background: var(--bg-surface-subtle); vertical-align: middle;">Sec ${sec.name}</td>`;
        }
        html += `<td style="padding: 0.5rem; font-weight: 600; border: 1px solid var(--border-subtle); background: var(--bg-surface-subtle);">${wd.day_name}</td>`;

        for (const ts of timeSlots) {
          const entry = entries.find(e => e.section_id === sec.id && e.day_id === wd.id && e.slot_id === ts.id);
          if (entry) {
            html += `
              <td style="padding: 0.4rem; border: 1px solid var(--border-subtle); background: var(--color-brand-blush-soft); text-align: left;">
                <div style="font-weight: 700; color: var(--color-brand-primary);">${entry.subject_code}</div>
                <div style="font-size: 0.7rem; color: var(--text-secondary);">${entry.faculty_name}</div>
                <div style="font-size: 0.65rem; color: var(--text-muted);">${entry.room_name}</div>
              </td>
            `;
          } else {
            html += `<td style="padding: 0.4rem; border: 1px solid var(--border-subtle); color: var(--text-muted); font-size: 0.7rem;">Free</td>`;
          }
        }

        html += `</tr>`;
      }
    }

    html += `</tbody></table></div>`;
    container.innerHTML = html;

  } catch (err) {
    container.innerHTML = `<div style="color: var(--color-error);">Failed to load department timetable: ${err.message}</div>`;
  }
}

export default { loadSchedule };
