const loginForm = document.getElementById('login-form');
const loginHint = document.getElementById('login-hint');
const googleLoginBtn = document.getElementById('google-login-btn');
const googleLoginHint = document.getElementById('google-login-hint');

let authConfig = { google_enabled: false, google_client_id: null };
let googleIdentityScriptPromise = null;
let googleClientInitialized = false;

function initPasswordToggles(root = document) {
  root.querySelectorAll('[data-password-toggle]').forEach((button) => {
    if (button.dataset.bound === 'true') return;
    button.addEventListener('click', () => {
      const field = button.closest('.password-field');
      const input = field?.querySelector('input');
      if (!input) return;
      const showIcon = button.querySelector('.password-toggle-icon-show');
      const hideIcon = button.querySelector('.password-toggle-icon-hide');
      const revealing = input.type === 'password';
      input.type = revealing ? 'text' : 'password';
      button.setAttribute('aria-label', revealing ? 'Hide password' : 'Show password');
      showIcon?.classList.toggle('hidden', revealing);
      hideIcon?.classList.toggle('hidden', !revealing);
    });
    button.dataset.bound = 'true';
  });
}

async function callApi(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    let errorMessage = `Error ${res.status}: ${res.statusText || 'Request failed'}`;
    try {
      const data = await res.json();
      errorMessage = toErrorMessage(data, errorMessage);
    } catch (e) {
      // keep fallback message
    }
    throw new Error(errorMessage);
  }
  return res.json();
}

function toErrorMessage(data, fallback = 'Request failed') {
  if (!data) return fallback;
  if (typeof data === 'string') return data;

  if (Array.isArray(data)) {
    const parts = data
      .map((item) => toErrorMessage(item, ''))
      .filter(Boolean);
    return parts.length ? parts.join(', ') : fallback;
  }

  if (typeof data !== 'object') return String(data);

  const detail = data.detail;
  if (typeof detail === 'string' && detail.trim()) return detail.trim();
  if (Array.isArray(detail)) {
    const parts = detail
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          const loc = Array.isArray(item.loc) ? item.loc.join('.') : '';
          const msg = typeof item.msg === 'string' ? item.msg : '';
          return [loc, msg].filter(Boolean).join(': ');
        }
        return '';
      })
      .filter(Boolean);
    if (parts.length) return parts.join(', ');
  }

  if (typeof data.message === 'string' && data.message.trim()) return data.message.trim();
  if (typeof data.error === 'string' && data.error.trim()) return data.error.trim();

  return fallback;
}

function setLoginHintState(text, kind = 'neutral') {
  loginHint.textContent = text;
  loginHint.classList.toggle('auth-text-error', kind === 'error');
  loginHint.classList.toggle('auth-text-success', kind === 'success');
}

function toFriendlyLoginError(message) {
  const msg = String(message || '').toLowerCase();
  if (!msg) return 'Login failed. Please try again.';
  if (msg.includes('invalid user id/email or password') || msg.includes('invalid user id or password') || msg.includes('invalid credentials')) {
    return 'Invalid user ID/email or password. Please try again.';
  }
  if (
    (msg.includes('body.user_id') && msg.includes('at least 1 character'))
    || (msg.includes('body.password') && msg.includes('at least 1 character'))
    || msg.includes('string should have at least 1 character')
    || msg.includes('value_error.any_str.min_length')
  ) {
    return 'Username and password are required.';
  }
  if (msg.includes('user not found')) {
    return 'Account not found. Please check your username.';
  }
  if (msg.includes('network') || msg.includes('fetch')) {
    return 'Network error. Please check your connection and try again.';
  }
  if (msg.includes('value_error.missing') || msg.includes('field required')) {
    return 'User ID/email and password are required.';
  }
  return message;
}

function applyAuthResult(result) {
  localStorage.setItem('league-ledger-token', result.token);
  if (result.refresh_token) {
    localStorage.setItem('league-ledger-refresh-token', result.refresh_token);
  }
  localStorage.setItem('league-ledger-user-role', result.user.league_role === 'admin' ? 'admin' : 'read');
  localStorage.setItem('league-ledger-username', result.user.user_id);
  localStorage.setItem('league-ledger-full-name', result.user.full_name || result.user.user_id);
  if (result.user.active_league_id) {
    localStorage.setItem('league-ledger-active-league-id', String(result.user.active_league_id));
  }
  const next = localStorage.getItem('league-ledger-post-auth-path') || '/welcome';
  localStorage.removeItem('league-ledger-post-auth-path');
  window.location.replace(next);
}

function setGoogleState(kind, text) {
  googleLoginHint.textContent = text;
  googleLoginHint.classList.toggle('auth-text-success', kind === 'success');
  googleLoginHint.classList.toggle('auth-text-error', kind === 'error');
}

function getSavedTheme() {
  const stored = localStorage.getItem('dhaneshlabs-theme');
  if (stored === 'light' || stored === 'dark') return stored;
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
    return 'light';
  }
  return 'dark';
}

function updateThemeIcons(theme) {
  const themeToggle = document.getElementById('theme-toggle');
  const lightIcon = document.getElementById('light-icon');
  const darkIcon = document.getElementById('dark-icon');
  if (!lightIcon || !darkIcon) return;

  lightIcon.classList.toggle('active', theme === 'light');
  darkIcon.classList.toggle('active', theme !== 'light');
  if (themeToggle) {
    themeToggle.setAttribute('aria-label', 'Toggle theme');
    themeToggle.setAttribute('aria-pressed', String(theme === 'dark'));
    themeToggle.dataset.theme = theme;
  }
}

function initThemeToggle() {
  const themeToggle = document.getElementById('theme-toggle');
  if (!themeToggle) return;

  const savedTheme = getSavedTheme();
  document.documentElement.setAttribute('data-theme', savedTheme);
  updateThemeIcons(savedTheme);

  themeToggle.addEventListener('click', () => {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const nextTheme = currentTheme === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', nextTheme);
    localStorage.setItem('dhaneshlabs-theme', nextTheme);
    updateThemeIcons(nextTheme);
  });
}

function initGoogleLogin() {
  if (!authConfig.google_enabled || !authConfig.google_client_id) {
    googleLoginBtn.disabled = true;
    setGoogleState('error', 'Google sign-in is not configured in this environment yet.');
    return;
  }

  googleLoginBtn.disabled = false;
  setGoogleState('success', 'Tap to continue with Google when needed.');

  const loadGoogleIdentityScript = async () => {
    if (window.google?.accounts?.id) return;
    if (!googleIdentityScriptPromise) {
      googleIdentityScriptPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client';
        script.async = true;
        script.defer = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Failed to load Google sign-in client.'));
        document.head.appendChild(script);
      });
    }
    await googleIdentityScriptPromise;
  };

  const ensureGoogleClient = async () => {
    await loadGoogleIdentityScript();
    if (!window.google?.accounts?.id) {
      throw new Error('Google sign-in client is unavailable. Please try again.');
    }
    if (googleClientInitialized) return;

    google.accounts.id.initialize({
      client_id: authConfig.google_client_id,
      callback: async (response) => {
        try {
          const result = await callApi('/api/auth/google', {
            method: 'POST',
            body: JSON.stringify({ credential: response.credential }),
          });
          applyAuthResult(result);
        } catch (error) {
          setGoogleState('error', error instanceof Error ? error.message : String(error));
        }
      },
    });

    googleClientInitialized = true;
  };

  googleLoginBtn.addEventListener('click', async () => {
    try {
      googleLoginBtn.disabled = true;
      setGoogleState('success', 'Loading Google sign-in…');
      await ensureGoogleClient();
      google.accounts.id.prompt();
      setGoogleState('success', 'Continue in the Google sign-in popup.');
    } catch (error) {
      setGoogleState('error', error instanceof Error ? error.message : String(error));
    } finally {
      googleLoginBtn.disabled = false;
    }
  });
}

async function initLogin() {
  const storedRole = localStorage.getItem('dhaneshlabs-login-role-hint');
  if (storedRole === 'read') {
    document.body.classList.add('login-read-mode');
  }

  initThemeToggle();
  const token = localStorage.getItem('league-ledger-token');
  if (token) {
    window.location.replace(localStorage.getItem('league-ledger-post-auth-path') || '/welcome');
    return;
  }

  initPasswordToggles(loginForm);
  try {
    authConfig = await callApi('/api/auth/config');
    setLoginHintState('Use your user ID or email to sign in.');
    initGoogleLogin();
  } catch (err) {
    setLoginHintState('');
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const formData = new FormData(loginForm);
  const payload = {
    user_id: String(formData.get('user_id') || '').trim(),
    password: String(formData.get('password') || ''),
  };

  if (!payload.user_id || !payload.password) {
    setLoginHintState('User ID/email and password are required.', 'error');
    return;
  }

  showLoginLoading();
  setLoginHintState('Signing you in...');

  try {
    const result = await callApi('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    applyAuthResult(result);
  } catch (err) {
    hideLoginLoading();
    const rawMessage = err instanceof Error ? err.message : toErrorMessage(err, 'Login failed. Please try again.');
    const friendlyMessage = toFriendlyLoginError(rawMessage);
    setLoginHintState(friendlyMessage, 'error');
    console.error('Login error:', err);
  }
});

function showLoginLoading() {
  const submitBtn = loginForm.querySelector('button[type="submit"]');
  const usernameField = loginForm.elements.user_id;
  const passwordField = loginForm.elements.password;

  // Disable form elements
  submitBtn.disabled = true;
  usernameField.disabled = true;
  passwordField.disabled = true;

  // Add loading class to button
  submitBtn.classList.add('loading');

  // Add loading indication to fields
  usernameField.classList.add('loading');
  passwordField.classList.add('loading');
}

function hideLoginLoading() {
  const submitBtn = loginForm.querySelector('button[type="submit"]');
  const usernameField = loginForm.elements.user_id;
  const passwordField = loginForm.elements.password;

  // Re-enable form elements
  submitBtn.disabled = false;
  usernameField.disabled = false;
  passwordField.disabled = false;

  // Remove loading indication
  submitBtn.classList.remove('loading');
  usernameField.classList.remove('loading');
  passwordField.classList.remove('loading');
}

initLogin().catch((err) => {
  console.error('Login initialization failed:', err);
});
