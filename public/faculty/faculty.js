import { apiRequest } from '/js/api.js';
import { checkSession, logout } from '/js/auth.js';
import { showToast } from '/js/toast.js';
import { initSSE, onEvent } from '/js/sse.js';

let currentFaculty = null;
let currentYear = new Date().getFullYear();
let currentMonth = new Date().getMonth();
let selectedDateStr = new Date().toISOString().split('T')[0];
let activeView = 'calendar'; // 'calendar' | 'today' | 'weekly' | 'availability'

document.addEventListener('DOMContentLoaded', async () => {
  const user = await checkSession('faculty');
  if (!user) return;

  // Initialize SSE for live schedule and substitution updates
  initSSE('/api/events');
  onEvent('timetable.updated', () => {
    loadCalendar(currentYear, currentMonth);
    loadOpenSubstitutions();
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
  await loadTodayTracker();
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

  // Slide-in panel close
  document.getElementById('side-panel-close')?.addEventListener('click', () => {
    document.getElementById('day-slide-panel').style.transform = 'translateX(100%)';
  });

  // Absence modal open/close
  document.getElementById('btn-report-absence')?.addEventListener('click', () => {
    const dateInput = document.getElementById('abs-date');
    if (dateInput && !dateInput.value) {
      dateInput.value = new Date().toISOString().split('T')[0];
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
      await loadTodayTracker();
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

  if (view === 'today') loadTodayTracker();
  if (view === 'substitutions') loadOpenSubstitutions();
  if (view === 'availability') loadFacultyAvailability();
}

async function loadProfile() {
  try {
    const data = await apiRequest('/api/faculty/profile');
    currentFaculty = data.faculty;
    if (data.faculty) {
      document.getElementById('faculty-name-header').textContent = data.faculty.name;
      document.getElementById('faculty-dept-line').textContent = `${data.faculty.department_name} · Email: ${data.faculty.email} · Phone: ${data.faculty.phone}`;
      document.getElementById('stat-weekly-load').textContent = `${data.weeklySchedule?.length || 0} Periods`;
    }

    const subList = document.getElementById('assigned-subjects-list');
    if (subList && data.assignedSubjects?.length) {
      subList.innerHTML = data.assignedSubjects.map(s => `
        <div style="padding: 0.6rem 0.8rem; background: var(--bg-surface-subtle); border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); display: flex; justify-content: space-between; align-items: center;">
          <div>
            <span style="font-weight: 700; color: var(--color-brand-primary);">${s.code}</span>
            <span style="font-size: 0.85rem; margin-left: 0.4rem;">${s.name}</span>
          </div>
          <span style="font-size: 0.75rem; color: var(--text-muted);">${s.section_name} (${s.type})</span>
        </div>
      `).join('');
    }
  } catch (err) {
    console.error('Failed to load profile:', err);
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
    const todayStr = new Date().toISOString().split('T')[0];

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

    // Attach click listener to each date cell for Slide-in panel
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

// Slide-In Panel Listing Day's Schedule in Time Order
async function openDateSlidePanel(dateStr) {
  selectedDateStr = dateStr;
  const panel = document.getElementById('day-slide-panel');
  if (!panel) return;

  panel.style.transform = 'translateX(0)';

  try {
    const data = await apiRequest(`/api/faculty/schedule-date?date=${dateStr}`);
    document.getElementById('panel-date-title').textContent = `${data.dayName}, ${data.date}`;
    document.getElementById('panel-date-status').textContent = data.status.toUpperCase();
    document.getElementById('panel-date-status').style.color = data.colorClass === 'green' ? 'var(--color-success)' : (data.colorClass === 'soft-red' ? 'var(--color-error)' : 'var(--color-warning)');

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
      return `
        <div style="padding: 0.85rem 1rem; background: var(--color-brand-blush-soft); border-radius: var(--radius-md); border: 1px solid var(--border-strong); display: flex; justify-content: space-between; align-items: flex-start;">
          <div>
            <div style="font-weight: 700; color: var(--color-brand-primary); font-size: 0.95rem;">
              ${s.subjectCode} · ${s.subjectName}
            </div>
            <div style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 0.2rem;">
              Section: <strong>${s.sectionName}</strong> · Room: <strong>${s.roomName}</strong> (${s.subjectType.toUpperCase()})
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

// Today View with Next Class Tracker & Countdown
async function loadTodayTracker() {
  try {
    const data = await apiRequest('/api/faculty/today');
    const container = document.getElementById('today-classes-container');
    const trackerBox = document.getElementById('next-class-tracker-box');

    if (trackerBox) {
      if (data.currentClass) {
        trackerBox.innerHTML = `
          <div style="font-size: 0.75rem; color: var(--color-success); font-weight: 700; text-transform: uppercase;">Class Happening Now</div>
          <div style="font-size: 1.35rem; font-weight: 700; color: var(--text-primary); margin-top: 0.2rem;">
            ${data.currentClass.subjectCode} · ${data.currentClass.subjectName}
          </div>
          <div style="font-size: 0.9rem; color: var(--text-secondary); margin-top: 0.2rem;">
            Section: ${data.currentClass.sectionName} · Room: ${data.currentClass.roomName} · ${data.currentClass.startTime} - ${data.currentClass.endTime}
          </div>
        `;
      } else if (data.nextClass) {
        trackerBox.innerHTML = `
          <div style="font-size: 0.75rem; color: var(--color-brand-primary); font-weight: 700; text-transform: uppercase;">Upcoming Next Class</div>
          <div style="font-size: 1.35rem; font-weight: 700; color: var(--text-primary); margin-top: 0.2rem;">
            ${data.nextClass.subjectCode} · ${data.nextClass.subjectName}
          </div>
          <div style="font-size: 0.9rem; color: var(--text-secondary); margin-top: 0.2rem;">
            Section: ${data.nextClass.sectionName} · Room: ${data.nextClass.roomName} · Starts at ${data.nextClass.startTime}
          </div>
        `;
      } else {
        trackerBox.innerHTML = `
          <div style="font-size: 0.85rem; color: var(--text-muted);">No further classes scheduled for today. You are free for research and office hours.</div>
        `;
      }
    }

    if (container && data.allClasses) {
      if (data.allClasses.length === 0) {
        container.innerHTML = `<div style="color: var(--text-muted); padding: 1.5rem; text-align: center;">No scheduled teaching classes today.</div>`;
      } else {
        container.innerHTML = data.allClasses.map(c => `
          <div style="padding: 0.75rem 1rem; background: var(--bg-surface-subtle); border-radius: var(--radius-md); border: 1px solid var(--border-subtle); display: flex; justify-content: space-between; align-items: center;">
            <div>
              <span style="font-weight: 700; color: var(--color-brand-primary);">${c.subjectCode} · ${c.subjectName}</span>
              <span style="font-size: 0.85rem; color: var(--text-secondary); margin-left: 0.5rem;">Section ${c.sectionName} (${c.roomName})</span>
            </div>
            <div style="text-align: right;">
              <div style="font-size: 0.8rem; font-weight: 600;">${c.slotLabel}</div>
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

// 4. Open Substitutions Board (Mode A: Self-Service Claim)
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

export default { switchView };
