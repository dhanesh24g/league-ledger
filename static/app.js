const leagueForm = document.getElementById('league-form');
const playerForm = document.getElementById('player-form');
const matchForm = document.getElementById('match-form');
const playersList = document.getElementById('players-list');
const leagueState = document.getElementById('league-state');
const matchSelect = document.getElementById('match-select');
const winnersForm = document.getElementById('winners-form');
const loadWinnerBtn = document.getElementById('load-winner-form');
const ledgerBody = document.getElementById('ledger-body');

let state = { league: null, players: [], matches: [] };

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

function parseJsonInput(value, fallback = {}) {
  const raw = value.trim();
  if (!raw) return fallback;
  return JSON.parse(raw);
}

function renderLeague() {
  if (!state.league) {
    leagueState.textContent = 'No league configured yet.';
    return;
  }
  leagueState.textContent = `${state.league.name} (${state.league.tournament}) | Entry Fee: ${state.league.entry_fee} | Default Winners: ${state.league.default_winner_count}`;
}

function renderPlayers() {
  playersList.innerHTML = '';
  state.players.forEach((player) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${player.name}</span>`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Remove';
    btn.onclick = async () => {
      await callApi(`/api/players/${player.id}`, { method: 'DELETE' });
      await refresh();
    };
    li.appendChild(btn);
    playersList.appendChild(li);
  });
}

function renderMatches() {
  matchSelect.innerHTML = '';
  if (!state.matches.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No matches yet';
    matchSelect.appendChild(option);
    return;
  }

  state.matches.forEach((m) => {
    const option = document.createElement('option');
    option.value = String(m.id);
    option.textContent = `${m.match_date} - ${m.title} (${m.status})`;
    matchSelect.appendChild(option);
  });
}

function getWinnerCount(match) {
  if (match?.winner_count) return Number(match.winner_count);
  return Number(state.league?.default_winner_count || 0);
}

function renderWinnerForm(matchId) {
  winnersForm.innerHTML = '';
  const match = state.matches.find((m) => String(m.id) === String(matchId));
  if (!match || !state.players.length || !state.league) {
    winnersForm.innerHTML = '<p class="hint">Add league settings, players, and a match first.</p>';
    return;
  }

  const winnerCount = getWinnerCount(match);
  for (let rank = 1; rank <= winnerCount; rank += 1) {
    const block = document.createElement('div');
    block.className = 'rank-block';
    block.innerHTML = `<p class="rank-title">Rank ${rank}</p>`;

    const grid = document.createElement('div');
    grid.className = 'check-grid';

    state.players.forEach((player) => {
      const label = document.createElement('label');
      label.innerHTML = `<input type="checkbox" data-rank="${rank}" value="${player.id}"> ${player.name}`;
      grid.appendChild(label);
    });

    block.appendChild(grid);
    winnersForm.appendChild(block);
  }

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = 'Save Winners';
  winnersForm.appendChild(submit);

  winnersForm.onsubmit = async (e) => {
    e.preventDefault();
    const payload = [];

    for (let rank = 1; rank <= winnerCount; rank += 1) {
      const selected = [...winnersForm.querySelectorAll(`input[data-rank="${rank}"]:checked`)]
        .map((el) => Number(el.value));
      payload.push({ rank, player_ids: selected });
    }

    await callApi(`/api/matches/${match.id}/winners`, {
      method: 'POST',
      body: JSON.stringify({ ranks: payload }),
    });
    await refresh();
    renderWinnerForm(match.id);
  };
}

function renderLedgerRows(data) {
  ledgerBody.innerHTML = '';
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

leagueForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const formData = new FormData(leagueForm);
  await callApi('/api/league', {
    method: 'POST',
    body: JSON.stringify({
      name: formData.get('name'),
      tournament: formData.get('tournament'),
      entry_fee: Number(formData.get('entry_fee')),
      default_winner_count: Number(formData.get('default_winner_count')),
      payouts: parseJsonInput(String(formData.get('payouts')), {}),
    }),
  });
  await refresh();
});

playerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const formData = new FormData(playerForm);
  await callApi('/api/players', {
    method: 'POST',
    body: JSON.stringify({ name: String(formData.get('name')) }),
  });
  playerForm.reset();
  await refresh();
});

matchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const formData = new FormData(matchForm);
  const payoutRaw = String(formData.get('payouts') || '').trim();
  await callApi('/api/matches', {
    method: 'POST',
    body: JSON.stringify({
      title: formData.get('title'),
      match_date: formData.get('match_date'),
      winner_count: formData.get('winner_count') ? Number(formData.get('winner_count')) : null,
      payouts: payoutRaw ? parseJsonInput(payoutRaw) : null,
    }),
  });
  matchForm.reset();
  await refresh();
});

loadWinnerBtn.addEventListener('click', () => {
  if (!matchSelect.value) return;
  renderWinnerForm(matchSelect.value);
});

refresh().catch((err) => {
  leagueState.textContent = err.message;
});
