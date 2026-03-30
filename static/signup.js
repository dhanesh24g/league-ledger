const signupForm = document.getElementById('signup-form');
const signupHint = document.getElementById('signup-hint');
const googleSignupBtn = document.getElementById('google-signup-btn');
const googleSignupHint = document.getElementById('google-signup-hint');
const userIdStatus = document.getElementById('user-id-status');
const suggestionsRow = document.getElementById('user-id-suggestions');

let authConfig = { google_enabled: false, google_client_id: null };
let userIdCheckTimer = null;
let lastSuggestedSeed = '';

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
    checkUserIdAvailability().catch(() => {});
    return;
  }
  userIdCheckTimer = window.setTimeout(() => {
    checkUserIdAvailability().catch(() => {});
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
  if (!authConfig.google_enabled || !authConfig.google_client_id || !window.google?.accounts?.id) {
    googleSignupBtn.disabled = true;
    setGoogleState('error', 'Google sign-up is not configured in this environment yet.');
    return;
  }

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

  googleSignupBtn.addEventListener('click', () => {
    google.accounts.id.prompt();
  });
}

async function initSignup() {
  initThemeToggle();
  const token = localStorage.getItem('league-ledger-token');
  if (token) {
    window.location.replace(localStorage.getItem('league-ledger-post-auth-path') || '/welcome');
    return;
  }

  authConfig = await callApi('/api/auth/config');
  signupHint.textContent = `After signup, your session stays valid for ${authConfig.session_ttl_hours || 4} hours.`;
  initGoogleSignup();
  await refreshSuggestions(true);
}

signupForm.elements.first_name.addEventListener('input', () => {
  refreshSuggestions().catch(() => {});
});
signupForm.elements.last_name.addEventListener('input', () => {
  refreshSuggestions().catch(() => {});
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
