import {
  callApi,
  clearMatchDraft,
  getMatchDraft,
  initWorkflowShell,
  navigateTo,
  setMatchDraft,
  setSelectedMatchId,
  showError,
} from '/static/workflow-common.js';
import { createPayoutController } from '/static/payouts.js';

const matchForm = document.getElementById('match-form');
const matchFeed = document.getElementById('match-feed');
const addOverridePayoutBtn = document.getElementById('add-override-payout');
const overridePayouts = document.getElementById('override-payouts');
const overridePayoutTotal = document.getElementById('override-payout-total');
const enableOverrides = document.getElementById('enable-overrides');
const overrideZone = document.getElementById('override-zone');
const participantPicker = document.getElementById('participant-picker');
const participantCount = document.getElementById('participant-count');
const selectAllParticipantsBtn = document.getElementById('select-all-participants');

let authUser = { username: '', role: 'read' };
let suppressDraftSync = false;
let currentLeague = null;
let currentPlayers = [];

const payoutController = createPayoutController({
  container: overridePayouts,
  totalTarget: overridePayoutTotal,
  onChange: persistDraft,
});

function getSelectedParticipantIds() {
  return [...participantPicker.querySelectorAll('input[type="checkbox"]:checked')]
    .map((input) => Number(input.value))
    .filter((value) => Number.isFinite(value));
}

function syncParticipantSummary() {
  const selectedIds = getSelectedParticipantIds();
  const totalPlayers = currentPlayers.length;

  if (!totalPlayers) {
    participantCount.textContent = 'Add players first to build a match roster.';
    return;
  }

  const selectedNames = currentPlayers
    .filter((player) => selectedIds.includes(Number(player.id)))
    .map((player) => player.name);

  participantCount.textContent = selectedIds.length
    ? `${selectedIds.length} of ${totalPlayers} selected: ${selectedNames.join(', ')}`
    : 'Select at least two players for this match.';
}

function applyParticipantSelection(participantIds, options = {}) {
  const { persist = true } = options;
  const selected = new Set((participantIds || []).map((value) => Number(value)));

  [...participantPicker.querySelectorAll('input[type="checkbox"]')].forEach((input) => {
    input.checked = selected.has(Number(input.value));
    input.closest('.participant-pill')?.classList.toggle('active', input.checked);
  });

  syncParticipantSummary();
  if (persist && !suppressDraftSync) persistDraft();
}

function renderParticipantPicker() {
  participantPicker.innerHTML = '';

  if (!currentPlayers.length) {
    participantPicker.innerHTML = '<p class="muted">Add players first to select participants.</p>';
    syncParticipantSummary();
    return;
  }

  currentPlayers.forEach((player) => {
    const label = document.createElement('label');
    label.className = 'participant-pill active';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = String(player.id);
    input.checked = true;
    input.addEventListener('change', () => {
      label.classList.toggle('active', input.checked);
      syncParticipantSummary();
      persistDraft();
    });

    const name = document.createElement('span');
    name.textContent = player.name;

    label.appendChild(input);
    label.appendChild(name);
    participantPicker.appendChild(label);
  });

  const draft = getMatchDraft();
  if (draft?.participant_ids?.length) {
    applyParticipantSelection(draft.participant_ids, { persist: false });
  } else {
    applyParticipantSelection(currentPlayers.map((player) => Number(player.id)), { persist: false });
  }
}

function applyRoleBasedUI() {
  const isAdmin = authUser.league_role === 'admin';
  const controls = matchForm.querySelectorAll('input, button');
  controls.forEach((control) => {
    control.disabled = !isAdmin;
  });
}

function toggleOverrideSection(forceValue) {
  const enabled = typeof forceValue === 'boolean' ? forceValue : enableOverrides.checked;
  enableOverrides.checked = enabled;
  overrideZone.classList.toggle('hidden', !enabled);

  if (!enabled) {
    matchForm.elements.winner_count.value = '';
    payoutController.clear();
  }

  if (!suppressDraftSync) persistDraft();
}

function getDraftPayload() {
  return {
    match_date: String(matchForm.elements.match_date.value || ''),
    team1: String(matchForm.elements.team1.value || ''),
    team2: String(matchForm.elements.team2.value || ''),
    participant_ids: getSelectedParticipantIds(),
    enableOverrides: Boolean(enableOverrides.checked),
    winner_count: String(matchForm.elements.winner_count.value || ''),
    payouts: payoutController.collectRows(),
  };
}

function persistDraft() {
  if (suppressDraftSync) return;
  setMatchDraft(getDraftPayload());
}

function renderMatches(matches) {
  matchFeed.innerHTML = '';

  if (!matches.length) {
    matchFeed.innerHTML = '<div class="feed-item">No matches created yet.</div>';
    return;
  }

  matches.forEach((match) => {
    const count = match.winner_count || currentLeague?.default_winner_count || 0;
    const payoutMode = match.payouts && Object.keys(match.payouts).length ? 'Custom payout' : 'Default payout';
    const participantNames = Array.isArray(match.participant_ids)
      ? currentPlayers
          .filter((player) => match.participant_ids.includes(Number(player.id)))
          .map((player) => player.name)
      : [];

    const feedItem = document.createElement('div');
    feedItem.className = 'feed-item';
    feedItem.innerHTML = `
      <strong>${match.title}</strong><br>
      ${match.match_date} • Winners: ${count} • ${payoutMode} • Status: ${match.status}<br>
      <span class="muted">Participants (${participantNames.length || 0}): ${participantNames.join(', ') || 'Not captured'}</span>
    `;
    matchFeed.appendChild(feedItem);
  });
}

function renderDraft() {
  const draft = getMatchDraft();
  suppressDraftSync = true;

  if (draft) {
    matchForm.elements.match_date.value = draft.match_date || '';
    matchForm.elements.team1.value = draft.team1 || '';
    matchForm.elements.team2.value = draft.team2 || '';
    toggleOverrideSection(Boolean(draft.enableOverrides));
    matchForm.elements.winner_count.value = draft.winner_count || '';

    if (draft.enableOverrides) {
      if (draft.payouts && Object.keys(draft.payouts).length) {
        payoutController.setRows(draft.payouts);
      } else {
        payoutController.clear();
      }
    } else {
      payoutController.clear();
    }

    if (draft.participant_ids?.length) {
      applyParticipantSelection(draft.participant_ids, { persist: false });
    }
  } else {
    toggleOverrideSection(false);
    payoutController.clear();
    applyParticipantSelection(currentPlayers.map((player) => Number(player.id)), { persist: false });
  }

  payoutController.updateTotal();
  suppressDraftSync = false;
}

addOverridePayoutBtn.addEventListener('click', () => {
  payoutController.createRow('');
});

selectAllParticipantsBtn.addEventListener('click', () => {
  applyParticipantSelection(currentPlayers.map((player) => Number(player.id)));
});

enableOverrides.addEventListener('change', () => toggleOverrideSection(enableOverrides.checked));

['match_date', 'team1', 'team2', 'winner_count'].forEach((name) => {
  matchForm.elements[name].addEventListener('input', persistDraft);
});

matchForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (authUser.league_role !== 'admin') {
    showError('Only admin can add matches.');
    return;
  }

  try {
    const participantIds = getSelectedParticipantIds();
    if (participantIds.length < 2) {
      showError('Select at least two participants for this match.');
      return;
    }

    const formData = new FormData(matchForm);
    const team1 = String(formData.get('team1') || '').trim();
    const team2 = String(formData.get('team2') || '').trim();
    const payload = {
      title: `${team1} vs ${team2}`,
      match_date: String(formData.get('match_date') || ''),
      participant_ids: participantIds,
      winner_count: null,
      payouts: null,
    };

    if (enableOverrides.checked) {
      const winnerCount = Number(formData.get('winner_count'));
      const payouts = payoutController.collectRows();
      payload.payouts = Object.keys(payouts).length ? payouts : null;

      if (Number.isFinite(winnerCount) && winnerCount > 0) {
        payload.winner_count = winnerCount;
      } else if (payload.payouts) {
        payload.winner_count = Object.keys(payload.payouts).length;
      }
    }

    await callApi('/api/matches', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    clearMatchDraft();
    suppressDraftSync = true;
    matchForm.reset();
    toggleOverrideSection(false);
    applyParticipantSelection(currentPlayers.map((player) => Number(player.id)), { persist: false });
    suppressDraftSync = false;

    const state = await callApi('/api/state');
    currentLeague = state.league;
    currentPlayers = state.players;
    renderParticipantPicker();
    renderMatches(state.matches);
    if (state.matches.length) {
      setSelectedMatchId(state.matches[0].id);
    }
    navigateTo('/winners');
  } catch (error) {
    showError(error);
  }
});

async function init() {
  authUser = await initWorkflowShell('/matches');
  if (!authUser) return;
  applyRoleBasedUI();

  const state = await callApi('/api/state');
  currentLeague = state.league;
  currentPlayers = state.players;
  renderParticipantPicker();
  renderMatches(state.matches);
  renderDraft();
}

init().catch((error) => {
  console.error('Matches initialization failed:', error);
  showError(error);
});
