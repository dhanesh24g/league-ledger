import {
  callApi,
  clearAuthStorage,
  clearPostAuthPath,
  getCurrentWorkflowPage,
  getToken,
  initThemeToggle,
  setActiveLeagueId,
  setButtonLoading,
  showError,
  showLoading,
  showToast,
} from '/static/workflow-common.js';
import { initNotifications } from '/static/notifications.js';

const welcomeTitle = document.getElementById('welcome-title');
const welcomeCopy = document.getElementById('welcome-copy');
const welcomeActions = document.getElementById('welcome-actions');
const joinRequestsPanel = document.getElementById('join-requests-panel');
const requestHistoryPanel = document.getElementById('request-history-panel');
const authRole = document.getElementById('auth-role');
const logoutBtn = document.getElementById('logout-btn');
const joinModal = document.getElementById('join-modal');
const joinInviteInput = document.getElementById('join-invite-input');
const submitJoinModalBtn = document.getElementById('submit-join-modal');
const closeJoinModalBtn = document.getElementById('close-join-modal');
const cancelJoinModalBtn = document.getElementById('cancel-join-modal');
const routeChoiceModal = document.getElementById('route-choice-modal');
const routeChoiceCopy = document.getElementById('route-choice-copy');
const routeChoiceActions = document.getElementById('route-choice-actions');
const closeRouteChoiceBtn = document.getElementById('close-route-choice');
const LAST_LEAGUE_ROUTE_KEY = 'league-ledger-last-route-by-league';
const USER_CACHE_PREFIX = 'league-ledger-user-cache';

let previousFocus = null;
let joinModalBindingsReady = false;
let routeChoiceBindingsReady = false;

async function finalizeRequestAction(successMessage) {
  clearUserCache();
  if (window.notificationManager?.syncServerNotifications) {
    try {
      await window.notificationManager.syncServerNotifications();
    } catch (_) {
      // no-op
    }
  }
  if (successMessage) {
    showToast(successMessage, 'success');
  }
  window.setTimeout(() => {
    window.location.reload();
  }, 180);
}

function renderButtonLink(label, href, kind = 'primary') {
  return `<a class="button-link ${kind} auth-primary-button" href="${href}">${label}</a>`;
}

function getInviteCodeFromLocation() {
  const match = window.location.pathname.match(/^\/join\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : '';
}

function parseInviteInput(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw, window.location.origin);
    const match = url.pathname.match(/^\/join\/([^/]+)$/);
    if (match) return decodeURIComponent(match[1]);
  } catch (error) {
    return raw.replace(/^\/join\//, '').trim();
  }
  return raw.replace(/^\/join\//, '').trim();
}

function renderMembershipCards(user) {
  if (!Array.isArray(user.memberships) || !user.memberships.length) {
    return '';
  }
  return `
    <div class="info-card welcome-card">
      <h3>Your Leagues</h3>
      <div class="request-list">
        ${user.memberships
      .map(
        (membership) => `
            <button type="button" class="request-row welcome-membership-row" data-enter-league="${membership.league_id}">
              <div>
                <strong>${membership.league.name}</strong>
                <p class="muted">${membership.league.sport || 'Cricket'} • ${membership.league.tournament} • ${membership.role}</p>
              </div>
              <span class="welcome-choice-cta">Open League</span>
            </button>
          `
      )
      .join('')}
      </div>
    </div>
  `;
}

function bindMembershipCards(user) {
  document.querySelectorAll('[data-enter-league]').forEach((button) => {
    button.addEventListener('click', () => {
      const leagueId = button.getAttribute('data-enter-league');
      if (!leagueId) return;
      const membership = user.memberships.find((item) => String(item.league_id) === String(leagueId));
      if (!membership) return;
      openRouteChoiceModal(membership);
    });
  });
}

function closeRouteChoiceModal() {
  if (!routeChoiceModal) return;
  routeChoiceModal.classList.add('hidden');
  routeChoiceModal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
}

function readLastRouteMap() {
  try {
    const raw = localStorage.getItem(LAST_LEAGUE_ROUTE_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch (_) {
    return {};
  }
}

function getLastRouteForLeague(leagueId) {
  const map = readLastRouteMap();
  return map[String(leagueId)] || '';
}

function setLastRouteForLeague(leagueId, route) {
  try {
    const map = readLastRouteMap();
    map[String(leagueId)] = String(route || '');
    localStorage.setItem(LAST_LEAGUE_ROUTE_KEY, JSON.stringify(map));
  } catch (_) {
    // no-op
  }
}

function createRouteCard({
  title,
  description,
  route,
  variant = 'ghost',
  badge = '',
  recommended = false,
  leagueId,
}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `route-choice-card ${variant} ${recommended ? 'recommended' : ''}`.trim();
  button.innerHTML = `
    <span class="route-choice-title-row">
      <strong>${title}</strong>
      ${badge ? `<span class="route-choice-badge">${badge}</span>` : ''}
    </span>
    <span class="route-choice-description muted">${description}</span>
  `;
  button.addEventListener('click', () => {
    setActiveLeagueId(leagueId);
    setLastRouteForLeague(leagueId, route);
    closeRouteChoiceModal();
    window.location.href = route;
  });
  return button;
}

function openRouteChoiceModal(membership) {
  if (!routeChoiceModal || !routeChoiceActions || !routeChoiceCopy) return;

  const league = membership.league || {};
  routeChoiceCopy.textContent = `Choose destination for ${league.name || 'this league'} (${membership.role === 'admin' ? 'Admin' : 'Read'} access).`;

  routeChoiceActions.innerHTML = '';
  routeChoiceActions.classList.add('route-choice-grid');

  const leagueId = membership.league_id;
  const isAdmin = membership.role === 'admin';
  const allowedRoutes = isAdmin
    ? ['/stats', '/league-details', '/setup', '/matches', '/winners', '/league-settings']
    : ['/stats', '/league-details'];
  const lastRoute = getLastRouteForLeague(leagueId);

  if (allowedRoutes.includes(lastRoute)) {
    const lastLabel = lastRoute === '/setup'
      ? 'League Setup'
      : lastRoute === '/matches'
        ? 'Match Entry'
        : lastRoute === '/winners'
          ? 'Winner Assignment'
      : lastRoute === '/league-settings'
        ? 'League Settings'
        : lastRoute === '/league-details'
          ? 'League Details'
          : 'Stats Dashboard';

    routeChoiceActions.appendChild(
      createRouteCard({
        title: `Continue to ${lastLabel}`,
        description: 'Recommended based on your last destination for this league.',
        route: lastRoute,
        variant: 'primary',
        badge: 'Last Used',
        recommended: true,
        leagueId,
      })
    );
  }

  routeChoiceActions.appendChild(
    createRouteCard({
      title: 'Open Stats Dashboard',
      description: 'Performance analytics, leaderboard, match and player insights.',
      route: '/stats',
      variant: 'ghost',
      leagueId,
    })
  );

  routeChoiceActions.appendChild(
    createRouteCard({
      title: 'Open League Details',
      description: 'League rules, players, matches, winner amounts and payout settings.',
      route: '/league-details',
      variant: 'ghost',
      leagueId,
    })
  );

  if (isAdmin) {
    routeChoiceActions.appendChild(
      createRouteCard({
        title: 'Open Match Entry',
        description: 'Log today\'s fixture, roster, and match-level exception settings directly.',
        route: '/matches?flow=match-update',
        variant: 'ghost',
        leagueId,
      })
    );

    routeChoiceActions.appendChild(
      createRouteCard({
        title: 'Open Winner Assignment',
        description: 'Pick a saved match and assign payout ranks without reopening setup steps.',
        route: '/winners?flow=match-update',
        variant: 'ghost',
        leagueId,
      })
    );

    routeChoiceActions.appendChild(
      createRouteCard({
        title: 'Open League Setup',
        description: 'Manage league workflow: players, matches, winners and ledger.',
        route: '/setup',
        variant: 'ghost',
        leagueId,
      })
    );

    routeChoiceActions.appendChild(
      createRouteCard({
        title: 'Open League Settings',
        description: 'Governance controls, roles policy and admin-level management.',
        route: '/league-settings',
        variant: 'ghost',
        leagueId,
      })
    );
  }

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'ghost';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => closeRouteChoiceModal());
  routeChoiceActions.appendChild(cancelBtn);

  if (!routeChoiceBindingsReady) {
    routeChoiceBindingsReady = true;
    closeRouteChoiceBtn?.addEventListener('click', () => closeRouteChoiceModal());
    routeChoiceModal.querySelectorAll('[data-close-route-choice]').forEach((node) => {
      node.addEventListener('click', () => closeRouteChoiceModal());
    });
    routeChoiceModal.addEventListener('click', (event) => {
      if (event.target === routeChoiceModal) {
        closeRouteChoiceModal();
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !routeChoiceModal.classList.contains('hidden')) {
        closeRouteChoiceModal();
      }
    });
  }

  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  routeChoiceModal.classList.remove('hidden');
  routeChoiceModal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
}

async function renderJoinRequests(user) {
  if (user.league_role !== 'admin' || !user.active_league_id) {
    joinRequestsPanel.classList.add('hidden');
    joinRequestsPanel.innerHTML = '';
    return;
  }

  try {
    const result = await callApi('/api/league/requests');
    if (!result.requests.length) {
      joinRequestsPanel.classList.add('hidden');
      joinRequestsPanel.innerHTML = '';
      return;
    }

    joinRequestsPanel.classList.remove('hidden');
    joinRequestsPanel.innerHTML = `
      <div class="info-card">
        <h3>Pending Join Requests</h3>
        <div class="request-list">
          ${result.requests
        .map(
          (request) => `
            <div class="request-row">
              <div>
                <strong>${request.first_name} ${request.last_name}</strong>
                <p class="muted">${request.user_id_label} • ${request.email}</p>
              </div>
              <div class="member-role-actions">
                <span class="status-chip">Will be approved as Read</span>
                <button type="button" class="ghost approve-request" data-request-id="${request.request_id}" data-league-id="${request.league_id}">Approve</button>
                <button type="button" class="ghost reject-request" data-request-id="${request.request_id}" data-league-id="${request.league_id}">Reject</button>
              </div>
            </div>
          `
        )
        .join('')}
        </div>
      </div>
    `;

    joinRequestsPanel.querySelectorAll('.approve-request').forEach((button) => {
      button.addEventListener('click', async () => {
        let closeLoading = null;
        let restoreButton = null;
        try {
          restoreButton = setButtonLoading(button, 'Approving...');
          closeLoading = showLoading('Approving join request...');
          await callApi(`/api/league/requests/${button.dataset.requestId}/approve`, {
            method: 'POST',
            headers: button.dataset.leagueId ? { 'X-League-ID': button.dataset.leagueId } : undefined,
            body: JSON.stringify({ role: 'read' }),
          });
          await finalizeRequestAction('Join request approved.');
        } catch (error) {
          showError(error);
        } finally {
          if (restoreButton) restoreButton();
          if (closeLoading) closeLoading();
        }
      });
    });

    joinRequestsPanel.querySelectorAll('.reject-request').forEach((button) => {
      button.addEventListener('click', async () => {
        const confirmed = window.confirm('Reject this join request?');
        if (!confirmed) return;
        let closeLoading = null;
        let restoreButton = null;
        try {
          restoreButton = setButtonLoading(button, 'Rejecting...');
          closeLoading = showLoading('Rejecting join request...');
          await callApi(`/api/league/requests/${button.dataset.requestId}/reject`, {
            method: 'POST',
            headers: button.dataset.leagueId ? { 'X-League-ID': button.dataset.leagueId } : undefined,
          });
          await finalizeRequestAction('Join request rejected.');
        } catch (error) {
          showError(error);
        } finally {
          if (restoreButton) restoreButton();
          if (closeLoading) closeLoading();
        }
      });
    });
  } catch (error) {
    joinRequestsPanel.classList.add('hidden');
  }
}


function formatRequestStatus(status) {
  const normalized = String(status || 'pending').toLowerCase();
  if (normalized === 'approved') return 'Approved';
  if (normalized === 'rejected') return 'Rejected';
  if (normalized === 'canceled' || normalized === 'cancelled') return 'Canceled';
  return 'Pending';
}

function renderRequestHistory(user) {
  if (!requestHistoryPanel) return;
  const rows = Array.isArray(user.request_history) ? user.request_history : [];

  if (!rows.length) {
    requestHistoryPanel.classList.add('hidden');
    requestHistoryPanel.innerHTML = '';
    return;
  }

  requestHistoryPanel.classList.remove('hidden');
  requestHistoryPanel.innerHTML = `
    <div class="info-card">
      <h3>Your Request History</h3>
      <div class="request-list">
        ${rows.map((row) => {
    const status = String(row.status || 'pending').toLowerCase();
    const statusClass = status === 'approved' ? 'is-approved' : status === 'rejected' ? 'is-rejected' : status === 'canceled' || status === 'cancelled' ? 'is-canceled' : '';
    const reviewedLabel = row.reviewed_at ? `Reviewed: ${new Date(row.reviewed_at).toLocaleString()}` : 'Awaiting review';
    return `
            <div class="request-row">
              <div>
                <strong>${row.league?.name || 'League'}</strong>
                <p class="muted">${row.league?.sport || 'Cricket'} • ${row.league?.tournament || ''}</p>
                <p class="muted small">Requested: ${row.created_at ? new Date(row.created_at).toLocaleString() : '-'}</p>
                <p class="muted small">${reviewedLabel}</p>
              </div>
              <div class="member-role-actions">
                <span class="status-chip ${statusClass}">${formatRequestStatus(status)}</span>
                ${status === 'pending' ? `<button type="button" class="ghost cancel-request welcome-inline-action" data-request-id="${row.request_id}">Cancel request</button>` : ''}
              </div>
            </div>
          `;
  }).join('')}
      </div>
    </div>
  `;

  requestHistoryPanel.querySelectorAll('.cancel-request').forEach((button) => {
    button.addEventListener('click', async () => {
      const confirmed = window.confirm('Cancel this pending join request?');
      if (!confirmed) return;
      let closeLoading = null;
      let restoreButton = null;
      try {
        restoreButton = setButtonLoading(button, 'Cancelling...');
        closeLoading = showLoading('Cancelling request...');
        await callApi(`/api/league/requests/${button.dataset.requestId}/cancel`, {
          method: 'POST',
        });
        await finalizeRequestAction('Join request canceled.');
      } catch (error) {
        showError(error);
      } finally {
        if (restoreButton) restoreButton();
        if (closeLoading) closeLoading();
      }
    });
  });
}

async function renderInvitePreview(user, inviteCode) {
  const result = await callApi(`/api/leagues/invite/${encodeURIComponent(inviteCode)}`);
  const league = result.league;
  const membership = (user.memberships || []).find((item) => String(item.league_id) === String(league.id));
  const pending = (user.pending_requests || []).find((item) => String(item.league_id) === String(league.id));

  welcomeTitle.textContent = `Join ${league.name}`;
  welcomeCopy.textContent = 'This invite link opens a specific league. Review the details below, then request access when you are ready.';

  if (membership) {
    welcomeActions.innerHTML = `
      <div class="info-card welcome-card">
        <h3>Already Joined</h3>
        <p class="muted">You already belong to this league as ${membership.role}. Jump straight in.</p>
        <div class="welcome-meta-row">
          <span class="welcome-meta-chip">${league.sport || 'Cricket'}</span>
          <span class="welcome-meta-chip">${league.tournament}</span>
          <span class="welcome-meta-chip">Role: ${membership.role}</span>
        </div>
        <button id="enter-invite-league" type="button" class="primary auth-primary-button">Open League</button>
      </div>
    `;
    document.getElementById('enter-invite-league')?.addEventListener('click', () => {
      openRouteChoiceModal(membership);
    });
    return;
  }

  if (pending) {
    welcomeActions.innerHTML = `
      <div class="info-card welcome-card">
        <h3>Request Pending</h3>
        <p class="muted">Your request for ${league.name} is already waiting for admin approval.</p>
        <div class="welcome-meta-row">
          <span class="welcome-meta-chip">${league.sport || 'Cricket'}</span>
          <span class="welcome-meta-chip">${league.tournament}</span>
          <span class="welcome-meta-chip">Invite code: ${league.invite_code}</span>
        </div>
        <button id="pending-back-home" type="button" class="ghost welcome-inline-action">Back</button>
      </div>
    `;
    document.getElementById('pending-back-home')?.addEventListener('click', () => {
      window.history.replaceState({}, '', '/welcome');
      renderHome(user);
    });
    return;
  }

  welcomeActions.innerHTML = `
      <div class="info-card welcome-card">
        <h3>${league.name}</h3>
      <p class="muted">After approval, you will join this league with read access by default. Admins can later promote members inside the league if needed.</p>
      <div class="welcome-meta-row">
        <span class="welcome-meta-chip">${league.sport || 'Cricket'}</span>
        <span class="welcome-meta-chip">${league.tournament}</span>
        <span class="welcome-meta-chip">Invite code: ${league.invite_code}</span>
      </div>
      <button id="send-join-request" type="button" class="primary auth-primary-button">Send Join Request</button>
      <button id="back-to-home" type="button" class="ghost welcome-inline-action">Back</button>
    </div>
  `;

  document.getElementById('back-to-home')?.addEventListener('click', () => {
    window.history.replaceState({}, '', '/welcome');
    renderHome(user);
  });
  document.getElementById('send-join-request')?.addEventListener('click', async () => {
    let closeLoading = null;
    try {
      const button = document.getElementById('send-join-request');
      if (button) {
        button.disabled = true;
        button.textContent = 'Sending...';
      }
      closeLoading = showLoading('Sending join request...');
      await callApi('/api/auth/join-request', {
        method: 'POST',
        body: JSON.stringify({ invite_code: league.invite_code }),
      });
      await finalizeRequestAction('Join request sent.');
    } catch (error) {
      showError(error);
    } finally {
      if (closeLoading) closeLoading();
    }
  });
}

function closeJoinModal() {
  if (!joinModal) return;
  joinModal.classList.add('hidden');
  joinModal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
  if (previousFocus instanceof HTMLElement) {
    previousFocus.focus();
  }
}

function openJoinModal() {
  if (!joinModal) return;
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  joinModal.classList.remove('hidden');
  joinModal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
  window.setTimeout(() => {
    joinInviteInput?.focus();
    joinInviteInput?.select();
  }, 40);
}

function submitJoinModal(user) {
  const inviteCode = parseInviteInput(joinInviteInput?.value || '');
  if (!inviteCode) {
    window.alert('Paste a valid invite link or invite code.');
    joinInviteInput?.focus();
    return;
  }
  closeJoinModal();
  window.history.replaceState({}, '', `/join/${inviteCode}`);
  renderInvitePreview(user, inviteCode).catch((error) => {
    window.alert(error instanceof Error ? error.message : String(error));
  });
}

function bindJoinModal(user) {
  if (!joinModal) return;

  document.querySelectorAll('[data-open-join-modal]').forEach((button) => {
    button.addEventListener('click', () => openJoinModal());
  });

  if (joinModalBindingsReady) {
    return;
  }
  joinModalBindingsReady = true;

  closeJoinModalBtn?.addEventListener('click', () => closeJoinModal());
  cancelJoinModalBtn?.addEventListener('click', () => closeJoinModal());
  submitJoinModalBtn?.addEventListener('click', () => submitJoinModal(user));
  joinInviteInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitJoinModal(user);
    }
  });

  joinModal.querySelectorAll('[data-close-join-modal]').forEach((node) => {
    node.addEventListener('click', () => closeJoinModal());
  });

  joinModal.addEventListener('click', (event) => {
    if (event.target === joinModal) {
      closeJoinModal();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !joinModal.classList.contains('hidden')) {
      closeJoinModal();
    }
  });
}

function renderHome(user) {
  welcomeTitle.classList.remove('loading');
  welcomeTitle.textContent = `Welcome, ${user.first_name}.`;
  welcomeCopy.textContent = 'Create a fresh league, open an invite link, or jump into any league you already belong to.';
  welcomeActions.innerHTML = `
    <div class="welcome-choice-grid">
      <a class="welcome-choice-card" href="/setup?mode=create">
        <span class="welcome-choice-eyebrow create">Create</span>
        <strong>Create A New League</strong>
        <p class="muted">Start a new league, become its admin, and share the invite link with your friends.</p>
        <span class="welcome-choice-cta">Launch setup</span>
      </a>
      <button type="button" class="welcome-choice-card welcome-choice-join-card" data-open-join-modal>
        <span class="welcome-choice-eyebrow join">Join</span>
        <strong>Join With Invite Link</strong>
        <p class="muted">Use a league invite link or code. Requests stay tied to that specific league.</p>
        <span class="welcome-choice-cta">Click for invite access</span>
      </button>
    </div>
    ${renderMembershipCards(user)}
  `;

  bindMembershipCards(user);
  bindJoinModal(user);
}

async function refreshWelcomeView() {
  const profile = await callApi('/api/auth/me');
  const user = profile.user;

  cacheUser(user);
  document.body.classList.toggle('welcome-read-mode', user.league_role !== 'admin');
  localStorage.setItem('dhaneshlabs-login-role-hint', user.league_role === 'admin' ? 'admin' : 'read');
  authRole.textContent = `${user.user_id}`;

  const inviteCode = getInviteCodeFromLocation();
  if (inviteCode) {
    await renderInvitePreview(user, inviteCode);
  } else {
    if (user.active_league_id) {
      setActiveLeagueId(user.active_league_id);
    }
    renderHome(user);
  }

  await renderJoinRequests(user);
  renderRequestHistory(user);
}

async function init() {
  initThemeToggle();
  initNotifications();

  if (!getToken()) {
    window.location.replace('/login');
    return;
  }

  // Show modern loading state immediately
  renderLoadingState();

  // Try to get cached data for instant display
  const cachedUser = getCachedUser();
  if (cachedUser) {
    // Small delay to show loading state for better UX
    setTimeout(() => renderImmediateUI(cachedUser), 300);
  }

  try {
    const profile = await callApi('/api/auth/me');
    const user = profile.user;

    // Cache the user data for future visits
    cacheUser(user);

    // Update UI with fresh data
    updateUIWithUserData(user);

    document.body.classList.toggle('welcome-read-mode', user.league_role !== 'admin');
    localStorage.setItem('dhaneshlabs-login-role-hint', user.league_role === 'admin' ? 'admin' : 'read');
    authRole.textContent = `${user.user_id}`;
    clearPostAuthPath();

    logoutBtn.addEventListener('click', () => {
      clearAuthStorage();
      clearUserCache();
      window.location.replace('/login');
    });

    const inviteCode = getInviteCodeFromLocation();
    if (inviteCode) {
      await renderInvitePreview(user, inviteCode);
    } else {
      if (user.active_league_id) {
        setActiveLeagueId(user.active_league_id);
      }
      renderHome(user);
    }

    await renderJoinRequests(user);
    renderRequestHistory(user);
  } catch (error) {
    console.error('Failed to load user data:', error);
    // Show fallback UI with error indication
    setTimeout(() => {
      renderImmediateUI(null);
      welcomeCopy.innerHTML = `
        Create a fresh league, open an invite link, or jump into any league you already belong to.
        <div style="margin-top: 8px; color: var(--warning); font-size: 13px;">
          ⚠️ Some features may be unavailable due to connection issues
        </div>
      `;
    }, 500);
  }
}

function getCachedUser() {
  try {
    const cacheKey = `${USER_CACHE_PREFIX}:${(localStorage.getItem('league-ledger-username') || 'anonymous').trim().toLowerCase() || 'anonymous'}`;
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      const data = JSON.parse(cached);
      const now = Date.now();
      // Cache for 5 minutes
      if (now - data.timestamp < 300000) {
        return data.user;
      }
    }
  } catch (e) {
    // Ignore cache errors
  }
  return null;
}

function cacheUser(user) {
  try {
    const cacheKey = `${USER_CACHE_PREFIX}:${(localStorage.getItem('league-ledger-username') || 'anonymous').trim().toLowerCase() || 'anonymous'}`;
    localStorage.setItem(cacheKey, JSON.stringify({
      user,
      timestamp: Date.now()
    }));
  } catch (e) {
    // Ignore cache errors
  }
}

function clearUserCache() {
  try {
    const cacheKey = `${USER_CACHE_PREFIX}:${(localStorage.getItem('league-ledger-username') || 'anonymous').trim().toLowerCase() || 'anonymous'}`;
    localStorage.removeItem(cacheKey);
  } catch (e) {
    // Ignore cache errors
  }
}

function renderLoadingState() {
  // Show loading skeleton for user name with shimmer
  welcomeTitle.classList.add('loading');
  welcomeTitle.textContent = 'Loading your league access...';

  welcomeCopy.innerHTML = `
    <div class="status-loading">
      Setting up your league access
      <div class="loading-dots">
        <span></span>
        <span></span>
        <span></span>
      </div>
    </div>
  `;

  // Show skeleton cards for the choice options
  welcomeActions.innerHTML = `
    <div class="progress-bar">
      <div class="progress-bar-fill"></div>
    </div>
    <div class="welcome-loading-skeleton">
      <div class="skeleton-card"></div>
      <div class="skeleton-card"></div>
    </div>
  `;
}

function renderImmediateUI(user) {
  // Remove loading states
  welcomeTitle.classList.remove('loading');
  welcomeTitle.innerHTML = '';

  // Show welcome message immediately with fallback
  welcomeTitle.textContent = `Welcome, ${user?.first_name || 'back'}.`;
  welcomeCopy.textContent = 'Create a fresh league, open an invite link, or jump into any league you already belong to.';

  // Always show the choice cards immediately, even without user data
  if (!welcomeActions.innerHTML.includes('welcome-choice-grid')) {
    welcomeActions.innerHTML = `
      <div class="welcome-choice-grid">
        <a class="welcome-choice-card" href="/setup?mode=create">
          <span class="welcome-choice-eyebrow create">Create</span>
          <strong>Create A New League</strong>
          <p class="muted">Start a new league, become its admin, and share the invite link with your friends.</p>
          <span class="welcome-choice-cta">Launch setup</span>
        </a>
        <button type="button" class="welcome-choice-card welcome-choice-join-card" data-open-join-modal>
          <span class="welcome-choice-eyebrow join">Join</span>
          <strong>Join With Invite Link</strong>
          <p class="muted">Use a league invite link or code. Requests stay tied to that specific league.</p>
          <span class="welcome-choice-cta">Click for invite access</span>
        </button>
      </div>
    `;
  }

  // Show cached memberships if available
  if (user?.memberships && user.memberships.length > 0) {
    // Don't duplicate if already showing memberships
    if (!welcomeActions.innerHTML.includes('Your Leagues')) {
      welcomeActions.innerHTML += renderMembershipCards(user);
      bindMembershipCards(user);
    }
  }

  bindJoinModal(user);
}

function updateUIWithUserData(user) {
  // Update welcome message with fresh data
  welcomeTitle.classList.remove('loading');
  welcomeTitle.textContent = `Welcome, ${user.first_name}.`;

  // Update memberships if they changed
  const membershipSection = welcomeActions.querySelector('.welcome-card');
  if (membershipSection) {
    membershipSection.remove();
  }
  welcomeActions.innerHTML += renderMembershipCards(user);
  bindMembershipCards(user);
}

init().catch((error) => {
  console.error('Welcome initialization failed:', error);
  window.alert(error instanceof Error ? error.message : String(error));
});
