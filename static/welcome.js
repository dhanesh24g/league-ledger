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
  return `<a class="button-link ${kind}" href="${href}">${label}</a>`;
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
    welcomeTitle.textContent = `Hi ${user.first_name}, you can create the first league.`;
    welcomeCopy.textContent = 'The first person to create the league becomes its admin and controls who can join.';
    welcomeActions.innerHTML = `
      <div class="info-card">
        <h3>No league exists yet</h3>
        <p class="muted">Open setup, define the rules, and that league will belong to you.</p>
        ${renderButtonLink('Create The League', '/setup')}
      </div>
    `;
    joinRequestsPanel.classList.add('hidden');
    return;
  }

  if (user.membership_status === 'pending') {
    welcomeTitle.textContent = `Your join request is pending, ${user.first_name}.`;
    welcomeCopy.textContent = `An admin needs to approve your access to ${user.league?.name || 'the league'}.`;
    welcomeActions.innerHTML = `
      <div class="info-card">
        <h3>Request Sent</h3>
        <p class="muted">You will be able to enter the workflow and stats dashboard once the admin approves your request.</p>
      </div>
    `;
    joinRequestsPanel.classList.add('hidden');
    return;
  }

  welcomeTitle.textContent = `Welcome, ${user.first_name}.`;
  welcomeCopy.textContent = `${user.league?.name || 'A league'} already exists. Send a join request and the admin can approve you.`;
  welcomeActions.innerHTML = `
    <div class="info-card">
      <h3>${user.league?.name || 'League Ready'}</h3>
      <p class="muted">Role after approval: viewer. You will be able to see stats and use the league workflow after joining.</p>
      <button id="join-request-btn" type="button">Send Join Request</button>
    </div>
  `;

  document.getElementById('join-request-btn')?.addEventListener('click', async () => {
    try {
      const button = document.getElementById('join-request-btn');
      if (button) {
        button.disabled = true;
        button.textContent = 'Sending...';
      }
      await callApi('/api/auth/join-request', { method: 'POST' });
      window.location.reload();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
      const button = document.getElementById('join-request-btn');
      if (button) {
        button.disabled = false;
        button.textContent = 'Send Join Request';
      }
    }
  });

  if (user.league_role === 'admin') {
    await renderJoinRequests();
  }
}

init().catch((error) => {
  console.error('Welcome initialization failed:', error);
  window.alert(error instanceof Error ? error.message : String(error));
});
