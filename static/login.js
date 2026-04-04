const loginForm = document.getElementById('login-form');
const loginHint = document.getElementById('login-hint');
const googleLoginBtn = document.getElementById('google-login-btn');
const googleLoginHint = document.getElementById('google-login-hint');

let authConfig = { google_enabled: false, google_client_id: null };
let googleIdentityScriptPromise = null;
let googleClientInitialized = false;

async function callApi(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    let errorMessage = 'Request failed';
    try {
      const data = await res.json();
      // Extract error message from various possible fields
      if (data.detail) {
        errorMessage = data.detail;
      } else if (data.message) {
        errorMessage = data.message;
      } else if (data.error) {
        errorMessage = data.error;
      } else if (data.errors && Array.isArray(data.errors) && data.errors.length > 0) {
        errorMessage = data.errors[0].message || data.errors[0];
      } else {
        errorMessage = `Error ${res.status}: ${res.statusText}`;
      }
    } catch (e) {
      // If JSON parsing fails, use status text
      errorMessage = `Error ${res.status}: ${res.statusText}`;
    }
    throw new Error(errorMessage);
  }
  return res.json();
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

  // Show immediate loading state
  showLoginLoading();

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
    hideLoginLoading();

    // Properly extract error message
    let errorMessage = 'Login failed. Please try again.';

    if (err instanceof Error) {
      errorMessage = err.message;
    } else if (typeof err === 'object' && err !== null) {
      // Handle object errors
      errorMessage = err.detail || err.message || err.error || JSON.stringify(err);
    } else {
      errorMessage = String(err);
    }

    console.error('Login error:', err); // Log full error for debugging

    // Show user-friendly error message
    if (errorMessage.includes('Invalid user ID or password') || errorMessage.includes('Invalid credentials')) {
      window.alert('Invalid username or password. Please check your credentials and try again.');
    } else if (errorMessage.includes('User not found')) {
      window.alert('Account not found. Please check your username or contact support.');
    } else if (errorMessage.includes('network') || errorMessage.includes('fetch')) {
      window.alert('Network error. Please check your connection and try again.');
    } else if (errorMessage.includes('[object Object]')) {
      window.alert('Login failed. Please check your credentials and try again.');
    } else {
      window.alert(errorMessage || 'Login failed. Please try again.');
    }
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

['user_id', 'password'].forEach((fieldName) => {
  const field = loginForm.elements[fieldName];
  if (!(field instanceof HTMLElement)) return;
  field.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    // Allow default form submission behavior
    const submitEvent = new Event('submit', { bubbles: true, cancelable: true });
    loginForm.dispatchEvent(submitEvent);
  });
});

initLogin().catch((err) => {
  console.error('Login initialization failed:', err);
});
