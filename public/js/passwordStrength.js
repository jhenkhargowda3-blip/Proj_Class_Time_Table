/**
 * Password Strength Evaluator & UI Meter
 * Calculates password entropy and updates visual strength indicators
 */

export function evaluatePasswordStrength(password = '') {
  if (!password) {
    return {
      score: 0,
      level: 'none',
      label: 'Empty',
      color: '#94a3b8',
      bars: 0,
      feedback: 'Enter a password'
    };
  }

  let score = 0;
  const len = password.length;

  if (len >= 6) score += 1;
  if (len >= 8) score += 1;
  if (len >= 12) score += 1;

  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
  if (/\d/.test(password)) score += 1;
  if (/[^A-Za-z0-9]/.test(password)) score += 1;

  const varieties = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /\d/.test(password),
    /[^A-Za-z0-9]/.test(password)
  ].filter(Boolean).length;

  // Classify score into 4 levels
  if (len < 6 || score <= 2) {
    return {
      score,
      level: 'weak',
      label: 'Weak',
      color: '#ef4444',
      bars: 1,
      feedback: 'Too short or simple (use letters, numbers & symbols)'
    };
  } else if (score <= 3 || varieties < 2) {
    return {
      score,
      level: 'fair',
      label: 'Fair',
      color: '#f59e0b',
      bars: 2,
      feedback: 'Moderate strength (add uppercase letters or symbols)'
    };
  } else if (score <= 5 && varieties >= 3) {
    return {
      score,
      level: 'good',
      label: 'Strong',
      color: '#10b981',
      bars: 3,
      feedback: 'Good security (increase length for maximum defense)'
    };
  } else {
    return {
      score,
      level: 'strong',
      label: 'Very Strong',
      color: '#059669',
      bars: 4,
      feedback: 'Excellent security · High entropy verified'
    };
  }
}

export function updatePasswordMeterUI(password, { wrapId, labelId, barIds = [], hintId = null }) {
  const wrap = document.getElementById(wrapId);
  const label = document.getElementById(labelId);
  const hint = hintId ? document.getElementById(hintId) : null;

  if (!password) {
    if (wrap) wrap.style.display = 'none';
    barIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.background = 'transparent';
    });
    return;
  }

  if (wrap) wrap.style.display = 'block';
  const result = evaluatePasswordStrength(password);

  if (label) {
    label.textContent = result.label;
    label.style.color = result.color;
  }

  if (hint && result.feedback) {
    hint.textContent = result.feedback;
  }

  barIds.forEach((id, idx) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (idx < result.bars) {
      el.style.background = result.color;
    } else {
      el.style.background = 'transparent';
    }
  });
}
