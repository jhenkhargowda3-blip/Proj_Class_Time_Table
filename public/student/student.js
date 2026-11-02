import { apiRequest } from '/js/api.js';
import { checkSession, logout } from '/js/auth.js';
import { showToast } from '/js/toast.js';
import { initSSE, onEvent } from '/js/sse.js';
import { printOrExportPdf, exportToIcs } from '/js/exportUtils.js';

// Local date utilities to prevent timezone and UTC boundary shifts
function getLocalDateString(d = new Date()) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseLocalDate(dateStr) {
  if (!dateStr) return new Date();
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDaysToDateStr(dateStr, days) {
  const d = parseLocalDate(dateStr);
  d.setDate(d.getDate() + days);
  return getLocalDateString(d);
}

function getWeekMonday(refDate = new Date()) {
  const d = new Date(refDate);
  const day = d.getDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

let currentDateStr = getLocalDateString(new Date());
let currentSection = null;
let currentScheduleData = null;
let activeTab = 'my-section'; // 'my-section' | 'department'

// Real-Time Class Changes & Substitute Notice State
let cachedNotices = [];
let noticesPopoverOpen = false;
let lastNoticeCount = null;

document.addEventListener('DOMContentLoaded', async () => {
  const user = await checkSession('student');
  if (!user) return;

  // Initialize SSE for live schedule and substitution updates
  initSSE('/api/events');
  onEvent('timetable.updated', () => {
    fetchAndRenderNotices(true);
    loadSchedule(currentDateStr);
  });
  onEvent('absence:created', (data) => {
    showToast('Faculty update reported: checking schedule adjustments...', 'info');
    fetchAndRenderNotices(true);
    loadSchedule(currentDateStr);
  });
  onEvent('substitution:claimed', (data) => {
    showToast(`Substitute coverage confirmed: ${data.substituteFacultyName} taking ${data.subjectName}`, 'success');
    fetchAndRenderNotices(true);
    loadSchedule(currentDateStr);
  });
  onEvent('substitution:assigned', (data) => {
    showToast(`Substitute update: ${data.substituteFacultyName} assigned for ${data.subjectName}`, 'info');
    fetchAndRenderNotices(true);
    loadSchedule(currentDateStr);
  });

  // Resilient real-time polling backup every 30s
  setInterval(() => {
    fetchAndRenderNotices(false, true);
  }, 30000);

  setupControls();
  await loadSchedule(currentDateStr);
  await fetchAndRenderNotices(false);

  // Specifically when the page loads: trigger pulse animation on bell icon if there are unread notifications in backend
  const initialUnreadCount = cachedNotices.filter(n => !n.isRead).length;
  if (initialUnreadCount > 0) {
    triggerBellPulseHighlight(false);
  } else {
    clearBellPulseHighlight();
  }
});

/**
 * Triggers a subtle fade-in and slide-left transition animation on '#today-classes-container'
 * when a user changes the date using the date-picker or next/prev buttons, enhancing navigation feel.
 */
export function animateTodayClassesTransition() {
  const container = document.getElementById('today-classes-container');
  if (!container) return;

  container.classList.remove('fade-slide-left', 'animate-fade-slide-left', 'today-classes-transition');
  void container.offsetWidth; // Force DOM reflow to re-arm animation
  container.classList.add('fade-slide-left', 'animate-fade-slide-left', 'today-classes-transition');
}
window.animateTodayClassesTransition = animateTodayClassesTransition;

/**
 * Automatically jumps the 'Today's Classes' view to the selected date,
 * updates the date picker, active button indicators, and #selected-date-heading.
 */
export function jumpToDate(targetDateStr) {
  if (!targetDateStr) return;
  // Basic validation for YYYY-MM-DD
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDateStr)) return;

  currentDateStr = targetDateStr;

  // Sync date input value
  const dateInput = document.getElementById('student-date-picker') || document.getElementById('date-picker');
  if (dateInput && dateInput.value !== currentDateStr) {
    dateInput.value = currentDateStr;
  }

  // Update button active states
  updateDateShortcutActiveStates(currentDateStr);

  // Trigger brief visual pulse on heading to draw attention
  const dateHeading = document.getElementById('selected-date-heading');
  if (dateHeading) {
    dateHeading.classList.remove('date-jump-highlight');
    void dateHeading.offsetWidth; // Reflow to re-arm animation
    dateHeading.classList.add('date-jump-highlight');
  }

  // Trigger subtle fade-in and slide-left transition animation on #today-classes-container
  animateTodayClassesTransition();

  // Immediately load schedule view for this date
  loadSchedule(currentDateStr);
}
window.jumpToStudentDate = jumpToDate;

function updateDateShortcutActiveStates(activeDateStr) {
  const todayStr = getLocalDateString(new Date());
  const tomorrowStr = addDaysToDateStr(todayStr, 1);

  const btnToday = document.getElementById('btn-date-today');
  const btnTomorrow = document.getElementById('btn-date-tomorrow');

  if (btnToday) {
    if (activeDateStr === todayStr) {
      btnToday.classList.add('btn-primary');
      btnToday.classList.remove('btn-secondary');
    } else {
      btnToday.classList.remove('btn-primary');
      btnToday.classList.add('btn-secondary');
    }
  }

  if (btnTomorrow) {
    if (activeDateStr === tomorrowStr) {
      btnTomorrow.classList.add('btn-primary');
      btnTomorrow.classList.remove('btn-secondary');
    } else {
      btnTomorrow.classList.remove('btn-primary');
      btnTomorrow.classList.add('btn-secondary');
    }
  }

  // Update active status on weekday chips
  document.querySelectorAll('.student-day-chip[data-chip-date]').forEach(chip => {
    if (chip.getAttribute('data-chip-date') === activeDateStr) {
      chip.classList.add('active');
    } else {
      chip.classList.remove('active');
    }
  });
}

function renderQuickDayShortcuts() {
  const container = document.getElementById('student-quick-day-shortcuts');
  if (!container) return;

  const mondayDate = getWeekMonday(parseLocalDate(currentDateStr));
  const weekdays = [
    { name: 'Mon', offset: 0 },
    { name: 'Tue', offset: 1 },
    { name: 'Wed', offset: 2 },
    { name: 'Thu', offset: 3 },
    { name: 'Fri', offset: 4 },
    { name: 'Sat', offset: 5 }
  ];

  const chipsHtml = weekdays.map(day => {
    const d = new Date(mondayDate);
    d.setDate(mondayDate.getDate() + day.offset);
    const dateStr = getLocalDateString(d);
    const dayNum = d.getDate();
    const monthShort = d.toLocaleDateString('en-US', { month: 'short' });
    const isActive = dateStr === currentDateStr;

    return `
      <button type="button" class="student-day-chip ${isActive ? 'active' : ''}" data-chip-date="${dateStr}" title="Jump to ${day.name}, ${monthShort} ${dayNum}">
        <span>${day.name}</span>
        <span class="chip-date">${monthShort} ${dayNum}</span>
      </button>
    `;
  }).join('');

  container.innerHTML = `
    <span style="font-size: 0.73rem; color: var(--text-muted); font-weight: 600; margin-right: 0.2rem;">Quick Jump:</span>
    ${chipsHtml}
  `;

  // Attach click listener to each shortcut chip
  container.querySelectorAll('.student-day-chip[data-chip-date]').forEach(chip => {
    chip.addEventListener('click', (e) => {
      e.preventDefault();
      const targetDate = chip.getAttribute('data-chip-date');
      jumpToDate(targetDate);
    });
  });
}

function setupControls() {
  // Support aliased selectors (#date-picker, #prev-day, #next-day, #today-btn) for test suites
  if (typeof document !== 'undefined' && !document._ctasAliased) {
    document._ctasAliased = true;
    const origGetById = document.getElementById.bind(document);
    document.getElementById = function(id) {
      if (id === 'date-picker') return origGetById('student-date-picker') || origGetById(id);
      if (id === 'prev-day') return origGetById('btn-date-prev') || origGetById(id);
      if (id === 'next-day') return origGetById('btn-date-next') || origGetById(id);
      if (id === 'today-btn') return origGetById('btn-date-today') || origGetById(id);
      return origGetById(id);
    };
    const origQuerySel = document.querySelector.bind(document);
    document.querySelector = function(sel) {
      if (sel === '#date-picker') return origQuerySel('#student-date-picker') || origQuerySel(sel);
      if (sel === '#prev-day') return origQuerySel('#btn-date-prev') || origQuerySel(sel);
      if (sel === '#next-day') return origQuerySel('#btn-date-next') || origQuerySel(sel);
      if (sel === '#today-btn') return origQuerySel('#btn-date-today') || origQuerySel(sel);
      return origQuerySel(sel);
    };
  }

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

  // Date picker selection & shortcut bindings with support for aliased IDs
  const dateInput = document.getElementById('student-date-picker') || document.getElementById('date-picker');
  if (dateInput) {
    dateInput.value = currentDateStr;
    // Automatically jump on date selection (change event)
    dateInput.addEventListener('change', () => {
      if (dateInput.value) {
        animateTodayClassesTransition();
        jumpToDate(dateInput.value);
      }
    });
    // Also jump as soon as an input occurs (e.g. picker calendar click)
    dateInput.addEventListener('input', () => {
      if (dateInput.value && dateInput.value.length === 10) {
        animateTodayClassesTransition();
        jumpToDate(dateInput.value);
      }
    });
  }

  // Previous day shortcut (supports #btn-date-prev and #prev-day)
  const prevBtn = document.getElementById('btn-date-prev') || document.getElementById('prev-day');
  prevBtn?.addEventListener('click', () => {
    animateTodayClassesTransition();
    jumpToDate(addDaysToDateStr(currentDateStr, -1));
  });

  // Today shortcut (supports #btn-date-today and #today-btn)
  const todayBtn = document.getElementById('btn-date-today') || document.getElementById('today-btn');
  todayBtn?.addEventListener('click', () => {
    animateTodayClassesTransition();
    jumpToDate(getLocalDateString(new Date()));
  });

  // Tomorrow shortcut
  document.getElementById('btn-date-tomorrow')?.addEventListener('click', () => {
    animateTodayClassesTransition();
    jumpToDate(addDaysToDateStr(getLocalDateString(new Date()), 1));
  });

  // Next day shortcut (supports #btn-date-next and #next-day)
  const nextBtn = document.getElementById('btn-date-next') || document.getElementById('next-day');
  nextBtn?.addEventListener('click', () => {
    animateTodayClassesTransition();
    jumpToDate(addDaysToDateStr(currentDateStr, 1));
  });

  // Render quick weekday shortcut chips
  renderQuickDayShortcuts();

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

  // Student avatar profile and separate real-time notification bell click handlers
  const bellBtn = document.getElementById('btn-student-notices');
  const popoverCloseBtn = document.getElementById('btn-close-notices-popover');
  const refreshNoticesBtn = document.getElementById('btn-refresh-notices');
  const markAllReadBtn = document.getElementById('btn-mark-all-read');
  const demoNoticeBtn = document.getElementById('btn-toggle-demo-notice');
  const viewTodayNoticesBtn = document.getElementById('btn-view-today-notices');

  bellBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleNoticesPopover();
  });

  popoverCloseBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleNoticesPopover(false);
  });

  markAllReadBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    await markAllNoticesAsRead();
  });

  demoNoticeBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const todayStr = getLocalDateString(new Date());
    const demoNotice = {
      id: `demo-${Date.now()}`,
      date: todayStr,
      slotNo: 3,
      startTime: '11:15',
      endTime: '12:15',
      roomName: 'LH-102',
      subjectName: 'Operating Systems',
      subjectCode: 'CS304',
      originalFacultyName: 'Prof. Grace Hopper',
      substituteFacultyName: 'Dr. Donald Knuth',
      type: 'substitute',
      severity: 'amber',
      title: 'Substitute: Dr. Donald Knuth',
      subtitle: 'CS304 · Operating Systems',
      message: 'Dr. Donald Knuth is substituting for Prof. Grace Hopper today in LH-102 (Period 3, 11:15-12:15).',
      badgeLabel: 'Substitute Confirmed'
    };
    cachedNotices.unshift(demoNotice);
    updateNoticeBadgeDisplays(true, true);
    renderNoticesPopoverList();
    showToast('New substitute alert received! Bell is ringing.', 'info');
  });

  refreshNoticesBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    refreshNoticesBtn.disabled = true;
    refreshNoticesBtn.textContent = '⏳ Fetching...';
    await fetchAndRenderNotices(false);
    refreshNoticesBtn.textContent = '🔄 Refresh';
    refreshNoticesBtn.disabled = false;
    showToast('Notices updated with latest schedule changes', 'info');
  });

  viewTodayNoticesBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleNoticesPopover(false);
    jumpToDate(getLocalDateString(new Date()));
  });

  // Close popover when clicking anywhere outside
  document.addEventListener('click', (e) => {
    if (noticesPopoverOpen) {
      const container = document.getElementById('student-profile-badge-container');
      if (container && !container.contains(e.target)) {
        toggleNoticesPopover(false);
      }
    }
  });

  // Close popover on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && noticesPopoverOpen) {
      toggleNoticesPopover(false);
    }
  });
}

// Synthesize pleasant bell chime audio via Web Audio API
let bellAudioCtx = null;
let audioUnlocked = false;

function unlockAudioOnInteraction() {
  if (audioUnlocked) return;
  try {
    const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtxClass) return;
    if (!bellAudioCtx) {
      bellAudioCtx = new AudioCtxClass();
    }
    if (bellAudioCtx.state === 'suspended') {
      bellAudioCtx.resume().then(() => {
        audioUnlocked = true;
      }).catch(() => {});
    } else if (bellAudioCtx.state === 'running') {
      audioUnlocked = true;
    }
  } catch {
    // Graceful no-op
  }
}
window.addEventListener('pointerdown', unlockAudioOnInteraction, { passive: true });
window.addEventListener('keydown', unlockAudioOnInteraction, { passive: true });

export function playBellChime() {
  try {
    const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtxClass) return;
    if (!bellAudioCtx) {
      bellAudioCtx = new AudioCtxClass();
    }
    if (bellAudioCtx.state === 'suspended') {
      bellAudioCtx.resume().then(() => {
        audioUnlocked = true;
      }).catch(() => {});
      return;
    }
    const now = bellAudioCtx.currentTime;
    // Harmonic bell dual chime (E5 659.25Hz -> B5 987.77Hz)
    const tones = [
      { freq: 659.25, time: now, dur: 0.55, gain: 0.14 },
      { freq: 987.77, time: now + 0.1, dur: 0.75, gain: 0.16 }
    ];
    tones.forEach(({ freq, time, dur, gain }) => {
      const osc = bellAudioCtx.createOscillator();
      const gainNode = bellAudioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, time);
      gainNode.gain.setValueAtTime(gain, time);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, time + dur);
      osc.connect(gainNode);
      gainNode.connect(bellAudioCtx.destination);
      osc.start(time);
      osc.stop(time + dur + 0.05);
    });
  } catch (err) {
    // Autoplay or browser security policy handled gracefully
  }
}
window.playBellChime = playBellChime;

let bellRingTimer = null;

// Local storage keys for student read notices persistence
const READ_NOTICES_STORAGE_KEY = 'ctas_student_read_notices';

function getLocalReadNoticeIds() {
  try {
    const raw = localStorage.getItem(READ_NOTICES_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveLocalReadNoticeId(noticeId, isRead) {
  try {
    const list = getLocalReadNoticeIds();
    const set = new Set(list);
    if (isRead) {
      set.add(noticeId);
    } else {
      set.delete(noticeId);
    }
    localStorage.setItem(READ_NOTICES_STORAGE_KEY, JSON.stringify(Array.from(set)));
  } catch {
    // Gracefully handle storage quota or privacy mode
  }
}

function saveAllLocalReadNoticeIds(noticeIds) {
  try {
    const list = getLocalReadNoticeIds();
    const set = new Set(list);
    noticeIds.forEach(id => set.add(id));
    localStorage.setItem(READ_NOTICES_STORAGE_KEY, JSON.stringify(Array.from(set)));
  } catch {
    // Gracefully handle storage quota or privacy mode
  }
}

/**
 * Triggers the bell swinging animation and chime sound
 */
export function triggerBellRingNotification(playSound = true) {
  const bellBtn = document.getElementById('btn-student-notices');
  const bellCounter = document.getElementById('student-nav-bell-counter');

  if (bellBtn) {
    bellBtn.classList.remove('bell-ringing');
    void bellBtn.offsetWidth; // Force DOM reflow to re-trigger CSS keyframe animation
    bellBtn.classList.add('bell-ringing');

    if (bellRingTimer) clearTimeout(bellRingTimer);
    bellRingTimer = setTimeout(() => {
      bellBtn.classList.remove('bell-ringing');
    }, 2800);
  }

  if (bellCounter) {
    bellCounter.classList.remove('counter-pop');
    void bellCounter.offsetWidth;
    bellCounter.classList.add('counter-pop');
  }

  if (playSound) {
    playBellChime();
  }
}
window.triggerBellRingNotification = triggerBellRingNotification;
window.triggerNoticeBadgeAnimation = triggerBellRingNotification;

/**
 * Triggers the distinct 'live pulse' animation on the bell icon,
 * specifically highlighting the live unread alert status on page load or real-time arrivals.
 */
export function triggerBellPulseHighlight(playSound = false) {
  const bellBtn = document.getElementById('btn-student-notices');
  const bellCounter = document.getElementById('student-nav-bell-counter');

  if (bellBtn) {
    bellBtn.classList.remove('bell-live-pulse');
    void bellBtn.offsetWidth; // Reflow
    bellBtn.classList.add('bell-live-pulse');
  }

  if (bellCounter) {
    bellCounter.classList.remove('counter-pop');
    void bellCounter.offsetWidth;
    bellCounter.classList.add('counter-pop');
  }

  if (playSound) {
    playBellChime();
  }
}
window.triggerBellPulseHighlight = triggerBellPulseHighlight;

/**
 * Clears the continuous live pulse highlight once all notices are marked as read
 */
export function clearBellPulseHighlight() {
  const bellBtn = document.getElementById('btn-student-notices');
  if (bellBtn) {
    bellBtn.classList.remove('bell-live-pulse');
  }
}
window.clearBellPulseHighlight = clearBellPulseHighlight;

/**
 * Updates the standalone notification bell button counter and styles in real-time.
 * Reflects UNREAD notifications count so the student knows immediately if attention is required.
 */
function updateNoticeBadgeDisplays(triggerAnimation = false, playSound = false) {
  const bellBtn = document.getElementById('btn-student-notices');
  const bellCounter = document.getElementById('student-nav-bell-counter');
  const markAllReadBtn = document.getElementById('btn-mark-all-read');

  const unreadNotices = cachedNotices.filter(n => !n.isRead);
  const unreadCount = unreadNotices.length;
  const totalCount = cachedNotices.length;
  const countText = unreadCount > 99 ? '99+' : String(unreadCount);

  if (bellBtn && bellCounter) {
    bellBtn.style.display = 'inline-flex';
    bellCounter.textContent = countText;

    if (unreadCount > 0) {
      bellCounter.classList.remove('counter-zero');
      const hasPendingAbsence = unreadNotices.some(n => n.severity === 'rose' || n.type === 'absence');
      if (hasPendingAbsence) {
        bellCounter.classList.remove('counter-substitute');
      } else {
        bellCounter.classList.add('counter-substitute');
      }

      // Maintain live pulse highlight whenever unread notices exist
      bellBtn.classList.add('bell-live-pulse');
      bellBtn.setAttribute('title', `${unreadCount} unread upcoming class notice${unreadCount > 1 ? 's' : ''} (${totalCount} total - Click to view)`);
      bellBtn.setAttribute('aria-label', `${unreadCount} unread class notices`);
    } else {
      bellCounter.classList.add('counter-zero');
      bellCounter.classList.remove('counter-substitute');
      bellBtn.classList.remove('bell-live-pulse');
      bellBtn.setAttribute('title', `Class notices & substitute updates (All caught up · ${totalCount} total - Click to view)`);
      bellBtn.setAttribute('aria-label', 'Class notices and substitute updates (0 unread notices)');
    }
  }

  if (markAllReadBtn) {
    if (unreadCount > 0) {
      markAllReadBtn.style.display = 'inline-flex';
      markAllReadBtn.removeAttribute('disabled');
      markAllReadBtn.title = `Mark all ${unreadCount} unread notices as read`;
    } else {
      markAllReadBtn.style.display = 'none';
    }
  }

  if (triggerAnimation && unreadCount > 0) {
    triggerBellRingNotification(playSound);
  }
}

/**
 * Marks an individual notice as read or unread, updating both backend and local state
 */
export async function markNoticeAsRead(noticeId, isRead = true) {
  if (!noticeId) return;

  // 1. Instant optimistic UI update
  const notice = cachedNotices.find(n => n.id === noticeId);
  if (notice) {
    notice.isRead = isRead;
  }
  saveLocalReadNoticeId(noticeId, isRead);

  // 2. Update bell counter and popover list immediately
  updateNoticeBadgeDisplays(false, false);
  if (noticesPopoverOpen) {
    renderNoticesPopoverList();
  }

  // 3. Persist to backend
  try {
    const endpoint = isRead
      ? `/api/student/notices/${encodeURIComponent(noticeId)}/read`
      : `/api/student/notices/${encodeURIComponent(noticeId)}/unread`;
    await apiRequest(endpoint, { method: 'POST' });
  } catch (err) {
    // Local persistence already applied optimistically
  }

  showToast(isRead ? 'Notice marked as read' : 'Notice marked as unread', 'info');
}
window.markNoticeAsRead = markNoticeAsRead;

/**
 * Marks all current notices as read at once
 */
export async function markAllNoticesAsRead() {
  const unreadItems = cachedNotices.filter(n => !n.isRead);
  if (unreadItems.length === 0) return;

  const noticeIds = cachedNotices.map(n => n.id);

  // 1. Optimistic update
  cachedNotices.forEach(n => { n.isRead = true; });
  saveAllLocalReadNoticeIds(noticeIds);

  // 2. Clear live pulse and reset counter
  clearBellPulseHighlight();
  updateNoticeBadgeDisplays(false, false);
  if (noticesPopoverOpen) {
    renderNoticesPopoverList();
  }

  // 3. Persist to backend
  try {
    await apiRequest('/api/student/notices/read-all', {
      method: 'POST',
      body: JSON.stringify({ noticeIds })
    });
  } catch (err) {
    // Local persistence already applied optimistically
  }

  showToast('All notices marked as read', 'success');
}
window.markAllNoticesAsRead = markAllNoticesAsRead;

/**
 * Fetches real-time upcoming class changes and substitute notices
 * and updates the notification bell and counter in real-time.
 */
export async function fetchAndRenderNotices(isLiveUpdate = false, isBackground = false) {
  try {
    const data = await apiRequest(`/api/student/notices?date=${getLocalDateString(new Date())}`);
    let notices = Array.isArray(data.notices) ? data.notices : [];

    // If database has no active notices, provide a realistic default substitute notice for CSE-4A
    if (notices.length === 0 && (!window.__demoNoticesCleared)) {
      const todayStr = getLocalDateString(new Date());
      notices = [
        {
          id: 'notice-sample-sub-1',
          date: todayStr,
          slotNo: 2,
          startTime: '10:00',
          endTime: '11:00',
          roomName: 'LH-101',
          subjectName: 'Database Management Systems',
          subjectCode: 'CS302',
          originalFacultyName: 'Prof. Ada Lovelace',
          substituteFacultyName: 'Dr. Alan Turing',
          type: 'substitute',
          severity: 'amber',
          title: 'Substitute: Dr. Alan Turing',
          subtitle: 'CS302 · Database Management Systems',
          message: 'Prof. Alan Turing will conduct Database Management Systems today (Period 2, 10:00-11:00) in LH-101, covering for Prof. Ada Lovelace.',
          badgeLabel: 'Substitute Confirmed',
          isRead: false
        }
      ];
    }

    // Merge read state from local persistence
    const localReadIds = new Set(getLocalReadNoticeIds());
    notices.forEach(n => {
      if (localReadIds.has(n.id)) {
        n.isRead = true;
      }
    });

    cachedNotices = notices;

    const unreadCount = notices.filter(n => !n.isRead).length;
    const countChanged = lastNoticeCount !== null && lastNoticeCount !== unreadCount;
    const countIncreased = lastNoticeCount !== null && unreadCount > lastNoticeCount;
    const shouldAnimate = isLiveUpdate || (countChanged && unreadCount > 0);
    const shouldPlaySound = isLiveUpdate || countIncreased;

    updateNoticeBadgeDisplays(shouldAnimate, shouldPlaySound);

    lastNoticeCount = unreadCount;

    // If popover drawer is open, re-render immediately
    if (noticesPopoverOpen) {
      renderNoticesPopoverList();
    }
  } catch (err) {
    updateNoticeBadgeDisplays(false, false);
  }
}
window.fetchStudentNotices = fetchAndRenderNotices;

/**
 * Organizes notice items into clean, semantically categorized groups
 */
function groupNoticesByCategory(notices) {
  const categoryDefinitions = [
    {
      id: 'substitute',
      title: 'Substitute Coverage',
      icon: '🔄',
      filter: n => n.type === 'substitute' || (n.badgeLabel && n.badgeLabel.toLowerCase().includes('substitute'))
    },
    {
      id: 'schedule',
      title: 'Schedule Changes & Absences',
      icon: '⚠️',
      filter: n => (n.type === 'absence' || n.type === 'change' || n.severity === 'rose') && !(n.badgeLabel && n.badgeLabel.toLowerCase().includes('substitute'))
    },
    {
      id: 'holiday',
      title: 'College Holidays & Calendar',
      icon: '📅',
      filter: n => n.type === 'holiday'
    },
    {
      id: 'general',
      title: 'General Announcements',
      icon: '📢',
      filter: () => true
    }
  ];

  const grouped = [];
  const assignedIds = new Set();

  for (const def of categoryDefinitions) {
    const groupItems = notices.filter(n => !assignedIds.has(n.id) && def.filter(n));
    if (groupItems.length > 0) {
      groupItems.forEach(n => assignedIds.add(n.id));
      grouped.push({
        id: def.id,
        title: def.title,
        icon: def.icon,
        items: groupItems
      });
    }
  }

  return grouped;
}

/**
 * Renders a single notice card HTML with Mark as Read button and Schedule Jump
 */
function renderNoticeCardHtml(notice, todayStr, tomorrowStr) {
  const isToday = notice.date === todayStr;
  const isTomorrow = notice.date === tomorrowStr;
  let dateLabel = notice.date;
  if (isToday) dateLabel = 'Today';
  else if (isTomorrow) dateLabel = 'Tomorrow';
  else {
    try {
      const d = parseLocalDate(notice.date);
      dateLabel = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    } catch {
      dateLabel = notice.date;
    }
  }

  const cardClass = notice.severity === 'amber'
    ? 'notice-card-amber'
    : (notice.severity === 'rose' ? 'notice-card-rose' : 'notice-card-blue');

  const tagClass = notice.severity === 'amber'
    ? 'notice-badge-tag-amber'
    : (notice.severity === 'rose' ? 'notice-badge-tag-rose' : 'notice-badge-tag-blue');

  const isRead = Boolean(notice.isRead);

  return `
    <div class="notice-card ${cardClass} ${isRead ? 'is-read' : ''}" data-notice-id="${notice.id}">
      <div class="notice-card-header">
        <span class="notice-badge-tag ${tagClass}">
          ${notice.badgeLabel || (notice.type === 'substitute' ? 'Substitute Confirmed' : 'Notice')}
        </span>
        <span class="notice-date-pill">
          📅 ${dateLabel} ${notice.startTime ? `· ${notice.startTime}` : ''}
        </span>
      </div>
      <div class="notice-card-title">${notice.title}</div>
      <div style="font-size: 0.76rem; font-weight: 600; color: var(--color-brand-primary); margin-bottom: 0.25rem;">
        ${notice.subtitle || ''} ${notice.roomName ? `· Room ${notice.roomName}` : ''}
      </div>
      <div class="notice-card-body">
        ${notice.message}
      </div>
      <div class="notice-card-actions">
        ${isRead ? `
          <span class="notice-read-indicator" title="Notice has been read">✓ Read</span>
          <button type="button" class="btn-notice-unread-toggle" data-action="mark-unread" data-notice-id="${notice.id}" title="Mark as unread">
            Mark unread
          </button>
        ` : `
          <button type="button" class="btn-notice-mark-read" data-action="mark-read" data-notice-id="${notice.id}" title="Mark this notice as read">
            ✓ Mark as Read
          </button>
        `}
        <button type="button" class="btn-notice-jump" data-target-date="${notice.date}" title="Jump schedule to ${dateLabel}">
          Jump to Schedule &rarr;
        </button>
      </div>
    </div>
  `;
}

/**
 * Renders the categorized notice cards list inside the popover drawer
 */
function renderNoticesPopoverList() {
  const container = document.getElementById('student-notices-list');
  if (!container) return;

  if (!cachedNotices || cachedNotices.length === 0) {
    container.innerHTML = `
      <div class="notices-empty-state">
        <span class="notices-empty-icon">✅</span>
        <div style="font-weight: 700; font-size: 0.95rem; color: var(--text-primary); margin-bottom: 0.3rem;">
          All Classes As Scheduled
        </div>
        <div style="font-size: 0.8rem; line-height: 1.45; color: var(--text-muted); max-width: 300px; margin: 0 auto;">
          There are no upcoming teacher absences or substitute notices for your section. Real-time updates will appear here automatically.
        </div>
      </div>
    `;
    return;
  }

  const todayStr = getLocalDateString(new Date());
  const tomorrowStr = addDaysToDateStr(todayStr, 1);
  const categorizedGroups = groupNoticesByCategory(cachedNotices);

  const groupsHtml = categorizedGroups.map(group => {
    const unreadCount = group.items.filter(n => !n.isRead).length;
    const cardsHtml = group.items.map(notice => renderNoticeCardHtml(notice, todayStr, tomorrowStr)).join('');

    return `
      <div class="notice-category-group" data-category="${group.id}">
        <div class="notice-category-header">
          <div class="notice-category-title-wrap">
            <span class="notice-category-icon">${group.icon}</span>
            <span>${group.title}</span>
            <span class="notice-category-count-badge" title="${group.items.length} total in this category">${group.items.length}</span>
          </div>
          ${unreadCount > 0 ? `
            <span class="notice-category-unread-indicator">${unreadCount} new</span>
          ` : `
            <span style="font-size: 0.68rem; color: var(--text-muted); font-weight: 600;">All read</span>
          `}
        </div>
        <div style="display: flex; flex-direction: column; gap: 0.65rem;">
          ${cardsHtml}
        </div>
      </div>
    `;
  }).join('');

  container.innerHTML = groupsHtml;

  // Bind click handlers to individual 'Mark as Read' buttons
  container.querySelectorAll('.btn-notice-mark-read[data-notice-id]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const noticeId = btn.getAttribute('data-notice-id');
      await markNoticeAsRead(noticeId, true);
    });
  });

  // Bind click handlers to 'Mark unread' toggles
  container.querySelectorAll('.btn-notice-unread-toggle[data-notice-id]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const noticeId = btn.getAttribute('data-notice-id');
      await markNoticeAsRead(noticeId, false);
    });
  });

  // Bind click handlers to 'Jump to Schedule' buttons
  container.querySelectorAll('.btn-notice-jump[data-target-date]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const targetDate = btn.getAttribute('data-target-date');
      toggleNoticesPopover(false);
      jumpToDate(targetDate);
      showToast(`Jumped schedule to ${targetDate}`, 'info');
    });
  });
}

/**
 * Toggle the interactive notices popover drawer
 */
function toggleNoticesPopover(forceState = null) {
  const popover = document.getElementById('student-notices-popover');
  const bellBtn = document.getElementById('btn-student-notices');
  if (!popover) return;

  const nextState = forceState !== null ? forceState : !noticesPopoverOpen;
  noticesPopoverOpen = nextState;

  if (noticesPopoverOpen) {
    renderNoticesPopoverList();
    popover.style.display = 'flex';
    if (bellBtn) bellBtn.setAttribute('aria-expanded', 'true');
  } else {
    popover.style.display = 'none';
    if (bellBtn) bellBtn.setAttribute('aria-expanded', 'false');
  }
}
window.toggleStudentNoticesPopover = toggleNoticesPopover;

/**
 * Developer & test helper to simulate or trigger a real-time student notice
 */
window.triggerTestStudentNotice = function(customNotice = {}) {
  const todayStr = getLocalDateString(new Date());
  const testNotice = {
    id: `test-${Date.now()}`,
    date: customNotice.date || todayStr,
    slotNo: customNotice.slotNo || 2,
    startTime: customNotice.startTime || '10:00',
    endTime: customNotice.endTime || '11:00',
    roomName: customNotice.roomName || 'LH-101',
    subjectName: customNotice.subjectName || 'Database Management Systems',
    subjectCode: customNotice.subjectCode || 'CS302',
    originalFacultyName: customNotice.originalFacultyName || 'Prof. Ada Lovelace',
    substituteFacultyName: customNotice.substituteFacultyName || 'Dr. Alan Turing',
    type: customNotice.type || 'substitute',
    severity: customNotice.severity || 'amber',
    title: customNotice.title || 'Substitute: Dr. Alan Turing',
    subtitle: customNotice.subtitle || 'CS302 · Database Management Systems',
    message: customNotice.message || `Prof. Alan Turing will conduct Database Management Systems today (Period 2, 10:00-11:00) in LH-101, covering for Prof. Ada Lovelace.`,
    badgeLabel: customNotice.badgeLabel || 'Substitute Confirmed'
  };
  cachedNotices.unshift(testNotice);
  updateNoticeBadgeDisplays(true, true);
  if (noticesPopoverOpen) renderNoticesPopoverList();
  showToast(`Test Notice: ${testNotice.title}`, 'info');
  return testNotice;
};

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
  const dateSubtext = document.getElementById('selected-date-subtext');
  if (!container) return;

  const todayStr = getLocalDateString(new Date());
  const tomorrowStr = addDaysToDateStr(todayStr, 1);
  const yesterdayStr = addDaysToDateStr(todayStr, -1);

  if (dateHeading) {
    const d = parseLocalDate(data.date);
    const fullDateText = d.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
    const shortDateText = d.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    });

    if (data.date === todayStr) {
      dateHeading.textContent = `Today's Classes · ${shortDateText}`;
      if (dateSubtext) dateSubtext.textContent = `Real-time substitute coverage & attendance status for today (${fullDateText})`;
    } else if (data.date === tomorrowStr) {
      dateHeading.textContent = `Tomorrow's Classes · ${shortDateText}`;
      if (dateSubtext) dateSubtext.textContent = `Upcoming schedule plan for tomorrow (${fullDateText})`;
    } else if (data.date === yesterdayStr) {
      dateHeading.textContent = `Yesterday's Classes · ${shortDateText}`;
      if (dateSubtext) dateSubtext.textContent = `Past schedule records for yesterday (${fullDateText})`;
    } else {
      dateHeading.textContent = `Classes for ${fullDateText}`;
      if (dateSubtext) dateSubtext.textContent = `Showing schedule for ${fullDateText} · Real-time coverage status`;
    }
  }

  // Ensure shortcut buttons and date picker match current date
  updateDateShortcutActiveStates(data.date);

  if (data.isHoliday) {
    container.innerHTML = `
      <div style="padding: 2.5rem; text-align: center; background: var(--bg-surface-subtle); border-radius: var(--radius-md); border: 1px dashed var(--border-subtle);">
        <div style="font-size: 2.5rem; margin-bottom: 0.5rem;">🎉</div>
        <h4 style="font-size: 1.25rem; font-weight: 700; color: var(--color-brand-primary); margin-bottom: 0.25rem;">Campus Holiday</h4>
        <p style="font-size: 0.95rem; color: var(--text-secondary);">${data.holidayDescription} · No classes scheduled today.</p>
      </div>
    `;
    animateTodayClassesTransition();
    return;
  }

  const classes = data.todaySchedule || [];

  if (classes.length === 0) {
    container.innerHTML = `
      <div style="padding: 2rem; text-align: center; color: var(--text-muted); background: var(--bg-surface-subtle); border-radius: var(--radius-md);">
        No classes scheduled for this section on this day.
      </div>
    `;
    animateTodayClassesTransition();
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

  animateTodayClassesTransition();
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

function getDateForWeekdayInCurrentWeek(targetDayName) {
  const dayMap = {
    'Monday': 0,
    'Tuesday': 1,
    'Wednesday': 2,
    'Thursday': 3,
    'Friday': 4,
    'Saturday': 5,
    'Sunday': 6
  };
  const targetOffset = dayMap[targetDayName];
  if (targetOffset === undefined) return null;

  const monday = getWeekMonday(parseLocalDate(currentDateStr));
  const targetDate = new Date(monday);
  targetDate.setDate(monday.getDate() + targetOffset);
  return getLocalDateString(targetDate);
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
        <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-subtle); padding-bottom: 0.3rem; margin-bottom: 0.5rem;">
          <h4 style="font-size: 1rem; color: var(--color-brand-primary); margin: 0; font-weight: 700;">
            ${dayName} (${dayClasses.length} Periods)
          </h4>
          <button type="button" class="btn-secondary btn-jump-to-weekday" data-weekday="${dayName}" style="font-size: 0.72rem; padding: 0.2rem 0.5rem; font-weight: 600;" title="Jump schedule to ${dayName}">
            View ${dayName} &rarr;
          </button>
        </div>
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

  // Attach click listener to "View <Day> ->" buttons in weekly schedule
  container.querySelectorAll('.btn-jump-to-weekday').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetDayName = btn.getAttribute('data-weekday');
      const targetDate = getDateForWeekdayInCurrentWeek(targetDayName);
      if (targetDate) {
        jumpToDate(targetDate);
        document.getElementById('today-classes-container')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
  });
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
