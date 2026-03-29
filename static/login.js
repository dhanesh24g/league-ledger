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
    window.location.replace('/');
    return;
  }

  try {
    const config = await callApi('/api/auth/config');
    const users = (config.default_users || [])
      .map((u) => `${u.username} (${u.role})`)
      .join(', ');
    loginHint.textContent = users ? `Available users: ${users}` : '';
  } catch (err) {
    loginHint.textContent = '';
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const formData = new FormData(loginForm);
    const payload = {
      username: String(formData.get('username') || '').trim(),
      password: String(formData.get('password') || ''),
    };
    const result = await callApi('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    localStorage.setItem('league-ledger-token', result.token);
    localStorage.setItem('league-ledger-user-role', result.user.role);
    localStorage.setItem('league-ledger-username', result.user.username);
    window.location.replace('/');
  } catch (err) {
    window.alert(err instanceof Error ? err.message : String(err));
  }
});

initLogin().catch((err) => {
  console.error('Login initialization failed:', err);
});
