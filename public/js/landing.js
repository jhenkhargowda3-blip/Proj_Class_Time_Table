import { login } from './auth.js';
import { apiRequest } from './api.js';
import { showToast } from './toast.js';
import { updatePasswordMeterUI } from './passwordStrength.js';

let selectedRole = 'admin';

document.addEventListener('DOMContentLoaded', () => {
  const roleCards = document.querySelectorAll('.role-card');
  const roleTitle = document.getElementById('selected-role-title');
  const loginForm = document.getElementById('login-form');
  const usernameInput = document.getElementById('username');
  const passwordInput = document.getElementById('password');
  const togglePasswordBtn = document.getElementById('toggle-password-btn');

  // Auth views
  const authViewLogin = document.getElementById('auth-view-login');
  const authViewForgot = document.getElementById('auth-view-forgot');
  const authViewReset = document.getElementById('auth-view-reset');

  // Forgot password elements
  const btnShowForgot = document.getElementById('btn-show-forgot');
  const btnBackToLogin = document.getElementById('btn-back-to-login');
  const forgotForm = document.getElementById('forgot-password-form');
  const forgotEmailInput = document.getElementById('forgot-email');
  const btnSubmitForgot = document.getElementById('btn-submit-forgot');
  const forgotSuccessBox = document.getElementById('forgot-success-box');
  const forgotSuccessMsg = document.getElementById('forgot-success-msg');
  const simulatedLinkText = document.getElementById('simulated-link-text');
  const btnOpenSimulatedReset = document.getElementById('btn-open-simulated-reset');
  const forgotFillBtns = document.querySelectorAll('.forgot-fill-btn');

  // Reset password elements
  const resetForm = document.getElementById('reset-password-form');
  const resetTokenInput = document.getElementById('reset-token-input');
  const resetUserIntro = document.getElementById('reset-user-intro');
  const resetTokenErrorBox = document.getElementById('reset-token-error-box');
  const resetTokenErrorDesc = document.getElementById('reset-token-error-desc');
  const btnRequestNewReset = document.getElementById('btn-request-new-reset');
  const btnCancelReset = document.getElementById('btn-cancel-reset');
  const newPasswordInput = document.getElementById('new-password');
  const confirmNewPasswordInput = document.getElementById('confirm-new-password');
  const toggleNewPasswordBtn = document.getElementById('toggle-new-password-btn');
  const passwordMatchError = document.getElementById('password-match-error');
  const btnSubmitNewPassword = document.getElementById('btn-submit-new-password');

  function setRole(newRole) {
    selectedRole = newRole;
    roleCards.forEach(c => {
      if (c.getAttribute('data-role') === newRole) {
        c.classList.add('active');
      } else {
        c.classList.remove('active');
      }
    });
    if (roleTitle) {
      roleTitle.textContent = `${newRole.charAt(0).toUpperCase() + newRole.slice(1)} Portal Login`;
    }
  }

  // Switch between Login, Forgot Password, and Reset Password views
  function switchAuthView(viewName) {
    if (authViewLogin) authViewLogin.style.display = viewName === 'login' ? 'block' : 'none';
    if (authViewForgot) authViewForgot.style.display = viewName === 'forgot' ? 'block' : 'none';
    if (authViewReset) authViewReset.style.display = viewName === 'reset' ? 'block' : 'none';

    if (viewName === 'login') {
      setRole(selectedRole);
    } else if (viewName === 'forgot') {
      if (roleTitle) roleTitle.textContent = 'Account Recovery';
      if (forgotSuccessBox) forgotSuccessBox.style.display = 'none';
      if (forgotEmailInput) {
        forgotEmailInput.focus();
      }
    } else if (viewName === 'reset') {
      if (roleTitle) roleTitle.textContent = 'Set New Password';
      if (passwordMatchError) passwordMatchError.style.display = 'none';
    }
  }

  // Role card click handler
  roleCards.forEach(card => {
    card.addEventListener('click', () => {
      const r = card.getAttribute('data-role');
      if (r) {
        setRole(r);
        switchAuthView('login');
        if (usernameInput && passwordInput) {
          const currentU = usernameInput.value.trim().toLowerCase();
          const knownUsers = ['admin', 'faculty', 'student', 'sharma', 'raj', 'jhenkhar'];
          if (!currentU || knownUsers.includes(currentU)) {
            if (r === 'admin') {
              usernameInput.value = 'sharma';
              passwordInput.value = 'sharmajii';
            } else if (r === 'faculty') {
              usernameInput.value = 'raj';
              passwordInput.value = 'rajiv2112';
            } else if (r === 'student') {
              usernameInput.value = 'jhenkhar';
              passwordInput.value = 'rocky(Jg)';
            }
            passwordInput.dispatchEvent(new Event('input'));
          }
        }
      }
    });
  });

  // Password visibility toggle on login form
  if (togglePasswordBtn && passwordInput) {
    togglePasswordBtn.addEventListener('click', () => {
      const isPassword = passwordInput.getAttribute('type') === 'password';
      passwordInput.setAttribute('type', isPassword ? 'text' : 'password');
      togglePasswordBtn.textContent = isPassword ? 'Hide password' : 'Show password';
    });
  }

  // Password visibility toggle on new password form
  if (toggleNewPasswordBtn && newPasswordInput && confirmNewPasswordInput) {
    toggleNewPasswordBtn.addEventListener('click', () => {
      const isPassword = newPasswordInput.getAttribute('type') === 'password';
      newPasswordInput.setAttribute('type', isPassword ? 'text' : 'password');
      confirmNewPasswordInput.setAttribute('type', isPassword ? 'text' : 'password');
      toggleNewPasswordBtn.textContent = isPassword ? 'Hide password' : 'Show password';
    });
  }

  // 1. Live Password Strength Meter for Login Form
  if (passwordInput) {
    const updateLoginMeter = () => {
      updatePasswordMeterUI(passwordInput.value, {
        wrapId: 'login-password-meter-wrap',
        labelId: 'login-password-strength-label',
        barIds: ['login-meter-bar-1', 'login-meter-bar-2', 'login-meter-bar-3', 'login-meter-bar-4']
      });
    };
    passwordInput.addEventListener('input', updateLoginMeter);
    passwordInput.addEventListener('change', updateLoginMeter);
    if (passwordInput.value) updateLoginMeter();
  }

  // 2. Live Password Strength Meter for Reset Form
  if (newPasswordInput) {
    const updateResetMeter = () => {
      updatePasswordMeterUI(newPasswordInput.value, {
        wrapId: 'reset-password-meter-wrap',
        labelId: 'reset-password-strength-label',
        barIds: ['reset-meter-bar-1', 'reset-meter-bar-2', 'reset-meter-bar-3', 'reset-meter-bar-4'],
        hintId: 'reset-strength-hint'
      });
    };
    newPasswordInput.addEventListener('input', updateResetMeter);
    newPasswordInput.addEventListener('change', updateResetMeter);
    if (newPasswordInput.value) updateResetMeter();
  }

  // Auto-detect role based on username input
  if (usernameInput) {
    usernameInput.addEventListener('input', () => {
      const val = usernameInput.value.trim().toLowerCase();
      if (val.startsWith('faculty') && selectedRole !== 'faculty') {
        setRole('faculty');
      } else if (val.startsWith('student') && selectedRole !== 'student') {
        setRole('student');
      } else if (val === 'admin' && selectedRole !== 'admin') {
        setRole('admin');
      }
    });
  }

  // Demo credential helpers (fills credentials and immediately authenticates)
  const demoButtons = document.querySelectorAll('[data-demo-creds], .demo-fill-btn');
  demoButtons.forEach(btn => {
    btn.addEventListener('click', async () => {
      const u = btn.getAttribute('data-demo-user') || btn.getAttribute('data-demo-creds')?.split(':')[0];
      const p = btn.getAttribute('data-demo-pass') || btn.getAttribute('data-demo-creds')?.split(':')[1];
      const r = btn.getAttribute('data-demo-role') || btn.getAttribute('data-demo-creds')?.split(':')[2];

      if (usernameInput && u) usernameInput.value = u;
      if (passwordInput && p) passwordInput.value = p;
      if (r) setRole(r);

      switchAuthView('login');
      showToast(`Signing in as ${r || u}...`, 'info');
      await login(u, p, r);
    });
  });

  // Prefill default admin credentials on initial load for instant convenience
  if (usernameInput && !usernameInput.value) {
    usernameInput.value = 'sharma';
  }
  if (passwordInput && !passwordInput.value) {
    passwordInput.value = 'sharmajii';
  }
  if (passwordInput) {
    passwordInput.dispatchEvent(new Event('input'));
  }

  // Form submit handler
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = usernameInput?.value.trim();
      const password = passwordInput?.value;

      if (!username || !password) {
        showToast('Please provide both username and password', 'warning');
        return;
      }

      // Auto-adjust selectedRole to match username if clearly indicated
      const val = username.toLowerCase();
      let roleToUse = selectedRole;
      if ((val.startsWith('faculty') || val === 'raj') && roleToUse !== 'faculty') {
        roleToUse = 'faculty';
        setRole('faculty');
      } else if ((val.startsWith('student') || val === 'jhenkhar') && roleToUse !== 'student') {
        roleToUse = 'student';
        setRole('student');
      } else if ((val === 'admin' || val === 'sharma') && roleToUse !== 'admin') {
        roleToUse = 'admin';
        setRole('admin');
      }

      const submitBtn = loginForm.querySelector('button[type="submit"]');
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Authenticating...';
      }

      try {
        await login(username, password, roleToUse);
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Sign In to Portal';
        }
      }
    });
  }

  // Instant Presentation Demo Mode
  document.getElementById('btn-instant-demo')?.addEventListener('click', async () => {
    showToast('Starting instant presentation demo mode...', 'info');
    try {
      await login('sharma', 'sharmajii', 'admin');
    } catch (err) {
      showToast('Demo login failed: ' + err.message, 'error');
    }
  });

  // ==========================================
  // FORGOT PASSWORD FLOW
  // ==========================================

  // Switch to Forgot Password view
  if (btnShowForgot) {
    btnShowForgot.addEventListener('click', () => {
      switchAuthView('forgot');
    });
  }

  // Back to login from forgot view
  if (btnBackToLogin) {
    btnBackToLogin.addEventListener('click', () => {
      switchAuthView('login');
    });
  }

  // Cancel reset and return to login
  if (btnCancelReset) {
    btnCancelReset.addEventListener('click', () => {
      switchAuthView('login');
    });
  }

  // Request new reset link if current token failed
  if (btnRequestNewReset) {
    btnRequestNewReset.addEventListener('click', () => {
      switchAuthView('forgot');
    });
  }

  // Sample email fill chips
  forgotFillBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const email = btn.getAttribute('data-fill-email');
      if (email && forgotEmailInput) {
        forgotEmailInput.value = email;
        forgotEmailInput.focus();
        showToast(`Prefilled email: ${email}`, 'info');
      }
    });
  });

  let activeSimulatedToken = null;

  // Handle Forgot Password submission
  if (forgotForm) {
    forgotForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = forgotEmailInput?.value.trim();
      if (!email) {
        showToast('Please enter your email or username', 'warning');
        return;
      }

      if (btnSubmitForgot) {
        btnSubmitForgot.disabled = true;
        btnSubmitForgot.textContent = 'Sending reset link...';
      }

      try {
        const data = await apiRequest('/api/auth/forgot-password', {
          method: 'POST',
          body: { email }
        });

        if (forgotSuccessBox) {
          forgotSuccessBox.style.display = 'block';
        }
        if (forgotSuccessMsg) {
          forgotSuccessMsg.textContent = data.message;
        }

        if (data.token) {
          activeSimulatedToken = data.token;
          const resetUrl = `${window.location.origin}/#reset-password?token=${data.token}`;
          if (simulatedLinkText) {
            simulatedLinkText.textContent = resetUrl;
          }
          if (btnOpenSimulatedReset) {
            btnOpenSimulatedReset.style.display = 'block';
            btnOpenSimulatedReset.onclick = () => {
              loadResetToken(data.token);
            };
          }
          showToast('Password reset link generated & dispatched!', 'success');
        } else {
          activeSimulatedToken = null;
          if (simulatedLinkText) {
            simulatedLinkText.textContent = '(No user account registered with this email address)';
          }
          if (btnOpenSimulatedReset) {
            btnOpenSimulatedReset.style.display = 'none';
          }
          showToast(data.message, 'info');
        }
      } catch (err) {
        showToast(err.message || 'Failed to dispatch password reset request', 'error');
      } finally {
        if (btnSubmitForgot) {
          btnSubmitForgot.disabled = false;
          btnSubmitForgot.textContent = 'Send Secure Reset Link';
        }
      }
    });
  }

  // Open simulated reset button inside success box
  if (btnOpenSimulatedReset) {
    btnOpenSimulatedReset.addEventListener('click', () => {
      if (activeSimulatedToken) {
        loadResetToken(activeSimulatedToken);
      }
    });
  }

  // Verify and display Reset Password View for a token
  async function loadResetToken(token) {
    if (!token) return;

    switchAuthView('reset');
    if (resetTokenInput) resetTokenInput.value = token;
    if (resetUserIntro) resetUserIntro.textContent = 'Verifying security token...';
    if (resetTokenErrorBox) resetTokenErrorBox.style.display = 'none';
    if (resetForm) resetForm.style.display = 'block';
    if (passwordMatchError) passwordMatchError.style.display = 'none';
    if (newPasswordInput) newPasswordInput.value = '';
    if (confirmNewPasswordInput) confirmNewPasswordInput.value = '';

    try {
      const data = await apiRequest(`/api/auth/verify-reset-token?token=${encodeURIComponent(token)}`, {
        showErrorToast: false
      });

      if (data.valid) {
        if (resetUserIntro) {
          const roleBadge = data.role ? `[${data.role.toUpperCase()}]` : '';
          resetUserIntro.innerHTML = `Set a new password for <strong>${data.fullName || data.username}</strong> (<span style="color: var(--color-brand-primary); font-weight: 600;">@${data.username}</span> ${roleBadge})`;
        }
        if (resetForm) resetForm.style.display = 'block';
        if (newPasswordInput) newPasswordInput.focus();
      } else {
        throw new Error(data.error || 'Invalid reset token');
      }
    } catch (err) {
      if (resetForm) resetForm.style.display = 'none';
      if (resetTokenErrorBox) resetTokenErrorBox.style.display = 'block';
      if (resetTokenErrorDesc) resetTokenErrorDesc.textContent = err.message || 'This password reset link is invalid or has expired.';
      if (resetUserIntro) resetUserIntro.textContent = 'Verification Failed';
    }
  }

  // Real-time password match indicator
  if (confirmNewPasswordInput && newPasswordInput && passwordMatchError) {
    const checkMatch = () => {
      if (confirmNewPasswordInput.value && newPasswordInput.value !== confirmNewPasswordInput.value) {
        passwordMatchError.style.display = 'block';
      } else {
        passwordMatchError.style.display = 'none';
      }
    };
    newPasswordInput.addEventListener('input', checkMatch);
    confirmNewPasswordInput.addEventListener('input', checkMatch);
  }

  // Handle Set New Password submission
  if (resetForm) {
    resetForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const token = resetTokenInput?.value;
      const newPassword = newPasswordInput?.value;
      const confirmPassword = confirmNewPasswordInput?.value;

      if (!token) {
        showToast('Missing reset token. Please request a new link.', 'error');
        return;
      }

      if (!newPassword || newPassword.length < 6) {
        showToast('Password must be at least 6 characters long', 'warning');
        return;
      }

      if (newPassword !== confirmPassword) {
        if (passwordMatchError) passwordMatchError.style.display = 'block';
        showToast('Passwords do not match', 'error');
        return;
      }

      if (btnSubmitNewPassword) {
        btnSubmitNewPassword.disabled = true;
        btnSubmitNewPassword.textContent = 'Updating password...';
      }

      try {
        const data = await apiRequest('/api/auth/reset-password', {
          method: 'POST',
          body: { token, newPassword }
        });

        showToast(data.message || 'Password reset successfully! Please sign in with your new credentials.', 'success');

        // Transition back to login view with username prefilled
        switchAuthView('login');

        if (data.username && usernameInput) {
          usernameInput.value = data.username;
        }
        if (data.role) {
          setRole(data.role);
        }
        if (passwordInput) {
          passwordInput.value = '';
          passwordInput.focus();
        }

        // Clean query/hash from URL
        if (window.history && window.history.replaceState) {
          window.history.replaceState({}, document.title, window.location.pathname);
        }
      } catch (err) {
        showToast(err.message || 'Failed to reset password', 'error');
      } finally {
        if (btnSubmitNewPassword) {
          btnSubmitNewPassword.disabled = false;
          btnSubmitNewPassword.textContent = 'Save Password & Sign In';
        }
      }
    });
  }

  // Inspect URL for reset token on load (e.g. ?token=... or #reset-password?token=...)
  function checkUrlForResetToken() {
    const urlParams = new URLSearchParams(window.location.search);
    let token = urlParams.get('token');

    if (!token && window.location.hash) {
      const hash = window.location.hash;
      const queryIdx = hash.indexOf('?');
      if (queryIdx !== -1) {
        const hashParams = new URLSearchParams(hash.substring(queryIdx + 1));
        token = hashParams.get('token');
      } else if (hash.startsWith('#token=')) {
        token = hash.substring(7);
      }
    }

    if (token) {
      loadResetToken(token);
    }
  }

  // Run on mount
  checkUrlForResetToken();
});
