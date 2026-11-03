import { apiRequest, setStoredToken, setStoredUser, getStoredUser, getStoredToken } from './api.js';
import { showToast } from './toast.js';

export async function login(username, password, role) {
  setStoredToken(null);
  setStoredUser(null);
  try {
    const data = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: { username, password, role }
    });

    if (data?.token) {
      setStoredToken(data.token);
    }
    if (data?.user) {
      setStoredUser(data.user);
    }

    const displayName = data.user.facultyName || data.user.faculty_name || data.user.fullName || data.user.full_name || data.user.username;
    showToast(`Welcome, ${displayName}!`, 'success');

    // Route to actual user role dashboard
    const targetRole = data?.user?.role || role || 'admin';
    setTimeout(() => {
      if (targetRole === 'admin') window.location.href = '/admin/';
      else if (targetRole === 'faculty') window.location.href = '/faculty/';
      else if (targetRole === 'student') window.location.href = '/student/';
      else window.location.href = '/';
    }, 200);

    return data;
  } catch (err) {
    // Error is toasted automatically by apiRequest
    return null;
  }
}

export async function logout() {
  setStoredToken(null);
  setStoredUser(null);
  try {
    await apiRequest('/api/auth/logout', { method: 'POST', showErrorToast: false });
    showToast('Logged out successfully', 'info');
  } catch (err) {
    // Ignore error on logout
  } finally {
    setTimeout(() => {
      window.location.href = '/';
    }, 150);
  }
}

export async function getCurrentUser() {
  const token = getStoredToken();

  try {
    const res = await apiRequest('/api/auth/me', { showErrorToast: false });
    if (res?.user) {
      setStoredUser(res.user);
      return res.user;
    }
  } catch (err) {
    // If explicit 401/403 returned, authentication is expired/invalid
    if (err.status === 401 || err.status === 403) {
      setStoredToken(null);
      setStoredUser(null);
      return null;
    }

    // For transient network errors, if token and cached user exist, fallback to cached user
    const cachedUser = getStoredUser();
    if (cachedUser && token) {
      return cachedUser;
    }
  }
  return null;
}

export async function checkSession(expectedRole) {
  const user = await getCurrentUser();
  if (!user || (user.username && user.username.toLowerCase() === 'raj')) {
    setStoredToken(null);
    setStoredUser(null);
    window.location.href = '/#login';
    return null;
  }

  // Cross-role guard: allow admin everywhere, but restrict faculty & students
  if (expectedRole && user.role !== expectedRole && user.role !== 'admin') {
    showToast(`Access denied: Your account role is '${user.role}'`, 'error');
    setTimeout(() => {
      window.location.href = `/${user.role}/`;
    }, 600);
    return null;
  }

  // Populate header user badge if present (pulling linked faculty record name first)
  const userDisplay = document.getElementById('user-display-name');
  if (userDisplay) {
    userDisplay.textContent = user.facultyName || user.faculty_name || user.fullName || user.full_name || user.username;
  }

  const roleBadge = document.getElementById('user-role-badge');
  if (roleBadge) {
    roleBadge.textContent = (user.role || '').toUpperCase();
  }

  return user;
}

export async function changePassword(currentPassword, newPassword) {
  return await apiRequest('/api/auth/change-password', {
    method: 'POST',
    body: { currentPassword, newPassword }
  });
}

export default {
  login,
  logout,
  getCurrentUser,
  checkSession,
  changePassword
};
