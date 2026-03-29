import {
  callApi,
  clearSetupDraft,
  getSetupDraft,
  initWorkflowShell,
  navigateTo,
  setSetupDraft,
  showError,
} from '/static/workflow-common.js';
import { createPayoutController } from '/static/payouts.js';

const leagueForm = document.getElementById('league-form');
const leagueState = document.getElementById('league-state');
const defaultPayouts = document.getElementById('default-payouts');
const defaultPayoutTotal = document.getElementById('default-payout-total');
const addDefaultPayoutBtn = document.getElementById('add-default-payout');

let suppressDraftSync = false;
let authUser = { username: '', role: 'viewer' };

function getPrizePool() {
  const fee = Number(leagueForm.elements.entry_fee.value);
  const players = Number(leagueForm.elements.active_player_count.value);
  if (!Number.isFinite(fee) || !Number.isFinite(players) || fee <= 0 || players <= 0) return 0;
  return fee * players;
}

const payoutController = createPayoutController({
  container: defaultPayouts,
  totalTarget: defaultPayoutTotal,
  getPrizePool,
  onChange: persistDraft,
});

function applyRoleBasedUI() {
  const isAdmin = authUser.role === 'admin';
  const controls = leagueForm.querySelectorAll('input, select, textarea, button');
  controls.forEach((control) => {
    control.disabled = !isAdmin;
  });
}

function getDraftPayload() {
  return {
    name: String(leagueForm.elements.name.value || ''),
    tournament: String(leagueForm.elements.tournament.value || ''),
    entry_fee: String(leagueForm.elements.entry_fee.value || ''),
    active_player_count: String(leagueForm.elements.active_player_count.value || ''),
    payouts: payoutController.collectRows(),
  };
}

function persistDraft() {
  if (suppressDraftSync) return;
  setSetupDraft({
    dirty: true,
    ...getDraftPayload(),
  });
}

function setLeagueStateText(league) {
  if (!league) {
    leagueState.textContent = 'No league configured yet. Fill setup and save.';
    return;
  }

  leagueState.textContent = `${league.name} | ${league.tournament} | Entry Fee: ${league.entry_fee} | Players: ${league.active_player_count || '-'} | Winners: ${league.default_winner_count}`;
}

function renderLeague(league) {
  const draft = getSetupDraft();
  const source = draft && draft.dirty ? draft : league;

  suppressDraftSync = true;

  leagueForm.elements.name.value = source?.name || '';
  leagueForm.elements.tournament.value = source?.tournament || 'IPL';
  leagueForm.elements.entry_fee.value = source?.entry_fee || 100;
  leagueForm.elements.active_player_count.value = source?.active_player_count || 5;

  if (source?.payouts && Object.keys(source.payouts).length) {
    payoutController.setRows(source.payouts);
  } else {
    payoutController.setRows({ 1: getPrizePool() || '' });
  }

  payoutController.updateTotal();
  setLeagueStateText(league);
  suppressDraftSync = false;
}

addDefaultPayoutBtn.addEventListener('click', () => {
  payoutController.createRow('');
});

leagueForm.elements.entry_fee.addEventListener('input', () => {
  payoutController.updateTotal();
  persistDraft();
});

leagueForm.elements.active_player_count.addEventListener('input', () => {
  payoutController.updateTotal();
  persistDraft();
});

leagueForm.elements.name.addEventListener('input', persistDraft);
leagueForm.elements.tournament.addEventListener('input', persistDraft);

leagueForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (authUser.role !== 'admin') {
    showError('Only admin can update league settings.');
    return;
  }

  try {
    const formData = new FormData(leagueForm);
    const payouts = payoutController.collectRows();
    const defaultWinnerCount = Object.keys(payouts).length;
    const entryFee = Number(formData.get('entry_fee'));
    const activePlayerCount = Number(formData.get('active_player_count'));

    if (!defaultWinnerCount) {
      throw new Error('Add at least one winner payout.');
    }

    const payoutTotal = Object.values(payouts).reduce((sum, value) => sum + Number(value), 0);
    const prizePool = entryFee * activePlayerCount;
    if (Math.abs(payoutTotal - prizePool) >= 0.01) {
      throw new Error(`Winner payout total (${payoutTotal.toFixed(2)}) must match prize pool (${prizePool.toFixed(2)}).`);
    }

    await callApi('/api/league', {
      method: 'POST',
      body: JSON.stringify({
        name: String(formData.get('name') || ''),
        tournament: String(formData.get('tournament') || ''),
        entry_fee: entryFee,
        active_player_count: activePlayerCount,
        default_winner_count: defaultWinnerCount,
        payouts,
      }),
    });

    clearSetupDraft();
    navigateTo('/players');
  } catch (error) {
    showError(error);
  }
});

async function init() {
  authUser = await initWorkflowShell('/setup');
  if (!authUser) return;
  applyRoleBasedUI();
  const state = await callApi('/api/state');
  renderLeague(state.league);
}

init().catch((error) => {
  console.error('Setup initialization failed:', error);
  showError(error);
});
