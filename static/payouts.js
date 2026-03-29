const RANK_ICONS = ['🥇', '🥈', '🥉', '🏅', '🎖️', '🏆'];

export function rankIcon(rank) {
  if (rank <= RANK_ICONS.length) return RANK_ICONS[rank - 1];
  return '🏅';
}

export function createPayoutController({
  container,
  totalTarget,
  getPrizePool = null,
  onChange = null,
}) {
  function getTotal() {
    return [...container.querySelectorAll('.payout-amount')]
      .map((input) => Number(input.value))
      .filter((value) => Number.isFinite(value) && value >= 0)
      .reduce((sum, value) => sum + value, 0);
  }

  function updateTotal() {
    if (!totalTarget) return;

    const total = getTotal();
    const winners = container.querySelectorAll('.payout-row').length;

    if (typeof getPrizePool === 'function') {
      const prizePool = Number(getPrizePool()) || 0;
      const delta = Math.abs(prizePool - total);
      const status = delta < 0.01 ? 'Matched' : `Difference: ${(total - prizePool).toFixed(2)}`;
      totalTarget.textContent = `Total payout: ${total.toFixed(2)} | Prize pool: ${prizePool.toFixed(2)} | ${status}`;
      totalTarget.classList.toggle('payout-match', delta < 0.01);
      totalTarget.classList.toggle('payout-mismatch', delta >= 0.01);
    } else {
      totalTarget.textContent = `Total payout: ${total.toFixed(2)} across ${winners} winner${winners === 1 ? '' : 's'}`;
      totalTarget.classList.remove('payout-match', 'payout-mismatch');
    }
  }

  function renumberRows() {
    const rows = [...container.querySelectorAll('.payout-row')];
    rows.forEach((row, index) => {
      const rank = index + 1;
      row.dataset.rank = String(rank);
      const icon = row.querySelector('.rank-icon');
      const text = row.querySelector('.rank-text');
      if (icon) icon.textContent = rankIcon(rank);
      if (text) text.textContent = `W${rank}`;
    });
    updateTotal();
    if (typeof onChange === 'function') onChange();
  }

  function createRow(amount = '') {
    const row = document.createElement('div');
    row.className = 'payout-row';

    const label = document.createElement('div');
    label.className = 'payout-rank-display';

    const icon = document.createElement('span');
    icon.className = 'rank-icon';

    const text = document.createElement('span');
    text.className = 'rank-text';

    label.appendChild(icon);
    label.appendChild(text);

    const amountInput = document.createElement('input');
    amountInput.type = 'number';
    amountInput.min = '0';
    amountInput.step = '0.01';
    amountInput.placeholder = 'Winning amount';
    amountInput.className = 'payout-amount';
    amountInput.value = amount;
    amountInput.addEventListener('input', () => {
      updateTotal();
      if (typeof onChange === 'function') onChange();
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'remove';
    removeBtn.textContent = '🗑️';
    removeBtn.title = 'Remove payout winner';
    removeBtn.setAttribute('aria-label', 'Remove payout winner');
    removeBtn.addEventListener('click', () => {
      row.remove();
      renumberRows();
    });

    row.appendChild(label);
    row.appendChild(amountInput);
    row.appendChild(removeBtn);
    container.appendChild(row);
    renumberRows();
    return row;
  }

  function setRows(payouts) {
    container.innerHTML = '';
    const entries = Object.entries(payouts || {})
      .map(([rank, amount]) => ({ rank: Number(rank), amount: Number(amount) }))
      .filter((entry) => Number.isFinite(entry.rank) && Number.isFinite(entry.amount))
      .sort((a, b) => a.rank - b.rank);

    if (!entries.length) {
      createRow('');
      return;
    }

    entries.forEach((entry) => createRow(entry.amount));
  }

  function collectRows() {
    const map = {};
    const rows = [...container.querySelectorAll('.payout-row')];

    rows.forEach((row, index) => {
      const rank = index + 1;
      const amount = Number(row.querySelector('.payout-amount')?.value);
      if (!Number.isFinite(amount) || amount < 0) return;
      map[rank] = amount;
    });

    return map;
  }

  function clear() {
    container.innerHTML = '';
    updateTotal();
    if (typeof onChange === 'function') onChange();
  }

  return {
    createRow,
    setRows,
    collectRows,
    updateTotal,
    clear,
  };
}
