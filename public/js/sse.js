import { showToast } from './toast.js';

let eventSource = null;
let reconnectTimer = null;
const listeners = new Map();

export function initSSE(url = '/api/events') {
  if (eventSource) return;

  function connect() {
    let sseUrl = url;
    try {
      const token = localStorage.getItem('ctas_token') || sessionStorage.getItem('ctas_token');
      if (token) {
        const separator = url.includes('?') ? '&' : '?';
        sseUrl = `${url}${separator}token=${encodeURIComponent(token)}`;
      }
    } catch {}

    eventSource = new EventSource(sseUrl);

    eventSource.onopen = () => {
      console.log('[CTAS SSE] Connected to real-time stream');
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
      eventSource = null;
      if (!reconnectTimer) {
        reconnectTimer = setTimeout(connect, 5000);
      }
    };

    eventSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        triggerListeners('message', data);
      } catch (err) {
        console.error('[CTAS SSE] Message parse error:', err);
      }
    };

    // Specific event listeners
    const knownEvents = [
      'timetable.updated',
      'timetable.generation_progress',
      'timetable.generation_completed',
      'timetable.generation_failed',
      'absence:created',
      'substitution:claimed',
      'substitution:assigned',
      'absence.reported',
      'substitution.assigned',
      'notification.new'
    ];
    for (const ev of knownEvents) {
      eventSource.addEventListener(ev, (e) => {
        try {
          const data = JSON.parse(e.data);
          triggerListeners(ev, data);
        } catch (err) {
          console.error(`[CTAS SSE] Parse error for ${ev}:`, err);
        }
      });
    }
  }

  connect();
}

export function onEvent(eventName, callback) {
  if (!listeners.has(eventName)) {
    listeners.set(eventName, new Set());
  }
  listeners.get(eventName).add(callback);
  return () => offEvent(eventName, callback);
}

export function offEvent(eventName, callback) {
  if (listeners.has(eventName)) {
    listeners.get(eventName).delete(callback);
  }
}

function triggerListeners(eventName, data) {
  const set = listeners.get(eventName);
  if (set) {
    for (const cb of set) {
      try { cb(data); } catch (e) { console.error(e); }
    }
  }
}

export default {
  initSSE,
  onEvent,
  offEvent
};
