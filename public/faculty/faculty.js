import { apiRequest } from '/js/api.js';
import { checkSession, logout } from '/js/auth.js';
import { showToast } from '/js/toast.js';
import { initSSE, onEvent } from '/js/sse.js';

let currentFaculty = null;
let currentYear = new Date().getFullYear();
let currentMonth = new Date().getMonth();
let selectedDateStr = getLocalDateString(new Date());
let activeView = 'calendar'; // 'calendar' | 'today' | 'weekly' | 'availability' | 'substitutions'

function getLocalDateString(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseLocalDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDaysToDateStr(dateStr, days) {
  const d = parseLocalDate(dateStr);
  d.setDate(d.getDate() + days);
  return getLocalDateString(d);
}

document.addEventListener('DOMContentLoaded', async () => {
  const user = await checkSession('faculty');
  if (!user) return;

  // Initialize SSE for live schedule and substitution updates
  initSSE('/api/events');
  onEvent('timetable.updated', () => {
    loadCalendar(currentYear, currentMonth);
    loadOpenSubstitutions();
    if (activeView === 'weekly') loadWeeklySchedule();
    if (activeView === 'today') loadTodayTracker(selectedDateStr);
  });
  onEvent('absence:created', (data) => {
    showToast(`Notice: ${data.facultyName} reported ${data.type} on ${data.date}. Open slots available.`, 'info');
    loadCalendar(currentYear, currentMonth);
    loadOpenSubstitutions();
  });
  onEvent('substitution:claimed', (data) => {
    showToast(`Colleague ${data.substituteFacultyName} covered ${data.subjectName} (Period ${data.slotNo}) on ${data.date}.`, 'success');
    loadCalendar(currentYear, currentMonth);
    loadOpenSubstitutions();
  });
  onEvent('substitution:assigned', (data) => {
    showToast(`Admin assigned ${data.substituteFacultyName} to ${data.subjectName} on ${data.date}.`, 'info');
    loadCalendar(currentYear, currentMonth);
    loadOpenSubstitutions();
  });

  setupNavigation();
  await loadProfile();
  await loadCalendar(currentYear, currentMonth);
  await loadTodayTracker(selectedDateStr);
  await loadOpenSubstitutions();
});

function setupNavigation() {
  document.getElementById('logout-btn')?.addEventListener('click', logout);

  document.querySelectorAll('[data-fac-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-fac-view]').forEach(b => {
        b.classList.remove('btn-primary');
        b.classList.add('btn-secondary');
      });
      btn.classList.add('btn-primary');
      btn.classList.remove('btn-secondary');

      activeView = btn.getAttribute('data-fac-view');
      switchView(activeView);
    });
  });

  // Calendar prev/today/next controls
  document.getElementById('cal-prev')?.addEventListener('click', () => {
    currentMonth--;
    if (currentMonth < 0) { currentMonth = 11; currentYear--; }
    loadCalendar(currentYear, currentMonth);
  });

  document.getElementById('cal-today')?.addEventListener('click', () => {
    const now = new Date();
    currentYear = now.getFullYear();
    currentMonth = now.getMonth();
    loadCalendar(currentYear, currentMonth);
  });

  document.getElementById('cal-next')?.addEventListener('click', () => {
    currentMonth++;
    if (currentMonth > 11) { currentMonth = 0; currentYear++; }
    loadCalendar(currentYear, currentMonth);
  });

  // Close calendar selected day card
  document.getElementById('btn-close-calendar-day')?.addEventListener('click', () => {
    const card = document.getElementById('calendar-selected-day-card');
    if (card) card.style.display = 'none';
  });

  // Slide-in panel close
  document.getElementById('side-panel-close')?.addEventListener('click', () => {
    const panel = document.getElementById('day-slide-panel');
    if (panel) panel.style.transform = 'translateX(100%)';
  });

  // Today view date navigation buttons & picker
  const picker = document.getElementById('fac-date-picker');
  if (picker) {
    picker.value = selectedDateStr;
    picker.addEventListener('change', () => {
      if (picker.value) {
        selectedDateStr = picker.value;
        loadTodayTracker(selectedDateStr);
      }
    });
  }

  document.getElementById('btn-fac-date-prev')?.addEventListener('click', () => {
    selectedDateStr = addDaysToDateStr(selectedDateStr, -1);
    if (picker) picker.value = selectedDateStr;
    loadTodayTracker(selectedDateStr);
  });

  document.getElementById('btn-fac-date-today')?.addEventListener('click', () => {
    selectedDateStr = getLocalDateString(new Date());
    if (picker) picker.value = selectedDateStr;
    loadTodayTracker(selectedDateStr);
  });

  document.getElementById('btn-fac-date-tomorrow')?.addEventListener('click', () => {
    selectedDateStr = addDaysToDateStr(getLocalDateString(new Date()), 1);
    if (picker) picker.value = selectedDateStr;
    loadTodayTracker(selectedDateStr);
  });

  document.getElementById('btn-fac-date-next')?.addEventListener('click', () => {
    selectedDateStr = addDaysToDateStr(selectedDateStr, 1);
    if (picker) picker.value = selectedDateStr;
    loadTodayTracker(selectedDateStr);
  });

  // Absence modal open/close
  document.getElementById('btn-report-absence')?.addEventListener('click', () => {
    const dateInput = document.getElementById('abs-date');
    if (dateInput && !dateInput.value) {
      dateInput.value = selectedDateStr;
    }
    document.getElementById('modal-absence').style.display = 'flex';
  });

  document.getElementById('modal-absence-close')?.addEventListener('click', () => {
    document.getElementById('modal-absence').style.display = 'none';
  });

  // Toggle expected arrival field when late selected
  const absTypeSelect = document.getElementById('abs-type');
  const grpArrival = document.getElementById('grp-expected-arrival');
  absTypeSelect?.addEventListener('change', () => {
    if (grpArrival) {
      grpArrival.style.display = absTypeSelect.value === 'late' ? 'block' : 'none';
    }
  });

  // Absence report form submission
  document.getElementById('form-report-absence')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const date = document.getElementById('abs-date').value;
    const type = document.getElementById('abs-type').value;
    const expectedArrival = type === 'late' ? document.getElementById('abs-arrival').value : null;
    const reason = document.getElementById('abs-reason').value;

    try {
      const res = await apiRequest('/api/absence/report', {
        method: 'POST',
        body: { date, type, expectedArrival, reason }
      });

      showToast(`Notice registered! ${res.affectedClasses?.length || 0} affected class period(s) surfaced on the substitution board.`, 'success');
      document.getElementById('modal-absence').style.display = 'none';
      await loadCalendar(currentYear, currentMonth);
      await loadTodayTracker(selectedDateStr);
      await loadOpenSubstitutions();
    } catch (err) {
      // error handled by apiRequest toast
    }
  });

  document.getElementById('btn-refresh-subs')?.addEventListener('click', () => {
    loadOpenSubstitutions();
    showToast('Substitutions board refreshed', 'info');
  });
}

function switchView(view) {
  document.querySelectorAll('.fac-view-panel').forEach(p => p.style.display = 'none');
  const target = document.getElementById(`view-${view}`);
  if (target) target.style.display = 'block';

  if (view === 'today') loadTodayTracker(selectedDateStr);
  if (view === 'weekly') loadWeeklySchedule();
  if (view === 'substitutions') loadOpenSubstitutions();
  if (view === 'availability') loadFacultyAvailability();
}

async function loadProfile() {
  try {
    const data = await apiRequest('/api/faculty/profile');
    currentFaculty = data.faculty;
    if (data.faculty) {
      document.getElementById('faculty-name-header').textContent = data.faculty.name;
      const deptParts = [
        data.faculty.department_name,
        data.faculty.email ? `Email: ${data.faculty.email}` : null,
        data.faculty.phone ? `Phone: ${data.faculty.phone}` : null
      ].filter(Boolean);
      document.getElementById('faculty-dept-line').textContent = deptParts.join(' · ') || 'Department of Computer Science & Engineering';
      
      const periodsCount = data.weeklySchedule?.length || 0;
      document.getElementById('stat-weekly-load').textContent = `${periodsCount} Periods`;
      const badge = document.getElementById('fac-weekly-load-badge');
      if (badge) badge.textContent = `${periodsCount} Periods / Week`;

      const headerChip = document.getElementById('user-display-name');
      if (headerChip) {
        headerChip.textContent = data.faculty.name;
      }
      const roleBadge = document.getElementById('user-role-badge');
      if (roleBadge) {
        roleBadge.textContent = 'FACULTY';
      }
      document.title = `${data.faculty.name} · Faculty Dashboard · CTAS`;
    }

    const subList = document.getElementById('assigned-subjects-list');
    if (subList) {
      if (data.assignedSubjects?.length) {
        subList.innerHTML = data.assignedSubjects.map(s => `
          <div style="padding: 0.6rem 0.8rem; background: var(--bg-surface-subtle); border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); display: flex; justify-content: space-between; align-items: center;">
            <div>
              <span style="font-weight: 700; color: var(--color-brand-primary);">${s.code}</span>
              <span style="font-size: 0.85rem; margin-left: 0.4rem;">${s.name}</span>
            </div>
            <span style="font-size: 0.75rem; color: var(--text-muted);">${s.section_name} (${s.type})</span>
          </div>
        `).join('');
      } else {
        subList.innerHTML = `<div style="color: var(--text-muted); font-size: 0.85rem;">No courses currently assigned.</div>`;
      }
    }
  } catch (err) {
    console.error('Failed to load profile:', err);
  }
}

// Full Monday to Saturday Weekly Timetable View for Faculty
async function loadWeeklySchedule() {
  const container = document.getElementById('faculty-weekly-grid-container');
  if (!container) return;

  container.innerHTML = `<div style="padding: 1.5rem; text-align: center; color: var(--text-muted);">Loading weekly schedule...</div>`;

  try {
    const data = await apiRequest('/api/faculty/profile');
    const schedule = data.weeklySchedule || [];

    const badge = document.getElementById('fac-weekly-load-badge');
    if (badge) badge.textContent = `${schedule.length} Periods / Week`;
    const statLoad = document.getElementById('stat-weekly-load');
    if (statLoad) statLoad.textContent = `${schedule.length} Periods`;

    if (schedule.length === 0) {
      container.innerHTML = `<div style="padding: 2rem; text-align: center; color: var(--text-muted); background: var(--bg-surface-subtle); border-radius: var(--radius-md);">No weekly classes scheduled in active timetable.</div>`;
      return;
    }

    const days = [
      { index: 1, name: 'Monday', short: 'Mon' },
      { index: 2, name: 'Tuesday', short: 'Tue' },
      { index: 3, name: 'Wednesday', short: 'Wed' },
      { index: 4, name: 'Thursday', short: 'Thu' },
      { index: 5, name: 'Friday', short: 'Fri' },
      { index: 6, name: 'Saturday', short: 'Sat' }
    ];

    // Standard time slots (1 to 7)
    const slotMap = new Map();
    schedule.forEach(e => {
      if (!slotMap.has(e.slot_no)) {
        slotMap.set(e.slot_no, {
          slotNo: e.slot_no,
          label: e.slot_label || `Period ${e.slot_no}`,
          startTime: e.start_time,
          endTime: e.end_time
        });
      }
    });

    // Ensure all 7 standard slots are present for grid continuity
    const defaultSlots = [
      { slotNo: 1, label: 'Period 1', startTime: '09:00', endTime: '10:00' },
      { slotNo: 2, label: 'Period 2', startTime: '10:00', endTime: '11:00' },
      { slotNo: 3, label: 'Period 3', startTime: '11:15', endTime: '12:15' },
      { slotNo: 4, label: 'Period 4', startTime: '12:15', endTime: '13:15' },
      { slotNo: 5, label: 'Period 5', startTime: '14:00', endTime: '15:00' },
      { slotNo: 6, label: 'Period 6', startTime: '15:00', endTime: '16:00' },
      { slotNo: 7, label: 'Period 7', startTime: '16:00', endTime: '17:00' }
    ];

    defaultSlots.forEach(ds => {
      if (!slotMap.has(ds.slotNo)) {
        slotMap.set(ds.slotNo, ds);
      }
    });

    const slots = Array.from(slotMap.values()).sort((a, b) => a.slotNo - b.slotNo);

    let html = `
      <table style="width: 100%; border-collapse: collapse; border: 1px solid var(--border-subtle); font-size: 0.8rem; background: var(--bg-surface);">
        <thead>
          <tr style="background: var(--bg-surface-subtle); border-bottom: 2px solid var(--border-subtle);">
            <th style="padding: 0.6rem 0.5rem; border: 1px solid var(--border-subtle); width: 105px; text-align: center;">Period</th>
            ${days.map(d => `<th style="padding: 0.6rem 0.5rem; border: 1px solid var(--border-subtle); text-align: center; min-width: 120px;">${d.name}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
    `;

    for (const slot of slots) {
      html += `
        <tr>
          <td style="padding: 0.5rem 0.4rem; border: 1px solid var(--border-subtle); background: var(--bg-surface-subtle); text-align: center; font-weight: 700;">
            <div style="color: var(--color-brand-primary);">${slot.label}</div>
            <div style="font-size: 0.68rem; color: var(--text-muted); font-weight: 400;" class="tabular-nums">${slot.startTime} - ${slot.endTime}</div>
          </td>
      `;

      for (const d of days) {
        const cellEntries = schedule.filter(e => e.day_index === d.index && e.slot_no === slot.slotNo);

        if (cellEntries.length === 0) {
          html += `<td style="padding: 0.4rem; border: 1px solid var(--border-subtle); text-align: center; color: var(--text-muted); font-size: 0.72rem;">—</td>`;
        } else {
          html += `<td style="padding: 0.35rem; border: 1px solid var(--border-subtle); vertical-align: top; background: var(--bg-surface);">`;
          html += cellEntries.map(e => `
            <div style="padding: 0.4rem 0.5rem; background: var(--color-brand-blush-soft); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); margin-bottom: 0.25rem;">
              <div style="display: flex; justify-content: space-between; align-items: baseline; gap: 0.2rem;">
                <span style="font-weight: 700; color: var(--color-brand-primary); font-size: 0.8rem;">${e.subject_code}</span>
                ${e.batch ? `<span style="font-size: 0.65rem; font-weight: 700; background: var(--bg-surface); padding: 0.05rem 0.25rem; border-radius: 3px; border: 1px solid var(--border-subtle);">B:${e.batch}</span>` : ''}
              </div>
              <div style="font-size: 0.72rem; color: var(--text-primary); font-weight: 600; line-height: 1.2; margin-top: 0.15rem;">${e.subject_name}</div>
              <div style="font-size: 0.68rem; color: var(--text-secondary); margin-top: 0.15rem;">
                Sec: <strong>${e.section_name}</strong>
              </div>
              <div style="font-size: 0.65rem; color: var(--text-muted);">${e.room_name}</div>
            </div>
          `).join('');
          html += `</td>`;
        }
      }

      html += `</tr>`;
    }

    html += `</tbody></table>`;
    container.innerHTML = html;

  } catch (err) {
    console.error('Failed to load weekly schedule:', err);
    container.innerHTML = `<div style="color: var(--color-error); padding: 1.5rem;">Failed to load weekly timetable: ${err.message}</div>`;
  }
}

// Interactive Month Calendar with Green-Present convention
async function loadCalendar(year, month) {
  const container = document.getElementById('calendar-grid-cells');
  const monthTitle = document.getElementById('calendar-month-title');
  if (!container) return;

  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  if (monthTitle) monthTitle.textContent = `${monthNames[month]} ${year}`;

  try {
    const calData = await apiRequest(`/api/faculty/calendar?year=${year}&month=${month}`);
    const firstDayOfWeek = new Date(year, month, 1).getDay(); // 0 = Sunday
    const todayStr = getLocalDateString(new Date());

    let html = '';

    // Empty leading padding cells
    for (let i = 0; i < firstDayOfWeek; i++) {
      html += `<div style="height: 85px; border-radius: var(--radius-sm); background: var(--bg-surface-subtle); opacity: 0.25;"></div>`;
    }

    // Days of the month
    for (const d of calData.days) {
      const isToday = d.date === todayStr;

      // Color mapping: Green-present convention
      let bg = 'var(--color-success-bg)';
      let textCol = 'var(--color-success)';
      let statusText = d.classesCount > 0 ? `${d.classesCount} class(es)` : 'Working / Free';

      if (d.colorClass === 'grey') {
        bg = 'var(--bg-surface-subtle)';
        textCol = 'var(--text-muted)';
        statusText = d.holidayDesc || 'Holiday';
      } else if (d.colorClass === 'soft-red') {
        bg = 'var(--color-error-bg)';
        textCol = 'var(--color-error)';
        statusText = 'Marked Absent';
      } else if (d.colorClass === 'amber') {
        bg = 'var(--color-warning-bg)';
        textCol = 'var(--color-warning)';
        statusText = `Late (${d.absence?.expectedArrival || 'Delayed'})`;
      }

      const ringStyle = isToday ? 'outline: 3px solid var(--color-brand-primary); outline-offset: -2px;' : '';

      html += `
        <div class="cal-day-cell" data-date="${d.date}" style="height: 85px; border-radius: var(--radius-sm); background: ${bg}; border: 1px solid var(--border-subtle); ${ringStyle} padding: 0.5rem; cursor: pointer; text-align: left; display: flex; flex-direction: column; justify-content: space-between; transition: transform 0.15s, box-shadow 0.15s;">
          <div style="display: flex; justify-content: space-between; align-items: flex-start;">
            <span style="font-weight: 700; font-size: 0.95rem; color: ${textCol};">${d.dayNumber}</span>
            ${isToday ? '<span style="font-size: 0.65rem; background: var(--color-brand-primary); color: #fff; padding: 0.1rem 0.35rem; border-radius: 3px; font-weight: 700;">TODAY</span>' : ''}
          </div>
          <div style="font-size: 0.75rem; color: ${textCol}; font-weight: 600; line-height: 1.2;">
            ${statusText}
          </div>
        </div>
      `;
    }

    container.innerHTML = html;

    // Attach click listener to each date cell for Slide-in panel and inline view
    container.querySelectorAll('.cal-day-cell').forEach(cell => {
      cell.addEventListener('click', () => {
        const date = cell.getAttribute('data-date');
        openDateSlidePanel(date);
      });
    });

  } catch (err) {
    console.error('Failed to load calendar:', err);
  }
}

// Slide-In Panel & Inline Card Listing Day's Schedule in Time Order
async function openDateSlidePanel(dateStr) {
  selectedDateStr = dateStr;
  const panel = document.getElementById('day-slide-panel');
  if (panel) panel.style.transform = 'translateX(0)';

  try {
    const data = await apiRequest(`/api/faculty/schedule-date?date=${dateStr}`);
    const panelTitle = document.getElementById('panel-date-title');
    if (panelTitle) panelTitle.textContent = `${data.dayName}, ${data.date}`;
    
    const panelStatus = document.getElementById('panel-date-status');
    if (panelStatus) {
      panelStatus.textContent = data.status.toUpperCase();
      panelStatus.style.color = data.colorClass === 'green' ? 'var(--color-success)' : (data.colorClass === 'soft-red' ? 'var(--color-error)' : 'var(--color-warning)');
    }

    const teachingSlots = data.schedule.filter(s => !s.isBreak && !s.isFree);

    // Also populate the inline card under the month calendar
    const inlineCard = document.getElementById('calendar-selected-day-card');
    const inlineTitle = document.getElementById('calendar-selected-day-title');
    const inlineList = document.getElementById('calendar-selected-day-list');

    if (inlineCard && inlineTitle && inlineList) {
      inlineCard.style.display = 'block';
      inlineTitle.textContent = `Schedule for ${data.dayName}, ${data.date} (${teachingSlots.length} Teaching Classes)`;

      if (teachingSlots.length === 0) {
        inlineList.innerHTML = `
          <div style="padding: 1rem; text-align: center; color: var(--text-muted); background: var(--bg-surface-subtle); border-radius: var(--radius-sm);">
            No scheduled teaching classes on this day (${data.dayName}) · Free for research, student mentoring, and office hours.
          </div>
        `;
      } else {
        inlineList.innerHTML = teachingSlots.map(s => `
          <div style="padding: 0.75rem 1rem; background: var(--color-brand-blush-soft); border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.5rem;">
            <div>
              <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
                <span style="font-weight: 700; color: var(--color-brand-primary); font-size: 0.95rem;">${s.subjectCode} · ${s.subjectName}</span>
                <span style="font-size: 0.75rem; background: var(--bg-surface); border: 1px solid var(--border-subtle); padding: 0.15rem 0.4rem; border-radius: 4px; font-weight: 600;">Sec ${s.sectionName}</span>
                ${s.batch ? `<span style="font-size: 0.75rem; background: var(--bg-surface); border: 1px solid var(--border-subtle); padding: 0.15rem 0.4rem; border-radius: 4px; font-weight: 700;">Batch ${s.batch}</span>` : ''}
                <span style="font-size: 0.75rem; color: var(--text-muted);">Room: ${s.roomName}</span>
              </div>
            </div>
            <div style="text-align: right;">
              <div style="font-size: 0.8rem; font-weight: 700;">${s.label}</div>
              <div style="font-size: 0.75rem; color: var(--text-muted);" class="tabular-nums">${s.startTime} - ${s.endTime}</div>
            </div>
          </div>
        `).join('');
      }
    }

    const container = document.getElementById('panel-slots-list');
    if (!container) return;

    container.innerHTML = data.schedule.map(s => {
      if (s.isBreak) {
        return `
          <div style="padding: 0.6rem 0.85rem; background: repeating-linear-gradient(45deg, var(--bg-surface-subtle), var(--bg-surface-subtle) 8px, var(--bg-canvas) 8px, var(--bg-canvas) 16px); border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); display: flex; justify-content: space-between; align-items: center;">
            <span style="font-size: 0.8rem; font-weight: 600; color: var(--text-muted);">${s.label}</span>
            <span style="font-size: 0.75rem; color: var(--text-muted);" class="tabular-nums">${s.startTime} - ${s.endTime}</span>
          </div>
        `;
      }

      if (s.isFree) {
        return `
          <div style="padding: 0.75rem 1rem; background: var(--bg-surface); border-radius: var(--radius-md); border: 1px dashed var(--border-strong); display: flex; justify-content: space-between; align-items: center;">
            <div>
              <div style="font-weight: 700; font-size: 0.85rem; color: var(--color-success);">${s.label}: Free Period</div>
              <div style="font-size: 0.75rem; color: var(--text-muted);">${s.freeLabel}</div>
            </div>
            <span style="font-size: 0.8rem; color: var(--text-secondary);" class="tabular-nums">${s.startTime} - ${s.endTime}</span>
          </div>
        `;
      }

      // Scheduled Class
      const typeStr = s.subjectType ? `(${s.subjectType.toUpperCase()})` : '';
      return `
        <div style="padding: 0.85rem 1rem; background: var(--color-brand-blush-soft); border-radius: var(--radius-md); border: 1px solid var(--border-strong); display: flex; justify-content: space-between; align-items: flex-start;">
          <div>
            <div style="font-weight: 700; color: var(--color-brand-primary); font-size: 0.95rem;">
              ${s.subjectCode} · ${s.subjectName}
            </div>
            <div style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 0.2rem;">
              Section: <strong>${s.sectionName}</strong> ${s.batch ? `· Batch: <strong>${s.batch}</strong>` : ''} · Room: <strong>${s.roomName}</strong> ${typeStr}
            </div>
            ${s.isCoveredByColleague ? `<div style="font-size: 0.75rem; color: var(--color-info); margin-top: 0.25rem;">✓ Covered by colleague: Prof. ${s.substituteFacultyName}</div>` : ''}
            ${s.isSubstituteDuty ? `<div style="font-size: 0.75rem; color: var(--color-warning); margin-top: 0.25rem;">★ Covering as Substitute for ${s.originalFacultyName}</div>` : ''}
          </div>
          <div style="text-align: right;">
            <div style="font-size: 0.8rem; font-weight: 700;">${s.label}</div>
            <div style="font-size: 0.75rem; color: var(--text-muted);" class="tabular-nums">${s.startTime} - ${s.endTime}</div>
          </div>
        </div>
      `;
    }).join('');

  } catch (err) {
    console.error('Failed to load day schedule:', err);
  }
}

// Today View with Date Navigation & Next Class Tracker
async function loadTodayTracker(dateStr) {
  const targetDate = dateStr || selectedDateStr || getLocalDateString(new Date());
  selectedDateStr = targetDate;

  // Sync date picker input value
  const picker = document.getElementById('fac-date-picker');
  if (picker && picker.value !== targetDate) {
    picker.value = targetDate;
  }

  // Update button active states
  const todayStr = getLocalDateString(new Date());
  const tomorrowStr = addDaysToDateStr(todayStr, 1);
  const btnToday = document.getElementById('btn-fac-date-today');
  const btnTomorrow = document.getElementById('btn-fac-date-tomorrow');

  if (btnToday) {
    if (targetDate === todayStr) {
      btnToday.classList.add('btn-primary');
      btnToday.classList.remove('btn-secondary');
    } else {
      btnToday.classList.remove('btn-primary');
      btnToday.classList.add('btn-secondary');
    }
  }

  if (btnTomorrow) {
    if (targetDate === tomorrowStr) {
      btnTomorrow.classList.add('btn-primary');
      btnTomorrow.classList.remove('btn-secondary');
    } else {
      btnTomorrow.classList.remove('btn-primary');
      btnTomorrow.classList.add('btn-secondary');
    }
  }

  try {
    const data = await apiRequest(`/api/faculty/today?date=${targetDate}`);
    const container = document.getElementById('today-classes-container');
    const trackerBox = document.getElementById('next-class-tracker-box');
    const heading = document.getElementById('fac-today-heading');
    const subtext = document.getElementById('fac-today-subtext');

    const dayName = data.daySchedule?.dayName || '';
    if (heading) {
      if (targetDate === todayStr) {
        heading.textContent = `Today's Schedule (${dayName})`;
      } else {
        heading.textContent = `Schedule for ${dayName}, ${targetDate}`;
      }
    }
    if (subtext) {
      subtext.textContent = `Chronological teaching timeline for ${dayName}, ${targetDate} · ${data.allClasses?.length || 0} class(es)`;
    }

    if (trackerBox) {
      if (data.currentClass) {
        trackerBox.innerHTML = `
          <div style="font-size: 0.75rem; color: var(--color-success); font-weight: 700; text-transform: uppercase;">Class Happening Now</div>
          <div style="font-size: 1.35rem; font-weight: 700; color: var(--text-primary); margin-top: 0.2rem;">
            ${data.currentClass.subjectCode} · ${data.currentClass.subjectName}
          </div>
          <div style="font-size: 0.9rem; color: var(--text-secondary); margin-top: 0.2rem;">
            Section: ${data.currentClass.sectionName} ${data.currentClass.batch ? `(Batch ${data.currentClass.batch})` : ''} · Room: ${data.currentClass.roomName} · ${data.currentClass.startTime} - ${data.currentClass.endTime}
          </div>
        `;
      } else if (data.nextClass) {
        trackerBox.innerHTML = `
          <div style="font-size: 0.75rem; color: var(--color-brand-primary); font-weight: 700; text-transform: uppercase;">Upcoming Next Class</div>
          <div style="font-size: 1.35rem; font-weight: 700; color: var(--text-primary); margin-top: 0.2rem;">
            ${data.nextClass.subjectCode} · ${data.nextClass.subjectName}
          </div>
          <div style="font-size: 0.9rem; color: var(--text-secondary); margin-top: 0.2rem;">
            Section: ${data.nextClass.sectionName} ${data.nextClass.batch ? `(Batch ${data.nextClass.batch})` : ''} · Room: ${data.nextClass.roomName} · Starts at ${data.nextClass.startTime}
          </div>
        `;
      } else {
        trackerBox.innerHTML = `
          <div style="font-size: 0.85rem; color: var(--text-muted);">No ongoing teaching classes for this date. Free for research, grading, and office hours.</div>
        `;
      }
    }

    if (container && data.allClasses) {
      if (data.allClasses.length === 0) {
        container.innerHTML = `
          <div style="padding: 2.5rem; text-align: center; color: var(--text-muted); background: var(--bg-surface-subtle); border-radius: var(--radius-md); border: 1px dashed var(--border-subtle);">
            <div style="font-size: 2rem; margin-bottom: 0.5rem;">☕</div>
            <div style="font-weight: 700; font-size: 1.1rem; color: var(--text-primary); margin-bottom: 0.25rem;">No Scheduled Teaching Classes</div>
            <p style="font-size: 0.85rem;">You have 0 teaching periods scheduled on ${dayName} (${targetDate}). Use this time for research, student mentorship, and laboratory prep.</p>
          </div>
        `;
      } else {
        container.innerHTML = data.allClasses.map(c => `
          <div style="padding: 0.9rem 1.1rem; background: var(--bg-surface-subtle); border-radius: var(--radius-md); border: 1px solid var(--border-subtle); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.75rem;">
            <div>
              <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
                <span style="font-weight: 700; color: var(--color-brand-primary); font-size: 1.05rem;">${c.subjectCode} · ${c.subjectName}</span>
                <span style="font-size: 0.75rem; background: var(--bg-surface); border: 1px solid var(--border-subtle); padding: 0.2rem 0.5rem; border-radius: 4px; font-weight: 600;">Sec ${c.sectionName}</span>
                ${c.batch ? `<span style="font-size: 0.75rem; background: var(--color-brand-blush-soft); color: var(--color-brand-primary); border: 1px solid var(--border-subtle); padding: 0.2rem 0.5rem; border-radius: 4px; font-weight: 700;">Batch ${c.batch}</span>` : ''}
                <span style="font-size: 0.75rem; background: var(--bg-surface); border: 1px solid var(--border-subtle); padding: 0.2rem 0.5rem; border-radius: 4px;">Room: ${c.roomName}</span>
              </div>
              ${c.isSubstituteDuty ? `<div style="font-size: 0.75rem; color: var(--color-warning); margin-top: 0.25rem; font-weight: 600;">★ Covering as Substitute for ${c.originalFacultyName}</div>` : ''}
            </div>
            <div style="text-align: right;">
              <div style="font-size: 0.85rem; font-weight: 700;">${c.slotLabel || `Period ${c.slotNo}`}</div>
              <div style="font-size: 0.75rem; color: var(--text-muted);" class="tabular-nums">${c.startTime} - ${c.endTime}</div>
            </div>
          </div>
        `).join('');
      }
    }
  } catch (err) {
    console.error('Failed to load today tracker:', err);
  }
}

// Faculty Availability Matrix
async function loadFacultyAvailability() {
  const container = document.getElementById('faculty-availability-matrix');
  if (!container) return;

  try {
    const res = await apiRequest('/api/faculty/availability');
    // Group availability by day
    const dayMap = new Map();
    for (const a of res.availability) {
      if (!dayMap.has(a.day_name)) dayMap.set(a.day_name, []);
      dayMap.get(a.day_name).push(a);
    }

    let html = `
      <table style="width: 100%; border-collapse: collapse; text-align: center; border: 1px solid var(--border-subtle); border-radius: var(--radius-md); overflow: hidden;">
        <thead>
          <tr style="background: var(--bg-surface-subtle); border-bottom: 2px solid var(--border-subtle);">
            <th style="padding: 0.6rem; border: 1px solid var(--border-subtle);">Day</th>
    `;

    const sampleSlots = res.availability.slice(0, 7);
    for (const s of sampleSlots) {
      html += `<th style="padding: 0.6rem; border: 1px solid var(--border-subtle); font-size: 0.8rem;">${s.slot_label}</th>`;
    }
    html += `</tr></thead><tbody>`;

    for (const [dayName, slotList] of dayMap) {
      html += `<tr><td style="padding: 0.6rem; font-weight: 700; border: 1px solid var(--border-subtle); background: var(--bg-surface-subtle);">${dayName}</td>`;
      for (const s of slotList) {
        const isAvail = s.is_available === 1;
        const bg = isAvail ? 'var(--color-success-bg)' : 'var(--color-error-bg)';
        const col = isAvail ? 'var(--color-success)' : 'var(--color-error)';
        const text = isAvail ? '✓ Available' : '✗ Unavailable';
        html += `
          <td class="fac-avail-toggle" data-day="${s.day_id}" data-slot="${s.slot_id}" data-avail="${isAvail ? '1' : '0'}" style="padding: 0.5rem; border: 1px solid var(--border-subtle); background: ${bg}; color: ${col}; font-weight: 600; font-size: 0.75rem; cursor: pointer; user-select: none;">
            ${text}
          </td>
        `;
      }
      html += `</tr>`;
    }

    html += `</tbody></table>`;
    container.innerHTML = html;

    container.querySelectorAll('.fac-avail-toggle').forEach(td => {
      td.addEventListener('click', () => {
        const cur = td.getAttribute('data-avail') === '1';
        const next = !cur;
        td.setAttribute('data-avail', next ? '1' : '0');
        td.style.background = next ? 'var(--color-success-bg)' : 'var(--color-error-bg)';
        td.style.color = next ? 'var(--color-success)' : 'var(--color-error)';
        td.textContent = next ? '✓ Available' : '✗ Unavailable';
      });
    });

    document.getElementById('btn-save-own-avail').onclick = async () => {
      const payload = [];
      container.querySelectorAll('.fac-avail-toggle').forEach(td => {
        payload.push({
          dayId: parseInt(td.getAttribute('data-day'), 10),
          slotId: parseInt(td.getAttribute('data-slot'), 10),
          isAvailable: td.getAttribute('data-avail') === '1'
        });
      });

      await apiRequest('/api/faculty/availability', {
        method: 'PUT',
        body: { availability: payload }
      });
      showToast('Availability preferences updated!', 'success');
    };

  } catch (err) {
    console.error('Failed to load faculty availability:', err);
  }
}

// Open Substitutions Board (Mode A: Self-Service Claim)
async function loadOpenSubstitutions() {
  const container = document.getElementById('open-subs-container');
  const badgeCount = document.getElementById('open-subs-count');
  if (!container) return;

  try {
    const res = await apiRequest('/api/absence/open');
    const subs = res.substitutions || [];

    if (badgeCount) {
      badgeCount.textContent = subs.length;
    }

    if (subs.length === 0) {
      container.innerHTML = `
        <div style="padding: 2.5rem; text-align: center; color: var(--text-muted); background: var(--bg-surface-subtle); border-radius: var(--radius-md); border: 1px dashed var(--border-subtle);">
          <div style="font-size: 2rem; margin-bottom: 0.5rem;">🎉</div>
          <div style="font-size: 1.1rem; font-weight: 600; color: var(--text-primary); margin-bottom: 0.25rem;">All Classes Fully Covered</div>
          <p style="font-size: 0.85rem;">No colleague absence or delay notices pending substitution.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = subs.map(s => {
      const isEligible = s.isEligible;
      return `
        <div class="card animate-fade-in" style="border: 1px solid ${isEligible ? 'var(--color-success)' : 'var(--border-subtle)'}; background: var(--bg-surface); padding: 1.25rem; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem;">
          <div>
            <div style="display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.4rem; flex-wrap: wrap;">
              <span style="font-weight: 700; font-size: 1.1rem; color: var(--color-brand-primary);">${s.subject_name} (${s.subject_code})</span>
              <span style="font-size: 0.75rem; background: var(--bg-surface-subtle); border: 1px solid var(--border-subtle); padding: 0.2rem 0.5rem; border-radius: 4px; font-weight: 600;">Sec ${s.section_name}</span>
              <span style="font-size: 0.75rem; background: var(--bg-surface-subtle); border: 1px solid var(--border-subtle); padding: 0.2rem 0.5rem; border-radius: 4px;">Room: ${s.room_name}</span>
              ${isEligible
                ? `<span style="font-size: 0.75rem; background: var(--color-success-bg); color: var(--color-success); padding: 0.2rem 0.5rem; border-radius: 4px; font-weight: 700;">✓ You are eligible to cover</span>`
                : `<span style="font-size: 0.75rem; background: var(--color-error-bg); color: var(--color-error); padding: 0.2rem 0.5rem; border-radius: 4px;">Schedule clash / load reached</span>`}
            </div>
            <div style="font-size: 0.85rem; color: var(--text-secondary); display: flex; gap: 1.25rem; flex-wrap: wrap;">
              <span><strong>Date:</strong> ${s.date}</span>
              <span><strong>Period:</strong> ${s.slot_label} (${s.start_time} - ${s.end_time})</span>
              <span><strong>Absent Colleague:</strong> ${s.absent_faculty_name}</span>
              <span><strong>Reason:</strong> ${s.absence_reason || 'Personal / Medical'}</span>
            </div>
          </div>

          <div>
            <button class="btn-primary" ${!isEligible ? 'disabled style="opacity: 0.5; cursor: not-allowed;"' : ''} onclick="claimSub(${s.timetable_entry_id}, '${s.date}')">
              I Can Cover This
            </button>
          </div>
        </div>
      `;
    }).join('');

  } catch (err) {
    console.error('Failed to load open substitutions:', err);
  }
}

window.claimSub = async (timetableEntryId, date) => {
  try {
    const res = await apiRequest('/api/absence/substitute/claim', {
      method: 'POST',
      body: { timetableEntryId, date }
    });
    showToast(res.message || 'Substitution claimed successfully!', 'success');
    await loadOpenSubstitutions();
    await loadCalendar(currentYear, currentMonth);
  } catch (err) {
    showToast(err.message || 'Failed to claim substitution', 'error');
    loadOpenSubstitutions();
  }
};

export default { switchView, loadWeeklySchedule, loadTodayTracker };

