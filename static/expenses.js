import {
  callApi,
  initWorkflowShell,
  queueToast,
  setButtonLoading,
  showError,
  showLoading,
} from '/static/workflow-common.js';
import { initNotifications } from '/static/notifications.js';

const expensesBody = document.getElementById('expenses-body');
const expensesSummary = document.getElementById('expenses-summary');
const paymentsFeed = document.getElementById('payments-feed');
const addPaymentBtn = document.getElementById('add-payment-btn');
const poolBanner = document.getElementById('pool-integrity-banner');

const paymentModal = document.getElementById('payment-modal');
const paymentForm = document.getElementById('payment-form');
const paymentIdInput = document.getElementById('payment_id');
const paymentPlayerInput = document.getElementById('payment_player');
const paymentDirectionInput = document.getElementById('payment_direction');
const paymentAmountInput = document.getElementById('payment_amount');
const paymentPaidOnInput = document.getElementById('payment_paid_on');
const paymentNoteInput = document.getElementById('payment_note');
const paymentSaveBtn = document.getElementById('payment-save-btn');
const paymentDeleteBtn = document.getElementById('payment-delete-btn');
const paymentModalTitle = document.getElementById('payment-modal-title');

let authUser = { username: '', role: 'read' };
let currentRows = [];
let currentPayments = [];

function isAdmin() {
  return authUser.league_role === 'admin';
}

function fmt(value) {
  return Number(value || 0).toFixed(2);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function statusChip(status, balance) {
  const cls = status === 'settled'
    ? 'status-good'
    : status === 'owes'
      ? 'status-bad'
      : 'status-neutral';
  const label = status === 'settled'
    ? 'Settled'
    : status === 'owes'
      ? `Owes ${fmt(Math.abs(balance))}`
      : `Owed ${fmt(Math.abs(balance))}`;
  return `<span class="status-chip ${cls}">${label}</span>`;
}

function renderSummaryRows(data) {
  expensesBody.innerHTML = '';
  if (!data.rows.length) {
    expensesBody.innerHTML = '<tr><td colspan="8">No players yet.</td></tr>';
    return;
  }
  data.rows.forEach((row) => {
    const tr = document.createElement('tr');
    const balanceClass = row.balance === 0 ? '' : (row.balance > 0 ? 'pos' : 'neg');
    tr.innerHTML = `
      <td>${escapeHtml(row.name)}</td>
      <td>${fmt(row.spent)}</td>
      <td>${fmt(row.won)}</td>
      <td class="${row.net >= 0 ? 'pos' : 'neg'}">${fmt(row.net)}</td>
      <td>${fmt(row.collected)}</td>
      <td>${fmt(row.distributed)}</td>
      <td class="${balanceClass}">${fmt(row.balance)}</td>
      <td>${statusChip(row.status, row.balance)}</td>
    `;
    expensesBody.appendChild(tr);
  });
}

function renderPaymentsFeed(payments) {
  paymentsFeed.innerHTML = '';
  if (!payments.length) {
    paymentsFeed.innerHTML = '<div class="feed-item">No payments recorded yet.</div>';
    return;
  }
  payments.forEach((entry) => {
    const item = document.createElement('div');
    item.className = 'feed-item workflow-feed-item';
    const directionLabel = entry.direction === 'collected' ? 'Collected from' : 'Distributed to';
    const directionTone = entry.direction === 'collected' ? 'status-good' : 'status-neutral';
    const editBtnHtml = isAdmin()
      ? `<button type="button" class="ghost small payment-edit-trigger" data-payment-id="${entry.id}">Edit</button>`
      : '';
    item.innerHTML = `
      <div class="workflow-feed-head">
        <strong>${escapeHtml(entry.player_name || `Player #${entry.player_id}`)}</strong>
        <div class="workflow-chip-row">
          <span class="status-chip ${directionTone}">${directionLabel}</span>
          <span class="status-chip">${fmt(entry.amount)}</span>
          <span class="status-chip">${escapeHtml(entry.paid_on || '—')}</span>
          ${editBtnHtml}
        </div>
      </div>
      ${entry.note ? `<p class="muted small">${escapeHtml(entry.note)}</p>` : ''}
    `;
    const editBtn = item.querySelector('.payment-edit-trigger');
    if (editBtn) {
      editBtn.addEventListener('click', () => openEditModal(entry));
    }
    paymentsFeed.appendChild(item);
  });
}

function populatePlayerSelect() {
  paymentPlayerInput.innerHTML = '';
  currentRows.forEach((row) => {
    const opt = document.createElement('option');
    opt.value = String(row.player_id);
    opt.textContent = `${row.name} (balance ${fmt(row.balance)})`;
    paymentPlayerInput.appendChild(opt);
  });
}

function openCreateModal() {
  if (!isAdmin()) return;
  paymentModalTitle.textContent = 'Record a payment';
  paymentIdInput.value = '';
  populatePlayerSelect();
  paymentDirectionInput.value = 'collected';
  paymentAmountInput.value = '';
  paymentPaidOnInput.value = new Date().toISOString().slice(0, 10);
  paymentNoteInput.value = '';
  paymentDeleteBtn.classList.add('hidden');
  showModal();
}

function openEditModal(entry) {
  if (!isAdmin()) return;
  paymentModalTitle.textContent = 'Edit payment';
  paymentIdInput.value = String(entry.id);
  populatePlayerSelect();
  paymentPlayerInput.value = String(entry.player_id);
  paymentPlayerInput.disabled = true;
  paymentDirectionInput.value = entry.direction;
  paymentAmountInput.value = String(entry.amount);
  paymentPaidOnInput.value = entry.paid_on || '';
  paymentNoteInput.value = entry.note || '';
  paymentDeleteBtn.classList.remove('hidden');
  showModal();
}

function showModal() {
  paymentModal.classList.remove('hidden');
  paymentModal.setAttribute('aria-hidden', 'false');
}

function closeModal() {
  paymentModal.classList.add('hidden');
  paymentModal.setAttribute('aria-hidden', 'true');
  paymentPlayerInput.disabled = false;
}

function renderPoolIntegrity(rows) {
  if (!poolBanner) return;
  const totals = rows.reduce(
    (acc, row) => {
      acc.spent += Number(row.spent || 0);
      acc.won += Number(row.won || 0);
      return acc;
    },
    { spent: 0, won: 0 },
  );
  const drift = Math.round((totals.won - totals.spent) * 100) / 100;
  if (Math.abs(drift) < 0.01) {
    poolBanner.classList.add('hidden');
    poolBanner.textContent = '';
    return;
  }
  poolBanner.classList.remove('hidden');
  const direction = drift > 0
    ? `payouts exceed collections by ${fmt(Math.abs(drift))}`
    : `collections exceed payouts by ${fmt(Math.abs(drift))}`;
  poolBanner.innerHTML = `<strong>Pool integrity warning:</strong> total Won (${fmt(totals.won)}) ≠ total Spent (${fmt(totals.spent)}); ${direction}. Sum of "Owed" minus "Owes" will not be zero. Future winner saves are now blocked from over-distributing, but historical matches may need to be re-saved with corrected payouts.`;
}

async function refresh() {
  const data = await callApi('/api/settlements');
  currentRows = data.rows || [];
  currentPayments = data.payments || [];
  expensesSummary.textContent = `Completed matches: ${data.completed_matches} | Entry fee: ${fmt(data.entry_fee)} | Balance = Net + Collected − Distributed.`;
  renderSummaryRows(data);
  renderPaymentsFeed(currentPayments);
  renderPoolIntegrity(currentRows);
}

async function handleSave() {
  const playerId = Number(paymentPlayerInput.value);
  const direction = paymentDirectionInput.value;
  const amount = Number(paymentAmountInput.value);
  const paidOn = paymentPaidOnInput.value || null;
  const note = paymentNoteInput.value.trim() || null;
  const editingId = paymentIdInput.value ? Number(paymentIdInput.value) : null;

  if (!Number.isFinite(playerId) || playerId <= 0) {
    showError('Please choose a player.');
    return;
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    showError('Amount must be greater than zero.');
    return;
  }

  let restore = null;
  let closeLoading = null;
  try {
    restore = setButtonLoading(paymentSaveBtn, 'Saving...');
    closeLoading = showLoading('Saving payment...');
    if (editingId) {
      await callApi(`/api/settlements/${editingId}`, {
        method: 'PATCH',
        body: JSON.stringify({ direction, amount, paid_on: paidOn, note }),
      });
      queueToast('Payment updated.');
    } else {
      await callApi('/api/settlements', {
        method: 'POST',
        body: JSON.stringify({ player_id: playerId, direction, amount, paid_on: paidOn, note }),
      });
      queueToast('Payment recorded.');
    }
    closeModal();
    await refresh();
  } catch (error) {
    showError(error);
  } finally {
    if (restore) restore();
    if (closeLoading) closeLoading();
  }
}

async function handleDelete() {
  const editingId = paymentIdInput.value ? Number(paymentIdInput.value) : null;
  if (!editingId) return;
  if (!window.confirm('Delete this payment entry? This cannot be undone.')) return;

  let restore = null;
  let closeLoading = null;
  try {
    restore = setButtonLoading(paymentDeleteBtn, 'Deleting...');
    closeLoading = showLoading('Deleting payment...');
    await callApi(`/api/settlements/${editingId}`, { method: 'DELETE' });
    queueToast('Payment deleted.');
    closeModal();
    await refresh();
  } catch (error) {
    showError(error);
  } finally {
    if (restore) restore();
    if (closeLoading) closeLoading();
  }
}

if (paymentModal) {
  paymentModal.querySelectorAll('[data-close-payment-modal]').forEach((el) => {
    el.addEventListener('click', closeModal);
  });
  paymentSaveBtn.addEventListener('click', handleSave);
  paymentDeleteBtn.addEventListener('click', handleDelete);
  paymentForm.addEventListener('submit', (event) => {
    event.preventDefault();
    handleSave();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !paymentModal.classList.contains('hidden')) {
      closeModal();
    }
  });
}

addPaymentBtn?.addEventListener('click', openCreateModal);

async function init() {
  initNotifications();
  authUser = await initWorkflowShell('/expenses');
  if (!authUser) return;
  if (isAdmin()) {
    addPaymentBtn.classList.remove('hidden');
  }
  await refresh();
}

init().catch((error) => {
  console.error('Expenses initialization failed:', error);
  showError(error);
});
