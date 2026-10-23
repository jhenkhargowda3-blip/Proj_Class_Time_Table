import { apiRequest } from '/js/api.js';
import { checkSession, logout } from '/js/auth.js';
import { showToast } from '/js/toast.js';
import { initSSE, onEvent } from '/js/sse.js';
import { printOrExportPdf, exportToIcs, downloadFile } from '/js/exportUtils.js';

let currentTab = 'overview';
let activeVersionId = null;
let currentVersionData = null;
let masterData = null;
let studioMode = 'section'; // 'section' | 'faculty' | 'room'
let studioEntityId = null;
let draggedEntryId = null;

// CSP Timetable Generation Progress Tracker State
let isGenerationRunning = false;
let generationStartTime = null;
let generationTimerInterval = null;

document.addEventListener('DOMContentLoaded', async () => {
  const user = await checkSession('admin');
  if (!user) return;

  // Initialize SSE for real-time live sync
  initSSE('/api/events');
  onEvent('timetable.updated', (data) => {
    showToast(`Timetable event: ${data.type}`, 'info');
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
    if (currentTab === 'absence') loadAbsenceMonitor();
    if (currentTab === 'overview') loadOverview();
  });
  onEvent('substitution:claimed', (data) => {
    showToast(`Substitution claimed: ${data.substituteFacultyName} for ${data.subjectName}`, 'success');
    if (currentTab === 'absence') loadAbsenceMonitor();
    if (currentTab === 'overview') loadOverview();
  });
  onEvent('substitution:assigned', (data) => {
    showToast(`Substitution assigned: ${data.substituteFacultyName} for ${data.subjectName}`, 'info');
    if (currentTab === 'absence') loadAbsenceMonitor();
    if (currentTab === 'overview') loadOverview();
  });

  setupNavigation();
  setupModals();
  await checkGenerationStatus();
  await loadOverview();
  await loadMasterData();
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

export function switchTab(tab) {
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
  if (tab === 'studio') loadStudio();
  if (tab === 'master-data') renderMasterDataTables();
  if (tab === 'availability') loadAvailabilityEditor();
  if (tab === 'assignments') loadAssignments();
  if (tab === 'absence') loadAbsenceMonitor();
  if (tab === 'ai-center') loadAiCenter();
}

window.switchTab = switchTab;


// 1. Overview Loader
async function loadOverview() {
  try {
    const data = await apiRequest('/api/admin/overview');
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
  // 1. Faculty Search Bar
  const facultySearchInput = document.getElementById('faculty-search-input');
  const facultySearchClear = document.getElementById('btn-faculty-search-clear');

  facultySearchInput?.addEventListener('input', () => {
    applyFacultySearch();
  });

  facultySearchClear?.addEventListener('click', () => {
    if (facultySearchInput) {
      facultySearchInput.value = '';
      applyFacultySearch();
      facultySearchInput.focus();
    }
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
}

function applyFacultySearch() {
  if (!masterData?.faculty) return;
  const searchInput = document.getElementById('faculty-search-input');
  const q = (searchInput?.value || '').trim().toLowerCase();

  if (!q) {
    renderFacultyTable(masterData.faculty);
    return;
  }

  const filtered = masterData.faculty.filter(f => {
    const name = (f.name || '').toLowerCase();
    const email = (f.email || '').toLowerCase();
    const phone = (f.phone || '').toLowerCase();
    const deptCode = (f.department_code || '').toLowerCase();
    const deptName = (f.department_name || '').toLowerCase();
    return name.includes(q) || email.includes(q) || phone.includes(q) || deptCode.includes(q) || deptName.includes(q);
  });

  renderFacultyTable(filtered);
}

function renderFacultyTable(facultyList = masterData?.faculty || []) {
  const facTable = document.getElementById('table-faculty-body');
  const countLabel = document.getElementById('faculty-search-count');
  const clearBtn = document.getElementById('btn-faculty-search-clear');
  const searchInput = document.getElementById('faculty-search-input');

  const total = masterData?.faculty?.length || 0;
  if (countLabel) {
    if (searchInput && searchInput.value.trim()) {
      countLabel.textContent = `Showing ${facultyList.length} of ${total} faculty`;
      if (clearBtn) clearBtn.style.display = 'inline-block';
    } else {
      countLabel.textContent = `Showing all ${total} faculty members`;
      if (clearBtn) clearBtn.style.display = 'none';
    }
  }

  if (!facTable) return;

  if (facultyList.length === 0) {
    facTable.innerHTML = `
      <tr style="border-bottom: 1px solid var(--border-subtle);">
        <td colspan="6" style="padding: 2rem; text-align: center; color: var(--text-muted); background: var(--bg-surface-subtle);">
          🔍 No faculty members match "<strong>${escapeHtml(searchInput?.value || '')}</strong>".
        </td>
      </tr>
    `;
    return;
  }

  facTable.innerHTML = facultyList.map(f => `
    <tr style="border-bottom: 1px solid var(--border-subtle);">
      <td style="padding: 0.6rem 0.75rem; font-weight: 600;">${f.name}</td>
      <td style="padding: 0.6rem 0.75rem;"><span style="background: var(--bg-surface-subtle); padding: 0.15rem 0.4rem; border-radius: 4px; font-weight: 600;">${f.department_code}</span> ${f.department_name}</td>
      <td style="padding: 0.6rem 0.75rem;">${f.email || '—'}</td>
      <td style="padding: 0.6rem 0.75rem;">${f.phone || '—'}</td>
      <td style="padding: 0.6rem 0.75rem;" class="tabular-nums">${f.max_periods_per_day} / day · ${f.max_periods_per_week} / wk</td>
      <td style="padding: 0.6rem 0.75rem; text-align: right;">
        <button class="btn-secondary" style="font-size: 0.75rem; padding: 0.25rem 0.5rem;" onclick="window.editFaculty(${f.id})">Edit</button>
        <button class="btn-secondary" style="font-size: 0.75rem; padding: 0.25rem 0.5rem; color: var(--color-error);" onclick="window.deleteFaculty(${f.id})">Delete</button>
      </td>
    </tr>
  `).join('');
}

function renderMasterDataTables() {
  if (!masterData) return;

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

  // 1. Faculty with search filtering
  applyFacultySearch();

  // 2. Subjects
  const subTable = document.getElementById('table-subjects-body');
  if (subTable) {
    subTable.innerHTML = masterData.subjects.map(s => `
      <tr style="border-bottom: 1px solid var(--border-subtle);">
        <td style="padding: 0.6rem 0.75rem; font-weight: 700; color: var(--color-brand-primary);">${s.code}</td>
        <td style="padding: 0.6rem 0.75rem; font-weight: 600;">${s.name}</td>
        <td style="padding: 0.6rem 0.75rem;">${s.department_code}</td>
        <td style="padding: 0.6rem 0.75rem;">Sem ${s.semester}</td>
        <td style="padding: 0.6rem 0.75rem;"><span style="text-transform: capitalize; background: var(--bg-surface-subtle); padding: 0.15rem 0.45rem; border-radius: 4px;">${s.type}</span> ${s.type === 'lab' ? `(${s.lab_block_length}p block)` : ''}</td>
        <td style="padding: 0.6rem 0.75rem;" class="tabular-nums">${s.weekly_periods} periods</td>
        <td style="padding: 0.6rem 0.75rem; text-align: right;">
          <button class="btn-secondary" style="font-size: 0.75rem; padding: 0.25rem 0.5rem;" onclick="window.editSubject(${s.id})">Edit</button>
          <button class="btn-secondary" style="font-size: 0.75rem; padding: 0.25rem 0.5rem; color: var(--color-error);" onclick="window.deleteSubject(${s.id})">Delete</button>
        </td>
      </tr>
    `).join('');
  }

  // 3. Rooms
  const roomTable = document.getElementById('table-rooms-body');
  if (roomTable) {
    roomTable.innerHTML = masterData.rooms.map(r => `
      <tr style="border-bottom: 1px solid var(--border-subtle);">
        <td style="padding: 0.6rem 0.75rem; font-weight: 600;">${r.name}</td>
        <td style="padding: 0.6rem 0.75rem;"><span style="text-transform: capitalize; background: var(--bg-surface-subtle); padding: 0.15rem 0.45rem; border-radius: 4px;">${r.type}</span></td>
        <td style="padding: 0.6rem 0.75rem;" class="tabular-nums">${r.capacity} seats</td>
        <td style="padding: 0.6rem 0.75rem;"><span style="color: var(--color-success); font-weight: 600;">● Active</span></td>
        <td style="padding: 0.6rem 0.75rem; text-align: right;">
          <button class="btn-secondary" style="font-size: 0.75rem; padding: 0.25rem 0.5rem;" onclick="window.editRoom(${r.id})">Edit</button>
          <button class="btn-secondary" style="font-size: 0.75rem; padding: 0.25rem 0.5rem; color: var(--color-error);" onclick="window.deleteRoom(${r.id})">Delete</button>
        </td>
      </tr>
    `).join('');
  }

  // 4. Sections
  const secTable = document.getElementById('table-sections-body');
  if (secTable) {
    secTable.innerHTML = (masterData.sections || []).map(sec => `
      <tr style="border-bottom: 1px solid var(--border-subtle);">
        <td style="padding: 0.6rem 0.75rem; font-weight: 700; color: var(--color-brand-primary);">${sec.name}</td>
        <td style="padding: 0.6rem 0.75rem;">${sec.department_name} (${sec.department_code})</td>
        <td style="padding: 0.6rem 0.75rem;">Semester ${sec.semester}</td>
        <td style="padding: 0.6rem 0.75rem;" class="tabular-nums">${sec.strength} students</td>
        <td style="padding: 0.6rem 0.75rem; text-align: right;">
          <button class="btn-secondary" style="font-size: 0.75rem; padding: 0.25rem 0.5rem;" onclick="window.editSection(${sec.id})">Edit</button>
          <button class="btn-secondary" style="font-size: 0.75rem; padding: 0.25rem 0.5rem; color: var(--color-error);" onclick="window.deleteSection(${sec.id})">Delete</button>
        </td>
      </tr>
    `).join('');
  }

  // 5. Holidays
  const holTable = document.getElementById('table-holidays-body');
  if (holTable) {
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

  // 6. Departments
  const deptTable = document.getElementById('table-departments-body');
  if (deptTable) {
    deptTable.innerHTML = (masterData.departments || []).map(d => `
      <tr style="border-bottom: 1px solid var(--border-subtle);">
        <td style="padding: 0.6rem 0.75rem; font-weight: 700; color: var(--color-brand-primary);">${d.code}</td>
        <td style="padding: 0.6rem 0.75rem; font-weight: 600;">${d.name}</td>
        <td style="padding: 0.6rem 0.75rem; text-align: right;">
          <button class="btn-secondary" style="font-size: 0.75rem; padding: 0.25rem 0.5rem;" onclick="window.editDepartment(${d.id})">Edit</button>
          <button class="btn-secondary" style="font-size: 0.75rem; padding: 0.25rem 0.5rem; color: var(--color-error);" onclick="window.deleteDepartment(${d.id})">Delete</button>
        </td>
      </tr>
    `).join('');
  }
}

// 3. Timetable Studio
async function loadStudio() {
  await loadMasterData();
  const versionsData = await apiRequest('/api/timetable/versions');
  const selector = document.getElementById('studio-version-selector');
  if (selector && versionsData.versions?.length) {
    selector.innerHTML = versionsData.versions.map(v => `
      <option value="${v.id}" ${v.status === 'active' ? 'selected' : ''}>
        ${v.name} [${v.status.toUpperCase()}] (${v.entries_count} classes)
      </option>
    `).join('');

    activeVersionId = parseInt(selector.value, 10);
  }

  setupStudioControls();
  if (activeVersionId) {
    await loadStudioVersion(activeVersionId);
  }
}

function setupStudioControls() {
  const versionSelector = document.getElementById('studio-version-selector');
  versionSelector?.addEventListener('change', () => {
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

  // Studio actions
  document.getElementById('btn-studio-generate')?.addEventListener('click', () => {
    document.getElementById('modal-generate').style.display = 'flex';
  });

  document.getElementById('btn-studio-activate')?.addEventListener('click', async () => {
    if (!activeVersionId) return;
    try {
      const res = await apiRequest(`/api/timetable/versions/${activeVersionId}/activate`, { method: 'POST' });
      showToast(res.message, 'success');
      loadStudio();
    } catch (err) {}
  });

  document.getElementById('btn-studio-duplicate')?.addEventListener('click', async () => {
    if (!activeVersionId) return;
    try {
      const res = await apiRequest(`/api/timetable/versions/${activeVersionId}/duplicate`, { method: 'POST' });
      showToast(res.message, 'success');
      loadStudio();
    } catch (err) {}
  });

  document.getElementById('btn-studio-export')?.addEventListener('click', () => {
    if (!activeVersionId) return;
    window.location.href = `/api/timetable/versions/${activeVersionId}/export.csv`;
  });

  document.getElementById('btn-studio-export-pdf')?.addEventListener('click', () => {
    if (!currentVersionData || !masterData) {
      showToast('No timetable version loaded to export', 'warning');
      return;
    }
    const { workingDays, timeSlots } = masterData;
    const entries = currentVersionData.entries || [];
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

    printOrExportPdf({
      title: `Timetable Studio Schedule · ${entityName}`,
      subtitle: `Version: ${currentVersionData.version?.name || 'Academic Master'} (${currentVersionData.version?.status || 'draft'})`,
      meta: {
        'View': `By ${studioMode.charAt(0).toUpperCase() + studioMode.slice(1)}`,
        'Scheduled Periods': `${filteredEntries.length} classes`,
        'Integrity': currentVersionData.validation?.isValid ? '✓ 0 Conflicts' : `⚠ ${currentVersionData.validation?.errorCount || 0} Conflicts`
      },
      days: workingDays,
      slots: timeSlots,
      entries: filteredEntries
    });
  });

  document.getElementById('btn-studio-export-ics')?.addEventListener('click', () => {
    if (!activeVersionId || !currentVersionData) {
      showToast('No timetable version loaded to export', 'warning');
      return;
    }
    const versionName = currentVersionData.version?.name || `Timetable_v${activeVersionId}`;
    const cleanName = versionName.replace(/[^a-zA-Z0-9_-]/g, '_');
    exportToIcs(`timetable_${cleanName}`, versionName, currentVersionData.entries || []);
    showToast('ICS Calendar file generated and downloaded', 'success');
  });
}

function populateStudioEntitySelector() {
  const entitySelector = document.getElementById('studio-entity-selector');
  if (!entitySelector || !masterData) return;

  if (studioMode === 'section') {
    entitySelector.innerHTML = masterData.sections.map(s => `
      <option value="${s.id}">Section: ${s.name} (Sem ${s.semester})</option>
    `).join('');
  } else if (studioMode === 'faculty') {
    entitySelector.innerHTML = masterData.faculty.map(f => `
      <option value="${f.id}">Faculty: ${f.name} (${f.department_code})</option>
    `).join('');
  } else if (studioMode === 'room') {
    entitySelector.innerHTML = masterData.rooms.map(r => `
      <option value="${r.id}">Room: ${r.name} (${r.type})</option>
    `).join('');
  }

  studioEntityId = parseInt(entitySelector.value, 10);
}

async function loadStudioVersion(versionId) {
  try {
    currentVersionData = await apiRequest(`/api/timetable/versions/${versionId}`);
    renderStudioGrid();
    renderValidationStatus(currentVersionData.validation);
  } catch (err) {
    console.error('Failed to load version:', err);
  }
}

function renderValidationStatus(validation) {
  const statusBadge = document.getElementById('studio-validation-badge');
  if (!statusBadge || !validation) return;

  if (validation.isValid) {
    statusBadge.innerHTML = `<span style="color: var(--color-success); font-weight: 700;">✓ 0 Conflicts · Fully Verified</span>`;
  } else {
    statusBadge.innerHTML = `<span style="color: var(--color-error); font-weight: 700;">⚠ ${validation.errorCount} Conflicts Detected</span>`;
  }
}

function renderStudioGrid() {
  const container = document.getElementById('studio-grid-container');
  if (!container || !currentVersionData || !masterData) return;

  const { workingDays, timeSlots } = masterData;
  const entries = currentVersionData.entries || [];

  // Filter entries based on studioMode
  let filteredEntries = [];
  if (studioMode === 'section') {
    filteredEntries = entries.filter(e => e.section_id === studioEntityId);
  } else if (studioMode === 'faculty') {
    filteredEntries = entries.filter(e => e.faculty_id === studioEntityId);
  } else if (studioMode === 'room') {
    filteredEntries = entries.filter(e => e.room_id === studioEntityId);
  }

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

      const entry = filteredEntries.find(e => e.day_id === day.id && e.slot_id === slot.id);

      if (entry) {
        html += `
          <td class="timetable-cell-drop-target" data-day-id="${day.id}" data-slot-id="${slot.id}" style="padding: 0.4rem; border: 1px solid var(--border-subtle); vertical-align: top; height: 75px;">
            <div class="studio-entry-chip" draggable="true" data-entry-id="${entry.id}" style="padding: 0.45rem 0.5rem; background: var(--color-brand-blush-soft); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); cursor: grab; text-align: left; height: 100%; display: flex; flex-direction: column; justify-content: space-between; transition: transform 0.15s, box-shadow 0.15s;">
              <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                <span style="font-weight: 700; font-size: 0.85rem; color: var(--color-brand-primary);">${entry.subject_code}</span>
                ${entry.locked ? '<span style="font-size: 0.75rem;" title="Locked">🔒</span>' : ''}
              </div>
              <div style="font-size: 0.75rem; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                ${studioMode === 'faculty' ? entry.section_name : entry.faculty_name}
              </div>
              <div style="font-size: 0.7rem; color: var(--text-muted);">
                ${studioMode === 'room' ? entry.section_name : entry.room_name} ${entry.is_lab_block ? '· Lab' : ''}
              </div>
            </div>
          </td>
        `;
      } else {
        html += `
          <td class="timetable-cell-drop-target" data-day-id="${day.id}" data-slot-id="${slot.id}" style="padding: 0.4rem; border: 1px solid var(--border-subtle); vertical-align: middle; height: 75px; color: var(--text-muted); font-size: 0.8rem; cursor: pointer;">
            <span style="opacity: 0.35;">+ Free</span>
          </td>
        `;
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
}

// Drag & Drop Implementation with Live Validation
function attachDragAndDropHandlers() {
  const chips = document.querySelectorAll('.studio-entry-chip');
  const cells = document.querySelectorAll('.timetable-cell-drop-target');

  chips.forEach(chip => {
    chip.addEventListener('dragstart', (e) => {
      draggedEntryId = parseInt(chip.getAttribute('data-entry-id'), 10);
      chip.style.opacity = '0.5';
      e.dataTransfer.setData('text/plain', draggedEntryId);
    });

    chip.addEventListener('dragend', () => {
      chip.style.opacity = '1';
      cells.forEach(c => c.classList.remove('valid-drop-target', 'invalid-drop-target'));
    });

    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      const entryId = parseInt(chip.getAttribute('data-entry-id'), 10);
      openEditEntryModal(entryId);
    });
  });

  cells.forEach(cell => {
    cell.addEventListener('dragover', async (e) => {
      e.preventDefault();
      if (!draggedEntryId) return;

      const targetDayId = parseInt(cell.getAttribute('data-day-id'), 10);
      const targetSlotId = parseInt(cell.getAttribute('data-slot-id'), 10);

      // Instant live validation call
      try {
        const valRes = await apiRequest('/api/timetable/validate-move', {
          method: 'POST',
          body: {
            versionId: activeVersionId,
            entryId: draggedEntryId,
            targetDayId,
            targetSlotId
          },
          showErrorToast: false
        });

        if (valRes.isValid) {
          cell.style.backgroundColor = 'var(--color-success-bg)';
          cell.style.outline = '2px dashed var(--color-success)';
        } else {
          cell.style.backgroundColor = 'var(--color-error-bg)';
          cell.style.outline = '2px dashed var(--color-error)';
        }
      } catch (err) {}
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

      try {
        const res = await apiRequest(`/api/timetable/entries/${draggedEntryId}/move`, {
          method: 'POST',
          body: {
            targetDayId,
            targetSlotId
          }
        });

        showToast('Timetable entry moved and validated successfully!', 'success');
        await loadStudioVersion(activeVersionId);
      } catch (err) {
        if (err.status === 409) {
          // Warning override confirm
          if (confirm('This move introduces a soft constraint warning. Do you wish to override?')) {
            await apiRequest(`/api/timetable/entries/${draggedEntryId}/move`, {
              method: 'POST',
              body: { targetDayId, targetSlotId, overrideWarnings: true }
            });
            showToast('Entry moved with confirmed override', 'info');
            await loadStudioVersion(activeVersionId);
          }
        }
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

function onGenerationCompleted(data) {
  isGenerationRunning = false;
  stopGenerationTimer();
  updateGenerationButtons(false);

  const banner = document.getElementById('global-generation-banner');
  if (banner) {
    banner.style.display = 'block';
    banner.style.borderColor = 'var(--color-success)';

    const icon = document.getElementById('gen-banner-icon');
    if (icon) {
      icon.textContent = '✓';
      icon.style.animation = 'none';
    }

    const badge = document.getElementById('gen-banner-badge');
    if (badge) {
      badge.textContent = 'Generation Complete';
      badge.style.background = 'var(--color-success-bg)';
      badge.style.color = 'var(--color-success)';
    }

    const lockBadge = document.getElementById('gen-banner-lock-badge');
    if (lockBadge) lockBadge.style.display = 'none';

    const title = document.getElementById('gen-banner-title');
    if (title) {
      title.textContent = `Timetable Generated: "${data.versionName || data.name || 'Master Timetable'}"`;
    }

    const phaseEl = document.getElementById('gen-banner-phase');
    if (phaseEl) {
      phaseEl.textContent = `Successfully computed ${data.entriesCount || 0} collision-free periods with zero hard conflicts in ${data.durationMs || 0}ms. Soft constraint score: ${data.score || 100}/100.`;
    }

    const bar = document.getElementById('gen-banner-progress-bar');
    if (bar) {
      bar.style.width = '100%';
      bar.style.background = 'var(--color-success)';
      bar.style.animation = 'none';
    }

    const pct = document.getElementById('gen-banner-percent');
    if (pct) {
      pct.textContent = '100%';
      pct.style.color = 'var(--color-success)';
    }

    const stageLabel = document.getElementById('gen-banner-stage-label');
    if (stageLabel) stageLabel.textContent = 'All constraints satisfied · Saved to database';

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

  // Reload studio and overview
  loadStudio();
  loadOverview();
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

function setupModals() {
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

    const name = document.getElementById('gen-name').value;
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
        body: { name },
        showErrorToast: false
      });

      if (res.alreadyRunning) {
        showToast(res.reason || 'Generation already running in the background', 'warning');
        if (res.state) updateGenerationProgress(res.state);
        return;
      }

      showToast(res.message, 'success');
      onGenerationCompleted(res);
      switchTab('studio');
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

  // Master Data forms
  document.getElementById('form-faculty')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('fac-id').value;
    const body = {
      name: document.getElementById('fac-name').value,
      departmentId: parseInt(document.getElementById('fac-dept').value, 10),
      email: document.getElementById('fac-email').value,
      phone: document.getElementById('fac-phone').value,
      maxPeriodsPerDay: parseInt(document.getElementById('fac-max-day').value, 10),
      maxPeriodsPerWeek: parseInt(document.getElementById('fac-max-week').value, 10)
    };
    try {
      if (id) {
        await apiRequest(`/api/admin/faculty/${id}`, { method: 'PUT', body });
        showToast('Faculty updated successfully', 'success');
      } else {
        await apiRequest('/api/admin/faculty', { method: 'POST', body });
        showToast('Faculty added successfully', 'success');
      }
      document.getElementById('modal-faculty').style.display = 'none';
      await loadMasterData();
      renderMasterDataTables();
    } catch (err) {}
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
  const entry = currentVersionData.entries.find(e => e.id === entryId);
  if (!entry) return;

  const newFaculty = prompt(`Reassign Faculty (Current: ${entry.faculty_name}):\nEnter Faculty ID or Cancel:`, entry.faculty_id);
  if (newFaculty !== null && newFaculty !== '') {
    apiRequest(`/api/timetable/entries/${entryId}`, {
      method: 'PUT',
      body: { facultyId: parseInt(newFaculty, 10) }
    }).then(() => {
      showToast('Entry updated', 'success');
      loadStudioVersion(activeVersionId);
    });
  }
}

// 5. Faculty Availability Editor
async function loadAvailabilityEditor() {
  await loadMasterData();
  const select = document.getElementById('avail-faculty-selector');
  if (!select || !masterData) return;

  select.innerHTML = masterData.faculty.map(f => `
    <option value="${f.id}">${f.name} (${f.department_code})</option>
  `).join('');

  select.onchange = () => renderFacultyAvailabilityGrid(parseInt(select.value, 10));
  renderFacultyAvailabilityGrid(parseInt(select.value, 10));
}

async function renderFacultyAvailabilityGrid(facId) {
  const res = await apiRequest(`/api/admin/faculty/${facId}/availability`);
  const container = document.getElementById('availability-grid-container');
  if (!container || !masterData) return;

  const { workingDays, timeSlots } = masterData;
  const teachingSlots = timeSlots.filter(s => s.is_break === 0);
  const availMap = new Map();
  for (const a of res.availability) {
    availMap.set(`${a.day_id}_${a.slot_id}`, a.is_available === 1);
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
      const isAvailable = availMap.get(`${d.id}_${s.id}`) ?? true;
      const bg = isAvailable ? 'var(--color-success-bg)' : 'var(--color-error-bg)';
      const text = isAvailable ? '✓ Available' : '✗ Unavailable';
      const color = isAvailable ? 'var(--color-success)' : 'var(--color-error)';
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
async function loadAbsenceMonitor() {
  const container = document.getElementById('absence-list-container');
  if (!container) return;

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
                <span style="font-size: 1.25rem; font-weight: 700; color: var(--color-brand-primary);">${a.faculty_name}</span>
                <span style="font-size: 0.8rem; color: var(--text-muted);">${a.department_name}</span>
                <span style="font-size: 0.75rem; background: ${isAbsent ? 'var(--color-error-bg)' : 'var(--color-warning-bg)'}; color: ${isAbsent ? 'var(--color-error)' : 'var(--color-warning)'}; padding: 0.2rem 0.55rem; border-radius: 4px; font-weight: 600;">
                  ${isAbsent ? 'Full-day Absence' : `Running Late (Arrival: ${a.expected_arrival})`}
                </span>
                ${statusBadge}
              </div>
              <div style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 0.35rem;">
                <strong>Date:</strong> ${a.date} · <strong>Reason:</strong> ${a.reason}
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
                return `
                  <div style="padding: 0.75rem 1rem; background: var(--bg-surface-subtle); border: 1px solid var(--border-subtle); border-radius: var(--radius-md);">
                    <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.4rem;">
                      <span style="font-weight: 700; font-size: 0.95rem; color: var(--color-brand-primary);">${ac.subject_name}</span>
                      <span style="font-size: 0.75rem; color: var(--text-muted);">${ac.slot_label} (${ac.start_time})</span>
                    </div>
                    <div style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 0.6rem;">
                      Sec ${ac.section_name} · Room: ${ac.room_name}
                    </div>

                    <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--border-subtle); padding-top: 0.5rem;">
                      ${isClaimedOrAssigned ? `
                        <div style="font-size: 0.8rem; color: var(--color-success); font-weight: 600;">
                          ✓ Covered by: <strong>${ac.substitute_faculty_name}</strong>
                          <span style="font-size: 0.7rem; color: var(--text-muted);">(${ac.sub_status})</span>
                        </div>
                      ` : `
                        <span style="font-size: 0.8rem; color: var(--color-warning); font-weight: 600;">Pending Substitute</span>
                        <button class="btn-primary" style="font-size: 0.75rem; padding: 0.25rem 0.6rem;" onclick="openAssignModal(${ac.timetable_entry_id}, '${a.date}', '${ac.subject_name.replace(/'/g, "\\'")}', '${ac.slot_label}')">
                          Assign Substitute
                        </button>
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
  } catch (err) {
    console.error('Failed to load absence monitor:', err);
  }
}

// Open Assign Substitute Modal with Ranked Candidates
window.openAssignModal = async (timetableEntryId, date, subjectName, slotLabel) => {
  const modal = document.getElementById('modal-assign-sub');
  const subtitle = document.getElementById('assign-sub-subtitle');
  const list = document.getElementById('assign-candidates-list');
  if (!modal || !list) return;

  subtitle.textContent = `Ranking eligible substitutes for ${subjectName} (${slotLabel}) on ${date}:`;
  list.innerHTML = `<div style="color: var(--text-muted); font-size: 0.85rem;">Evaluating hard constraints and scoring qualified colleagues...</div>`;
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
            <span style="font-weight: 700; font-size: 1rem; color: var(--color-brand-primary);">${c.name}</span>
            <span style="font-size: 0.75rem; color: var(--text-muted);">${c.departmentName}</span>
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
            Reasons: ${c.reasons.join(' · ')}
          </div>
        </div>

        <div>
          <button class="btn-primary" style="font-size: 0.85rem;" onclick="assignSubstitute(${timetableEntryId}, '${date}', ${c.facultyId}, '${c.name.replace(/'/g, "\\'")}')">
            Assign Duty
          </button>
        </div>
      </div>
    `).join('');

  } catch (err) {
    list.innerHTML = `<div style="color: var(--color-error); font-size: 0.85rem;">Failed to load candidates: ${err.message}</div>`;
  }
};

window.assignSubstitute = async (timetableEntryId, date, substituteFacultyId, facultyName) => {
  if (!confirm(`Confirm assignment of ${facultyName} as substitute for this class?`)) return;
  try {
    const res = await apiRequest('/api/absence/substitute/assign', {
      method: 'POST',
      body: { timetableEntryId, date, substituteFacultyId }
    });
    showToast(res.message || 'Substitute assigned successfully!', 'success');
    document.getElementById('modal-assign-sub').style.display = 'none';
    await loadAbsenceMonitor();
    await loadOverview();
  } catch (err) {
    // Handled by apiRequest toast
  }
};

// Global functions for inline actions & Master Data Modals
window.openFacultyModal = (id = null) => {
  const deptSelect = document.getElementById('fac-dept');
  if (deptSelect && masterData) {
    deptSelect.innerHTML = (masterData.departments || []).map(d => `<option value="${d.id}">${d.name} (${d.code})</option>`).join('');
  }
  const title = document.getElementById('modal-faculty-title');
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
    if (title) title.textContent = 'Edit Faculty Member';
  } else {
    document.getElementById('form-faculty')?.reset();
    document.getElementById('fac-id').value = '';
    if (title) title.textContent = 'Add Faculty Member';
  }
  document.getElementById('modal-faculty').style.display = 'flex';
};

window.editFaculty = (id) => window.openFacultyModal(id);

window.deleteFaculty = async (id) => {
  if (!confirm('Are you sure you want to delete this faculty member?')) return;
  try {
    await apiRequest(`/api/admin/faculty/${id}`, { method: 'DELETE' });
    showToast('Faculty deleted', 'info');
    await loadMasterData();
    renderMasterDataTables();
  } catch (err) {}
};

window.openSubjectModal = (id = null) => {
  const deptSelect = document.getElementById('sub-dept');
  if (deptSelect && masterData) {
    deptSelect.innerHTML = (masterData.departments || []).map(d => `<option value="${d.id}">${d.name} (${d.code})</option>`).join('');
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
  if (!confirm('Are you sure you want to delete this subject?')) return;
  try {
    await apiRequest(`/api/admin/subjects/${id}`, { method: 'DELETE' });
    showToast('Subject deleted', 'info');
    await loadMasterData();
    renderMasterDataTables();
  } catch (err) {}
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
  if (!confirm('Are you sure you want to delete this room?')) return;
  try {
    await apiRequest(`/api/admin/rooms/${id}`, { method: 'DELETE' });
    showToast('Room deleted', 'info');
    await loadMasterData();
    renderMasterDataTables();
  } catch (err) {}
};

window.openSectionModal = (id = null) => {
  const deptSelect = document.getElementById('sec-dept');
  if (deptSelect && masterData) {
    deptSelect.innerHTML = (masterData.departments || []).map(d => `<option value="${d.id}">${d.name} (${d.code})</option>`).join('');
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
  if (!confirm('Are you sure you want to delete this section?')) return;
  try {
    await apiRequest(`/api/admin/sections/${id}`, { method: 'DELETE' });
    showToast('Section deleted', 'info');
    await loadMasterData();
    renderMasterDataTables();
  } catch (err) {}
};

window.openHolidayModal = () => {
  document.getElementById('form-holiday')?.reset();
  const dateInput = document.getElementById('hol-date');
  if (dateInput) dateInput.value = new Date().toISOString().split('T')[0];
  document.getElementById('modal-holiday').style.display = 'flex';
};

window.deleteHoliday = async (id) => {
  if (!confirm('Are you sure you want to remove this academic holiday?')) return;
  try {
    await apiRequest(`/api/admin/holidays/${id}`, { method: 'DELETE' });
    showToast('Holiday removed', 'info');
    await loadMasterData();
    renderMasterDataTables();
  } catch (err) {}
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
  if (!confirm('Are you sure you want to delete this department?')) return;
  try {
    await apiRequest(`/api/admin/departments/${id}`, { method: 'DELETE' });
    showToast('Department deleted', 'info');
    await loadMasterData();
    renderMasterDataTables();
  } catch (err) {}
};

// ============================================================================
// 6. AI INTELLIGENCE CENTER (Phases 10, 11, 12)
// ============================================================================
let aiCenterInitialized = false;
let currentExtractedReviewData = null;
let selectedVisionFile = null;

async function loadAiCenter() {
  if (!masterData) await loadMasterData();
  await loadAiStatusPills();
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

async function loadAiStatusPills() {
  const container = document.getElementById('ai-model-status-pills');
  if (!container) return;

  try {
    const res = await apiRequest('/api/ai/status');
    const { configured, models } = res;

    container.innerHTML = `
      <div style="background: ${configured.vision ? 'var(--color-success-bg)' : 'var(--color-warning-bg)'}; border: 1px solid ${configured.vision ? 'var(--color-success)' : 'var(--color-warning)'}; border-radius: var(--radius-sm); padding: 0.35rem 0.65rem; font-size: 0.75rem;">
        <strong>Vision:</strong> ${configured.vision ? models.vision : 'Fallback Template'}
      </div>
      <div style="background: ${configured.reasoning ? 'var(--color-success-bg)' : 'var(--color-warning-bg)'}; border: 1px solid ${configured.reasoning ? 'var(--color-success)' : 'var(--color-warning)'}; border-radius: var(--radius-sm); padding: 0.35rem 0.65rem; font-size: 0.75rem;">
        <strong>Reasoning:</strong> ${configured.reasoning ? models.reasoning : 'Deterministic Rules'}
      </div>
      <div style="background: ${configured.decision ? 'var(--color-success-bg)' : 'var(--color-warning-bg)'}; border: 1px solid ${configured.decision ? 'var(--color-success)' : 'var(--color-warning)'}; border-radius: var(--radius-sm); padding: 0.35rem 0.65rem; font-size: 0.75rem;">
        <strong>Decision:</strong> ${configured.decision ? models.decision : 'Deterministic Heuristic'}
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<span style="font-size: 0.8rem; color: var(--text-muted);">Status offline</span>`;
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
    await apiRequest('/api/absence/substitutions/assign', {
      method: 'POST',
      body: JSON.stringify({
        timetableEntryId: entryId,
        dateStr,
        substituteFacultyId: facultyId
      })
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

export default { switchTab };

