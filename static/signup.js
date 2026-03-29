const signupForm = document.getElementById('signup-form');
const signupHint = document.getElementById('signup-hint');

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

async function initSignup() {
  const token = localStorage.getItem('league-ledger-token');
  if (token) {
    window.location.replace('/welcome');
    return;
  }
  signupHint.textContent = 'After signup, you can create the first league or request access to an existing one.';
}

signupForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const formData = new FormData(signupForm);
    const payload = {
      first_name: String(formData.get('first_name') || '').trim(),
      last_name: String(formData.get('last_name') || '').trim(),
      user_id: String(formData.get('user_id') || '').trim(),
      email: String(formData.get('email') || '').trim(),
      password: String(formData.get('password') || ''),
    };
    const result = await callApi('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    localStorage.setItem('league-ledger-token', result.token);
    localStorage.setItem('league-ledger-user-role', result.user.league_role === 'admin' ? 'admin' : 'viewer');
    localStorage.setItem('league-ledger-username', result.user.user_id);
    localStorage.setItem('league-ledger-full-name', result.user.full_name || result.user.user_id);
    window.location.replace('/welcome');
  } catch (err) {
    window.alert(err instanceof Error ? err.message : String(err));
  }
});

initSignup().catch((err) => {
  console.error('Signup initialization failed:', err);
});
