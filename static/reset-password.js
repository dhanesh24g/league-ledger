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

const form = document.getElementById('reset-password-form');
const result = document.getElementById('reset-password-result');
const submitButton = form?.querySelector('button[type="submit"]');

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

function getResetToken() {
  const token = new URLSearchParams(window.location.search).get('token');
  return token ? token.trim() : '';
}

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  result.textContent = '';
  const originalLabel = submitButton?.textContent || 'Reset Password';

  const token = getResetToken();
  if (!token) {
    result.textContent = 'Reset token is missing. Please use the link from Forgot Password.';
    return;
  }

  const formData = new FormData(form);
  const newPassword = String(formData.get('new_password') || '');
  const confirmPassword = String(formData.get('confirm_password') || '');

  if (newPassword.length < 8) {
    result.textContent = 'New password must be at least 8 characters.';
    return;
  }
  if (newPassword !== confirmPassword) {
    result.textContent = 'Passwords do not match.';
    return;
  }

  try {
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = 'Resetting...';
    }
    await callApi('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, new_password: newPassword }),
    });

    result.textContent = 'Password reset successful. Redirecting to login...';
    window.setTimeout(() => {
      window.location.replace('/login');
    }, 1200);
  } catch (error) {
    result.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = originalLabel;
    }
  }
});

initThemeToggle();
initPasswordToggles(form);

if (!getResetToken() && submitButton) {
  submitButton.disabled = true;
}
