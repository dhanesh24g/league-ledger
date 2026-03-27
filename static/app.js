const leagueForm = document.getElementById('league-form');
const playerForm = document.getElementById('player-form');
const matchForm = document.getElementById('match-form');

const playersList = document.getElementById('players-list');
const leagueState = document.getElementById('league-state');
const matchSelect = document.getElementById('match-select');
const loadWinnerBtn = document.getElementById('load-winner-form');
const cancelMatchBtn = document.getElementById('mark-cancelled');
const winnersForm = document.getElementById('winners-form');
const ledgerBody = document.getElementById('ledger-body');
const matchFeed = document.getElementById('match-feed');

const defaultPayouts = document.getElementById('default-payouts');
const addDefaultPayoutBtn = document.getElementById('add-default-payout');
const overridePayouts = document.getElementById('override-payouts');
const addOverridePayoutBtn = document.getElementById('add-override-payout');
const enableOverrides = document.getElementById('enable-overrides');
const overrideZone = document.getElementById('override-zone');
const defaultPayoutTotal = document.getElementById('default-payout-total');
const overridePayoutTotal = document.getElementById('override-payout-total');

const stepPills = [...document.querySelectorAll('.step-pill')];
const stepPanels = [...document.querySelectorAll('.step-panel')];
const prevStepBtn = document.getElementById('prev-step');
const nextStepBtn = document.getElementById('next-step');

const stepOrder = ['setup', 'players', 'matches', 'winners', 'ledger'];
const RANK_ICONS = ['🥇', '🥈', '🥉', '🏅', '🎖️', '🏆'];

let currentStepIndex = 0;
let state = { league: null, players: [], matches: [] };
let winnerFeedbackEl = null;

async function callApi(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || 'Request failed');
  }
  return res.json();
}

function showError(err) {
  const message = err instanceof Error ? err.message : String(err);
  window.alert(message);
}

function rankIcon(rank) {
  if (rank <= RANK_ICONS.length) return RANK_ICONS[rank - 1];
  return '🏅';
}

function getPayoutTotalTarget(container) {
  return container === defaultPayouts ? defaultPayoutTotal : overridePayoutTotal;
}

function getDefaultPrizePool() {
  const fee = Number(leagueForm.elements.entry_fee.value);
  const players = Number(leagueForm.elements.active_player_count.value);
  if (!Number.isFinite(fee) || !Number.isFinite(players) || fee <= 0 || players <= 0) return 0;
  return fee * players;
}

function getPayoutTotalFromContainer(container) {
  return [...container.querySelectorAll('.payout-amount')]
    .map((input) => Number(input.value))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .reduce((sum, value) => sum + value, 0);
}

function updatePayoutTotal(container) {
  const target = getPayoutTotalTarget(container);
  if (!target) return;

  const total = getPayoutTotalFromContainer(container);
  const winners = container.querySelectorAll('.payout-row').length;

  if (container === defaultPayouts) {
    const pool = getDefaultPrizePool();
    const delta = Math.abs(pool - total);
    const status = delta < 0.01 ? 'Matched' : `Difference: ${(total - pool).toFixed(2)}`;
    target.textContent = `Total payout: ${total.toFixed(2)} | Prize pool: ${pool.toFixed(2)} | ${status}`;
    target.classList.toggle('payout-match', delta < 0.01);
    target.classList.toggle('payout-mismatch', delta >= 0.01);
    return;
  }

  target.textContent = `Total payout: ${total.toFixed(2)} across ${winners} winner${winners === 1 ? '' : 's'}`;
  target.classList.remove('payout-match', 'payout-mismatch');
}

function setStep(index) {
  currentStepIndex = Math.max(0, Math.min(index, stepOrder.length - 1));
  const activeStep = stepOrder[currentStepIndex];

  stepPills.forEach((pill) => {
    pill.classList.toggle('active', pill.dataset.step === activeStep);
  });

  stepPanels.forEach((panel) => {
    panel.classList.toggle('active', panel.id === `step-${activeStep}`);
  });

  prevStepBtn.disabled = currentStepIndex === 0;
  nextStepBtn.textContent = currentStepIndex === stepOrder.length - 1 ? 'Done' : 'Continue';
}

function renumberPayoutRows(container) {
  const rows = [...container.querySelectorAll('.payout-row')];
  rows.forEach((row, index) => {
    const rank = index + 1;
    row.dataset.rank = String(rank);
    const icon = row.querySelector('.rank-icon');
    const text = row.querySelector('.rank-text');
    if (icon) icon.textContent = rankIcon(rank);
    if (text) text.textContent = `Winner ${rank}`;
  });
  updatePayoutTotal(container);
}

function createPayoutRow(container, amount = '') {
  const row = document.createElement('div');
  row.className = 'payout-row';

  const label = document.createElement('div');
  label.className = 'payout-rank-display';

  const icon = document.createElement('span');
  icon.className = 'rank-icon';

  const text = document.createElement('span');
  text.className = 'rank-text';

  label.appendChild(icon);
  label.appendChild(text);

  const amountInput = document.createElement('input');
  amountInput.type = 'number';
  amountInput.min = '0';
  amountInput.step = '0.01';
  amountInput.placeholder = 'Winning amount';
  amountInput.className = 'payout-amount';
  amountInput.value = amount;
  amountInput.addEventListener('input', () => updatePayoutTotal(container));

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'remove';
  removeBtn.textContent = 'Remove';
  removeBtn.addEventListener('click', () => {
    row.remove();
    renumberPayoutRows(container);
  });

  row.appendChild(label);
  row.appendChild(amountInput);
  row.appendChild(removeBtn);
  container.appendChild(row);
  renumberPayoutRows(container);
}

function setPayoutRows(container, payouts) {
  container.innerHTML = '';
  const entries = Object.entries(payouts || {})
    .map(([rank, amount]) => ({ rank: Number(rank), amount: Number(amount) }))
    .filter((entry) => Number.isFinite(entry.rank) && Number.isFinite(entry.amount))
    .sort((a, b) => a.rank - b.rank);

  if (!entries.length) {
    createPayoutRow(container, '');
    return;
  }

  entries.forEach((entry) => createPayoutRow(container, entry.amount));
}

function collectPayoutRows(container) {
  const map = {};
  const rows = [...container.querySelectorAll('.payout-row')];

  rows.forEach((row, index) => {
    const rank = index + 1;
    const amount = Number(row.querySelector('.payout-amount')?.value);
    if (!Number.isFinite(amount) || amount < 0) return;
    map[rank] = amount;
  });

  return map;
}

function toggleOverrideSection(forceValue) {
  const enabled = typeof forceValue === 'boolean' ? forceValue : enableOverrides.checked;
  enableOverrides.checked = enabled;
  overrideZone.classList.toggle('hidden', !enabled);

  if (!enabled) {
    matchForm.elements.winner_count.value = '';
    overridePayouts.innerHTML = '';
    updatePayoutTotal(overridePayouts);
  }
}

function renderLeague() {
  if (!state.league) {
    leagueState.textContent = 'No league configured yet. Fill setup and save.';
    if (!defaultPayouts.children.length) createPayoutRow(defaultPayouts, getDefaultPrizePool());
    return;
  }

  leagueForm.elements.name.value = state.league.name;
  leagueForm.elements.tournament.value = state.league.tournament;
  leagueForm.elements.entry_fee.value = state.league.entry_fee;
  leagueForm.elements.active_player_count.value = state.league.active_player_count || 5;
  setPayoutRows(defaultPayouts, state.league.payouts || {});

  leagueState.textContent = `${state.league.name} | ${state.league.tournament} | Entry Fee: ${state.league.entry_fee} | Players: ${state.league.active_player_count || '-'} | Winners: ${state.league.default_winner_count}`;
}

function renderPlayers() {
  playersList.innerHTML = '';

  if (!state.players.length) {
    playersList.innerHTML = '<li>No players added yet.</li>';
    return;
  }

  state.players.forEach((player) => {
    const li = document.createElement('li');

    const name = document.createElement('span');
    name.textContent = player.name;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'remove';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', async () => {
      try {
        await callApi(`/api/players/${player.id}`, { method: 'DELETE' });
        await refresh();
      } catch (err) {
        showError(err);
      }
    });

    li.appendChild(name);
    li.appendChild(removeBtn);
    playersList.appendChild(li);
  });
}

function renderMatches() {
  matchSelect.innerHTML = '';
  matchFeed.innerHTML = '';

  if (!state.matches.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No matches yet';
    matchSelect.appendChild(option);

    matchFeed.innerHTML = '<div class="feed-item">No matches created yet.</div>';
    return;
  }

  state.matches.forEach((match) => {
    const option = document.createElement('option');
    option.value = String(match.id);
    option.textContent = `${match.match_date} - ${match.title}`;
    matchSelect.appendChild(option);

    const feedItem = document.createElement('div');
    feedItem.className = 'feed-item';

    const count = match.winner_count || state.league?.default_winner_count || 0;
    const payoutMode = match.payouts && Object.keys(match.payouts).length ? 'Custom payout' : 'Default payout';

    feedItem.innerHTML = `<strong>${match.title}</strong><br>${match.match_date} • Winners: ${count} • ${payoutMode} • Status: ${match.status}`;
    matchFeed.appendChild(feedItem);
  });
}

function getWinnerCount(match) {
  if (match?.winner_count) return Number(match.winner_count);
  return Number(state.league?.default_winner_count || 0);
}

function getPlayerSuggestions(query) {
  const raw = query.trim().toLowerCase();
  if (!raw) return state.players.slice(0, 8);

  return state.players
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

  input.addEventListener('focus', () => {
    refreshSuggestions();
  });

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
  removeBtn.textContent = 'Remove';
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
}

function ensureWinnerFeedback() {
  if (winnerFeedbackEl) return winnerFeedbackEl;

  winnerFeedbackEl = document.createElement('p');
  winnerFeedbackEl.className = 'winner-feedback hidden';
  winnersForm.before(winnerFeedbackEl);
  return winnerFeedbackEl;
}

function getPlayerMapByName() {
  return new Map(state.players.map((player) => [player.name.toLowerCase(), player.id]));
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
}

function validateWinnerDraft(match) {
  const playerMap = getPlayerMapByName();
  const seenPlayers = new Map();
  const errors = [];
  const ranksPayload = [];

  const rankCards = [...winnersForm.querySelectorAll('.rank-card:not(.rank-consumed)')];
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
  const feedback = ensureWinnerFeedback();
  const { errors } = validateWinnerDraft(match);

  if (!errors.length) {
    feedback.classList.add('hidden');
    feedback.textContent = '';
    return true;
  }

  feedback.classList.remove('hidden');
  feedback.textContent = errors[0];
  return false;
}

function renderWinnerForm(matchId) {
  winnersForm.innerHTML = '';
  const feedback = ensureWinnerFeedback();
  feedback.classList.add('hidden');
  feedback.textContent = '';

  const match = state.matches.find((item) => String(item.id) === String(matchId));
  if (!match || !state.league || !state.players.length) {
    winnersForm.innerHTML = '<p class="muted">Set up league, players, and matches first.</p>';
    return;
  }

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

  refreshConsumedRankCards(match);

  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.textContent = 'Save Winners';
  winnersForm.appendChild(submitBtn);

  winnersForm.onsubmit = async (event) => {
    event.preventDefault();

    try {
      refreshConsumedRankCards(match);
      const { errors, ranksPayload } = validateWinnerDraft(match);
      if (errors.length) {
        updateWinnerFeedback(match);
        return;
      }

      await callApi(`/api/matches/${match.id}/winners`, {
        method: 'POST',
        body: JSON.stringify({ ranks: ranksPayload }),
      });

      await refresh();
      renderWinnerForm(match.id);
      setStep(stepOrder.indexOf('ledger'));
    } catch (err) {
      showError(err);
    }
  };
}

function renderLedgerRows(data) {
  ledgerBody.innerHTML = '';

  if (!data.rows.length) {
    ledgerBody.innerHTML = '<tr><td colspan="4">No ledger data yet.</td></tr>';
    return;
  }

  data.rows.forEach((row) => {
    const tr = document.createElement('tr');
    const netClass = row.net >= 0 ? 'pos' : 'neg';

    tr.innerHTML = `
      <td>${row.name}</td>
      <td>${row.spent.toFixed(2)}</td>
      <td>${row.won.toFixed(2)}</td>
      <td class="${netClass}">${row.net.toFixed(2)}</td>
    `;

    ledgerBody.appendChild(tr);
  });
}

async function refresh() {
  state = await callApi('/api/state');
  renderLeague();
  renderPlayers();
  renderMatches();

  const ledger = await callApi('/api/ledger');
  renderLedgerRows(ledger);
}

stepPills.forEach((pill) => {
  pill.addEventListener('click', () => {
    const index = stepOrder.indexOf(pill.dataset.step);
    if (index >= 0) setStep(index);
  });
});

prevStepBtn.addEventListener('click', () => setStep(currentStepIndex - 1));
nextStepBtn.addEventListener('click', () => setStep(currentStepIndex + 1));

addDefaultPayoutBtn.addEventListener('click', () => createPayoutRow(defaultPayouts));
addOverridePayoutBtn.addEventListener('click', () => createPayoutRow(overridePayouts));
enableOverrides.addEventListener('change', () => toggleOverrideSection(enableOverrides.checked));
updatePayoutTotal(defaultPayouts);
updatePayoutTotal(overridePayouts);
leagueForm.elements.entry_fee.addEventListener('input', () => updatePayoutTotal(defaultPayouts));
leagueForm.elements.active_player_count.addEventListener('input', () => updatePayoutTotal(defaultPayouts));

leagueForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  try {
    const formData = new FormData(leagueForm);
    const payouts = collectPayoutRows(defaultPayouts);
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

    await callApi('/api/league', {
      method: 'POST',
      body: JSON.stringify({
        name: String(formData.get('name') || ''),
        tournament: String(formData.get('tournament') || ''),
        entry_fee: entryFee,
        active_player_count: activePlayerCount,
        default_winner_count: defaultWinnerCount,
        payouts,
      }),
    });

    await refresh();
    setStep(stepOrder.indexOf('players'));
  } catch (err) {
    showError(err);
  }
});

playerForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  try {
    const formData = new FormData(playerForm);
    await callApi('/api/players', {
      method: 'POST',
      body: JSON.stringify({ name: String(formData.get('name') || '') }),
    });

    playerForm.reset();
    await refresh();
  } catch (err) {
    showError(err);
  }
});

matchForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  try {
    const formData = new FormData(matchForm);
    const payload = {
      title: String(formData.get('title') || ''),
      match_date: String(formData.get('match_date') || ''),
      winner_count: null,
      payouts: null,
    };

    if (enableOverrides.checked) {
      const winnerCount = Number(formData.get('winner_count'));
      const payouts = collectPayoutRows(overridePayouts);

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

    matchForm.reset();
    toggleOverrideSection(false);
    await refresh();
    setStep(stepOrder.indexOf('winners'));
  } catch (err) {
    showError(err);
  }
});

loadWinnerBtn.addEventListener('click', () => {
  if (!matchSelect.value) {
    showError('Choose a match first.');
    return;
  }
  renderWinnerForm(matchSelect.value);
});

cancelMatchBtn.addEventListener('click', async () => {
  if (!matchSelect.value) {
    showError('Choose a match first.');
    return;
  }

  const proceed = window.confirm('Mark this match as washout/cancelled and refund equally to all players?');
  if (!proceed) return;

  try {
    await callApi(`/api/matches/${matchSelect.value}/cancel`, { method: 'POST' });
    winnersForm.innerHTML = '<p class="muted">Match marked as washout/cancelled. Refund distributed equally.</p>';
    await refresh();
  } catch (err) {
    showError(err);
  }
});

setStep(0);
toggleOverrideSection(false);

refresh().catch((err) => {
  showError(err);
});
