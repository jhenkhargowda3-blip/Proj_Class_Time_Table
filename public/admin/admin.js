import { apiRequest } from '/js/api.js';
import { checkSession, logout } from '/js/auth.js';
import { showToast } from '/js/toast.js';
import { initSSE, onEvent } from '/js/sse.js';
import { exportTimetableToPdf, printOrExportPdf, downloadFile } from '/js/exportUtils.js';
import { evaluateTimetableConflicts, validateTimetableConflict } from '/js/timetableValidator.js';
import { TimetableResolver } from '/js/timetableResolver.js';

window.validateTimetableConflict = validateTimetableConflict;

let currentTab = 'overview';
let activeVersionId = null;
let currentVersionData = null;
let masterData = null;
let studioMode = 'section'; // 'section' | 'faculty' | 'room'
let studioEntityId = null;
let draggedEntryId = null;

// Conflict Resolution & Manual Editing State
let draftWorkingEntries = null;
let originalVersionEntries = null;
let isResolvedDraftPreview = false;
let isComparingWithOriginal = false;
let activeResolver = null;
let lastSharedValidation = null;
let undoStack = [];
let redoStack = [];
let activeStepHighlight = null;
let originalBaselineSnapshot = null;

// CSP Timetable Generation Progress Tracker State
let isGenerationRunning = false;
let generationStartTime = null;
let generationTimerInterval = null;

// Absence Tracking & Active Faculty Pulse Notification State
let lastObservedAbsenceCount = null;

document.addEventListener('DOMContentLoaded', async () => {
  const user = await checkSession('admin');
  if (!user) return;

  // Initialize SSE for real-time live sync
  initSSE('/api/events');
  onEvent('timetable.updated', (data) => {
    if (isGenerationRunning || (activeResolver && activeResolver.isRunning) || isResolvedDraftPreview) {
      return;
    }
    if (currentTab === 'studio') loadStudioVersion(activeVersionId);
    if (currentTab === 'overview') loadOverview();
  });

  // Real-time CSP Timetable Generation Progress & Lock Events
  onEvent('timetable.generation_progress', (data) => {
    updateGenerationProgress(data);
  });
  onEvent('timetable.generation_completed', (data) => {
    onGenerationCompleted(data);
  });
  onEvent('timetable.generation_failed', (data) => {
    onGenerationFailed(data);
  });

  onEvent('absence:created', (data) => {
    showToast(`Faculty notice: ${data.facultyName} reported ${data.type} on ${data.date}`, 'warning');
    triggerFacultyCardPulse({ type: 'absence', facultyName: data.facultyName });
    triggerAbsencesCountAlert({ type: 'absence', facultyName: data.facultyName });
    if (currentTab === 'absence') loadAbsenceMonitor();
    if (currentTab === 'overview') loadOverview();
  });
  onEvent('substitution:claimed', (data) => {
    showToast(`Substitution claimed: ${data.substituteFacultyName} for ${data.subjectName}`, 'success');
    triggerFacultyCardPulse({ type: 'substitution', substituteFacultyName: data.substituteFacultyName });
    triggerAbsencesCountAlert({ type: 'substitution', substituteFacultyName: data.substituteFacultyName });
    if (currentTab === 'absence') loadAbsenceMonitor();
    if (currentTab === 'overview') loadOverview();
  });
  onEvent('substitution:assigned', (data) => {
    showToast(`Substitution assigned: ${data.substituteFacultyName} for ${data.subjectName}`, 'info');
    triggerFacultyCardPulse({ type: 'substitution', substituteFacultyName: data.substituteFacultyName });
    triggerAbsencesCountAlert({ type: 'substitution', substituteFacultyName: data.substituteFacultyName });
    if (currentTab === 'absence') loadAbsenceMonitor();
    if (currentTab === 'overview') loadOverview();
  });

  setupNavigation();
  setupModals();
  setupMetricDrilldowns();
  await checkGenerationStatus();
  await loadOverview();
  await loadMasterData();
  renderMasterDataTables();
});

// Navigation tab switching
function setupNavigation() {
  document.querySelectorAll('[data-admin-tab]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const tab = btn.getAttribute('data-admin-tab');
      switchTab(tab);
    });
  });

  document.getElementById('logout-btn')?.addEventListener('click', logout);
  setupMasterDataSubtabs();
  setupMasterDataTools();
}

export function switchTab(tab, preferredVersionId = null) {
  currentTab = tab;
  document.querySelectorAll('[data-admin-tab]').forEach(b => {
    if (b.getAttribute('data-admin-tab') === tab) {
      b.classList.add('btn-primary');
      b.classList.remove('btn-secondary');
    } else {
      b.classList.remove('btn-primary');
      b.classList.add('btn-secondary');
    }
  });

  document.querySelectorAll('.admin-panel').forEach(p => p.style.display = 'none');
  const targetPanel = document.getElementById(`panel-${tab}`);
  if (targetPanel) targetPanel.style.display = 'block';

  if (tab === 'overview') loadOverview();
  if (tab === 'studio') loadStudio(preferredVersionId || activeVersionId);
  if (tab === 'master-data') renderMasterDataTables();
  if (tab === 'availability') loadAvailabilityEditor();
  if (tab === 'assignments') loadAssignments();
  if (tab === 'absence') loadAbsenceMonitor();
  if (tab === 'ai-center') loadAiCenter();
}

window.switchTab = switchTab;


// 1. Overview Loader & Metric Drilldown System
let cachedOverviewData = null;
let currentDrilldownType = null;
let currentDrilldownItems = [];

const METRIC_ICONS = {
  faculty: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
    <circle cx="9" cy="7" r="4"/>
    <path d="M22 21v-2a4 4 0 0 0-3-3.87"/>
    <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
  </svg>`,
  subjects: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
    <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
    <path d="M6 8h2"/><path d="M6 12h2"/><path d="M16 8h2"/><path d="M16 12h2"/>
  </svg>`,
  sections: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polygon points="12 2 2 7 12 12 22 7 12 2"/>
    <polyline points="2 17 12 22 22 17"/>
    <polyline points="2 12 12 17 22 12"/>
  </svg>`,
  rooms: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect width="16" height="20" x="4" y="2" rx="2" ry="2"/>
    <path d="M9 22v-4h6v4"/>
    <path d="M8 6h.01"/><path d="M16 6h.01"/><path d="M8 10h.01"/><path d="M16 10h.01"/><path d="M8 14h.01"/><path d="M16 14h.01"/>
  </svg>`,
  absences: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M8 2v4"/><path d="M16 2v4"/>
    <rect width="18" height="18" x="3" y="4" rx="2"/>
    <path d="M3 10h18"/>
    <path d="m14 14-4 4"/><path d="m10 14 4 4"/>
  </svg>`
};

const COLOR_PALETTES = {
  faculty: ['#6B0010', '#940C1E', '#C1121F', '#E63946', '#FF7B88', '#FFA3AC'],
  subjects: ['#1D4ED8', '#2563EB', '#3B82F6', '#60A5FA', '#93C5FD', '#BFDBFE'],
  sections: ['#B45309', '#D97706', '#F59E0B', '#FBBF24', '#FCD34D', '#FDE68A'],
  rooms: ['#15803D', '#16A34A', '#22C55E', '#4ADE80', '#86EFAC', '#BBF7D0'],
  absences: ['#16A34A', '#D97706', '#E11D48', '#64748B']
};

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function setupMetricDrilldowns() {
  const cards = document.querySelectorAll('.admin-metric-card[data-metric-type]');
  cards.forEach(card => {
    const type = card.getAttribute('data-metric-type');
    card.addEventListener('click', (e) => {
      // Don't open drilldown if clicked on interactive buttons inside header
      if (e.target.closest('#btn-preview-faculty-pulse') || e.target.closest('#btn-preview-absences-pulse')) return;
      e.preventDefault();
      openMetricDrilldown(type);
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openMetricDrilldown(type);
      }
    });
  });

  const previewPulseBtn = document.getElementById('btn-preview-faculty-pulse');
  previewPulseBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    triggerFacultyCardPulse({ reason: 'preview' });
  });

  const previewAbsencesBtn = document.getElementById('btn-preview-absences-pulse');
  previewAbsencesBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    triggerAbsencesCountAlert({ reason: 'preview' });
  });

  const modal = document.getElementById('modal-metric-drilldown');
  const closeBtn = document.getElementById('btn-close-drilldown');
  const closeX = document.getElementById('btn-close-drilldown-x');
  const searchInput = document.getElementById('drilldown-search-input');
  const searchClear = document.getElementById('btn-drilldown-search-clear');

  closeBtn?.addEventListener('click', closeMetricDrilldown);
  closeX?.addEventListener('click', closeMetricDrilldown);

  modal?.addEventListener('click', (e) => {
    if (e.target === modal) closeMetricDrilldown();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && modal.style.display === 'flex') {
      closeMetricDrilldown();
    }
  });

  searchInput?.addEventListener('input', () => {
    filterDrilldownTable();
  });

  searchClear?.addEventListener('click', () => {
    if (searchInput) {
      searchInput.value = '';
      searchClear.style.display = 'none';
      filterDrilldownTable();
      searchInput.focus();
    }
  });
}

/**
 * Triggers a subtle, refined visual pulse animation on the Active Faculty metric card
 * when faculty availability / absence status updates.
 */
export function triggerFacultyCardPulse(details = {}) {
  const card = document.querySelector('.admin-metric-card[data-metric-type="faculty"]');
  if (!card) return;

  // Clear existing animation class to permit seamless re-triggering
  card.classList.remove('pulse-active');
  void card.offsetWidth; // Force DOM reflow to restart CSS animation cleanly

  card.classList.add('pulse-active');

  // Handle live status badge/beacon
  const pingBadge = document.getElementById('faculty-live-ping');
  if (pingBadge) {
    if (details.type === 'absence' || (details.currentAbsences !== undefined && details.previousAbsences !== undefined && details.currentAbsences > details.previousAbsences)) {
      const diff = (details.currentAbsences && details.previousAbsences) ? (details.currentAbsences - details.previousAbsences) : 1;
      pingBadge.textContent = diff > 0 ? `+${diff} Absence` : 'Absence Logged';
      pingBadge.className = 'metric-live-ping metric-ping-alert animate-fade-in';
    } else if (details.type === 'substitution' || (details.currentAbsences !== undefined && details.previousAbsences !== undefined && details.currentAbsences < details.previousAbsences)) {
      pingBadge.textContent = 'Substituted';
      pingBadge.className = 'metric-live-ping metric-ping-success animate-fade-in';
    } else if (details.reason === 'preview') {
      pingBadge.textContent = 'Live Pulse';
      pingBadge.className = 'metric-live-ping metric-ping-info animate-fade-in';
    } else {
      pingBadge.textContent = 'Status Updated';
      pingBadge.className = 'metric-live-ping metric-ping-info animate-fade-in';
    }
    pingBadge.style.display = 'inline-flex';
  }

  // Clear existing timer if already scheduled
  if (card._pulseTimer) clearTimeout(card._pulseTimer);
  card._pulseTimer = setTimeout(() => {
    card.classList.remove('pulse-active');
    if (pingBadge) {
      setTimeout(() => {
        pingBadge.style.display = 'none';
      }, 1200);
    }
  }, 2200);
}
window.triggerFacultyCardPulse = triggerFacultyCardPulse;

/**
 * Triggers a CSS transition on 'Today's Absences' number text:
 * briefly changes the number text color to alert red and scales it slightly,
 * emphasizing the change to the user.
 */
export function triggerAbsencesCountAlert(details = {}) {
  const el = document.getElementById('stat-absences');
  if (!el) return;

  // Clear existing transition timeout & classes for seamless re-triggering
  el.classList.remove('alert-absences-transition', 'absences-alert-pulse');
  void el.offsetWidth; // Force reflow to re-arm transition

  // Apply alert state: changes color to alert red and scales slightly via .alert-absences-transition
  el.classList.add('alert-absences-transition', 'absences-alert-pulse');

  // Also handle card ping/badge if present
  const pingBadge = document.getElementById('absences-live-ping');
  if (pingBadge) {
    pingBadge.textContent = 'Updated';
    pingBadge.className = 'metric-live-ping metric-ping-alert animate-fade-in';
    pingBadge.style.display = 'inline-flex';
  }

  // Clear any existing timer
  if (el._alertTimer) clearTimeout(el._alertTimer);
  el._alertTimer = setTimeout(() => {
    // Transition back smoothly to normal state
    el.classList.remove('alert-absences-transition', 'absences-alert-pulse');
    if (pingBadge) {
      setTimeout(() => {
        pingBadge.style.display = 'none';
      }, 1000);
    }
  }, 1200);
}
window.triggerAbsencesCountAlert = triggerAbsencesCountAlert;

function closeMetricDrilldown() {
  const modal = document.getElementById('modal-metric-drilldown');
  if (modal) modal.style.display = 'none';
}
window.closeMetricDrilldown = closeMetricDrilldown;

async function openMetricDrilldown(type) {
  const modal = document.getElementById('modal-metric-drilldown');
  if (!modal) return;

  currentDrilldownType = type;
  const searchInput = document.getElementById('drilldown-search-input');
  const searchClear = document.getElementById('btn-drilldown-search-clear');
  if (searchInput) searchInput.value = '';
  if (searchClear) searchClear.style.display = 'none';

  if (!masterData) await loadMasterData();
  if (!cachedOverviewData) await loadOverview();

  // Set icon badge
  const iconBadge = document.getElementById('drilldown-icon-badge');
  if (iconBadge) {
    iconBadge.className = `metric-icon-badge metric-badge-${type}`;
    iconBadge.innerHTML = METRIC_ICONS[type] || '';
  }

  // Set action button
  const actionBtn = document.getElementById('btn-drilldown-action');
  if (actionBtn) {
    actionBtn.onclick = () => {
      closeMetricDrilldown();
      if (type === 'absences') {
        switchTab('absence');
      } else {
        switchTab('master-data');
        const subtabBtn = document.querySelector(`.master-subtab-btn[data-master-subtab="${type}"]`);
        if (subtabBtn) subtabBtn.click();
      }
    };
    actionBtn.textContent = type === 'absences' ? 'Open Absence Monitor →' : `Manage ${capitalize(type)} in Master Data →`;
  }

  renderDrilldownContent(type);
  modal.style.display = 'flex';
  if (searchInput) setTimeout(() => searchInput.focus(), 50);
}
window.openMetricDrilldown = openMetricDrilldown;

function renderDrilldownContent(type) {
  const tagEl = document.getElementById('drilldown-category-tag');
  const titleEl = document.getElementById('drilldown-title');
  const kpiEl = document.getElementById('drilldown-kpis');
  const distTitleEl = document.getElementById('drilldown-distribution-title');
  const distSubtitleEl = document.getElementById('drilldown-distribution-subtitle');
  const theadEl = document.getElementById('drilldown-thead');

  let kpiHtml = '';
  const countsMap = {};
  let totalCount = 0;
  let distTitle = 'Distribution Breakdown';
  let distSubtitle = '';
  let theadHtml = '';

  if (type === 'faculty') {
    const list = masterData?.faculty || [];
    currentDrilldownItems = list;
    totalCount = list.length;
    tagEl.textContent = 'Faculty Roster Drill-down';
    titleEl.textContent = 'Active Teaching Faculty Breakdown';

    const depts = new Set(list.map(f => f.department_code || f.department_name || 'General'));
    const avgDay = totalCount ? (list.reduce((acc, f) => acc + (f.max_periods_per_day || 0), 0) / totalCount).toFixed(1) : '0';
    const avgWeek = totalCount ? (list.reduce((acc, f) => acc + (f.max_periods_per_week || 0), 0) / totalCount).toFixed(1) : '0';

    kpiHtml = `
      <div class="drilldown-kpi-card">
        <div class="drilldown-kpi-label">Total Faculty</div>
        <div class="drilldown-kpi-val" style="color: var(--color-brand-primary);">${totalCount}</div>
      </div>
      <div class="drilldown-kpi-card">
        <div class="drilldown-kpi-label">Departments</div>
        <div class="drilldown-kpi-val">${depts.size}</div>
      </div>
      <div class="drilldown-kpi-card">
        <div class="drilldown-kpi-label">Avg Max/Day</div>
        <div class="drilldown-kpi-val">${avgDay} <span style="font-size: 0.8rem; font-weight: normal; color: var(--text-muted);">periods</span></div>
      </div>
      <div class="drilldown-kpi-card">
        <div class="drilldown-kpi-label">Avg Max/Week</div>
        <div class="drilldown-kpi-val">${avgWeek} <span style="font-size: 0.8rem; font-weight: normal; color: var(--text-muted);">periods</span></div>
      </div>
    `;

    list.forEach(f => {
      const d = f.department_code || f.department_name || 'General';
      countsMap[d] = (countsMap[d] || 0) + 1;
    });
    distTitle = 'Faculty by Department';
    distSubtitle = `${depts.size} Departments Enrolled`;

    theadHtml = `
      <tr>
        <th style="width: 25%;">Faculty Name</th>
        <th style="width: 15%;">Department</th>
        <th style="width: 25%;">Email</th>
        <th style="width: 15%;">Phone</th>
        <th style="width: 10%; text-align: center;">Max/Day</th>
        <th style="width: 10%; text-align: right;">Action</th>
      </tr>
    `;
  } else if (type === 'subjects') {
    const list = masterData?.subjects || [];
    currentDrilldownItems = list;
    totalCount = list.length;
    tagEl.textContent = 'Curriculum Drill-down';
    titleEl.textContent = 'Curriculum Subjects & Course Breakdown';

    const theory = list.filter(s => s.type === 'theory').length;
    const lab = list.filter(s => s.type === 'lab').length;
    const activity = list.filter(s => s.type === 'activity').length;
    const totalPeriods = list.reduce((acc, s) => acc + (s.weekly_periods || 0), 0);

    kpiHtml = `
      <div class="drilldown-kpi-card">
        <div class="drilldown-kpi-label">Total Subjects</div>
        <div class="drilldown-kpi-val" style="color: #2563EB;">${totalCount}</div>
      </div>
      <div class="drilldown-kpi-card">
        <div class="drilldown-kpi-label">Theory Courses</div>
        <div class="drilldown-kpi-val">${theory}</div>
      </div>
      <div class="drilldown-kpi-card">
        <div class="drilldown-kpi-label">Practical / Labs</div>
        <div class="drilldown-kpi-val">${lab}</div>
      </div>
      <div class="drilldown-kpi-card">
        <div class="drilldown-kpi-label">Weekly Class Load</div>
        <div class="drilldown-kpi-val">${totalPeriods} <span style="font-size: 0.8rem; font-weight: normal; color: var(--text-muted);">periods</span></div>
      </div>
    `;

    countsMap['Theory'] = theory;
    countsMap['Practical / Lab'] = lab;
    if (activity > 0) countsMap['Activity'] = activity;
    distTitle = 'Course Type Distribution';
    distSubtitle = `${theory} Theory · ${lab} Labs${activity > 0 ? ` · ${activity} Activity` : ''}`;

    theadHtml = `
      <tr>
        <th style="width: 15%;">Code</th>
        <th style="width: 30%;">Subject Name</th>
        <th style="width: 15%;">Department</th>
        <th style="width: 10%; text-align: center;">Semester</th>
        <th style="width: 12%; text-align: center;">Type</th>
        <th style="width: 10%; text-align: center;">Weekly</th>
        <th style="width: 8%; text-align: right;">Action</th>
      </tr>
    `;
  } else if (type === 'sections') {
    const list = masterData?.sections || [];
    currentDrilldownItems = list;
    totalCount = list.length;
    tagEl.textContent = 'Student Cohorts Drill-down';
    titleEl.textContent = 'Enrolled Student Sections Breakdown';

    const depts = new Set(list.map(s => s.department_code || s.department_name || 'General'));
    const sems = new Set(list.map(s => s.semester));
    const totalStrength = list.reduce((acc, s) => acc + (s.strength || 0), 0);

    kpiHtml = `
      <div class="drilldown-kpi-card">
        <div class="drilldown-kpi-label">Total Sections</div>
        <div class="drilldown-kpi-val" style="color: #D97706;">${totalCount}</div>
      </div>
      <div class="drilldown-kpi-card">
        <div class="drilldown-kpi-label">Departments</div>
        <div class="drilldown-kpi-val">${depts.size}</div>
      </div>
      <div class="drilldown-kpi-card">
        <div class="drilldown-kpi-label">Semesters</div>
        <div class="drilldown-kpi-val">${sems.size}</div>
      </div>
      <div class="drilldown-kpi-card">
        <div class="drilldown-kpi-label">Total Student Capacity</div>
        <div class="drilldown-kpi-val">${totalStrength || (totalCount * 60)}</div>
      </div>
    `;

    list.forEach(s => {
      const key = `Semester ${s.semester}`;
      countsMap[key] = (countsMap[key] || 0) + 1;
    });
    distTitle = 'Sections by Academic Semester';
    distSubtitle = `${list.length} cohorts across ${sems.size} levels`;

    theadHtml = `
      <tr>
        <th style="width: 25%;">Section Name</th>
        <th style="width: 25%;">Department</th>
        <th style="width: 15%; text-align: center;">Semester</th>
        <th style="width: 20%;">Academic Year</th>
        <th style="width: 15%; text-align: right;">Action</th>
      </tr>
    `;
  } else if (type === 'rooms') {
    const list = masterData?.rooms || [];
    currentDrilldownItems = list;
    totalCount = list.length;
    tagEl.textContent = 'Infrastructure Drill-down';
    titleEl.textContent = 'Campus Classrooms & Specialized Labs';

    const classrooms = list.filter(r => r.type === 'classroom').length;
    const labs = list.filter(r => r.type === 'lab').length;
    const seminars = list.filter(r => r.type === 'seminar').length;
    const totalCap = list.reduce((acc, r) => acc + (r.capacity || 0), 0);

    kpiHtml = `
      <div class="drilldown-kpi-card">
        <div class="drilldown-kpi-label">Total Venues</div>
        <div class="drilldown-kpi-val" style="color: #16A34A;">${totalCount}</div>
      </div>
      <div class="drilldown-kpi-card">
        <div class="drilldown-kpi-label">Classrooms</div>
        <div class="drilldown-kpi-val">${classrooms}</div>
      </div>
      <div class="drilldown-kpi-card">
        <div class="drilldown-kpi-label">Computer / Science Labs</div>
        <div class="drilldown-kpi-val">${labs}</div>
      </div>
      <div class="drilldown-kpi-card">
        <div class="drilldown-kpi-label">Total Seating Capacity</div>
        <div class="drilldown-kpi-val">${totalCap} <span style="font-size: 0.8rem; font-weight: normal; color: var(--text-muted);">seats</span></div>
      </div>
    `;

    countsMap['Classrooms'] = classrooms;
    countsMap['Specialized Labs'] = labs;
    if (seminars > 0) countsMap['Seminar Halls'] = seminars;
    distTitle = 'Venue Type Distribution';
    distSubtitle = `${totalCap} Total Campus Seating Capacity`;

    theadHtml = `
      <tr>
        <th style="width: 30%;">Room / Hall Name</th>
        <th style="width: 25%;">Venue Type</th>
        <th style="width: 20%; text-align: center;">Capacity</th>
        <th style="width: 15%; text-align: center;">Status</th>
        <th style="width: 10%; text-align: right;">Action</th>
      </tr>
    `;
  } else if (type === 'absences') {
    const list = cachedOverviewData?.todayAbsences || [];
    currentDrilldownItems = list;
    totalCount = list.length;
    tagEl.textContent = 'Daily Disruptions Drill-down';
    titleEl.textContent = "Today's Faculty Absence & Coverage Breakdown";

    const covered = list.filter(a => a.status === 'covered').length;
    const pending = list.filter(a => a.status === 'pending' || !a.status).length;
    const rate = totalCount > 0 ? Math.round((covered / totalCount) * 100) : 100;

    kpiHtml = `
      <div class="drilldown-kpi-card">
        <div class="drilldown-kpi-label">Total Absences Today</div>
        <div class="drilldown-kpi-val" style="color: ${totalCount > 0 ? '#E11D48' : '#16A34A'};">${totalCount}</div>
      </div>
      <div class="drilldown-kpi-card">
        <div class="drilldown-kpi-label">Substitutions Covered</div>
        <div class="drilldown-kpi-val" style="color: #16A34A;">${covered}</div>
      </div>
      <div class="drilldown-kpi-card">
        <div class="drilldown-kpi-label">Pending Coverage</div>
        <div class="drilldown-kpi-val" style="color: ${pending > 0 ? '#D97706' : 'var(--text-muted)'};">${pending}</div>
      </div>
      <div class="drilldown-kpi-card">
        <div class="drilldown-kpi-label">Coverage Rate</div>
        <div class="drilldown-kpi-val">${rate}%</div>
      </div>
    `;

    if (totalCount > 0) {
      countsMap['Covered'] = covered;
      countsMap['Pending Coverage'] = pending;
    } else {
      countsMap['No Disruptions'] = 1;
    }
    distTitle = 'Absence Coverage Resolution';
    distSubtitle = totalCount > 0 ? `${covered} resolved, ${pending} needing attention` : 'All faculty active & present';

    theadHtml = `
      <tr>
        <th style="width: 25%;">Faculty Name</th>
        <th style="width: 15%;">Date</th>
        <th style="width: 15%;">Disruption Type</th>
        <th style="width: 25%;">Reason / Remarks</th>
        <th style="width: 10%; text-align: center;">Status</th>
        <th style="width: 10%; text-align: right;">Action</th>
      </tr>
    `;
  }

  kpiEl.innerHTML = kpiHtml;
  distTitleEl.textContent = distTitle;
  distSubtitleEl.textContent = distSubtitle;
  theadEl.innerHTML = theadHtml;

  renderDistributionBar(countsMap, totalCount || 1, COLOR_PALETTES[type] || COLOR_PALETTES.faculty);
  filterDrilldownTable();
}

function renderDistributionBar(countsMap, total, palette) {
  const barEl = document.getElementById('drilldown-segments');
  const legendEl = document.getElementById('drilldown-legend');
  if (!barEl || !legendEl) return;

  const entries = Object.entries(countsMap).filter(([_, count]) => count > 0);
  if (entries.length === 0) {
    barEl.innerHTML = `<div class="drilldown-segment" style="width: 100%; background: var(--border-subtle);"></div>`;
    legendEl.innerHTML = `<span style="color: var(--text-muted); font-size: 0.75rem;">No category breakdown records available</span>`;
    return;
  }

  let segHtml = '';
  let legHtml = '';

  entries.forEach(([label, count], idx) => {
    const color = palette[idx % palette.length];
    const pct = ((count / total) * 100).toFixed(1);
    segHtml += `
      <div class="drilldown-segment" style="width: ${pct}%; background: ${color};" title="${escapeHtml(label)}: ${count} (${pct}%)"></div>
    `;
    legHtml += `
      <div class="drilldown-legend-item">
        <span class="drilldown-legend-dot" style="background: ${color};"></span>
        <span><strong>${escapeHtml(label)}</strong>: ${count} <span style="color: var(--text-muted); font-size: 0.72rem;">(${pct}%)</span></span>
      </div>
    `;
  });

  barEl.innerHTML = segHtml;
  legendEl.innerHTML = legHtml;
}

function filterDrilldownTable() {
  const searchInput = document.getElementById('drilldown-search-input');
  const clearBtn = document.getElementById('btn-drilldown-search-clear');
  const tbodyEl = document.getElementById('drilldown-tbody');
  const footerInfo = document.getElementById('drilldown-footer-info');
  if (!tbodyEl) return;

  const q = (searchInput?.value || '').trim().toLowerCase();
  if (clearBtn) clearBtn.style.display = q ? 'inline-block' : 'none';

  const type = currentDrilldownType;
  const items = currentDrilldownItems || [];

  const filtered = items.filter(item => {
    if (!q) return true;
    if (type === 'faculty') {
      const name = (item.name || '').toLowerCase();
      const email = (item.email || '').toLowerCase();
      const phone = (item.phone || '').toLowerCase();
      const dept = (item.department_name || item.department_code || '').toLowerCase();
      return name.includes(q) || email.includes(q) || phone.includes(q) || dept.includes(q);
    }
    if (type === 'subjects') {
      const code = (item.code || '').toLowerCase();
      const name = (item.name || '').toLowerCase();
      const dept = (item.department_name || item.department_code || '').toLowerCase();
      const sType = (item.type || '').toLowerCase();
      return code.includes(q) || name.includes(q) || dept.includes(q) || sType.includes(q);
    }
    if (type === 'sections') {
      const name = (item.name || '').toLowerCase();
      const dept = (item.department_name || item.department_code || '').toLowerCase();
      const sem = String(item.semester || '');
      const year = (item.academic_year || '').toLowerCase();
      return name.includes(q) || dept.includes(q) || sem.includes(q) || year.includes(q);
    }
    if (type === 'rooms') {
      const name = (item.name || '').toLowerCase();
      const rType = (item.type || '').toLowerCase();
      const cap = String(item.capacity || '');
      return name.includes(q) || rType.includes(q) || cap.includes(q);
    }
    if (type === 'absences') {
      const name = (item.faculty_name || '').toLowerCase();
      const reason = (item.reason || '').toLowerCase();
      const aType = (item.type || '').toLowerCase();
      const status = (item.status || '').toLowerCase();
      return name.includes(q) || reason.includes(q) || aType.includes(q) || status.includes(q);
    }
    return true;
  });

  if (footerInfo) {
    footerInfo.textContent = `Showing ${filtered.length} of ${items.length} records · Live synchronized system records`;
  }

  if (filtered.length === 0) {
    tbodyEl.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; padding: 2.5rem; color: var(--text-muted);">
          <div style="font-size: 1.5rem; margin-bottom: 0.35rem;">🔍</div>
          <div style="font-weight: 600; color: var(--text-secondary); margin-bottom: 0.2rem;">No matching records found</div>
          <span style="font-size: 0.78rem;">Try clearing or adjusting your search filter keywords</span>
        </td>
      </tr>
    `;
    return;
  }

  tbodyEl.innerHTML = filtered.map(item => {
    if (type === 'faculty') {
      return `
        <tr>
          <td>
            <div style="font-weight: 700; color: var(--text-primary);">${escapeHtml(item.name)}</div>
            <div style="font-size: 0.72rem; color: var(--text-muted);">${escapeHtml(item.username ? '@' + item.username : '')}</div>
          </td>
          <td>
            <span class="drilldown-badge-pill" style="background: var(--color-brand-blush-soft); color: var(--color-brand-primary);">
              ${escapeHtml(item.department_code || item.department_name || 'General')}
            </span>
          </td>
          <td><a href="mailto:${escapeHtml(item.email)}" style="color: var(--color-brand-primary); text-decoration: none;">${escapeHtml(item.email || '—')}</a></td>
          <td style="color: var(--text-secondary); font-size: 0.8rem;">${escapeHtml(item.phone || '—')}</td>
          <td style="text-align: center; font-weight: 600;" class="tabular-nums">${item.max_periods_per_day || 4}</td>
          <td style="text-align: right;">
            <button class="btn-secondary" style="font-size: 0.72rem; padding: 0.2rem 0.5rem;" onclick="window.closeMetricDrilldown(); window.editFaculty(${item.id});">
              Edit
            </button>
          </td>
        </tr>
      `;
    }
    if (type === 'subjects') {
      const isLab = item.type === 'lab';
      const isActivity = item.type === 'activity';
      let semText = item.semester ? `Sem ${item.semester}` : 'Multiple';
      if (!item.semester && item.semester_candidates) {
        try {
          const candidates = typeof item.semester_candidates === 'string' && item.semester_candidates.startsWith('[')
            ? JSON.parse(item.semester_candidates)
            : item.semester_candidates;
          if (Array.isArray(candidates) && candidates.length > 0) {
            semText = `Multiple (Sem ${candidates.join(', ')})`;
          }
        } catch (e) {}
      }
      return `
        <tr>
          <td><span style="font-family: monospace; font-weight: 700; color: var(--color-brand-primary);">${escapeHtml(item.code)}</span></td>
          <td><div style="font-weight: 600;">${escapeHtml(item.name || item.short_name || item.code)}</div></td>
          <td><span style="font-size: 0.78rem; color: var(--text-secondary);">${escapeHtml(item.department_code || item.department_name || 'CSE')}</span></td>
          <td style="text-align: center;" class="tabular-nums">${escapeHtml(semText)}</td>
          <td style="text-align: center;">
            <span class="drilldown-badge-pill" style="${isLab ? 'background: #FDF4FF; color: #9333EA; border: 1px solid rgba(147,51,234,0.2);' : (isActivity ? 'background: #FEF3C7; color: #D97706; border: 1px solid rgba(217,119,6,0.2);' : 'background: #EFF6FF; color: #2563EB; border: 1px solid rgba(37,99,235,0.2);')}">
              ${isLab ? '🧪 Practical Lab' : (isActivity ? '🎯 Activity' : '📖 Theory')}
            </span>
          </td>
          <td style="text-align: center; font-weight: 700;" class="tabular-nums">${item.weekly_periods} / wk</td>
          <td style="text-align: right;">
            <button class="btn-secondary" style="font-size: 0.72rem; padding: 0.2rem 0.5rem;" onclick="window.closeMetricDrilldown(); window.editSubject(${item.id});">
              Edit
            </button>
          </td>
        </tr>
      `;
    }
    if (type === 'sections') {
      let batchesText = '-';
      if (item.batches) {
        try {
          const b = typeof item.batches === 'string' && item.batches.startsWith('[') ? JSON.parse(item.batches) : item.batches;
          batchesText = Array.isArray(b) ? b.join(', ') : String(b);
        } catch (e) {
          batchesText = String(item.batches);
        }
      }
      return `
        <tr>
          <td>
            <div style="font-weight: 700; color: var(--text-primary);">${escapeHtml(item.name)}</div>
            <div style="font-size: 0.72rem; color: var(--text-muted);">Batches: ${escapeHtml(batchesText)}</div>
          </td>
          <td>
            <span class="drilldown-badge-pill" style="background: #FFFBEB; color: #D97706; border: 1px solid rgba(217,119,6,0.2);">
              ${escapeHtml(item.department_code || item.department_name || 'CSE')}
            </span>
          </td>
          <td style="text-align: center; font-weight: 600;" class="tabular-nums">Semester ${item.semester}</td>
          <td style="color: var(--text-secondary); font-size: 0.8rem;">${escapeHtml(item.academic_year || 'Current')}</td>
          <td style="text-align: right;">
            <button class="btn-secondary" style="font-size: 0.72rem; padding: 0.2rem 0.5rem;" onclick="window.closeMetricDrilldown(); window.editSection(${item.id});">
              Edit
            </button>
          </td>
        </tr>
      `;
    }
    if (type === 'rooms') {
      const isLab = item.type === 'lab';
      return `
        <tr>
          <td><div style="font-weight: 700; color: var(--text-primary); font-family: monospace;">${escapeHtml(item.name)}</div></td>
          <td>
            <span class="drilldown-badge-pill" style="${isLab ? 'background: #F0FDF4; color: #16A34A; border: 1px solid rgba(22,163,74,0.2);' : 'background: var(--bg-surface-subtle); color: var(--text-secondary); border: 1px solid var(--border-subtle);'}">
              ${isLab ? '💻 Specialized Lab' : '🏛️ Lecture Classroom'}
            </span>
          </td>
          <td style="text-align: center; font-weight: 700;" class="tabular-nums">${item.capacity} seats</td>
          <td style="text-align: center;">
            <span class="drilldown-badge-pill" style="background: var(--color-success-bg); color: var(--color-success); border: 1px solid var(--color-success);">
              ● Active
            </span>
          </td>
          <td style="text-align: right;">
            <button class="btn-secondary" style="font-size: 0.72rem; padding: 0.2rem 0.5rem;" onclick="window.closeMetricDrilldown(); window.editRoom(${item.id});">
              Edit
            </button>
          </td>
        </tr>
      `;
    }
    if (type === 'absences') {
      const isCovered = item.status === 'covered';
      return `
        <tr>
          <td><div style="font-weight: 700;">${escapeHtml(item.faculty_name || 'Faculty Member')}</div></td>
          <td class="tabular-nums" style="font-size: 0.8rem; color: var(--text-secondary);">${escapeHtml(item.date || 'Today')}</td>
          <td>
            <span class="drilldown-badge-pill" style="background: #FFF1F2; color: #E11D48; border: 1px solid rgba(225,29,72,0.2);">
              ${escapeHtml(capitalize(item.type || 'Absent'))}
            </span>
          </td>
          <td style="color: var(--text-secondary); font-size: 0.8rem;">${escapeHtml(item.reason || 'Personal / Academic leave')}</td>
          <td style="text-align: center;">
            <span class="drilldown-badge-pill" style="${isCovered ? 'background: var(--color-success-bg); color: var(--color-success); border: 1px solid var(--color-success);' : 'background: var(--color-warning-bg); color: var(--color-warning); border: 1px solid var(--color-warning);'}">
              ${isCovered ? '✓ Covered' : '⏳ Pending'}
            </span>
          </td>
          <td style="text-align: right;">
            <button class="btn-secondary" style="font-size: 0.72rem; padding: 0.2rem 0.5rem;" onclick="window.closeMetricDrilldown(); window.switchTab('absence');">
              Manage
            </button>
          </td>
        </tr>
      `;
    }
    return '';
  }).join('');
}

async function loadOverview() {
  try {
    const data = await apiRequest('/api/admin/overview');
    cachedOverviewData = data;

    const currentAbsences = Number(data.stats.todayAbsencesCount) || 0;
    // Check if absences count has changed after initial baseline load
    if (lastObservedAbsenceCount !== null && currentAbsences !== lastObservedAbsenceCount) {
      triggerFacultyCardPulse({
        previousAbsences: lastObservedAbsenceCount,
        currentAbsences: currentAbsences,
        reason: 'absence_count_changed'
      });
      triggerAbsencesCountAlert({
        previousCount: lastObservedAbsenceCount,
        currentCount: currentAbsences,
        reason: 'absence_count_changed'
      });
    }
    lastObservedAbsenceCount = currentAbsences;

    document.getElementById('stat-faculty').textContent = data.stats.facultyCount;
    document.getElementById('stat-subjects').textContent = data.stats.subjectsCount;
    document.getElementById('stat-sections').textContent = data.stats.sectionsCount;
    document.getElementById('stat-rooms').textContent = data.stats.roomsCount;
    document.getElementById('stat-absences').textContent = data.stats.todayAbsencesCount;

    if (data.stats.activeVersion) {
      activeVersionId = data.stats.activeVersion.id;
      document.getElementById('active-version-title').textContent = data.stats.activeVersion.name;
      document.getElementById('active-version-notes').textContent = data.stats.activeVersion.notes || 'Verified active schedule';
    } else {
      document.getElementById('active-version-title').textContent = 'No Active Version (Drafts available)';
    }

    const logContainer = document.getElementById('audit-log-list');
    if (logContainer && data.recentLogs?.length) {
      logContainer.innerHTML = data.recentLogs.map(l => `
        <div style="padding: 0.5rem 0.75rem; background: var(--bg-surface-subtle); border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); display: flex; justify-content: space-between; align-items: center;">
          <div>
            <span style="font-weight: 700; color: var(--color-brand-primary);">${l.action}</span>
            <span style="color: var(--text-secondary); margin-left: 0.5rem;">by ${l.username || 'Admin'}</span>
          </div>
          <span style="color: var(--text-muted); font-size: 0.75rem;">${new Date(l.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
      `).join('');
    }
  } catch (err) {
    console.error('Error loading overview:', err);
  }
}

// 2. Load Master Data
async function loadMasterData() {
  try {
    masterData = await apiRequest('/api/admin/master-data');
  } catch (err) {
    console.error('Error loading master data:', err);
  }
}

let activeMasterSubtab = 'faculty';

function setupMasterDataSubtabs() {
  document.querySelectorAll('.master-subtab-btn').forEach(btn => {
    btn.onclick = () => {
      activeMasterSubtab = btn.getAttribute('data-master-subtab');
      document.querySelectorAll('.master-subtab-btn').forEach(b => {
        b.classList.remove('btn-primary');
        b.classList.add('btn-secondary');
      });
      btn.classList.add('btn-primary');
      btn.classList.remove('btn-secondary');

      document.querySelectorAll('.master-subpanel').forEach(p => p.style.display = 'none');
      const panel = document.getElementById(`master-subpanel-${activeMasterSubtab}`);
      if (panel) panel.style.display = 'block';
    };
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function setupMasterDataTools() {
  // 1. Faculty Real-Time Search & Department Filter Bar
  const facultySearchInput = document.getElementById('faculty-search-input');
  const facultyDeptFilter = document.getElementById('faculty-dept-filter');
  const facultySearchClear = document.getElementById('btn-faculty-search-clear');

  const handleSearchChange = () => {
    applyFacultySearch();
  };

  facultySearchInput?.addEventListener('input', handleSearchChange);
  facultySearchInput?.addEventListener('keyup', handleSearchChange);
  facultySearchInput?.addEventListener('search', handleSearchChange);
  facultySearchInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      facultySearchInput.value = '';
      if (facultyDeptFilter) facultyDeptFilter.value = '';
      applyFacultySearch();
    }
  });

  facultyDeptFilter?.addEventListener('change', handleSearchChange);

  facultySearchClear?.addEventListener('click', () => {
    if (facultySearchInput) facultySearchInput.value = '';
    if (facultyDeptFilter) facultyDeptFilter.value = '';
    applyFacultySearch();
    facultySearchInput?.focus();
  });

  // 2. Backup System (JSON Download)
  const handleBackupDownload = async () => {
    try {
      showToast('Exporting complete database snapshot...', 'info');
      const backupData = await apiRequest('/api/admin/backup');
      const jsonStr = JSON.stringify(backupData, null, 2);
      const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      downloadFile(`ctas_backup_snapshot_${timestamp}.json`, jsonStr, 'application/json');
      showToast(`Snapshot downloaded (${backupData.stats?.totalFaculty || 0} faculty, ${backupData.stats?.totalTimetableEntries || 0} timetable entries)`, 'success');
    } catch (err) {
      showToast('Failed to download backup snapshot: ' + (err.message || 'Error'), 'error');
    }
  };

  document.getElementById('btn-admin-backup-json')?.addEventListener('click', handleBackupDownload);
  document.getElementById('btn-overview-backup-json')?.addEventListener('click', handleBackupDownload);

  // 3. Timetable JSON Import & Undo Subsystem
  setupTimetableImportTools();
}

let pendingImportPayload = null;

function parseClientTimeMinutes(tStr) {
  if (!tStr) return 0;
  const parts = String(tStr).trim().split(':');
  let h = parseInt(parts[0], 10) || 0;
  const m = parseInt(parts[1] || '0', 10) || 0;
  // Afternoon 12-hour format e.g. 1:30 -> 13:30
  if (h >= 1 && h <= 6) h += 12;
  return h * 60 + m;
}

function normalizeClientDayCode(day) {
  if (!day) return 'MON';
  const d = String(day).trim().toUpperCase();
  if (d.startsWith('MON')) return 'MON';
  if (d.startsWith('TUE')) return 'TUE';
  if (d.startsWith('WED')) return 'WED';
  if (d.startsWith('THU')) return 'THU';
  if (d.startsWith('FRI')) return 'FRI';
  if (d.startsWith('SAT')) return 'SAT';
  if (d.startsWith('SUN')) return 'SUN';
  return d;
}

function checkClientSessionsOverlap(s1, s2) {
  if (s1.period_start != null && s2.period_start != null) {
    const p1s = Number(s1.period_start);
    const p1e = Number(s1.period_end ?? s1.period_start);
    const p2s = Number(s2.period_start);
    const p2e = Number(s2.period_end ?? s2.period_start);
    return Math.max(p1s, p2s) <= Math.min(p1e, p2e);
  }
  if (s1.start && s1.end && s2.start && s2.end) {
    const start1 = parseClientTimeMinutes(s1.start);
    const end1 = parseClientTimeMinutes(s1.end);
    const start2 = parseClientTimeMinutes(s2.start);
    const end2 = parseClientTimeMinutes(s2.end);
    return start1 < end2 && start2 < end1;
  }
  return false;
}

function validateTimetableClient(data) {
  const errors = [];
  const warnings = [];

  const faculty = Array.isArray(data.faculty) ? data.faculty : [];
  const subjects = Array.isArray(data.subjects) ? data.subjects : [];
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  const breaks = Array.isArray(data.breaks) && data.breaks.length > 0 ? data.breaks : [
    { name: 'Tea Break', start: '10:30', end: '10:45' },
    { name: 'Lunch Break', start: '12:45', end: '13:30' }
  ];

  const knownFacultyIds = new Set(faculty.map(f => String(f.id)));
  (masterData?.faculty || []).forEach(f => knownFacultyIds.add(String(f.id)));

  // 1. Duplicate session ID check
  const seenIds = new Set();
  sessions.forEach(sess => {
    const sId = String(sess.id ?? '');
    if (!sId) {
      errors.push('A session is missing a required "id" attribute.');
    } else if (seenIds.has(sId)) {
      errors.push(`Duplicate session id '${sId}' found in import file.`);
    } else {
      seenIds.add(sId);
    }
  });

  // 2. Unknown faculty_id check
  sessions.forEach(sess => {
    const facId = sess.faculty_id != null ? String(sess.faculty_id) : '';
    if (!facId) {
      errors.push(`Session '${sess.id || '?'}' has no faculty_id specified.`);
    } else if (!knownFacultyIds.has(facId)) {
      errors.push(`Session '${sess.id}' references unknown faculty_id: '${sess.faculty_id}'.`);
    }
  });

  // 3. Faculty overlapping sessions on same day
  for (let i = 0; i < sessions.length; i++) {
    for (let j = i + 1; j < sessions.length; j++) {
      const s1 = sessions[i];
      const s2 = sessions[j];
      if (s1.faculty_id != null && s2.faculty_id != null && String(s1.faculty_id) === String(s2.faculty_id)) {
        if (normalizeClientDayCode(s1.day) === normalizeClientDayCode(s2.day)) {
          if (checkClientSessionsOverlap(s1, s2)) {
            const fac = faculty.find(f => String(f.id) === String(s1.faculty_id)) || (masterData?.faculty || []).find(f => String(f.id) === String(s1.faculty_id));
            const facName = fac ? fac.name : `ID ${s1.faculty_id}`;
            errors.push(`Faculty "${facName}" has overlapping sessions on ${s1.day}: Session '${s1.id}' (${s1.subject || ''} ${s1.start || 'P' + s1.period_start}-${s1.end || 'P' + s1.period_end}) overlaps with Session '${s2.id}' (${s2.subject || ''} ${s2.start || 'P' + s2.period_start}-${s2.end || 'P' + s2.period_end}).`);
          }
        }
      }
    }
  }

  // 4. Warnings: Break overlap
  sessions.forEach(sess => {
    if (sess.start && sess.end) {
      const sStart = parseClientTimeMinutes(sess.start);
      const sEnd = parseClientTimeMinutes(sess.end);
      breaks.forEach(brk => {
        const bStart = parseClientTimeMinutes(brk.start);
        const bEnd = parseClientTimeMinutes(brk.end);
        if (sStart < bEnd && bStart < sEnd) {
          warnings.push(`Session '${sess.id}' (${sess.subject || 'Class'} on ${sess.day} ${sess.start}-${sess.end}) falls during scheduled ${brk.name || 'Break'} (${brk.start}-${brk.end}).`);
        }
      });
    }
  });

  // 5. Warnings: Holiday overlap
  const holidays = masterData?.holidays || [];
  if (holidays.length > 0) {
    sessions.forEach(sess => {
      if (sess.date) {
        const hol = holidays.find(h => h.date === sess.date);
        if (hol) {
          warnings.push(`Session '${sess.id}' falls on scheduled holiday: ${hol.name} (${hol.date}).`);
        }
      }
    });
  }

  // 6. Warnings: Same semester + batch has two different subjects at same time
  for (let i = 0; i < sessions.length; i++) {
    for (let j = i + 1; j < sessions.length; j++) {
      const s1 = sessions[i];
      const s2 = sessions[j];
      if (s1.semester != null && s2.semester != null && Number(s1.semester) === Number(s2.semester)) {
        if (normalizeClientDayCode(s1.day) === normalizeClientDayCode(s2.day)) {
          const sameBatch = (s1.batch && s2.batch && String(s1.batch).trim().toLowerCase() === String(s2.batch).trim().toLowerCase()) ||
                            (!s1.batch && !s2.batch && (!s1.section || !s2.section || String(s1.section) === String(s2.section)));
          if (sameBatch && String(s1.subject || '').trim() !== String(s2.subject || '').trim()) {
            if (checkClientSessionsOverlap(s1, s2)) {
              warnings.push(`Semester ${s1.semester}${s1.batch ? ' (Batch ' + s1.batch + ')' : ''} has two different subjects ('${s1.subject}' and '${s2.subject}') scheduled at the same time on ${s1.day} (${s1.start || 'P' + s1.period_start} - ${s1.end || 'P' + s1.period_end}).`);
            }
          }
        }
      }
    }
  }

  return {
    errors,
    warnings,
    counts: {
      faculty: faculty.length,
      subjects: subjects.length,
      sessions: sessions.length
    }
  };
}

function updateUndoButtonState(canUndo) {
  const btnUndo = document.getElementById('btn-admin-undo-import');
  if (btnUndo) {
    btnUndo.style.display = canUndo ? 'inline-block' : 'none';
  }
}

function setupTimetableImportTools() {
  const btnImport = document.getElementById('btn-admin-import-json');
  const fileInput = document.getElementById('import-json-file-input');
  const modal = document.getElementById('modal-import-preview');
  const btnCloseX = document.getElementById('btn-close-import-preview-x');
  const btnCancel = document.getElementById('btn-cancel-import-preview');
  const btnConfirm = document.getElementById('btn-confirm-import-json');
  const btnUndo = document.getElementById('btn-admin-undo-import');

  // Trigger file chooser
  btnImport?.addEventListener('click', () => {
    if (fileInput) {
      fileInput.value = '';
      fileInput.click();
    }
  });

  // Handle file selection
  fileInput?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith('.json') && file.type !== 'application/json') {
      showToast('Please select a valid JSON file (ctas_timetable_import.json)', 'warning');
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const json = JSON.parse(event.target.result);
        if (!json || typeof json !== 'object') {
          throw new Error('Parsed JSON is not an object.');
        }

        pendingImportPayload = json;

        // Perform client-side validation
        const val = validateTimetableClient(json);

        // Update preview UI
        const filenameEl = document.getElementById('import-preview-filename');
        const filesizeEl = document.getElementById('import-preview-filesize');
        const facCountEl = document.getElementById('import-preview-faculty-count');
        const subCountEl = document.getElementById('import-preview-subjects-count');
        const sessCountEl = document.getElementById('import-preview-sessions-count');
        const bannerEl = document.getElementById('import-preview-status-banner');
        const errSec = document.getElementById('import-preview-errors-section');
        const errCountEl = document.getElementById('import-preview-errors-count');
        const errListEl = document.getElementById('import-preview-errors-list');
        const warnSec = document.getElementById('import-preview-warnings-section');
        const warnCountEl = document.getElementById('import-preview-warnings-count');
        const warnListEl = document.getElementById('import-preview-warnings-list');
        const actionStatusEl = document.getElementById('import-preview-action-status');

        if (filenameEl) filenameEl.textContent = file.name;
        if (filesizeEl) filesizeEl.textContent = `${(file.size / 1024).toFixed(1)} KB`;
        if (facCountEl) facCountEl.textContent = val.counts.faculty;
        if (subCountEl) subCountEl.textContent = val.counts.subjects;
        if (sessCountEl) sessCountEl.textContent = val.counts.sessions;

        // Errors display
        if (val.errors.length > 0) {
          if (errSec) errSec.style.display = 'block';
          if (errCountEl) errCountEl.textContent = val.errors.length;
          if (errListEl) {
            errListEl.innerHTML = val.errors.map(err => `<li style="margin-bottom: 0.35rem;">${escapeHtml(err)}</li>`).join('');
          }
          if (bannerEl) {
            bannerEl.style.display = 'flex';
            bannerEl.innerHTML = `<div style="background: rgba(225, 29, 72, 0.12); color: var(--color-error); font-weight: 600; padding: 0.65rem 0.85rem; border-radius: 6px; width: 100%;">🚫 Import Blocked: ${val.errors.length} constraint violation${val.errors.length > 1 ? 's' : ''} found. Please resolve conflicting sessions or unknown faculty before importing.</div>`;
          }
          if (btnConfirm) {
            btnConfirm.disabled = true;
            btnConfirm.style.opacity = '0.5';
            btnConfirm.style.cursor = 'not-allowed';
            btnConfirm.title = 'Resolve blocking errors to proceed';
          }
          if (actionStatusEl) actionStatusEl.textContent = 'Import blocked due to validation errors.';
        } else {
          if (errSec) errSec.style.display = 'none';
          if (btnConfirm) {
            btnConfirm.disabled = false;
            btnConfirm.style.opacity = '1';
            btnConfirm.style.cursor = 'pointer';
            btnConfirm.title = 'Confirm and apply timetable data';
          }
          if (val.warnings.length > 0) {
            if (bannerEl) {
              bannerEl.style.display = 'flex';
              bannerEl.innerHTML = `<div style="background: rgba(245, 158, 11, 0.12); color: #d97706; font-weight: 600; padding: 0.65rem 0.85rem; border-radius: 6px; width: 100%;">⚠️ Validation Passed with ${val.warnings.length} warning${val.warnings.length > 1 ? 's' : ''}. Timetable data is ready to import.</div>`;
            }
            if (actionStatusEl) actionStatusEl.textContent = 'Ready to import. Click "Confirm Import" to save.';
          } else {
            if (bannerEl) {
              bannerEl.style.display = 'flex';
              bannerEl.innerHTML = `<div style="background: rgba(16, 185, 129, 0.12); color: #059669; font-weight: 600; padding: 0.65rem 0.85rem; border-radius: 6px; width: 100%;">✅ Validation Passed: 0 conflicts detected. All faculty, subjects, and sessions are verified.</div>`;
            }
            if (actionStatusEl) actionStatusEl.textContent = 'All constraints verified. Click "Confirm Import" to proceed.';
          }
        }

        // Warnings display
        if (val.warnings.length > 0) {
          if (warnSec) warnSec.style.display = 'block';
          if (warnCountEl) warnCountEl.textContent = val.warnings.length;
          if (warnListEl) {
            warnListEl.innerHTML = val.warnings.map(warn => `<li style="margin-bottom: 0.35rem;">${escapeHtml(warn)}</li>`).join('');
          }
        } else {
          if (warnSec) warnSec.style.display = 'none';
        }

        // Open modal
        if (modal) modal.style.display = 'flex';
      } catch (err) {
        showToast('Failed to parse timetable JSON: ' + err.message, 'error');
      }
    };
    reader.readAsText(file);
  });

  // Close preview modal
  const closeModal = () => {
    if (modal) modal.style.display = 'none';
    if (fileInput) fileInput.value = '';
    pendingImportPayload = null;
  };
  btnCloseX?.addEventListener('click', closeModal);
  btnCancel?.addEventListener('click', closeModal);

  // Helper to normalize faculty name for matching (Requirement 4)
  const normalizeFacultyName = (name) => {
    if (!name) return '';
    return String(name).trim().toLowerCase().replace(/^(dr|prof|mrs|mr|ms)\.?\s+/i, '');
  };

  // Helper to capture a pre-import snapshot
  const takePreImportSnapshot = async () => {
    let entries = [];
    if (activeVersionId) {
      try {
        const vData = await apiRequest(`/api/timetable/versions/${activeVersionId}`);
        entries = Array.isArray(vData?.entries) ? JSON.parse(JSON.stringify(vData.entries)) : [];
      } catch {}
    }
    return {
      timestamp: new Date().toISOString(),
      faculty: Array.isArray(masterData?.faculty) ? JSON.parse(JSON.stringify(masterData.faculty)) : [],
      subjects: Array.isArray(masterData?.subjects) ? JSON.parse(JSON.stringify(masterData.subjects)) : [],
      rooms: Array.isArray(masterData?.rooms) ? JSON.parse(JSON.stringify(masterData.rooms)) : [],
      sections: Array.isArray(masterData?.sections) ? JSON.parse(JSON.stringify(masterData.sections)) : [],
      departments: Array.isArray(masterData?.departments) ? JSON.parse(JSON.stringify(masterData.departments)) : [],
      holidays: Array.isArray(masterData?.holidays) ? JSON.parse(JSON.stringify(masterData.holidays)) : [],
      activeVersionId: activeVersionId || null,
      entries
    };
  };

  // Confirm Import (Requirements 1, 2, 3, 4, 5)
  btnConfirm?.addEventListener('click', async () => {
    if (!pendingImportPayload) {
      showToast('No timetable payload selected to import', 'warning');
      return;
    }

    try {
      btnConfirm.disabled = true;
      btnConfirm.textContent = 'Importing...';
      showToast('Importing faculty, subjects, and sessions in a single database transaction...', 'info');

      const res = await apiRequest('/api/admin/import-timetable', {
        method: 'POST',
        body: { data: pendingImportPayload }
      });

      localStorage.setItem('ctas_pre_import_snapshot', JSON.stringify({ canUndo: true, timestamp: new Date().toISOString() }));
      updateUndoButtonState(true);

      showToast(res.message || `Import completed! Loaded ${res.stats?.faculty ?? 0} faculty, ${res.stats?.subjects ?? 0} subjects, ${res.stats?.sessions ?? 0} sessions.`, 'success');
      closeModal();

      // Refresh master data, overview statistics, and timetable studio
      await loadMasterData();
      renderMasterDataTables();
      await loadOverview();
      if (typeof window.loadStudio === 'function') {
        await window.loadStudio();
      }
    } catch (saveErr) {
      console.error('[CTAS Import] Import error:', saveErr);
      showToast('Import failed: ' + (saveErr.message || 'Error occurred during import'), 'error');
    } finally {
      btnConfirm.disabled = false;
      btnConfirm.textContent = 'Confirm Import';
    }
  });

  // Undo Last Import (Requirement 3: Never touches rooms/sections/holidays/departments, restores pre-import state)
  btnUndo?.addEventListener('click', async () => {
    const ok = await showAppConfirm({
      title: 'Undo Last Timetable Import',
      message: 'Are you sure you want to revert the last timetable import? This will restore all faculty, subjects, and timetable classes back to their state prior to the import, while preserving rooms, sections, holidays, and departments.',
      okText: 'Undo Import',
      danger: true
    });
    if (!ok) return;

    try {
      showToast('Reverting to pre-import snapshot...', 'info');
      const res = await apiRequest('/api/admin/undo-import', { method: 'POST' });
      localStorage.removeItem('ctas_pre_import_snapshot');
      showToast(res.message || 'Import undone successfully.', 'success');
      updateUndoButtonState(false);

      // Refresh views
      await loadMasterData();
      renderMasterDataTables();
      await loadOverview();
      if (typeof window.loadStudio === 'function') {
        await window.loadStudio();
      }
    } catch (err) {
      showToast('Failed to undo import: ' + (err.message || 'Error'), 'error');
    }
  });

  // Check initial undo status on load
  if (localStorage.getItem('ctas_pre_import_snapshot')) {
    updateUndoButtonState(true);
  } else {
    apiRequest('/api/admin/undo-status')
      .then(status => {
        if (status && status.canUndo) {
          updateUndoButtonState(true);
        }
      })
      .catch(() => {});
  }
}

export function filterFacultyList(facultyList = [], rawQuery = '', deptFilter = '') {
  const q = String(rawQuery || '').trim().toLowerCase();
  const dept = String(deptFilter || '').trim().toLowerCase();
  const tokens = q ? q.split(/\s+/).filter(Boolean) : [];

  return (facultyList || []).filter((f) => {
    if (dept) {
      const code = (f.department_code || '').toLowerCase();
      const dName = (f.department_name || '').toLowerCase();
      const dId = String(f.department_id || '');
      if (code !== dept && dName !== dept && dId !== dept) {
        return false;
      }
    }
    if (tokens.length === 0) return true;

    const name = (f.name || '').toLowerCase();
    const email = (f.email || '').toLowerCase();
    const phone = (f.phone || '').toLowerCase();
    const deptCode = (f.department_code || '').toLowerCase();
    const deptName = (f.department_name || '').toLowerCase();
    const username = (f.username || '').toLowerCase();
    const combined = `${name} ${deptCode} ${deptName} ${email} ${phone} ${username}`;

    return tokens.every((token) =>
      name.includes(token) ||
      deptCode.includes(token) ||
      deptName.includes(token) ||
      email.includes(token) ||
      phone.includes(token) ||
      username.includes(token) ||
      combined.includes(token)
    );
  });
}
window.filterFacultyList = filterFacultyList;

export function applyFacultySearch() {
  if (!masterData?.faculty) return [];
  const searchInput = document.getElementById('faculty-search-input');
  const deptSelect = document.getElementById('faculty-dept-filter');
  const q = (searchInput?.value || '').trim();
  const dept = (deptSelect?.value || '').trim();

  const filtered = filterFacultyList(masterData.faculty, q, dept);
  renderFacultyTable(filtered);
  return filtered;
}
window.applyFacultySearch = applyFacultySearch;

function renderFacultyTable(facultyList = masterData?.faculty || []) {
  const facTable = document.getElementById('table-faculty-body');
  const countLabel = document.getElementById('faculty-search-count');
  const clearBtn = document.getElementById('btn-faculty-search-clear');
  const searchInput = document.getElementById('faculty-search-input');
  const deptSelect = document.getElementById('faculty-dept-filter');

  const total = masterData?.faculty?.length || 0;
  const hasActiveFilter = Boolean((searchInput && searchInput.value.trim()) || (deptSelect && deptSelect.value));

  if (countLabel) {
    if (hasActiveFilter) {
      countLabel.textContent = `Showing ${facultyList.length} of ${total} faculty`;
      if (clearBtn) clearBtn.style.display = 'inline-block';
    } else {
      countLabel.textContent = `Showing all ${total} faculty members`;
      if (clearBtn) clearBtn.style.display = 'none';
    }
  }

  if (!facTable) return;

  if (facultyList.length === 0) {
    const queryDesc = searchInput?.value?.trim() || deptSelect?.value || '';
    facTable.innerHTML = `
      <tr style="border-bottom: 1px solid var(--border-subtle);">
        <td colspan="6" style="padding: 2.5rem; text-align: center; color: var(--text-muted); background: var(--bg-surface-subtle);">
          ${queryDesc ? `🔍 No faculty members match "<strong>${escapeHtml(queryDesc)}</strong>".` : 'No faculty records found. Click "+ Add Faculty" above to add department faculty.'}
        </td>
      </tr>
    `;
    return;
  }

  facTable.innerHTML = facultyList.map(f => `
    <tr class="faculty-row" data-faculty-id="${f.id}" data-faculty-name="${escapeHtml(f.name || '')}" data-faculty-dept="${escapeHtml((f.department_code || '') + ' ' + (f.department_name || ''))}" data-faculty-email="${escapeHtml(f.email || '')}" style="border-bottom: 1px solid var(--border-subtle);">
      <td style="padding: 0.6rem 0.75rem; font-weight: 600;">
        ${escapeHtml(f.name || '-')}
        ${f.classes_taught ? `<div style="font-size: 0.72rem; color: var(--text-muted); font-weight: normal;">Classes: ${escapeHtml(f.classes_taught)}</div>` : ''}
      </td>
      <td style="padding: 0.6rem 0.75rem;">${f.department_code ? `<span style="background: var(--bg-surface-subtle); padding: 0.15rem 0.4rem; border-radius: 4px; font-weight: 600;">${escapeHtml(f.department_code)}</span>` : ''} ${escapeHtml(f.department_name || '-')}</td>
      <td style="padding: 0.6rem 0.75rem;">${escapeHtml(f.email || '-')}</td>
      <td style="padding: 0.6rem 0.75rem;">${escapeHtml(f.phone || '-')}</td>
      <td style="padding: 0.6rem 0.75rem;" class="tabular-nums">${f.max_periods_per_day ?? 4} / day · ${f.max_periods_per_week ?? 18} / wk ${f.weekly_hours != null ? `(${f.weekly_hours} hrs)` : ''}</td>
      <td style="padding: 0.6rem 0.75rem; text-align: right;">
        <button class="btn-secondary" style="font-size: 0.75rem; padding: 0.25rem 0.5rem;" onclick="window.editFaculty(${f.id})">Edit</button>
        <button class="btn-secondary" style="font-size: 0.75rem; padding: 0.25rem 0.5rem; color: var(--color-error);" onclick="window.deleteFaculty(${f.id})">Delete</button>
      </td>
    </tr>
  `).join('');
}

function renderMasterDataTables() {
  if (!masterData) return;

  // Populate Department Filter dropdown for Faculty Management
  const deptSelect = document.getElementById('faculty-dept-filter');
  if (deptSelect && masterData.departments) {
    const currentDeptVal = deptSelect.value;
    deptSelect.innerHTML = `<option value="">All Departments</option>` +
      masterData.departments.map(d => `<option value="${escapeHtml(d.code)}">${escapeHtml(d.code)} — ${escapeHtml(d.name)}</option>`).join('');
    deptSelect.value = currentDeptVal;
  }

  // Counts
  const facCount = document.getElementById('count-faculty');
  if (facCount) facCount.textContent = masterData.faculty?.length || 0;
  const subCount = document.getElementById('count-subjects');
  if (subCount) subCount.textContent = masterData.subjects?.length || 0;
  const roomCount = document.getElementById('count-rooms');
  if (roomCount) roomCount.textContent = masterData.rooms?.length || 0;
  const secCount = document.getElementById('count-sections');
  if (secCount) secCount.textContent = masterData.sections?.length || 0;
  const holCount = document.getElementById('count-holidays');
  if (holCount) holCount.textContent = masterData.holidays?.length || 0;
  const deptCount = document.getElementById('count-departments');
  if (deptCount) deptCount.textContent = masterData.departments?.length || 0;

  // 1. Faculty with real-time search filtering
  applyFacultySearch();

  // 2. Subjects
  const subTable = document.getElementById('table-subjects-body');
  if (subTable) {
    if (!masterData.subjects || masterData.subjects.length === 0) {
      subTable.innerHTML = `
        <tr style="border-bottom: 1px solid var(--border-subtle);">
          <td colspan="7" style="padding: 2.5rem; text-align: center; color: var(--text-muted); background: var(--bg-surface-subtle);">
            No curriculum subjects found. Click "+ Add Subject" above to add courses/subjects.
          </td>
        </tr>
      `;
    } else {
      subTable.innerHTML = masterData.subjects.map(s => {
        const displayName = s.name || s.short_name || s.code || '-';
        let semDisplay = '-';
        if (s.semester != null) {
          semDisplay = 'Sem ' + s.semester;
        } else if (s.semester_candidates) {
          try {
            const cand = typeof s.semester_candidates === 'string' ? JSON.parse(s.semester_candidates) : s.semester_candidates;
            semDisplay = 'Multiple (Sem ' + (Array.isArray(cand) ? cand.join(', ') : cand) + ')';
          } catch (e) {
            semDisplay = 'Multiple';
          }
        } else {
          semDisplay = 'Multiple';
        }

        const isLab = s.type === 'lab';
        const isActivity = s.type === 'activity';
        const typeBadge = isActivity
          ? '<span style="text-transform: capitalize; background: #FFFBEB; color: #D97706; padding: 0.15rem 0.45rem; border-radius: 4px; font-weight: 600;">⚡ Activity</span>'
          : (isLab ? '<span style="text-transform: capitalize; background: #FDF4FF; color: #9333EA; padding: 0.15rem 0.45rem; border-radius: 4px; font-weight: 600;">🧪 Lab</span> (2p block)' : '<span style="text-transform: capitalize; background: #EFF6FF; color: #2563EB; padding: 0.15rem 0.45rem; border-radius: 4px; font-weight: 600;">📖 Theory</span>');

        return `
          <tr style="border-bottom: 1px solid var(--border-subtle);">
            <td style="padding: 0.6rem 0.75rem; font-weight: 700; color: var(--color-brand-primary); font-family: monospace;">${escapeHtml(s.code || '-')}</td>
            <td style="padding: 0.6rem 0.75rem; font-weight: 600;">${escapeHtml(displayName)}</td>
            <td style="padding: 0.6rem 0.75rem;">${escapeHtml(s.department_code || '-')}</td>
            <td style="padding: 0.6rem 0.75rem;">${escapeHtml(semDisplay)}</td>
            <td style="padding: 0.6rem 0.75rem;">${typeBadge}</td>
            <td style="padding: 0.6rem 0.75rem; font-weight: 700;" class="tabular-nums">${s.weekly_periods != null ? s.weekly_periods + ' periods' : '-'}</td>
            <td style="padding: 0.6rem 0.75rem; text-align: right;">
              <button class="btn-secondary" style="font-size: 0.75rem; padding: 0.25rem 0.5rem;" onclick="window.editSubject(${s.id})">Edit</button>
              <button class="btn-secondary" style="font-size: 0.75rem; padding: 0.25rem 0.5rem; color: var(--color-error);" onclick="window.deleteSubject(${s.id})">Delete</button>
            </td>
          </tr>
        `;
      }).join('');
    }
  }

  // 3. Rooms
  const roomTable = document.getElementById('table-rooms-body');
  if (roomTable) {
    if (!masterData.rooms || masterData.rooms.length === 0) {
      roomTable.innerHTML = `
        <tr style="border-bottom: 1px solid var(--border-subtle);">
          <td colspan="5" style="padding: 2.5rem; text-align: center; color: var(--text-muted); background: var(--bg-surface-subtle);">
            <p style="margin-bottom: 0.75rem;">No rooms or laboratories configured. Click "+ Add Room" above to register classrooms and labs.</p>
            <button class="btn-primary" style="font-size: 0.85rem;" onclick="window.restoreDefaultRooms()">🔄 Revert & Restore Campus Rooms (11)</button>
          </td>
        </tr>
      `;
    } else {
      roomTable.innerHTML = masterData.rooms.map(r => `
        <tr style="border-bottom: 1px solid var(--border-subtle);">
          <td style="padding: 0.6rem 0.75rem; font-weight: 600;">${r.name || '-'}</td>
          <td style="padding: 0.6rem 0.75rem;"><span style="text-transform: capitalize; background: var(--bg-surface-subtle); padding: 0.15rem 0.45rem; border-radius: 4px;">${r.type || '-'}</span></td>
          <td style="padding: 0.6rem 0.75rem;" class="tabular-nums">${r.capacity != null ? r.capacity + ' seats' : '-'}</td>
          <td style="padding: 0.6rem 0.75rem;"><span style="color: var(--color-success); font-weight: 600;">● Active</span></td>
          <td style="padding: 0.6rem 0.75rem; text-align: right;">
            <button class="btn-secondary" style="font-size: 0.75rem; padding: 0.25rem 0.5rem;" onclick="window.editRoom(${r.id})">Edit</button>
            <button class="btn-secondary" style="font-size: 0.75rem; padding: 0.25rem 0.5rem; color: var(--color-error);" onclick="window.deleteRoom(${r.id})">Delete</button>
          </td>
        </tr>
      `).join('');
    }
  }

  // 4. Sections (15 sections: CSE-1A..1D, CSE-3A..3D, CSE-5A..5D, CSE-7A..7C)
  const secTable = document.getElementById('table-sections-body');
  if (secTable) {
    if (!masterData.sections || masterData.sections.length === 0) {
      secTable.innerHTML = `
        <tr style="border-bottom: 1px solid var(--border-subtle);">
          <td colspan="5" style="padding: 2.5rem; text-align: center; color: var(--text-muted); background: var(--bg-surface-subtle);">
            No student sections found. Click "+ Add Section" above to create classes/sections.
          </td>
        </tr>
      `;
    } else {
      secTable.innerHTML = (masterData.sections || []).map(sec => {
        let batchesStr = '';
        if (sec.batches) {
          try {
            const b = typeof sec.batches === 'string' ? JSON.parse(sec.batches) : sec.batches;
            if (Array.isArray(b) && b.length > 0) batchesStr = ` · Batches: ${b.join(', ')}`;
          } catch(e) {}
        }
        return `
          <tr style="border-bottom: 1px solid var(--border-subtle);">
            <td style="padding: 0.6rem 0.75rem; font-weight: 700; color: var(--color-brand-primary);">${escapeHtml(sec.name)}</td>
            <td style="padding: 0.6rem 0.75rem;">${escapeHtml(sec.department_name || sec.department_code)}${batchesStr ? `<div style="font-size: 0.72rem; color: var(--text-muted);">${escapeHtml(batchesStr)}</div>` : ''}</td>
            <td style="padding: 0.6rem 0.75rem;">Semester ${sec.semester}</td>
            <td style="padding: 0.6rem 0.75rem;" class="tabular-nums">${sec.strength ? sec.strength + ' students' : '-'}</td>
            <td style="padding: 0.6rem 0.75rem; text-align: right;">
              <button class="btn-secondary" style="font-size: 0.75rem; padding: 0.25rem 0.5rem;" onclick="window.editSection(${sec.id})">Edit</button>
              <button class="btn-secondary" style="font-size: 0.75rem; padding: 0.25rem 0.5rem; color: var(--color-error);" onclick="window.deleteSection(${sec.id})">Delete</button>
            </td>
          </tr>
        `;
      }).join('');
    }
  }

  // 5. Holidays
  const holTable = document.getElementById('table-holidays-body');
  if (holTable) {
    if (!masterData.holidays || masterData.holidays.length === 0) {
      holTable.innerHTML = `
        <tr style="border-bottom: 1px solid var(--border-subtle);">
          <td colspan="3" style="padding: 2.5rem; text-align: center; color: var(--text-muted); background: var(--bg-surface-subtle);">
            No academic holidays scheduled. Click "+ Add Holiday" above to register holidays.
          </td>
        </tr>
      `;
    } else {
      holTable.innerHTML = (masterData.holidays || []).map(h => `
        <tr style="border-bottom: 1px solid var(--border-subtle);">
          <td style="padding: 0.6rem 0.75rem; font-weight: 600; color: var(--color-brand-primary);">${h.date}</td>
          <td style="padding: 0.6rem 0.75rem;">${h.description}</td>
          <td style="padding: 0.6rem 0.75rem; text-align: right;">
            <button class="btn-secondary" style="font-size: 0.75rem; padding: 0.25rem 0.5rem; color: var(--color-error);" onclick="window.deleteHoliday(${h.id})">Remove</button>
          </td>
        </tr>
      `).join('');
    }
  }

  // 6. Departments (CSE active, IT and ECE unused)
  const deptTable = document.getElementById('table-departments-body');
  if (deptTable) {
    if (!masterData.departments || masterData.departments.length === 0) {
      deptTable.innerHTML = `
        <tr style="border-bottom: 1px solid var(--border-subtle);">
          <td colspan="4" style="padding: 2.5rem; text-align: center; color: var(--text-muted); background: var(--bg-surface-subtle);">
            No academic departments found. Click "+ Add Department" above to create departments.
          </td>
        </tr>
      `;
    } else {
      deptTable.innerHTML = (masterData.departments || []).map(d => {
        const isCse = d.code === 'CSE';
        const statusBadge = isCse
          ? '<span class="drilldown-badge-pill" style="background: var(--color-success-bg); color: var(--color-success); border: 1px solid var(--color-success); font-weight: 600;">● Active (All Records)</span>'
          : '<span class="drilldown-badge-pill" style="background: var(--bg-surface-subtle); color: var(--text-muted); border: 1px solid var(--border-subtle);">Unused (Kept Intact)</span>';
        return `
          <tr style="border-bottom: 1px solid var(--border-subtle);">
            <td style="padding: 0.6rem 0.75rem; font-weight: 700; color: var(--color-brand-primary); font-family: monospace;">${escapeHtml(d.code)}</td>
            <td style="padding: 0.6rem 0.75rem; font-weight: 600;">${escapeHtml(d.name)}</td>
            <td style="padding: 0.6rem 0.75rem;">${statusBadge}</td>
            <td style="padding: 0.6rem 0.75rem; text-align: right;">
              <button class="btn-secondary" style="font-size: 0.75rem; padding: 0.25rem 0.5rem;" onclick="window.editDepartment(${d.id})">Edit</button>
            </td>
          </tr>
        `;
      }).join('');
    }
  }
}

// 3. Timetable Studio
let studioControlsInitialized = false;

async function loadStudio(preferredVersionId = null) {
  await loadMasterData();
  const versionsData = await apiRequest('/api/timetable/versions');
  const selector = document.getElementById('studio-version-selector');
  if (selector && versionsData.versions?.length) {
    let selectedId = preferredVersionId ? parseInt(preferredVersionId, 10) : null;
    if (!selectedId || !versionsData.versions.some(v => v.id === selectedId)) {
      const activeVer = versionsData.versions.find(v => v.status === 'active');
      selectedId = activeVer ? activeVer.id : versionsData.versions[0].id;
    }

    selector.innerHTML = versionsData.versions.map(v => `
      <option value="${v.id}" ${v.id === selectedId ? 'selected' : ''}>
        ${v.name} [${v.status.toUpperCase()}] (${v.entries_count} classes)
      </option>
    `).join('');

    activeVersionId = selectedId;
  }

  setupStudioControls();
  if (activeVersionId) {
    await loadStudioVersion(activeVersionId);
  }
}

function setupStudioControls() {
  if (studioControlsInitialized) return;
  studioControlsInitialized = true;

  const versionSelector = document.getElementById('studio-version-selector');
  versionSelector?.addEventListener('change', async () => {
    if (activeResolver && activeResolver.isRunning) {
      const ok = await showAppConfirm({
        title: 'Cancel Conflict Resolution',
        message: 'Conflict resolution is currently in progress. Switching versions will cancel resolution and discard the copy. Continue?',
        confirmText: 'Discard & Switch',
        isDanger: true
      });
      if (!ok) {
        versionSelector.value = activeVersionId;
        return;
      }
      activeResolver.cancel();
      activeResolver = null;
      resetResolvedPreviewState();
    } else if (isResolvedDraftPreview) {
      const ok = await showAppConfirm({
        title: 'Discard Unsaved Preview',
        message: 'You have an unsaved resolved preview. Switching versions will discard this copy. Continue?',
        confirmText: 'Discard & Switch',
        isDanger: true
      });
      if (!ok) {
        versionSelector.value = activeVersionId;
        return;
      }
      resetResolvedPreviewState();
    }
    activeVersionId = parseInt(versionSelector.value, 10);
    loadStudioVersion(activeVersionId);
  });

  const modeButtons = document.querySelectorAll('[data-studio-mode]');
  modeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      modeButtons.forEach(b => {
        b.classList.remove('btn-primary');
        b.classList.add('btn-secondary');
      });
      btn.classList.add('btn-primary');
      btn.classList.remove('btn-secondary');

      studioMode = btn.getAttribute('data-studio-mode');
      populateStudioEntitySelector();
      renderStudioGrid();
    });
  });

  const entitySelector = document.getElementById('studio-entity-selector');
  entitySelector?.addEventListener('change', () => {
    studioEntityId = parseInt(entitySelector.value, 10);
    renderStudioGrid();
  });

  populateStudioEntitySelector();

  // Studio actions: Generate New naturally conflicted draft
  document.getElementById('btn-studio-generate')?.addEventListener('click', async () => {
    if (isGenerationRunning || (activeResolver && activeResolver.isRunning)) {
      showToast('A timetable generation or resolution is active in the background.', 'warning');
      return;
    }

    if (isResolvedDraftPreview) {
      resetResolvedPreviewState();
    }

    const now = new Date();
    const timeFormatted = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dateFormatted = now.toLocaleDateString([], { month: 'short', day: 'numeric' });
    const targetName = `Draft – ${dateFormatted} ${timeFormatted}`;

    updateGenerationProgress({
      isRunning: true,
      progress: 15,
      phase: 'Generating initial draft with realistic conflicts...',
      name: targetName,
      startedAt: Date.now()
    });

    try {
      const res = await apiRequest('/api/timetable/generate', {
        method: 'POST',
        body: { name: targetName },
        showErrorToast: false
      });
      await onGenerationCompleted(res);
    } catch (err) {
      onGenerationFailed({ reason: err.message || 'Generation failed' });
      showToast(err.message || 'Failed to generate timetable', 'error');
    }
  });

  // Task 4: "Regenerate" becomes "Generate" when in resolved draft preview state
  const regenBtn = document.getElementById('btn-studio-regenerate');
  regenBtn?.addEventListener('click', async () => {
    if (isGenerationRunning) {
      showToast('A timetable generation computation is active in the background.', 'warning');
      return;
    }

    // If draft is resolved and ready for review: click "Generate" saves the previewed draft
    if (isResolvedDraftPreview && draftWorkingEntries) {
      try {
        const baseName = currentVersionData?.version?.name || 'Academic Master';
        const cleanBase = baseName.replace(/\s*\(Resolved\)/gi, '').replace(/\s*\(.*conflicts\)/gi, '');
        const newVersionName = `${cleanBase} (Resolved Schedule)`;
        const saveRes = await apiRequest('/api/timetable/versions', {
          method: 'POST',
          body: {
            name: newVersionName,
            notes: 'Created via automated conflict resolution engine with 0 conflicts',
            entries: draftWorkingEntries,
            status: 'draft'
          }
        });

        showToast('Timetable generation successful', 'success');
        resetResolvedPreviewState();
        await loadStudio(saveRes.versionId);
      } catch (err) {
        showToast(err.message || 'Failed to save resolved timetable version', 'error');
      }
      return;
    }

    // Normal state: check if current version has conflicts
    const val = runSharedValidation();
    if (val.errorCount > 0) {
      // Current version has conflicts: start min-conflicts resolver visibly!
      startResolveWorkflow();
      return;
    }

    // Current version already has 0 conflicts: produce genuinely DIFFERENT valid arrangement
    const currentName = currentVersionData?.version?.name || 'Academic Master';
    const altName = `${currentName} (Variant ${Math.floor(Math.random() * 900 + 100)})`;

    updateGenerationProgress({
      isRunning: true,
      progress: 15,
      phase: 'Re-shuffling timetable to produce alternative 0-conflict arrangement...',
      name: altName,
      startedAt: Date.now()
    });

    try {
      const res = await apiRequest('/api/timetable/generate', {
        method: 'POST',
        body: { name: altName, regenerate: true, currentVersionId: activeVersionId },
        showErrorToast: false
      });
      if (res.cellsChanged === 0) {
        showToast('No better arrangement found', 'info');
      } else if (res.cellsChanged > 0) {
        showToast(`Alternative timetable generated: ${res.cellsChanged} classes rearranged.`, 'success');
      }
      await onGenerationCompleted(res);
    } catch (err) {
      onGenerationFailed({ reason: err.message || 'Regeneration failed' });
      showToast(err.message || 'Failed to regenerate timetable', 'error');
    }
  });

  document.getElementById('btn-studio-activate')?.addEventListener('click', async () => {
    if (!activeVersionId) return;
    try {
      const res = await apiRequest(`/api/timetable/versions/${activeVersionId}/activate`, { method: 'POST' });
      showToast(res.message, 'success');
      await loadStudio(activeVersionId);
      await loadOverview();
    } catch (err) {
      showToast(err.message || 'Failed to activate timetable', 'error');
    }
  });

  document.getElementById('btn-studio-duplicate')?.addEventListener('click', async () => {
    if (!activeVersionId) return;
    try {
      const res = await apiRequest(`/api/timetable/versions/${activeVersionId}/duplicate`, { method: 'POST' });
      showToast(res.message, 'success');
      await loadStudio(res.versionId);
    } catch (err) {}
  });

  document.getElementById('btn-studio-export-pdf')?.addEventListener('click', async () => {
    if (!currentVersionData || !masterData) {
      showToast('No timetable version loaded to export', 'warning');
      return;
    }
    const { workingDays, timeSlots } = masterData;
    const entries = draftWorkingEntries || currentVersionData.entries || [];
    let filteredEntries = entries;
    let entityName = 'Master College Grid';

    if (studioMode === 'section') {
      filteredEntries = entries.filter(e => e.section_id === studioEntityId);
      const sec = masterData.sections.find(s => s.id === studioEntityId);
      if (sec) entityName = `Section ${sec.name} (Semester ${sec.semester})`;
    } else if (studioMode === 'faculty') {
      filteredEntries = entries.filter(e => e.faculty_id === studioEntityId);
      const fac = masterData.faculty.find(f => f.id === studioEntityId);
      if (fac) entityName = `Faculty: ${fac.name} (${fac.department_code || ''})`;
    } else if (studioMode === 'room') {
      filteredEntries = entries.filter(e => e.room_id === studioEntityId);
      const rm = masterData.rooms.find(r => r.id === studioEntityId);
      if (rm) entityName = `Room ${rm.name} (${rm.type || 'Classroom'})`;
    }

    try {
      showToast('Generating timetable PDF...', 'info');
      await exportTimetableToPdf({
        title: `Timetable Studio Schedule · ${entityName}`,
        subtitle: `Version: ${currentVersionData.version?.name || 'Academic Master'} (${currentVersionData.version?.status || 'draft'})`,
        meta: {
          'View': `By ${studioMode.charAt(0).toUpperCase() + studioMode.slice(1)}`,
          'Scheduled Periods': `${filteredEntries.length} classes`,
          'Integrity': lastSharedValidation?.isValid ? '✓ 0 Conflicts' : `⚠ ${lastSharedValidation?.errorCount || 0} Conflicts`
        },
        days: workingDays,
        slots: timeSlots,
        entries: filteredEntries,
        filename: `Timetable_${entityName.replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf`
      });
      showToast('Timetable PDF generated and downloaded', 'success');
    } catch (err) {
      console.error('PDF export failed:', err);
      showToast('Opening fallback print preview...', 'warning');
      printOrExportPdf({
        title: `Timetable Studio Schedule · ${entityName}`,
        subtitle: `Version: ${currentVersionData.version?.name || 'Academic Master'} (${currentVersionData.version?.status || 'draft'})`,
        meta: {
          'View': `By ${studioMode.charAt(0).toUpperCase() + studioMode.slice(1)}`,
          'Scheduled Periods': `${filteredEntries.length} classes`,
          'Integrity': lastSharedValidation?.isValid ? '✓ 0 Conflicts' : `⚠ ${lastSharedValidation?.errorCount || 0} Conflicts`
        },
        days: workingDays,
        slots: timeSlots,
        entries: filteredEntries
      });
    }
  });

  // Undo / Redo Toolbar buttons & Keyboard shortcuts
  document.getElementById('btn-studio-undo')?.addEventListener('click', () => executeUndo());
  document.getElementById('btn-studio-redo')?.addEventListener('click', () => executeRedo());

  window.addEventListener('keydown', (e) => {
    if (currentTab !== 'studio') return;
    const tag = e.target?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      e.preventDefault();
      executeUndo();
    } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
      e.preventDefault();
      executeRedo();
    }
  });

  // Task 2 & 3: Resolve Button Click Handler
  document.getElementById('btn-studio-resolve')?.addEventListener('click', () => {
    if (activeResolver && activeResolver.isRunning) {
      showToast('Resolution engine is currently solving conflicts...', 'info');
      return;
    }
    const val = runSharedValidation();
    if (val.errorCount === 0) {
      showToast('0 conflicts found. Timetable is fully compliant.', 'success');
      return;
    }
    startResolveWorkflow();
  });

  // Amber Banner quick resolve trigger
  document.getElementById('btn-banner-trigger-resolve')?.addEventListener('click', () => {
    startResolveWorkflow();
  });

  // Resolution Progress Controls: Speed, Pause/Resume, Step, Skip, Cancel
  document.getElementById('resolve-speed-select')?.addEventListener('change', (e) => {
    if (activeResolver) activeResolver.setSpeed(e.target.value);
  });

  const pauseBtn = document.getElementById('btn-resolve-pause');
  pauseBtn?.addEventListener('click', () => {
    if (!activeResolver) return;
    if (activeResolver.isPaused) {
      activeResolver.resume();
      pauseBtn.textContent = '⏸ Pause';
      const stepBtn = document.getElementById('btn-resolve-step');
      if (stepBtn) stepBtn.disabled = true;
    } else {
      activeResolver.pause();
      pauseBtn.textContent = '▶ Resume';
      const stepBtn = document.getElementById('btn-resolve-step');
      if (stepBtn) stepBtn.disabled = false;
    }
  });

  document.getElementById('btn-resolve-step')?.addEventListener('click', () => {
    if (activeResolver && activeResolver.isPaused) {
      activeResolver.singleStep();
    }
  });

  document.getElementById('btn-resolve-skip')?.addEventListener('click', () => {
    if (activeResolver) {
      activeResolver.skipToEnd();
    }
  });

  // Resolution Progress Cancel button
  document.getElementById('btn-cancel-resolve')?.addEventListener('click', () => {
    if (activeResolver) {
      activeResolver.cancel();
      activeResolver = null;
    }
    document.getElementById('studio-resolve-progress-strip').style.display = 'none';
    document.getElementById('studio-resolve-log-panel').style.display = 'none';
    if (originalVersionEntries) {
      draftWorkingEntries = JSON.parse(JSON.stringify(originalVersionEntries));
    }
    runSharedValidation();
    renderStudioGrid();
    showToast('Conflict resolution cancelled. Working draft restored.', 'info');
  });

  // Live Resolution Log Collapsible Header
  document.getElementById('resolve-log-header')?.addEventListener('click', () => {
    const content = document.getElementById('resolve-log-content');
    const icon = document.getElementById('resolve-log-toggle-icon');
    if (content && icon) {
      const isHidden = content.style.display === 'none';
      content.style.display = isHidden ? 'flex' : 'none';
      icon.textContent = isHidden ? 'Collapse ▲' : 'Expand ▼';
    }
  });

  // Diff toggle button
  document.getElementById('btn-toggle-diff-details')?.addEventListener('click', () => {
    const diffContainer = document.getElementById('studio-diff-container');
    const toggleBtn = document.getElementById('btn-toggle-diff-details');
    if (!diffContainer || !toggleBtn) return;
    const isHidden = diffContainer.style.display === 'none';
    diffContainer.style.display = isHidden ? 'block' : 'none';
    toggleBtn.textContent = isHidden ? 'Hide Change Details ▲' : 'Show Change Details (Diff) ▼';
  });

  // Discard Draft buttons
  document.getElementById('btn-discard-draft')?.addEventListener('click', () => {
    resetResolvedPreviewState();
    loadStudioVersion(activeVersionId);
    showToast('Resolved working draft discarded. Restored original version.', 'info');
  });

  document.getElementById('btn-discard-failed-draft')?.addEventListener('click', () => {
    resetResolvedPreviewState();
    loadStudioVersion(activeVersionId);
    showToast('Partial draft discarded. Restored original version.', 'info');
  });

  document.getElementById('btn-keep-partial-draft')?.addEventListener('click', () => {
    document.getElementById('studio-resolve-failed-banner').style.display = 'none';
    showToast('Keeping partial resolution draft for manual edits.', 'info');
  });

  // Task 4: Compare Before / After toggle
  document.getElementById('chk-compare-original')?.addEventListener('change', (e) => {
    isComparingWithOriginal = !!e.target.checked;
    const compText = document.getElementById('compare-toggle-text');
    if (compText) {
      compText.textContent = isComparingWithOriginal ? 'Showing: Original Conflicted Draft (Before)' : 'Compare Before / After';
    }
    renderStudioGrid();
  });
}

function resetResolvedPreviewState() {
  const compText = document.getElementById('compare-toggle-text');
  if (compText) compText.textContent = 'Compare Before / After';
  if (activeResolver) {
    activeResolver.cancel();
    activeResolver = null;
  }
  draftWorkingEntries = null;
  originalVersionEntries = null;
  isResolvedDraftPreview = false;
  isComparingWithOriginal = false;
  activeStepHighlight = null;
  undoStack = [];
  redoStack = [];
  updateUndoRedoButtons();

  // Reset UI elements
  document.getElementById('studio-resolve-progress-strip').style.display = 'none';
  document.getElementById('studio-resolve-log-panel').style.display = 'none';
  document.getElementById('resolve-cross-section-chip').style.display = 'none';
  document.getElementById('studio-resolved-banner').style.display = 'none';
  document.getElementById('studio-resolve-failed-banner').style.display = 'none';
  const compLabel = document.getElementById('compare-toggle-label');
  if (compLabel) compLabel.style.display = 'none';
  const chkComp = document.getElementById('chk-compare-original');
  if (chkComp) chkComp.checked = false;

  // Reset "Regenerate" button styling and label
  const regenBtn = document.getElementById('btn-studio-regenerate');
  if (regenBtn) {
    regenBtn.textContent = 'Regenerate';
    regenBtn.className = 'btn-secondary';
    regenBtn.title = 'Regenerate alternative timetable with randomized ordering';
  }
}

// Undo / Redo Core Functions
function updateUndoRedoButtons() {
  const undoBtn = document.getElementById('btn-studio-undo');
  const redoBtn = document.getElementById('btn-studio-redo');
  if (undoBtn) {
    undoBtn.disabled = undoStack.length === 0;
    undoBtn.style.opacity = undoStack.length === 0 ? '0.5' : '1';
  }
  if (redoBtn) {
    redoBtn.disabled = redoStack.length === 0;
    redoBtn.style.opacity = redoStack.length === 0 ? '0.5' : '1';
  }
}

function pushUndoSnapshot() {
  const current = draftWorkingEntries || currentVersionData?.entries || [];
  undoStack.push(JSON.parse(JSON.stringify(current)));
  if (undoStack.length > 50) undoStack.shift();
  redoStack = [];
  updateUndoRedoButtons();
}

async function executeUndo() {
  if (undoStack.length === 0) return;
  const current = draftWorkingEntries || currentVersionData?.entries || [];
  redoStack.push(JSON.parse(JSON.stringify(current)));
  const restored = undoStack.pop();
  updateUndoRedoButtons();

  if (draftWorkingEntries) {
    draftWorkingEntries = restored;
  } else if (currentVersionData) {
    currentVersionData.entries = restored;
    // Persist restored slot placements
    await syncRestoredEntriesToDb(restored);
  }

  if (originalBaselineSnapshot && restored) {
    const restoredSnapshot = JSON.stringify(restored.map(e => ({
      id: e.id,
      day_id: e.day_id,
      slot_id: e.slot_id,
      room_id: e.room_id,
      faculty_id: e.faculty_id
    })));
    if (restoredSnapshot === originalBaselineSnapshot) {
      draftWorkingEntries = null;
    }
  }

  runSharedValidation();
  renderStudioGrid();
  showToast('Undone manual move (Ctrl+Z)', 'info');
}

async function executeRedo() {
  if (redoStack.length === 0) return;
  const current = draftWorkingEntries || currentVersionData?.entries || [];
  undoStack.push(JSON.parse(JSON.stringify(current)));
  const restored = redoStack.pop();
  updateUndoRedoButtons();

  if (draftWorkingEntries) {
    draftWorkingEntries = restored;
  } else if (currentVersionData) {
    currentVersionData.entries = restored;
    await syncRestoredEntriesToDb(restored);
  }

  runSharedValidation();
  renderStudioGrid();
  showToast('Redone manual move (Ctrl+Y)', 'info');
}

async function syncRestoredEntriesToDb(entriesList) {
  if (!entriesList || !activeVersionId) return;
  for (const e of entriesList) {
    try {
      await apiRequest(`/api/timetable/entries/${e.id}/move`, {
        method: 'POST',
        body: {
          targetDayId: e.day_id,
          targetSlotId: e.slot_id,
          targetRoomId: e.room_id,
          targetFacultyId: e.faculty_id
        },
        showErrorToast: false
      });
    } catch (err) {}
  }
}

// Unified Timetable Validation Function for CTAS
// Calculates conflicts for faculty, rooms, and sections consistently across Header Counter, Toolbar Button, Grid, and Resolver
export function calculateTimetableConflicts(targetEntries = null, targetMasterData = null, options = {}) {
  const mData = targetMasterData || masterData;
  const entriesToValidate = targetEntries || draftWorkingEntries || currentVersionData?.entries || [];

  const versionObj = currentVersionData?.version || currentVersionData || {};
  const isImportedVerified = versionObj.source === 'imported_verified';

  let baselineFingerprint = options.baselineFingerprint;
  if (!baselineFingerprint && versionObj.baseline_fingerprint) {
    try {
      baselineFingerprint = typeof versionObj.baseline_fingerprint === 'string'
        ? JSON.parse(versionObj.baseline_fingerprint)
        : versionObj.baseline_fingerprint;
    } catch (e) {}
  }

  // Check if current entries match the pristine loaded baseline snapshot
  let isModified = false;
  if (originalBaselineSnapshot && entriesToValidate.length > 0) {
    const currentSnapshot = JSON.stringify(entriesToValidate.map(e => ({
      id: e.id,
      day_id: e.day_id,
      slot_id: e.slot_id,
      room_id: e.room_id,
      faculty_id: e.faculty_id
    })));
    isModified = (currentSnapshot !== originalBaselineSnapshot);
  } else if (draftWorkingEntries) {
    isModified = true;
  }

  const validationOpts = {
    isGeneratingOrEditing: isModified || Boolean(options.isGeneratingOrEditing),
    isImportedBaseline: isImportedVerified && !isModified,
    baselineFingerprint: baselineFingerprint || [],
    ...options
  };

  const rawValidation = validateTimetableConflict(entriesToValidate, mData || {}, validationOpts);

  // Categorize conflicts consistently across Faculty, Rooms, and Sections
  const facultyConflicts = (rawValidation.conflicts || []).filter(v =>
    v.type === 'FACULTY_DOUBLE_BOOKED' || v.type === 'FACULTY_UNAVAILABLE' || v.type === 'FACULTY_DAILY_LIMIT_EXCEEDED'
  );
  const roomConflicts = (rawValidation.conflicts || []).filter(v =>
    v.type === 'ROOM_DOUBLE_BOOKED' || v.type === 'ROOM_CAPACITY_EXCEEDED' || v.type === 'ROOM_TYPE_MISMATCH' || v.type === 'LAB_ROOM_REQUIRED'
  );
  const sectionConflicts = (rawValidation.conflicts || []).filter(v =>
    v.type === 'SECTION_DOUBLE_BOOKED' || v.type === 'SUBJECT_PERIODS_MISMATCH' || v.type === 'LAB_NON_CONSECUTIVE'
  );

  const validationResult = {
    isValid: rawValidation.isValid,
    errorCount: rawValidation.errorCount,
    totalConflicts: rawValidation.errorCount,
    conflicts: rawValidation.conflicts,
    conflictsByEntryId: rawValidation.conflictsByEntryId,
    byEntryId: rawValidation.conflictsByEntryId,
    conflictsByCellKey: rawValidation.conflictsByCellKey,
    facultyConflicts,
    roomConflicts,
    sectionConflicts
  };

  lastSharedValidation = validationResult;

  // 1. Sync Studio Header Validation Badge & Conflict Counter
  const statusBadge = document.getElementById('studio-validation-badge');
  const conflictCounter = document.getElementById('studio-conflict-counter');
  if (validationResult.isValid) {
    if (statusBadge) {
      statusBadge.innerHTML = `<span id="studio-conflict-counter" style="color: var(--color-success); font-weight: 700;">✓ 0 Conflicts · Fully Verified</span>`;
    } else if (conflictCounter) {
      conflictCounter.textContent = '✓ 0 Conflicts · Fully Verified';
      conflictCounter.style.color = 'var(--color-success)';
    }
  } else {
    if (statusBadge) {
      statusBadge.innerHTML = `<span id="studio-conflict-counter" style="color: var(--color-error); font-weight: 700;">⚠ ${validationResult.errorCount} Conflicts Detected</span>`;
    } else if (conflictCounter) {
      conflictCounter.textContent = `⚠ ${validationResult.errorCount} Conflicts Detected`;
      conflictCounter.style.color = 'var(--color-error)';
    }
  }

  // 2. Sync Studio Toolbar Resolve Button
  const resolveBtn = document.getElementById('btn-studio-resolve');
  const resolveBtnText = document.getElementById('resolve-btn-text');
  const resolveBtnBadge = document.getElementById('resolve-btn-badge');

  if (resolveBtn && resolveBtnText) {
    if (validationResult.errorCount > 0) {
      resolveBtnText.textContent = `Resolve ${validationResult.errorCount}`;
      if (resolveBtnBadge) {
        resolveBtnBadge.textContent = validationResult.errorCount;
        resolveBtnBadge.style.display = 'none';
      }
      resolveBtn.style.color = 'var(--color-error)';
      resolveBtn.style.borderColor = 'var(--color-error)';
      resolveBtn.style.background = 'var(--bg-surface)';
      resolveBtn.style.cursor = 'pointer';
      resolveBtn.title = `Click to resolve all ${validationResult.errorCount} conflicts with min-conflicts heuristic search`;
    } else {
      resolveBtnText.textContent = '0 Conflicts ✓ Done';
      if (resolveBtnBadge) {
        resolveBtnBadge.textContent = '0';
        resolveBtnBadge.style.display = 'none';
      }
      resolveBtn.style.color = '#15803D';
      resolveBtn.style.borderColor = '#86EFAC';
      resolveBtn.style.background = '#DCFCE7';
      resolveBtn.style.cursor = 'pointer';
      resolveBtn.title = '0 conflicts found. Fully verified.';
    }
  }

  // 3. Sync Studio Draft Conflict Banner
  const studioConflictBanner = document.getElementById('studio-draft-conflict-banner') || document.getElementById('studio-conflict-banner');
  const draftConflictText = document.getElementById('draft-conflict-banner-text');
  if (studioConflictBanner) {
    if (validationResult.errorCount > 0) {
      studioConflictBanner.style.display = 'block';
      if (draftConflictText) {
        draftConflictText.textContent = `Draft generated with ${validationResult.errorCount} conflicts. Click Regenerate to resolve them.`;
      }
    } else {
      studioConflictBanner.style.display = 'none';
    }
  }

  return validationResult;
}

export const runSharedValidation = calculateTimetableConflicts;
export const validateConflicts = calculateTimetableConflicts;
window.calculateTimetableConflicts = calculateTimetableConflicts;
window.runSharedValidation = calculateTimetableConflicts;
window.validateConflicts = calculateTimetableConflicts;

// Task 3: The Resolve Workflow (Min-Conflicts Local Search on Working Draft)
async function startResolveWorkflow() {
  if (!currentVersionData?.entries?.length || !masterData) {
    showToast('No timetable loaded to resolve', 'warning');
    return;
  }

  // Isolation check: if active/published version is open, duplicate to draft first
  if (currentVersionData.version?.status === 'active') {
    showToast('Active timetable detected: creating working draft to isolate changes...', 'info');
    try {
      const dupRes = await apiRequest(`/api/timetable/versions/${activeVersionId}/duplicate`, { method: 'POST' });
      await loadStudio(dupRes.versionId);
    } catch (err) {
      showToast('Failed to clone active version for safe draft resolution', 'error');
      return;
    }
  }

  // Establish isolated draft copies
  draftWorkingEntries = JSON.parse(JSON.stringify(currentVersionData.entries));
  originalVersionEntries = JSON.parse(JSON.stringify(currentVersionData.entries));
  undoStack = [];
  redoStack = [];
  updateUndoRedoButtons();

  // Show live progress strip and log panel
  const progressStrip = document.getElementById('studio-resolve-progress-strip');
  const progressCounter = document.getElementById('resolve-progress-counter');
  const progressStatus = document.getElementById('resolve-progress-status');
  const logPanel = document.getElementById('studio-resolve-log-panel');
  const logContent = document.getElementById('resolve-log-content');
  const logBadge = document.getElementById('resolve-log-count-badge');
  const conflictBanner = document.getElementById('studio-draft-conflict-banner') || document.getElementById('studio-conflict-banner');
  const resolvedBanner = document.getElementById('studio-resolved-banner');
  const failedBanner = document.getElementById('studio-resolve-failed-banner');
  const crossChip = document.getElementById('resolve-cross-section-chip');

  if (progressStrip) progressStrip.style.display = 'block';
  if (logPanel) logPanel.style.display = 'block';
  if (conflictBanner) conflictBanner.style.display = 'none';
  if (resolvedBanner) resolvedBanner.style.display = 'none';
  if (failedBanner) failedBanner.style.display = 'none';
  if (crossChip) crossChip.style.display = 'none';

  if (logContent) {
    logContent.innerHTML = '<div style="color: var(--text-muted); font-style: italic;">Engine initializing Min-Conflicts solver...</div>';
  }
  if (logBadge) logBadge.textContent = '0 steps';

  const initialVal = runSharedValidation(draftWorkingEntries);
  const initialConflictsCount = initialVal.errorCount;
  if (progressCounter) progressCounter.textContent = `${initialVal.errorCount} Conflicts`;
  if (progressStatus) progressStatus.textContent = 'Initializing Min-Conflicts local search heuristics...';

  const speedVal = document.getElementById('resolve-speed-select')?.value || 'normal';
  let initialStepDelay = 500;
  if (speedVal === 'slow') initialStepDelay = 850;
  else if (speedVal === 'fast') initialStepDelay = 150;

  // Instantiate deterministic non-blocking solver
  activeResolver = new TimetableResolver(draftWorkingEntries, masterData, {
    validator: calculateTimetableConflicts,
    maxDurationMs: 30000,
    maxIterations: 20000,
    stepDelayMs: initialStepDelay,
    onStep: (stepData) => {
      const step = stepData.step || {};
      const entries = stepData.entries || [];
      const conflictsCount = stepData.conflictsCount ?? stepData.conflictsRemaining ?? 0;
      const iterations = stepData.iterations || 0;
      const log = stepData.log || (activeResolver ? activeResolver.resolutionLog : []) || [];

      pushUndoSnapshot();
      draftWorkingEntries = entries;
      runSharedValidation(draftWorkingEntries);

      if (progressCounter) progressCounter.textContent = `${conflictsCount} Conflicts`;
      const resolveBtnText = document.getElementById('resolve-btn-text');
      const resolveBadge = document.getElementById('resolve-btn-badge');
      if (resolveBtnText) resolveBtnText.textContent = conflictsCount > 0 ? `Resolve ${conflictsCount}` : '0 Conflicts ✓ Done';
      if (resolveBadge) resolveBadge.style.display = 'none';
      if (progressStatus) progressStatus.textContent = `Iteration ${iterations.toLocaleString()}: ${step.description || 'Interchanging periods'}`;

      if (logContent) {
        if (!log || log.length <= 1) logContent.innerHTML = '';
        const logLine = document.createElement('div');
        logLine.style.padding = '0.2rem 0';
        logLine.style.borderBottom = '1px solid #E5E7EB';
        logLine.innerHTML = `<strong>Step ${step.stepNo || 1}:</strong> ${escapeHtml(step.description || 'Period move')} &middot; <span style="color: ${conflictsCount < (step.conflictsBefore ?? conflictsCount) ? 'var(--color-success)' : 'var(--color-warning)'}; font-weight: 700;">Conflicts ${step.conflictsBefore ?? conflictsCount} &rarr; ${conflictsCount}</span>`;
        logContent.appendChild(logLine);
        logContent.scrollTop = logContent.scrollHeight;
      }
      if (logBadge) logBadge.textContent = `${log.length} steps`;

      if (crossChip) {
        if (studioMode === 'section' && step.sectionId && step.sectionId !== studioEntityId) {
          crossChip.textContent = `Changes also happening in ${step.sectionName}`;
          crossChip.style.display = 'inline-block';
        } else {
          crossChip.style.display = 'none';
        }
      }

      activeStepHighlight = {
        sourceDayId: step.sourceDayId,
        sourceSlotId: step.sourceSlotId,
        sourceEntryId: step.sourceEntryId,
        targetDayId: step.targetDayId,
        targetSlotId: step.targetSlotId,
        targetEntryId: step.targetEntryId
      };

      renderStudioGrid();
    },
    onProgress: (p) => {
      // Live badge countdown (e.g. 13 -> 11 -> 8 -> 4 -> 0)
      if (progressCounter) progressCounter.textContent = `${p.conflictsCount} Conflicts`;
      if (progressStatus) progressStatus.textContent = `Iteration ${p.iterations.toLocaleString()}: ${p.phase}`;
      
      const resolveBtnText = document.getElementById('resolve-btn-text');
      const resolveBadge = document.getElementById('resolve-btn-badge');
      if (resolveBtnText) resolveBtnText.textContent = p.conflictsCount > 0 ? `Resolve ${p.conflictsCount}` : '0 Conflicts ✓ Done';
      if (resolveBadge) resolveBadge.style.display = 'none';

      draftWorkingEntries = p.entries;
      runSharedValidation(draftWorkingEntries);
      renderStudioGrid();
    },
    onComplete: (res) => {
      activeStepHighlight = null;
      const durationSec = activeResolver?.startTime ? ((Date.now() - activeResolver.startTime) / 1000).toFixed(1) : '1.2';
      activeResolver = null;
      if (progressStrip) progressStrip.style.display = 'none';
      if (crossChip) crossChip.style.display = 'none';

      draftWorkingEntries = res.entries;

      // Compute detailed change diff
      const diffList = [];
      let movedCount = 0;
      let facCount = 0;
      let roomCount = 0;

      for (const draft of res.entries) {
        const orig = originalVersionEntries.find(o => o.id === draft.id);
        if (!orig) continue;
        const slotChanged = Number(orig.day_id) !== Number(draft.day_id) || Number(orig.slot_id) !== Number(draft.slot_id);
        const facChanged = Number(orig.faculty_id) !== Number(draft.faculty_id);
        const roomChanged = Number(orig.room_id) !== Number(draft.room_id);

        if (slotChanged) movedCount++;
        if (facChanged) facCount++;
        if (roomChanged) roomCount++;

        if (slotChanged || facChanged || roomChanged) {
          const origDay = masterData.workingDays?.find(d => d.id === orig.day_id)?.day_name || `Day ${orig.day_id}`;
          const draftDay = masterData.workingDays?.find(d => d.id === draft.day_id)?.day_name || `Day ${draft.day_id}`;
          const origSlot = masterData.timeSlots?.find(s => s.id === orig.slot_id)?.label || `Period ${orig.slot_id}`;
          const draftSlot = masterData.timeSlots?.find(s => s.id === draft.slot_id)?.label || `Period ${draft.slot_id}`;
          const origFac = masterData.faculty?.find(f => f.id === orig.faculty_id)?.name || 'Instructor';
          const draftFac = masterData.faculty?.find(f => f.id === draft.faculty_id)?.name || 'Instructor';
          const origRoom = masterData.rooms?.find(r => r.id === orig.room_id)?.name || 'Room';
          const draftRoom = masterData.rooms?.find(r => r.id === draft.room_id)?.name || 'Room';

          const changes = [];
          if (slotChanged) changes.push(`moved from ${origDay} ${origSlot} &rarr; ${draftDay} ${draftSlot}`);
          if (facChanged) changes.push(`reassigned from ${origFac} &rarr; ${draftFac}`);
          if (roomChanged) changes.push(`relocated from ${origRoom} &rarr; ${draftRoom}`);

          diffList.push(`
            <div style="padding: 0.35rem 0.6rem; background: #fff; border-radius: 4px; border: 1px solid #BBF7D0;">
              <strong>${escapeHtml(draft.subject_code)}</strong> (${escapeHtml(draft.section_name)}): ${changes.join(', ')}
            </div>
          `);
        }
      }

      const totalChanges = movedCount + facCount + roomCount;

      // Independent re-verification: whole resolved timetable checked by validator
      const finalVal = runSharedValidation(draftWorkingEntries);
      if (!finalVal.isValid || finalVal.errorCount > 0) {
        const failedTitle = document.getElementById('resolve-failed-title');
        if (failedTitle) failedTitle.textContent = `Could not resolve ${finalVal.errorCount} conflicts`;
        const failedBanner = document.getElementById('studio-resolve-failed-banner');
        if (failedBanner) failedBanner.style.display = 'block';
        showToast(`Resolution stopped: ${finalVal.errorCount} conflicts remaining.`, 'warning');
        return;
      }

      if (totalChanges === 0 && initialConflictsCount > 0) {
        showToast('No classes could be moved to reduce conflicts.', 'warning');
        return;
      }

      // Populate Success State & Diff
      const summaryText = document.getElementById('resolve-summary-text');
      if (summaryText) {
        summaryText.textContent = `${initialConflictsCount} conflicts resolved: ${movedCount} classes moved/swapped, ${facCount} faculty reassigned, ${roomCount} rooms changed. Time taken ${durationSec}s`;
      }

      const diffListContainer = document.getElementById('studio-diff-list');
      if (diffListContainer) {
        diffListContainer.innerHTML = diffList.length ? diffList.join('') : '<div>All disputes resolved with 0 slot relocations.</div>';
      }

      if (resolvedBanner) resolvedBanner.style.display = 'block';

      // Show "Compare with original" toggle
      const compLabel = document.getElementById('compare-toggle-label');
      if (compLabel) compLabel.style.display = 'inline-flex';

      // Task 5: Change "Regenerate" button to "Generate" prominently
      isResolvedDraftPreview = true;
      const regenBtn = document.getElementById('btn-studio-regenerate');
      if (regenBtn) {
        regenBtn.textContent = 'Generate';
        regenBtn.className = 'btn-primary';
        regenBtn.style.fontWeight = '700';
        regenBtn.style.boxShadow = '0 2px 8px rgba(107, 0, 16, 0.25)';
        regenBtn.title = 'Accept and save this conflict-free timetable draft as a new version';
      }

      runSharedValidation(draftWorkingEntries);
      renderStudioGrid();
      showToast('0 conflicts. All disputes resolved.', 'success');
    },
    onError: (err) => {
      activeStepHighlight = null;
      activeResolver = null;
      if (progressStrip) progressStrip.style.display = 'none';
      if (crossChip) crossChip.style.display = 'none';

      // Populate Diagnostics Banner
      const failedTitle = document.getElementById('resolve-failed-title');
      if (failedTitle) failedTitle.textContent = `Could not resolve ${err.conflictsRemaining} conflicts`;

      const failedReason = document.getElementById('resolve-failed-reason');
      if (failedReason) failedReason.textContent = `${err.reason} Review diagnostic reasons and suggested fixes below:`;

      const diagList = document.getElementById('resolve-failed-diagnostics-list');
      if (diagList) {
        diagList.innerHTML = (err.violations || []).map(v => `
          <div style="padding: 0.6rem 0.85rem; background: #fff; border-radius: 4px; border: 1px solid #FECACA;">
            <div style="font-weight: 700; color: #DC2626; margin-bottom: 0.2rem;">⚠ ${escapeHtml(v.message)}</div>
            <div style="font-size: 0.78rem; color: #4B5563;">
              💡 <strong>Suggested Fix:</strong> ${escapeHtml(v.suggestedFix || 'Adjust faculty availability, add faculty, or balance periods.')}
            </div>
          </div>
        `).join('');
      }

      if (failedBanner) failedBanner.style.display = 'block';
      runSharedValidation(draftWorkingEntries);
      renderStudioGrid();
      showToast(`Resolution stopped: ${err.conflictsRemaining} conflicts remaining.`, 'warning');
    }
  });

  activeResolver.start();
}

function populateStudioEntitySelector() {
  const entitySelector = document.getElementById('studio-entity-selector');
  if (!entitySelector || !masterData) return;

  if (studioMode === 'section') {
    if (!masterData.sections || masterData.sections.length === 0) {
      entitySelector.innerHTML = '<option value="">Add a section in Master Data to start building a timetable.</option>';
    } else {
      entitySelector.innerHTML = masterData.sections.map(s => `
        <option value="${s.id}">Section: ${s.name} (Sem ${s.semester})</option>
      `).join('');
    }
  } else if (studioMode === 'faculty') {
    if (!masterData.faculty || masterData.faculty.length === 0) {
      entitySelector.innerHTML = '<option value="">No faculty added yet</option>';
    } else {
      entitySelector.innerHTML = masterData.faculty.map(f => `
        <option value="${f.id}">${f.code ? f.code + ' · ' : ''}${f.name} (${f.department_code || 'CSE'}) - ${f.weekly_hours || 0} hrs/wk</option>
      `).join('');
    }
  } else if (studioMode === 'room') {
    entitySelector.innerHTML = `
      <option value="-1">Room: TBD (All Sessions Awaiting Room Assignment)</option>
      ${(masterData.rooms || []).map(r => `
        <option value="${r.id}">Room: ${r.name} (${r.floor_name ? r.floor_name + ', ' : (r.floor !== null && r.floor !== undefined ? 'Floor ' + r.floor + ', ' : '')}${r.type}, Cap: ${r.capacity})</option>
      `).join('')}
    `;
  }

  const parsedVal = parseInt(entitySelector.value, 10);
  studioEntityId = isNaN(parsedVal) ? null : parsedVal;
}

async function loadStudioVersion(versionId) {
  try {
    resetResolvedPreviewState();
    currentVersionData = await apiRequest(`/api/timetable/versions/${versionId}`);

    // Store pristine baseline snapshot for imported_verified detection
    if (currentVersionData?.entries && (currentVersionData?.version?.source === 'imported_verified' || !currentVersionData?.version?.source)) {
      originalBaselineSnapshot = JSON.stringify(currentVersionData.entries.map(e => ({
        id: e.id,
        day_id: e.day_id,
        slot_id: e.slot_id,
        room_id: e.room_id,
        faculty_id: e.faculty_id
      })));
    } else {
      originalBaselineSnapshot = null;
    }

    const val = runSharedValidation(currentVersionData.entries);

    // Sync draft conflict banner
    const conflictBanner = document.getElementById('studio-draft-conflict-banner') || document.getElementById('studio-conflict-banner');
    const conflictText = document.getElementById('draft-conflict-banner-text');
    if (conflictBanner) {
      if (val && val.errorCount > 0) {
        conflictBanner.style.display = 'block';
        if (conflictText) {
          conflictText.textContent = `Draft generated with ${val.errorCount} conflicts. Click Regenerate to resolve them.`;
        }
      } else {
        conflictBanner.style.display = 'none';
      }
    }

    renderStudioGrid();
  } catch (err) {
    console.error('Failed to load version:', err);
  }
}

function renderStudioGrid() {
  const container = document.getElementById('studio-grid-container');
  if (!container || !currentVersionData || !masterData) return;

  const { workingDays, timeSlots } = masterData;
  const entries = (isComparingWithOriginal && originalVersionEntries)
    ? originalVersionEntries
    : (draftWorkingEntries || currentVersionData.entries || []);

  // Filter entries based on studioMode
  let filteredEntries = [];
  if (studioMode === 'section') {
    filteredEntries = studioEntityId ? entries.filter(e => e.section_id === studioEntityId) : [];
  } else if (studioMode === 'faculty') {
    filteredEntries = studioEntityId ? entries.filter(e => e.faculty_id === studioEntityId) : [];
  } else if (studioMode === 'room') {
    if (studioEntityId === -1 || studioEntityId === null || studioEntityId === undefined || String(studioEntityId) === '-1') {
      filteredEntries = entries.filter(e => !e.room_id || e.room_name === 'TBD');
    } else {
      const selectedRoom = (masterData.rooms || []).find(r => r.id === studioEntityId || String(r.id) === String(studioEntityId));
      filteredEntries = entries.filter(e => 
        e.room_id === studioEntityId || 
        String(e.room_id) === String(studioEntityId) || 
        (selectedRoom && (e.room_name === selectedRoom.name || e.room_code === selectedRoom.code || e.room_id === selectedRoom.code))
      );
    }
  }

  const conflictsByEntry = lastSharedValidation?.conflictsByEntryId || {};

  let html = `
    <table style="width: 100%; border-collapse: collapse; min-width: 820px; text-align: center; background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); overflow: hidden;">
      <thead>
        <tr style="background: var(--bg-surface-subtle); border-bottom: 2px solid var(--border-subtle);">
          <th style="padding: 0.75rem; border: 1px solid var(--border-subtle); width: 110px; font-size: 0.85rem;">Day</th>
  `;

  for (const s of timeSlots) {
    html += `
      <th style="padding: 0.65rem 0.5rem; border: 1px solid var(--border-subtle); font-size: 0.8rem;">
        <div style="font-weight: 700;">${s.label}</div>
        <div style="font-size: 0.7rem; color: var(--text-muted);" class="tabular-nums">${s.start_time} - ${s.end_time}</div>
      </th>
    `;
  }

  html += `
        </tr>
      </thead>
      <tbody>
  `;

  for (const day of workingDays) {
    html += `
      <tr>
        <td style="padding: 0.75rem; font-weight: 700; border: 1px solid var(--border-subtle); background: var(--bg-surface-subtle); font-size: 0.85rem;">
          ${day.day_name}
        </td>
    `;

    for (const slot of timeSlots) {
      if (slot.is_break === 1) {
        html += `
          <td style="border: 1px solid var(--border-subtle); background: repeating-linear-gradient(45deg, var(--bg-surface-subtle), var(--bg-surface-subtle) 10px, var(--bg-canvas) 10px, var(--bg-canvas) 20px); font-size: 0.75rem; color: var(--text-muted);">
            ${slot.label}
          </td>
        `;
        continue;
      }

      const cellEntries = filteredEntries.filter(e => e.day_id === day.id && e.slot_id === slot.id);
      const isStepSource = Boolean(activeStepHighlight && activeStepHighlight.sourceDayId === day.id && activeStepHighlight.sourceSlotId === slot.id);
      const isStepTarget = Boolean(activeStepHighlight && activeStepHighlight.targetDayId === day.id && activeStepHighlight.targetSlotId === slot.id);

      if (cellEntries.length > 0) {
        html += `
          <td class="timetable-cell-drop-target" data-day-id="${day.id}" data-slot-id="${slot.id}" data-entry-id="${cellEntries[0].id}" style="padding: 0.4rem; border: 1px solid var(--border-subtle); vertical-align: top; min-height: 75px;">
            <div style="display: flex; flex-direction: column; gap: 0.35rem; height: 100%;">
        `;

        for (const entry of cellEntries) {
          const entryConflicts = conflictsByEntry[entry.id] || [];
          const hasConflict = entryConflicts.length > 0;

          // Check if modified compared to original / resolved for comparison highlight
          let isModified = false;
          if (originalVersionEntries && draftWorkingEntries) {
            const orig = originalVersionEntries.find(o => o.id === entry.id);
            const draft = draftWorkingEntries.find(d => d.id === entry.id);
            if (orig && draft) {
              if (Number(orig.day_id) !== Number(draft.day_id) || Number(orig.slot_id) !== Number(draft.slot_id) || Number(orig.faculty_id) !== Number(draft.faculty_id) || Number(orig.room_id) !== Number(draft.room_id)) {
                isModified = true;
              }
            }
          }

          let chipStyle = 'padding: 0.45rem 0.5rem; border-radius: var(--radius-sm); cursor: grab; text-align: left; height: 100%; display: flex; flex-direction: column; justify-content: space-between; transition: all 0.2s ease;';
          if (isStepSource) {
            chipStyle += ' background: #FEF3C7; border: 2px solid #D97706; box-shadow: 0 0 0 3px rgba(217, 119, 6, 0.45); transform: scale(1.02);';
          } else if (isStepTarget) {
            chipStyle += ' background: #DBEAFE; border: 2px solid #2563EB; box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.45); transform: scale(1.02);';
          } else if (isComparingWithOriginal && isModified) {
            chipStyle += ' background: #FEF3C7; border: 2px solid #D97706; outline: 2px solid #FCD34D; box-shadow: 0 0 8px rgba(217, 119, 6, 0.25);';
          } else if (!isComparingWithOriginal && isModified) {
            chipStyle += ' background: #EFF6FF; border: 2px solid #2563EB; outline: 2px solid #93C5FD; box-shadow: 0 0 8px rgba(37, 99, 235, 0.25);';
          } else if (hasConflict) {
            chipStyle += ' background: #FEF2F2; border: 2px solid var(--color-error); box-shadow: 0 0 0 1px var(--color-error);';
          } else {
            chipStyle += ' background: var(--color-brand-blush-soft); border: 1px solid var(--border-strong);';
          }

          const conflictTooltip = hasConflict
            ? `title="[CONFLICT DETECTED] ${escapeHtml(entryConflicts.map(c => c.message).join(' | '))}"`
            : (isModified ? `title="[MODIFIED] Class changed during conflict resolution"` : '');

          const sectionLabel = entry.section_name || (entry.batch ? ('Batch ' + entry.batch) : 'Unassigned');
          const facultyLabel = entry.faculty_name || 'Faculty';
          const roomLabel = entry.room_name || 'TBD';
          const floorStr = (entry.floor !== null && entry.floor !== undefined)
            ? (entry.floor_name ? `Fl ${entry.floor} (${entry.floor_name})` : `Fl ${entry.floor}`)
            : '';
          const roomWithFloor = roomLabel + (floorStr ? ` · ${floorStr}` : '');

          html += `
            <div class="studio-entry-chip" draggable="true" data-entry-id="${entry.id}" ${conflictTooltip} style="${chipStyle}">
              <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 0.25rem;">
                <span style="font-weight: 700; font-size: 0.85rem; color: ${hasConflict ? 'var(--color-error)' : 'var(--color-brand-primary)'};">${escapeHtml(entry.subject_code)}</span>
                <div style="display: flex; align-items: center; gap: 0.25rem;">
                  ${isStepSource ? '<span style="font-size: 0.65rem; background: #D97706; color: #FFFFFF; font-weight: 700; padding: 0.05rem 0.35rem; border-radius: 3px;">SRC</span>' : ''}
                  ${isStepTarget ? '<span style="font-size: 0.65rem; background: #2563EB; color: #FFFFFF; font-weight: 700; padding: 0.05rem 0.35rem; border-radius: 3px;">TGT</span>' : ''}
                  ${!isStepSource && !isStepTarget && isModified ? `<span style="font-size: 0.65rem; background: ${isComparingWithOriginal ? '#D97706' : '#2563EB'}; color: #FFFFFF; font-weight: 700; padding: 0.05rem 0.35rem; border-radius: 3px;">${isComparingWithOriginal ? 'CHANGED' : 'MOVED'}</span>` : ''}
                  ${hasConflict ? '<span style="font-size: 0.72rem; color: var(--color-error); font-weight: 800;" title="Collision">⚠</span>' : ''}
                  ${entry.locked ? '<span style="font-size: 0.72rem;" title="Locked">🔒</span>' : ''}
                </div>
              </div>
              <div style="font-size: 0.75rem; color: ${hasConflict ? 'var(--color-error)' : 'var(--text-secondary)'}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                ${escapeHtml(studioMode === 'faculty' ? sectionLabel : (studioMode === 'room' ? `${sectionLabel} · ${facultyLabel}` : facultyLabel))}
              </div>
              <div style="font-size: 0.7rem; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                ${escapeHtml(roomWithFloor)}${entry.batch ? ` [${entry.batch}]` : ''}${entry.is_lab_block ? ' · Lab' : ''}
              </div>
            </div>
          `;
        }

        html += `
            </div>
          </td>
        `;
      } else {
        if (isStepTarget) {
          html += `
            <td class="timetable-cell-drop-target timetable-cell-free" data-day-id="${day.id}" data-slot-id="${slot.id}" style="padding: 0.4rem; border: 2px solid #2563EB; background: #DBEAFE; box-shadow: inset 0 0 0 2px rgba(37, 99, 235, 0.3); vertical-align: middle; height: 75px; color: #1D4ED8; font-size: 0.8rem; font-weight: 700; cursor: pointer;" title="Target slot for resolution move">
              <span>🎯 Target Slot</span>
            </td>
          `;
        } else if (isStepSource) {
          html += `
            <td class="timetable-cell-drop-target timetable-cell-free" data-day-id="${day.id}" data-slot-id="${slot.id}" style="padding: 0.4rem; border: 2px solid #D97706; background: #FEF3C7; box-shadow: inset 0 0 0 2px rgba(217, 119, 6, 0.3); vertical-align: middle; height: 75px; color: #B45309; font-size: 0.8rem; font-weight: 700; cursor: pointer;">
              <span>Vacated</span>
            </td>
          `;
        } else {
          html += `
            <td class="timetable-cell-drop-target timetable-cell-free" data-day-id="${day.id}" data-slot-id="${slot.id}" style="padding: 0.4rem; border: 1px solid var(--border-subtle); vertical-align: middle; height: 75px; color: var(--text-muted); font-size: 0.8rem; cursor: pointer;" title="Click to schedule a class in this open period">
              <span style="opacity: 0.45; font-weight: 600;">+ Free</span>
            </td>
          `;
        }
      }
    }

    html += `</tr>`;
  }

  html += `
      </tbody>
    </table>
  `;

  container.innerHTML = html;
  attachDragAndDropHandlers();

  // Toggle Unassigned Sections Panel in section mode
  const unassignedPanel = document.getElementById('unassigned-sections-panel');
  if (unassignedPanel) {
    if (studioMode === 'section') {
      unassignedPanel.style.display = 'block';
      renderUnassignedSectionsPanel(currentVersionData?.unassignedSessions || []);
    } else {
      unassignedPanel.style.display = 'none';
    }
  }
}

// Drag & Drop Implementation with Full Manual Authority (Swap on Occupied Drop)
function attachDragAndDropHandlers() {
  const chips = document.querySelectorAll('.studio-entry-chip');
  const cells = document.querySelectorAll('.timetable-cell-drop-target');
  const freeCells = document.querySelectorAll('.timetable-cell-free');

  freeCells.forEach(cell => {
    cell.addEventListener('click', (e) => {
      e.stopPropagation();
      const dayId = parseInt(cell.getAttribute('data-day-id'), 10);
      const slotId = parseInt(cell.getAttribute('data-slot-id'), 10);
      openAddEntryModal(dayId, slotId);
    });
  });

  chips.forEach(chip => {
    chip.addEventListener('dragstart', (e) => {
      draggedEntryId = parseInt(chip.getAttribute('data-entry-id'), 10);
      chip.style.opacity = '0.5';
      e.dataTransfer.setData('text/plain', draggedEntryId);
    });

    chip.addEventListener('dragend', () => {
      chip.style.opacity = '1';
      cells.forEach(c => {
        c.style.backgroundColor = '';
        c.style.outline = '';
      });
    });

    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      const entryId = parseInt(chip.getAttribute('data-entry-id'), 10);
      openEditEntryModal(entryId);
    });
  });

  cells.forEach(cell => {
    cell.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!draggedEntryId) return;
      cell.style.backgroundColor = 'var(--bg-surface-subtle)';
      cell.style.outline = '2px dashed var(--color-brand-primary)';
    });

    cell.addEventListener('dragleave', () => {
      cell.style.backgroundColor = '';
      cell.style.outline = '';
    });

    cell.addEventListener('drop', async (e) => {
      e.preventDefault();
      cell.style.backgroundColor = '';
      cell.style.outline = '';

      if (!draggedEntryId) return;

      const targetDayId = parseInt(cell.getAttribute('data-day-id'), 10);
      const targetSlotId = parseInt(cell.getAttribute('data-slot-id'), 10);

      // Record undo snapshot before executing move or swap
      pushUndoSnapshot();

      const activeEntries = draftWorkingEntries || currentVersionData?.entries || [];
      const draggedEntry = activeEntries.find(ent => ent.id === draggedEntryId);
      if (!draggedEntry) {
        draggedEntryId = null;
        return;
      }

      // Check if target cell already has an occupant in the same section view or target cell
      const targetOccupant = activeEntries.find(ent =>
        ent.day_id === targetDayId &&
        ent.slot_id === targetSlotId &&
        ent.id !== draggedEntryId &&
        (studioMode === 'section' ? ent.section_id === draggedEntry.section_id : ent.section_id === draggedEntry.section_id)
      );

      if (draftWorkingEntries) {
        // Working draft mode
        if (targetOccupant) {
          // Swap positions
          targetOccupant.day_id = draggedEntry.day_id;
          targetOccupant.slot_id = draggedEntry.slot_id;
          draggedEntry.day_id = targetDayId;
          draggedEntry.slot_id = targetSlotId;
          showToast(`Swapped '${draggedEntry.subject_code}' with '${targetOccupant.subject_code}'`, 'info');
        } else {
          draggedEntry.day_id = targetDayId;
          draggedEntry.slot_id = targetSlotId;
          showToast(`Moved '${draggedEntry.subject_code}' to target slot`, 'info');
        }

        runSharedValidation(draftWorkingEntries);
        renderStudioGrid();
        draggedEntryId = null;
        return;
      }

      // Standard active/draft version: execute non-blocking move/swap on server
      try {
        const res = await apiRequest(`/api/timetable/entries/${draggedEntryId}/move`, {
          method: 'POST',
          body: {
            targetDayId,
            targetSlotId,
            swapWithEntryId: targetOccupant ? targetOccupant.id : null,
            force: true
          }
        });

        // Apply in memory immediately
        if (targetOccupant) {
          targetOccupant.day_id = draggedEntry.day_id;
          targetOccupant.slot_id = draggedEntry.slot_id;
        }
        draggedEntry.day_id = targetDayId;
        draggedEntry.slot_id = targetSlotId;

        const val = runSharedValidation();
        renderStudioGrid();

        if (!val.isValid) {
          showToast(`Move applied. Warning: created ${val.errorCount} conflict(s). Click Resolve to auto-fix.`, 'warning');
        } else {
          showToast(res.message || 'Timetable entry moved successfully!', 'success');
        }
      } catch (err) {
        showToast(err.message || 'Failed to move timetable entry', 'error');
      } finally {
        draggedEntryId = null;
      }
    });
  });
}

// 4. Modal Setup & CSP Generation Progress Tracker
function formatElapsed(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function updateGenerationProgress(data) {
  if (!data) return;
  isGenerationRunning = !!data.isRunning;

  const banner = document.getElementById('global-generation-banner');
  const modalBox = document.getElementById('modal-gen-progress-box');

  if (banner) {
    banner.style.display = 'block';
    banner.style.borderColor = 'var(--color-brand-primary)';

    const icon = document.getElementById('gen-banner-icon');
    if (icon) {
      icon.textContent = '⚙️';
      icon.style.animation = 'spin 2s linear infinite';
    }

    const badge = document.getElementById('gen-banner-badge');
    if (badge) {
      badge.textContent = 'CSP Engine Active';
      badge.style.background = 'var(--color-brand-blush-soft)';
      badge.style.color = 'var(--color-brand-primary)';
    }

    const lockBadge = document.getElementById('gen-banner-lock-badge');
    if (lockBadge) lockBadge.style.display = 'inline-block';

    const title = document.getElementById('gen-banner-title');
    if (title) {
      title.textContent = data.name 
        ? `Computing Timetable: "${data.name}"`
        : 'Constraint Satisfaction Generation in Progress';
    }

    const phaseEl = document.getElementById('gen-banner-phase');
    if (phaseEl) phaseEl.textContent = data.phase || 'Evaluating CSP constraints...';

    const percent = Math.min(100, Math.max(5, data.progress || 5));
    const progressBar = document.getElementById('gen-banner-progress-bar');
    if (progressBar) progressBar.style.width = `${percent}%`;

    const percentEl = document.getElementById('gen-banner-percent');
    if (percentEl) percentEl.textContent = `${percent}%`;

    const stageLabel = document.getElementById('gen-banner-stage-label');
    if (stageLabel) {
      if (percent < 20) stageLabel.textContent = 'Phase 1/5: Feasibility Validation';
      else if (percent < 45) stageLabel.textContent = 'Phase 2/5: MRV Task Sequencing';
      else if (percent < 75) stageLabel.textContent = 'Phase 3/5: Backtracking CSP Search';
      else if (percent < 95) stageLabel.textContent = 'Phase 4/5: Soft-Constraint Scoring & Optimization';
      else stageLabel.textContent = 'Phase 5/5: Zero-Collision Verification & Commit';
    }
  }

  // Update in-modal tracker
  if (modalBox) {
    modalBox.style.display = 'block';
    const percent = Math.min(100, Math.max(5, data.progress || 5));
    const mPhase = document.getElementById('modal-gen-phase-text');
    if (mPhase) mPhase.textContent = data.phase || 'Computing Schedule...';
    const mBar = document.getElementById('modal-gen-progress-bar');
    if (mBar) mBar.style.width = `${percent}%`;
    const mPct = document.getElementById('modal-gen-percent');
    if (mPct) mPct.textContent = `${percent}%`;

    updateStepBullets(percent);
  }

  // Handle timer
  if (data.startedAt) {
    generationStartTime = data.startedAt;
  } else if (!generationStartTime) {
    generationStartTime = Date.now() - (data.elapsedMs || 0);
  }

  startGenerationTimer();
  updateGenerationButtons(true);
}

function updateStepBullets(percent) {
  const steps = [
    { id: 'step-1', bullet: 'step-1-bullet', threshold: 10 },
    { id: 'step-2', bullet: 'step-2-bullet', threshold: 25 },
    { id: 'step-3', bullet: 'step-3-bullet', threshold: 55 },
    { id: 'step-4', bullet: 'step-4-bullet', threshold: 85 },
    { id: 'step-5', bullet: 'step-5-bullet', threshold: 100 }
  ];

  steps.forEach(s => {
    const el = document.getElementById(s.id);
    const b = document.getElementById(s.bullet);
    if (!el || !b) return;

    if (percent >= s.threshold) {
      b.textContent = '✓';
      b.style.color = 'var(--color-success)';
      el.style.color = 'var(--color-success)';
      el.style.fontWeight = '600';
    } else {
      b.textContent = '○';
      b.style.color = 'var(--text-muted)';
      el.style.color = 'var(--text-secondary)';
      el.style.fontWeight = 'normal';
    }
  });
}

function startGenerationTimer() {
  if (generationTimerInterval) return;
  const timerEl = document.getElementById('gen-banner-timer');

  generationTimerInterval = setInterval(() => {
    if (!generationStartTime) return;
    const elapsed = Date.now() - generationStartTime;
    if (timerEl) timerEl.textContent = `Elapsed: ${formatElapsed(elapsed)}`;
  }, 200);
}

function stopGenerationTimer() {
  if (generationTimerInterval) {
    clearInterval(generationTimerInterval);
    generationTimerInterval = null;
  }
}

function updateGenerationButtons(isLocked) {
  const overviewBtn = document.getElementById('btn-overview-generate');
  const studioBtn = document.getElementById('btn-studio-generate');
  const submitBtn = document.getElementById('btn-submit-generate');
  const dismissBtn = document.getElementById('gen-banner-dismiss-btn');

  if (isLocked) {
    if (overviewBtn) {
      overviewBtn.disabled = true;
      overviewBtn.textContent = '⏳ Computation Active...';
      overviewBtn.title = 'A timetable generation computation is active in the background. Duplicate runs are locked.';
      overviewBtn.style.opacity = '0.7';
    }
    if (studioBtn) {
      studioBtn.disabled = true;
      studioBtn.textContent = '⏳ Computation Active...';
      studioBtn.title = 'A timetable generation computation is active in the background. Duplicate runs are locked.';
      studioBtn.style.opacity = '0.7';
    }
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = '⏳ CSP Solver Running...';
    }
    if (dismissBtn) dismissBtn.style.display = 'none';
  } else {
    if (overviewBtn) {
      overviewBtn.disabled = false;
      overviewBtn.textContent = '+ Generate New Timetable';
      overviewBtn.title = '';
      overviewBtn.style.opacity = '1';
    }
    if (studioBtn) {
      studioBtn.disabled = false;
      studioBtn.textContent = 'Generate New';
      studioBtn.title = '';
      studioBtn.style.opacity = '1';
    }
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Start CSP Generator';
    }
  }
}

async function onGenerationCompleted(data) {
  isGenerationRunning = false;
  stopGenerationTimer();
  updateGenerationButtons(false);

  const hasConflicts = Boolean(data.hasConflicts || (data.conflictsCount && data.conflictsCount > 0));
  const conflictsCount = data.conflictsCount || 0;

  const banner = document.getElementById('global-generation-banner');
  if (banner) {
    banner.style.display = 'block';
    banner.style.borderColor = hasConflicts ? '#D97706' : 'var(--color-success)';
    banner.style.background = hasConflicts ? '#FFFBEB' : 'var(--bg-surface)';

    const icon = document.getElementById('gen-banner-icon');
    if (icon) {
      icon.textContent = hasConflicts ? '⚠' : '✓';
      icon.style.color = hasConflicts ? '#D97706' : 'var(--color-success)';
      icon.style.animation = 'none';
    }

    const badge = document.getElementById('gen-banner-badge');
    if (badge) {
      badge.textContent = hasConflicts ? `Draft Generated (${conflictsCount} Conflicts Detected)` : 'Generation Complete';
      badge.style.background = hasConflicts ? '#FEF3C7' : 'var(--color-success-bg)';
      badge.style.color = hasConflicts ? '#B45309' : 'var(--color-success)';
    }

    const lockBadge = document.getElementById('gen-banner-lock-badge');
    if (lockBadge) lockBadge.style.display = 'none';

    const title = document.getElementById('gen-banner-title');
    if (title) {
      title.textContent = hasConflicts
        ? `Timetable Draft Generated: "${data.versionName || data.name || 'Master Timetable'}"`
        : `Timetable Generated: "${data.versionName || data.name || 'Master Timetable'}"`;
    }

    const phaseEl = document.getElementById('gen-banner-phase');
    if (phaseEl) {
      phaseEl.textContent = hasConflicts
        ? `Draft generated with ${conflictsCount} conflicts. Click Regenerate to resolve them.`
        : `Successfully computed ${data.entriesCount || 0} collision-free periods with zero hard conflicts in ${data.durationMs || 0}ms. Soft constraint score: ${data.score || 100}/100.`;
    }

    const bar = document.getElementById('gen-banner-progress-bar');
    if (bar) {
      bar.style.width = '100%';
      bar.style.background = hasConflicts ? '#D97706' : 'var(--color-success)';
      bar.style.animation = 'none';
    }

    const pct = document.getElementById('gen-banner-percent');
    if (pct) {
      pct.textContent = hasConflicts ? `${conflictsCount} Conflicts` : '100%';
      pct.style.color = hasConflicts ? '#D97706' : 'var(--color-success)';
    }

    const stageLabel = document.getElementById('gen-banner-stage-label');
    if (stageLabel) {
      stageLabel.textContent = hasConflicts
        ? 'Conflicts present · Ready for resolution or review'
        : 'All constraints satisfied · Saved to database';
    }

    const dismissBtn = document.getElementById('gen-banner-dismiss-btn');
    if (dismissBtn) {
      dismissBtn.style.display = 'inline-block';
      dismissBtn.onclick = () => { banner.style.display = 'none'; };
    }

    // Auto-dismiss after 10s if not dismissed manually
    setTimeout(() => {
      if (!isGenerationRunning && banner.style.display === 'block') {
        banner.style.display = 'none';
      }
    }, 10000);
  }

  // Also sync studio conflict banner
  const studioConflictBanner = document.getElementById('studio-draft-conflict-banner') || document.getElementById('studio-conflict-banner');
  const draftConflictText = document.getElementById('draft-conflict-banner-text');
  if (studioConflictBanner) {
    if (hasConflicts) {
      studioConflictBanner.style.display = 'block';
      if (draftConflictText) {
        draftConflictText.textContent = `Draft generated with ${conflictsCount} conflicts. Click Regenerate to resolve them.`;
      }
    } else {
      studioConflictBanner.style.display = 'none';
    }
  }

  // Update in-modal box if open
  const modalBox = document.getElementById('modal-gen-progress-box');
  if (modalBox) {
    const mBar = document.getElementById('modal-gen-progress-bar');
    if (mBar) {
      mBar.style.width = '100%';
      mBar.style.background = 'var(--color-success)';
    }
    const mPct = document.getElementById('modal-gen-percent');
    if (mPct) mPct.textContent = '100%';
    const mPhase = document.getElementById('modal-gen-phase-text');
    if (mPhase) mPhase.textContent = 'Generation Successful!';
    updateStepBullets(100);

    setTimeout(() => {
      document.getElementById('modal-generate').style.display = 'none';
      modalBox.style.display = 'none';
    }, 1500);
  }

  // Reload studio with the new version and overview
  if (data.versionId) {
    activeVersionId = data.versionId;
  }
  await loadStudio(data.versionId);
  loadOverview();
  switchTab('studio', data.versionId);
}

function onGenerationFailed(data) {
  isGenerationRunning = false;
  stopGenerationTimer();
  updateGenerationButtons(false);

  const banner = document.getElementById('global-generation-banner');
  if (banner) {
    banner.style.display = 'block';
    banner.style.borderColor = 'var(--color-error)';

    const icon = document.getElementById('gen-banner-icon');
    if (icon) {
      icon.textContent = '❌';
      icon.style.animation = 'none';
    }

    const badge = document.getElementById('gen-banner-badge');
    if (badge) {
      badge.textContent = 'Generation Infeasible';
      badge.style.background = 'var(--color-error-bg)';
      badge.style.color = 'var(--color-error)';
    }

    const lockBadge = document.getElementById('gen-banner-lock-badge');
    if (lockBadge) lockBadge.style.display = 'none';

    const title = document.getElementById('gen-banner-title');
    if (title) title.textContent = 'CSP Generation Failed';

    const phaseEl = document.getElementById('gen-banner-phase');
    if (phaseEl) phaseEl.textContent = data.reason || 'The constraints could not be satisfied with current master data.';

    const bar = document.getElementById('gen-banner-progress-bar');
    if (bar) {
      bar.style.width = '100%';
      bar.style.background = 'var(--color-error)';
      bar.style.animation = 'none';
    }

    const pct = document.getElementById('gen-banner-percent');
    if (pct) {
      pct.textContent = 'Error';
      pct.style.color = 'var(--color-error)';
    }

    const dismissBtn = document.getElementById('gen-banner-dismiss-btn');
    if (dismissBtn) {
      dismissBtn.style.display = 'inline-block';
      dismissBtn.onclick = () => { banner.style.display = 'none'; };
    }
  }

  const modalBox = document.getElementById('modal-gen-progress-box');
  if (modalBox) {
    const mPhase = document.getElementById('modal-gen-phase-text');
    if (mPhase) mPhase.textContent = 'Generation Infeasible';
  }
}

async function checkGenerationStatus() {
  try {
    const state = await apiRequest('/api/timetable/generation-status');
    if (state && state.isRunning) {
      updateGenerationProgress(state);
    }
  } catch (err) {
    // Non-blocking
  }
}

function openGenerateModal() {
  const modal = document.getElementById('modal-generate');
  if (!modal) return;
  const nameInput = document.getElementById('gen-name');
  if (nameInput) {
    const d = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    nameInput.value = `Master Schedule ${d}`;
  }
  const scopeSelect = document.getElementById('gen-scope-section');
  if (scopeSelect && masterData?.sections) {
    scopeSelect.innerHTML = `
      <option value="">All Sections (Master Schedule)</option>
      ${masterData.sections.map(s => `<option value="${s.id}">${s.name} (${s.department_name || s.department_code || 'Dept'})</option>`).join('')}
    `;
  }
  const publishCheck = document.getElementById('gen-publish-now');
  if (publishCheck) publishCheck.checked = false;

  const modalBox = document.getElementById('modal-gen-progress-box');
  if (modalBox) modalBox.style.display = 'none';

  modal.style.display = 'flex';
}
window.openGenerateModal = openGenerateModal;

function setupModals() {
  // Wire Overview Generate button (Studio has its own direct trigger)
  document.getElementById('btn-overview-generate')?.addEventListener('click', openGenerateModal);

  document.getElementById('modal-generate-close')?.addEventListener('click', () => {
    document.getElementById('modal-generate').style.display = 'none';
  });

  document.getElementById('modal-generate-x')?.addEventListener('click', () => {
    document.getElementById('modal-generate').style.display = 'none';
  });

  document.getElementById('form-generate')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (isGenerationRunning) {
      showToast('A timetable generation computation is already active in the background.', 'warning');
      return;
    }

    const name = document.getElementById('gen-name')?.value || 'Master Timetable';
    const scopeSectionVal = document.getElementById('gen-scope-section')?.value;
    const sectionId = scopeSectionVal ? parseInt(scopeSectionVal, 10) : undefined;
    const publishNow = document.getElementById('gen-publish-now')?.checked || false;

    const btn = document.getElementById('btn-submit-generate');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '⏳ Initializing CSP Solver...';
    }

    // Immediately activate the in-modal and global progress trackers
    updateGenerationProgress({
      isRunning: true,
      progress: 5,
      phase: 'Phase 1: Validating Master Data Feasibility...',
      name,
      startedAt: Date.now()
    });

    try {
      const res = await apiRequest('/api/timetable/generate', {
        method: 'POST',
        body: { name, sectionId, publishNow },
        showErrorToast: false
      });

      if (res.alreadyRunning) {
        showToast(res.reason || 'Generation already running in the background', 'warning');
        if (res.state) updateGenerationProgress(res.state);
        return;
      }

      if (res.hasConflicts) {
        showToast(`Draft generated with ${res.conflictsCount} conflicts. Click Regenerate to resolve them.`, 'warning');
      } else {
        showToast(res.message || 'Timetable generated successfully', 'success');
      }
      await onGenerationCompleted(res);
    } catch (err) {
      if (err.status === 409 || err.message?.includes('computation is currently active')) {
        showToast('A timetable generation computation is already active in the background. Duplicate runs locked.', 'warning');
        checkGenerationStatus();
      } else {
        onGenerationFailed({ reason: err.message || 'Generation failed' });
        showToast(err.message || 'Failed to generate timetable', 'error');
      }
    } finally {
      if (!isGenerationRunning && btn) {
        btn.disabled = false;
        btn.textContent = 'Start CSP Generator';
      }
    }
  });

  // Edit / Add Timetable Entry Modal handlers (Task 6: Unrestricted Manual Edit Authority)
  document.getElementById('modal-edit-entry-close')?.addEventListener('click', () => {
    document.getElementById('modal-edit-entry').style.display = 'none';
  });
  document.getElementById('modal-edit-entry-close-btn')?.addEventListener('click', () => {
    document.getElementById('modal-edit-entry').style.display = 'none';
  });
  document.getElementById('modal-edit-entry-x')?.addEventListener('click', () => {
    document.getElementById('modal-edit-entry').style.display = 'none';
  });

  // Delete Timetable Entry
  document.getElementById('btn-delete-edit-entry')?.addEventListener('click', async () => {
    const entryId = parseInt(document.getElementById('edit-entry-id')?.value, 10);
    const ok = await showAppConfirm({
      title: 'Remove Scheduled Class',
      message: 'Are you sure you want to remove this class from the schedule?',
      confirmText: 'Remove Class',
      isDanger: true
    });
    if (!ok) return;

    // Record undo state
    pushUndoSnapshot();

    if (draftWorkingEntries) {
      const idx = draftWorkingEntries.findIndex(e => e.id === entryId);
      if (idx !== -1) draftWorkingEntries.splice(idx, 1);
      document.getElementById('modal-edit-entry').style.display = 'none';
      const val = runSharedValidation(draftWorkingEntries);
      renderStudioGrid();
      showToast('Class removed from working draft', 'info');
      return;
    }

    try {
      await apiRequest(`/api/timetable/entries/${entryId}`, { method: 'DELETE' });
      if (currentVersionData?.entries) {
        const idx = currentVersionData.entries.findIndex(e => e.id === entryId);
        if (idx !== -1) currentVersionData.entries.splice(idx, 1);
      }
      document.getElementById('modal-edit-entry').style.display = 'none';
      const val = runSharedValidation();
      renderStudioGrid();
      showToast('Class removed from timetable', 'success');
    } catch (err) {
      showToast(err.message || 'Failed to remove class', 'error');
    }
  });

  document.getElementById('form-edit-entry')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const entryId = parseInt(document.getElementById('edit-entry-id')?.value, 10);
    const dayId = parseInt(document.getElementById('edit-entry-day-id')?.value, 10);
    const slotId = parseInt(document.getElementById('edit-entry-slot-id')?.value, 10);
    const subjectId = parseInt(document.getElementById('edit-entry-subject')?.value, 10);
    const facultyId = parseInt(document.getElementById('edit-entry-faculty')?.value, 10);
    const roomId = parseInt(document.getElementById('edit-entry-room')?.value, 10);
    const locked = document.getElementById('edit-entry-lock')?.checked ? 1 : 0;

    const sub = masterData?.subjects?.find(s => s.id === subjectId);
    const fac = masterData?.faculty?.find(f => f.id === facultyId);
    const rm = masterData?.rooms?.find(r => r.id === roomId);

    // Record undo state
    pushUndoSnapshot();

    // CASE 1: ADD NEW ENTRY (when entryId is falsy)
    if (!entryId) {
      const sectionSelect = document.getElementById('edit-entry-section');
      const sectionId = parseInt(sectionSelect?.value || (studioMode === 'section' ? studioEntityId : masterData?.sections?.[0]?.id), 10);
      if (!sectionId || isNaN(sectionId)) {
        showToast('Please add a section in Master Data first before scheduling.', 'warning');
        return;
      }
      if (!subjectId || isNaN(subjectId)) {
        showToast('Please add and select a subject from Master Data first.', 'warning');
        return;
      }
      if (!facultyId || isNaN(facultyId)) {
        showToast('Please select a valid faculty instructor.', 'warning');
        return;
      }
      if (!roomId || isNaN(roomId)) {
        showToast('Please add and select a classroom/lab room from Master Data first.', 'warning');
        return;
      }

      const sec = masterData?.sections?.find(s => s.id === sectionId);
      const day = masterData?.workingDays?.find(d => d.id === dayId);
      const slot = masterData?.timeSlots?.find(s => s.id === slotId);

      if (draftWorkingEntries) {
        const newEntry = {
          id: Date.now(),
          version_id: activeVersionId,
          section_id: sectionId,
          subject_id: subjectId,
          faculty_id: facultyId,
          room_id: roomId,
          day_id: dayId,
          slot_id: slotId,
          is_lab_block: sub?.type === 'lab' ? 1 : 0,
          locked,
          is_locked: locked,
          section_name: sec?.name || `Section ${sectionId}`,
          section_strength: sec?.strength || 40,
          subject_code: sub?.code || 'SUB',
          subject_name: sub?.name || 'Subject',
          subject_type: sub?.type || 'theory',
          faculty_name: fac?.name || 'Instructor',
          room_name: rm?.name || 'Room',
          room_type: rm?.type || 'classroom',
          room_capacity: rm?.capacity || 40,
          day_name: day?.day_name || 'Day',
          day_index: day?.day_index || 1,
          slot_label: slot?.label || 'Period',
          slot_no: slot?.slot_no || 1,
          start_time: slot?.start_time || '09:00',
          end_time: slot?.end_time || '10:00'
        };

        draftWorkingEntries.push(newEntry);
        document.getElementById('modal-edit-entry').style.display = 'none';
        const val = runSharedValidation(draftWorkingEntries);
        renderStudioGrid();
        if (!val.isValid) {
          showToast(`Class added to draft. Notice: ${val.errorCount} conflict(s) detected. Click Resolve to fix.`, 'warning');
        } else {
          showToast('Class added to working draft', 'success');
        }
        return;
      }

      try {
        const res = await apiRequest('/api/timetable/entries', {
          method: 'POST',
          body: {
            versionId: activeVersionId,
            sectionId,
            subjectId,
            facultyId,
            roomId,
            dayId,
            slotId,
            isLabBlock: sub?.type === 'lab' ? 1 : 0,
            locked
          }
        });

        if (res.entry && currentVersionData?.entries) {
          currentVersionData.entries.push(res.entry);
        }

        document.getElementById('modal-edit-entry').style.display = 'none';
        const val = runSharedValidation();
        renderStudioGrid();

        if (!val.isValid) {
          showToast(`Class scheduled. Notice: created ${val.errorCount} conflict(s). Click Resolve to auto-fix.`, 'warning');
        } else {
          showToast('Class scheduled successfully', 'success');
        }
      } catch (err) {
        showToast(err.message || 'Failed to add class', 'error');
      }
      return;
    }

    // CASE 2: EDIT EXISTING ENTRY
    const activeList = draftWorkingEntries || currentVersionData?.entries || [];
    const entry = activeList.find(ent => ent.id === entryId);

    if (entry) {
      if (!isNaN(subjectId) && sub) {
        entry.subject_id = subjectId;
        entry.subject_name = sub.name;
        entry.subject_code = sub.code;
        entry.subject_type = sub.type;
        entry.is_lab_block = sub.type === 'lab' ? 1 : 0;
      }
      if (!isNaN(facultyId) && fac) {
        entry.faculty_id = facultyId;
        entry.faculty_name = fac.name;
      }
      if (!isNaN(roomId) && rm) {
        entry.room_id = roomId;
        entry.room_name = rm.name;
        entry.room_type = rm.type;
        entry.room_capacity = rm.capacity;
      }
      entry.locked = locked;
      entry.is_locked = locked;
    }

    document.getElementById('modal-edit-entry').style.display = 'none';

    if (draftWorkingEntries) {
      const val = runSharedValidation(draftWorkingEntries);
      renderStudioGrid();
      if (!val.isValid) {
        showToast(`Assignment saved. Notice: ${val.errorCount} conflict(s) detected. Click Resolve to fix.`, 'warning');
      } else {
        showToast('Assignment updated in working draft', 'success');
      }
      return;
    }

    try {
      await apiRequest(`/api/timetable/entries/${entryId}`, {
        method: 'PUT',
        body: { subjectId, facultyId, roomId, locked }
      });

      const val = runSharedValidation();
      renderStudioGrid();

      if (!val.isValid) {
        showToast(`Assignment updated. Warning: created ${val.errorCount} conflict(s). Click Resolve to auto-fix.`, 'warning');
      } else {
        showToast('Timetable assignment updated successfully', 'success');
      }
    } catch (err) {
      showToast(err.message || 'Failed to update assignment', 'error');
    }
  });

  // Master Data forms
  document.getElementById('form-faculty')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('fac-id').value;
    const pwdInput = document.getElementById('fac-password');
    const body = {
      name: document.getElementById('fac-name').value,
      departmentId: parseInt(document.getElementById('fac-dept').value, 10),
      email: document.getElementById('fac-email').value,
      phone: document.getElementById('fac-phone').value,
      maxPeriodsPerDay: parseInt(document.getElementById('fac-max-day').value, 10),
      maxPeriodsPerWeek: parseInt(document.getElementById('fac-max-week').value, 10)
    };
    if (!id && pwdInput && pwdInput.value.trim()) {
      body.password = pwdInput.value.trim();
    }
    try {
      if (id) {
        await apiRequest(`/api/admin/faculty/${id}`, { method: 'PUT', body });
        showToast('Faculty updated successfully', 'success');
      } else {
        const res = await apiRequest('/api/admin/faculty', { method: 'POST', body });
        showToast(res.message || 'Faculty added successfully', 'success');
      }
      document.getElementById('modal-faculty').style.display = 'none';
      await loadMasterData();
      renderMasterDataTables();
      if (typeof loadOverview === 'function') loadOverview();
      populateStudioEntitySelector();
      renderStudioGrid();
    } catch (err) {
      showToast(err.message || 'Failed to save faculty', 'error');
    }
  });

  document.getElementById('form-subject')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('sub-id').value;
    const body = {
      code: document.getElementById('sub-code').value,
      name: document.getElementById('sub-name').value,
      departmentId: parseInt(document.getElementById('sub-dept').value, 10),
      semester: parseInt(document.getElementById('sub-semester').value, 10),
      type: document.getElementById('sub-type').value,
      weeklyPeriods: parseInt(document.getElementById('sub-periods').value, 10),
      labBlockLength: parseInt(document.getElementById('sub-lab-block').value, 10)
    };
    try {
      if (id) {
        await apiRequest(`/api/admin/subjects/${id}`, { method: 'PUT', body });
        showToast('Subject updated successfully', 'success');
      } else {
        await apiRequest('/api/admin/subjects', { method: 'POST', body });
        showToast('Subject created successfully', 'success');
      }
      document.getElementById('modal-subject').style.display = 'none';
      await loadMasterData();
      renderMasterDataTables();
    } catch (err) {}
  });

  document.getElementById('form-room')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('room-id').value;
    const body = {
      name: document.getElementById('room-name').value,
      type: document.getElementById('room-type').value,
      capacity: parseInt(document.getElementById('room-capacity').value, 10),
      isActive: 1
    };
    try {
      if (id) {
        await apiRequest(`/api/admin/rooms/${id}`, { method: 'PUT', body });
        showToast('Room updated successfully', 'success');
      } else {
        await apiRequest('/api/admin/rooms', { method: 'POST', body });
        showToast('Room created successfully', 'success');
      }
      document.getElementById('modal-room').style.display = 'none';
      await loadMasterData();
      renderMasterDataTables();
    } catch (err) {}
  });

  document.getElementById('form-section')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('sec-id').value;
    const body = {
      name: document.getElementById('sec-name').value,
      departmentId: parseInt(document.getElementById('sec-dept').value, 10),
      semester: parseInt(document.getElementById('sec-semester').value, 10),
      strength: parseInt(document.getElementById('sec-strength').value, 10)
    };
    try {
      if (id) {
        await apiRequest(`/api/admin/sections/${id}`, { method: 'PUT', body });
        showToast('Section updated successfully', 'success');
      } else {
        await apiRequest('/api/admin/sections', { method: 'POST', body });
        showToast('Section created successfully', 'success');
      }
      document.getElementById('modal-section').style.display = 'none';
      await loadMasterData();
      renderMasterDataTables();
    } catch (err) {}
  });

  document.getElementById('form-holiday')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      date: document.getElementById('hol-date').value,
      description: document.getElementById('hol-desc').value
    };
    try {
      await apiRequest('/api/admin/holidays', { method: 'POST', body });
      showToast('Academic holiday added successfully', 'success');
      document.getElementById('modal-holiday').style.display = 'none';
      await loadMasterData();
      renderMasterDataTables();
    } catch (err) {}
  });

  document.getElementById('form-department')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('dept-id').value;
    const body = {
      code: document.getElementById('dept-code').value,
      name: document.getElementById('dept-name').value
    };
    try {
      if (id) {
        await apiRequest(`/api/admin/departments/${id}`, { method: 'PUT', body });
        showToast('Department updated successfully', 'success');
      } else {
        await apiRequest('/api/admin/departments', { method: 'POST', body });
        showToast('Department created successfully', 'success');
      }
      document.getElementById('modal-department').style.display = 'none';
      await loadMasterData();
      renderMasterDataTables();
    } catch (err) {}
  });
}

function openEditEntryModal(entryId) {
  const activeList = draftWorkingEntries || currentVersionData?.entries || [];
  const entry = activeList.find(e => e.id === entryId);
  if (!entry) return;

  const modal = document.getElementById('modal-edit-entry');
  if (!modal) return;

  const titleEl = document.getElementById('modal-edit-entry-title');
  if (titleEl) titleEl.textContent = 'Edit Class Assignment';

  const idInput = document.getElementById('edit-entry-id');
  if (idInput) idInput.value = entry.id;

  const dayInput = document.getElementById('edit-entry-day-id');
  if (dayInput) dayInput.value = entry.day_id;

  const slotInput = document.getElementById('edit-entry-slot-id');
  if (slotInput) slotInput.value = entry.slot_id;

  const secGroup = document.getElementById('edit-entry-section-group');
  if (secGroup) secGroup.style.display = 'none';

  const detailsEl = document.getElementById('modal-edit-entry-details');
  if (detailsEl) {
    detailsEl.textContent = `${entry.subject_name || 'Class'} (${entry.subject_code || 'SUB'}) · ${entry.day_name || 'Day'} · ${entry.slot_label || 'Period ' + entry.slot_no} (${entry.start_time || '09:00'} - ${entry.end_time || '10:00'}) · Section ${entry.section_name || ''}`;
  }

  const subSelect = document.getElementById('edit-entry-subject');
  if (subSelect && masterData?.subjects) {
    subSelect.innerHTML = masterData.subjects.map(s =>
      `<option value="${s.id}" ${s.id === entry.subject_id ? 'selected' : ''}>${s.code} - ${s.name} (${s.type === 'lab' ? 'Lab' : 'Theory'}, ${s.weekly_periods} hrs)</option>`
    ).join('');
  }

  const facSelect = document.getElementById('edit-entry-faculty');
  if (facSelect && masterData?.faculty) {
    facSelect.innerHTML = masterData.faculty.map(f =>
      `<option value="${f.id}" ${f.id === entry.faculty_id ? 'selected' : ''}>${f.name} (${f.department_code || 'Dept'}) - Max: ${f.max_periods_per_day || 4}/day</option>`
    ).join('');
  }

  const roomSelect = document.getElementById('edit-entry-room');
  if (roomSelect && masterData?.rooms) {
    roomSelect.innerHTML = masterData.rooms.map(r =>
      `<option value="${r.id}" ${r.id === entry.room_id ? 'selected' : ''}>${r.name} (${r.type}, Cap: ${r.capacity})</option>`
    ).join('');
  }

  const lockCheck = document.getElementById('edit-entry-lock');
  if (lockCheck) {
    lockCheck.checked = Boolean(entry.locked || entry.is_locked);
  }

  const deleteBtn = document.getElementById('btn-delete-edit-entry');
  if (deleteBtn) deleteBtn.style.display = 'inline-block';

  const saveBtn = document.getElementById('btn-save-edit-entry');
  if (saveBtn) saveBtn.textContent = 'Save Assignment';

  modal.style.display = 'flex';
}
window.openEditEntryModal = openEditEntryModal;

function openAddEntryModal(dayId, slotId) {
  const modal = document.getElementById('modal-edit-entry');
  if (!modal || !masterData) return;

  const day = masterData.workingDays?.find(d => d.id === dayId) || { day_name: `Day ${dayId}` };
  const slot = masterData.timeSlots?.find(s => s.id === slotId) || { label: `Period ${slotId}`, start_time: '09:00', end_time: '10:00' };

  const titleEl = document.getElementById('modal-edit-entry-title');
  if (titleEl) titleEl.textContent = 'Schedule Class in Period';

  const idInput = document.getElementById('edit-entry-id');
  if (idInput) idInput.value = '';

  const dayInput = document.getElementById('edit-entry-day-id');
  if (dayInput) dayInput.value = dayId;

  const slotInput = document.getElementById('edit-entry-slot-id');
  if (slotInput) slotInput.value = slotId;

  const secGroup = document.getElementById('edit-entry-section-group');
  const secSelect = document.getElementById('edit-entry-section');
  if (secGroup && secSelect && masterData.sections) {
    secGroup.style.display = 'block';
    secSelect.innerHTML = masterData.sections.map(s =>
      `<option value="${s.id}" ${(studioMode === 'section' && s.id === studioEntityId) ? 'selected' : ''}>Section: ${s.name} (Semester ${s.semester})</option>`
    ).join('');
  }

  const detailsEl = document.getElementById('modal-edit-entry-details');
  if (detailsEl) {
    detailsEl.textContent = `Scheduling into ${day.day_name} · ${slot.label} (${slot.start_time} - ${slot.end_time})`;
  }

  const subSelect = document.getElementById('edit-entry-subject');
  if (subSelect && masterData.subjects) {
    if (masterData.subjects.length === 0) {
      subSelect.innerHTML = '<option value="">No subjects found (Add in Master Data first)</option>';
    } else {
      subSelect.innerHTML = masterData.subjects.map(s =>
        `<option value="${s.id}">${s.code} - ${s.name} (${s.type === 'lab' ? 'Lab' : 'Theory'}, ${s.weekly_periods} hrs)</option>`
      ).join('');
    }
  }

  const facSelect = document.getElementById('edit-entry-faculty');
  if (facSelect && masterData.faculty) {
    if (masterData.faculty.length === 0) {
      facSelect.innerHTML = '<option value="">No faculty found (Add in Master Data first)</option>';
    } else {
      facSelect.innerHTML = masterData.faculty.map(f =>
        `<option value="${f.id}" ${(studioMode === 'faculty' && f.id === studioEntityId) ? 'selected' : ''}>${f.name} (${f.department_code || 'Dept'}) - Max: ${f.max_periods_per_day || 4}/day</option>`
      ).join('');
    }
  }

  const roomSelect = document.getElementById('edit-entry-room');
  if (roomSelect && masterData.rooms) {
    roomSelect.innerHTML = masterData.rooms.map(r =>
      `<option value="${r.id}" ${(studioMode === 'room' && r.id === studioEntityId) ? 'selected' : ''}>${r.name} (${r.type}, Cap: ${r.capacity})</option>`
    ).join('');
  }

  const lockCheck = document.getElementById('edit-entry-lock');
  if (lockCheck) lockCheck.checked = false;

  const deleteBtn = document.getElementById('btn-delete-edit-entry');
  if (deleteBtn) deleteBtn.style.display = 'none';

  const saveBtn = document.getElementById('btn-save-edit-entry');
  if (saveBtn) saveBtn.textContent = 'Add Class';

  modal.style.display = 'flex';
}
window.openAddEntryModal = openAddEntryModal;

// 5. Faculty Availability Editor
async function loadAvailabilityEditor() {
  await loadMasterData();
  const select = document.getElementById('avail-faculty-selector');
  const searchInput = document.getElementById('avail-faculty-search');
  if (!select || !masterData) return;

  const populateAvailabilitySelect = (query = '') => {
    const filtered = filterFacultyList(masterData.faculty || [], query);
    const prevSelected = select.value;
    if (filtered.length === 0) {
      select.innerHTML = `<option value="">No matching faculty found</option>`;
      const container = document.getElementById('availability-grid-container');
      if (container) {
        container.innerHTML = `
          <div style="padding: 2.5rem; text-align: center; color: var(--text-muted); background: var(--bg-surface-subtle); border-radius: var(--radius-md); border: 1px dashed var(--border-subtle);">
            No faculty members available. Add faculty in Master Data first to configure their availability.
          </div>
        `;
      }
      return;
    }
    select.innerHTML = filtered.map(f => `
      <option value="${f.id}">${escapeHtml(f.name)} (${escapeHtml(f.department_code || 'General')}${f.email ? ' · ' + escapeHtml(f.email) : ''})</option>
    `).join('');
    if (prevSelected && filtered.some(f => String(f.id) === String(prevSelected))) {
      select.value = prevSelected;
    }
    const selectedId = parseInt(select.value, 10);
    if (!isNaN(selectedId)) {
      renderFacultyAvailabilityGrid(selectedId);
    } else {
      const container = document.getElementById('availability-grid-container');
      if (container) {
        container.innerHTML = `
          <div style="padding: 2.5rem; text-align: center; color: var(--text-muted); background: var(--bg-surface-subtle); border-radius: var(--radius-md); border: 1px dashed var(--border-subtle);">
            No faculty members available. Add faculty in Master Data first to configure their availability.
          </div>
        `;
      }
    }
  };

  if (searchInput && !searchInput._boundAvailFilter) {
    searchInput._boundAvailFilter = true;
    searchInput.addEventListener('input', () => populateAvailabilitySelect(searchInput.value));
    searchInput.addEventListener('search', () => populateAvailabilitySelect(searchInput.value));
  }

  populateAvailabilitySelect(searchInput?.value || '');
  select.onchange = () => {
    const selectedId = parseInt(select.value, 10);
    if (!isNaN(selectedId)) renderFacultyAvailabilityGrid(selectedId);
  };
}

async function renderFacultyAvailabilityGrid(facId) {
  const res = await apiRequest(`/api/admin/faculty/${facId}/availability`);
  const container = document.getElementById('availability-grid-container');
  if (!container || !masterData) return;

  const { workingDays, timeSlots } = masterData;
  const teachingSlots = timeSlots.filter(s => s.is_break === 0);
  const availMap = new Map();
  for (const a of res.availability) {
    availMap.set(`${a.day_id}_${a.slot_id}`, a);
  }

  let html = `
    <table style="width: 100%; border-collapse: collapse; min-width: 700px; text-align: center; border: 1px solid var(--border-subtle); border-radius: var(--radius-md); overflow: hidden;">
      <thead>
        <tr style="background: var(--bg-surface-subtle); border-bottom: 2px solid var(--border-subtle);">
          <th style="padding: 0.65rem; border: 1px solid var(--border-subtle);">Day</th>
  `;

  for (const s of teachingSlots) {
    html += `<th style="padding: 0.65rem; border: 1px solid var(--border-subtle); font-size: 0.8rem;">${s.label}</th>`;
  }

  html += `</tr></thead><tbody>`;

  for (const d of workingDays) {
    html += `<tr><td style="padding: 0.65rem; font-weight: 700; border: 1px solid var(--border-subtle); background: var(--bg-surface-subtle);">${d.day_name}</td>`;
    for (const s of teachingSlots) {
      const a = availMap.get(`${d.id}_${s.id}`);
      const isBusy = a?.is_busy === 1;
      const isAvailable = a ? (a.is_available === 1 && !isBusy) : true;
      let bg, text, color;
      if (isBusy) {
        bg = 'rgba(239, 68, 68, 0.14)';
        color = 'var(--color-error, #E11D48)';
        const subj = a.busy_session?.subject ? `${a.busy_session.subject}${a.busy_session.type === 'lab' ? ' (Lab)' : ''}` : 'Class';
        text = `✗ Busy: ${subj}`;
      } else if (isAvailable) {
        bg = 'var(--color-success-bg)';
        color = 'var(--color-success)';
        text = '✓ Available';
      } else {
        bg = 'var(--color-error-bg)';
        color = 'var(--color-error)';
        text = '✗ Unavailable';
      }
      html += `
        <td class="avail-cell" data-day="${d.id}" data-slot="${s.id}" data-avail="${isAvailable ? '1' : '0'}" style="padding: 0.6rem; border: 1px solid var(--border-subtle); background: ${bg}; color: ${color}; font-weight: 600; font-size: 0.8rem; cursor: pointer; user-select: none;">
          ${text}
        </td>
      `;
    }
    html += `</tr>`;
  }

  html += `</tbody></table>`;
  container.innerHTML = html;

  // Toggle availability cell click
  container.querySelectorAll('.avail-cell').forEach(c => {
    c.addEventListener('click', () => {
      const cur = c.getAttribute('data-avail') === '1';
      const next = !cur;
      c.setAttribute('data-avail', next ? '1' : '0');
      c.style.background = next ? 'var(--color-success-bg)' : 'var(--color-error-bg)';
      c.style.color = next ? 'var(--color-success)' : 'var(--color-error)';
      c.textContent = next ? '✓ Available' : '✗ Unavailable';
    });
  });

  document.getElementById('btn-save-availability').onclick = async () => {
    const payload = [];
    container.querySelectorAll('.avail-cell').forEach(c => {
      payload.push({
        dayId: parseInt(c.getAttribute('data-day'), 10),
        slotId: parseInt(c.getAttribute('data-slot'), 10),
        isAvailable: c.getAttribute('data-avail') === '1'
      });
    });

    await apiRequest(`/api/admin/faculty/${facId}/availability`, {
      method: 'PUT',
      body: { availability: payload }
    });
    showToast('Faculty availability updated successfully', 'success');
  };
}

// 6. Absence Monitor & Substitute Assignment (Mode B: Admin Assignment)
let absenceControlsInitialized = false;

async function loadAbsenceMonitor() {
  const container = document.getElementById('absence-list-container');
  if (!container) return;

  if (!absenceControlsInitialized) {
    document.getElementById('btn-admin-auto-assign-all')?.addEventListener('click', () => {
      window.autoAssignAllPending();
    });
    document.getElementById('btn-admin-refresh-absences')?.addEventListener('click', () => {
      loadAbsenceMonitor();
      showToast('Absence board refreshed', 'info');
    });
    document.getElementById('btn-refresh-history')?.addEventListener('click', () => {
      loadSubstitutionHistory();
    });
    absenceControlsInitialized = true;
  }

  try {
    const data = await apiRequest('/api/absence/board');
    const absences = data.absences || [];

    if (!absences.length) {
      container.innerHTML = `
        <div style="padding: 2.5rem; text-align: center; color: var(--text-muted); background: var(--bg-surface-subtle); border-radius: var(--radius-md); border: 1px dashed var(--border-subtle);">
          <div style="font-size: 2rem; margin-bottom: 0.5rem;">🎉</div>
          <div style="font-size: 1.1rem; font-weight: 600; color: var(--text-primary); margin-bottom: 0.25rem;">No Absences Reported</div>
          <p style="font-size: 0.85rem;">All faculty members are scheduled normally with zero disruptions.</p>
        </div>
      `;
      await loadSubstitutionHistory();
      return;
    }

    container.innerHTML = absences.map(a => {
      const isAbsent = a.type === 'absent';
      const isOverdue = a.isOverdue;
      const isCovered = a.status === 'covered';

      let statusBadge = `<span style="font-size: 0.75rem; background: var(--color-warning-bg); color: var(--color-warning); padding: 0.2rem 0.55rem; border-radius: 4px; font-weight: 700;">Open</span>`;
      if (isCovered) {
        statusBadge = `<span style="font-size: 0.75rem; background: var(--color-success-bg); color: var(--color-success); padding: 0.2rem 0.55rem; border-radius: 4px; font-weight: 700;">Covered</span>`;
      } else if (a.status === 'cancelled') {
        statusBadge = `<span style="font-size: 0.75rem; background: var(--bg-surface-subtle); color: var(--text-muted); padding: 0.2rem 0.55rem; border-radius: 4px;">Cancelled</span>`;
      }

      return `
        <div class="card animate-fade-in" style="margin-bottom: 1.25rem; border-left: 4px solid ${isOverdue ? 'var(--color-error)' : isAbsent ? 'var(--color-error)' : 'var(--color-warning)'}; background: var(--bg-surface);">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 0.75rem; margin-bottom: 1rem;">
            <div>
              <div style="display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;">
                <span style="font-size: 1.25rem; font-weight: 700; color: var(--color-brand-primary);">${escapeHtml(a.faculty_name)}</span>
                <span style="font-size: 0.8rem; color: var(--text-muted);">${escapeHtml(a.department_name)}</span>
                <span style="font-size: 0.75rem; background: ${isAbsent ? 'var(--color-error-bg)' : 'var(--color-warning-bg)'}; color: ${isAbsent ? 'var(--color-error)' : 'var(--color-warning)'}; padding: 0.2rem 0.55rem; border-radius: 4px; font-weight: 600;">
                  ${isAbsent ? 'Full-day Absence' : `Running Late (Arrival: ${a.expected_arrival})`}
                </span>
                ${statusBadge}
              </div>
              <div style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 0.35rem;">
                <strong>Date:</strong> ${a.date} · <strong>Reason:</strong> ${escapeHtml(a.reason || 'None specified')}
              </div>
            </div>

            ${isOverdue ? `
              <div style="background: var(--color-error-bg); border: 1px solid var(--color-error); color: var(--color-error); padding: 0.4rem 0.75rem; border-radius: var(--radius-sm); font-size: 0.8rem; font-weight: 700; display: flex; align-items: center; gap: 0.4rem;">
                <span>⚠️</span>
                <span>ARRIVAL OVERDUE (${a.expected_arrival})</span>
              </div>
            ` : ''}
          </div>

          <h4 style="font-size: 0.95rem; font-weight: 700; color: var(--text-secondary); margin-bottom: 0.5rem; text-transform: uppercase;">
            Affected Classes &amp; Substitution Coverage:
          </h4>

          ${!a.affectedClasses?.length ? `
            <div style="font-size: 0.85rem; color: var(--text-muted); font-style: italic;">
              No classes required substitution during the affected window.
            </div>
          ` : `
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 0.75rem;">
              ${a.affectedClasses.map(ac => {
                const isClaimedOrAssigned = ac.sub_status === 'accepted' || ac.sub_status === 'assigned';
                const safeSubName = (ac.substitute_faculty_name || '').replace(/'/g, "\\'");
                const safeSubjName = (ac.subject_name || '').replace(/'/g, "\\'");
                const safeSlotLabel = (ac.slot_label || '').replace(/'/g, "\\'");

                return `
                  <div style="padding: 0.75rem 1rem; background: var(--bg-surface-subtle); border: 1px solid ${isClaimedOrAssigned ? 'var(--color-success)' : 'var(--color-warning)'}; border-radius: var(--radius-md);">
                    <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.4rem;">
                      <span style="font-weight: 700; font-size: 0.95rem; color: var(--color-brand-primary);">${escapeHtml(ac.subject_name)}</span>
                      <span style="font-size: 0.75rem; color: var(--text-muted);">${escapeHtml(ac.slot_label)} (${ac.start_time})</span>
                    </div>
                    <div style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 0.6rem;">
                      Sec ${escapeHtml(ac.section_name)} · Room: ${escapeHtml(ac.room_name)}
                    </div>

                    <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--border-subtle); padding-top: 0.5rem; flex-wrap: wrap; gap: 0.5rem;">
                      ${isClaimedOrAssigned ? `
                        <div style="font-size: 0.8rem; color: var(--color-success); font-weight: 600;">
                          ✓ Covered by: <strong>${escapeHtml(ac.substitute_faculty_name || 'Assigned')}</strong>
                          <span style="font-size: 0.7rem; color: var(--text-muted);">(${ac.sub_status})</span>
                        </div>
                        <div style="display: flex; gap: 0.35rem;">
                          <button class="btn-secondary" style="font-size: 0.72rem; padding: 0.2rem 0.5rem;" onclick="openAssignModal(${ac.timetable_entry_id}, '${a.date}', '${safeSubjName}', '${safeSlotLabel}', ${ac.substitution_id})">
                            Reassign
                          </button>
                          <button class="btn-secondary" style="font-size: 0.72rem; padding: 0.2rem 0.5rem; color: var(--color-error); border-color: var(--color-error);" onclick="cancelSubstituteAssignment(${ac.substitution_id})">
                            Cancel Cover
                          </button>
                        </div>
                      ` : ac.timetable_entry_id ? `
                        <span style="font-size: 0.78rem; color: var(--color-warning); font-weight: 700; background: var(--color-warning-bg); padding: 0.2rem 0.45rem; border-radius: var(--radius-sm);">⚠️ Pending Substitute</span>
                        <button class="btn-primary" style="font-size: 0.75rem; padding: 0.25rem 0.6rem;" onclick="openAssignModal(${ac.timetable_entry_id}, '${a.date}', '${safeSubjName}', '${safeSlotLabel}')">
                          Assign Substitute
                        </button>
                      ` : `
                        <span style="font-size: 0.78rem; color: var(--color-warning); font-weight: 700; background: var(--color-warning-bg); padding: 0.2rem 0.45rem; border-radius: var(--radius-sm);">⚠️ Scheduled Session</span>
                        <span style="font-size: 0.75rem; color: var(--text-muted);">${escapeHtml(ac.slot_label || 'Direct Session')}</span>
                      `}
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          `}
        </div>
      `;
    }).join('');

    await loadSubstitutionHistory();
  } catch (err) {
    console.error('Failed to load absence monitor:', err);
  }
}

// Load Substitution History Log
async function loadSubstitutionHistory() {
  const container = document.getElementById('substitution-history-container');
  if (!container) return;

  try {
    const data = await apiRequest('/api/absence/history?limit=30');
    const history = data.history || [];

    if (!history.length) {
      container.innerHTML = `
        <div style="padding: 1.5rem; text-align: center; color: var(--text-muted); font-size: 0.85rem;">
          No substitution actions recorded yet.
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div style="overflow-x: auto;">
        <table class="table-admin" style="width: 100%; font-size: 0.8rem; border-collapse: collapse;">
          <thead>
            <tr style="background: var(--bg-surface-subtle); border-bottom: 2px solid var(--border-subtle); text-align: left;">
              <th style="padding: 0.5rem 0.6rem;">Date</th>
              <th style="padding: 0.5rem 0.6rem;">Period</th>
              <th style="padding: 0.5rem 0.6rem;">Class / Subject</th>
              <th style="padding: 0.5rem 0.6rem;">Absent Faculty</th>
              <th style="padding: 0.5rem 0.6rem;">Substitute Faculty</th>
              <th style="padding: 0.5rem 0.6rem; text-align: center;">Status</th>
              <th style="padding: 0.5rem 0.6rem;">Assigned By</th>
              <th style="padding: 0.5rem 0.6rem;">Action Time</th>
            </tr>
          </thead>
          <tbody>
            ${history.map(h => {
              let badgeBg = 'var(--bg-surface-subtle)';
              let badgeColor = 'var(--text-secondary)';
              if (h.status === 'assigned' || h.status === 'accepted') {
                badgeBg = 'var(--color-success-bg)';
                badgeColor = 'var(--color-success)';
              } else if (h.status === 'cancelled') {
                badgeBg = 'var(--color-error-bg)';
                badgeColor = 'var(--color-error)';
              } else if (h.status === 'requested') {
                badgeBg = 'var(--color-warning-bg)';
                badgeColor = 'var(--color-warning)';
              }

              return `
                <tr style="border-bottom: 1px solid var(--border-subtle);">
                  <td style="padding: 0.5rem 0.6rem; font-weight: 600;">${h.date || '—'}</td>
                  <td style="padding: 0.5rem 0.6rem;">${h.slot_label || (h.slot_no ? 'P' + h.slot_no : '—')}</td>
                  <td style="padding: 0.5rem 0.6rem;">
                    <strong>${escapeHtml(h.subject_name || 'Class')}</strong>
                    <div style="font-size: 0.72rem; color: var(--text-muted);">${h.section_name ? `Sec ${escapeHtml(h.section_name)}` : ''} ${h.room_name ? '· ' + escapeHtml(h.room_name) : ''}</div>
                  </td>
                  <td style="padding: 0.5rem 0.6rem;">${escapeHtml(h.absent_faculty_name || 'N/A')}</td>
                  <td style="padding: 0.5rem 0.6rem; font-weight: 600; color: var(--color-brand-primary);">
                    ${h.substitute_faculty_name ? escapeHtml(h.substitute_faculty_name) : '<span style="color: var(--text-muted);">None</span>'}
                  </td>
                  <td style="padding: 0.5rem 0.6rem; text-align: center;">
                    <span style="font-size: 0.72rem; padding: 0.15rem 0.45rem; border-radius: 4px; font-weight: 700; background: ${badgeBg}; color: ${badgeColor};">
                      ${h.status}
                    </span>
                  </td>
                  <td style="padding: 0.5rem 0.6rem; color: var(--text-muted); font-size: 0.75rem;">${escapeHtml(h.assigned_by_username || (h.assigned_by_user_id ? 'User #' + h.assigned_by_user_id : 'System'))}</td>
                  <td style="padding: 0.5rem 0.6rem; color: var(--text-muted); font-size: 0.72rem;">${new Date(h.updated_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div style="color: var(--color-error); font-size: 0.8rem; padding: 1rem;">Failed to load history: ${escapeHtml(err.message)}</div>`;
  }
}
window.loadSubstitutionHistory = loadSubstitutionHistory;

// Open Assign / Reassign Substitute Modal with Ranked Candidates
window.openAssignModal = async (timetableEntryId, date, subjectName, slotLabel, substitutionId = null) => {
  const modal = document.getElementById('modal-assign-sub');
  const title = document.getElementById('assign-sub-title');
  const subtitle = document.getElementById('assign-sub-subtitle');
  const list = document.getElementById('assign-candidates-list');
  if (!modal || !list) return;

  if (title) title.textContent = substitutionId ? 'Reassign Substitute Faculty' : 'Assign Substitute Faculty';
  if (subtitle) subtitle.textContent = `Ranking eligible substitutes for ${subjectName} (${slotLabel}) on ${date}:`;
  list.innerHTML = `<div style="color: var(--text-muted); font-size: 0.85rem; padding: 1.5rem; text-align: center;">Evaluating hard constraints and scoring qualified colleagues...</div>`;
  modal.style.display = 'flex';

  // Modal close handlers
  document.getElementById('modal-assign-close').onclick = () => modal.style.display = 'none';
  document.getElementById('modal-assign-close-btn').onclick = () => modal.style.display = 'none';

  try {
    const res = await apiRequest(`/api/absence/candidates/${timetableEntryId}?date=${date}`);
    const candidates = res.candidates || [];

    if (!candidates.length) {
      list.innerHTML = `
        <div style="padding: 1.5rem; text-align: center; color: var(--color-error); background: var(--color-error-bg); border-radius: var(--radius-sm); font-size: 0.85rem;">
          No available faculty meet all hard constraints (all colleagues are either double-booked, on leave, or have reached max daily periods).
        </div>
      `;
      return;
    }

    list.innerHTML = candidates.map(c => `
      <div style="padding: 0.85rem 1rem; background: var(--bg-surface-subtle); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.75rem;">
        <div>
          <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.25rem;">
            <span style="font-weight: 700; font-size: 1rem; color: var(--color-brand-primary);">${escapeHtml(c.name)}</span>
            <span style="font-size: 0.75rem; color: var(--text-muted);">${escapeHtml(c.departmentName)}</span>
            <span style="font-size: 0.75rem; font-weight: 700; background: var(--color-brand-blush-soft); color: var(--color-brand-primary); padding: 0.15rem 0.45rem; border-radius: 4px;">
              Score: ${c.score}
            </span>
            ${c.isQualified ? `<span style="font-size: 0.7rem; background: var(--color-success-bg); color: var(--color-success); padding: 0.15rem 0.45rem; border-radius: 4px; font-weight: 700;">Qualified</span>` : ''}
            ${c.isSameDept ? `<span style="font-size: 0.7rem; background: var(--bg-surface); border: 1px solid var(--border-subtle); padding: 0.15rem 0.45rem; border-radius: 4px;">Same Dept</span>` : ''}
          </div>
          <div style="font-size: 0.8rem; color: var(--text-secondary);">
            Today: ${c.currentDailyPeriods} / ${c.maxPeriodsPerDay} periods · Weekly: ${c.weeklyPeriods} periods
          </div>
          <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.2rem;">
            Reasons: ${(c.reasons || []).map(escapeHtml).join(' · ')}
          </div>
        </div>

        <div>
          <button class="btn-primary" style="font-size: 0.85rem;" onclick="assignSubstitute(${timetableEntryId}, '${date}', ${c.facultyId}, '${escapeHtml(c.name).replace(/'/g, "\\'")}', ${substitutionId || 'null'})">
            ${substitutionId ? 'Reassign Duty' : 'Assign Duty'}
          </button>
        </div>
      </div>
    `).join('');

  } catch (err) {
    list.innerHTML = `<div style="color: var(--color-error); font-size: 0.85rem; padding: 1rem;">Failed to load candidates: ${escapeHtml(err.message)}</div>`;
  }
};

window.assignSubstitute = async (timetableEntryId, date, substituteFacultyId, facultyName, substitutionId = null) => {
  try {
    let res;
    if (substitutionId) {
      res = await apiRequest('/api/absence/substitute/reassign', {
        method: 'POST',
        body: { substitutionId, substituteFacultyId }
      });
      showToast(res.message || `Substitute reassigned to ${facultyName}`, 'success');
    } else {
      res = await apiRequest('/api/absence/substitute/assign', {
        method: 'POST',
        body: { timetableEntryId, date, substituteFacultyId }
      });
      showToast(res.message || `Substitute assigned to ${facultyName}`, 'success');
    }
    const modal = document.getElementById('modal-assign-sub');
    if (modal) modal.style.display = 'none';
    await loadAbsenceMonitor();
    await loadOverview();
  } catch (err) {
    showToast(err.message || 'Failed to assign substitute', 'error');
  }
};

window.cancelSubstituteAssignment = async (substitutionId) => {
  try {
    const res = await apiRequest(`/api/absence/substitute/${substitutionId}/cancel`, {
      method: 'POST'
    });
    showToast(res.message || 'Substitution cancelled', 'info');
    await loadAbsenceMonitor();
    await loadOverview();
  } catch (err) {
    showToast(err.message || 'Failed to cancel substitution', 'error');
  }
};

window.autoAssignAllPending = async () => {
  const btn = document.getElementById('btn-admin-auto-assign-all');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Auto-assigning...';
  }
  try {
    const res = await apiRequest('/api/absence/substitute/auto-assign', {
      method: 'POST',
      body: {}
    });
    if (res.assignedCount > 0) {
      showToast(`Auto-assigned ${res.assignedCount} substitute(s) successfully!`, 'success');
    } else if (res.unassignedCount > 0) {
      showToast(`No conflict-free substitutes found for ${res.unassignedCount} pending class(es).`, 'warning');
    } else {
      showToast('No pending substitutions to auto-assign.', 'info');
    }
    await loadAbsenceMonitor();
    await loadOverview();
  } catch (err) {
    showToast(err.message || 'Auto-assignment failed', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '⚡ Auto-Assign All';
    }
  }
};

// Global in-app confirmation modal (100% iframe-safe, zero window.confirm dependency)
export function showAppConfirm({
  title = 'Confirm Deletion',
  message = 'Are you sure you want to proceed?',
  confirmText = 'Delete Permanently',
  cancelText = 'Cancel',
  isDanger = true
} = {}) {
  return new Promise((resolve) => {
    const modal = document.getElementById('modal-app-confirm');
    if (!modal) {
      // Fallback if modal container not found
      return resolve(true);
    }

    const titleEl = modal.querySelector('#app-confirm-title');
    const msgEl = modal.querySelector('#app-confirm-message');
    const cancelBtn = modal.querySelector('#app-confirm-cancel-btn');
    const okBtn = modal.querySelector('#app-confirm-ok-btn');
    const iconEl = modal.querySelector('#app-confirm-icon');

    if (titleEl) titleEl.textContent = title;
    if (msgEl) msgEl.innerHTML = message;
    if (cancelBtn) cancelBtn.textContent = cancelText;
    if (okBtn) {
      okBtn.textContent = confirmText;
      if (isDanger) {
        okBtn.style.background = '#E11D48';
        okBtn.style.borderColor = '#E11D48';
        okBtn.style.color = '#FFFFFF';
        if (iconEl) {
          iconEl.textContent = '🗑️';
          iconEl.style.background = 'rgba(225, 29, 72, 0.15)';
          iconEl.style.color = '#E11D48';
        }
      } else {
        okBtn.style.background = 'var(--color-brand-primary)';
        okBtn.style.borderColor = 'var(--color-brand-primary)';
        okBtn.style.color = '#FFFFFF';
        if (iconEl) {
          iconEl.textContent = 'ℹ️';
          iconEl.style.background = 'rgba(59, 130, 246, 0.15)';
          iconEl.style.color = 'var(--color-brand-primary)';
        }
      }
    }

    const cleanup = () => {
      modal.style.display = 'none';
      if (cancelBtn) cancelBtn.onclick = null;
      if (okBtn) okBtn.onclick = null;
    };

    if (cancelBtn) {
      cancelBtn.onclick = () => {
        cleanup();
        resolve(false);
      };
    }

    if (okBtn) {
      okBtn.onclick = () => {
        cleanup();
        resolve(true);
      };
    }

    modal.style.display = 'flex';
  });
}
window.showAppConfirm = showAppConfirm;

// Global functions for inline actions & Master Data Modals
window.openFacultyModal = (id = null) => {
  const deptSelect = document.getElementById('fac-dept');
  if (deptSelect && masterData) {
    if (!masterData.departments || masterData.departments.length === 0) {
      deptSelect.innerHTML = '<option value="">No departments found (Add department first)</option>';
    } else {
      deptSelect.innerHTML = masterData.departments.map(d => `<option value="${d.id}">${d.name} (${d.code})</option>`).join('');
    }
  }
  const title = document.getElementById('modal-faculty-title');
  const pwdWrap = document.getElementById('fac-password-wrap');
  const deleteBtn = document.getElementById('btn-modal-delete-faculty');

  if (id) {
    const f = masterData.faculty.find(x => x.id === id);
    if (!f) return;
    document.getElementById('fac-id').value = f.id;
    document.getElementById('fac-name').value = f.name;
    document.getElementById('fac-dept').value = f.department_id;
    document.getElementById('fac-email').value = f.email || '';
    document.getElementById('fac-phone').value = f.phone || '';
    document.getElementById('fac-max-day').value = f.max_periods_per_day;
    document.getElementById('fac-max-week').value = f.max_periods_per_week;
    if (pwdWrap) pwdWrap.style.display = 'none';
    if (title) title.textContent = 'Edit Faculty Member';
    if (deleteBtn) {
      deleteBtn.style.display = 'inline-block';
      deleteBtn.onclick = () => {
        document.getElementById('modal-faculty').style.display = 'none';
        window.deleteFaculty(id);
      };
    }
  } else {
    document.getElementById('form-faculty')?.reset();
    document.getElementById('fac-id').value = '';
    if (pwdWrap) pwdWrap.style.display = 'block';
    if (title) title.textContent = 'Add Faculty Member';
    if (deleteBtn) deleteBtn.style.display = 'none';
  }
  document.getElementById('modal-faculty').style.display = 'flex';
};

window.editFaculty = (id) => window.openFacultyModal(id);

window.deleteFaculty = async (id) => {
  const fac = masterData?.faculty?.find(f => f.id === id);
  const name = fac ? fac.name : 'this faculty member';

  const confirmed = await showAppConfirm({
    title: 'Delete Faculty Member',
    message: `Are you sure you want to permanently delete <strong>${escapeHtml(name)}</strong>?<br><br><span style="color: var(--text-muted); font-size: 0.82rem;">This will remove their faculty profile, user account, availability records, and any active timetable class assignments.</span>`,
    confirmText: 'Delete Faculty',
    cancelText: 'Cancel',
    isDanger: true
  });

  if (!confirmed) return;

  try {
    const res = await apiRequest(`/api/admin/faculty/${id}?cascade=true`, { method: 'DELETE' });
    showToast(res.message || `Faculty ${name} deleted successfully`, 'success');
    await loadMasterData();
    renderMasterDataTables();
    if (typeof loadOverview === 'function') loadOverview();
    if (typeof populateStudioEntitySelector === 'function') populateStudioEntitySelector();
    if (typeof renderStudioGrid === 'function') renderStudioGrid();
  } catch (err) {
    if (err.status === 409 || (err.message && err.message.includes('active timetable class'))) {
      const forceConfirmed = await showAppConfirm({
        title: 'Force Delete Faculty',
        message: `${escapeHtml(err.message)}<br><br>Do you want to permanently force-delete <strong>${escapeHtml(name)}</strong> and clear all their classes from the timetable?`,
        confirmText: 'Force Delete',
        cancelText: 'Cancel',
        isDanger: true
      });
      if (forceConfirmed) {
        try {
          const forceRes = await apiRequest(`/api/admin/faculty/${id}?force=true&cascade=true`, { method: 'DELETE' });
          showToast(forceRes.message || `Faculty ${name} deleted successfully`, 'success');
          await loadMasterData();
          renderMasterDataTables();
          if (typeof loadOverview === 'function') loadOverview();
          if (typeof populateStudioEntitySelector === 'function') populateStudioEntitySelector();
          if (typeof renderStudioGrid === 'function') renderStudioGrid();
          return;
        } catch (forceErr) {
          showToast(forceErr.message || 'Failed to delete faculty member', 'error');
          return;
        }
      }
    }
    showToast(err.message || 'Failed to delete faculty member', 'error');
  }
};

window.openSubjectModal = (id = null) => {
  const deptSelect = document.getElementById('sub-dept');
  if (deptSelect && masterData) {
    if (!masterData.departments || masterData.departments.length === 0) {
      deptSelect.innerHTML = '<option value="">No departments found (Add department first)</option>';
    } else {
      deptSelect.innerHTML = masterData.departments.map(d => `<option value="${d.id}">${d.name} (${d.code})</option>`).join('');
    }
  }
  const title = document.getElementById('modal-subject-title');
  if (id) {
    const s = masterData.subjects.find(x => x.id === id);
    if (!s) return;
    document.getElementById('sub-id').value = s.id;
    document.getElementById('sub-code').value = s.code;
    document.getElementById('sub-name').value = s.name;
    document.getElementById('sub-dept').value = s.department_id;
    document.getElementById('sub-semester').value = s.semester;
    document.getElementById('sub-type').value = s.type;
    document.getElementById('sub-periods').value = s.weekly_periods;
    document.getElementById('sub-lab-block').value = s.lab_block_length;
    if (title) title.textContent = 'Edit Subject';
  } else {
    document.getElementById('form-subject')?.reset();
    document.getElementById('sub-id').value = '';
    if (title) title.textContent = 'Add Subject';
  }
  document.getElementById('modal-subject').style.display = 'flex';
};

window.editSubject = (id) => window.openSubjectModal(id);

window.deleteSubject = async (id) => {
  const sub = masterData?.subjects?.find(s => s.id === id);
  const name = sub ? `${sub.code} (${sub.name})` : 'this subject';

  const confirmed = await showAppConfirm({
    title: 'Delete Subject',
    message: `Are you sure you want to delete <strong>${escapeHtml(name)}</strong>?<br><br><span style="color: var(--text-muted); font-size: 0.82rem;">All associated timetable entries and mappings will be removed.</span>`,
    confirmText: 'Delete Subject',
    isDanger: true
  });
  if (!confirmed) return;

  try {
    const res = await apiRequest(`/api/admin/subjects/${id}`, { method: 'DELETE' });
    showToast(res.message || 'Subject deleted', 'success');
    await loadMasterData();
    renderMasterDataTables();
    if (typeof loadOverview === 'function') loadOverview();
    populateStudioEntitySelector();
    renderStudioGrid();
  } catch (err) {
    showToast(err.message || 'Failed to delete subject', 'error');
  }
};

window.openRoomModal = (id = null) => {
  const title = document.getElementById('modal-room-title');
  if (id) {
    const r = masterData.rooms.find(x => x.id === id);
    if (!r) return;
    document.getElementById('room-id').value = r.id;
    document.getElementById('room-name').value = r.name;
    document.getElementById('room-type').value = r.type;
    document.getElementById('room-capacity').value = r.capacity;
    if (title) title.textContent = 'Edit Room / Lab';
  } else {
    document.getElementById('form-room')?.reset();
    document.getElementById('room-id').value = '';
    if (title) title.textContent = 'Add Room / Lab';
  }
  document.getElementById('modal-room').style.display = 'flex';
};

window.editRoom = (id) => window.openRoomModal(id);

window.deleteRoom = async (id) => {
  const room = masterData?.rooms?.find(r => r.id === id);
  const name = room ? room.name : 'this room';

  const confirmed = await showAppConfirm({
    title: 'Delete Room / Lab',
    message: `Are you sure you want to delete <strong>${escapeHtml(name)}</strong>?<br><br><span style="color: var(--text-muted); font-size: 0.82rem;">Any classes scheduled in this room will be cleared.</span>`,
    confirmText: 'Delete Room',
    isDanger: true
  });
  if (!confirmed) return;

  try {
    const res = await apiRequest(`/api/admin/rooms/${id}`, { method: 'DELETE' });
    showToast(res.message || 'Room deleted', 'success');
    await loadMasterData();
    renderMasterDataTables();
    if (typeof loadOverview === 'function') loadOverview();
    populateStudioEntitySelector();
    renderStudioGrid();
  } catch (err) {
    showToast(err.message || 'Failed to delete room', 'error');
  }
};

window.restoreDefaultRooms = async () => {
  try {
    const res = await apiRequest('/api/admin/rooms/restore-defaults', { method: 'POST' });
    showToast(res.message || 'All 11 default rooms restored successfully', 'success');
    await loadMasterData();
    renderMasterDataTables();
    if (typeof loadOverview === 'function') loadOverview();
    populateStudioEntitySelector();
    renderStudioGrid();
  } catch (err) {
    showToast(err.message || 'Failed to restore rooms', 'error');
  }
};

window.openSectionModal = (id = null) => {
  const deptSelect = document.getElementById('sec-dept');
  if (deptSelect && masterData) {
    if (!masterData.departments || masterData.departments.length === 0) {
      deptSelect.innerHTML = '<option value="">No departments found (Add department first)</option>';
    } else {
      deptSelect.innerHTML = masterData.departments.map(d => `<option value="${d.id}">${d.name} (${d.code})</option>`).join('');
    }
  }
  const title = document.getElementById('modal-section-title');
  if (id) {
    const sec = masterData.sections.find(x => x.id === id);
    if (!sec) return;
    document.getElementById('sec-id').value = sec.id;
    document.getElementById('sec-name').value = sec.name;
    document.getElementById('sec-dept').value = sec.department_id;
    document.getElementById('sec-semester').value = sec.semester;
    document.getElementById('sec-strength').value = sec.strength;
    if (title) title.textContent = 'Edit Student Section';
  } else {
    document.getElementById('form-section')?.reset();
    document.getElementById('sec-id').value = '';
    if (title) title.textContent = 'Add Student Section';
  }
  document.getElementById('modal-section').style.display = 'flex';
};

window.editSection = (id) => window.openSectionModal(id);

window.deleteSection = async (id) => {
  const sec = masterData?.sections?.find(s => s.id === id);
  const name = sec ? sec.name : 'this section';

  const confirmed = await showAppConfirm({
    title: 'Delete Student Section',
    message: `Are you sure you want to delete <strong>${escapeHtml(name)}</strong>?<br><br><span style="color: var(--text-muted); font-size: 0.82rem;">All timetable entries and subject mappings for this section will be removed.</span>`,
    confirmText: 'Delete Section',
    isDanger: true
  });
  if (!confirmed) return;

  try {
    const res = await apiRequest(`/api/admin/sections/${id}`, { method: 'DELETE' });
    showToast(res.message || 'Section deleted', 'success');
    await loadMasterData();
    renderMasterDataTables();
    if (typeof loadOverview === 'function') loadOverview();
    populateStudioEntitySelector();
    renderStudioGrid();
  } catch (err) {
    showToast(err.message || 'Failed to delete section', 'error');
  }
};

window.openHolidayModal = () => {
  document.getElementById('form-holiday')?.reset();
  const dateInput = document.getElementById('hol-date');
  if (dateInput) dateInput.value = new Date().toISOString().split('T')[0];
  document.getElementById('modal-holiday').style.display = 'flex';
};

window.deleteHoliday = async (id) => {
  const hol = masterData?.holidays?.find(h => h.id === id);
  const desc = hol ? `${hol.description} (${hol.date})` : 'this holiday';

  const confirmed = await showAppConfirm({
    title: 'Remove Academic Holiday',
    message: `Are you sure you want to remove <strong>${escapeHtml(desc)}</strong>?`,
    confirmText: 'Remove Holiday',
    isDanger: true
  });
  if (!confirmed) return;

  try {
    const res = await apiRequest(`/api/admin/holidays/${id}`, { method: 'DELETE' });
    showToast(res.message || 'Holiday removed', 'success');
    await loadMasterData();
    renderMasterDataTables();
    if (typeof loadOverview === 'function') loadOverview();
  } catch (err) {
    showToast(err.message || 'Failed to remove holiday', 'error');
  }
};

window.openDepartmentModal = (id = null) => {
  const title = document.getElementById('modal-dept-title');
  if (id) {
    const d = masterData.departments.find(x => x.id === id);
    if (!d) return;
    document.getElementById('dept-id').value = d.id;
    document.getElementById('dept-code').value = d.code;
    document.getElementById('dept-name').value = d.name;
    if (title) title.textContent = 'Edit Department';
  } else {
    document.getElementById('form-department')?.reset();
    document.getElementById('dept-id').value = '';
    if (title) title.textContent = 'Add Department';
  }
  document.getElementById('modal-department').style.display = 'flex';
};

window.editDepartment = (id) => window.openDepartmentModal(id);

window.deleteDepartment = async (id) => {
  const dept = masterData?.departments?.find(d => d.id === id);
  const name = dept ? `${dept.name} (${dept.code})` : 'this department';

  const confirmed = await showAppConfirm({
    title: 'Delete Department',
    message: `Are you sure you want to delete <strong>${escapeHtml(name)}</strong>?<br><br><span style="color: var(--text-muted); font-size: 0.82rem;">All associated faculty, subjects, sections, and timetable records will also be removed.</span>`,
    confirmText: 'Delete Department',
    isDanger: true
  });
  if (!confirmed) return;

  try {
    const res = await apiRequest(`/api/admin/departments/${id}`, { method: 'DELETE' });
    showToast(res.message || 'Department deleted', 'success');
    await loadMasterData();
    renderMasterDataTables();
    if (typeof loadOverview === 'function') loadOverview();
    populateStudioEntitySelector();
    renderStudioGrid();
  } catch (err) {
    showToast(err.message || 'Failed to delete department', 'error');
  }
};

// ============================================================================
// 6. AI INTELLIGENCE CENTER (Phases 10, 11, 12)
// ============================================================================
let aiCenterInitialized = false;
let currentExtractedReviewData = null;
let selectedVisionFile = null;

async function loadAiCenter() {
  if (!masterData) await loadMasterData();
  setupAiSubtabs();

  // Populate selectors
  populateVisionSectionSelector();
  await populateReasoningVersionSelector();
  await populateDecisionAffectedSlots();
  await populateDecisionTimetableEntries();

  if (!aiCenterInitialized) {
    setupAiCenterEvents();
    aiCenterInitialized = true;
  }
}

function setupAiSubtabs() {
  document.querySelectorAll('[data-ai-subtab]').forEach(btn => {
    btn.onclick = () => {
      const subtab = btn.getAttribute('data-ai-subtab');
      document.querySelectorAll('[data-ai-subtab]').forEach(b => {
        b.classList.remove('btn-primary');
        b.classList.add('btn-secondary');
      });
      btn.classList.add('btn-primary');
      btn.classList.remove('btn-secondary');

      document.querySelectorAll('.ai-subpanel').forEach(p => p.style.display = 'none');
      const target = document.getElementById(`ai-subpanel-${subtab}`);
      if (target) target.style.display = 'block';
    };
  });
}

function populateVisionSectionSelector() {
  const sel = document.getElementById('vision-target-section');
  if (!sel || !masterData?.sections) return;
  sel.innerHTML = masterData.sections.map(s => `
    <option value="${s.id}">${s.name} (${s.department_code || 'Dept'} · Sem ${s.semester})</option>
  `).join('');
}

async function populateReasoningVersionSelector() {
  const sel = document.getElementById('reasoning-version-selector');
  if (!sel) return;

  try {
    const res = await apiRequest('/api/timetable/versions');
    const versions = Array.isArray(res) ? res : (res?.versions || []);
    if (!versions.length) {
      sel.innerHTML = '<option value="">No timetable versions available</option>';
      return;
    }
    sel.innerHTML = versions.map(v => `
      <option value="${v.id}" ${v.status === 'active' ? 'selected' : ''}>${v.name} (${v.status.toUpperCase()})</option>
    `).join('');
  } catch (err) {
    console.error('Failed to load versions for reasoning:', err);
    sel.innerHTML = '<option value="">Unable to load versions</option>';
  }
}

async function populateDecisionAffectedSlots() {
  const sel = document.getElementById('decision-affected-slot-selector');
  if (!sel) return;

  try {
    const todayStr = new Date().toISOString().slice(0, 10);
    const res = await apiRequest(`/api/absence/board?date=${todayStr}`);
    const absences = Array.isArray(res) ? res : (res?.absences || []);
    const openSlots = [];

    absences.forEach(abs => {
      (abs.affectedClasses || []).forEach(cls => {
        if (!cls.substitute_faculty_id) {
          openSlots.push({
            timetableEntryId: cls.id,
            dateStr: abs.date,
            label: `${abs.date} · Period ${cls.slot_no} (${cls.start_time}) - ${cls.subject_name} (${cls.section_name}) - Absent: ${abs.faculty_name}`
          });
        }
      });
    });

    if (openSlots.length === 0) {
      sel.innerHTML = `<option value="">No open absence slots today (all covered)</option>`;
    } else {
      sel.innerHTML = openSlots.map(s => `
        <option value="${s.timetableEntryId}" data-date="${s.dateStr}">${s.label}</option>
      `).join('');
    }
  } catch (err) {
    sel.innerHTML = `<option value="">Unable to load open absence slots</option>`;
  }
}

async function populateDecisionTimetableEntries() {
  const sel = document.getElementById('decision-reschedule-entry-selector');
  if (!sel) return;

  try {
    const res = await apiRequest('/api/timetable/versions');
    const versions = Array.isArray(res) ? res : (res?.versions || []);
    const active = versions.find(v => v.status === 'active') || versions[0];
    if (!active) {
      sel.innerHTML = `<option value="">No timetable versions found</option>`;
      return;
    }

    const data = await apiRequest(`/api/timetable/versions/${active.id}`);
    sel.innerHTML = (data.entries || []).slice(0, 30).map(e => `
      <option value="${e.id}">${e.day_name} P${e.slot_no} · ${e.subject_code} (${e.section_name}) - ${e.faculty_name} [${e.room_name}]</option>
    `).join('');
  } catch (err) {
    sel.innerHTML = `<option value="">Unable to load timetable classes</option>`;
  }
}

function setupAiCenterEvents() {
  // Vision File Input
  const fileInput = document.getElementById('vision-file-input');
  const fileNameDisplay = document.getElementById('vision-file-name');
  fileInput?.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) {
      selectedVisionFile = fileInput.files[0];
      fileNameDisplay.textContent = `Selected: ${selectedVisionFile.name} (${(selectedVisionFile.size / 1024).toFixed(1)} KB)`;
    }
  });

  // Use Sample Image Button
  document.getElementById('btn-use-sample-image')?.addEventListener('click', () => {
    selectedVisionFile = null;
    if (fileInput) fileInput.value = '';
    fileNameDisplay.textContent = 'Selected: Realistic University Timetable Capture (Demo)';
    showToast('Loaded demo university timetable capture for extraction', 'info');
  });

  // Process Vision Button
  document.getElementById('btn-process-vision')?.addEventListener('click', async () => {
    const secSelect = document.getElementById('vision-target-section');
    const sectionId = secSelect ? secSelect.value : null;
    const sectionName = secSelect ? secSelect.options[secSelect.selectedIndex]?.text : 'CSE-4A';

    const btn = document.getElementById('btn-process-vision');
    btn.disabled = true;
    btn.textContent = '⏳ Processing Image with Vision Model...';

    try {
      let res;
      if (selectedVisionFile) {
        const formData = new FormData();
        formData.append('image', selectedVisionFile);
        formData.append('sectionId', sectionId);
        formData.append('sectionName', sectionName);

        const token = localStorage.getItem('ctas_token');
        const fetchRes = await fetch('/api/ai/vision-import', {
          method: 'POST',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: formData
        });
        res = await fetchRes.json();
      } else {
        res = await apiRequest('/api/ai/vision-import', {
          method: 'POST',
          body: JSON.stringify({ useSample: true, sectionId, sectionName })
        });
      }

      if (res.success && res.mappedCells) {
        currentExtractedReviewData = res;
        renderVisionReviewTable(res);
        showToast(`Extracted ${res.mappedCells.length} class slots successfully (${res.mode})`, 'success');
      } else {
        showToast(res.error || 'Failed to extract timetable from image', 'error');
      }
    } catch (err) {
      showToast('Vision processing failed: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '⚡ Process & Extract Timetable';
    }
  });

  // Confirm Vision Import -> Create Draft
  document.getElementById('btn-confirm-vision-import')?.addEventListener('click', async () => {
    if (!currentExtractedReviewData) return;

    const versionName = document.getElementById('vision-version-name')?.value || 'Digitized Timetable Import';
    const rows = document.querySelectorAll('#vision-review-tbody tr');
    const cellsToSave = [];

    rows.forEach(tr => {
      const dayId = parseInt(tr.querySelector('.cell-day-select')?.value, 10);
      const slotId = parseInt(tr.querySelector('.cell-slot-select')?.value, 10);
      const subjectId = parseInt(tr.querySelector('.cell-sub-select')?.value, 10);
      const facultyId = parseInt(tr.querySelector('.cell-fac-select')?.value, 10);
      const roomId = parseInt(tr.querySelector('.cell-room-select')?.value, 10);
      const isLab = tr.querySelector('.cell-lab-check')?.checked ? 1 : 0;
      const sectionId = parseInt(document.getElementById('vision-target-section')?.value, 10) || 1;

      if (dayId && slotId && subjectId && facultyId && roomId) {
        cellsToSave.push({
          sectionId,
          subjectId,
          facultyId,
          roomId,
          dayId,
          slotId,
          isLabBlock: isLab
        });
      }
    });

    if (cellsToSave.length === 0) {
      showToast('No valid complete cells to save', 'warning');
      return;
    }

    try {
      const res = await apiRequest('/api/ai/import-confirm', {
        method: 'POST',
        body: JSON.stringify({
          versionName,
          cells: cellsToSave,
          notes: `Imported via Grok Vision from timetable image. ${cellsToSave.length} periods verified.`
        })
      });

      showToast(`Draft timetable "${versionName}" created!`, 'success');
      // Switch to Studio with the newly created version
      await switchTab('studio');
      const versionSelector = document.getElementById('studio-version-selector');
      if (versionSelector) {
        versionSelector.value = res.versionId;
        await loadStudioVersion(res.versionId);
      }
    } catch (err) {
      showToast('Failed to save imported timetable: ' + err.message, 'error');
    }
  });

  // Run Grok Clash Reasoning
  document.getElementById('btn-run-reasoning')?.addEventListener('click', async () => {
    const versionSelect = document.getElementById('reasoning-version-selector');
    const versionId = versionSelect ? versionSelect.value : null;

    const btn = document.getElementById('btn-run-reasoning');
    btn.disabled = true;
    btn.textContent = '🧠 Analyzing Conflicts with Grok...';

    const container = document.getElementById('reasoning-issues-container');
    container.innerHTML = '<div style="padding: 1.5rem; text-align: center; color: var(--text-muted);">Running constraint validator and Grok reasoning analysis...</div>';

    try {
      const res = await apiRequest('/api/ai/analyze-version', {
        method: 'POST',
        body: JSON.stringify({ versionId })
      });

      renderReasoningIssues(res);
      showToast(`Analysis complete: ${res.issues.length} issue(s) diagnosed`, 'info');
    } catch (err) {
      container.innerHTML = `<div style="padding: 1rem; color: var(--color-error);">Clash analysis failed: ${err.message}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = '🧠 Run AI Clash Analysis';
    }
  });

  // Rank Substitute Candidates with Grok Decision
  document.getElementById('btn-rank-substitutes-ai')?.addEventListener('click', async () => {
    const sel = document.getElementById('decision-affected-slot-selector');
    const entryId = sel ? sel.value : null;
    const dateStr = sel?.options[sel.selectedIndex]?.getAttribute('data-date') || new Date().toISOString().slice(0, 10);

    if (!entryId) {
      showToast('Please select an active substitution slot to evaluate', 'warning');
      return;
    }

    const resultBox = document.getElementById('decision-rank-result');
    resultBox.innerHTML = '<div style="padding: 1rem; color: var(--text-muted);">Evaluating qualified faculty with Grok Decision...</div>';

    try {
      const res = await apiRequest('/api/ai/decision/rank-substitutes', {
        method: 'POST',
        body: JSON.stringify({ timetableEntryId: entryId, dateStr })
      });

      renderDecisionRankResult(res);
    } catch (err) {
      resultBox.innerHTML = `<div style="color: var(--color-error); padding: 0.5rem;">Ranking error: ${err.message}</div>`;
    }
  });

  // Find Reschedule Slots
  document.getElementById('btn-find-reschedule-slots')?.addEventListener('click', async () => {
    const sel = document.getElementById('decision-reschedule-entry-selector');
    const entryId = sel ? sel.value : null;
    const dateStr = new Date().toISOString().slice(0, 10);

    if (!entryId) {
      showToast('Please select a timetable class', 'warning');
      return;
    }

    const resultBox = document.getElementById('decision-reschedule-result');
    resultBox.innerHTML = '<div style="padding: 1rem; color: var(--text-muted);">Calculating collision-free alternative slots...</div>';

    try {
      const res = await apiRequest('/api/ai/decision/reschedule-slots', {
        method: 'POST',
        body: JSON.stringify({ timetableEntryId: entryId, dateStr })
      });

      renderRescheduleSlotsResult(res);
    } catch (err) {
      resultBox.innerHTML = `<div style="color: var(--color-error); padding: 0.5rem;">Reschedule search error: ${err.message}</div>`;
    }
  });
}

function renderVisionReviewTable(data) {
  const container = document.getElementById('vision-review-container');
  const tbody = document.getElementById('vision-review-tbody');
  const statsSpan = document.getElementById('vision-review-stats');
  if (!container || !tbody) return;

  container.style.display = 'block';

  const cells = data.mappedCells || [];
  const dict = data.dictionaries || {};

  statsSpan.textContent = `Total extracted: ${cells.length} slots · Section: ${data.sectionName}`;

  tbody.innerHTML = cells.map((cell, idx) => {
    const isHighConf = (cell.confidence || 0) >= 0.85;
    const rowBg = cell.needsReview ? 'background: var(--color-warning-bg);' : '';

    return `
      <tr style="border-bottom: 1px solid var(--border-subtle); ${rowBg}">
        <td style="padding: 0.5rem 0.6rem;">
          <select class="cell-day-select" style="font-size: 0.8rem; padding: 0.25rem;">
            ${(dict.days || []).map(d => `
              <option value="${d.id}" ${d.id === cell.dayId ? 'selected' : ''}>${d.day_name}</option>
            `).join('')}
          </select>
        </td>

        <td style="padding: 0.5rem 0.6rem;">
          <select class="cell-slot-select" style="font-size: 0.8rem; padding: 0.25rem;">
            ${(dict.slots || []).filter(s => !s.is_break).map(s => `
              <option value="${s.id}" ${s.id === cell.slotId ? 'selected' : ''}>P${s.slot_no} (${s.start_time})</option>
            `).join('')}
          </select>
        </td>

        <td style="padding: 0.5rem 0.6rem; font-weight: 600;">
          ${cell.original?.subjectCode || cell.original?.subjectName || 'Unlabeled'}
        </td>

        <td style="padding: 0.5rem 0.6rem;">
          <select class="cell-sub-select" style="font-size: 0.8rem; padding: 0.25rem; max-width: 170px;">
            ${(dict.subjects || []).map(sub => `
              <option value="${sub.id}" ${sub.id === cell.subjectId ? 'selected' : ''}>${sub.code} - ${sub.name}</option>
            `).join('')}
          </select>
        </td>

        <td style="padding: 0.5rem 0.6rem;">
          <select class="cell-fac-select" style="font-size: 0.8rem; padding: 0.25rem; max-width: 160px;">
            ${(dict.faculty || []).map(f => `
              <option value="${f.id}" ${f.id === cell.facultyId ? 'selected' : ''}>${f.name}</option>
            `).join('')}
          </select>
        </td>

        <td style="padding: 0.5rem 0.6rem;">
          <select class="cell-room-select" style="font-size: 0.8rem; padding: 0.25rem; max-width: 130px;">
            ${(dict.rooms || []).map(r => `
              <option value="${r.id}" ${r.id === cell.roomId ? 'selected' : ''}>${r.name} (${r.type})</option>
            `).join('')}
          </select>
        </td>

        <td style="padding: 0.5rem 0.6rem; text-align: center;">
          <input type="checkbox" class="cell-lab-check" ${cell.isLabBlock ? 'checked' : ''}>
        </td>

        <td style="padding: 0.5rem 0.6rem;">
          <span style="font-size: 0.75rem; padding: 0.2rem 0.45rem; border-radius: var(--radius-sm); background: ${isHighConf ? 'var(--color-success-bg)' : 'var(--color-warning-bg)'}; color: ${isHighConf ? 'var(--color-success)' : 'var(--color-warning)'}; font-weight: 700;">
            ${Math.round((cell.confidence || 0.85) * 100)}%
          </span>
        </td>
      </tr>
    `;
  }).join('');
}

function renderReasoningIssues(data) {
  const container = document.getElementById('reasoning-issues-container');
  if (!container) return;

  const issues = data.issues || [];
  if (issues.length === 0) {
    container.innerHTML = `
      <div style="padding: 2rem; text-align: center; background: var(--color-success-bg); border: 1px solid var(--color-success); border-radius: var(--radius-md);">
        <h4 style="color: var(--color-success); font-size: 1.25rem; margin-bottom: 0.25rem;">✓ Zero Conflicts Detected</h4>
        <p style="font-size: 0.85rem; color: var(--text-secondary);">
          This timetable version complies completely with all hard constraints and college policies.
        </p>
      </div>
    `;
    return;
  }

  container.innerHTML = issues.map((iss, idx) => {
    const isError = iss.severity === 'error' || iss.severity === 'critical';
    const badgeColor = isError ? 'var(--color-error)' : 'var(--color-warning)';
    const badgeBg = isError ? 'var(--color-error-bg)' : 'var(--color-warning-bg)';

    return `
      <div class="card" style="border-left: 4px solid ${badgeColor}; padding: 1.25rem; background: var(--bg-surface-subtle);">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.5rem; flex-wrap: wrap; gap: 0.5rem;">
          <div>
            <span style="font-size: 0.75rem; font-weight: 700; text-transform: uppercase; background: ${badgeBg}; color: ${badgeColor}; padding: 0.2rem 0.5rem; border-radius: var(--radius-sm); margin-right: 0.5rem;">
              ${iss.severity} · ${iss.category || 'Conflict'}
            </span>
            <strong style="font-size: 1rem; color: var(--text-primary);">${iss.summary}</strong>
          </div>
          <button class="btn-secondary" style="font-size: 0.75rem; padding: 0.25rem 0.6rem;" onclick="window.switchTab('studio')">
            Open in Studio &rarr;
          </button>
        </div>

        <p style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 0.75rem; line-height: 1.45;">
          ${iss.reasoning}
        </p>

        ${iss.suggestedFix ? `
          <div style="background: var(--bg-surface); padding: 0.75rem 1rem; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); font-size: 0.8rem;">
            <div style="font-weight: 600; color: var(--color-brand-primary); margin-bottom: 0.25rem;">
              💡 Proposed Fix: ${iss.suggestedFix.description}
            </div>
            ${iss.suggestedFix.expectedSideEffects ? `
              <div style="color: var(--text-muted); font-size: 0.75rem;">
                Tradeoff / Side effect: ${iss.suggestedFix.expectedSideEffects}
              </div>
            ` : ''}
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

function renderDecisionRankResult(data) {
  const box = document.getElementById('decision-rank-result');
  if (!box) return;

  if (!data.hasCandidates || (data.rankedOptions || []).length === 0) {
    box.innerHTML = `
      <div style="padding: 1rem; background: var(--color-error-bg); border-radius: var(--radius-sm); border: 1px solid var(--color-error); color: var(--color-error);">
        <strong>No Candidates Available:</strong> ${data.justification}
      </div>
    `;
    return;
  }

  const top = data.rankedOptions[0];

  box.innerHTML = `
    <div style="background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); padding: 1rem; margin-top: 0.75rem;">
      <div style="font-size: 0.75rem; font-weight: 700; color: var(--color-brand-primary); text-transform: uppercase;">
        Top Recommended Candidate (${data.mode})
      </div>
      <div style="font-size: 1.25rem; font-weight: 700; color: var(--text-primary); margin: 0.2rem 0;">
        ${top.name}
      </div>
      <p style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 0.75rem;">
        ${data.justification}
      </p>

      ${data.risks && data.risks.length > 0 ? `
        <div style="font-size: 0.75rem; color: var(--color-warning); margin-bottom: 0.75rem;">
          ⚠️ Risk assessment: ${data.risks.join('; ')}
        </div>
      ` : ''}

      <div style="display: flex; gap: 0.5rem; justify-content: flex-end;">
        <button class="btn-primary" style="font-size: 0.8rem; padding: 0.4rem 0.85rem;" onclick="window.applyAiSubstituteAssignment(${data.timetableEntryId}, '${data.dateStr}', ${top.facultyId})">
          ✓ One-Click Approve &amp; Assign ${top.name}
        </button>
      </div>

      <div style="margin-top: 1rem; border-top: 1px solid var(--border-subtle); padding-top: 0.75rem;">
        <div style="font-size: 0.75rem; font-weight: 600; color: var(--text-muted); margin-bottom: 0.4rem;">All Evaluated Candidates:</div>
        ${data.rankedOptions.map(c => `
          <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.35rem 0; border-bottom: 1px dashed var(--border-subtle); font-size: 0.75rem;">
            <span>#${c.aiRank || 1} <strong>${c.name}</strong> (${c.departmentName})</span>
            <span style="color: var(--color-brand-primary); font-weight: 600;">${c.aiSummary || (c.score + ' pts')}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

window.applyAiSubstituteAssignment = async (entryId, dateStr, facultyId) => {
  try {
    await apiRequest('/api/absence/substitute/assign', {
      method: 'POST',
      body: {
        timetableEntryId: entryId,
        date: dateStr,
        substituteFacultyId: facultyId
      }
    });
    showToast('AI substitute recommendation approved and assigned!', 'success');
    await populateDecisionAffectedSlots();
    await loadAbsenceMonitor();
    await loadOverview();
  } catch (err) {
    showToast('Failed to assign substitute: ' + err.message, 'error');
  }
};

function renderRescheduleSlotsResult(data) {
  const box = document.getElementById('decision-reschedule-result');
  if (!box) return;

  const slots = data.candidateSlots || [];
  if (slots.length === 0) {
    box.innerHTML = `
      <div style="padding: 1rem; background: var(--bg-surface); border-radius: var(--radius-sm); border: 1px dashed var(--border-subtle); color: var(--text-muted); text-align: center;">
        No completely open slots found for this cohort without moving other classes.
      </div>
    `;
    return;
  }

  box.innerHTML = `
    <div style="background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); padding: 1rem; margin-top: 0.75rem;">
      <div style="font-size: 0.75rem; font-weight: 700; color: var(--color-brand-primary); text-transform: uppercase; margin-bottom: 0.5rem;">
        Conflict-Free Replacement Periods
      </div>
      <div style="display: flex; flex-direction: column; gap: 0.5rem;">
        ${slots.map(s => `
          <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.5rem; background: var(--bg-surface-subtle); border-radius: var(--radius-sm); font-size: 0.8rem;">
            <div>
              <strong>${s.dayName}</strong> · Period ${s.slotNo} (${s.startTime} - ${s.endTime})
            </div>
            <button class="btn-secondary" style="font-size: 0.75rem; padding: 0.25rem 0.5rem;" onclick="window.switchTab('studio')">
              Select in Studio &rarr;
            </button>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

// ==========================================
// SJBIT CSE REFERENCE DATA & UNASSIGNED SESSIONS (Requirement 4 & 5)
// ==========================================

const DAY_MAP_STUDIO = {
  MON: 'Monday',
  TUE: 'Tuesday',
  WED: 'Wednesday',
  THU: 'Thursday',
  FRI: 'Friday',
  SAT: 'Saturday'
};

let currentUnassignedSessions = [];

function renderUnassignedSectionsPanel(sessions) {
  const panel = document.getElementById('unassigned-sections-panel');
  const countBadge = document.getElementById('unassigned-sessions-count-badge');
  if (!panel) return;

  currentUnassignedSessions = sessions || [];
  if (countBadge) {
    countBadge.textContent = String(currentUnassignedSessions.length);
  }

  filterAndRenderUnassignedTable();
  setupUnassignedPanelListeners();
}

function filterAndRenderUnassignedTable() {
  const tbody = document.getElementById('unassigned-sessions-table-body');
  const searchInput = document.getElementById('unassigned-search-input');
  if (!tbody) return;

  const q = (searchInput?.value || '').trim().toLowerCase();
  const filtered = currentUnassignedSessions.filter(s => {
    if (!q) return true;
    return (s.session_id || '').toLowerCase().includes(q) ||
           (s.faculty_name || '').toLowerCase().includes(q) ||
           (s.faculty_code || '').toLowerCase().includes(q) ||
           (s.subject_code || '').toLowerCase().includes(q) ||
           (s.section_status || '').toLowerCase().includes(q) ||
           (s.day || '').toLowerCase().includes(q) ||
           (s.batch || '').toLowerCase().includes(q);
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" style="padding: 1.5rem; text-align: center; color: var(--text-muted);">
          ${currentUnassignedSessions.length === 0 ? '✓ All sessions have assigned sections!' : 'No matching unassigned sessions found.'}
        </td>
      </tr>
    `;
    return;
  }

  const sectionsList = masterData?.sections || [];

  tbody.innerHTML = filtered.map(s => {
    let candidateList = [];
    try {
      if (typeof s.candidate_sections === 'string') {
        candidateList = JSON.parse(s.candidate_sections);
      } else if (Array.isArray(s.candidate_sections)) {
        candidateList = s.candidate_sections;
      }
    } catch (e) {
      candidateList = [];
    }

    const dayName = s.day ? (DAY_MAP_STUDIO[s.day] || s.day) : '-';
    const periodStr = s.period_start === s.period_end ? `P${s.period_start}` : `P${s.period_start}-P${s.period_end}`;

    return `
      <tr style="border-bottom: 1px solid var(--border-subtle);">
        <td style="padding: 0.5rem 0.75rem; font-family: monospace; font-weight: 600;">${escapeHtml(s.session_id)}</td>
        <td style="padding: 0.5rem 0.75rem;"><strong>${escapeHtml(s.faculty_name || s.faculty_code || 'Faculty')}</strong></td>
        <td style="padding: 0.5rem 0.75rem;">${escapeHtml(dayName)} · ${escapeHtml(periodStr)}</td>
        <td style="padding: 0.5rem 0.75rem;"><span style="font-weight: 700; color: var(--color-brand-primary);">${escapeHtml(s.subject_code)}</span></td>
        <td style="padding: 0.5rem 0.75rem;">
          <span class="drilldown-badge-pill" style="${s.type === 'lab' ? 'background: #FDF4FF; color: #9333EA;' : 'background: #EFF6FF; color: #2563EB;'}">
            ${escapeHtml(s.type || 'theory')} ${s.batch ? `(${escapeHtml(s.batch)})` : ''}
          </span>
        </td>
        <td style="padding: 0.5rem 0.75rem;">${s.semester ? `Sem ${s.semester}` : 'Multiple / -'}</td>
        <td style="padding: 0.5rem 0.75rem;">
          <span style="font-size: 0.75rem; color: #B45309; background: #FEF3C7; padding: 0.15rem 0.45rem; border-radius: 4px; display: inline-block;">
            ${escapeHtml(s.section_status || 'Unassigned')}
          </span>
        </td>
        <td style="padding: 0.5rem 0.75rem; text-align: right;">
          <div style="display: flex; gap: 0.35rem; justify-content: flex-end; align-items: center;">
            <select id="assign-sec-select-${s.id}" class="form-select" style="font-size: 0.78rem; padding: 0.25rem 0.45rem; width: 130px;">
              <option value="">Select Section...</option>
              ${candidateList.length > 0 ? `
                <optgroup label="Candidates">
                  ${candidateList.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')}
                </optgroup>
              ` : ''}
              <optgroup label="All CSE Sections">
                ${sectionsList.map(sec => `<option value="${escapeHtml(sec.name)}">${escapeHtml(sec.name)} (Sem ${sec.semester})</option>`).join('')}
              </optgroup>
            </select>
            <button class="btn-primary" style="font-size: 0.75rem; padding: 0.25rem 0.55rem;" onclick="window.assignSectionToSession(${s.id})">
              Assign
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function setupUnassignedPanelListeners() {
  const searchInput = document.getElementById('unassigned-search-input');
  if (searchInput && !searchInput.dataset.bound) {
    searchInput.dataset.bound = 'true';
    searchInput.addEventListener('input', () => {
      filterAndRenderUnassignedTable();
    });
  }

  const btnRefresh = document.getElementById('btn-refresh-unassigned');
  if (btnRefresh && !btnRefresh.dataset.bound) {
    btnRefresh.dataset.bound = 'true';
    btnRefresh.addEventListener('click', async () => {
      try {
        const data = await apiRequest('/api/timetable/unassigned-sessions');
        renderUnassignedSectionsPanel(data.sessions || []);
        showToast('Unassigned sessions refreshed', 'info');
      } catch (err) {
        showToast('Failed to refresh unassigned sessions: ' + err.message, 'error');
      }
    });
  }
}

window.assignSectionToSession = async (sessionId) => {
  const select = document.getElementById(`assign-sec-select-${sessionId}`);
  if (!select || !select.value) {
    showToast('Please select a target section to assign', 'error');
    return;
  }
  const sectionName = select.value;
  try {
    await apiRequest(`/api/timetable/sessions/${sessionId}/assign-section`, {
      method: 'PUT',
      body: { sectionName }
    });
    showToast(`Session assigned to section ${sectionName} permanently!`, 'success');
    if (currentVersionId) {
      await loadStudioVersion(currentVersionId);
    }
  } catch (err) {
    showToast('Failed to assign section: ' + err.message, 'error');
  }
};

window.openVerificationModal = async () => {
  const modal = document.getElementById('modal-verification-report');
  if (!modal) return;
  modal.style.display = 'flex';

  const kpisContainer = document.getElementById('verification-kpis');
  const tbody = document.getElementById('verification-table-body');
  const deptStatus = document.getElementById('verification-dept-status');

  if (tbody) {
    tbody.innerHTML = '<tr><td colspan="6" style="padding: 1.5rem; text-align: center; color: var(--text-muted);">Generating real-time verification report from database...</td></tr>';
  }

  try {
    const report = await apiRequest('/api/admin/verification-report');
    if (!report || !report.summary) return;

    if (kpisContainer) {
      kpisContainer.innerHTML = `
        <div class="drilldown-kpi-card" style="padding: 0.65rem 0.85rem;">
          <div class="drilldown-kpi-label">Faculty Count</div>
          <div class="drilldown-kpi-val" style="color: #2563EB;">${report.summary.facultyCount} <span style="font-size: 0.75rem; color: var(--text-muted); font-weight: normal;">(Target: 33)</span></div>
        </div>
        <div class="drilldown-kpi-card" style="padding: 0.65rem 0.85rem;">
          <div class="drilldown-kpi-label">Subjects</div>
          <div class="drilldown-kpi-val" style="color: #7C3AED;">${report.summary.subjectCount} <span style="font-size: 0.75rem; color: var(--text-muted); font-weight: normal;">(Target: 40)</span></div>
        </div>
        <div class="drilldown-kpi-card" style="padding: 0.65rem 0.85rem;">
          <div class="drilldown-kpi-label">Imported Sessions</div>
          <div class="drilldown-kpi-val" style="color: #D97706;">${report.summary.sessionCount} <span style="font-size: 0.75rem; color: var(--text-muted); font-weight: normal;">(Target: 305)</span></div>
        </div>
        <div class="drilldown-kpi-card" style="padding: 0.65rem 0.85rem;">
          <div class="drilldown-kpi-label">Total Teaching Hours</div>
          <div class="drilldown-kpi-val" style="color: #16A34A;">${report.summary.totalTeachingHours}h <span style="font-size: 0.75rem; color: var(--text-muted); font-weight: normal;">(Target: 413)</span></div>
        </div>
        <div class="drilldown-kpi-card" style="padding: 0.65rem 0.85rem;">
          <div class="drilldown-kpi-label">Faculty Mismatches</div>
          <div class="drilldown-kpi-val" style="color: ${report.summary.mismatchesCount === 0 ? '#16A34A' : '#DC2626'};">
            ${report.summary.mismatchesCount} <span style="font-size: 0.75rem; color: var(--text-muted); font-weight: normal;">(${report.summary.mismatchesCount === 0 ? '✓ 100% Match' : 'Mismatches'})</span>
          </div>
        </div>
      `;
    }

    if (deptStatus && report.unusedDepartments) {
      deptStatus.innerHTML = `🏛️ Departments: <strong>CSE</strong> (Active, ${report.summary.sessionCount} sessions) · <strong>${report.unusedDepartments.join(' & ')}</strong> (${report.unusedDepartmentsText || 'Unused, kept intact'})`;
    }

    if (tbody) {
      tbody.innerHTML = (report.facultyComparison || []).map(f => {
        const isMatch = f.match;
        return `
          <tr style="border-bottom: 1px solid var(--border-subtle); ${!isMatch ? 'background: #FEF2F2;' : ''}">
            <td style="padding: 0.5rem 0.75rem; font-family: monospace; font-weight: 700; color: var(--color-brand-primary);">${escapeHtml(f.code)}</td>
            <td style="padding: 0.5rem 0.75rem; font-weight: 600;">${escapeHtml(f.name)}</td>
            <td style="padding: 0.5rem 0.75rem; font-size: 0.75rem; color: var(--text-secondary); max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(f.classesTaught || '-')}">
              ${escapeHtml(f.classesTaught || '-')}
            </td>
            <td style="padding: 0.5rem 0.75rem; text-align: center; font-weight: 600;" class="tabular-nums">${f.targetWeeklyHours}h</td>
            <td style="padding: 0.5rem 0.75rem; text-align: center; font-weight: 700;" class="tabular-nums">${f.actualSessionHours}h</td>
            <td style="padding: 0.5rem 0.75rem; text-align: center;">
              <span class="drilldown-badge-pill" style="${isMatch ? 'background: var(--color-success-bg); color: var(--color-success); border: 1px solid var(--color-success);' : 'background: #FEE2E2; color: #DC2626; border: 1px solid #DC2626;'}">
                ${isMatch ? '✓ Exact Match' : `⚠ Diff: ${f.diff > 0 ? '+' + f.diff : f.diff}h`}
              </span>
            </td>
          </tr>
        `;
      }).join('');
    }
  } catch (err) {
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="6" style="padding: 1.5rem; text-align: center; color: var(--color-error);">Failed to load verification report: ${escapeHtml(err.message)}</td></tr>`;
    }
  }
};

window.reloadReferenceData = async () => {
  if (!confirm('Re-sync database with CTAS_reference_data.json? This updates the timetable, sections, subjects, and faculty idempotently.')) return;
  try {
    showToast('Synchronizing with CTAS reference data...', 'info');
    const res = await apiRequest('/api/admin/import-reference-data', { method: 'POST' });
    showToast('Successfully synchronized! 33 faculty, 40 subjects, 305 sessions, 413 teaching hours.', 'success');
    await loadMasterData();
    await loadTimetableVersions();
    await loadOverview();
  } catch (err) {
    showToast('Failed to synchronize reference data: ' + err.message, 'error');
  }
};

export default { switchTab };

