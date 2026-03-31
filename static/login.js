const loginForm = document.getElementById('login-form');
const loginHint = document.getElementById('login-hint');
const googleLoginBtn = document.getElementById('google-login-btn');
const googleLoginHint = document.getElementById('google-login-hint');

let authConfig = { google_enabled: false, google_client_id: null };

async function callApi(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || 'Request failed');
  }
  return res.json();
}

function applyAuthResult(result) {
  localStorage.setItem('league-ledger-token', result.token);
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
    themeToggle.setAttribute('aria-label', `Theme setting: ${theme === 'light' ? 'Light' : 'Dark'}`);
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
  if (!authConfig.google_enabled || !authConfig.google_client_id || !window.google?.accounts?.id) {
    googleLoginBtn.disabled = true;
    setGoogleState('error', 'Google sign-in is not configured in this environment yet.');
    return;
  }

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

  googleLoginBtn.addEventListener('click', () => {
    google.accounts.id.prompt();
  });
}

async function init() {
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

  try {
    authConfig = await callApi('/api/auth/config');
    loginHint.textContent = `Use your username to sign in. Sessions stay valid for ${authConfig.session_ttl_hours || 4} hours.`;
    initGoogleLogin();
  } catch (err) {
    loginHint.textContent = '';
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const formData = new FormData(loginForm);
    const payload = {
      user_id: String(formData.get('user_id') || '').trim(),
      password: String(formData.get('password') || ''),
    };
    const result = await callApi('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    applyAuthResult(result);
  } catch (err) {
    window.alert(err instanceof Error ? err.message : String(err));
  }
});

['user_id', 'password'].forEach((fieldName) => {
  const field = loginForm.elements[fieldName];
  if (!(field instanceof HTMLElement)) return;
  field.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    loginForm.requestSubmit();
  });
});

initLogin().catch((err) => {
  console.error('Login initialization failed:', err);
});
