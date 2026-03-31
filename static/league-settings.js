import {
  callApi,
  initWorkflowShell,
  showError,
} from '/static/workflow-common.js';
import { initNotifications } from '/static/notifications.js';

const summaryZone = document.getElementById('league-settings-summary');
const membersZone = document.getElementById('league-settings-members');

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
          <span class="muted small">Managed by policy</span>
        </div>
      </article>
    `)
    .join('');
}

async function init() {
  initNotifications();

  const user = await initWorkflowShell('/league-settings');
  if (!user) return;

  const [membersResult, requestsResult] = await Promise.all([
    callApi('/api/league/members'),
    callApi('/api/league/requests'),
  ]);

  const members = Array.isArray(membersResult.members) ? membersResult.members : [];
  const requests = Array.isArray(requestsResult.requests) ? requestsResult.requests : [];

  renderSummary(user, members, requests);
  renderMembers(members);
}

init().catch((error) => {
  console.error('League settings initialization failed:', error);
  showError(error);
});
