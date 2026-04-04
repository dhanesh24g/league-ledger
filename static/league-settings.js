import {
  callApi,
  initWorkflowShell,
  setButtonLoading,
  showError,
  showSuccess,
} from '/static/workflow-common.js';
import { initNotifications } from '/static/notifications.js';

const summaryZone = document.getElementById('league-settings-summary');
const membersZone = document.getElementById('league-settings-members');
let currentUser = null;

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
        <div>
          <strong>${escapeHtml(`${member.first_name} ${member.last_name}`.trim() || member.user_id_label)}</strong>
          <p class="muted">${escapeHtml(member.user_id_label)} • ${escapeHtml(member.email || 'No email')}</p>
        </div>
        <div class="settings-member-meta">
          <span class="status-chip">Role: ${member.role === 'admin' ? 'Admin' : 'Read'}</span>
          ${Number(member.user_id) === Number(currentUser?.id)
            ? '<span class="muted small">You</span>'
            : `
              <div class="member-role-actions">
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
}

async function init() {
  initNotifications();

  currentUser = await initWorkflowShell('/league-settings');
  if (!currentUser) return;

  const [membersResult, requestsResult] = await Promise.all([
    callApi('/api/league/members'),
    callApi('/api/league/requests'),
  ]);

  const members = Array.isArray(membersResult.members) ? membersResult.members : [];
  const requests = Array.isArray(requestsResult.requests) ? requestsResult.requests : [];

  renderSummary(currentUser, members, requests);
  renderMembers(members);
}

init().catch((error) => {
  console.error('League settings initialization failed:', error);
  showError(error);
});
