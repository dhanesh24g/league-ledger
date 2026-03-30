const loginForm = document.getElementById('login-form');
const loginHint = document.getElementById('login-hint');

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

async function initLogin() {
  const token = localStorage.getItem('league-ledger-token');
  if (token) {
    window.location.replace(localStorage.getItem('league-ledger-post-auth-path') || '/welcome');
    return;
  }

  try {
    const config = await callApi('/api/auth/config');
    loginHint.textContent = config.signup_enabled
      ? 'Use your user ID to login. New users can create an account first.'
      : '';
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
  } catch (err) {
    window.alert(err instanceof Error ? err.message : String(err));
  }
});

initLogin().catch((err) => {
  console.error('Login initialization failed:', err);
});
