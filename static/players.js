import {
  callApi,
  clearPlayerDraft,
  getPlayerDraft,
  initWorkflowShell,
  setPlayerDraft,
  showError,
} from '/static/workflow-common.js';

const playerForm = document.getElementById('player-form');
const playersList = document.getElementById('players-list');

let authUser = { username: '', role: 'read' };

function applyRoleBasedUI() {
  const isAdmin = authUser.league_role === 'admin';
  const controls = playerForm.querySelectorAll('input, button');
  controls.forEach((control) => {
    control.disabled = !isAdmin;
  });
}

function persistDraft() {
  setPlayerDraft({
    name: String(playerForm.elements.name.value || ''),
  });
}

function renderPlayers(players) {
  playersList.innerHTML = '';

  if (!players.length) {
    playersList.innerHTML = '<li>No players added yet.</li>';
    return;
  }

  players.forEach((player) => {
    const li = document.createElement('li');

    const name = document.createElement('span');
    name.textContent = player.name;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'remove';
    removeBtn.textContent = '🗑️';
    removeBtn.title = 'Remove player';
    removeBtn.setAttribute('aria-label', 'Remove player');
    removeBtn.disabled = authUser.league_role !== 'admin';
    removeBtn.addEventListener('click', async () => {
      if (authUser.league_role !== 'admin') {
        showError('Only admin can remove players.');
        return;
      }

      try {
        await callApi(`/api/players/${player.id}`, { method: 'DELETE' });
        const state = await callApi('/api/state');
        renderPlayers(state.players);
      } catch (error) {
        showError(error);
      }
    });

    li.appendChild(name);
    li.appendChild(removeBtn);
    playersList.appendChild(li);
  });
}

playerForm.elements.name.addEventListener('input', persistDraft);

playerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (authUser.league_role !== 'admin') {
    showError('Only admin can add players.');
    return;
  }

  try {
    const formData = new FormData(playerForm);
    await callApi('/api/players', {
      method: 'POST',
      body: JSON.stringify({ name: String(formData.get('name') || '') }),
    });

    playerForm.reset();
    clearPlayerDraft();
    const state = await callApi('/api/state');
    renderPlayers(state.players);
  } catch (error) {
    showError(error);
  }
});

async function init() {
  authUser = await initWorkflowShell('/players');
  if (!authUser) return;
  applyRoleBasedUI();

  const draft = getPlayerDraft();
  if (draft?.name) {
    playerForm.elements.name.value = draft.name;
  }

  const state = await callApi('/api/state');
  renderPlayers(state.players);
}

init().catch((error) => {
  console.error('Players initialization failed:', error);
  showError(error);
});
