import {
  callApi,
  initThemeToggle,
  showError,
} from '/static/workflow-common.js';

const matchFilter = document.getElementById('match-filter');
const playerFilter = document.getElementById('player-filter');
const matchWinnersCard = document.getElementById('match-winners-card');
const playerStatsCard = document.getElementById('player-stats-card');
const statsOverview = document.getElementById('stats-overview');
const statsSummaryStrip = document.getElementById('stats-summary-strip');
const leaderboardChart = document.getElementById('leaderboard-chart');
const topNav = document.getElementById('top-nav');
const logoutBtn = document.getElementById('logout-btn');
const authRole = document.getElementById('auth-role');
const earnersModal = document.getElementById('earners-modal');
const earnersModalBody = document.getElementById('earners-modal-body');
const closeEarnersModalBtn = document.getElementById('close-earners-modal');

let stats = {
  summary: {
    total_matches: 0,
    played_matches: 0,
    canceled_matches: 0,
  },
  matches: [],
  players: [],
};

const RANK_VISUALS = {
  0: { icon: '🌧️', label: 'Washout / Refund' },
  1: { icon: '🥇', label: 'Champion' },
  2: { icon: '🥈', label: 'Runner-up' },
  3: { icon: '🥉', label: 'Third place' },
  4: { icon: '🏅', label: 'Fourth place' },
  5: { icon: '🎖️', label: 'Fifth place' },
};

const TROPHIES = ['🥇', '🥈', '🥉'];

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatCurrency(value) {
  return Number(value || 0).toFixed(2);
}

function getRankVisual(rank) {
  return RANK_VISUALS[rank] || { icon: '🏁', label: `Rank ${rank}` };
}

function getInitials(name) {
  return String(name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('') || 'LL';
}

function barWidth(value, maxValue) {
  if (!maxValue || maxValue <= 0) {
    return '0%';
  }
  return `${Math.max(8, Math.round((Number(value || 0) / maxValue) * 100))}%`;
}

function getBestFinish(player) {
  const positiveRanks = Object.keys(player.rank_counts || {})
    .map((rank) => Number(rank))
    .filter((rank) => rank > 0)
    .sort((a, b) => a - b);

  if (positiveRanks.length) {
    return getRankVisual(positiveRanks[0]).label;
  }

  return Number(player.washout_matches || 0) ? 'Washout only' : 'No finish yet';
}

function openEarnersModal() {
  if (!earnersModal) return;
  earnersModal.classList.remove('hidden');
  earnersModal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
}

function closeEarnersModal() {
  if (!earnersModal) return;
  earnersModal.classList.add('hidden');
  earnersModal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
}

function renderEarnersModal() {
  if (!earnersModalBody) return;

  if (!stats.players.length) {
    earnersModalBody.innerHTML = '<div class="feed-item">No earnings data yet.</div>';
    return;
  }

  const topEarners = [...stats.players]
    .sort((a, b) => (b.total_amount - a.total_amount) || (b.wins_total - a.wins_total) || a.name.localeCompare(b.name));
  const maxAmount = Math.max(...topEarners.map((player) => Number(player.total_amount || 0)), 0);

  earnersModalBody.innerHTML = `
    <div class="zoom-board">
      ${topEarners.map((player, index) => `
        <article class="zoom-board-row">
          <div class="zoom-board-head">
            <span class="zoom-board-rank">${TROPHIES[index] || `#${index + 1}`}</span>
            <div class="chart-player-avatar">${escapeHtml(getInitials(player.name))}</div>
            <div>
              <strong>${escapeHtml(player.name)}</strong>
              <p class="muted">${player.matches_played} played • ${player.matches_won} winning matches • ${player.wins_total} titles</p>
            </div>
          </div>
          <div class="zoom-board-lane">
            <div class="chart-bar-track">
              <span class="chart-bar-fill amount" style="width: ${barWidth(player.total_amount, maxAmount)};"></span>
            </div>
            <strong>${formatCurrency(player.total_amount)}</strong>
          </div>
        </article>
      `).join('')}
    </div>
  `;
}

function renderOverview() {
  const { total_matches, played_matches, canceled_matches } = stats.summary || {};

  statsSummaryStrip.innerHTML = `
    <div class="summary-chip">
      <span class="summary-chip-label">Total Matches</span>
      <strong>${Number(total_matches || 0)}</strong>
    </div>
    <div class="summary-chip">
      <span class="summary-chip-label">Matches Played</span>
      <strong>${Number(played_matches || 0)}</strong>
    </div>
    <div class="summary-chip">
      <span class="summary-chip-label">Washout / Canceled</span>
      <strong>${Number(canceled_matches || 0)}</strong>
    </div>
  `;

  if (!stats.players.length) {
    statsOverview.innerHTML = '<div class="feed-item">No stats yet. Add results to light this dashboard up.</div>';
    return;
  }

  const topWinner = [...stats.players].sort((a, b) => (b.wins_total - a.wins_total) || a.name.localeCompare(b.name))[0];
  const topEarner = [...stats.players].sort((a, b) => (b.total_amount - a.total_amount) || a.name.localeCompare(b.name))[0];
  const topEarners = [...stats.players]
    .sort((a, b) => (b.total_amount - a.total_amount) || a.name.localeCompare(b.name))
    .slice(0, 3);

  const topEarnerRows = topEarners
    .map((player, index) => `
      <div class="top-earner-row">
        <span class="top-earner-rank">${TROPHIES[index] || `#${index + 1}`}</span>
        <strong>${escapeHtml(player.name)}</strong>
        <span class="top-earner-amount">${formatCurrency(player.total_amount)}</span>
      </div>
    `)
    .join('');

  statsOverview.innerHTML = `
    <article class="spotlight-card winner">
      <span class="spotlight-label">Most Wins</span>
      <strong>${escapeHtml(topWinner.name)}</strong>
      <span class="spotlight-metric">${topWinner.wins_total}</span>
      <p>First-place finishes collected so far.</p>
    </article>
    <article class="spotlight-card earner">
      <span class="spotlight-label">Top Earner</span>
      <strong>${escapeHtml(topEarner.name)}</strong>
      <span class="spotlight-metric">${formatCurrency(topEarner.total_amount)}</span>
      <p>Total amount won across all recorded results.</p>
    </article>
    <article id="top-earners-card" class="spotlight-card leaders">
      <span class="spotlight-label">Top 3 Earners</span>
      <div class="top-earner-list">${topEarnerRows}</div>
      <div class="spotlight-card-actions">
        <p>Open a richer view of the winnings table with all players ranked together.</p>
        <button id="open-earners-modal" type="button" class="ghost stats-action-button">Click For Deep Dive</button>
      </div>
    </article>
  `;

  document.getElementById('open-earners-modal')?.addEventListener('click', openEarnersModal);
}

function renderLeaderboardChart() {
  if (!stats.players.length) {
    leaderboardChart.innerHTML = '<div class="feed-item">Player comparisons will appear here once results are saved.</div>';
    return;
  }

  const maxWins = Math.max(...stats.players.map((player) => Number(player.wins_total || 0)), 0);
  const maxAmount = Math.max(...stats.players.map((player) => Number(player.total_amount || 0)), 0);

  const rows = stats.players
    .map((player) => `
      <article class="chart-row-card">
        <div class="chart-player-head">
          <div class="chart-player-avatar">${escapeHtml(getInitials(player.name))}</div>
          <div>
            <strong>${escapeHtml(player.name)}</strong>
            <p class="muted">${player.matches_played} matches • ${player.matches_won} winning matches • ${player.washout_matches} washouts</p>
          </div>
        </div>
        <div class="chart-lane">
          <span class="chart-lane-label">Wins</span>
          <div class="chart-bar-track">
            <span class="chart-bar-fill wins" style="width: ${barWidth(player.wins_total, maxWins)};"></span>
          </div>
          <strong>${player.wins_total}</strong>
        </div>
        <div class="chart-lane">
          <span class="chart-lane-label">Amount Won</span>
          <div class="chart-bar-track">
            <span class="chart-bar-fill amount" style="width: ${barWidth(player.total_amount, maxAmount)};"></span>
          </div>
          <strong>${formatCurrency(player.total_amount)}</strong>
        </div>
      </article>
    `)
    .join('');

  leaderboardChart.innerHTML = `
    <div class="chart-header">
      <div>
        <h3>League Ladder</h3>
        <p class="muted">Two quick bars per player: trophies and cash.</p>
      </div>
      <div class="chart-legend">
        <span class="status-chip">Wins</span>
        <span class="status-chip">Amount Won</span>
      </div>
    </div>
    <div class="chart-grid">${rows}</div>
  `;
}

function setupHeader() {
  initThemeToggle();
  topNav.addEventListener('change', () => {
    window.location.href = topNav.value;
  });

  logoutBtn.addEventListener('click', () => {
    localStorage.removeItem('league-ledger-token');
    localStorage.removeItem('league-ledger-user-role');
    localStorage.removeItem('league-ledger-username');
    localStorage.removeItem('league-ledger-full-name');
    window.location.replace('/login');
  });
}

function setupModal() {
  closeEarnersModalBtn?.addEventListener('click', closeEarnersModal);
  earnersModal?.querySelectorAll('[data-close-earners]').forEach((node) => {
    node.addEventListener('click', closeEarnersModal);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && earnersModal && !earnersModal.classList.contains('hidden')) {
      closeEarnersModal();
    }
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

  stats.matches.forEach((match) => {
    const option = document.createElement('option');
    option.value = String(match.match_id);
    option.textContent = `Match #${match.match_id} · ${match.title} (${match.match_date})`;
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
    matchWinnersCard.innerHTML = `<div class="feed-item"><strong>Match #${match.match_id} · ${match.title}</strong><br>No winners saved for this match yet.</div>`;
    return;
  }

  const totalDistributed = match.winners.reduce((sum, row) => sum + (row.amount_each * row.players.length), 0);
  const champions = match.winners.find((row) => Number(row.rank) === 1)?.players || [];
  const payoutSlots = match.winners.filter((row) => Number(row.rank) > 0).length;
  const winningEntries = match.winners
    .filter((row) => Number(row.rank) > 0)
    .reduce((sum, row) => sum + row.players.length, 0);
  const washoutEntries = match.winners
    .filter((row) => Number(row.rank) === 0)
    .reduce((sum, row) => sum + row.players.length, 0);
  const participantPills = (match.participants || [])
    .map((name) => `<span class="winner-pill subdued">${escapeHtml(name)}</span>`)
    .join('');

  const winnerRows = match.winners
    .map((row) => {
      const visual = getRankVisual(Number(row.rank));
      const players = row.players
        .map((player) => `<span class="winner-pill">${escapeHtml(player)}</span>`)
        .join('');
      const tieLabel = row.players.length > 1 ? `<span class="rank-tie">Tie x${row.players.length}</span>` : '';
      return `
        <article class="winner-rank-card rank-${Number(row.rank)}">
          <div class="winner-rank-head">
            <div>
              <span class="rank-badge">${visual.icon}</span>
              <strong>${escapeHtml(visual.label)}</strong>
            </div>
            <div class="winner-rank-meta">
              ${tieLabel}
              <span class="winner-amount">${formatCurrency(row.amount_each)} each</span>
            </div>
          </div>
          <div class="winner-pill-row">${players}</div>
        </article>
      `;
    })
    .join('');

  matchWinnersCard.innerHTML = `
    <article class="match-spotlight">
      <div class="match-spotlight-head">
        <div>
          <span class="match-kicker">Match #${match.match_id}</span>
          <h3>${escapeHtml(match.title)}</h3>
          <p class="muted">Champion line: ${escapeHtml(champions.join(', ') || 'Not decided')}</p>
        </div>
        <div class="match-spotlight-meta">
          <span class="status-chip">${escapeHtml(match.status)}</span>
          <span class="status-chip">${escapeHtml(match.match_date)}</span>
          <span class="status-chip">${match.participant_count || 0} players</span>
          <span class="status-chip">Settled ${formatCurrency(totalDistributed)}</span>
        </div>
      </div>
      <div class="match-summary-strip">
        <div class="match-summary-card">
          <span class="summary-chip-label">Champion</span>
          <strong>${escapeHtml(champions.join(', ') || 'None')}</strong>
        </div>
        <div class="match-summary-card">
          <span class="summary-chip-label">Participants</span>
          <strong>${match.participant_count || 0}</strong>
        </div>
        <div class="match-summary-card">
          <span class="summary-chip-label">Winning Entries</span>
          <strong>${winningEntries}</strong>
        </div>
        <div class="match-summary-card">
          <span class="summary-chip-label">Washout / Refunds</span>
          <strong>${washoutEntries}</strong>
        </div>
      </div>
      <div class="winner-pill-row winner-pill-row-subdued">${participantPills}</div>
      <div class="winner-rank-grid">${winnerRows}</div>
    </article>
  `;
}

function renderSelectedPlayer() {
  const player = stats.players.find((item) => String(item.player_id) === String(playerFilter.value));
  if (!player) {
    playerStatsCard.innerHTML = '<div class="feed-item">No player data found.</div>';
    return;
  }

  const rankCounts = Object.values(player.rank_counts || {}).map((value) => Number(value));
  const maxCount = Math.max(...rankCounts, 1);
  const rankLines = Object.keys(player.rank_counts || {})
    .sort((a, b) => Number(a) - Number(b))
    .map((rank) => {
      const rankNumber = Number(rank);
      const visual = getRankVisual(rankNumber);
      const count = Number(player.rank_counts[rank]);
      return `
        <div class="rank-distribution-row">
          <span class="rank-distribution-label">${visual.icon} ${escapeHtml(visual.label)}</span>
          <div class="rank-distribution-bar">
            <span class="rank-distribution-fill" style="width: ${barWidth(count, maxCount)};"></span>
          </div>
          <strong>${count}</strong>
        </div>
      `;
    })
    .join('') || '<p class="muted">No rank placements yet.</p>';

  const historyRows = (player.match_history || [])
    .map((entry) => `
      <article class="history-row">
        <div>
          <strong>${escapeHtml(entry.title)}</strong>
          <p class="muted">${escapeHtml(entry.match_date)} • ${escapeHtml(entry.status)}</p>
        </div>
        <div class="history-row-meta">
          <span class="status-chip">${escapeHtml(entry.result)}</span>
          <span class="status-chip">Won ${formatCurrency(entry.amount_won)}</span>
        </div>
      </article>
    `)
    .join('') || '<p class="muted">No match history yet.</p>';

  const matchesPlayed = Number(player.matches_played || 0);
  const matchesWon = Number(player.matches_won || 0);
  const winRate = matchesPlayed ? Math.round((matchesWon / matchesPlayed) * 100) : 0;

  playerStatsCard.innerHTML = `
    <article class="player-spotlight">
      <div class="player-hero">
        <div class="player-avatar">${escapeHtml(getInitials(player.name))}</div>
        <div>
          <h3>${escapeHtml(player.name)}</h3>
          <p class="muted">Performance fingerprint based on who played, who placed, and where the money landed.</p>
        </div>
      </div>
      <div class="player-metric-grid">
        <div class="player-metric-card accent-cyan">
          <span>Total Matches Played</span>
          <strong>${matchesPlayed}</strong>
          <small>Actual recorded participant history</small>
        </div>
        <div class="player-metric-card accent-gold">
          <span>Total Matches Won</span>
          <strong>${matchesWon}</strong>
          <small>Matches with a payout finish</small>
        </div>
        <div class="player-metric-card accent-pink">
          <span>Total Wins</span>
          <strong>${player.wins_total}</strong>
          <small>First-place finishes</small>
        </div>
        <div class="player-metric-card accent-green">
          <span>Total Won</span>
          <strong>${formatCurrency(player.total_amount)}</strong>
          <small>Amount collected</small>
        </div>
        <div class="player-metric-card accent-slate">
          <span>Washout / Canceled</span>
          <strong>${Number(player.washout_matches || 0)}</strong>
          <small>Refund-style result entries</small>
        </div>
      </div>
      <div class="player-breakdown">
        <div class="player-breakdown-card">
          <h4>Rank Distribution</h4>
          <div class="rank-distribution-list">${rankLines}</div>
        </div>
        <div class="player-breakdown-card">
          <h4>Quick Read</h4>
          <div class="player-tag-row">
            <span class="player-tag">Win rate: ${winRate}%</span>
            <span class="player-tag">Best finish: ${escapeHtml(getBestFinish(player))}</span>
            <span class="player-tag">Matches won: ${matchesWon}</span>
            <span class="player-tag">Washouts: ${Number(player.washout_matches || 0)}</span>
            <span class="player-tag">Money won: ${formatCurrency(player.total_amount)}</span>
          </div>
        </div>
      </div>
      <div class="player-breakdown-card">
        <h4>Match History</h4>
        <div class="history-list">${historyRows}</div>
      </div>
    </article>
  `;
}

async function init() {
  setupHeader();
  setupModal();
  const profile = await callApi('/api/auth/me');
  const user = profile.user;
  if (user.membership_status !== 'active') {
    window.location.replace('/welcome');
    return;
  }
  const effectiveRole = user.league_role === 'admin' ? 'admin' : 'viewer';
  localStorage.setItem('league-ledger-user-role', effectiveRole);
  localStorage.setItem('league-ledger-username', user.user_id);
  localStorage.setItem('league-ledger-full-name', user.full_name || user.user_id);
  authRole.textContent = `${user.full_name} • ${user.user_id} (${effectiveRole})`;
  stats = await callApi('/api/stats');
  renderOverview();
  renderEarnersModal();
  renderLeaderboardChart();
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
  showError(err);
});
