const STORAGE_KEYS = {
  token: 'league-ledger-token',
  role: 'league-ledger-user-role',
  username: 'league-ledger-username',
  theme: 'dhaneshlabs-theme',
  workflow: 'league-ledger-workflow',
};

const WORKFLOW_ROUTES = ['/setup', '/players', '/matches', '/winners', '/ledger'];

const DEFAULT_WORKFLOW_STATE = {
  currentPage: '/setup',
  selectedMatchId: '',
  setupDraft: null,
  playerDraft: null,
  matchDraft: null,
  winnerDrafts: {},
};

function safeParse(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    return fallback;
  }
}

function mergeWorkflowState(value) {
  return {
    ...DEFAULT_WORKFLOW_STATE,
    ...(value || {}),
    winnerDrafts: {
      ...DEFAULT_WORKFLOW_STATE.winnerDrafts,
      ...((value && value.winnerDrafts) || {}),
    },
  };
}

export function readWorkflowState() {
  return mergeWorkflowState(safeParse(localStorage.getItem(STORAGE_KEYS.workflow), DEFAULT_WORKFLOW_STATE));
}

export function writeWorkflowState(nextState) {
  localStorage.setItem(STORAGE_KEYS.workflow, JSON.stringify(mergeWorkflowState(nextState)));
}

export function updateWorkflowState(updater) {
  const nextState = updater(readWorkflowState());
  writeWorkflowState(nextState);
  return readWorkflowState();
}

export function setCurrentWorkflowPage(pathname = window.location.pathname) {
  if (!WORKFLOW_ROUTES.includes(pathname)) return;
  updateWorkflowState((state) => ({ ...state, currentPage: pathname }));
}

export function getCurrentWorkflowPage() {
  return readWorkflowState().currentPage || '/setup';
}

export function getSelectedMatchId() {
  return readWorkflowState().selectedMatchId || '';
}

export function setSelectedMatchId(matchId) {
  updateWorkflowState((state) => ({
    ...state,
    selectedMatchId: matchId ? String(matchId) : '',
  }));
}

export function getSetupDraft() {
  return readWorkflowState().setupDraft;
}

export function setSetupDraft(draft) {
  updateWorkflowState((state) => ({ ...state, setupDraft: draft }));
}

export function clearSetupDraft() {
  updateWorkflowState((state) => ({ ...state, setupDraft: null }));
}

export function getPlayerDraft() {
  return readWorkflowState().playerDraft;
}

export function setPlayerDraft(draft) {
  updateWorkflowState((state) => ({ ...state, playerDraft: draft }));
}

export function clearPlayerDraft() {
  updateWorkflowState((state) => ({ ...state, playerDraft: null }));
}

export function getMatchDraft() {
  return readWorkflowState().matchDraft;
}

export function setMatchDraft(draft) {
  updateWorkflowState((state) => ({ ...state, matchDraft: draft }));
}

export function clearMatchDraft() {
  updateWorkflowState((state) => ({ ...state, matchDraft: null }));
}

export function getWinnerDraft(matchId) {
  if (!matchId) return null;
  return readWorkflowState().winnerDrafts[String(matchId)] || null;
}

export function setWinnerDraft(matchId, draft) {
  if (!matchId) return;
  updateWorkflowState((state) => ({
    ...state,
    winnerDrafts: {
      ...state.winnerDrafts,
      [String(matchId)]: draft,
    },
  }));
}

export function clearWinnerDraft(matchId) {
  if (!matchId) return;
  updateWorkflowState((state) => {
    const nextDrafts = { ...state.winnerDrafts };
    delete nextDrafts[String(matchId)];
    return {
      ...state,
      winnerDrafts: nextDrafts,
    };
  });
}

export function getToken() {
  return localStorage.getItem(STORAGE_KEYS.token) || '';
}

export function clearAuthStorage() {
  localStorage.removeItem(STORAGE_KEYS.token);
  localStorage.removeItem(STORAGE_KEYS.role);
  localStorage.removeItem(STORAGE_KEYS.username);
}

export function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function callApi(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(options.headers || {}),
    },
    ...options,
  });

  if (response.status === 401) {
    clearAuthStorage();
    window.location.replace('/login');
    throw new Error('Session expired. Please login again.');
  }

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.detail || 'Request failed');
  }

  return response.json();
}

export function showError(error) {
  const message = error instanceof Error ? error.message : String(error);
  window.alert(message);
}

export function getSavedTheme() {
  const stored = localStorage.getItem(STORAGE_KEYS.theme);
  if (stored === 'light' || stored === 'dark') return stored;
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
    return 'light';
  }
  return 'dark';
}

function updateThemeIcons(theme) {
  const lightIcon = document.getElementById('light-icon');
  const darkIcon = document.getElementById('dark-icon');
  if (!lightIcon || !darkIcon) return;

  if (theme === 'light') {
    lightIcon.classList.add('active');
    darkIcon.classList.remove('active');
  } else {
    darkIcon.classList.add('active');
    lightIcon.classList.remove('active');
  }
}

export function initThemeToggle() {
  const themeToggle = document.getElementById('theme-toggle');
  if (!themeToggle) return;

  const savedTheme = getSavedTheme();
  document.documentElement.setAttribute('data-theme', savedTheme);
  updateThemeIcons(savedTheme);

  themeToggle.addEventListener('click', () => {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const nextTheme = currentTheme === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', nextTheme);
    localStorage.setItem(STORAGE_KEYS.theme, nextTheme);
    updateThemeIcons(nextTheme);
  });
}

function initTopNav(currentPath) {
  const topNav = document.getElementById('top-nav');
  if (!topNav) return;

  if ([...topNav.options].some((option) => option.value === currentPath)) {
    topNav.value = currentPath;
  }

  topNav.addEventListener('change', () => {
    const target = topNav.value;
    if (WORKFLOW_ROUTES.includes(target)) setCurrentWorkflowPage(target);
    window.location.href = target;
  });
}

function initStepNav(currentPath) {
  const stepPills = [...document.querySelectorAll('.step-pill')];
  stepPills.forEach((pill) => {
    const target = pill.getAttribute('href') || pill.dataset.route || '';
    pill.classList.toggle('active', target === currentPath);
    pill.addEventListener('click', () => {
      if (WORKFLOW_ROUTES.includes(target)) setCurrentWorkflowPage(target);
    });
  });

  const workflowLinks = [...document.querySelectorAll('[data-workflow-link]')];
  workflowLinks.forEach((link) => {
    const target = link.getAttribute('href') || '';
    link.addEventListener('click', () => {
      if (WORKFLOW_ROUTES.includes(target)) setCurrentWorkflowPage(target);
    });
  });
}

function initLogout() {
  const logoutBtn = document.getElementById('logout-btn');
  if (!logoutBtn) return;
  logoutBtn.addEventListener('click', () => {
    clearAuthStorage();
    window.location.replace('/login');
  });
}

export async function initWorkflowShell(currentPath) {
  setCurrentWorkflowPage(currentPath);
  initThemeToggle();
  initTopNav(currentPath);
  initStepNav(currentPath);
  initLogout();

  if (!getToken()) {
    window.location.replace('/login');
    return null;
  }

  const profile = await callApi('/api/auth/me');
  const user = profile.user;
  localStorage.setItem(STORAGE_KEYS.role, user.role);
  localStorage.setItem(STORAGE_KEYS.username, user.username);

  const authRole = document.getElementById('auth-role');
  if (authRole) {
    authRole.textContent = `${user.username} (${user.role})`;
  }

  return user;
}

export function navigateTo(target) {
  if (WORKFLOW_ROUTES.includes(target)) setCurrentWorkflowPage(target);
  window.location.assign(target);
}
