import {
  callApi,
  clearAuthStorage,
  clearPostAuthPath,
  getCurrentWorkflowPage,
  getToken,
  initThemeToggle,
  setActiveLeagueId,
} from '/static/workflow-common.js';

const welcomeTitle = document.getElementById('welcome-title');
const welcomeCopy = document.getElementById('welcome-copy');
const welcomeActions = document.getElementById('welcome-actions');
const joinRequestsPanel = document.getElementById('join-requests-panel');
const authRole = document.getElementById('auth-role');
const logoutBtn = document.getElementById('logout-btn');
const joinModal = document.getElementById('join-modal');
const joinInviteInput = document.getElementById('join-invite-input');
const submitJoinModalBtn = document.getElementById('submit-join-modal');
const closeJoinModalBtn = document.getElementById('close-join-modal');
const cancelJoinModalBtn = document.getElementById('cancel-join-modal');

let previousFocus = null;
let joinModalBindingsReady = false;

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

function getSelectedLeagueIdFromQuery() {
  const value = new URLSearchParams(window.location.search).get('league_id');
  if (!value) return '';
  return String(value);
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
      setActiveLeagueId(leagueId);
      const membership = user.memberships.find((item) => String(item.league_id) === String(leagueId));
      const target = membership?.role === 'admin' ? '/setup' : `/welcome?league_id=${encodeURIComponent(String(leagueId))}`;
      window.location.href = target;
    });
  });
}

function renderReadLeagueContext(user, membership) {
  const league = membership?.league;
  if (!league) {
    renderHome(user);
    return;
  }

  welcomeTitle.textContent = `${league.name} · Read Access`;
  welcomeCopy.textContent = 'Your access is intentionally limited to league overview on this home screen.';
  welcomeActions.innerHTML = `
    <div class="info-card welcome-card">
      <h3>League Context Selected</h3>
      <p class="muted">You are currently inside <strong>${league.name}</strong> with read-only access. Workflow and stats dashboards are restricted to admins.</p>
      <div class="welcome-meta-row">
        <span class="welcome-meta-chip">${league.sport || 'Cricket'}</span>
        <span class="welcome-meta-chip">${league.tournament || 'League'}</span>
        <span class="welcome-meta-chip">Role: Read</span>
      </div>
      <button id="back-to-leagues" type="button" class="ghost welcome-inline-action">Back To My Leagues</button>
    </div>
  `;

  document.getElementById('back-to-leagues')?.addEventListener('click', () => {
    window.history.replaceState({}, '', '/welcome');
    renderHome(user);
  });

  bindJoinModal(user);
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
                <button type="button" class="ghost approve-request" data-request-id="${request.request_id}">Approve</button>
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
        try {
          button.disabled = true;
          await callApi(`/api/league/requests/${button.dataset.requestId}/approve`, {
            method: 'POST',
            body: JSON.stringify({ role: 'read' }),
          });
          await renderJoinRequests(user);
        } catch (error) {
          window.alert(error instanceof Error ? error.message : String(error));
          button.disabled = false;
        }
      });
    });
  } catch (error) {
    joinRequestsPanel.classList.add('hidden');
  }
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
      setActiveLeagueId(league.id);
      window.location.href = membership.role === 'admin'
        ? '/setup'
        : `/welcome?league_id=${encodeURIComponent(String(league.id))}`;
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
      </div>
    `;
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
    try {
      const button = document.getElementById('send-join-request');
      if (button) {
        button.disabled = true;
        button.textContent = 'Sending...';
      }
      await callApi('/api/auth/join-request', {
        method: 'POST',
        body: JSON.stringify({ invite_code: league.invite_code }),
      });
      await renderInvitePreview(
        {
          ...user,
          pending_requests: [...(user.pending_requests || []), { league_id: league.id, league }],
        },
        league.invite_code
      );
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
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

async function init() {
  initThemeToggle();

  if (!getToken()) {
    window.location.replace('/login');
    return;
  }

  const profile = await callApi('/api/auth/me');
  const user = profile.user;
  authRole.textContent = `${user.user_id}`;
  clearPostAuthPath();

  logoutBtn.addEventListener('click', () => {
    clearAuthStorage();
    window.location.replace('/login');
  });

  const inviteCode = getInviteCodeFromLocation();
  const selectedLeagueId = getSelectedLeagueIdFromQuery();
  if (inviteCode) {
    await renderInvitePreview(user, inviteCode);
  } else if (selectedLeagueId) {
    const membership = (user.memberships || []).find((item) => String(item.league_id) === String(selectedLeagueId));
    if (membership?.league_id) {
      setActiveLeagueId(membership.league_id);
      if (membership.role === 'admin') {
        window.location.replace('/setup');
        return;
      }
      renderReadLeagueContext(user, membership);
    } else {
      renderHome(user);
    }
  } else {
    if (user.active_league_id) {
      setActiveLeagueId(user.active_league_id);
    }
    renderHome(user);
  }

  await renderJoinRequests(user);
}

init().catch((error) => {
  console.error('Welcome initialization failed:', error);
  window.alert(error instanceof Error ? error.message : String(error));
});
