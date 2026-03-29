import {
  callApi,
  clearWinnerDraft,
  getSelectedMatchId,
  getWinnerDraft,
  initWorkflowShell,
  navigateTo,
  setCurrentWorkflowPage,
  setSelectedMatchId,
  setWinnerDraft,
  showError,
} from '/static/workflow-common.js';
import { rankIcon } from '/static/payouts.js';

const matchSelect = document.getElementById('match-select');
const loadWinnerBtn = document.getElementById('load-winner-form');
const cancelMatchBtn = document.getElementById('mark-cancelled');
const continueLedgerBtn = document.getElementById('continue-ledger');
const winnersForm = document.getElementById('winners-form');

let authUser = { username: '', role: 'viewer' };
let appState = { league: null, players: [], matches: [] };
let winnerFeedbackEl = null;
let saveWinnersBtn = null;
let activeParticipantIds = [];

function setWinnerFeedback(kind, message) {
  const feedback = ensureWinnerFeedback();
  feedback.classList.remove('hidden', 'winner-feedback-error', 'winner-feedback-success');
  feedback.classList.add(kind === 'success' ? 'winner-feedback-success' : 'winner-feedback-error');
  feedback.innerHTML = message;
}

function clearWinnerFeedback() {
  const feedback = ensureWinnerFeedback();
  feedback.classList.add('hidden');
  feedback.classList.remove('winner-feedback-error', 'winner-feedback-success');
  feedback.textContent = '';
}

function applyRoleBasedUI() {
  const isAdmin = authUser.role === 'admin';
  [loadWinnerBtn, cancelMatchBtn, continueLedgerBtn].forEach((element) => {
    element.disabled = !isAdmin;
  });

  if (!isAdmin) {
    winnersForm.innerHTML = '<p class="muted">Viewer mode: winners can only be updated by admin.</p>';
  }
}

function ensureWinnerFeedback() {
  if (winnerFeedbackEl) return winnerFeedbackEl;
  winnerFeedbackEl = document.createElement('p');
  winnerFeedbackEl.className = 'winner-feedback hidden';
  winnersForm.before(winnerFeedbackEl);
  return winnerFeedbackEl;
}

function renderMatchSelect() {
  matchSelect.innerHTML = '';

  if (!appState.matches.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No matches yet';
    matchSelect.appendChild(option);
    return;
  }

  appState.matches.forEach((match) => {
    const option = document.createElement('option');
    option.value = String(match.id);
    option.textContent = `${match.match_date} - ${match.title} (${(match.participant_ids || []).length || appState.players.length} players)`;
    matchSelect.appendChild(option);
  });

  const storedMatchId = getSelectedMatchId();
  const selectedMatch = appState.matches.find((match) => String(match.id) === String(storedMatchId));
  const activeMatchId = selectedMatch ? String(selectedMatch.id) : String(appState.matches[0].id);
  matchSelect.value = activeMatchId;
  setSelectedMatchId(activeMatchId);
}

function getWinnerCount(match) {
  if (match?.winner_count) return Number(match.winner_count);
  return Number(appState.league?.default_winner_count || 0);
}

function getPlayerSuggestions(query) {
  const raw = query.trim().toLowerCase();
  const eligiblePlayers = activeParticipantIds.length
    ? appState.players.filter((player) => activeParticipantIds.includes(Number(player.id)))
    : appState.players;
  if (!raw) return eligiblePlayers.slice(0, 8);
  return eligiblePlayers
    .filter((player) => player.name.toLowerCase().includes(raw))
    .slice(0, 8);
}

function renderSuggestions(menu, suggestions, activeIndex) {
  menu.innerHTML = '';

  if (!suggestions.length) {
    menu.classList.add('hidden');
    return;
  }

  suggestions.forEach((player, index) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'suggestion-item';
    if (index === activeIndex) option.classList.add('active');
    option.textContent = player.name;
    option.dataset.player = player.name;
    menu.appendChild(option);
  });

  menu.classList.remove('hidden');
}

function persistWinnerDraft(matchId) {
  if (!matchId) return;
  const ranks = {};
  const rankCards = [...winnersForm.querySelectorAll('.rank-card')];
  rankCards.forEach((card) => {
    const rank = String(card.dataset.rank);
    ranks[rank] = [...card.querySelectorAll('input[type="text"]')].map((input) => input.value);
  });
  setWinnerDraft(matchId, { ranks });
}

function createWinnerInputRow(rowsContainer, onUpdate, initialName = '') {
  const row = document.createElement('div');
  row.className = 'rank-select-row';

  const combo = document.createElement('div');
  combo.className = 'autocomplete';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Type player name';
  input.value = initialName;

  const menu = document.createElement('div');
  menu.className = 'suggestions hidden';

  let activeIndex = -1;
  let suggestions = [];

  const refreshSuggestions = () => {
    suggestions = getPlayerSuggestions(input.value);
    if (activeIndex >= suggestions.length) activeIndex = -1;
    renderSuggestions(menu, suggestions, activeIndex);
  };

  input.addEventListener('focus', refreshSuggestions);
  input.addEventListener('input', () => {
    activeIndex = -1;
    refreshSuggestions();
    onUpdate();
  });

  input.addEventListener('keydown', (event) => {
    if (menu.classList.contains('hidden') && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      refreshSuggestions();
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!suggestions.length) return;
      activeIndex = (activeIndex + 1) % suggestions.length;
      renderSuggestions(menu, suggestions, activeIndex);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!suggestions.length) return;
      activeIndex = (activeIndex - 1 + suggestions.length) % suggestions.length;
      renderSuggestions(menu, suggestions, activeIndex);
      return;
    }

    if (event.key === 'Escape') {
      menu.classList.add('hidden');
      return;
    }

    if (event.key === 'Enter' && !menu.classList.contains('hidden') && activeIndex >= 0) {
      event.preventDefault();
      input.value = suggestions[activeIndex].name;
      menu.classList.add('hidden');
      onUpdate();
    }
  });

  input.addEventListener('blur', () => {
    window.setTimeout(() => {
      menu.classList.add('hidden');
    }, 120);
  });

  menu.addEventListener('mousedown', (event) => {
    const item = event.target.closest('.suggestion-item');
    if (!item) return;
    event.preventDefault();
    input.value = item.dataset.player || '';
    menu.classList.add('hidden');
    onUpdate();
  });

  combo.appendChild(input);
  combo.appendChild(menu);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'remove';
  removeBtn.textContent = '🗑️';
  removeBtn.title = 'Remove winner row';
  removeBtn.setAttribute('aria-label', 'Remove winner row');
  removeBtn.addEventListener('click', () => {
    row.remove();
    if (!rowsContainer.children.length) {
      createWinnerInputRow(rowsContainer, onUpdate);
    }
    onUpdate();
  });

  row.appendChild(combo);
  row.appendChild(removeBtn);
  rowsContainer.appendChild(row);
  return row;
}

function getPlayerMapByName() {
  return new Map(appState.players.map((player) => [player.name.toLowerCase(), player.id]));
}

function getValidPlayerIdsFromCard(card, playerMap) {
  const ids = [];
  const used = new Set();
  const inputs = [...card.querySelectorAll('input[type="text"]')];

  inputs.forEach((input) => {
    const typed = input.value.trim().toLowerCase();
    if (!typed) return;
    const playerId = playerMap.get(typed);
    if (!playerId || used.has(playerId)) return;
    used.add(playerId);
    ids.push(playerId);
  });

  return ids;
}

function resetConsumedCard(card) {
  const rows = [...card.querySelectorAll('.rank-select-row')];
  rows.forEach((row, index) => {
    const input = row.querySelector('input[type="text"]');
    if (input) {
      input.value = '';
      input.classList.remove('field-error');
    }

    const menu = row.querySelector('.suggestions');
    if (menu) menu.classList.add('hidden');

    if (index > 0) row.remove();
  });
}

function refreshConsumedRankCards(match) {
  const cards = [...winnersForm.querySelectorAll('.rank-card')]
    .sort((a, b) => Number(a.dataset.rank) - Number(b.dataset.rank));

  const playerMap = getPlayerMapByName();
  let consumeUntil = 0;

  cards.forEach((card) => {
    const rank = Number(card.dataset.rank);
    const shouldHide = rank <= consumeUntil;

    if (shouldHide) {
      if (!card.classList.contains('rank-consumed')) {
        resetConsumedCard(card);
      }
      card.classList.add('rank-consumed');
      return;
    }

    card.classList.remove('rank-consumed');

    const tieSize = getValidPlayerIdsFromCard(card, playerMap).length;
    if (tieSize > 1) {
      consumeUntil = Math.max(consumeUntil, rank + tieSize - 1);
    }
  });

  persistWinnerDraft(match.id);
}

function validateWinnerDraft(match) {
  if (!winnersForm.innerHTML || winnersForm.innerHTML.includes('washout/cancelled')) {
    return { errors: [], ranksPayload: [] };
  }

  const playerMap = getPlayerMapByName();
  const seenPlayers = new Map();
  const errors = [];
  const ranksPayload = [];
  const rankCards = [...winnersForm.querySelectorAll('.rank-card:not(.rank-consumed)')];

  if (!rankCards.length) {
    return { errors: [], ranksPayload: [] };
  }

  rankCards.forEach((card) => {
    const rank = Number(card.dataset.rank);
    const inputs = [...card.querySelectorAll('input[type="text"]')];
    const playerIds = [];

    inputs.forEach((input) => {
      const typedRaw = input.value.trim();
      const typed = typedRaw.toLowerCase();
      input.classList.remove('field-error');

      if (!typedRaw) return;

      const playerId = playerMap.get(typed);
      if (!playerId) {
        input.classList.add('field-error');
        errors.push(`"${typedRaw}" is not in your player list.`);
        return;
      }

      if (activeParticipantIds.length && !activeParticipantIds.includes(playerId)) {
        input.classList.add('field-error');
        errors.push(`"${typedRaw}" is not selected as a participant for this match.`);
        return;
      }

      if (seenPlayers.has(playerId)) {
        input.classList.add('field-error');
        errors.push(`"${typedRaw}" is already selected for Rank ${seenPlayers.get(playerId)}.`);
        return;
      }

      seenPlayers.set(playerId, rank);
      playerIds.push(playerId);
    });

    ranksPayload.push({ rank, player_ids: playerIds });
  });

  const expectedCount = getWinnerCount(match);
  if (!expectedCount) {
    errors.push('Winner count is not configured for this match.');
  }

  const selectedWinners = ranksPayload.reduce((sum, row) => sum + row.player_ids.length, 0);
  if (expectedCount && selectedWinners < expectedCount) {
    errors.push(`Select at least ${expectedCount} winner${expectedCount === 1 ? '' : 's'} in total.`);
  }

  return { errors, ranksPayload };
}

function updateWinnerFeedback(match) {
  if (winnersForm.innerHTML.includes('washout/cancelled')) {
    clearWinnerFeedback();
    return true;
  }

  const { errors } = validateWinnerDraft(match);
  if (!errors.length) {
    clearWinnerFeedback();
    return true;
  }

  setWinnerFeedback('error', errors[0]);
  return false;
}

function applyWinnerDraft(match, onWinnerChange) {
  const draft = getWinnerDraft(match.id);
  if (!draft?.ranks) return;

  Object.entries(draft.ranks).forEach(([rank, names]) => {
    const card = winnersForm.querySelector(`.rank-card[data-rank="${rank}"]`);
    if (!card) return;

    const rowsContainer = card.querySelector('.stack');
    const existingRows = [...rowsContainer.querySelectorAll('.rank-select-row')];
    const values = Array.isArray(names) ? names : [];
    if (!values.length) return;

    const firstInput = existingRows[0]?.querySelector('input[type="text"]');
    if (firstInput) {
      firstInput.value = values[0] || '';
    }

    values.slice(1).forEach((name) => {
      createWinnerInputRow(rowsContainer, onWinnerChange, name);
    });
  });
}

function renderWinnerForm(matchId) {
  winnersForm.innerHTML = '';
  clearWinnerFeedback();

  const match = appState.matches.find((item) => String(item.id) === String(matchId));
  if (!match || !appState.league || !appState.players.length) {
    winnersForm.innerHTML = '<p class="muted">Set up league, players, and matches first.</p>';
    return;
  }

  activeParticipantIds = Array.isArray(match.participant_ids) && match.participant_ids.length
    ? match.participant_ids.map((value) => Number(value))
    : appState.players.map((player) => Number(player.id));

  const participantNames = appState.players
    .filter((player) => activeParticipantIds.includes(Number(player.id)))
    .map((player) => player.name);

  const participantSummary = document.createElement('div');
  participantSummary.className = 'feed-item';
  participantSummary.innerHTML = `
    <strong>Eligible Players</strong><br>
    <span class="muted">${participantNames.join(', ') || 'No participants captured for this match.'}</span>
  `;
  winnersForm.appendChild(participantSummary);

  const onWinnerChange = () => {
    refreshConsumedRankCards(match);
    updateWinnerFeedback(match);
  };

  const winnerCount = getWinnerCount(match);
  for (let rank = 1; rank <= winnerCount; rank += 1) {
    const card = document.createElement('section');
    card.className = 'rank-card';
    card.dataset.rank = String(rank);

    const title = document.createElement('h4');
    title.textContent = `${rankIcon(rank)} Rank ${rank}`;

    const rowsContainer = document.createElement('div');
    rowsContainer.className = 'stack';

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'ghost';
    addBtn.textContent = '+ Add Winner';
    addBtn.addEventListener('click', () => {
      createWinnerInputRow(rowsContainer, onWinnerChange);
      onWinnerChange();
    });

    createWinnerInputRow(rowsContainer, onWinnerChange);

    card.appendChild(title);
    card.appendChild(rowsContainer);
    card.appendChild(addBtn);
    winnersForm.appendChild(card);
  }

  applyWinnerDraft(match, onWinnerChange);
  refreshConsumedRankCards(match);
  updateWinnerFeedback(match);

  saveWinnersBtn = document.createElement('button');
  saveWinnersBtn.type = 'submit';
  saveWinnersBtn.textContent = 'Save Winners';
  winnersForm.appendChild(saveWinnersBtn);

  winnersForm.onsubmit = async (event) => {
    event.preventDefault();
    const saved = await saveWinners(match, { showSuccess: true });
    if (!saved) return;

    setWinnerFeedback(
      'success',
      `<strong>Saved beautifully.</strong> Winners for <strong>${match.title}</strong> are now recorded and ready for the ledger.`
    );
  };
}

async function saveWinners(match, options = {}) {
  const { showSuccess = false } = options;
  try {
    if (saveWinnersBtn) {
      saveWinnersBtn.disabled = true;
      saveWinnersBtn.textContent = 'Saving...';
    }

    refreshConsumedRankCards(match);
    const { errors, ranksPayload } = validateWinnerDraft(match);
    if (errors.length) {
      updateWinnerFeedback(match);
      return false;
    }

    await callApi(`/api/matches/${match.id}/winners`, {
      method: 'POST',
      body: JSON.stringify({ ranks: ranksPayload }),
    });

    clearWinnerDraft(match.id);
    if (showSuccess) {
      appState = await callApi('/api/state');
    }
    return true;
  } catch (error) {
    showError(error);
    return false;
  } finally {
    if (saveWinnersBtn) {
      saveWinnersBtn.disabled = false;
      saveWinnersBtn.textContent = 'Save Winners';
    }
  }
}

loadWinnerBtn.addEventListener('click', () => {
  if (authUser.role !== 'admin') {
    showError('Only admin can assign winners.');
    return;
  }
  if (!matchSelect.value) {
    showError('Choose a match first.');
    return;
  }
  setSelectedMatchId(matchSelect.value);
  renderWinnerForm(matchSelect.value);
});

matchSelect.addEventListener('change', () => {
  setSelectedMatchId(matchSelect.value);
  if (authUser.role === 'admin') {
    renderWinnerForm(matchSelect.value);
  }
});

cancelMatchBtn.addEventListener('click', async () => {
  if (authUser.role !== 'admin') {
    showError('Only admin can cancel a match.');
    return;
  }
  if (!matchSelect.value) {
    showError('Choose a match first.');
    return;
  }

  const proceed = window.confirm('Mark this match as washout/cancelled and refund equally to all players?');
  if (!proceed) return;

  try {
    await callApi(`/api/matches/${matchSelect.value}/cancel`, { method: 'POST' });
    clearWinnerDraft(matchSelect.value);
    winnersForm.innerHTML = '<p class="muted">Match marked as washout/cancelled. Refund distributed equally.</p>';
    clearWinnerFeedback();
  } catch (error) {
    showError(error);
  }
});

continueLedgerBtn.addEventListener('click', async () => {
  if (authUser.role !== 'admin') {
    navigateTo('/ledger');
    return;
  }

  const match = appState.matches.find((item) => String(item.id) === String(matchSelect.value));
  if (!match) {
    showError('Choose a match first.');
    return;
  }

  const saved = await saveWinners(match);
  if (!saved) return;

  setCurrentWorkflowPage('/ledger');
  navigateTo('/ledger');
});

async function init() {
  authUser = await initWorkflowShell('/winners');
  if (!authUser) return;
  applyRoleBasedUI();
  appState = await callApi('/api/state');
  renderMatchSelect();

  if (authUser.role === 'admin' && matchSelect.value) {
    renderWinnerForm(matchSelect.value);
  }
}

init().catch((error) => {
  console.error('Winners initialization failed:', error);
  showError(error);
});
