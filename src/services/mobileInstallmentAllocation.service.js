const money = (value) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const directAmountFor = (directPaidByInstallment, installmentId) => {
  if (directPaidByInstallment instanceof Map) {
    return money(directPaidByInstallment.get(installmentId)
      ?? directPaidByInstallment.get(String(installmentId)));
  }
  return money(directPaidByInstallment?.[installmentId]
    ?? directPaidByInstallment?.[String(installmentId)]);
};

/**
 * Allocate receipts to an installment schedule without mutating database rows.
 *
 * Direct, legacy plot_installment_payments claim their linked installment first.
 * Canonical plot_payments then waterfall through the still-unpaid amount in the
 * supplied schedule order. Every installment-facing screen uses this function
 * so tracker, reminders, and analytics cannot disagree about a balance.
 */
export const allocateInstallmentPayments = (
  installments,
  { genericPaid = 0, directPaidByInstallment = {}, asOf = new Date() } = {}
) => {
  let waterfallPool = Math.max(money(genericPaid), 0);
  const asOfDate = asOf instanceof Date ? asOf : new Date(asOf);

  const rows = (installments || []).map((installment) => {
    const amount = Math.max(money(installment.amount), 0);
    const directPaid = Math.max(directAmountFor(directPaidByInstallment, installment.id), 0);
    const directApplied = Math.min(directPaid, amount);
    const stillNeeded = Math.max(amount - directApplied, 0);
    const waterfallPaid = Math.min(waterfallPool, stillNeeded);
    waterfallPool = Math.max(waterfallPool - waterfallPaid, 0);

    const paid = Math.min(directApplied + waterfallPaid, amount);
    const remaining = Math.max(amount - paid, 0);
    const dueDate = new Date(installment.due_date);
    const overdue = remaining > 0
      && !Number.isNaN(dueDate.getTime())
      && dueDate < asOfDate;

    let status = 'pending';
    if (amount > 0 && paid >= amount) status = 'paid';
    else if (overdue) status = 'overdue';
    else if (paid > 0) status = 'partially_paid';

    return {
      ...installment,
      paid,
      paid_amount: paid,
      remaining,
      remaining_amount: remaining,
      status,
      direct_paid: directApplied,
      waterfall_paid: waterfallPaid,
    };
  });

  return {
    installments: rows,
    unapplied: waterfallPool,
    totalPaid: rows.reduce((sum, row) => sum + row.paid, 0),
    totalRemaining: rows.reduce((sum, row) => sum + row.remaining, 0),
  };
};

export const sumDirectPayments = (installments, directPaidByInstallment = {}) =>
  (installments || []).reduce(
    (sum, installment) => sum + Math.max(directAmountFor(directPaidByInstallment, installment.id), 0),
    0
  );

