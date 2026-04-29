import {
  callApi,
  initCollapsibles,
  initWorkflowShell,
  registerMobileSelectProxy,
  setButtonLoading,
  showError,
  showSuccess,
} from '/static/workflow-common.js';
import { initNotifications } from '/static/notifications.js';

const summaryZone = document.getElementById('league-settings-summary');
const membersZone = document.getElementById('league-settings-members');
const aliasPanel = document.getElementById('alias-panel');
const aliasList = document.getElementById('alias-list');
const aliasCountChip = document.getElementById('alias-count-chip');
const aliasSearchInput = document.getElementById('alias-search');
const aliasAddForm = document.getElementById('alias-add-form');
const aliasNewText = document.getElementById('alias-new-text');
const aliasNewPlayer = document.getElementById('alias-new-player');
let currentUser = null;
let aliasData = { aliases: [], players: [] };
let aliasFilter = '';

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderSummary(user, members, requests) {
  const memberCount = members.length;
  const adminCount = members.filter((member) => member.role === 'admin').length;
  const readCount = members.filter((member) => member.role === 'read').length;

  summaryZone.innerHTML = `
    <article class="settings-card">
      <span class="summary-chip-label">Active League</span>
      <strong>${escapeHtml(user.active_league_name || 'Current League')}</strong>
      <small class="muted">ID: ${escapeHtml(String(user.active_league_id || '-'))}</small>
    </article>
    <article class="settings-card">
      <span class="summary-chip-label">Pending Join Requests</span>
      <strong>${requests.length}</strong>
      <small class="muted">Default approval role is Read</small>
    </article>
    <article class="settings-card">
      <span class="summary-chip-label">Admins</span>
      <strong>${adminCount}</strong>
      <small class="muted">Total members: ${memberCount}</small>
    </article>
    <article class="settings-card">
      <span class="summary-chip-label">Read Members</span>
      <strong>${readCount}</strong>
      <small class="muted">Role updates managed in this section</small>
    </article>
  `;
}

function renderMembers(members) {
  if (!members.length) {
    membersZone.innerHTML = '<div class="feed-item">No members found for this league.</div>';
    return;
  }

  membersZone.innerHTML = members
    .map((member) => `
      <article class="feed-item settings-member-item">
        <div class="settings-member-copy">
          <strong>${escapeHtml(`${member.first_name} ${member.last_name}`.trim() || member.user_id_label)}</strong>
          <p class="muted">${escapeHtml(member.user_id_label)} • ${escapeHtml(member.email || 'No email')}</p>
        </div>
        <div class="settings-member-meta">
          <div class="settings-member-badges">
            <span class="status-chip">Role: ${member.role === 'admin' ? 'Admin' : 'Read'}</span>
            ${Number(member.user_id) === Number(currentUser?.id)
        ? '<span class="muted small settings-self-badge">You</span>'
        : ''}
          </div>
          ${Number(member.user_id) === Number(currentUser?.id)
        ? ''
        : `
              <div class="member-role-actions settings-member-controls">
                <select class="member-role-select" data-user-id="${member.user_id}" aria-label="Role for ${escapeHtml(member.user_id_label)}">
                  <option value="read" ${member.role === 'read' ? 'selected' : ''}>Read</option>
                  <option value="admin" ${member.role === 'admin' ? 'selected' : ''}>Admin</option>
                </select>
                <button type="button" class="ghost small save-member-role" data-user-id="${member.user_id}">Save</button>
              </div>
            `}
        </div>
      </article>
    `)
    .join('');

  membersZone.querySelectorAll('.save-member-role').forEach((button) => {
    button.addEventListener('click', async () => {
      const memberUserId = button.dataset.userId;
      const select = membersZone.querySelector(`.member-role-select[data-user-id="${memberUserId}"]`);
      if (!select || !memberUserId) return;

      const restoreButton = setButtonLoading(button, 'Saving...');
      try {
        await callApi(`/api/league/members/${memberUserId}/role`, {
          method: 'PATCH',
          body: JSON.stringify({ role: select.value }),
        });
        showSuccess('Member role updated.');

        const membersResult = await callApi('/api/league/members');
        const refreshedMembers = Array.isArray(membersResult.members) ? membersResult.members : [];
        renderMembers(refreshedMembers);
      } catch (error) {
        showError(error);
      } finally {
        restoreButton();
      }
    });
  });

  membersZone.querySelectorAll('.member-role-select').forEach((select) => {
    registerMobileSelectProxy(select, {
      variant: 'full',
      placeholder: 'Select role',
    });
  });
}

// ---------- Screenshot name mappings (aliases) ----------

function renderAliasPlayerOptions() {
  if (!aliasNewPlayer) return;
  const currentValue = aliasNewPlayer.value;
  const players = aliasData.players || [];
  aliasNewPlayer.innerHTML = '<option value="">— Select a player —</option>'
    + players
      .map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)
      .join('');
  if (currentValue && players.some((p) => String(p.id) === String(currentValue))) {
    aliasNewPlayer.value = currentValue;
  }
}

function filteredAliases() {
  const query = aliasFilter.trim().toLowerCase();
  if (!query) return aliasData.aliases;
  return aliasData.aliases.filter((row) =>
    String(row.alias_display || '').toLowerCase().includes(query)
    || String(row.player_name || '').toLowerCase().includes(query));
}

function renderAliasList() {
  if (!aliasList) return;
  const total = aliasData.aliases.length;
  if (aliasCountChip) {
    aliasCountChip.textContent = `${total} mapping${total === 1 ? '' : 's'}`;
  }

  const rows = filteredAliases();
  if (!rows.length) {
    aliasList.innerHTML = total
      ? '<div class="feed-item">No mappings match your search.</div>'
      : '<div class="feed-item">No screenshot name mappings yet. They will appear here automatically after you save winners from a screenshot.</div>';
    return;
  }

  const players = aliasData.players || [];
  aliasList.innerHTML = rows.map((row) => {
    const optionsHtml = players
      .map((p) => `<option value="${p.id}" ${String(p.id) === String(row.player_id) ? 'selected' : ''}>${escapeHtml(p.name)}</option>`)
      .join('');
    return `
      <article class="feed-item alias-row" data-alias-id="${row.id}">
        <div class="alias-row-main">
          <strong class="alias-row-text">${escapeHtml(row.alias_display || row.alias)}</strong>
          <span class="muted small alias-row-arrow" aria-hidden="true">→</span>
          <select class="alias-row-select" data-alias-id="${row.id}" aria-label="Map ${escapeHtml(row.alias_display || row.alias)} to a player">
            ${optionsHtml || '<option value="">(no players)</option>'}
          </select>
        </div>
        <div class="alias-row-actions">
          <button type="button" class="ghost small alias-save" data-alias-id="${row.id}" disabled>Save</button>
          <button type="button" class="ghost small alias-delete" data-alias-id="${row.id}" title="Remove mapping">🗑</button>
        </div>
      </article>
    `;
  }).join('');

  aliasList.querySelectorAll('.alias-row-select').forEach((select) => {
    const aliasId = select.dataset.aliasId;
    const originalValue = select.value;
    select.addEventListener('change', () => {
      const saveBtn = aliasList.querySelector(`.alias-save[data-alias-id="${aliasId}"]`);
      if (saveBtn) saveBtn.disabled = select.value === originalValue || !select.value;
    });
  });

  aliasList.querySelectorAll('.alias-save').forEach((button) => {
    button.addEventListener('click', async () => {
      const aliasId = button.dataset.aliasId;
      const select = aliasList.querySelector(`.alias-row-select[data-alias-id="${aliasId}"]`);
      if (!select || !select.value) return;
      const restore = setButtonLoading(button, 'Saving...');
      try {
        await callApi(`/api/player-aliases/${aliasId}`, {
          method: 'PATCH',
          body: JSON.stringify({ player_id: Number(select.value) }),
        });
        showSuccess('Mapping updated.');
        await loadAliases();
      } catch (error) {
        showError(error);
      } finally {
        restore();
      }
    });
  });

  aliasList.querySelectorAll('.alias-delete').forEach((button) => {
    button.addEventListener('click', async () => {
      const aliasId = button.dataset.aliasId;
      if (!aliasId) return;
      const row = aliasData.aliases.find((item) => String(item.id) === String(aliasId));
      const aliasText = row?.alias_display || row?.alias || 'this mapping';
      if (!window.confirm(`Remove "${aliasText}"? Future screenshots will no longer auto-resolve this name.`)) return;
      const restore = setButtonLoading(button, '…');
      try {
        await callApi(`/api/player-aliases/${aliasId}`, { method: 'DELETE' });
        showSuccess('Mapping removed.');
        await loadAliases();
      } catch (error) {
        showError(error);
      } finally {
        restore();
      }
    });
  });
}

async function loadAliases() {
  if (!aliasPanel) return;
  try {
    const data = await callApi('/api/player-aliases');
    aliasData = {
      aliases: Array.isArray(data?.aliases) ? data.aliases : [],
      players: Array.isArray(data?.players) ? data.players : [],
    };
    aliasPanel.classList.remove('hidden');
    renderAliasPlayerOptions();
    renderAliasList();
  } catch (error) {
    // If the backend returns 501 (Supabase path) or 403, just hide the panel quietly.
    console.warn('Alias management unavailable:', error);
    aliasPanel.classList.add('hidden');
  }
}

aliasSearchInput?.addEventListener('input', (event) => {
  aliasFilter = String(event.target.value || '');
  renderAliasList();
});

aliasAddForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const aliasText = String(aliasNewText?.value || '').trim();
  const playerId = Number(aliasNewPlayer?.value || 0);
  if (!aliasText || !playerId) {
    showError('Enter an alias and pick a player.');
    return;
  }
  const submitBtn = aliasAddForm.querySelector('button[type="submit"]');
  const restore = submitBtn ? setButtonLoading(submitBtn, 'Adding...') : () => { };
  try {
    await callApi('/api/player-aliases/bulk', {
      method: 'POST',
      body: JSON.stringify({
        entries: [{ player_id: playerId, alias: aliasText, alias_display: aliasText }],
      }),
    });
    aliasNewText.value = '';
    aliasNewPlayer.value = '';
    showSuccess('Mapping added.');
    await loadAliases();
  } catch (error) {
    showError(error);
  } finally {
    restore();
  }
});

// ---------- End alias management ----------

async function init() {
  initNotifications();

  currentUser = await initWorkflowShell('/league-settings');
  if (!currentUser) return;

  initCollapsibles();

  const [membersResult, requestsResult] = await Promise.all([
    callApi('/api/league/members'),
    callApi('/api/league/requests'),
  ]);

  const members = Array.isArray(membersResult.members) ? membersResult.members : [];
  const requests = Array.isArray(requestsResult.requests) ? requestsResult.requests : [];

  renderSummary(currentUser, members, requests);
  renderMembers(members);

  if (currentUser.league_role === 'admin') {
    loadAliases().catch(() => { });
  }
}

init().catch((error) => {
  console.error('League settings initialization failed:', error);
  showError(error);
});
