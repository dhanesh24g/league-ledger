const STORAGE_KEYS = {
  token: 'league-ledger-token',
  refreshToken: 'league-ledger-refresh-token',
  role: 'league-ledger-user-role',
  username: 'league-ledger-username',
  fullName: 'league-ledger-full-name',
  leagueId: 'league-ledger-active-league-id',
  theme: 'dhaneshlabs-theme',
  workflow: 'league-ledger-workflow',
  postAuthPath: 'league-ledger-post-auth-path',
};

const FLASH_TOAST_KEY = 'league-ledger-flash-toast';
let refreshInFlight = null;
let refreshTimerId = null;
let mobileSelectProxyResizeBound = false;
let mobileSelectProxyIdCounter = 0;

const MOBILE_SELECT_BREAKPOINT = '(max-width: 760px)';
const mobileSelectRegistry = new Set();

const PROACTIVE_REFRESH_BUFFER_MS = 2 * 60 * 1000;
const MIN_PROACTIVE_REFRESH_DELAY_MS = 15 * 1000;
const DIRECT_ADMIN_FLOW_PARAM = 'match-update';

function parseTokenPayload(token) {
  if (!token || typeof token !== 'string') return null;
  const [payloadPart] = token.split('.');
  if (!payloadPart) return null;
  try {
    const normalized = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
    const padLength = (4 - (normalized.length % 4)) % 4;
    const padded = normalized + '='.repeat(padLength);
    const decoded = atob(padded);
    return JSON.parse(decoded);
  } catch (_) {
    return null;
  }
}

function clearRefreshSchedule() {
  if (refreshTimerId !== null) {
    window.clearTimeout(refreshTimerId);
    refreshTimerId = null;
  }
}

function scheduleProactiveRefresh() {
  clearRefreshSchedule();

  const token = getToken();
  const payload = parseTokenPayload(token);
  const expSeconds = Number(payload?.exp || 0);
  if (!Number.isFinite(expSeconds) || expSeconds <= 0) return;

  const targetMs = (expSeconds * 1000) - PROACTIVE_REFRESH_BUFFER_MS;
  const delayMs = Math.max(MIN_PROACTIVE_REFRESH_DELAY_MS, targetMs - Date.now());

  refreshTimerId = window.setTimeout(async () => {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      scheduleProactiveRefresh();
    }
  }, delayMs);
}

const WORKFLOW_ROUTES = ['/setup', '/players', '/matches', '/winners', '/ledger', '/league-settings'];
const HEADER_NAV_DESTINATIONS = [
  { value: '/welcome', label: 'Home' },
  { value: '/stats', label: 'Stats Dashboard' },
  { value: '/league-details', label: 'League Details' },
];
const PAGE_LABEL_BY_ROUTE = {
  '/welcome': 'Home',
  '/stats': 'Stats Dashboard',
  '/league-details': 'League Details',
  '/setup': 'League Workflow',
  '/players': 'League Workflow',
  '/matches': 'League Workflow',
  '/winners': 'League Workflow',
  '/ledger': 'League Workflow',
  '/league-settings': 'League Settings',
};

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

export function isDirectAdminFlow(pathname = window.location.pathname) {
  if (!['/matches', '/winners'].includes(pathname)) return false;
  const params = new URLSearchParams(window.location.search);
  return params.get('flow') === DIRECT_ADMIN_FLOW_PARAM;
}

export function buildWorkflowRoute(target, options = {}) {
  const { preserveDirectAdminFlow = false } = options;
  const url = new URL(target, window.location.origin);
  if (preserveDirectAdminFlow && isDirectAdminFlow() && ['/matches', '/winners'].includes(url.pathname)) {
    url.searchParams.set('flow', DIRECT_ADMIN_FLOW_PARAM);
  }
  return `${url.pathname}${url.search}${url.hash}`;
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

export function getRefreshToken() {
  return localStorage.getItem(STORAGE_KEYS.refreshToken) || '';
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
  localStorage.removeItem(STORAGE_KEYS.refreshToken);
  localStorage.removeItem(STORAGE_KEYS.role);
  localStorage.removeItem(STORAGE_KEYS.username);
  localStorage.removeItem(STORAGE_KEYS.fullName);
  localStorage.removeItem(STORAGE_KEYS.leagueId);
  localStorage.removeItem(STORAGE_KEYS.postAuthPath);
  clearRefreshSchedule();
}

export function authHeaders() {
  const token = getToken();
  const leagueId = getActiveLeagueId();
  return token ? { Authorization: `Bearer ${token}`, ...(leagueId ? { 'X-League-ID': leagueId } : {}) } : {};
}

async function refreshAccessToken() {
  if (refreshInFlight) return refreshInFlight;
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;

  refreshInFlight = (async () => {
    const leagueId = getActiveLeagueId();
    const response = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(leagueId ? { 'X-League-ID': leagueId } : {}),
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!response.ok) return false;
    const data = await response.json().catch(() => ({}));
    if (!data?.token) return false;

    localStorage.setItem(STORAGE_KEYS.token, String(data.token));
    if (data.refresh_token) {
      localStorage.setItem(STORAGE_KEYS.refreshToken, String(data.refresh_token));
    }
    if (data.user?.league_role) {
      localStorage.setItem(STORAGE_KEYS.role, data.user.league_role === 'admin' ? 'admin' : 'read');
    }
    if (data.user?.user_id) {
      localStorage.setItem(STORAGE_KEYS.username, String(data.user.user_id));
    }
    if (data.user?.full_name || data.user?.user_id) {
      localStorage.setItem(STORAGE_KEYS.fullName, String(data.user.full_name || data.user.user_id));
    }
    if (data.user?.active_league_id) {
      localStorage.setItem(STORAGE_KEYS.leagueId, String(data.user.active_league_id));
    }
    scheduleProactiveRefresh();
    return true;
  })();

  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

export async function callApi(url, options = {}, retryOnAuthError = true) {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(options.headers || {}),
    },
    ...options,
  });

  if (response.status === 401) {
    if (retryOnAuthError && !String(url).includes('/api/auth/refresh')) {
      const refreshed = await refreshAccessToken();
      if (refreshed) {
        return callApi(url, options, false);
      }
    }
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

export function setButtonLoading(button, loadingText = 'Processing...') {
  if (!button) return () => { };

  const originalHtml = button.innerHTML;
  const hadDisabled = button.disabled;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.classList.add('is-loading');
  button.innerHTML = `<span class="button-spinner" aria-hidden="true"></span><span>${loadingText}</span>`;

  return () => {
    button.classList.remove('is-loading');
    button.removeAttribute('aria-busy');
    button.disabled = hadDisabled;
    button.innerHTML = originalHtml;
  };
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
    themeToggle.setAttribute('aria-label', 'Toggle theme');
    themeToggle.setAttribute('aria-pressed', String(theme === 'dark'));
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

function isMobileSelectViewport() {
  return Boolean(window.matchMedia && window.matchMedia(MOBILE_SELECT_BREAKPOINT).matches);
}

function ensureMobileSelectId(select) {
  if (select.id) return select.id;
  mobileSelectProxyIdCounter += 1;
  const name = select.getAttribute('name') || 'select';
  select.id = `mobile-select-${name.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()}-${mobileSelectProxyIdCounter}`;
  return select.id;
}

function ensureMobileSelectProxyShell(select, config = {}) {
  if (!select) return null;

  const selectId = ensureMobileSelectId(select);
  const variant = config.variant === 'full' ? 'full' : 'compact';

  let shell = select.closest(`.mobile-select-shell[data-select-id="${selectId}"]`);
  if (!shell) {
    shell = document.createElement('div');
    shell.className = 'mobile-select-shell';
    shell.dataset.selectId = selectId;
    select.insertAdjacentElement('afterend', shell);
    shell.appendChild(select);
  }

  shell.classList.toggle('mobile-select-shell-full', variant === 'full');
  shell.classList.toggle('mobile-select-shell-compact', variant !== 'full');

  let proxy = shell.querySelector(`.mobile-select-proxy[data-select-id="${selectId}"]`);
  if (!proxy) {
    proxy = document.createElement('button');
    proxy.type = 'button';
    proxy.className = 'mobile-select-proxy hidden';
    proxy.dataset.selectId = selectId;
    proxy.tabIndex = -1;
    proxy.setAttribute('aria-hidden', 'true');
    proxy.innerHTML = `
      <span class="mobile-select-proxy-copy"></span>
      <span class="mobile-select-proxy-icon" aria-hidden="true">⌄</span>
    `;
    shell.appendChild(proxy);
  }

  const syncProxyCopy = () => {
    const selectedOption = select.options[select.selectedIndex];
    const label = selectedOption?.textContent?.trim() || config.placeholder || 'Choose an option';
    const copy = proxy.querySelector('.mobile-select-proxy-copy');
    if (copy) copy.textContent = label;
    proxy.disabled = Boolean(select.disabled);
  };

  if (!select.dataset.mobileSelectProxyBound) {
    select.addEventListener('change', syncProxyCopy);
    select.dataset.mobileSelectProxyBound = 'true';
  }

  syncProxyCopy();
  return { shell, proxy };
}

export function syncMobileSelectProxy(select) {
  if (!select) return;
  const selectId = ensureMobileSelectId(select);
  const mobile = isMobileSelectViewport();
  const shell = select.closest(`.mobile-select-shell[data-select-id="${selectId}"]`);
  const proxy = shell?.querySelector(`.mobile-select-proxy[data-select-id="${selectId}"]`);
  select.classList.toggle('mobile-select-source', mobile);
  shell?.classList.toggle('mobile-select-shell-active', mobile);
  proxy?.classList.toggle('hidden', !mobile);
}

function syncAllMobileSelectProxies() {
  mobileSelectRegistry.forEach((select) => syncMobileSelectProxy(select));
}

function isDesktopHeaderNavViewport() {
  return Boolean(window.matchMedia && window.matchMedia('(min-width: 1025px)').matches);
}

function closeHeaderDropdowns(except = null) {
  document.querySelectorAll('.header-league-menu.is-open, .header-command-menu.is-open').forEach((menu) => {
    if (except && menu === except) return;
    menu.classList.remove('is-open');
    const trigger = menu.querySelector('.header-league-trigger, .header-command-trigger');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  });
}

document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element) || target.closest('.header-league-menu, .header-command-menu')) return;
  closeHeaderDropdowns();
});

export function registerMobileSelectProxy(select, config = {}) {
  if (!select) return null;
  const proxyParts = ensureMobileSelectProxyShell(select, config);
  mobileSelectRegistry.add(select);
  if (!mobileSelectProxyResizeBound) {
    mobileSelectProxyResizeBound = true;
    window.addEventListener('resize', syncAllMobileSelectProxies);
  }
  syncMobileSelectProxy(select);
  return proxyParts?.proxy || null;
}

export function enhanceHeaderNavSelect(select) {
  if (!select) return null;

  select.classList.add('header-select-source');
  const selectId = ensureMobileSelectId(select);
  let nav = document.querySelector(`.header-desktop-nav[data-select-id="${selectId}"]`);
  if (!nav) {
    nav = document.createElement('nav');
    nav.className = 'header-desktop-nav';
    nav.dataset.selectId = selectId;
    nav.setAttribute('aria-label', 'Primary navigation');
    const shell = select.closest(`.mobile-select-shell[data-select-id="${selectId}"]`) || select.parentElement;
    shell?.insertAdjacentElement('afterend', nav);
  }

  const currentValue = String(select.value || '');
  nav.innerHTML = [...select.options].map((option) => {
    const active = String(option.value) === currentValue;
    return `
      <button
        type="button"
        class="header-nav-pill${active ? ' is-active' : ''}"
        data-nav-value="${option.value}">
        ${option.textContent || ''}
      </button>
    `;
  }).join('');

  nav.querySelectorAll('[data-nav-value]').forEach((button) => {
    button.addEventListener('click', () => {
      const nextValue = button.getAttribute('data-nav-value') || '';
      if (!nextValue || nextValue === select.value) return;
      select.value = nextValue;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });

  return nav;
}

export function enhanceHeaderLeagueSwitcher(select) {
  if (!select) return null;

  select.classList.add('header-select-source');
  const selectId = ensureMobileSelectId(select);
  let menu = document.querySelector(`.header-league-menu[data-select-id="${selectId}"]`);
  if (!menu) {
    menu = document.createElement('div');
    menu.className = 'header-league-menu';
    menu.dataset.selectId = selectId;
    menu.innerHTML = `
      <button type="button" class="header-league-trigger" aria-haspopup="menu" aria-expanded="false">
        <span class="header-league-copy"></span>
        <span class="header-league-chevron" aria-hidden="true">⌄</span>
      </button>
      <div class="header-league-panel" role="menu"></div>
    `;
    const shell = select.closest(`.mobile-select-shell[data-select-id="${selectId}"]`) || select.parentElement;
    shell?.insertAdjacentElement('afterend', menu);
  }

  const trigger = menu.querySelector('.header-league-trigger');
  const copy = menu.querySelector('.header-league-copy');
  const panel = menu.querySelector('.header-league-panel');
  const selectedOption = select.options[select.selectedIndex];
  if (copy) {
    copy.textContent = selectedOption?.textContent?.trim() || 'Choose league';
  }
  if (panel) {
    panel.innerHTML = [...select.options].map((option) => {
      const active = String(option.value) === String(select.value);
      return `
        <button
          type="button"
          class="header-league-option${active ? ' is-active' : ''}"
          data-league-value="${option.value}"
          role="menuitemradio"
          aria-checked="${active ? 'true' : 'false'}">
          <span class="header-league-option-check" aria-hidden="true">${active ? '✓' : ''}</span>
          <span>${option.textContent || ''}</span>
        </button>
      `;
    }).join('');
  }

  if (trigger && !trigger.dataset.bound) {
    trigger.addEventListener('click', () => {
      if (!isDesktopHeaderNavViewport()) return;
      const willOpen = !menu.classList.contains('is-open');
      closeHeaderDropdowns(menu);
      menu.classList.toggle('is-open', willOpen);
      trigger.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    });
    trigger.dataset.bound = 'true';
  }

  panel?.querySelectorAll('[data-league-value]').forEach((button) => {
    button.addEventListener('click', () => {
      const nextValue = button.getAttribute('data-league-value') || '';
      if (!nextValue || nextValue === select.value) {
        closeHeaderDropdowns();
        return;
      }
      select.value = nextValue;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      closeHeaderDropdowns();
    });
  });

  return menu;
}

function ensureHeaderCommandMenu() {
  const host = document.querySelector('.header-actions') || document.querySelector('.header-center');
  if (!host) return null;

  let menu = host.querySelector('.header-command-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.className = 'header-command-menu';
    menu.innerHTML = `
      <button type="button" class="header-command-trigger" aria-haspopup="menu" aria-expanded="false">
        <span class="header-command-copy">
          <span class="header-command-copy-label">Navigate</span>
          <span class="header-command-copy-value"></span>
        </span>
        <span class="header-command-chevron" aria-hidden="true">⌄</span>
      </button>
      <div class="header-command-panel" role="menu">
        <div class="header-command-section header-command-section-pages is-open">
          <button type="button" class="header-command-section-toggle is-static" data-command-section="pages" aria-expanded="true">
            <span class="header-command-section-copy">
              <span class="header-command-section-label">Choose destination</span>
            </span>
          </button>
          <div class="header-command-options" data-command-options="pages"></div>
        </div>
        <div class="header-command-section header-command-section-leagues hidden">
          <button type="button" class="header-command-section-toggle" data-command-section="leagues" aria-expanded="false">
            <span class="header-command-section-copy">
              <span class="header-command-section-label">Choose league</span>
            </span>
            <span class="header-command-section-summary" data-command-summary="leagues"></span>
            <span class="header-command-section-chevron" aria-hidden="true">⌄</span>
          </button>
          <div class="header-command-options" data-command-options="leagues"></div>
        </div>
        <div class="header-command-section header-command-section-admin hidden">
          <button type="button" class="header-command-section-toggle" data-command-section="admin" aria-expanded="false">
            <span class="header-command-section-copy">
              <span class="header-command-section-label">Admin shortcuts</span>
            </span>
            <span class="header-command-section-summary" data-command-summary="admin"></span>
            <span class="header-command-section-chevron" aria-hidden="true">⌄</span>
          </button>
          <div class="header-command-options" data-command-options="admin"></div>
        </div>
        <div class="header-command-footer">
          <button type="button" class="header-command-option header-command-option-logout" data-command-kind="logout">
            <span class="header-command-option-copy">Log out</span>
            <span class="header-command-option-check" aria-hidden="true">↗</span>
          </button>
        </div>
      </div>
    `;
    const notificationWrapper = host.querySelector('.notification-wrapper');
    const logoutBtn = host.querySelector('#logout-btn');
    if (logoutBtn) {
      host.insertBefore(menu, logoutBtn);
    } else if (notificationWrapper?.nextSibling) {
      host.insertBefore(menu, notificationWrapper.nextSibling);
    } else {
      host.appendChild(menu);
    }
  }

  const trigger = menu.querySelector('.header-command-trigger');
  if (trigger && !trigger.dataset.bound) {
    trigger.addEventListener('click', () => {
      const willOpen = !menu.classList.contains('is-open');
      closeHeaderDropdowns(menu);
      menu.classList.toggle('is-open', willOpen);
      trigger.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    });
    trigger.dataset.bound = 'true';
  }

  menu.querySelectorAll('.header-command-section-toggle').forEach((button) => {
    if (button.dataset.bound) return;
    button.addEventListener('click', () => {
      if (button.classList.contains('is-static')) return;
      const section = button.closest('.header-command-section');
      if (!section) return;
      const willOpen = !section.classList.contains('is-open');
      section.classList.toggle('is-open', willOpen);
      button.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    });
    button.dataset.bound = 'true';
  });

  return menu;
}

function buildHeaderCommandOption(value, label, active = false, kind = 'page') {
  return `
    <button
      type="button"
      class="header-command-option${active ? ' is-active' : ''}"
      data-command-kind="${kind}"
      data-command-value="${value}">
      <span class="header-command-option-copy">${label}</span>
      <span class="header-command-option-check" aria-hidden="true">${active ? '✓' : ''}</span>
    </button>
  `;
}

export function refreshHeaderCommandMenu(user = null) {
  const topNav = document.getElementById('top-nav');
  const leagueSelect = document.getElementById('league-switcher');
  const headerContent = document.querySelector('.header-content');
  const menu = ensureHeaderCommandMenu();
  if (!headerContent || !menu || !topNav) return;

  headerContent.classList.add('header-content-command-nav');
  topNav.classList.add('header-select-source');
  if (leagueSelect) {
    leagueSelect.classList.add('header-select-source');
  }
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) logoutBtn.classList.add('hidden');

  const effectiveRole = String(
    user?.league_role
    || localStorage.getItem(STORAGE_KEYS.role)
    || ''
  ).toLowerCase();
  const isAdmin = effectiveRole === 'admin';
  const currentPath = window.location.pathname;
  const currentPage = PAGE_LABEL_BY_ROUTE[currentPath]
    || topNav.options[topNav.selectedIndex]?.textContent?.trim()
    || 'League Workflow';
  const value = menu.querySelector('.header-command-copy-value');
  if (value) {
    value.textContent = currentPage;
  }

  const pagesHost = menu.querySelector('[data-command-options="pages"]');
  if (pagesHost) {
    pagesHost.innerHTML = HEADER_NAV_DESTINATIONS
      .map((item) => buildHeaderCommandOption(item.value, item.label, item.value === currentPath, 'page'))
      .join('');

    pagesHost.querySelectorAll('[data-command-kind="page"]').forEach((button) => {
      button.addEventListener('click', () => {
        const nextValue = button.getAttribute('data-command-value') || '';
        if (!nextValue || nextValue === currentPath) {
          closeHeaderDropdowns();
          return;
        }
        navigateTo(nextValue);
        closeHeaderDropdowns();
      });
    });
  }
  const adminSection = menu.querySelector('.header-command-section-admin');
  const adminHost = menu.querySelector('[data-command-options="admin"]');
  const adminSummary = menu.querySelector('[data-command-summary="admin"]');
  if (adminSection && adminHost) {
    adminSection.classList.toggle('hidden', !isAdmin);
    if (!isAdmin) {
      adminSection.classList.remove('is-open');
      adminSection.querySelector('.header-command-section-toggle')?.setAttribute('aria-expanded', 'false');
      if (adminSummary) adminSummary.textContent = '';
    }
    if (isAdmin) {
      const shortcuts = [
        { value: '/setup', label: 'League Workflow' },
        { value: '/league-settings', label: 'League Settings' },
        { value: '/matches', label: 'Match Entry' },
        { value: '/winners', label: 'Winner Assignment' },
      ];
      if (adminSummary) adminSummary.textContent = `${shortcuts.length} tools`;
      adminHost.innerHTML = shortcuts
        .map((item) => buildHeaderCommandOption(item.value, item.label, item.value === currentPath, 'admin'))
        .join('');

      adminHost.querySelectorAll('[data-command-kind="admin"]').forEach((button) => {
        button.addEventListener('click', () => {
          const nextValue = button.getAttribute('data-command-value') || '';
          if (!nextValue || nextValue === window.location.pathname) {
            closeHeaderDropdowns();
            return;
          }
          navigateTo(nextValue);
        });
      });
    } else {
      adminHost.innerHTML = '';
    }
  }

  const leagueSection = menu.querySelector('.header-command-section-leagues');
  const leagueHost = menu.querySelector('[data-command-options="leagues"]');
  const leagueSummary = menu.querySelector('[data-command-summary="leagues"]');
  const leagues = leagueSelect ? [...leagueSelect.options] : [];
  if (leagueSection && leagueHost) {
    const showLeagues = leagues.length > 1;
    leagueSection.classList.toggle('hidden', !showLeagues);
    if (!showLeagues) {
      leagueSection.classList.remove('is-open');
      leagueSection.querySelector('.header-command-section-toggle')?.setAttribute('aria-expanded', 'false');
      if (leagueSummary) leagueSummary.textContent = '';
    }
    if (showLeagues) {
      if (leagueSummary) leagueSummary.textContent = `${leagues.length} leagues`;
      leagueHost.innerHTML = leagues
        .map((option) => buildHeaderCommandOption(option.value, option.textContent || '', String(option.value) === String(leagueSelect.value), 'league'))
        .join('');

      leagueHost.querySelectorAll('[data-command-kind="league"]').forEach((button) => {
        button.addEventListener('click', () => {
          const nextValue = button.getAttribute('data-command-value') || '';
          if (!nextValue || nextValue === leagueSelect.value) {
            closeHeaderDropdowns();
            return;
          }
          leagueSelect.value = nextValue;
          leagueSelect.dispatchEvent(new Event('change', { bubbles: true }));
          closeHeaderDropdowns();
        });
      });
    } else {
      leagueHost.innerHTML = '';
    }
  }

  const logoutAction = menu.querySelector('[data-command-kind="logout"]');
  if (logoutAction && !logoutAction.dataset.bound) {
    logoutAction.addEventListener('click', () => {
      clearAuthStorage();
      window.location.replace('/login');
    });
    logoutAction.dataset.bound = 'true';
  }
}

function initTopNav(currentPath) {
  const topNav = document.getElementById('top-nav');
  if (!topNav) return;
  document.querySelector('.header-content')?.classList.add('header-content-command-nav');

  if ([...topNav.options].some((option) => option.value === currentPath)) {
    topNav.value = currentPath;
  }

  topNav.addEventListener('change', () => {
    const target = topNav.value;
    navigateTo(target);
  });
  refreshHeaderCommandMenu();
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

export function ensureLeagueSwitcher(user) {
  const memberships = Array.isArray(user.memberships) ? user.memberships : [];
  const existing = document.getElementById('league-switcher');
  if (existing) existing.remove();
  const headerCenter = document.querySelector('.header-center');
  const headerContent = document.querySelector('.header-content');
  headerCenter?.classList.remove('has-league-switcher');
  headerContent?.classList.remove('header-content-has-league-switcher');
  if (memberships.length < 2) return;

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
    headerCenter ||
    document.querySelector('.header-actions') ||
    document.querySelector('.header-content');

  if (topNav && topNav.parentElement) {
    topNav.parentElement.insertBefore(select, topNav);
    topNav.parentElement.classList.add('has-league-switcher');
    headerContent?.classList.add('header-content-has-league-switcher');
  } else if (fallbackParent) {
    fallbackParent.insertBefore(select, fallbackParent.firstChild);
    fallbackParent.classList.add('has-league-switcher');
    headerContent?.classList.add('header-content-has-league-switcher');
  }

  refreshHeaderCommandMenu();
}

export function populateHeaderIdentity(user) {
  const authRole = document.getElementById('auth-role');
  if (!authRole) return;

  authRole.classList.add('auth-pill', 'auth-pill-identity');
  const username = String(user?.user_id || '').trim();
  const activeLeagueName = String(
    user?.active_league_name
    || user?.league?.name
    || ''
  ).trim();
  authRole.innerHTML = `
    <span class="auth-pill-line auth-pill-line-primary">${username}</span>
    <span class="auth-pill-line auth-pill-line-secondary">${activeLeagueName || 'Active league'}</span>
  `;
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

  scheduleProactiveRefresh();

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
  const directAdminFlow = isAdmin && isDirectAdminFlow(currentPath);
  document.body.classList.toggle('direct-admin-flow', directAdminFlow);
  const stepNav = document.querySelector('.step-nav');
  if (stepNav) {
    stepNav.classList.toggle('hidden', !isAdmin || directAdminFlow);
  }
  const canReadPlayers = currentPath === '/players';
  if (!isAdmin && !canCreateFirstLeague && !canReadPlayers) {
    window.location.replace('/welcome');
    return null;
  }

  populateHeaderIdentity(user);

  updateHeaderLeagueContext(user);
  ensureLeagueSwitcher(user);

  return user;
}

export function navigateTo(target) {
  if (WORKFLOW_ROUTES.includes(target)) setCurrentWorkflowPage(target);
  window.location.assign(buildWorkflowRoute(target, { preserveDirectAdminFlow: true }));
}

export function updateHeaderLeagueContext(user, explicitPageName = '') {
  const appName = document.querySelector('.brand-text .app-name');
  if (!appName) return;

  const basePageName = explicitPageName
    || appName.dataset.pageName
    || appName.textContent?.trim()
    || '';

  if (!appName.dataset.pageName && basePageName) {
    appName.dataset.pageName = basePageName;
  }

  const activeLeagueName = String(
    user?.active_league_name
    || user?.league?.name
    || ''
  ).trim();

  appName.textContent = activeLeagueName
    ? `${activeLeagueName} | ${basePageName}`
    : basePageName;
}
