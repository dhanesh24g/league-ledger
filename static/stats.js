const topNav = document.getElementById('top-nav');
const logoutBtn = document.getElementById('logout-btn');
const authRole = document.getElementById('auth-role');

const matchFilter = document.getElementById('match-filter');
const playerFilter = document.getElementById('player-filter');
const matchWinnersCard = document.getElementById('match-winners-card');
const playerStatsCard = document.getElementById('player-stats-card');

let stats = { matches: [], players: [] };

function getToken() {
  return localStorage.getItem('league-ledger-token') || '';
}

function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function callApi(url, options = {}) {
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(options.headers || {}),
    },
    ...options,
  });
  if (res.status === 401) {
    localStorage.removeItem('league-ledger-token');
    window.location.replace('/login');
    throw new Error('Session expired. Please login again.');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || 'Request failed');
  }
  return res.json();
}

function setupHeader() {
  const role = localStorage.getItem('league-ledger-user-role') || 'viewer';
  const username = localStorage.getItem('league-ledger-username') || 'user';
  authRole.textContent = `${username} (${role})`;

  topNav.addEventListener('change', () => {
    window.location.href = topNav.value;
  });

  logoutBtn.addEventListener('click', () => {
    localStorage.removeItem('league-ledger-token');
    localStorage.removeItem('league-ledger-user-role');
    localStorage.removeItem('league-ledger-username');
    window.location.replace('/login');
  });
}

function renderMatchFilter() {
  matchFilter.innerHTML = '';
  if (!stats.matches.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No matches available';
    matchFilter.appendChild(option);
    return;
  }
  stats.matches.forEach((match, index) => {
    const option = document.createElement('option');
    option.value = String(match.match_id);
    option.textContent = `${index + 1}. ${match.title} (${match.match_date})`;
    matchFilter.appendChild(option);
  });
}

function renderPlayerFilter() {
  playerFilter.innerHTML = '';
  if (!stats.players.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No players available';
    playerFilter.appendChild(option);
    return;
  }
  stats.players.forEach((player) => {
    const option = document.createElement('option');
    option.value = String(player.player_id);
    option.textContent = player.name;
    playerFilter.appendChild(option);
  });
}

function renderSelectedMatch() {
  const match = stats.matches.find((item) => String(item.match_id) === String(matchFilter.value));
  if (!match) {
    matchWinnersCard.innerHTML = '<div class="feed-item">No match data found.</div>';
    return;
  }

  if (!match.winners.length) {
    matchWinnersCard.innerHTML = `<div class="feed-item"><strong>${match.title}</strong><br>No winners saved for this match yet.</div>`;
    return;
  }

  const winnerRows = match.winners
    .map((row) => `Rank ${row.rank}: ${row.players.join(', ')} (${row.amount_each.toFixed(2)} each)`)
    .join('<br>');

  matchWinnersCard.innerHTML = `
    <div class="feed-item">
      <strong>${match.title}</strong><br>
      ${match.match_date} • ${match.status}<br><br>
      ${winnerRows}
    </div>
  `;
}

function renderSelectedPlayer() {
  const player = stats.players.find((item) => String(item.player_id) === String(playerFilter.value));
  if (!player) {
    playerStatsCard.innerHTML = '<div class="feed-item">No player data found.</div>';
    return;
  }

  const rankLines = Object.keys(player.rank_counts || {})
    .sort((a, b) => Number(a) - Number(b))
    .map((rank) => `Rank ${rank}: ${player.rank_counts[rank]} time(s)`)
    .join('<br>') || 'No rank placements yet';

  playerStatsCard.innerHTML = `
    <div class="feed-item">
      <strong>${player.name}</strong><br><br>
      Total Wins: ${player.wins_total}<br>
      Matches Won: ${player.matches_won}<br>
      Total Won Amount: ${Number(player.total_amount).toFixed(2)}<br><br>
      ${rankLines}
    </div>
  `;
}

async function init() {
  setupHeader();
  stats = await callApi('/api/stats');
  renderMatchFilter();
  renderPlayerFilter();

  if (stats.matches.length) {
    matchFilter.value = String(stats.matches[0].match_id);
  }
  if (stats.players.length) {
    playerFilter.value = String(stats.players[0].player_id);
  }

  renderSelectedMatch();
  renderSelectedPlayer();

  matchFilter.addEventListener('change', renderSelectedMatch);
  playerFilter.addEventListener('change', renderSelectedPlayer);
}

init().catch((err) => {
  console.error('Stats initialization failed:', err);
  window.alert(err instanceof Error ? err.message : String(err));
});
