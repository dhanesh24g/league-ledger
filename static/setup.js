import {
  callApi,
  clearSetupDraft,
  getSetupDraft,
  getActiveLeagueId,
  initWorkflowShell,
  navigateTo,
  queueToast,
  setButtonLoading,
  setActiveLeagueId,
  setSetupDraft,
  showError,
  showLoading,
  showSuccess,
} from '/static/workflow-common.js';
import { createPayoutController } from '/static/payouts.js';
import { initNotifications } from '/static/notifications.js';

const leagueForm = document.getElementById('league-form');
const leagueState = document.getElementById('league-state');
const defaultPayouts = document.getElementById('default-payouts');
const defaultPayoutTotal = document.getElementById('default-payout-total');
const addDefaultPayoutBtn = document.getElementById('add-default-payout-bottom');
const inviteZone = document.getElementById('invite-zone');
const joinRequestsZone = document.getElementById('join-requests-zone');
const membersZone = document.getElementById('members-zone');

let suppressDraftSync = false;
let authUser = { username: '', role: 'read' };
const isCreateMode = new URLSearchParams(window.location.search).get('mode') === 'create';
let invitePanelExpanded = false;

function getPrizePool() {
  const fee = Number(leagueForm.elements.entry_fee.value);
  const players = Number(leagueForm.elements.active_player_count.value);
  if (!Number.isFinite(fee) || !Number.isFinite(players) || fee <= 0 || players <= 0) return 0;
  return fee * players;
}

const payoutController = createPayoutController({
  container: defaultPayouts,
  totalTarget: defaultPayoutTotal,
  getPrizePool,
  onChange: persistDraft,
});

function applyRoleBasedUI() {
  const isAdmin = isCreateMode || authUser.league_role === 'admin' || !authUser.league_exists;
  const controls = leagueForm.querySelectorAll('input, select, textarea, button');
  controls.forEach((control) => {
    control.disabled = !isAdmin;
  });
}

async function copyInviteLink(link, button) {
  try {
    await navigator.clipboard.writeText(link);
    const originalText = button.textContent;
    button.textContent = 'Copied';
    window.setTimeout(() => {
      button.textContent = originalText;
    }, 1400);
  } catch (error) {
    showError('Could not copy the invite link. Please copy it manually.');
  }
}

async function shareInviteLink(link, button) {
  if (!navigator.share) {
    await copyInviteLink(link, button);
    return;
  }

  try {
    await navigator.share({
      title: 'League Ledger Invite',
      text: 'Join my league on League Ledger.',
      url: link,
    });
  } catch (error) {
    if (error && error.name === 'AbortError') return;
    showError('Could not open the share sheet. Please copy the invite link instead.');
  }
}

function renderInviteCard(league) {
  if (!inviteZone) return;

  const isAdmin = authUser.league_role === 'admin' || isCreateMode || !authUser.league_exists;
  if (!league || !league.invite_link || !isAdmin) {
    inviteZone.classList.add('hidden');
    inviteZone.innerHTML = '';
    return;
  }

  const inviteLink = `${window.location.origin}${league.invite_link}`;
  inviteZone.classList.remove('hidden');
  inviteZone.innerHTML = `
    <div class="info-card invite-card">
      <div class="welcome-step-header invite-card-head">
        <div>
          <h3>Invite Members</h3>
          <p class="muted">Generate a shareable invite link so friends can request access to this league.</p>
        </div>
        <span class="welcome-meta-chip">Code: ${league.invite_code}</span>
      </div>
      <div class="invite-action-row">
        <button type="button" id="toggle-invite-link" class="primary invite-primary-action">
          ${invitePanelExpanded ? 'Invite Link Ready' : 'Generate Invite Link'}
        </button>
        ${invitePanelExpanded ? '<button type="button" id="share-invite-link" class="ghost">Share</button>' : ''}
      </div>
      <div class="invite-link-block ${invitePanelExpanded ? '' : 'hidden'}">
        <label class="invite-link-label">Shareable Invitation Link
          <input type="text" class="invite-link-input" value="${inviteLink}" readonly aria-label="League invite link">
        </label>
        <div class="invite-link-row">
          <button type="button" id="copy-invite-link" class="primary">Copy Link</button>
          <span class="muted small">Anyone with this link can request to join, but approval still stays with the league admin.</span>
        </div>
      </div>
    </div>
  `;

  inviteZone.querySelector('#toggle-invite-link')?.addEventListener('click', () => {
    invitePanelExpanded = true;
    renderInviteCard(league);
  });

  inviteZone.querySelector('#copy-invite-link')?.addEventListener('click', (event) => {
    copyInviteLink(inviteLink, event.currentTarget);
  });

  inviteZone.querySelector('#share-invite-link')?.addEventListener('click', (event) => {
    shareInviteLink(inviteLink, event.currentTarget);
  });
}

async function renderJoinRequests() {
  if (authUser.league_role !== 'admin') {
    joinRequestsZone.classList.add('hidden');
    joinRequestsZone.innerHTML = '';
    membersZone.classList.add('hidden');
    membersZone.innerHTML = '';
    return;
  }

  try {
    const result = await callApi('/api/league/requests');
    if (!result.requests.length) {
      joinRequestsZone.classList.add('hidden');
      joinRequestsZone.innerHTML = '';
      return;
    }

    joinRequestsZone.classList.remove('hidden');
    joinRequestsZone.innerHTML = `
      <div class="info-card">
        <h3>Pending Join Requests</h3>
        <div class="request-list">
          ${result.requests.map((request) => `
            <div class="request-row">
              <div>
                <strong>${request.first_name} ${request.last_name}</strong>
                <p class="muted">${request.user_id_label} • ${request.email}</p>
              </div>
              <div class="member-role-actions">
                <span class="status-chip">Will be approved as Read</span>
                <button type="button" class="ghost approve-request" data-request-id="${request.request_id}">Approve</button>
                <button type="button" class="ghost reject-request" data-request-id="${request.request_id}">Reject</button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;

    joinRequestsZone.querySelectorAll('.approve-request').forEach((button) => {
      button.addEventListener('click', async () => {
        let closeLoading = null;
        let restoreButton = null;
        try {
          restoreButton = setButtonLoading(button, 'Approving...');
          closeLoading = showLoading('Approving request...');
          await callApi(`/api/league/requests/${button.dataset.requestId}/approve`, {
            method: 'POST',
            body: JSON.stringify({ role: 'read' }),
          });

          // Show notification to admin
          if (window.notificationManager) {
            const request = result.requests.find(r => r.request_id === parseInt(button.dataset.requestId));
            if (request) {
              window.notificationManager.addNotification({
                title: 'Join Request Approved',
                message: `${request.first_name} ${request.last_name} has been approved and added to the league`,
                icon: '✅'
              });
            }
          }

          showSuccess('Join request approved successfully.');

          await renderJoinRequests();
          await renderMembers();
        } catch (error) {
          showError(error);
        } finally {
          if (restoreButton) restoreButton();
          if (closeLoading) closeLoading();
        }
      });
    });

    joinRequestsZone.querySelectorAll('.reject-request').forEach((button) => {
      button.addEventListener('click', async () => {
        const confirmed = window.confirm('Reject this join request?');
        if (!confirmed) return;

        let closeLoading = null;
        let restoreButton = null;
        try {
          restoreButton = setButtonLoading(button, 'Rejecting...');
          closeLoading = showLoading('Rejecting request...');
          await callApi(`/api/league/requests/${button.dataset.requestId}/reject`, {
            method: 'POST',
          });

          showSuccess('Join request rejected.');
          await renderJoinRequests();
        } catch (error) {
          showError(error);
        } finally {
          if (restoreButton) restoreButton();
          if (closeLoading) closeLoading();
        }
      });
    });
  } catch (error) {
    joinRequestsZone.classList.add('hidden');
    joinRequestsZone.innerHTML = '';
  }
}

async function renderMembers() {
  if (authUser.league_role !== 'admin') {
    membersZone.classList.add('hidden');
    membersZone.innerHTML = '';
    return;
  }

  try {
    const result = await callApi('/api/league/members');
    if (!result.members.length) {
      membersZone.classList.add('hidden');
      membersZone.innerHTML = '';
      return;
    }

    membersZone.classList.remove('hidden');
    membersZone.innerHTML = `
      <div class="info-card">
        <h3>League Members</h3>
        <div class="request-list">
          ${result.members.map((member) => `
            <div class="request-row">
              <div>
                <strong>${member.first_name} ${member.last_name}</strong>
                <p class="muted">${member.user_id_label} • ${member.email}</p>
              </div>
              <div class="member-role-actions">
                <span class="status-chip">Role: ${member.role === 'admin' ? 'Admin' : 'Read'}</span>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  } catch (error) {
    membersZone.classList.add('hidden');
    membersZone.innerHTML = '';
  }
}

function getDraftPayload() {
  return {
    sport: String(leagueForm.elements.sport.value || ''),
    name: String(leagueForm.elements.name.value || ''),
    tournament: String(leagueForm.elements.tournament.value || ''),
    entry_fee: String(leagueForm.elements.entry_fee.value || ''),
    active_player_count: String(leagueForm.elements.active_player_count.value || ''),
    payouts: payoutController.collectRows(),
  };
}

function persistDraft() {
  if (suppressDraftSync) return;
  setSetupDraft({
    dirty: true,
    ...getDraftPayload(),
  });
}

function setLeagueStateText(league) {
  if (!league) {
    leagueState.textContent = 'No league configured yet. Fill setup and save.';
    renderInviteCard(null);
    return;
  }

  const inviteLink = league.invite_link
    ? `${window.location.origin}${league.invite_link}`
    : '';
  const sportLabel = league.sport ? `${league.sport} | ` : '';
  leagueState.textContent = `${sportLabel}${league.name} | ${league.tournament} | Entry Fee: ${league.entry_fee} | Players: ${league.active_player_count || '-'} | Winners: ${league.default_winner_count}${inviteLink ? ` | Invite: ${inviteLink}` : ''}`;
}

function renderLeague(league) {
  const draft = getSetupDraft();
  const source = draft && draft.dirty ? draft : league;

  suppressDraftSync = true;

  leagueForm.elements.sport.value = source?.sport || 'Cricket';
  leagueForm.elements.name.value = source?.name || '';
  leagueForm.elements.tournament.value = source?.tournament || 'IPL';
  leagueForm.elements.entry_fee.value = source?.entry_fee || 100;
  leagueForm.elements.active_player_count.value = source?.active_player_count || 5;

  if (source?.payouts && Object.keys(source.payouts).length) {
    payoutController.setRows(source.payouts);
  } else {
    payoutController.setRows({ 1: getPrizePool() || '' });
  }

  payoutController.updateTotal();
  setLeagueStateText(league);
  renderInviteCard(league);
  suppressDraftSync = false;
}

addDefaultPayoutBtn.addEventListener('click', () => {
  payoutController.createRow('');
});

leagueForm.elements.entry_fee.addEventListener('input', () => {
  payoutController.updateTotal();
  persistDraft();
});

leagueForm.elements.active_player_count.addEventListener('input', () => {
  payoutController.updateTotal();
  persistDraft();
});

leagueForm.elements.name.addEventListener('input', persistDraft);
leagueForm.elements.sport.addEventListener('change', persistDraft);
leagueForm.elements.tournament.addEventListener('input', persistDraft);

leagueForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!isCreateMode && authUser.league_role !== 'admin' && authUser.league_exists) {
    showError('Only the league admin can update league settings.');
    return;
  }

  let closeLoading = null;
  const submitBtn = leagueForm.querySelector('button[type="submit"]');
  let restoreSubmitButton = null;
  try {
    restoreSubmitButton = setButtonLoading(submitBtn, 'Saving rules...');
    closeLoading = showLoading('Saving league settings...');
    const formData = new FormData(leagueForm);
    const payoutRows = [...defaultPayouts.querySelectorAll('.payout-row')];
    if (!payoutRows.length) {
      throw new Error('Add at least one winner payout.');
    }

    const payouts = {};
    payoutRows.forEach((row, index) => {
      const rank = index + 1;
      const amount = Number(row.querySelector('.payout-amount')?.value);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error(`Winner payout for W${rank} must be greater than 0.`);
      }
      payouts[rank] = Number(amount.toFixed(2));
    });

    const defaultWinnerCount = payoutRows.length;
    const entryFee = Number(formData.get('entry_fee'));
    const activePlayerCount = Number(formData.get('active_player_count'));

    if (defaultWinnerCount > activePlayerCount) {
      throw new Error('Winner count cannot exceed active league players.');
    }

    const payoutTotal = Object.values(payouts).reduce((sum, value) => sum + Number(value), 0);
    const prizePool = entryFee * activePlayerCount;
    if (Math.abs(payoutTotal - prizePool) >= 0.01) {
      throw new Error(`Winner payout total (${payoutTotal.toFixed(2)}) must match prize pool (${prizePool.toFixed(2)}).`);
    }

    const result = await callApi(`/api/league${isCreateMode ? '?create_new=true' : ''}`, {
      method: 'POST',
      body: JSON.stringify({
        league_id: isCreateMode ? null : Number(getActiveLeagueId() || 0) || null,
        sport: String(formData.get('sport') || 'Cricket'),
        name: String(formData.get('name') || ''),
        tournament: String(formData.get('tournament') || ''),
        entry_fee: entryFee,
        active_player_count: activePlayerCount,
        default_winner_count: defaultWinnerCount,
        payouts,
      }),
    });

    if (result.league_id) {
      setActiveLeagueId(result.league_id);
    }
    clearSetupDraft();
    queueToast('League settings saved successfully.');
    navigateTo('/players');
  } catch (error) {
    showError(error);
  } finally {
    if (restoreSubmitButton) restoreSubmitButton();
    if (closeLoading) closeLoading();
  }
});

async function init() {
  // Initialize notification system
  initNotifications();

  authUser = await initWorkflowShell('/setup');
  if (!authUser) return;
  applyRoleBasedUI();
  if (isCreateMode) {
    renderLeague(null);
    return;
  }
  const state = await callApi('/api/state');
  renderLeague(state.league);
  await renderJoinRequests();
  await renderMembers();
}

init().catch((error) => {
  console.error('Setup initialization failed:', error);
  showError(error);
});
