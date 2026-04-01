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

const form = document.getElementById('forgot-password-form');
const result = document.getElementById('forgot-password-result');
const linkBox = document.getElementById('forgot-password-link');

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  result.textContent = '';
  linkBox.classList.add('hidden');
  linkBox.innerHTML = '';

  try {
    const formData = new FormData(form);
    const payload = {
      identifier: String(formData.get('identifier') || '').trim(),
    };
    const response = await callApi('/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    result.textContent = response.message || 'If the account exists, reset instructions have been generated.';

    if (response.reset_link) {
      const absoluteLink = `${window.location.origin}${response.reset_link}`;
      linkBox.classList.remove('hidden');
      linkBox.innerHTML = `
        <strong>Reset Link (Development)</strong>
        <code>${absoluteLink}</code>
        <a class="auth-inline-link" href="${response.reset_link}">Open reset page</a>
      `;
    }
  } catch (error) {
    result.textContent = error instanceof Error ? error.message : String(error);
  }
});

initThemeToggle();
