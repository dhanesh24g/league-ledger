import {
  buildWorkflowRoute,
  callApi,
  clearMatchDraft,
  getMatchDraft,
  initWorkflowShell,
  isDirectAdminFlow,
  navigateTo,
  queueToast,
  setButtonLoading,
  setMatchDraft,
  setSelectedMatchId,
  showError,
  showLoading,
} from '/static/workflow-common.js';
import { createPayoutController } from '/static/payouts.js';
import { initNotifications } from '/static/notifications.js';

const matchForm = document.getElementById('match-form');
const matchFeed = document.getElementById('match-feed');
const addOverridePayoutBtn = document.getElementById('add-override-payout');
const overridePayouts = document.getElementById('override-payouts');
const overridePayoutTotal = document.getElementById('override-payout-total');
const enableOverrides = document.getElementById('enable-overrides');
const overrideZone = document.getElementById('override-zone');
const participantPicker = document.getElementById('participant-picker');
const participantCount = document.getElementById('participant-count');
const participantBasket = document.getElementById('participant-basket');
const selectAllParticipantsBtn = document.getElementById('select-all-participants');
const matchesBackLink = document.getElementById('matches-back-link');
const matchesNextLink = document.getElementById('matches-next-link');
const pageBrand = document.getElementById('page-brand');
const matchEditModal = document.getElementById('match-edit-modal');
const matchEditForm = document.getElementById('match-edit-form');
const matchEditSaveBtn = document.getElementById('match-edit-save');
const matchEditDateInput = document.getElementById('edit_match_date');
const matchEditTeam1Input = document.getElementById('edit_team1');
const matchEditTeam2Input = document.getElementById('edit_team2');
const matchEditSubtitle = document.getElementById('match-edit-modal-subtitle');

let editingMatchId = null;

let authUser = { username: '', role: 'read' };
let suppressDraftSync = false;
let currentLeague = null;
let currentPlayers = [];

const payoutController = createPayoutController({
  container: overridePayouts,
  totalTarget: overridePayoutTotal,
  onChange: persistDraft,
});
const matchDateInput = matchForm?.elements.match_date;
const syncMatchDateProxy = setupMobileDateProxy(matchDateInput);

function formatMatchDateLabel(value) {
  if (!value) return 'Select match date';
  const [year, month, day] = String(value).split('-').map((part) => Number(part));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return value;
  const date = new Date(Date.UTC(year, month - 1, day));
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function setupMobileDateProxy(input) {
  if (!input) return () => { };

  const shell = document.createElement('div');
  shell.className = 'mobile-date-shell';
  input.classList.add('mobile-date-source');
  input.insertAdjacentElement('afterend', shell);
  shell.appendChild(input);

  const proxy = document.createElement('div');
  proxy.className = 'mobile-date-proxy';
  proxy.setAttribute('aria-hidden', 'true');
  proxy.innerHTML = `
    <span class="mobile-date-proxy-copy"></span>
    <span class="mobile-date-proxy-icon" aria-hidden="true">⌄</span>
  `;
  shell.appendChild(proxy);

  const copy = proxy.querySelector('.mobile-date-proxy-copy');
  const sync = () => {
    const hasValue = Boolean(input.value);
    if (copy) {
      copy.textContent = formatMatchDateLabel(input.value);
      copy.classList.toggle('is-placeholder', !hasValue);
    }
    proxy.classList.toggle('is-disabled', Boolean(input.disabled));
  };

  input.addEventListener('input', sync);
  input.addEventListener('change', sync);
  sync();
  return sync;
}

function getSelectedParticipantIds() {
  return [...participantPicker.querySelectorAll('input[type="checkbox"]:checked')]
    .map((input) => Number(input.value))
    .filter((value) => Number.isFinite(value));
}

function renderParticipantBasket(selectedIds, options = {}) {
  if (!participantBasket) return;

  const { animate = false } = options;
  participantBasket.innerHTML = '';

  if (!selectedIds.length) {
    participantBasket.classList.add('hidden');
    return;
  }

  const selectedNames = currentPlayers
    .filter((player) => selectedIds.includes(Number(player.id)))
    .map((player) => player.name);

  selectedNames.forEach((name, index) => {
    const chip = document.createElement('span');
    chip.className = 'participant-basket-chip';
    if (animate) {
      chip.classList.add('is-drop');
      chip.style.animationDelay = `${Math.min(index, 10) * 45}ms`;
    }
    chip.textContent = name;
    participantBasket.appendChild(chip);
  });

  participantBasket.classList.remove('hidden');
}

function normalizeTeamInputValue(input) {
  if (!input) return;
  const upper = String(input.value || '').toUpperCase();
  if (input.value !== upper) {
    input.value = upper;
  }
}

function syncParticipantSummary() {
  const selectedIds = getSelectedParticipantIds();
  const totalPlayers = currentPlayers.length;

  if (!totalPlayers) {
    participantCount.textContent = 'Add players first to build a match roster.';
    renderParticipantBasket([]);
    return;
  }

  participantCount.textContent = selectedIds.length
    ? `${selectedIds.length} of ${totalPlayers} selected.`
    : 'Select at least two players for this match.';

  renderParticipantBasket(selectedIds);
}

function applyEntryModeUI() {
  const directFlow = isDirectAdminFlow('/matches');
  document.body.classList.toggle('direct-admin-flow', directFlow);
  if (pageBrand) {
    pageBrand.classList.add('brand-home-link');
    pageBrand.setAttribute('aria-label', 'Go to home');
  }

  if (!matchesBackLink || !matchesNextLink) return;

  if (directFlow) {
    matchesBackLink.textContent = 'Back to Welcome';
    matchesBackLink.removeAttribute('data-workflow-link');
    matchesBackLink.href = '/welcome';

    matchesNextLink.textContent = 'Open Winner Assignment';
    matchesNextLink.removeAttribute('data-workflow-link');
    matchesNextLink.href = buildWorkflowRoute('/winners', { preserveDirectAdminFlow: true });
    return;
  }

  matchesBackLink.textContent = 'Back to Players';
  matchesBackLink.setAttribute('data-workflow-link', '');
  matchesBackLink.href = '/players';

  matchesNextLink.textContent = 'Continue to Winners';
  matchesNextLink.setAttribute('data-workflow-link', '');
  matchesNextLink.href = '/winners';
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
  syncMatchDateProxy();
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
    const participantPreview = participantNames.slice(0, 4).join(', ');
    const extraCount = Math.max(0, participantNames.length - 4);
    const statusTone = String(match.status || '').toLowerCase() === 'completed'
      ? 'status-good'
      : String(match.status || '').toLowerCase() === 'canceled'
        ? 'status-bad'
        : 'status-neutral';

    const feedItem = document.createElement('div');
    feedItem.className = 'feed-item workflow-feed-item';
    const isAdmin = authUser.league_role === 'admin';
    const editButtonHtml = isAdmin
      ? `<button type="button" class="ghost small match-edit-trigger" data-edit-match-id="${match.id}">Edit</button>`
      : '';
    feedItem.innerHTML = `
      <div class="workflow-feed-head">
        <strong>${match.title}</strong>
        <div class="workflow-chip-row">
          <span class="status-chip ${statusTone}">${match.status}</span>
          <span class="status-chip">${match.match_date}</span>
          <span class="status-chip">${participantNames.length || 0} players</span>
          ${editButtonHtml}
        </div>
      </div>
      <div class="workflow-feed-meta">
        <span>Winners: ${count}</span>
        <span>${payoutMode}</span>
      </div>
      <p class="muted small">Participants: ${participantPreview || 'Not captured'}${extraCount ? ` +${extraCount} more` : ''}</p>
    `;
    const editBtn = feedItem.querySelector('.match-edit-trigger');
    if (editBtn) {
      editBtn.addEventListener('click', () => openMatchEditModal(match));
    }
    matchFeed.appendChild(feedItem);
  });
}

function parseTitleTeams(title) {
  const parts = String(title || '').split(/\s+vs\s+/i);
  return {
    team1: (parts[0] || '').trim(),
    team2: (parts.slice(1).join(' vs ') || '').trim(),
  };
}

function openMatchEditModal(match) {
  if (!matchEditModal) return;
  editingMatchId = match.id;
  const { team1, team2 } = parseTitleTeams(match.title);
  matchEditDateInput.value = match.match_date || '';
  matchEditTeam1Input.value = team1;
  matchEditTeam2Input.value = team2;
  if (matchEditSubtitle) {
    matchEditSubtitle.textContent = `Editing: ${match.title} (${match.match_date})`;
  }
  matchEditModal.classList.remove('hidden');
  matchEditModal.setAttribute('aria-hidden', 'false');
}

function closeMatchEditModal() {
  if (!matchEditModal) return;
  editingMatchId = null;
  matchEditModal.classList.add('hidden');
  matchEditModal.setAttribute('aria-hidden', 'true');
}

async function refreshMatchesState() {
  const state = await callApi('/api/state');
  currentLeague = state.league;
  currentPlayers = state.players;
  renderParticipantPicker();
  renderMatches(state.matches);
}

async function handleMatchEditSave() {
  if (!editingMatchId) return;
  const matchId = editingMatchId;
  const team1 = String(matchEditTeam1Input.value || '').trim().toUpperCase();
  const team2 = String(matchEditTeam2Input.value || '').trim().toUpperCase();
  const matchDate = String(matchEditDateInput.value || '').trim();

  if (!team1 || !team2) {
    showError('Both team names are required.');
    return;
  }
  if (!matchDate) {
    showError('Match date is required.');
    return;
  }

  let closeLoading = null;
  let restore = null;
  try {
    restore = setButtonLoading(matchEditSaveBtn, 'Saving...');
    closeLoading = showLoading('Updating match...');
    await callApi(`/api/matches/${matchId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        title: `${team1} vs ${team2}`,
        match_date: matchDate,
      }),
    });
    queueToast('Match updated.');
    closeMatchEditModal();
    await refreshMatchesState();
  } catch (error) {
    showError(error);
  } finally {
    if (restore) restore();
    if (closeLoading) closeLoading();
  }
}

if (matchEditModal) {
  matchEditModal.querySelectorAll('[data-close-edit-modal]').forEach((el) => {
    el.addEventListener('click', closeMatchEditModal);
  });
  matchEditSaveBtn?.addEventListener('click', handleMatchEditSave);
  matchEditForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    handleMatchEditSave();
  });
  ['edit_team1', 'edit_team2'].forEach((id) => {
    const input = document.getElementById(id);
    input?.addEventListener('input', () => {
      const upper = input.value.toUpperCase();
      if (input.value !== upper) input.value = upper;
    });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !matchEditModal.classList.contains('hidden')) {
      closeMatchEditModal();
    }
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
  syncMatchDateProxy();
}

addOverridePayoutBtn.addEventListener('click', () => {
  payoutController.createRow('');
});

selectAllParticipantsBtn.addEventListener('click', () => {
  const allPlayerIds = currentPlayers.map((player) => Number(player.id));
  applyParticipantSelection(allPlayerIds);
  renderParticipantBasket(allPlayerIds, { animate: true });
});

enableOverrides.addEventListener('change', () => toggleOverrideSection(enableOverrides.checked));

['match_date', 'team1', 'team2', 'winner_count'].forEach((name) => {
  matchForm.elements[name].addEventListener('input', persistDraft);
});

matchDateInput?.addEventListener('change', () => {
  syncMatchDateProxy();
  persistDraft();
});

['team1', 'team2'].forEach((name) => {
  matchForm.elements[name].addEventListener('input', (event) => {
    normalizeTeamInputValue(event.currentTarget);
    persistDraft();
  });
});

matchForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (authUser.league_role !== 'admin') {
    showError('Only admin can add matches.');
    return;
  }

  let closeLoading = null;
  const submitBtn = matchForm.querySelector('button[type="submit"]');
  let restoreSubmitButton = null;
  try {
    restoreSubmitButton = setButtonLoading(submitBtn, 'Saving match...');
    closeLoading = showLoading('Saving match...');
    const participantIds = getSelectedParticipantIds();
    if (participantIds.length < 2) {
      showError('Select at least two participants for this match.');
      return;
    }

    const formData = new FormData(matchForm);
    const team1 = String(formData.get('team1') || '').trim().toUpperCase();
    const team2 = String(formData.get('team2') || '').trim().toUpperCase();
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
    syncMatchDateProxy();
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
    queueToast('Match saved successfully.');
    navigateTo('/winners');
  } catch (error) {
    showError(error);
  } finally {
    if (restoreSubmitButton) restoreSubmitButton();
    if (closeLoading) closeLoading();
  }
});

async function init() {
  initNotifications();
  matchFeed.innerHTML = '<div class="feed-item">Loading matches...</div>';
  authUser = await initWorkflowShell('/matches');
  if (!authUser) return;
  applyEntryModeUI();
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
