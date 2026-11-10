import { showToast } from './toast.js';

export function getStoredToken() {
  try {
    return localStorage.getItem('ctas_token') || sessionStorage.getItem('ctas_token') || '';
  } catch {
    return '';
  }
}

export function setStoredToken(token) {
  try {
    if (token) {
      localStorage.setItem('ctas_token', token);
      sessionStorage.setItem('ctas_token', token);
    } else {
      localStorage.removeItem('ctas_token');
      sessionStorage.removeItem('ctas_token');
    }
  } catch {}
}

export function getStoredUser() {
  try {
    const raw = localStorage.getItem('ctas_user') || sessionStorage.getItem('ctas_user');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setStoredUser(user) {
  try {
    if (user) {
      const serialized = JSON.stringify(user);
      localStorage.setItem('ctas_user', serialized);
      sessionStorage.setItem('ctas_user', serialized);
    } else {
      localStorage.removeItem('ctas_user');
      sessionStorage.removeItem('ctas_user');
    }
  } catch {}
}

export async function apiRequest(endpoint, options = {}) {
  let opts = options;
  if (typeof opts === 'string') {
    const method = opts.toUpperCase();
    const body = arguments[2];
    opts = { method, body };
  }

  const url = endpoint.startsWith('/') ? endpoint : `/api/${endpoint}`;
  
  const token = getStoredToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    ...(opts.headers || {})
  };

  const config = {
    method: opts.method || 'GET',
    headers,
    credentials: 'include', // Includes httpOnly JWT cookie
    ...(opts.body ? { body: typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body) } : {})
  };

  try {
    const res = await fetch(url, config);
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const errorMsg = data.error || `HTTP error ${res.status}`;
      if (options.showErrorToast !== false) {
        showToast(errorMsg, 'error');
      }
      const err = new Error(errorMsg);
      err.status = res.status;
      err.data = data;
      throw err;
    }

    return data;
  } catch (err) {
    if (err.name === 'TypeError' && err.message.includes('fetch')) {
      showToast('Network error: unable to connect to server', 'error');
    }
    throw err;
  }
}

export default apiRequest;
