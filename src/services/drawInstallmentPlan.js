import { money, validDate, workflowError } from './drawWorkflow.js';

const TYPES = new Set(['per_day', 'per_month', 'per_quarter', 'per_year']);
const PENALTY_TYPES = new Set(['per_day', 'per_week', 'per_month', 'percentage']);

function nonNegativeNumber(value, label) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0 || number > 1000) throw workflowError(`${label} must be between 0 and 1000`);
  return number;
}

function nonNegativeDays(value, label, fallback = 0) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 0 || number > 3650) throw workflowError(`${label} must be between 0 and 3650 days`);
  return number;
}

/** The same 25% booking anchor and full-price schedule used by Accounting. */
export function validateDrawInstallmentPlan(salePrice, bookingDate, installments, rawSettings = {}) {
  rawSettings = rawSettings || {};
  const salePaise = Math.round(money(salePrice, 'Unit sale price') * 100);
  if (!Array.isArray(installments) || installments.length < 2 || installments.length > 120) {
    throw workflowError('Create between 2 and 120 complete installments before allotment');
  }
  const firstPaise = Math.round(salePaise * 0.25);
  let scheduledPaise = 0;
  let previousDate = bookingDate;
  const rows = installments.map((row, index) => {
    const amount = money(row?.amount, `Installment ${index + 1} amount`);
    const dueDate = row?.due_date;
    if (!validDate(dueDate) || dueDate < previousDate) {
      throw workflowError(`Installment ${index + 1} needs a valid due date on or after the previous installment`);
    }
    const name = String(row?.installment_name || `Installment ${index + 1}`).trim();
    if (!name || name.length > 255) throw workflowError(`Installment ${index + 1} name must be 1–255 characters`);
    previousDate = dueDate;
    scheduledPaise += Math.round(amount * 100);
    return { installment_name: name, amount, due_date: dueDate };
  });
  if (rows[0].due_date !== bookingDate || Math.round(rows[0].amount * 100) !== firstPaise) {
    throw workflowError('Installment 1 must be 25% of the sale price on the booking date');
  }
  if (scheduledPaise !== salePaise) throw workflowError('The installment schedule must cover the full sale price');

  const settings = {
    installments_enabled: true,
    interest_enabled: rawSettings.interest_enabled === true,
    interest_rate: nonNegativeNumber(rawSettings.interest_rate, 'Interest rate'),
    interest_type: rawSettings.interest_type || 'per_month',
    grace_period_days: nonNegativeDays(rawSettings.grace_period_days, 'Bench period', 15),
    penalty_enabled: rawSettings.penalty_enabled === true,
    penalty_rate: nonNegativeNumber(rawSettings.penalty_rate, 'Penalty rate'),
    penalty_type: rawSettings.penalty_type || 'per_day',
    free_to_sale_days: nonNegativeDays(rawSettings.free_to_sale_days, 'Free to sale period'),
  };
  if (!TYPES.has(settings.interest_type)) throw workflowError('Select a valid interest period');
  if (!PENALTY_TYPES.has(settings.penalty_type)) throw workflowError('Select a valid penalty period');
  if (!settings.interest_enabled) settings.interest_rate = 0;
  if (!settings.penalty_enabled) settings.penalty_rate = 0;
  return { firstInstallment: firstPaise / 100, rows, settings };
}
