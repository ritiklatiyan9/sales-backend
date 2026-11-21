import { validatePayment, workflowError } from './drawWorkflow.js';

const TEXT_COLUMNS = { bank_name: 150, branch: 150, bank_details: 255, cheque_no: 50, received_by: 255, narration: Infinity };
const PAYMENT_COLUMNS = ['amount', 'payment_date', 'payment_from', 'bank_account_id', ...Object.keys(TEXT_COLUMNS)];

export async function editedDrawPayment(body, payment, siteId, db) {
  if (!body || !PAYMENT_COLUMNS.some(column => Object.hasOwn(body, column))) throw workflowError('Nothing to update');
  const patch = Object.fromEntries(PAYMENT_COLUMNS.map(column => [column, Object.hasOwn(body, column) ? body[column] : payment[column]]));
  for (const [column, max] of Object.entries(TEXT_COLUMNS)) {
    if (!Object.hasOwn(body, column)) continue;
    const value = patch[column];
    if (value != null && (typeof value !== 'string' || value.length > max)) {
      throw workflowError(`Invalid ${column.replaceAll('_', ' ')}`);
    }
    patch[column] = value?.trim() || null;
  }
  if (!patch.payment_date) throw workflowError('Payment date is required');
  patch.payment_from ||= 'CASH';
  patch.amount = validatePayment(patch);
  const changedMode = patch.payment_from !== (payment.payment_from || 'CASH');
  if (patch.payment_from !== 'CHEQUE' && (changedMode || Object.hasOwn(body, 'cheque_no'))) patch.cheque_no = null;
  if (patch.payment_from === 'CASH') {
    for (const field of ['bank_account_id', 'bank_name', 'branch', 'bank_details']) {
      if (changedMode || Object.hasOwn(body, field)) patch[field] = null;
    }
    return patch;
  }
  if (patch.bank_account_id == null || patch.bank_account_id === '') {
    patch.bank_account_id = null;
    return patch;
  }

  patch.bank_account_id = Number(patch.bank_account_id);
  if (!Number.isInteger(patch.bank_account_id) || patch.bank_account_id < 1 || patch.bank_account_id > 2147483647) {
    throw workflowError('Choose an active bank account of this site', 409);
  }
  if (patch.bank_account_id !== payment.bank_account_id) {
    const { rows: [bank] } = await db.query('SELECT name FROM bank_accounts WHERE id=$1 AND site_id=$2 AND is_active IS NOT FALSE', [patch.bank_account_id, siteId]);
    if (!bank) throw workflowError('Choose an active bank account of this site', 409);
    patch.bank_name = bank.name;
  } else {
    patch.bank_name = payment.bank_name;
  }
  return patch;
}

export async function drawPaymentAccounting(db, actorId) {
  const { rows: [accounting] } = await db.query(`
    SELECT set_config('app.current_user_id', $1, true),
      to_regprocedure('delete_draw_payment_with_accounting(integer,integer,integer)') IS NOT NULL AS can_delete,
      to_regprocedure('update_draw_payment_with_accounting(integer,integer,integer,jsonb)') IS NOT NULL AS can_update,
      to_regclass('pool_money_receipts') IS NOT NULL AS has_pool_money
  `, [String(actorId)]);
  return accounting;
}

async function ensureUnrecorded(db, accounting, paymentId, operation) {
  if (!accounting.has_pool_money) return;
  const { rows: [linked] } = await db.query("SELECT 1 FROM pool_money_receipts WHERE source_kind='draw' AND source_id=$1", [paymentId]);
  if (linked) throw workflowError(`Install the Accounting draw receipt update before ${operation} this receipt.`, 409);
}

export async function removeDrawPayment(db, accounting, { registrationId, paymentId, actorId }) {
  if (accounting.can_delete) {
    const { rows: [{ deleted }] } = await db.query('SELECT delete_draw_payment_with_accounting($1,$2,$3) AS deleted', [registrationId, paymentId, actorId]);
    if (!deleted) throw workflowError('Payment not found on this registration.', 404);
    return;
  }
  await ensureUnrecorded(db, accounting, paymentId, 'deleting');
  await db.query('DELETE FROM draw_payments WHERE id=$1 AND draw_registration_id=$2', [paymentId, registrationId]);
}

export async function saveDrawPaymentEdit(db, accounting, { registrationId, paymentId, actorId, patch }) {
  if (accounting.can_update) {
    const { rows: [{ updated }] } = await db.query('SELECT update_draw_payment_with_accounting($1,$2,$3,$4::jsonb) AS updated', [registrationId, paymentId, actorId, JSON.stringify(patch)]);
    if (!updated) throw workflowError('Payment not found on this registration.', 404);
    return;
  }
  await ensureUnrecorded(db, accounting, paymentId, 'editing');
  await db.query(`UPDATE draw_payments SET ${PAYMENT_COLUMNS.map((column, index) => `${column}=$${index + 3}`).join(', ')}
    WHERE id=$1 AND draw_registration_id=$2`, [paymentId, registrationId, ...PAYMENT_COLUMNS.map(column => patch[column])]);
}

export function drawPaymentMutationError(error) {
  if (['draw_payment_delete_conflict', 'draw_payment_edit_conflict', 'pool_money_receipt_locked', 'pool_money_period_locked', 'cash_wallet_collector_locked', 'loyalty_vault_holder_funds'].includes(error.constraint)) {
    return workflowError(error.message, 409);
  }
  if (error.code === '23503') return workflowError('A posted Accounting entry uses this receipt. Reverse that entry in Accounting before changing the receipt.', 409);
  return error;
}
