import {
  buildWorkflowRoute,
  callApi,
  clearWinnerDraft,
  getSelectedMatchId,
  getWinnerDraft,
  initWorkflowShell,
  isDirectAdminFlow,
  navigateTo,
  queueToast,
  registerMobileSelectProxy,
  setButtonLoading,
  setCurrentWorkflowPage,
  setSelectedMatchId,
  syncMobileSelectProxy,
  setWinnerDraft,
  showError,
  showLoading,
  showSuccess,
} from '/static/workflow-common.js';
import { initNotifications } from '/static/notifications.js';
import { rankIcon } from '/static/payouts.js';

const matchSelect = document.getElementById('match-select');
const loadWinnerBtn = document.getElementById('load-winner-form');
const reopenMatchBtn = document.getElementById('reopen-match');
const cancelMatchBtn = document.getElementById('mark-cancelled');
const continueLedgerBtn = document.getElementById('continue-ledger');
const sendTelegramUpdateBtn = document.getElementById('send-telegram-update');
const winnersForm = document.getElementById('winners-form');
const winnerMatchSummary = document.getElementById('winner-match-summary');
const winnersBackLink = document.getElementById('winners-back-link');
const pageBrand = document.getElementById('page-brand');
const telegramModal = document.getElementById('telegram-modal');
const telegramModalBody = document.getElementById('telegram-modal-body');
const closeTelegramModalBtn = document.getElementById('close-telegram-modal');

let authUser = { username: '', role: 'read' };
let appState = { league: null, players: [], matches: [] };
let winnerFeedbackEl = null;
let saveWinnersBtn = null;
let activeParticipantIds = [];
let telegramState = {
  status: null,
  activeMatchId: null,
  activeSessionId: null,
  sessionPollTimer: null,
};

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
  const isAdmin = authUser.league_role === 'admin';
  [loadWinnerBtn, cancelMatchBtn, continueLedgerBtn, sendTelegramUpdateBtn].forEach((element) => {
    element.disabled = !isAdmin;
  });

  if (!isAdmin) {
    winnersForm.innerHTML = '<p class="muted">Viewer mode: winners can only be updated by admin.</p>';
  }
}

function applyEntryModeUI() {
  const directFlow = isDirectAdminFlow('/winners');
  document.body.classList.toggle('direct-admin-flow', directFlow);
  if (pageBrand) {
    pageBrand.classList.add('brand-home-link');
    pageBrand.setAttribute('aria-label', 'Go to home');
  }

  if (!winnersBackLink) return;

  if (directFlow) {
    winnersBackLink.textContent = 'Back to Match Entry';
    winnersBackLink.removeAttribute('data-workflow-link');
    winnersBackLink.href = buildWorkflowRoute('/matches', { preserveDirectAdminFlow: true });
    return;
  }

  winnersBackLink.textContent = 'Back to Matches';
  winnersBackLink.setAttribute('data-workflow-link', '');
  winnersBackLink.href = '/matches';
}

function ensureWinnerFeedback() {
  if (winnerFeedbackEl) return winnerFeedbackEl;
  winnerFeedbackEl = document.createElement('p');
  winnerFeedbackEl.className = 'winner-feedback hidden';
  winnersForm.before(winnerFeedbackEl);
  return winnerFeedbackEl;
}

function updateMatchActionState() {
  const match = appState.matches.find((item) => String(item.id) === String(matchSelect.value));
  const isAdmin = authUser.league_role === 'admin';
  const status = String(match?.status || '').toLowerCase();
  const isCanceled = status === 'canceled';
  const isCompleted = status === 'completed';

  loadWinnerBtn.disabled = !isAdmin || !match || isCanceled;
  cancelMatchBtn.disabled = !isAdmin || !match || isCanceled;
  reopenMatchBtn?.classList.toggle('hidden', !isCanceled || !isAdmin || !match);
  if (reopenMatchBtn) {
    reopenMatchBtn.disabled = !isAdmin || !match || !isCanceled;
  }

  if (!match || !isAdmin) return;
  loadWinnerBtn.textContent = isCompleted ? 'Edit Assignment' : 'Load Assignment';
  cancelMatchBtn.textContent = isCanceled ? 'Washout Recorded' : 'Washout / Cancelled';
  if (sendTelegramUpdateBtn) {
    sendTelegramUpdateBtn.disabled = !isAdmin || !match;
  }
}

function setTelegramModalState(isOpen) {
  if (!telegramModal) return;
  telegramModal.classList.toggle('hidden', !isOpen);
  telegramModal.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
  document.body.classList.toggle('modal-open', isOpen);
}

function clearTelegramSessionPolling() {
  if (telegramState.sessionPollTimer) {
    window.clearTimeout(telegramState.sessionPollTimer);
    telegramState.sessionPollTimer = null;
  }
}

function closeTelegramModal() {
  clearTelegramSessionPolling();
  setTelegramModalState(false);
}

function getActiveTelegramMatch() {
  const targetId = telegramState.activeMatchId || matchSelect.value;
  return appState.matches.find((item) => String(item.id) === String(targetId)) || null;
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function telegramTargetLabel(status) {
  const target = status?.target;
  if (!target?.chat_name) return 'Telegram target';
  return target.chat_name;
}

function renderTelegramModal(content) {
  if (!telegramModalBody) return;
  telegramModalBody.innerHTML = content;
  setTelegramModalState(true);
}

function telegramSetupSummary(match, intro) {
  const safeTitle = escapeHtml(match?.title || 'Selected match');
  const safeIntro = escapeHtml(intro || 'Connect Telegram once and we will remember it for future match updates.');
  return `
    <article class="telegram-surface-card telegram-surface-card-compact">
      <span class="telegram-surface-kicker">Setup</span>
      <h3>Set up Telegram for this league</h3>
      <p>${safeIntro}</p>
      <div class="telegram-match-pill">${safeTitle}</div>
    </article>
  `;
}

function renderTelegramConfigError(status, match, intro) {
  const needsWebhook = status?.bot_ready && (!status?.webhook_ready || !status?.webhook_registered);
  const helper = needsWebhook
    ? 'Telegram bot is ready, but the webhook is not registered yet. Register it once, then continue.'
    : 'Add TELEGRAM_BOT_TOKEN and TELEGRAM_BOT_USERNAME on the server to enable Telegram linking.';
  renderTelegramModal(`
    ${telegramSetupSummary(match, intro)}
    <article class="telegram-surface-card telegram-surface-card-muted">
      <h3>${needsWebhook ? 'Webhook setup pending' : 'Telegram bot setup pending'}</h3>
      <p>${escapeHtml(helper)}</p>
      <div class="telegram-inline-actions">
        ${needsWebhook ? '<button id="telegram-register-webhook" type="button" class="primary">Register Webhook</button>' : ''}
        <button id="telegram-close-inline" type="button" class="ghost">Close</button>
      </div>
    </article>
  `);
  document.getElementById('telegram-close-inline')?.addEventListener('click', closeTelegramModal);
  document.getElementById('telegram-register-webhook')?.addEventListener('click', async (event) => {
    const restore = setButtonLoading(event.currentTarget, 'Registering...');
    try {
      const result = await callApi('/api/integrations/telegram/webhook/register', { method: 'POST' });
      showSuccess(result.description || 'Telegram webhook registered.');
      await openTelegramModal({ matchId: match?.id, reason: 'Webhook registered. Continue with Telegram connect.' });
    } catch (error) {
      showError(error);
    } finally {
      restore();
    }
  });
}

function renderTelegramConnectedState(status, match, intro) {
  const target = status?.target;
  renderTelegramModal(`
    <article class="telegram-surface-card telegram-surface-card-success telegram-surface-card-compact">
      <span class="telegram-surface-kicker">Connected</span>
      <h3>Ready to send</h3>
      <p>${escapeHtml(intro || `Linked to ${telegramTargetLabel(status)}. Send this match update now or skip for later.`)}</p>
      <div class="telegram-target-summary">
        <strong>${escapeHtml(target?.chat_name || 'Configured Telegram target')}</strong>
        <span>${escapeHtml(target?.chat_type || 'chat')}</span>
      </div>
      <div class="telegram-inline-actions">
        <button id="telegram-send-now" type="button" class="primary">Send Match Update</button>
        <button id="telegram-change-target" type="button" class="ghost">Change Telegram Target</button>
        <button id="telegram-skip-now" type="button" class="ghost">Skip for now</button>
      </div>
    </article>
  `);
  document.getElementById('telegram-skip-now')?.addEventListener('click', closeTelegramModal);
  document.getElementById('telegram-change-target')?.addEventListener('click', () => {
    renderTelegramConnectChoiceState(match, 'Choose a new Telegram destination for this league.', status);
  });
  document.getElementById('telegram-send-now')?.addEventListener('click', async (event) => {
    await sendTelegramUpdateForMatch(match?.id, event.currentTarget);
  });
}

function renderTelegramWaitingState(match, session, statusSnapshot) {
  const personal = session?.target === 'personal';
  const title = personal ? 'Connect personal chat' : 'Connect Telegram group';
  const helper = personal
    ? 'Open the bot, tap Start, then return here.'
    : 'Open Telegram, add the bot to the group, then return here.';
  renderTelegramModal(`
    ${telegramSetupSummary(match, 'Match update recorded. Connect Telegram once and the league can reuse it for future updates.')}
    <article class="telegram-surface-card">
      <span class="telegram-surface-kicker">Step 1</span>
      <h3>${title}</h3>
      <p>${helper}</p>
      <div class="telegram-connect-grid">
        <div class="telegram-connect-main">
          <a class="primary telegram-open-link" href="${escapeHtml(session.connect_url)}" target="_blank" rel="noreferrer">Open Telegram</a>
          <button id="telegram-copy-link" type="button" class="ghost">Copy Link</button>
          <p class="telegram-helper-copy">Link expires in about 15 minutes.</p>
          <div class="telegram-command-card">
            <strong>Fallback for Telegram Web/Desktop</strong>
            <p>Use this only if Telegram opens the chat without the secure token.</p>
            <code class="telegram-command-code">${escapeHtml(session.start_command || '/start')}</code>
            <button id="telegram-copy-command" type="button" class="ghost">Copy Secure Command</button>
          </div>
        </div>
        <div class="telegram-qr-card ${session.qr_code_data_uri ? '' : 'telegram-qr-card-empty'}">
          ${session.qr_code_data_uri ? `<img src="${session.qr_code_data_uri}" alt="Telegram connect QR code" class="telegram-qr-image">` : '<div class="telegram-qr-fallback">QR available after server package install</div>'}
          <span>${personal ? 'Scan from your phone' : 'Scan to add the bot to the group'}</span>
        </div>
      </div>
      <div class="telegram-inline-actions">
        <button id="telegram-refresh-session" type="button" class="primary">I connected it</button>
        <button id="telegram-cancel-session" type="button" class="ghost">Close</button>
      </div>
    </article>
    ${statusSnapshot?.target ? `
      <article class="telegram-surface-card telegram-surface-card-muted">
        <span class="telegram-surface-kicker">Current league target</span>
        <h3>${escapeHtml(statusSnapshot.target.chat_name || 'Telegram target already configured')}</h3>
        <p>Connecting again will replace the existing destination for this league.</p>
      </article>
    ` : ''}
  `);
  document.getElementById('telegram-cancel-session')?.addEventListener('click', closeTelegramModal);
  document.getElementById('telegram-copy-link')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(session.connect_url);
      showSuccess('Telegram connect link copied.');
    } catch (_) {
      showError('Could not copy the Telegram link on this device.');
    }
  });
  document.getElementById('telegram-copy-command')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(session.start_command || '/start');
      showSuccess('Secure Telegram start command copied.');
    } catch (_) {
      showError('Could not copy the Telegram start command on this device.');
    }
  });
  document.getElementById('telegram-refresh-session')?.addEventListener('click', () => refreshTelegramSession(session.session_id, match?.id));
}

async function loadTelegramStatus() {
  telegramState.status = await callApi('/api/integrations/telegram/status');
  return telegramState.status;
}

async function refreshTelegramSession(sessionId, matchId) {
  clearTelegramSessionPolling();
  try {
    const session = await callApi(`/api/integrations/telegram/connect-session/${sessionId}`);
    if (session.status === 'connected') {
      telegramState.activeSessionId = null;
      await loadTelegramStatus();
      renderTelegramConnectedState(telegramState.status, getActiveTelegramMatch(), 'Telegram connected successfully. Send the latest match update now?');
      return;
    }
    if (session.status === 'expired') {
      showError('Telegram connect link expired. Generate a fresh one and try again.');
      await openTelegramModal({ matchId, reason: 'The earlier Telegram link expired. Create a new one.' });
      return;
    }
    telegramState.sessionPollTimer = window.setTimeout(() => refreshTelegramSession(sessionId, matchId), 3000);
  } catch (error) {
    showError(error);
  }
}

async function startTelegramConnect(target, matchId, triggerButton) {
  let restore = null;
  try {
    if (triggerButton) restore = setButtonLoading(triggerButton, 'Preparing...');
    const session = await callApi('/api/integrations/telegram/connect-session', {
      method: 'POST',
      body: JSON.stringify({ target, match_id: matchId || null }),
    });
    telegramState.activeSessionId = session.session_id;
    renderTelegramWaitingState(getActiveTelegramMatch(), session, telegramState.status);
    telegramState.sessionPollTimer = window.setTimeout(() => refreshTelegramSession(session.session_id, matchId), 3000);
  } catch (error) {
    showError(error);
  } finally {
    if (restore) restore();
  }
}

async function sendTelegramUpdateForMatch(matchId, triggerButton = null) {
  if (!matchId) {
    showError('Choose a match first.');
    return;
  }
  let restore = null;
  try {
    if (triggerButton) restore = setButtonLoading(triggerButton, 'Sending...');
    const result = await callApi('/api/integrations/telegram/matches/send', {
      method: 'POST',
      body: JSON.stringify({ match_id: Number(matchId) }),
    });
    closeTelegramModal();
    showSuccess(`Telegram update sent${result.chat_name ? ` to ${result.chat_name}` : ''}.`);
  } catch (error) {
    showError(error);
  } finally {
    if (restore) restore();
  }
}

function renderTelegramConnectChoiceState(match, intro = '', statusSnapshot = null) {
  renderTelegramModal(`
    ${telegramSetupSummary(match, intro || 'Match update recorded. Connect Telegram once and the league can send future result notifications in one tap.')}
    <article class="telegram-surface-card">
      <span class="telegram-surface-kicker">Step 1</span>
      <h3>Choose how you want to connect</h3>
      <p>Most admins test with their own Telegram first, then switch the league to a group later.</p>
      <div class="telegram-choice-grid">
        <button id="telegram-connect-personal" type="button" class="telegram-choice-card">
          <strong>Connect personal chat</strong>
          <span>Use your own Telegram chat to test the workflow safely.</span>
        </button>
        <button id="telegram-connect-group" type="button" class="telegram-choice-card">
          <strong>Connect Telegram group</strong>
          <span>Attach the bot directly to the league’s Telegram group.</span>
        </button>
      </div>
      <div class="telegram-inline-actions">
        <button id="telegram-close-choice" type="button" class="ghost">Close</button>
      </div>
    </article>
    ${statusSnapshot?.target ? `
      <article class="telegram-surface-card telegram-surface-card-muted">
        <span class="telegram-surface-kicker">Current league target</span>
        <h3>${escapeHtml(statusSnapshot.target.chat_name || 'Telegram target already configured')}</h3>
        <p>Connecting again will replace the existing destination for this league.</p>
      </article>
    ` : ''}
  `);
  document.getElementById('telegram-close-choice')?.addEventListener('click', closeTelegramModal);
  document.getElementById('telegram-connect-personal')?.addEventListener('click', (event) => startTelegramConnect('personal', match.id, event.currentTarget));
  document.getElementById('telegram-connect-group')?.addEventListener('click', (event) => startTelegramConnect('group', match.id, event.currentTarget));
}

async function openTelegramModal({ matchId = null, reason = '', forceReconnect = false } = {}) {
  const match = appState.matches.find((item) => String(item.id) === String(matchId || matchSelect.value));
  if (!match) {
    showError('Choose a match first.');
    return;
  }
  telegramState.activeMatchId = String(match.id);
  const status = await loadTelegramStatus();
  if (!status.bot_ready) {
    renderTelegramConfigError(status, match, reason);
    return;
  }
  if (!status.webhook_ready || !status.webhook_registered) {
    renderTelegramConfigError(status, match, reason);
    return;
  }
  if (status.target?.chat_id && !forceReconnect) {
    renderTelegramConnectedState(status, match, reason || `Connected to ${telegramTargetLabel(status)}. Send this match update now?`);
    return;
  }
  renderTelegramConnectChoiceState(
    match,
    reason || 'Match update recorded. Connect Telegram once and the league can send future result notifications in one tap.',
    status,
  );
}

function renderMatchSelect() {
  matchSelect.innerHTML = '';

  if (!appState.matches.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No matches yet';
    matchSelect.appendChild(option);
    loadWinnerBtn.disabled = true;
    cancelMatchBtn.disabled = true;
    if (winnerMatchSummary) {
      winnerMatchSummary.innerHTML = '<div class="feed-item">Create a match first, then assign winners here.</div>';
    }
    return;
  }

  appState.matches.forEach((match) => {
    const option = document.createElement('option');
    option.value = String(match.id);
    option.textContent = `${match.title} · ${match.match_date}`;
    matchSelect.appendChild(option);
  });

  const storedMatchId = getSelectedMatchId();
  const selectedMatch = appState.matches.find((match) => String(match.id) === String(storedMatchId));
  const activeMatchId = selectedMatch ? String(selectedMatch.id) : String(appState.matches[0].id);
  matchSelect.value = activeMatchId;
  setSelectedMatchId(activeMatchId);
  syncMobileSelectProxy(matchSelect);
  updateMatchActionState();
}

function renderMatchSummary(matchId) {
  if (!winnerMatchSummary) return;

  const match = appState.matches.find((item) => String(item.id) === String(matchId));
  if (!match) {
    winnerMatchSummary.innerHTML = '';
    return;
  }

  const participantCount = (match.participant_ids || []).length || appState.players.length;
  const winnerCount = getWinnerCount(match);
  const status = String(match.status || 'pending');
  const statusTone = status === 'completed' ? 'status-good' : status === 'canceled' ? 'status-bad' : 'status-neutral';

  winnerMatchSummary.innerHTML = `
    <article class="feed-item workflow-match-summary-card">
      <div class="workflow-feed-head">
        <div>
          <span class="match-kicker">Selected Match</span>
          <strong>${match.title}</strong>
        </div>
        <div class="workflow-chip-row">
          <span class="status-chip ${statusTone}">${status}</span>
          <span class="status-chip">${match.match_date}</span>
          <span class="status-chip">${participantCount} players</span>
          <span class="status-chip">${winnerCount} winner${winnerCount === 1 ? '' : 's'}</span>
        </div>
      </div>
    </article>
  `;
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
  renderMatchSummary(matchId);

  const match = appState.matches.find((item) => String(item.id) === String(matchId));
  if (!match || !appState.league || !appState.players.length) {
    winnersForm.innerHTML = '<p class="muted">Set up league, players, and matches first.</p>';
    return;
  }

  if (String(match.status || '').toLowerCase() === 'canceled') {
    winnersForm.innerHTML = '<p class="muted">This match is marked as washout/cancelled. Refund has been distributed equally. Continue to ledger or reopen the match to restore winner assignment.</p>';
    return;
  }

  activeParticipantIds = Array.isArray(match.participant_ids) && match.participant_ids.length
    ? match.participant_ids.map((value) => Number(value))
    : appState.players.map((player) => Number(player.id));

  const participantNames = appState.players
    .filter((player) => activeParticipantIds.includes(Number(player.id)))
    .map((player) => player.name);

  const participantSummary = document.createElement('div');
  participantSummary.className = 'feed-item workflow-feed-item workflow-feed-item-soft';
  participantSummary.innerHTML = `
    <div class="workflow-feed-head">
      <strong>Eligible Players</strong>
      <span class="status-chip">${participantNames.length} available</span>
    </div>
    <p class="muted small">${participantNames.join(', ') || 'No participants captured for this match.'}</p>
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

    showSuccess('Winners saved successfully.');

    setWinnerFeedback(
      'success',
      `<strong>Saved beautifully.</strong> Winners for <strong>${match.title}</strong> are now recorded and ready for the ledger.`
    );
    await openTelegramModal({
      matchId: match.id,
      reason: `Match update for ${match.title} has been recorded successfully. Do you want to send the Telegram notification now?`,
    });
  };
}

async function saveWinners(match, options = {}) {
  const { showSuccess = false } = options;
  let closeLoading = null;
  let restoreSaveButton = null;
  try {
    closeLoading = showLoading('Saving winners...');
    if (saveWinnersBtn) {
      restoreSaveButton = setButtonLoading(saveWinnersBtn, 'Saving...');
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
    if (closeLoading) closeLoading();
    if (restoreSaveButton) restoreSaveButton();
  }
}

loadWinnerBtn.addEventListener('click', () => {
  if (authUser.league_role !== 'admin') {
    showError('Only admin can assign winners.');
    return;
  }
  if (!matchSelect.value) {
    showError('Choose a match first.');
    return;
  }
  setSelectedMatchId(matchSelect.value);
  updateMatchActionState();
  renderWinnerForm(matchSelect.value);
});

matchSelect.addEventListener('change', () => {
  setSelectedMatchId(matchSelect.value);
  updateMatchActionState();
  renderMatchSummary(matchSelect.value);
  if (authUser.league_role === 'admin') {
    renderWinnerForm(matchSelect.value);
  }
});

sendTelegramUpdateBtn?.addEventListener('click', async () => {
  if (authUser.league_role !== 'admin') {
    showError('Only admin can send Telegram notifications.');
    return;
  }
  if (!matchSelect.value) {
    showError('Choose a match first.');
    return;
  }

  const match = appState.matches.find((item) => String(item.id) === String(matchSelect.value));
  if (!match) {
    showError('Choose a match first.');
    return;
  }

  const status = String(match.status || '').toLowerCase();
  if (!['completed', 'canceled'].includes(status)) {
    showError('Save winners or record washout before sending a Telegram update.');
    return;
  }

  await openTelegramModal({
    matchId: match.id,
    reason: `You can send the latest update for ${match.title} to Telegram now.`,
  });
});

cancelMatchBtn.addEventListener('click', async () => {
  if (authUser.league_role !== 'admin') {
    showError('Only admin can cancel a match.');
    return;
  }
  if (!matchSelect.value) {
    showError('Choose a match first.');
    return;
  }

  const proceed = window.confirm('Mark this match as washout/cancelled and refund equally to all players?');
  if (!proceed) return;

  let closeLoading = null;
  let restoreCancelButton = null;
  try {
    restoreCancelButton = setButtonLoading(cancelMatchBtn, 'Cancelling...');
    closeLoading = showLoading('Cancelling match...');
    const targetMatchId = String(matchSelect.value);
    await callApi(`/api/matches/${targetMatchId}/cancel`, { method: 'POST' });
    appState = await callApi('/api/state');
    const refreshedMatch = (appState.matches || []).find((item) => String(item.id) === targetMatchId);
    if (!refreshedMatch || String(refreshedMatch.status || '').toLowerCase() !== 'canceled') {
      throw new Error('The match did not switch to washout/cancelled status. Please refresh and try again.');
    }
    renderMatchSelect();
    matchSelect.value = targetMatchId;
    updateMatchActionState();
    renderMatchSummary(targetMatchId);
    clearWinnerDraft(targetMatchId);
    winnersForm.innerHTML = '<p class="muted">Match marked as washout/cancelled. Refund distributed equally.</p>';
    clearWinnerFeedback();
    showSuccess('Match cancelled and refund distributed.');
    await openTelegramModal({
      matchId: targetMatchId,
      reason: `Washout for ${refreshedMatch.title} has been recorded successfully. Do you want to send the Telegram notification now?`,
    });
  } catch (error) {
    showError(error);
  } finally {
    if (restoreCancelButton) restoreCancelButton();
    if (closeLoading) closeLoading();
  }
});

reopenMatchBtn?.addEventListener('click', async () => {
  if (authUser.league_role !== 'admin') {
    showError('Only admin can reopen a match.');
    return;
  }
  if (!matchSelect.value) {
    showError('Choose a match first.');
    return;
  }

  const proceed = window.confirm('Reopen this washout/cancelled match? Refund rows will be cleared and you can assign winners again.');
  if (!proceed) return;

  let closeLoading = null;
  let restoreReopenButton = null;
  try {
    restoreReopenButton = setButtonLoading(reopenMatchBtn, 'Reopening...');
    closeLoading = showLoading('Reopening match...');
    const targetMatchId = String(matchSelect.value);
    await callApi(`/api/matches/${targetMatchId}/reopen`, { method: 'POST' });
    appState = await callApi('/api/state');
    const refreshedMatch = (appState.matches || []).find((item) => String(item.id) === targetMatchId);
    if (!refreshedMatch || String(refreshedMatch.status || '').toLowerCase() === 'canceled') {
      throw new Error('The match could not be reopened. Please refresh and try again.');
    }
    renderMatchSelect();
    matchSelect.value = targetMatchId;
    updateMatchActionState();
    renderMatchSummary(targetMatchId);
    clearWinnerDraft(targetMatchId);
    renderWinnerForm(targetMatchId);
    showSuccess('Match reopened. You can assign winners again.');
  } catch (error) {
    showError(error);
  } finally {
    if (restoreReopenButton) restoreReopenButton();
    if (closeLoading) closeLoading();
  }
});

continueLedgerBtn.addEventListener('click', async () => {
  if (authUser.league_role !== 'admin') {
    navigateTo('/ledger');
    return;
  }

  const match = appState.matches.find((item) => String(item.id) === String(matchSelect.value));
  if (!match) {
    showError('Choose a match first.');
    return;
  }

  if (String(match.status || '').toLowerCase() === 'canceled') {
    setCurrentWorkflowPage('/ledger');
    navigateTo('/ledger');
    return;
  }

  let restoreContinueButton = null;
  try {
    restoreContinueButton = setButtonLoading(continueLedgerBtn, 'Saving...');
    const saved = await saveWinners(match);
    if (!saved) return;

    queueToast('Winners saved successfully.');
    setCurrentWorkflowPage('/ledger');
    navigateTo('/ledger');
  } finally {
    if (restoreContinueButton) restoreContinueButton();
  }
});

closeTelegramModalBtn?.addEventListener('click', closeTelegramModal);
telegramModal?.querySelectorAll('[data-close-telegram-modal]').forEach((node) => {
  node.addEventListener('click', closeTelegramModal);
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && telegramModal && !telegramModal.classList.contains('hidden')) {
    closeTelegramModal();
  }
});

async function init() {
  initNotifications();
  matchSelect.innerHTML = '<option>Loading matches...</option>';
  winnersForm.innerHTML = '<div class="feed-item">Loading winner assignment...</div>';
  authUser = await initWorkflowShell('/winners');
  if (!authUser) return;
  registerMobileSelectProxy(matchSelect, {
    variant: 'full',
    placeholder: 'Choose a match',
  });
  applyEntryModeUI();
  applyRoleBasedUI();
  appState = await callApi('/api/state');
  renderMatchSelect();
  updateMatchActionState();
  renderMatchSummary(matchSelect.value);

  if (authUser.league_role === 'admin' && matchSelect.value) {
    renderWinnerForm(matchSelect.value);
  }
}

init().catch((error) => {
  console.error('Winners initialization failed:', error);
  showError(error);
});
