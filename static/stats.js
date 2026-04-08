import {
  callApi,
  clearAuthStorage,
  ensureLeagueSwitcher,
  initThemeToggle,
  populateHeaderIdentity,
  refreshHeaderCommandMenu,
  setActiveLeagueId,
  showError,
  updateHeaderLeagueContext,
} from '/static/workflow-common.js';
import { initNotifications } from '/static/notifications.js';

const matchFilter = document.getElementById('match-filter');
const playerFilter = document.getElementById('player-filter');
const matchWinnersCard = document.getElementById('match-winners-card');
const playerStatsCard = document.getElementById('player-stats-card');
const statsOverview = document.getElementById('stats-overview');
const statsSummaryStrip = document.getElementById('stats-summary-strip');
const leaderboardChart = document.getElementById('leaderboard-chart');
const topNav = document.getElementById('top-nav');
const earnersModal = document.getElementById('earners-modal');
const earnersModalBody = document.getElementById('earners-modal-body');
const closeEarnersModalBtn = document.getElementById('close-earners-modal');
const ladderModal = document.getElementById('ladder-modal');
const ladderModalBody = document.getElementById('ladder-modal-body');
const closeLadderModalBtn = document.getElementById('close-ladder-modal');
const historyModal = document.getElementById('history-modal');
const historyModalBody = document.getElementById('history-modal-body');
const closeHistoryModalBtn = document.getElementById('close-history-modal');
const rankModal = document.getElementById('rank-modal');
const rankModalBody = document.getElementById('rank-modal-body');
const closeRankModalBtn = document.getElementById('close-rank-modal');
const mobileSelectModal = document.getElementById('mobile-select-modal');
const mobileSelectTitle = document.getElementById('mobile-select-title');
const mobileSelectSubtitle = document.getElementById('mobile-select-subtitle');
const mobileSelectOptions = document.getElementById('mobile-select-options');
const closeMobileSelectModalBtn = document.getElementById('close-mobile-select-modal');

let stats = {
  summary: {
    total_matches: 0,
    played_matches: 0,
    canceled_matches: 0,
    entry_fee: 0,
  },
  matches: [],
  players: [],
};
let currentUser = null;
let mobileSelectResizeBound = false;

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

function formatPercent(value) {
  return `${Math.round(Number(value || 0))}%`;
}

function getEligiblePayoutTone(value) {
  const amount = Number(value || 0);
  if (amount > 0) return 'positive';
  if (amount < 0) return 'negative';
  return 'neutral';
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

function isMobileStatsViewport() {
  return Boolean(window.matchMedia && window.matchMedia('(max-width: 760px)').matches);
}

function closeMobileSelect() {
  setModalState(mobileSelectModal, false);
}

function renderDesktopHeaderNav() {
  if (!topNav) return;
  document.querySelector('.header-content')?.classList.add('header-content-modern-nav');
  topNav.classList.add('header-select-source');

  let nav = document.querySelector(`.header-desktop-nav[data-select-id="${topNav.id}"]`);
  if (!nav) {
    nav = document.createElement('nav');
    nav.className = 'header-desktop-nav';
    nav.dataset.selectId = topNav.id;
    nav.setAttribute('aria-label', 'Primary navigation');
    topNav.parentElement?.insertBefore(nav, topNav.nextSibling);
  }

  nav.innerHTML = [...topNav.options].map((option) => {
    const active = String(option.value) === String(topNav.value);
    return `
      <button type="button" class="header-nav-pill${active ? ' is-active' : ''}" data-nav-value="${option.value}">
        ${escapeHtml(option.textContent || '')}
      </button>
    `;
  }).join('');

  nav.querySelectorAll('[data-nav-value]').forEach((button) => {
    button.addEventListener('click', () => {
      const nextValue = button.getAttribute('data-nav-value') || '';
      if (!nextValue || nextValue === topNav.value) return;
      topNav.value = nextValue;
      topNav.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
}

function ensureMobileSelectProxy(select, config = {}) {
  if (!select) return null;

  let shell = select.closest(`.stats-mobile-select-shell[data-select-id="${select.id}"]`);
  if (!shell) {
    shell = document.createElement('div');
    shell.className = 'stats-mobile-select-shell';
    shell.dataset.selectId = select.id;
    select.insertAdjacentElement('afterend', shell);
    shell.appendChild(select);
  }

  let proxy = shell.querySelector(`.stats-mobile-select-proxy[data-select-id="${select.id}"]`);
  if (!proxy) {
    proxy = document.createElement('button');
    proxy.type = 'button';
    proxy.className = 'stats-mobile-select-proxy hidden';
    proxy.dataset.selectId = select.id;
    proxy.innerHTML = `
      <span class="stats-mobile-select-proxy-copy"></span>
      <span class="stats-mobile-select-proxy-icon" aria-hidden="true">⌄</span>
    `;
    shell.appendChild(proxy);
  }

  const syncProxy = () => {
    const selectedOption = select.options[select.selectedIndex];
    const label = selectedOption?.textContent?.trim() || config.placeholder || 'Choose an option';
    const copy = proxy.querySelector('.stats-mobile-select-proxy-copy');
    if (copy) copy.textContent = label;
    proxy.disabled = Boolean(select.disabled);
  };

  if (!proxy.dataset.bound) {
    proxy.addEventListener('click', () => {
      if (!mobileSelectModal || !mobileSelectOptions) return;
      mobileSelectTitle.textContent = config.title || 'Choose an option';
      mobileSelectSubtitle.textContent = config.subtitle || 'Pick the item you want to view.';
      mobileSelectOptions.innerHTML = [...select.options].map((option) => {
        const isActive = String(option.value) === String(select.value);
        return `
          <button type="button" class="stats-mobile-select-option${isActive ? ' is-active' : ''}" data-mobile-select-value="${escapeHtml(option.value)}" data-mobile-select-id="${select.id}">
            <span>${escapeHtml(option.textContent || '')}</span>
          </button>
        `;
      }).join('') || '<div class="feed-item">No options available.</div>';

      mobileSelectOptions.querySelectorAll(`[data-mobile-select-id="${select.id}"]`).forEach((button) => {
        button.addEventListener('click', () => {
          const nextValue = button.getAttribute('data-mobile-select-value') || '';
          select.value = nextValue;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          closeMobileSelect();
        });
      });

      setModalState(mobileSelectModal, true);
    });
    proxy.dataset.bound = 'true';
  }

  if (!select.dataset.proxyBound) {
    select.addEventListener('change', syncProxy);
    select.dataset.proxyBound = 'true';
  }

  syncProxy();
  return proxy;
}

function syncMobileSelectVisibility() {
  const mobile = isMobileStatsViewport();
  [topNav, matchFilter, playerFilter].forEach((select) => {
    if (!select) return;
    const shell = select.closest(`.stats-mobile-select-shell[data-select-id="${select.id}"]`);
    const proxy = shell?.querySelector(`.stats-mobile-select-proxy[data-select-id="${select.id}"]`);
    select.classList.toggle('stats-mobile-select-source', mobile);
    shell?.classList.toggle('stats-mobile-select-shell-active', mobile);
    proxy?.classList.toggle('hidden', !mobile);
  });
}

function polarToCartesian(centerX, centerY, radius, angleInDegrees) {
  const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180.0;
  return {
    x: centerX + (radius * Math.cos(angleInRadians)),
    y: centerY + (radius * Math.sin(angleInRadians)),
  };
}

function describeArc(centerX, centerY, radius, startAngle, endAngle) {
  const start = polarToCartesian(centerX, centerY, radius, endAngle);
  const end = polarToCartesian(centerX, centerY, radius, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';

  return [
    'M', centerX, centerY,
    'L', start.x, start.y,
    'A', radius, radius, 0, largeArcFlag, 0, end.x, end.y,
    'Z',
  ].join(' ');
}

function setModalState(modal, isOpen) {
  if (!modal) return;
  modal.classList.toggle('hidden', !isOpen);
  modal.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
  const anyModalOpen = [earnersModal, ladderModal, historyModal, rankModal, mobileSelectModal].some((node) => node && !node.classList.contains('hidden'));
  document.body.classList.toggle('modal-open', anyModalOpen);
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

function findCurrentPlayer() {
  if (!currentUser || !Array.isArray(stats.players) || !stats.players.length) return null;

  const candidates = [
    String(currentUser.full_name || '').trim(),
    String(currentUser.user_id || '').trim(),
  ].filter(Boolean).map((value) => value.toLowerCase());

  return stats.players.find((player) => {
    const playerName = String(player.name || '').trim().toLowerCase();
    return candidates.includes(playerName);
  }) || null;
}

function createSliceColor(index, total) {
  // Enterprise-grade color palette - professional, accessible, harmonious
  const colors = [
    { h: 210, s: 85, l: 55 }, // Professional Blue
    { h: 160, s: 75, l: 45 }, // Emerald Green  
    { h: 280, s: 70, l: 60 }, // Soft Purple
    { h: 35, s: 90, l: 55 },  // Amber/Gold
    { h: 190, s: 80, l: 50 }, // Cyan/Teal
    { h: 340, s: 75, l: 55 }, // Rose/Coral
    { h: 45, s: 85, l: 50 },  // Orange
    { h: 260, s: 65, l: 55 }, // Indigo
  ];
  const color = colors[index % colors.length];
  return `hsl(${color.h} ${color.s}% ${color.l}%)`;
}

function buildPayoutShares(players) {
  const positivePlayers = (players || [])
    .map((player) => ({
      ...player,
      total_amount: Number(player.total_amount || 0),
    }))
    .filter((player) => player.total_amount > 0)
    .sort((a, b) => (b.total_amount - a.total_amount) || a.name.localeCompare(b.name));

  const totalAmount = positivePlayers.reduce((sum, player) => sum + player.total_amount, 0);

  return {
    totalAmount,
    shares: positivePlayers.map((player, index) => ({
      ...player,
      color: createSliceColor(index, positivePlayers.length),
      percentage: totalAmount ? (player.total_amount / totalAmount) * 100 : 0,
    })),
  };
}

function renderPieChart(shares, options = {}) {
  const size = Number(options.size || 220);
  const radius = Number(options.radius || Math.round(size * 0.41));
  const center = size / 2;
  const innerRadius = Number(options.innerRadius || Math.round(radius * 0.56));
  const label = escapeHtml(options.label || 'Payout share');
  const totalLabel = escapeHtml(options.centerValue || formatCurrency(options.totalAmount || 0));
  const subLabel = options.centerSubValue ? escapeHtml(options.centerSubValue) : '';
  const interactive = options.interactive ? 'true' : 'false';

  if (!shares.length) {
    return `
      <div class="pie-chart-empty" aria-label="No payout data available">
        <div>
          <strong>No payout data</strong>
          <p class="muted">Results will populate this chart once earnings are recorded.</p>
        </div>
      </div>
    `;
  }

  let cursor = 0;
  const slices = shares.map((share) => {
    if (share.percentage >= 99.999) {
      return `
        <circle cx="${center}" cy="${center}" r="${radius}" fill="${share.color}" class="pie-slice" data-slice-index="${share.player_id}" data-interactive="${interactive}" tabindex="${options.interactive ? '0' : '-1'}" role="${options.interactive ? 'button' : 'presentation'}" aria-label="${escapeHtml(share.name)} ${formatCurrency(share.total_amount)}">
          <title>${escapeHtml(share.name)} • ${formatCurrency(share.total_amount)}</title>
        </circle>
      `;
    }
    const startAngle = cursor;
    const sliceAngle = (share.percentage / 100) * 360;
    const endAngle = cursor + sliceAngle;
    cursor = endAngle;
    return `
      <path d="${describeArc(center, center, radius, startAngle, endAngle)}" fill="${share.color}" class="pie-slice" data-slice-index="${share.player_id}" data-interactive="${interactive}" tabindex="${options.interactive ? '0' : '-1'}" role="${options.interactive ? 'button' : 'presentation'}" aria-label="${escapeHtml(share.name)} ${formatCurrency(share.total_amount)}">
        <title>${escapeHtml(share.name)} • ${formatCurrency(share.total_amount)}</title>
      </path>
    `;
  }).join('');

  return `
    <svg class="pie-chart-svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="${label}">
      ${slices}
      <circle cx="${center}" cy="${center}" r="${innerRadius}" class="pie-chart-core"></circle>
      <text x="50%" y="47%" text-anchor="middle" class="pie-chart-center-label">${label}</text>
      <text x="50%" y="${subLabel ? '55%' : '57%'}" text-anchor="middle" class="pie-chart-center-value">${totalLabel}</text>
      ${subLabel ? `<text x="50%" y="63%" text-anchor="middle" class="pie-chart-center-subvalue">${subLabel}</text>` : ''}
    </svg>
  `;
}

function renderLadderSliceDetails(share) {
  if (!share) {
    return `
      <div class="pie-slice-detail-empty">
        <strong>Select a slice</strong>
        <p class="muted">Tap or click any slice to inspect that player's payout share.</p>
      </div>
    `;
  }

  const entryFee = Number(stats.summary?.entry_fee || 0);
  const eligiblePayout = Number(share.total_amount || 0) - (Number(share.matches_played || 0) * entryFee);
  const eligiblePayoutTone = getEligiblePayoutTone(eligiblePayout);

  return `
    <div class="pie-slice-detail-card">
      <div class="pie-slice-detail-head">
        <span class="pie-legend-chip" style="--slice-color:${share.color};"></span>
        <div>
          <strong>${escapeHtml(share.name)}</strong>
          <p class="muted">${formatPercent(share.percentage)} of the total payout pool</p>
        </div>
      </div>
      <div class="pie-slice-detail-grid">
        <div class="stats-current-user-metric">
          <span>Payout Won</span>
          <strong>${formatCurrency(share.total_amount)}</strong>
        </div>
        <div class="stats-current-user-metric stats-current-user-metric-payout stats-current-user-metric-payout-${eligiblePayoutTone}">
          <span>Eligible Payout</span>
          <strong>${formatCurrency(eligiblePayout)}</strong>
        </div>
        <div class="stats-current-user-metric">
          <span>Matches Played</span>
          <strong>${Number(share.matches_played || 0)}</strong>
        </div>
        <div class="stats-current-user-metric">
          <span>Winning Matches</span>
          <strong>${Number(share.matches_won || 0)}</strong>
        </div>
        <div class="stats-current-user-metric">
          <span>Total Wins</span>
          <strong>${Number(share.wins_total || 0)}</strong>
        </div>
      </div>
    </div>
  `;
}

function bindInteractivePie(container, shares, onSelect) {
  if (!container || !shares.length || typeof onSelect !== 'function') return;

  const selectShare = (playerId) => {
    const activeId = String(playerId);
    container.querySelectorAll('.pie-slice').forEach((slice) => {
      slice.classList.toggle('is-active', String(slice.dataset.sliceIndex || '') === activeId);
    });
    const matched = shares.find((share) => String(share.player_id) === activeId) || shares[0];
    onSelect(matched);
  };

  container.querySelectorAll('.pie-slice[data-interactive="true"]').forEach((slice) => {
    slice.addEventListener('click', () => selectShare(slice.dataset.sliceIndex || ''));
    slice.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectShare(slice.dataset.sliceIndex || '');
      }
    });
  });

  selectShare(String(shares[0].player_id));
}

function renderMetricStack(metrics) {
  return metrics.map((metric) => `
    <div class="player-metric-row ${escapeHtml(metric.accent || '')} ${metric.featured ? 'player-metric-row-featured' : ''} ${escapeHtml(metric.toneClass || '')}">
      <div>
        <span>${escapeHtml(metric.label)}</span>
        <small>${escapeHtml(metric.helper || '')}</small>
      </div>
      <strong>${escapeHtml(metric.value)}</strong>
    </div>
  `).join('');
}

function openEarnersModal() {
  setModalState(earnersModal, true);
}

function closeEarnersModal() {
  setModalState(earnersModal, false);
}

function openLadderModal() {
  setModalState(ladderModal, true);
}

function closeLadderModal() {
  setModalState(ladderModal, false);
}

function openHistoryModal() {
  setModalState(historyModal, true);
}

function closeHistoryModal() {
  setModalState(historyModal, false);
}

function openRankModal() {
  setModalState(rankModal, true);
}

function closeRankModal() {
  setModalState(rankModal, false);
}

function buildRankDistributionRows(rankCounts, maxCount) {
  return Object.keys(rankCounts || {})
    .sort((a, b) => Number(a) - Number(b))
    .map((rank) => {
      const rankNumber = Number(rank);
      const visual = getRankVisual(rankNumber);
      const count = Number(rankCounts[rank]);
      return `
        <div class="rank-distribution-row">
          <span class="rank-distribution-label">${visual.icon} ${escapeHtml(visual.label)}</span>
          <div class="rank-distribution-bar">
            <span class="rank-distribution-fill" style="width: ${barWidth(count, maxCount)};"></span>
          </div>
          <strong>${count}</strong>
        </div>
      `;
    });
}

function renderRankDistributionColumns(rows, columnCount) {
  if (!rows.length) {
    return '<p class="muted">No rank placements yet.</p>';
  }

  const safeColumnCount = Math.max(1, Number(columnCount || 1));
  const rowsPerColumn = Math.ceil(rows.length / safeColumnCount);
  const columns = [];
  for (let i = 0; i < safeColumnCount; i += 1) {
    const start = i * rowsPerColumn;
    const columnRows = rows.slice(start, start + rowsPerColumn);
    if (columnRows.length) {
      columns.push(`<div class="rank-distribution-column">${columnRows.join('')}</div>`);
    }
  }
  return columns.join('');
}

function renderRankModal(player, rankRows) {
  if (!rankModalBody) return;

  rankModalBody.innerHTML = `
    <div class="zoom-board">
      <article class="zoom-board-row">
        <div class="zoom-board-head">
          <div class="chart-player-avatar">${escapeHtml(getInitials(player?.name || 'LL'))}</div>
          <div>
            <strong>${escapeHtml(player?.name || 'Selected player')}</strong>
            <p class="muted">Every finishing position recorded in this league.</p>
          </div>
        </div>
      </article>
      <div class="player-breakdown-card player-breakdown-card-compact rank-distribution-modal-card">
        <div class="rank-distribution-list rank-distribution-list-columns rank-distribution-list-modal">
          ${renderRankDistributionColumns(rankRows, rankRows.length > 6 ? 2 : 1)}
        </div>
      </div>
    </div>
  `;
}

function renderEarnersModal() {
  if (!earnersModalBody) return;

  if (!stats.players.length) {
    earnersModalBody.innerHTML = '<div class="feed-item">No earnings data yet.</div>';
    return;
  }

  const { entry_fee } = stats.summary || {};
  const entryFee = Number(entry_fee || 0);

  const topEarners = [...stats.players]
    .sort((a, b) => (b.total_amount - a.total_amount) || (b.wins_total - a.wins_total) || a.name.localeCompare(b.name));

  earnersModalBody.innerHTML = `
    <div class="earners-compact-list">
      ${(() => {
      const rows = [];
      for (let i = 0; i < topEarners.length; i += 2) {
        const player1 = topEarners[i];
        const player2 = topEarners[i + 1];
        const idx1 = i;
        const idx2 = i + 1;

        const amountWon1 = Number(player1.total_amount || 0);
        const eligiblePayout1 = amountWon1 - (Number(player1.matches_played || 0) * entryFee);

        let player2Html = '';
        if (player2) {
          const amountWon2 = Number(player2.total_amount || 0);
          const eligiblePayout2 = amountWon2 - (Number(player2.matches_played || 0) * entryFee);
          const eligiblePayoutTone2 = getEligiblePayoutTone(eligiblePayout2);
          player2Html = `
              <div class="earner-compact-cell">
                <span class="earner-rank">${TROPHIES[idx2] || `#${idx2 + 1}`}</span>
                <div class="earner-info">
                  <span class="earner-name">${escapeHtml(player2.name)}</span>
                  <span class="earner-meta">${player2.matches_played} played · ${player2.wins_total} titles</span>
                </div>
                <div class="earner-amounts">
                  <div class="earner-amount-item">
                    <span class="earner-amount-label">Amount Won</span>
                    <span class="earner-amount-won">${formatCurrency(amountWon2)}</span>
                  </div>
                  <div class="earner-amount-item earner-payout-highlight earner-payout-highlight-${eligiblePayoutTone2}">
                    <span class="earner-amount-label">Eligible Payout</span>
                    <span class="earner-payout earner-payout-${eligiblePayoutTone2}">${formatCurrency(eligiblePayout2)}</span>
                  </div>
                </div>
              </div>
            `;
        }

        const eligiblePayoutTone1 = getEligiblePayoutTone(eligiblePayout1);

        rows.push(`
            <div class="earner-compact-row earner-compact-row-pair">
              <div class="earner-compact-cell">
                <span class="earner-rank">${TROPHIES[idx1] || `#${idx1 + 1}`}</span>
                <div class="earner-info">
                  <span class="earner-name">${escapeHtml(player1.name)}</span>
                  <span class="earner-meta">${player1.matches_played} played · ${player1.wins_total} titles</span>
                </div>
                <div class="earner-amounts">
                  <div class="earner-amount-item">
                    <span class="earner-amount-label">Amount Won</span>
                    <span class="earner-amount-won">${formatCurrency(amountWon1)}</span>
                  </div>
                  <div class="earner-amount-item earner-payout-highlight earner-payout-highlight-${eligiblePayoutTone1}">
                    <span class="earner-amount-label">Eligible Payout</span>
                    <span class="earner-payout earner-payout-${eligiblePayoutTone1}">${formatCurrency(eligiblePayout1)}</span>
                  </div>
                </div>
              </div>
              ${player2Html}
            </div>
          `);
      }
      return rows.join('');
    })()}
    </div>
  `;
}

function renderLadderModal() {
  if (!ladderModalBody) return;
  const { shares, totalAmount } = buildPayoutShares(stats.players);
  const entryFee = Number(stats.summary?.entry_fee || 0);
  const currentPlayer = findCurrentPlayer();
  const currentEligiblePayout = currentPlayer
    ? Number(currentPlayer.total_amount || 0) - (Number(currentPlayer.matches_played || 0) * entryFee)
    : totalAmount;
  const currentWinRate = currentPlayer && Number(currentPlayer.matches_played || 0) > 0
    ? formatPercent((Number(currentPlayer.matches_won || 0) / Number(currentPlayer.matches_played || 0)) * 100)
    : `${shares.length} earners`;

  ladderModalBody.innerHTML = `
    <div class="ladder-modal-layout">
      <div class="pie-chart-shell pie-chart-shell-large">
        ${renderPieChart(shares, {
          size: 380,
          radius: 142,
          innerRadius: 78,
          label: currentPlayer ? 'Your Payout' : 'Top Earners',
          centerValue: formatCurrency(currentEligiblePayout),
          centerSubValue: currentPlayer ? `Win rate ${currentWinRate}` : currentWinRate,
          totalAmount,
          interactive: true,
        })}
      </div>
      <div class="pie-detail-panel">
        <div id="ladder-slice-detail" class="pie-slice-detail-shell"></div>
        <div class="zoom-board pie-detail-list">
          ${shares.length ? shares.map((share) => {
            const eligiblePayout = Number(share.total_amount || 0) - (Number(share.matches_played || 0) * entryFee);
            const payoutTone = getEligiblePayoutTone(eligiblePayout);
            return `
            <button type="button" class="zoom-board-row pie-detail-row pie-detail-button pie-detail-button-${payoutTone}" data-slice-trigger="${share.player_id}">
              <div class="pie-legend-chip" style="--slice-color:${share.color};"></div>
              <div>
                <strong>${escapeHtml(share.name)}</strong>
                <p class="muted">${share.matches_played} played • ${share.wins_total} titles • Eligible <span class="pie-detail-payout pie-detail-payout-${payoutTone}">${formatCurrency(eligiblePayout)}</span></p>
              </div>
              <div class="pie-detail-meta">
                <strong>${formatCurrency(share.total_amount)}</strong>
                <span>${formatPercent(share.percentage)}</span>
              </div>
            </button>
          `;
          }).join('') : '<div class="feed-item">No payout data available yet.</div>'}
        </div>
      </div>
    </div>
  `;

  const detailTarget = ladderModalBody.querySelector('#ladder-slice-detail');
  bindInteractivePie(ladderModalBody, shares, (share) => {
    if (detailTarget) {
      detailTarget.innerHTML = renderLadderSliceDetails(share);
      if (isMobileStatsViewport()) {
        window.requestAnimationFrame(() => {
          detailTarget.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      }
    }
    ladderModalBody.querySelectorAll('[data-slice-trigger]').forEach((button) => {
      button.classList.toggle('is-active', String(button.getAttribute('data-slice-trigger')) === String(share.player_id));
    });
  });

  ladderModalBody.querySelectorAll('[data-slice-trigger]').forEach((button) => {
    button.addEventListener('click', () => {
      const targetId = String(button.getAttribute('data-slice-trigger') || '');
      ladderModalBody.querySelector(`.pie-slice[data-slice-index="${targetId}"]`)?.dispatchEvent(new Event('click'));
    });
  });
}

function renderHistoryModal(player) {
  if (!historyModalBody) return;
  const sortedHistory = [...(player?.match_history || [])]
    .sort((a, b) => String(b.match_date || '').localeCompare(String(a.match_date || '')));

  historyModalBody.innerHTML = `
    <div class="zoom-board">
      <article class="zoom-board-row">
        <div class="zoom-board-head">
          <div class="chart-player-avatar">${escapeHtml(getInitials(player?.name || 'LL'))}</div>
          <div>
            <strong>${escapeHtml(player?.name || 'Selected player')}</strong>
            <p class="muted">Full result timeline for this player, newest first.</p>
          </div>
        </div>
      </article>
      ${sortedHistory.length ? sortedHistory.map((entry) => `
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
      `).join('') : '<div class="feed-item">No match history yet.</div>'}
    </div>
  `;
}

function renderOverview() {
  const { total_matches, played_matches, canceled_matches, entry_fee } = stats.summary || {};

  if (!stats.players.length) {
    statsSummaryStrip.innerHTML = `
      <div class="summary-chip stats-kpi-card">
        <span class="summary-chip-label">Total Matches</span>
        <strong>${Number(total_matches || 0)}</strong>
      </div>
      <div class="summary-chip stats-kpi-card">
        <span class="summary-chip-label">Matches Played</span>
        <strong>${Number(played_matches || 0)}</strong>
      </div>
      <div class="summary-chip stats-kpi-card">
        <span class="summary-chip-label">Washout / Canceled</span>
        <strong>${Number(canceled_matches || 0)}</strong>
      </div>
    `;
    statsOverview.innerHTML = '<div class="feed-item">No stats yet. Add results to light this dashboard up.</div>';
    return;
  }

  const topWinsValue = Math.max(...stats.players.map((player) => Number(player.wins_total || 0)), 0);
  const topWinnerNames = [...stats.players]
    .filter((player) => Number(player.wins_total || 0) === topWinsValue)
    .sort((a, b) => a.name.localeCompare(b.name));
  const topEarnerValue = Math.max(...stats.players.map((player) => Number(player.total_amount || 0)), 0);
  const topEarnerNames = [...stats.players]
    .filter((player) => Number(player.total_amount || 0) === topEarnerValue)
    .sort((a, b) => a.name.localeCompare(b.name));
  const topEarners = [...stats.players]
    .sort((a, b) => (b.total_amount - a.total_amount) || a.name.localeCompare(b.name))
    .slice(0, 3);

  const topWinnerRows = topWinnerNames.map((player) => `
    <div class="stats-leader-row">
      <strong>${escapeHtml(player.name)}</strong>
      <span>${Number(player.wins_total || 0)}</span>
    </div>
  `).join('');

  const topEarnerRows = topEarners.map((player, index) => `
    <div class="top-earner-row">
      <span class="top-earner-rank">${TROPHIES[index] || `#${index + 1}`}</span>
      <strong>${escapeHtml(player.name)}</strong>
      <span class="top-earner-amount">${formatCurrency(player.total_amount)}</span>
    </div>
  `).join('');

  const currentPlayer = findCurrentPlayer();
  const matchesYouPlayed = currentPlayer ? Number(currentPlayer.matches_played || 0) : Number(played_matches || 0);
  const eligiblePayoutAmount = currentPlayer
    ? Number(currentPlayer.total_amount || 0) - (Number(currentPlayer.matches_played || 0) * Number(entry_fee || 0))
    : 0;
  const eligiblePayoutTone = eligiblePayoutAmount > 0 ? 'positive' : eligiblePayoutAmount < 0 ? 'negative' : 'neutral';

  statsSummaryStrip.innerHTML = `
    <div class="summary-chip stats-kpi-card stats-kpi-card-payout stats-kpi-card-payout-${eligiblePayoutTone}">
      <span class="summary-chip-label">Eligible Payout</span>
      <strong>${formatCurrency(eligiblePayoutAmount)}</strong>
    </div>
    <div class="summary-chip stats-kpi-card">
      <span class="summary-chip-label">Total Matches</span>
      <strong>${Number(total_matches || 0)}</strong>
    </div>
    <div class="summary-chip stats-kpi-card">
      <span class="summary-chip-label">Matches You Played</span>
      <strong>${matchesYouPlayed}</strong>
    </div>
    <div class="summary-chip stats-kpi-card">
      <span class="summary-chip-label">Washout / Canceled</span>
      <strong>${Number(canceled_matches || 0)}</strong>
    </div>
  `;

  statsOverview.innerHTML = `
    <div class="stats-overview-column stats-overview-column-middle">
      <article class="spotlight-card winner stats-feature-card">
        <span class="spotlight-label">Most Wins</span>
        <div class="stats-leader-list">${topWinnerRows}</div>
        <p>First-place finishes collected so far.</p>
      </article>
    </div>
    <article id="top-earners-card" class="stats-page spotlight-card leaders stats-right-card" style="cursor: pointer; transition: transform 0.15s ease, box-shadow 0.15s ease;">
      <span class="spotlight-label">Top 3 Earners</span>
      <div class="top-earner-list">${topEarnerRows}</div>
      <div class="spotlight-card-actions">
        <p>Open a richer view of the winnings table with all players ranked together.</p>
        <button id="open-earners-modal" type="button" class="ghost stats-action-button">Click For Deep Dive</button>
      </div>
    </article>
	    <article class="spotlight-card stats-current-user-card">
	      <span class="spotlight-label">Your League Snapshot</span>
	      ${currentPlayer ? `
	        <div class="stats-current-user-head">
	          <div class="chart-player-avatar">${escapeHtml(getInitials(currentPlayer.name))}</div>
	          <div>
	            <strong>${escapeHtml(currentPlayer.name)}</strong>
	          </div>
	        </div>
	        <div class="stats-current-user-grid">
	          <div class="stats-current-user-metric"><span>Played</span><strong>${Number(currentPlayer.matches_played || 0)}</strong></div>
	          <div class="stats-current-user-metric"><span>Winning Matches</span><strong>${Number(currentPlayer.matches_won || 0)}</strong></div>
	          <div class="stats-current-user-metric"><span>Best</span><strong>${escapeHtml(getBestFinish(currentPlayer))}</strong></div>
	          <div class="stats-current-user-metric"><span>Total Won</span><strong>${formatCurrency(currentPlayer.total_amount)}</strong></div>
	          <div class="stats-current-user-metric stats-current-user-metric-wide stats-current-user-metric-wide-${eligiblePayoutTone}"><span>Eligible Payout</span><strong>${formatCurrency(eligiblePayoutAmount)}</strong></div>
	        </div>
	      ` : `
	        <div class="stats-current-user-empty">
          <strong>Your League Snapshot</strong>
          <p class="muted">We will show your compact player overview here once your stats are available in the league table.</p>
        </div>
      `}
    </article>
  `;

  document.getElementById('open-earners-modal')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openEarnersModal();
  });
  document.getElementById('top-earners-card')?.addEventListener('click', openEarnersModal);
}

function renderLeaderboardChart() {
  if (!stats.players.length) {
    leaderboardChart.innerHTML = '<div class="feed-item">Player comparisons will appear here once results are saved.</div>';
    return;
  }

  const { shares, totalAmount } = buildPayoutShares(stats.players);
  const currentPlayer = findCurrentPlayer();
  const entryFee = Number(stats.summary?.entry_fee || 0);
  const currentEligiblePayout = currentPlayer
    ? Number(currentPlayer.total_amount || 0) - (Number(currentPlayer.matches_played || 0) * entryFee)
    : totalAmount;
  const currentWinRate = currentPlayer && Number(currentPlayer.matches_played || 0) > 0
    ? formatPercent((Number(currentPlayer.matches_won || 0) / Number(currentPlayer.matches_played || 0)) * 100)
    : `${shares.length} earners`;

  leaderboardChart.innerHTML = `
    <button id="open-ladder-modal" type="button" class="pie-chart-button pie-chart-button-block ladder-chart-trigger" aria-label="Open league ladder deep dive">
      <div class="pie-chart-shell pie-chart-shell-plain">
        ${renderPieChart(shares, {
          size: 420,
          radius: 160,
          innerRadius: 88,
          label: currentPlayer ? 'Your Payout' : 'Top Earners',
          centerValue: formatCurrency(currentEligiblePayout),
          centerSubValue: currentPlayer ? `Win rate ${currentWinRate}` : currentWinRate,
          totalAmount,
        })}
      </div>
    </button>
  `;

  renderLadderModal();
  document.getElementById('open-ladder-modal')?.addEventListener('click', openLadderModal);
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
    option.textContent = `Match #${Number(match.match_number || 0)} · ${match.title} (${match.match_date})`;
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
    matchWinnersCard.innerHTML = `<div class="feed-item"><strong>Match #${Number(match.match_number || 0)} · ${match.title}</strong><br>No winners saved for this match yet.</div>`;
    return;
  }

  const totalDistributed = match.winners.reduce((sum, row) => sum + (row.amount_each * row.players.length), 0);
  const champions = match.winners.find((row) => Number(row.rank) === 1)?.players || [];
  const winningEntries = match.winners
    .filter((row) => Number(row.rank) > 0)
    .reduce((sum, row) => sum + row.players.length, 0);
  const washoutEntries = match.winners
    .filter((row) => Number(row.rank) === 0)
    .reduce((sum, row) => sum + row.players.length, 0);
  const championPills = champions.length
    ? champions.map((name) => `<span class="winner-pill">${escapeHtml(name)}</span>`).join('')
    : '<span class="winner-pill subdued">Not decided</span>';

  const winnerRows = match.winners.map((row) => {
    const visual = getRankVisual(Number(row.rank));
    const players = row.players.map((player) => `<span class="winner-pill">${escapeHtml(player)}</span>`).join('');
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
  }).join('');

  matchWinnersCard.innerHTML = `
    <article class="match-spotlight">
      <div class="match-spotlight-layout">
        <div class="match-spotlight-main">
          <div class="match-spotlight-head">
            <div>
              <span class="match-kicker">Match #${Number(match.match_number || 0)}</span>
              <h3>${escapeHtml(match.title)}</h3>
            </div>
            <div class="match-spotlight-meta">
              <span class="status-chip">${escapeHtml(match.status)}</span>
              <span class="status-chip">${escapeHtml(match.match_date)}</span>
              <span class="status-chip">${match.participant_count || 0} players</span>
              <span class="status-chip">Settled ${formatCurrency(totalDistributed)}</span>
            </div>
          </div>
          <div class="match-summary-strip">
            <div class="match-summary-card"><span>Champion Slots</span><strong>${champions.length || 0}</strong></div>
            <div class="match-summary-card"><span>Winning Entries</span><strong>${winningEntries}</strong></div>
            <div class="match-summary-card"><span>Refund / Washout</span><strong>${washoutEntries}</strong></div>
          </div>
        </div>
        <div class="winner-rank-grid winner-rank-grid-compact">${winnerRows}</div>
      </div>
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
  const rankRows = buildRankDistributionRows(player.rank_counts || {}, maxCount);
  const useRankColumns = rankRows.length > 6;
  const visibleRankRows = useRankColumns ? rankRows.slice(0, 6) : rankRows;
  const rankLines = visibleRankRows.length
    ? renderRankDistributionColumns(visibleRankRows, useRankColumns ? 2 : 1)
    : '<p class="muted">No rank placements yet.</p>';

  const history = [...(player.match_history || [])]
    .sort((a, b) => String(b.match_date || '').localeCompare(String(a.match_date || '')));
  const recentHistory = history.slice(0, 2);
  const hasMoreHistory = history.length > 2;
  const historyRows = recentHistory.map((entry) => `
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
  `).join('') || '<p class="muted">No match history yet.</p>';

  const matchesPlayed = Number(player.matches_played || 0);
  const matchesWon = Number(player.matches_won || 0);
  const winRate = matchesPlayed ? Math.round((matchesWon / matchesPlayed) * 100) : 0;
  const entryFee = Number(stats.summary?.entry_fee || 0);
  const eligiblePayout = Number(player.total_amount || 0) - (matchesPlayed * entryFee);
  const eligiblePayoutToneClass = eligiblePayout > 0
    ? 'player-metric-row-featured-positive'
    : eligiblePayout < 0
      ? 'player-metric-row-featured-negative'
      : 'player-metric-row-featured-neutral';
  const metricStack = renderMetricStack([
    { label: 'Played', value: String(matchesPlayed), helper: 'League matches joined', accent: 'accent-cyan' },
    { label: 'Wins', value: String(player.wins_total), helper: 'First-place finishes', accent: 'accent-pink' },
    { label: 'Winning Matches', value: String(matchesWon), helper: 'Paid finishes', accent: 'accent-gold' },
    { label: 'Total Won', value: formatCurrency(player.total_amount), helper: 'Amount collected', accent: 'accent-green' },
    { label: 'Eligible Payout', value: formatCurrency(eligiblePayout), helper: 'Won minus entry fees', accent: 'accent-amber', featured: true, toneClass: eligiblePayoutToneClass },
    { label: 'Washouts', value: String(Number(player.washout_matches || 0)), helper: 'Refund-style results', accent: 'accent-slate' },
  ]);

  playerStatsCard.innerHTML = `
    <article class="player-spotlight">
	      <div class="player-compact-layout">
	        <div class="player-compact-main">
	          <div class="player-hero">
	            <div class="player-avatar">${escapeHtml(getInitials(player.name))}</div>
	            <div class="player-hero-copy">
	              <h3>${escapeHtml(player.name)}</h3>
	              <p class="muted">Compact read of results, winnings, and recent form.</p>
	            </div>
	          </div>
	          <div class="player-metric-stack">${metricStack}</div>
	          <div class="player-breakdown-card player-breakdown-card-compact">
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
        <div class="player-compact-side">
          <div class="player-breakdown-card player-breakdown-card-compact">
            <div class="player-history-head">
              <h4>Rank Distribution</h4>
              ${rankRows.length > 6 ? '<button id="open-rank-modal" type="button" class="ghost stats-action-button">View Full Distribution</button>' : ''}
            </div>
            <div class="rank-distribution-list ${useRankColumns ? 'rank-distribution-list-columns' : ''}">${rankLines}</div>
          </div>
          <div class="player-breakdown-card player-breakdown-card-compact">
            <div class="player-history-head">
              <h4>Latest 2 Matches</h4>
              ${hasMoreHistory ? '<button id="open-history-modal" type="button" class="ghost stats-action-button">View All Matches</button>' : ''}
            </div>
            <div class="history-list">${historyRows}</div>
          </div>
        </div>
      </div>
    </article>
  `;

  if (hasMoreHistory) {
    renderHistoryModal(player);
    document.getElementById('open-history-modal')?.addEventListener('click', openHistoryModal);
  }

  if (rankRows.length > 6) {
    renderRankModal(player, rankRows);
    document.getElementById('open-rank-modal')?.addEventListener('click', openRankModal);
  }
}

function setupHeader() {
  initThemeToggle();
  topNav.addEventListener('change', () => {
    window.location.href = topNav.value;
  });
  refreshHeaderCommandMenu(currentUser);
}

function setupModal() {
  closeEarnersModalBtn?.addEventListener('click', closeEarnersModal);
  closeLadderModalBtn?.addEventListener('click', closeLadderModal);
  closeHistoryModalBtn?.addEventListener('click', closeHistoryModal);
  closeRankModalBtn?.addEventListener('click', closeRankModal);
  closeMobileSelectModalBtn?.addEventListener('click', closeMobileSelect);

  earnersModal?.querySelectorAll('[data-close-earners]').forEach((node) => {
    node.addEventListener('click', closeEarnersModal);
  });
  ladderModal?.querySelectorAll('[data-close-ladder]').forEach((node) => {
    node.addEventListener('click', closeLadderModal);
  });
  historyModal?.querySelectorAll('[data-close-history]').forEach((node) => {
    node.addEventListener('click', closeHistoryModal);
  });
  rankModal?.querySelectorAll('[data-close-rank]').forEach((node) => {
    node.addEventListener('click', closeRankModal);
  });
  mobileSelectModal?.querySelectorAll('[data-close-mobile-select]').forEach((node) => {
    node.addEventListener('click', closeMobileSelect);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (mobileSelectModal && !mobileSelectModal.classList.contains('hidden')) {
      closeMobileSelect();
      return;
    }
    if (rankModal && !rankModal.classList.contains('hidden')) {
      closeRankModal();
      return;
    }
    if (historyModal && !historyModal.classList.contains('hidden')) {
      closeHistoryModal();
      return;
    }
    if (ladderModal && !ladderModal.classList.contains('hidden')) {
      closeLadderModal();
      return;
    }
    if (earnersModal && !earnersModal.classList.contains('hidden')) {
      closeEarnersModal();
    }
  });
}

function setReadNavigationMode() {
  if (!topNav) return;
  topNav.innerHTML = '';

  const homeOption = document.createElement('option');
  homeOption.value = '/welcome';
  homeOption.textContent = 'Home';
  topNav.appendChild(homeOption);

  const statsOption = document.createElement('option');
  statsOption.value = '/stats';
  statsOption.textContent = 'Stats Dashboard';
  topNav.appendChild(statsOption);

  const detailsOption = document.createElement('option');
  detailsOption.value = '/league-details';
  detailsOption.textContent = 'League Details';
  topNav.appendChild(detailsOption);

  topNav.value = '/stats';
  refreshHeaderCommandMenu(currentUser);
}

function renderLoadingState() {
  statsSummaryStrip.innerHTML = `
    <div class="summary-chip stats-kpi-card stats-kpi-card-loading">
      <div class="skeleton skeleton-text small"></div>
      <div class="skeleton skeleton-text large"></div>
    </div>
    <div class="summary-chip stats-kpi-card stats-kpi-card-loading">
      <div class="skeleton skeleton-text small"></div>
      <div class="skeleton skeleton-text large"></div>
    </div>
    <div class="summary-chip stats-kpi-card stats-kpi-card-loading">
      <div class="skeleton skeleton-text small"></div>
      <div class="skeleton skeleton-text large"></div>
    </div>
    <div class="summary-chip stats-kpi-card stats-kpi-card-loading">
      <div class="skeleton skeleton-text small"></div>
      <div class="skeleton skeleton-text large"></div>
    </div>
  `;

  statsOverview.innerHTML = `
    <article class="spotlight-card stats-loading-card">
      <div class="stats-loading-head">
        <div class="skeleton skeleton-avatar"></div>
        <div class="stats-loading-copy">
          <div class="skeleton skeleton-text"></div>
          <div class="skeleton skeleton-text small"></div>
        </div>
      </div>
      <div class="stats-loading-stack">
        <div class="skeleton skeleton-text"></div>
        <div class="skeleton skeleton-text"></div>
        <div class="skeleton skeleton-text"></div>
      </div>
      <div class="status-loading">Loading league pulse</div>
    </article>
    <article class="spotlight-card stats-loading-card">
      <div class="stats-loading-stack">
        <div class="skeleton skeleton-text"></div>
        <div class="skeleton skeleton-text"></div>
        <div class="skeleton skeleton-text"></div>
        <div class="skeleton skeleton-text small"></div>
      </div>
    </article>
    <article class="spotlight-card stats-loading-card">
      <div class="stats-loading-stack">
        <div class="skeleton skeleton-text"></div>
        <div class="skeleton skeleton-text"></div>
        <div class="skeleton skeleton-text"></div>
        <div class="skeleton skeleton-text large"></div>
      </div>
    </article>
  `;

  leaderboardChart.innerHTML = `
    <div class="stats-loading-panel">
      <div class="status-loading">Loading payout breakdown</div>
      <div class="skeleton skeleton-card stats-loading-chart"></div>
    </div>
  `;

  matchWinnersCard.innerHTML = `
    <div class="stats-loading-panel">
      <div class="status-loading">Loading match results</div>
      <div class="skeleton skeleton-card"></div>
    </div>
  `;

  playerStatsCard.innerHTML = `
    <div class="stats-loading-panel">
      <div class="status-loading">Loading player performance</div>
      <div class="skeleton skeleton-card"></div>
    </div>
  `;

  matchFilter.innerHTML = '<option>Loading matches...</option>';
  playerFilter.innerHTML = '<option>Loading players...</option>';
  matchFilter.disabled = true;
  playerFilter.disabled = true;
}

async function init() {
  initNotifications();
  setupHeader();
  setupModal();
  renderLoadingState();

  const profile = await callApi('/api/auth/me');
  const user = profile.user;
  currentUser = user;

  if (user.membership_status !== 'active') {
    window.location.replace('/welcome');
    return;
  }

  if (user.active_league_id) {
    setActiveLeagueId(user.active_league_id);
  }
  const effectiveRole = user.league_role === 'admin' ? 'admin' : 'read';
  localStorage.setItem('league-ledger-user-role', effectiveRole);
  localStorage.setItem('league-ledger-username', user.user_id);
  localStorage.setItem('league-ledger-full-name', user.full_name || user.user_id);
  updateHeaderLeagueContext(user);
  ensureLeagueSwitcher(user);
  refreshHeaderCommandMenu(user);

  populateHeaderIdentity(user);
  if (effectiveRole !== 'admin') {
    setReadNavigationMode();
  }

  stats = await callApi('/api/stats');
  renderOverview();
  renderEarnersModal();
  renderLeaderboardChart();
  renderMatchFilter();
  renderPlayerFilter();
  ensureMobileSelectProxy(matchFilter, {
    title: 'Select Match',
    subtitle: 'Choose the match you want to inspect.',
    placeholder: 'Choose a match',
  });
  ensureMobileSelectProxy(playerFilter, {
    title: 'Select Player',
    subtitle: 'Choose the player you want to inspect.',
    placeholder: 'Choose a player',
  });
  syncMobileSelectVisibility();
  if (!mobileSelectResizeBound) {
    window.addEventListener('resize', syncMobileSelectVisibility);
    mobileSelectResizeBound = true;
  }
  matchFilter.disabled = false;
  playerFilter.disabled = false;
  syncMobileSelectVisibility();

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
