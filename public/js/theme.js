// Theme Toggle Manager (persists to localStorage across sessions)
const THEME_STORAGE_KEY = 'ctas_theme';

export function getSavedTheme() {
  if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
    try {
      const saved = localStorage.getItem(THEME_STORAGE_KEY);
      if (saved === 'dark' || saved === 'light') {
        return saved;
      }
    } catch (e) {
      console.warn('[CTAS] localStorage not accessible for reading theme:', e);
    }
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
  }
  return 'light';
}

export function setTheme(theme) {
  const targetTheme = theme === 'dark' ? 'dark' : 'light';
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.setAttribute('data-theme', targetTheme);
  }
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, targetTheme);
    } catch (e) {
      console.warn('[CTAS] localStorage not accessible for saving theme:', e);
    }
  }
  updateThemeIcon(targetTheme);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('ctas:theme-changed', { detail: { theme: targetTheme } }));
  }
  return targetTheme;
}

export function toggleTheme() {
  const current = (typeof document !== 'undefined' && document.documentElement ? document.documentElement.getAttribute('data-theme') : null) || getSavedTheme();
  const next = current === 'dark' ? 'light' : 'dark';
  return setTheme(next);
}

export function updateThemeIcon(theme) {
  if (typeof document === 'undefined') return;
  const current = theme || document.documentElement?.getAttribute('data-theme') || getSavedTheme();
  const iconSpan = document.getElementById('theme-icon');
  if (iconSpan) {
    iconSpan.textContent = current === 'dark' ? '☀️' : '🌙';
  }
  const btn = document.getElementById('theme-toggle-btn');
  if (btn) {
    btn.setAttribute('aria-label', current === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    btn.setAttribute('title', current === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  }
}

// Immediate theme initialization on script evaluation
(function initTheme() {
  if (typeof document !== 'undefined' && document.documentElement) {
    const initialTheme = getSavedTheme();
    document.documentElement.setAttribute('data-theme', initialTheme);
  }
})();

function bindThemeControls() {
  if (typeof document === 'undefined') return;
  const current = document.documentElement?.getAttribute('data-theme') || getSavedTheme();
  updateThemeIcon(current);
  const btn = document.getElementById('theme-toggle-btn');
  if (btn && !btn.dataset.themeBound) {
    btn.dataset.themeBound = 'true';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      toggleTheme();
    });
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindThemeControls);
  } else {
    bindThemeControls();
  }
}

// Sync theme changes in real-time if modified across tabs or windows
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === THEME_STORAGE_KEY && (e.newValue === 'light' || e.newValue === 'dark')) {
      if (typeof document !== 'undefined' && document.documentElement) {
        document.documentElement.setAttribute('data-theme', e.newValue);
      }
      updateThemeIcon(e.newValue);
    }
  });
}

export default { toggleTheme, setTheme, getSavedTheme, updateThemeIcon };


