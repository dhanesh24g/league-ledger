import {
  callApi,
  clearAuthStorage,
  initThemeToggle,
  registerMobileSelectProxy,
  setActiveLeagueId,
  syncMobileSelectProxy,
  showError,
  updateHeaderLeagueContext,
} from '/static/workflow-common.js';
import { initNotifications } from '/static/notifications.js';

const topNav = document.getElementById('top-nav');
const authRole = document.getElementById('auth-role');
const logoutBtn = document.getElementById('logout-btn');
const leagueHero = document.getElementById('league-hero');
const leagueOverview = document.getElementById('league-overview');
const leaguePayouts = document.getElementById('league-payouts');
const playersList = document.getElementById('players-list');
const matchesList = document.getElementById('matches-list');

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function setupNav(user) {
  if (!topNav) return;
  const isAdmin = user.league_role === 'admin';

  const options = [
    { value: '/league-details', label: 'League Details' },
    { value: '/stats', label: 'Stats Dashboard' },
    ...(isAdmin ? [{ value: '/setup', label: 'League Workflow' }, { value: '/league-settings', label: 'League Settings' }] : []),
    { value: '/welcome', label: 'Home' },
  ];

  topNav.innerHTML = options
    .map((item) => `<option value="${item.value}">${item.label}</option>`)
    .join('');
  topNav.value = '/league-details';
  registerMobileSelectProxy(topNav, {
    variant: 'compact',
    placeholder: 'Navigate',
  });
  syncMobileSelectProxy(topNav);

  topNav.addEventListener('change', () => {
    window.location.href = topNav.value;
  });
}

function statusClass(status) {
  const value = String(status || '').toLowerCase();
  if (value === 'completed') return 'is-completed';
  if (value === 'canceled') return 'is-canceled';
  return 'is-pending';
}

function renderHero(league, playerCount, matchCount) {
  if (!leagueHero) return;
  if (!league) {
    leagueHero.innerHTML = '<p class="muted">League summary is currently unavailable.</p>';
    return;
  }

  const prizePool = Number(league.entry_fee || 0) * Number(league.active_player_count || 0);
  leagueHero.innerHTML = `
    <div class="league-details-hero-shell">
      <div class="league-details-hero-main">
        <span class="summary-chip-label">League Overview</span>
        <h2>${escapeHtml(league.name)}</h2>
        <p class="muted">${escapeHtml(league.sport || 'Cricket')} • ${escapeHtml(league.tournament || 'League')}</p>
        <div class="league-hero-chips">
          <span class="status-chip">Players: ${playerCount}</span>
          <span class="status-chip">Matches: ${matchCount}</span>
          <span class="status-chip">Prize Pool: ${prizePool.toFixed(2)}</span>
        </div>
      </div>
      <div class="league-details-hero-stats">
        <article class="league-details-stat-card">
          <span class="summary-chip-label">Entry Fee</span>
          <strong>${Number(league.entry_fee || 0).toFixed(2)}</strong>
          <small class="muted">Per player</small>
        </article>
        <article class="league-details-stat-card">
          <span class="summary-chip-label">Configured Players</span>
          <strong>${Number(league.active_player_count || 0)}</strong>
          <small class="muted">League roster</small>
        </article>
        <article class="league-details-stat-card">
          <span class="summary-chip-label">Winner Slots</span>
          <strong>${Number(league.default_winner_count || 0)}</strong>
          <small class="muted">Default places</small>
        </article>
      </div>
    </div>
  `;
}

function renderLeagueRules(league) {
  if (!league) {
    renderHero(null, 0, 0);
    leagueOverview.innerHTML = '<div class="feed-item">League data is not available yet.</div>';
    leaguePayouts.innerHTML = '';
    return;
  }

  leagueOverview.innerHTML = `
    <article class="settings-card">
      <span class="summary-chip-label">League Name</span>
      <strong>${escapeHtml(league.name)}</strong>
      <small class="muted">${escapeHtml(league.sport || 'Cricket')} • ${escapeHtml(league.tournament || 'League')}</small>
    </article>
    <article class="settings-card">
      <span class="summary-chip-label">Entry Fee</span>
      <strong>${Number(league.entry_fee || 0).toFixed(2)}</strong>
      <small class="muted">Per match, per participant</small>
    </article>
    <article class="settings-card">
      <span class="summary-chip-label">Configured Players</span>
      <strong>${Number(league.active_player_count || 0)}</strong>
      <small class="muted">Target active participants</small>
    </article>
    <article class="settings-card">
      <span class="summary-chip-label">Winner Slots</span>
      <strong>${Number(league.default_winner_count || 0)}</strong>
      <small class="muted">Default rank payouts</small>
    </article>
  `;

  const payoutEntries = Object.entries(league.payouts || {}).sort((a, b) => Number(a[0]) - Number(b[0]));
  const total = payoutEntries.reduce((sum, [, amount]) => sum + Number(amount || 0), 0) || 1;
  leaguePayouts.innerHTML = payoutEntries.length
    ? payoutEntries
      .map(([rank, amount]) => {
        const value = Number(amount || 0);
        const ratio = Math.max(6, Math.round((value / total) * 100));
        return `
          <article class="league-payout-card">
            <div class="league-payout-head">
              <strong>Rank ${escapeHtml(rank)}</strong>
              <span>${value.toFixed(2)}</span>
            </div>
            <div class="league-payout-bar-track">
              <div class="league-payout-bar" style="width:${ratio}%"></div>
            </div>
          </article>
        `;
      })
      .join('')
    : '<span class="muted small">No default payout configuration available.</span>';
}

function renderPlayers(members) {
  if (!Array.isArray(members) || !members.length) {
    playersList.innerHTML = '<div class="feed-item">No players found.</div>';
    return;
  }

  playersList.innerHTML = members
    .map((member) => {
      const fullName = `${String(member.first_name || '').trim()} ${String(member.last_name || '').trim()}`.trim();
      const displayName = fullName || String(member.user_id_label || '').trim();
      const roleLabel = String(member.role || '').toLowerCase() === 'admin' ? 'Admin' : 'Read';
      return `
      <article class="feed-item settings-member-item league-player-card compact-member-card">
        <span class="player-avatar">${escapeHtml(String(displayName || '').trim().charAt(0).toUpperCase() || 'P')}</span>
        <div class="compact-member-meta">
          <strong>${escapeHtml(displayName)}</strong>
          <p class="muted">@${escapeHtml(String(member.user_id_label || ''))} · ${escapeHtml(roleLabel)}</p>
        </div>
        <div class="settings-member-meta compact-member-role-actions">
          <span class="status-chip">${escapeHtml(roleLabel)}</span>
        </div>
      </article>
    `;
    })
    .join('');
}

function renderMatches(matches, statsMatches) {
  if (!Array.isArray(matches) || !matches.length) {
    matchesList.innerHTML = '<div class="feed-item">No matches created yet.</div>';
    return;
  }

  const statsById = new Map((statsMatches || []).map((match) => [String(match.match_id), match]));

  matchesList.innerHTML = matches
    .map((match) => {
      const matchId = String(match.id);
      const stat = statsById.get(matchId);
      const winners = Array.isArray(stat?.winners) ? stat.winners : [];
      const winnerSummary = winners.length
        ? winners.map((row) => {
          const names = (row.players || []).map((name) => escapeHtml(name)).join(', ');
          return `
            <li class="match-winner-line">
              <span class="winner-pill">Rank ${escapeHtml(String(row.rank))}</span>
              <span>${names}</span>
              <span class="muted">${Number(row.amount_each || 0).toFixed(2)} each</span>
            </li>
          `;
        }).join('')
        : '<li>No winners saved yet.</li>';

      const overrides = match.payouts && Object.keys(match.payouts).length
        ? Object.entries(match.payouts)
          .sort((a, b) => Number(a[0]) - Number(b[0]))
          .map(([rank, amount]) => `Rank ${escapeHtml(rank)}: ${Number(amount || 0).toFixed(2)}`)
          .join(' · ')
        : 'Default league payouts';

      return `
        <article class="feed-item match-card league-match-card">
          <div class="match-head">
            <strong>#${escapeHtml(String(match.match_number || stat?.match_number || 0))} • ${escapeHtml(match.title)}</strong>
            <span class="status-chip ${statusClass(match.status)}">${escapeHtml(String(match.status || 'pending').toUpperCase())}</span>
          </div>
          <div class="league-match-meta">
            <span class="muted small">Date: ${escapeHtml(match.match_date)}</span>
            <span class="muted small">Winner Slots: ${Number(match.winner_count || 0) || 'Default'}</span>
          </div>
          <p class="muted league-match-payouts">Payouts: ${escapeHtml(overrides)}</p>
          <ul class="muted small match-winner-list">${winnerSummary}</ul>
        </article>
      `;
    })
    .join('');
}

async function init() {
  initNotifications();
  initThemeToggle();

  const profile = await callApi('/api/auth/me');
  const user = profile.user;

  if (user.active_league_id) {
    setActiveLeagueId(user.active_league_id);
  }

  authRole.textContent = user.user_id;
  updateHeaderLeagueContext(user);
  setupNav(user);

  logoutBtn?.addEventListener('click', () => {
    clearAuthStorage();
    window.location.replace('/login');
  });

  const [state, stats, memberResult] = await Promise.all([
    callApi('/api/state'),
    callApi('/api/stats'),
    callApi('/api/league/members'),
  ]);

  const members = memberResult.members || [];

  renderHero(state.league, members.length, (state.matches || []).length);
  renderLeagueRules(state.league);
  renderPlayers(members);
  renderMatches(state.matches || [], stats.matches || []);
}

init().catch((error) => {
  console.error('League details initialization failed:', error);
  showError(error);
});
