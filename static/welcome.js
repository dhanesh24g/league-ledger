import {
  callApi,
  clearAuthStorage,
  getCurrentWorkflowPage,
  getToken,
  initThemeToggle,
} from '/static/workflow-common.js';

const welcomeTitle = document.getElementById('welcome-title');
const welcomeCopy = document.getElementById('welcome-copy');
const welcomeActions = document.getElementById('welcome-actions');
const joinRequestsPanel = document.getElementById('join-requests-panel');
const authRole = document.getElementById('auth-role');
const logoutBtn = document.getElementById('logout-btn');

function renderButtonLink(label, href, kind = 'primary') {
  return `<a class="button-link ${kind} auth-primary-button" href="${href}">${label}</a>`;
}

function renderChoiceCard({ id, eyebrow, title, body, cta, tone = 'primary', disabled = false }) {
  const disabledAttr = disabled ? 'disabled aria-disabled="true"' : '';
  return `
    <button type="button" class="welcome-choice-card ${disabled ? 'is-disabled' : ''}" data-choice="${id}" ${disabledAttr}>
      <span class="welcome-choice-eyebrow ${tone}">${eyebrow}</span>
      <strong>${title}</strong>
      <p class="muted">${body}</p>
      <span class="welcome-choice-cta">${cta}</span>
    </button>
  `;
}

function bindChoiceHandlers(handlers) {
  Object.entries(handlers).forEach(([choice, handler]) => {
    document.querySelector(`[data-choice="${choice}"]`)?.addEventListener('click', handler);
  });
}

function renderPendingState(user) {
  welcomeTitle.textContent = `Your join request is pending, ${user.first_name}.`;
  welcomeCopy.textContent = `An admin needs to approve your access to ${user.league?.name || 'the league'}.`;
  welcomeActions.innerHTML = `
    <div class="info-card welcome-card">
      <h3>Request Sent</h3>
      <p class="muted">You will be able to enter the workflow and stats dashboard once the admin approves your request.</p>
      <div class="welcome-meta-row">
        <span class="welcome-meta-chip">Requested league: ${user.league?.name || 'League Ledger'}</span>
        <span class="welcome-meta-chip">Role after approval: Viewer</span>
      </div>
    </div>
  `;
}

function renderNoLeagueState(user) {
  welcomeTitle.textContent = `Hi ${user.first_name}, let's start your league.`;
  welcomeCopy.textContent = 'No league exists yet, so your next step is to create one. The creator becomes the league admin automatically.';
  welcomeActions.innerHTML = `
    <div class="info-card welcome-card">
      <h3>No league exists yet</h3>
      <p class="muted">Open setup, define the rules, and invite others after your league is ready.</p>
      <div class="welcome-meta-row">
        <span class="welcome-meta-chip">Role after creation: Admin</span>
      </div>
      ${renderButtonLink('Create The League', '/setup')}
    </div>
  `;
}

function renderDecisionState(user) {
  welcomeTitle.textContent = `Welcome, ${user.first_name}.`;
  welcomeCopy.textContent = 'Choose what you want to do next. We will only move you into the join or create flow after you make that decision.';
  welcomeActions.innerHTML = `
    <div class="welcome-choice-grid">
      ${renderChoiceCard({
        id: 'create',
        eyebrow: 'Create',
        title: 'Create A New League',
        body: user.league_exists
          ? `${user.league?.name || 'A league'} already exists in this workspace, so another league cannot be created here yet.`
          : 'Set up the league rules, become the admin, and start inviting players.',
        cta: user.league_exists ? 'Unavailable in current setup' : 'Become the admin',
        tone: 'create',
        disabled: Boolean(user.league_exists),
      })}
      ${renderChoiceCard({
        id: 'join',
        eyebrow: 'Join',
        title: 'Join Existing League',
        body: user.league?.name
          ? `Request access to ${user.league.name} and start participating once an admin approves you.`
          : 'Browse the available league and send an approval request to the admin.',
        cta: 'Request viewer access',
        tone: 'join',
      })}
    </div>
  `;

  bindChoiceHandlers({
    create: () => {
      if (!user.league_exists) {
        window.location.href = '/setup';
      }
    },
    join: () => renderJoinFlow(user),
  });
}

function renderJoinFlow(user) {
  welcomeTitle.textContent = `Join ${user.league?.name || 'the league'}`;
  welcomeCopy.textContent = 'Review the active league below and send a join request when you are ready. Your role will be assigned after approval.';
  welcomeActions.innerHTML = `
    <div class="info-card welcome-card">
      <div class="welcome-step-header">
        <span class="welcome-choice-eyebrow join">Join Flow</span>
        <button id="back-to-choice-btn" type="button" class="ghost welcome-inline-action">Back</button>
      </div>
      <h3>${user.league?.name || 'League Ready'}</h3>
      <p class="muted">This workspace currently supports one active league. Once approved, you will join as a viewer and get access to matches, stats, and ledger views.</p>
      <div class="welcome-meta-row">
        ${user.league?.tournament ? `<span class="welcome-meta-chip">Tournament: ${user.league.tournament}</span>` : ''}
        <span class="welcome-meta-chip">Role after approval: Viewer</span>
      </div>
      <button id="join-request-btn" type="button" class="primary auth-primary-button">Send Join Request</button>
    </div>
  `;

  document.getElementById('back-to-choice-btn')?.addEventListener('click', () => renderDecisionState(user));
  document.getElementById('join-request-btn')?.addEventListener('click', async () => {
    try {
      const button = document.getElementById('join-request-btn');
      if (button) {
        button.disabled = true;
        button.textContent = 'Sending...';
      }
      await callApi('/api/auth/join-request', { method: 'POST' });
      renderPendingState(user);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
      const button = document.getElementById('join-request-btn');
      if (button) {
        button.disabled = false;
        button.textContent = 'Send Join Request';
      }
    }
  });
}

async function renderJoinRequests() {
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
          ${result.requests.map((request) => `
            <div class="request-row">
              <div>
                <strong>${request.first_name} ${request.last_name}</strong>
                <p class="muted">${request.user_id_label} • ${request.email}</p>
              </div>
              <button type="button" class="ghost approve-request" data-request-id="${request.request_id}">Approve</button>
            </div>
          `).join('')}
        </div>
      </div>
    `;

    joinRequestsPanel.querySelectorAll('.approve-request').forEach((button) => {
      button.addEventListener('click', async () => {
        try {
          button.disabled = true;
          await callApi(`/api/league/requests/${button.dataset.requestId}/approve`, { method: 'POST' });
          await renderJoinRequests();
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

async function init() {
  initThemeToggle();

  if (!getToken()) {
    window.location.replace('/login');
    return;
  }

  const profile = await callApi('/api/auth/me');
  const user = profile.user;
  localStorage.setItem('league-ledger-user-role', user.league_role === 'admin' ? 'admin' : 'viewer');
  localStorage.setItem('league-ledger-username', user.user_id);
  localStorage.setItem('league-ledger-full-name', user.full_name || user.user_id);
  authRole.textContent = `${user.full_name} • ${user.user_id}`;

  logoutBtn.addEventListener('click', () => {
    clearAuthStorage();
    window.location.replace('/login');
  });

  if (user.membership_status === 'active') {
    const target = getCurrentWorkflowPage() || '/setup';
    window.location.replace(target);
    return;
  }

  if (!user.league_exists) {
    renderNoLeagueState(user);
    joinRequestsPanel.classList.add('hidden');
    return;
  }

  if (user.membership_status === 'pending') {
    renderPendingState(user);
    joinRequestsPanel.classList.add('hidden');
    return;
  }

  renderDecisionState(user);

  if (user.league_role === 'admin') {
    await renderJoinRequests();
  }
}

init().catch((error) => {
  console.error('Welcome initialization failed:', error);
  window.alert(error instanceof Error ? error.message : String(error));
});
