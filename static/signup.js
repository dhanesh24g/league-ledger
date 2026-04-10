const signupForm = document.getElementById('signup-form');
const signupHint = document.getElementById('signup-hint');
const googleSignupBtn = document.getElementById('google-signup-btn');
const googleSignupHint = document.getElementById('google-signup-hint');
const userIdStatus = document.getElementById('user-id-status');
const suggestionsRow = document.getElementById('user-id-suggestions');
const googleSignupRenderRoot = document.getElementById('google-signup-render-root');

let authConfig = { google_enabled: false, google_client_id: null };
let userIdCheckTimer = null;
let lastSuggestedSeed = '';
let googleIdentityScriptPromise = null;
let googleClientInitialized = false;

function renderUnavailableGoogleButton(root, unavailableLabel) {
  if (!root) return;
  root.innerHTML = `<div class="auth-google-button-fallback" aria-disabled="true">${unavailableLabel}</div>`;
  googleSignupBtn?.setAttribute('aria-disabled', 'true');
  googleSignupBtn?.classList.add('is-unavailable');
}

function clearUnavailableGoogleButton(root) {
  if (!root) return;
  root.innerHTML = '';
  googleSignupBtn?.setAttribute('aria-disabled', 'false');
  googleSignupBtn?.classList.remove('is-unavailable');
}

function googleButtonWidth(root) {
  const measured = Math.round(root?.clientWidth || 0);
  return Math.min(Math.max(measured || 280, 240), 380);
}

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
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || 'Request failed');
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
  googleSignupHint.textContent = text;
  googleSignupHint.classList.toggle('auth-text-success', kind === 'success');
  googleSignupHint.classList.toggle('auth-text-error', kind === 'error');
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

  const applyNextTheme = () => {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const nextTheme = currentTheme === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', nextTheme);
    localStorage.setItem('dhaneshlabs-theme', nextTheme);
    updateThemeIcons(nextTheme);
  };

  themeToggle.addEventListener('pointerup', (event) => {
    event.preventDefault();
    applyNextTheme();
  });

  themeToggle.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    applyNextTheme();
  });
}

function renderSuggestions(suggestions) {
  suggestionsRow.innerHTML = '';
  if (!suggestions.length) {
    suggestionsRow.classList.add('hidden');
    return;
  }
  suggestions.forEach((suggestion) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'suggestion-chip';
    button.textContent = suggestion;
    button.addEventListener('click', () => {
      signupForm.elements.user_id.value = suggestion;
      queueUserIdCheck(true);
    });
    suggestionsRow.appendChild(button);
  });
  suggestionsRow.classList.remove('hidden');
}

async function refreshSuggestions(force = false) {
  const firstName = String(signupForm.elements.first_name.value || '').trim();
  const lastName = String(signupForm.elements.last_name.value || '').trim();
  const seed = `${firstName}|${lastName}`;
  if (!force && seed === lastSuggestedSeed) return;
  lastSuggestedSeed = seed;

  if (!firstName) {
    renderSuggestions([]);
    return;
  }

  try {
    const result = await callApi(`/api/auth/user-id-suggestions?first_name=${encodeURIComponent(firstName)}&last_name=${encodeURIComponent(lastName)}`);
    renderSuggestions(result.suggestions || []);
  } catch (error) {
    renderSuggestions([]);
  }
}

async function checkUserIdAvailability() {
  const raw = String(signupForm.elements.user_id.value || '').trim();
  if (!raw) {
    userIdStatus.textContent = '';
    userIdStatus.className = 'muted small auth-inline-hint';
    return;
  }

  try {
    const result = await callApi(`/api/auth/user-id-check?user_id=${encodeURIComponent(raw)}`);
    if (result.available) {
      userIdStatus.textContent = `Available as ${result.normalized}`;
      userIdStatus.className = 'small auth-inline-hint auth-text-success';
    } else {
      userIdStatus.textContent = result.reason || 'Username is not available';
      userIdStatus.className = 'small auth-inline-hint auth-text-error';
    }
  } catch (error) {
    userIdStatus.textContent = '';
    userIdStatus.className = 'muted small auth-inline-hint';
  }
}

function queueUserIdCheck(immediate = false) {
  if (userIdCheckTimer) {
    window.clearTimeout(userIdCheckTimer);
  }
  if (immediate) {
    checkUserIdAvailability().catch(() => { });
    return;
  }
  userIdCheckTimer = window.setTimeout(() => {
    checkUserIdAvailability().catch(() => { });
  }, 220);
}

async function handleGoogleCredential(credential) {
  const result = await callApi('/api/auth/google/profile', {
    method: 'POST',
    body: JSON.stringify({ credential }),
  });
  const profile = result.profile;
  signupForm.elements.first_name.value = profile.first_name || '';
  signupForm.elements.last_name.value = profile.last_name || '';
  signupForm.elements.email.value = profile.email || '';
  signupForm.elements.google_token.value = credential;
  signupForm.elements.email.readOnly = true;
  signupForm.elements.password.required = false;
  signupForm.elements.password.placeholder = 'Optional after Google verification';
  setGoogleState('success', 'Google profile verified. Choose your username and continue.');
  await refreshSuggestions(true);
  queueUserIdCheck(true);
}

function initGoogleSignup() {
  if (!authConfig.google_enabled || !authConfig.google_client_id) {
    renderUnavailableGoogleButton(googleSignupRenderRoot, 'Google sign-up unavailable');
    setGoogleState('error', 'Google sign-up is unavailable until the Google client ID is configured for this environment.');
    return;
  }

  clearUnavailableGoogleButton(googleSignupRenderRoot);
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
        script.onerror = () => reject(new Error('Failed to load Google sign-up client.'));
        document.head.appendChild(script);
      });
    }
    await googleIdentityScriptPromise;
  };

  const ensureGoogleClient = async () => {
    await loadGoogleIdentityScript();
    if (!window.google?.accounts?.id) {
      throw new Error('Google sign-up client is unavailable. Please try again.');
    }
    if (googleClientInitialized) return;

    google.accounts.id.initialize({
      client_id: authConfig.google_client_id,
      callback: async (response) => {
        try {
          await handleGoogleCredential(response.credential);
        } catch (error) {
          setGoogleState('error', error instanceof Error ? error.message : String(error));
        }
      },
    });

    googleClientInitialized = true;
  };

  const renderGoogleButton = async () => {
    try {
      setGoogleState('success', 'Loading Google sign-up…');
      await ensureGoogleClient();
      if (!googleSignupRenderRoot) return;
      googleSignupRenderRoot.innerHTML = '';
      google.accounts.id.renderButton(googleSignupRenderRoot, {
        type: 'standard',
        theme: document.documentElement.getAttribute('data-theme') === 'light' ? 'outline' : 'filled_blue',
        size: 'large',
        shape: 'pill',
        text: 'continue_with',
        width: googleButtonWidth(googleSignupRenderRoot),
      });
      setGoogleState('success', 'Continue with Google using the button above.');
    } catch (error) {
      renderUnavailableGoogleButton(googleSignupRenderRoot, 'Google sign-up unavailable');
      setGoogleState('error', error instanceof Error ? error.message : String(error));
    }
  };

  renderGoogleButton().catch(() => { });
}

async function initSignup() {
  initThemeToggle();
  initPasswordToggles(signupForm);
  const token = localStorage.getItem('league-ledger-token');
  if (token) {
    window.location.replace(localStorage.getItem('league-ledger-post-auth-path') || '/welcome');
    return;
  }

  try {
    authConfig = await callApi('/api/auth/config');
    signupHint.textContent = 'Create your account to continue.';
    initGoogleSignup();
  } catch (err) {
    signupHint.textContent = 'Create your account to continue.';
    renderUnavailableGoogleButton(googleSignupRenderRoot, 'Google unavailable');
    setGoogleState('error', 'Google sign-up could not be initialized right now. Please try again later.');
  }
  await refreshSuggestions(true);
}

signupForm.elements.first_name.addEventListener('input', () => {
  refreshSuggestions().catch(() => { });
});
signupForm.elements.last_name.addEventListener('input', () => {
  refreshSuggestions().catch(() => { });
});
signupForm.elements.user_id.addEventListener('input', () => {
  queueUserIdCheck();
});
signupForm.elements.user_id.addEventListener('blur', () => {
  queueUserIdCheck(true);
});

signupForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const formData = new FormData(signupForm);
    const payload = {
      first_name: String(formData.get('first_name') || '').trim(),
      last_name: String(formData.get('last_name') || '').trim(),
      user_id: String(formData.get('user_id') || '').trim(),
      email: String(formData.get('email') || '').trim(),
      password: String(formData.get('password') || '') || null,
      google_token: String(formData.get('google_token') || '') || null,
    };
    const result = await callApi('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    applyAuthResult(result);
  } catch (err) {
    window.alert(err instanceof Error ? err.message : String(err));
  }
});

initSignup().catch((err) => {
  console.error('Signup initialization failed:', err);
  signupHint.textContent = err instanceof Error ? err.message : String(err);
});
