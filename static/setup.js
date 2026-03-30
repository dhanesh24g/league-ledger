import {
  callApi,
  clearSetupDraft,
  getSetupDraft,
  getActiveLeagueId,
  initWorkflowShell,
  navigateTo,
  setActiveLeagueId,
  setSetupDraft,
  showError,
} from '/static/workflow-common.js';
import { createPayoutController } from '/static/payouts.js';

const leagueForm = document.getElementById('league-form');
const leagueState = document.getElementById('league-state');
const defaultPayouts = document.getElementById('default-payouts');
const defaultPayoutTotal = document.getElementById('default-payout-total');
const addDefaultPayoutBtn = document.getElementById('add-default-payout');
const joinRequestsZone = document.getElementById('join-requests-zone');
const membersZone = document.getElementById('members-zone');

let suppressDraftSync = false;
let authUser = { username: '', role: 'read' };
const isCreateMode = new URLSearchParams(window.location.search).get('mode') === 'create';

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
                <select class="member-role-select" data-request-role="${request.request_id}">
                  <option value="read">Read</option>
                  <option value="admin">Admin</option>
                </select>
                <button type="button" class="ghost approve-request" data-request-id="${request.request_id}">Approve</button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;

    joinRequestsZone.querySelectorAll('.approve-request').forEach((button) => {
      button.addEventListener('click', async () => {
        try {
          button.disabled = true;
          const select = joinRequestsZone.querySelector(`[data-request-role="${button.dataset.requestId}"]`);
          await callApi(`/api/league/requests/${button.dataset.requestId}/approve`, {
            method: 'POST',
            body: JSON.stringify({ role: select?.value || 'read' }),
          });
          await renderJoinRequests();
          await renderMembers();
        } catch (error) {
          showError(error);
          button.disabled = false;
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
                <select class="member-role-select" data-member-role="${member.user_id}">
                  <option value="read" ${member.role === 'read' ? 'selected' : ''}>Read</option>
                  <option value="admin" ${member.role === 'admin' ? 'selected' : ''}>Admin</option>
                </select>
                <button type="button" class="ghost save-member-role" data-member-id="${member.user_id}">Save Role</button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;

    membersZone.querySelectorAll('.save-member-role').forEach((button) => {
      button.addEventListener('click', async () => {
        try {
          button.disabled = true;
          const select = membersZone.querySelector(`[data-member-role="${button.dataset.memberId}"]`);
          await callApi(`/api/league/members/${button.dataset.memberId}/role`, {
            method: 'PATCH',
            body: JSON.stringify({ role: select?.value || 'read' }),
          });
          await renderMembers();
        } catch (error) {
          showError(error);
          button.disabled = false;
        }
      });
    });
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

  try {
    const formData = new FormData(leagueForm);
    const payouts = payoutController.collectRows();
    const defaultWinnerCount = Object.keys(payouts).length;
    const entryFee = Number(formData.get('entry_fee'));
    const activePlayerCount = Number(formData.get('active_player_count'));

    if (!defaultWinnerCount) {
      throw new Error('Add at least one winner payout.');
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
    navigateTo('/players');
  } catch (error) {
    showError(error);
  }
});

async function init() {
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
