import {
  callApi,
  initWorkflowShell,
  setButtonLoading,
  showError,
  showLoading,
  showSuccess,
} from '/static/workflow-common.js';
import { initNotifications } from '/static/notifications.js';

const playersList = document.getElementById('players-list');

let authUser = { username: '', role: 'read' };

function renderPlayers(members) {
  playersList.innerHTML = '';

  if (!members.length) {
    playersList.innerHTML = '<li>No league members yet. Share the invite link from setup to add players.</li>';
    return;
  }

  members.forEach((member) => {
    const isSelf = Number(member.user_id) === Number(authUser.id);
    const li = document.createElement('li');
    li.className = 'member-chip';

    const name = document.createElement('span');
    const fullName = `${String(member.first_name || '').trim()} ${String(member.last_name || '').trim()}`.trim();
    const roleLabel = member.role === 'admin' ? 'Admin' : 'Read';
    name.textContent = `${fullName || member.user_id_label} (@${member.user_id_label}) · ${roleLabel}`;

    li.appendChild(name);
    if (authUser.league_role === 'admin' && !isSelf) {
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'remove';
      removeBtn.textContent = '🗑️';
      removeBtn.title = 'Remove member from league';
      removeBtn.setAttribute('aria-label', 'Remove member from league');
      removeBtn.addEventListener('click', async () => {
        const targetName = fullName || member.user_id_label;
        const confirmed = window.confirm(`Remove ${targetName} from this league? This action cannot be undone.`);
        if (!confirmed) return;

        let closeLoading = null;
        let restoreButton = null;
        try {
          restoreButton = setButtonLoading(removeBtn, 'Removing...');
          closeLoading = showLoading('Removing member...');
          await callApi(`/api/league/members/${member.user_id}`, { method: 'DELETE' });
          const result = await callApi('/api/league/members');
          renderPlayers(result.members || []);
          showSuccess('League member removed successfully.');
        } catch (error) {
          showError(error);
        } finally {
          if (restoreButton) restoreButton();
          if (closeLoading) closeLoading();
        }
      });
      li.appendChild(removeBtn);
    }
    playersList.appendChild(li);
  });
}

async function init() {
  initNotifications();
  authUser = await initWorkflowShell('/players');
  if (!authUser) return;
  const result = await callApi('/api/league/members');
  renderPlayers(result.members || []);
}

init().catch((error) => {
  console.error('Players initialization failed:', error);
  showError(error);
});
