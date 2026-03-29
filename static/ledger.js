import {
  callApi,
  initWorkflowShell,
  showError,
} from '/static/workflow-common.js';

const ledgerBody = document.getElementById('ledger-body');
const ledgerSummary = document.getElementById('ledger-summary');

function renderLedgerRows(data) {
  ledgerBody.innerHTML = '';

  if (!data.rows.length) {
    ledgerBody.innerHTML = '<tr><td colspan="4">No ledger data yet.</td></tr>';
    return;
  }

  data.rows.forEach((row) => {
    const tr = document.createElement('tr');
    const netClass = row.net >= 0 ? 'pos' : 'neg';
    tr.innerHTML = `
      <td>${row.name}</td>
      <td>${row.spent.toFixed(2)}</td>
      <td>${row.won.toFixed(2)}</td>
      <td class="${netClass}">${row.net.toFixed(2)}</td>
    `;
    ledgerBody.appendChild(tr);
  });
}

async function init() {
  const user = await initWorkflowShell('/ledger');
  if (!user) return;

  const ledger = await callApi('/api/ledger');
  ledgerSummary.textContent = `Completed matches: ${ledger.completed_matches} | Entry fee: ${Number(ledger.entry_fee).toFixed(2)} | Net = won - spent.`;
  renderLedgerRows(ledger);
}

init().catch((error) => {
  console.error('Ledger initialization failed:', error);
  showError(error);
});
