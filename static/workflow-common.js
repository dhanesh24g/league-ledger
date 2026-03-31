const STORAGE_KEYS = {
  token: 'league-ledger-token',
  role: 'league-ledger-user-role',
  username: 'league-ledger-username',
  fullName: 'league-ledger-full-name',
  leagueId: 'league-ledger-active-league-id',
  theme: 'dhaneshlabs-theme',
  workflow: 'league-ledger-workflow',
  postAuthPath: 'league-ledger-post-auth-path',
};

const FLASH_TOAST_KEY = 'league-ledger-flash-toast';

const WORKFLOW_ROUTES = ['/setup', '/players', '/matches', '/winners', '/ledger', '/league-settings'];

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
  const leagueKey = getActiveLeagueId() || 'global';
  const allStates = safeParse(localStorage.getItem(STORAGE_KEYS.workflow), {});
  return mergeWorkflowState(allStates[leagueKey] || DEFAULT_WORKFLOW_STATE);
}

export function writeWorkflowState(nextState) {
  const leagueKey = getActiveLeagueId() || 'global';
  const allStates = safeParse(localStorage.getItem(STORAGE_KEYS.workflow), {});
  allStates[leagueKey] = mergeWorkflowState(nextState);
  localStorage.setItem(STORAGE_KEYS.workflow, JSON.stringify(allStates));
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

function setAdminNavigationVisibility(isAdmin) {
  const headerCenter = document.querySelector('.header-center');
  if (headerCenter) {
    headerCenter.classList.toggle('hidden', !isAdmin);
  }

  const stepNav = document.querySelector('.step-nav');
  if (stepNav) {
    stepNav.classList.toggle('hidden', !isAdmin);
  }

  document.querySelectorAll('[data-workflow-link]').forEach((link) => {
    if (isAdmin) return;
    link.classList.add('hidden');
  });
}

export function getToken() {
  return localStorage.getItem(STORAGE_KEYS.token) || '';
}

export function getActiveLeagueId() {
  const value = localStorage.getItem(STORAGE_KEYS.leagueId);
  return value ? String(value) : '';
}

export function setActiveLeagueId(leagueId) {
  if (!leagueId) {
    localStorage.removeItem(STORAGE_KEYS.leagueId);
    return;
  }
  localStorage.setItem(STORAGE_KEYS.leagueId, String(leagueId));
}

export function getPostAuthPath() {
  return localStorage.getItem(STORAGE_KEYS.postAuthPath) || '';
}

export function setPostAuthPath(pathname) {
  if (!pathname) return;
  localStorage.setItem(STORAGE_KEYS.postAuthPath, pathname);
}

export function clearPostAuthPath() {
  localStorage.removeItem(STORAGE_KEYS.postAuthPath);
}

export function clearAuthStorage() {
  localStorage.removeItem(STORAGE_KEYS.token);
  localStorage.removeItem(STORAGE_KEYS.role);
  localStorage.removeItem(STORAGE_KEYS.username);
  localStorage.removeItem(STORAGE_KEYS.fullName);
  localStorage.removeItem(STORAGE_KEYS.leagueId);
  localStorage.removeItem(STORAGE_KEYS.postAuthPath);
}

export function authHeaders() {
  const token = getToken();
  const leagueId = getActiveLeagueId();
  return token ? { Authorization: `Bearer ${token}`, ...(leagueId ? { 'X-League-ID': leagueId } : {}) } : {};
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
  showToast(message, 'error');
}

function ensureToastHost() {
  let host = document.getElementById('app-toast-host');
  if (host) return host;

  host = document.createElement('div');
  host.id = 'app-toast-host';
  host.className = 'toast-host';
  document.body.appendChild(host);
  return host;
}

function dismissToast(toast) {
  if (!toast || !toast.parentElement) return;
  toast.classList.remove('toast-visible');
  window.setTimeout(() => {
    if (toast.parentElement) toast.remove();
  }, 180);
}

export function showToast(message, type = 'success', durationMs = 2800) {
  const host = ensureToastHost();
  const toast = document.createElement('div');
  const safeType = ['success', 'error', 'info'].includes(type) ? type : 'info';
  toast.className = `toast toast-${safeType}`;
  toast.textContent = String(message || '').trim() || 'Action completed';
  host.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add('toast-visible');
  });

  window.setTimeout(() => {
    dismissToast(toast);
  }, Math.max(1200, Number(durationMs) || 2800));
}

export function showLoading(message = 'Saving...') {
  const host = ensureToastHost();
  const toast = document.createElement('div');
  toast.className = 'toast toast-info toast-loading';

  const spinner = document.createElement('span');
  spinner.className = 'toast-spinner';
  spinner.setAttribute('aria-hidden', 'true');

  const label = document.createElement('span');
  label.className = 'toast-label';
  label.textContent = String(message || 'Saving...');

  toast.appendChild(spinner);
  toast.appendChild(label);
  host.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add('toast-visible');
  });

  return () => dismissToast(toast);
}

export function showSuccess(message, durationMs = 2400) {
  showToast(message, 'success', durationMs);
}

export function queueToast(message, type = 'success') {
  try {
    sessionStorage.setItem(
      FLASH_TOAST_KEY,
      JSON.stringify({ message: String(message || ''), type, ts: Date.now() })
    );
  } catch (_) {
    // no-op
  }
}

function flushQueuedToast() {
  try {
    const raw = sessionStorage.getItem(FLASH_TOAST_KEY);
    if (!raw) return;
    sessionStorage.removeItem(FLASH_TOAST_KEY);
    const data = JSON.parse(raw);
    if (!data?.message) return;
    showToast(data.message, data.type || 'success');
  } catch (_) {
    // no-op
  }
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
  const themeToggle = document.getElementById('theme-toggle');
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

  if (themeToggle) {
    themeToggle.setAttribute('aria-label', `Theme setting: ${theme === 'light' ? 'Light' : 'Dark'}`);
    themeToggle.dataset.theme = theme;
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

function ensureLeagueSwitcher(user) {
  const memberships = Array.isArray(user.memberships) ? user.memberships : [];
  const existing = document.getElementById('league-switcher');
  if (existing) existing.remove();
  if (!memberships.length) return;

  const select = document.createElement('select');
  select.id = 'league-switcher';
  select.setAttribute('aria-label', 'Switch league');
  memberships.forEach((membership) => {
    const option = document.createElement('option');
    option.value = String(membership.league_id);
    option.textContent = membership.league.name;
    if (String(membership.league_id) === String(user.active_league_id || '')) {
      option.selected = true;
    }
    select.appendChild(option);
  });

  select.addEventListener('change', () => {
    setActiveLeagueId(select.value);
    writeWorkflowState(readWorkflowState());
    window.location.reload();
  });

  const topNav = document.getElementById('top-nav');
  const fallbackParent =
    document.querySelector('.header-center') ||
    document.querySelector('.header-actions') ||
    document.querySelector('.header-content');

  if (topNav && topNav.parentElement) {
    topNav.parentElement.insertBefore(select, topNav);
  } else if (fallbackParent) {
    fallbackParent.insertBefore(select, fallbackParent.firstChild);
  }
}

export async function initWorkflowShell(currentPath) {
  setCurrentWorkflowPage(currentPath);
  initThemeToggle();
  initTopNav(currentPath);
  initStepNav(currentPath);
  initLogout();
  flushQueuedToast();

  if (!getToken()) {
    window.location.replace('/login');
    return null;
  }

  const profile = await callApi('/api/auth/me');
  const user = profile.user;
  if (user.active_league_id) {
    setActiveLeagueId(user.active_league_id);
  }
  const effectiveRole = user.league_role === 'admin' ? 'admin' : 'read';
  localStorage.setItem(STORAGE_KEYS.role, effectiveRole);
  localStorage.setItem(STORAGE_KEYS.username, user.user_id);
  localStorage.setItem(STORAGE_KEYS.fullName, user.full_name || user.user_id);

  const createMode = currentPath === '/setup' && new URLSearchParams(window.location.search).get('mode') === 'create';
  const canCreateFirstLeague = currentPath === '/setup' && createMode;
  if (user.membership_status !== 'active' && !canCreateFirstLeague) {
    window.location.replace('/welcome');
    return null;
  }

  const isAdmin = effectiveRole === 'admin';
  setAdminNavigationVisibility(isAdmin);
  const canReadPlayers = currentPath === '/players';
  if (!isAdmin && !canCreateFirstLeague && !canReadPlayers) {
    window.location.replace('/welcome');
    return null;
  }

  const authRole = document.getElementById('auth-role');
  if (authRole) {
    authRole.textContent = `${user.user_id}`;
  }

  // League switcher intentionally disabled in header UI.

  return user;
}

export function navigateTo(target) {
  if (WORKFLOW_ROUTES.includes(target)) setCurrentWorkflowPage(target);
  window.location.assign(target);
}
