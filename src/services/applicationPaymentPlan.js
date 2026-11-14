import { workflowError } from './drawWorkflow.js';

const textFields = { title:100, subtitle:180, selected_plan:100, schedule_note:700, rental_title:100, rental_subtitle:180, rental_introduction:700, acknowledgement:700 };
const toggles = ['enabled', 'show_installments', 'show_rental_options', 'show_rental_conditions'];
const detailedTextFields = { grace_title:140, grace_note:700, rental_options_title:140, rental_benefit_heading:140, rental_details_title:140 };
function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw workflowError(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw workflowError(`Unknown ${label} field: ${key}`);
}
function text(value, limit, label) {
  if (typeof value !== 'string' || value.length > limit) throw workflowError(`${label} must contain at most ${limit} characters`);
  return value.trim();
}
function toggle(value, label) {
  if (typeof value !== 'boolean') throw workflowError(`${label} must be on or off`);
  return value;
}
function amount(value, label) {
  if (typeof value !== 'string' || (value !== '' && !/^\d{1,12}(\.\d{1,2})?$/.test(value))) throw workflowError(`${label} must be a non-negative amount with up to two decimal places, or blank`);
  return value;
}
export function validateApplicationPaymentPlan(value) {
  object(value, [...Object.keys(textFields), ...Object.keys(detailedTextFields), ...toggles, 'overview_only', 'show_payout_details', 'booking_deposit', 'installments', 'rental_options', 'rental_clauses', 'layout', 'grace_days', 'grace_clauses', 'payout_fields'], 'payment plan');
  const out = {};
  for (const [key, limit] of Object.entries(textFields)) out[key] = text(value[key], limit, key);
  for (const key of toggles) out[key] = toggle(value[key], key);
  for (const key of ['overview_only', 'show_payout_details']) if (value[key] != null) out[key] = toggle(value[key], key);
  out.booking_deposit = amount(value.booking_deposit, 'Booking deposit');
  const arrays = { installments:8, rental_options:3, rental_clauses:5 };
  for (const [key, limit] of Object.entries(arrays)) if (!Array.isArray(value[key]) || value[key].length > limit) throw workflowError(`Use up to ${limit} ${key}`);
  out.installments = value.installments.map(row => {
    object(row, ['enabled', 'milestone', 'due_date', 'particulars', 'amount'], 'installment');
    const date = text(row.due_date, 10, 'Installment due date');
    if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T12:00:00Z`)) || new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date)) throw workflowError('Choose a valid installment due date');
    return { enabled:toggle(row.enabled, 'Installment visibility'), milestone:text(row.milestone, 140, 'Installment milestone'), due_date:date, particulars:text(row.particulars, 300, 'Payment particulars'), amount:amount(row.amount, 'Installment amount') };
  });
  out.rental_options = value.rental_options.map(row => {
    object(row, ['option', 'timeline', 'benefit'], 'rental option');
    return { option:text(row.option, 100, 'Payment option'), timeline:text(row.timeline, 180, 'Completion timeline'), benefit:text(row.benefit, 400, 'Rental benefit') };
  });
  out.rental_clauses = value.rental_clauses.map(row => {
    object(row, ['title', 'body'], 'rental clause');
    return { title:text(row.title, 140, 'Rental clause heading'), body:text(row.body, 900, 'Rental clause wording') };
  });
  if (value.layout != null) {
    if (!['standard', 'detailed'].includes(value.layout)) throw workflowError('Choose a supported payment layout');
    out.layout = value.layout;
  }
  if (value.grace_days != null) {
    if (!Number.isInteger(value.grace_days) || value.grace_days < 0 || value.grace_days > 90) throw workflowError('Grace period must be 0 to 90 calendar days');
    out.grace_days = value.grace_days;
  }
  for (const [key, limit] of Object.entries(detailedTextFields)) if (value[key] != null) out[key] = text(value[key], limit, key);
  if (value.grace_clauses != null) {
    if (!Array.isArray(value.grace_clauses) || value.grace_clauses.length > 5) throw workflowError('Use up to five grace clauses');
    out.grace_clauses = value.grace_clauses.map(row => {
      object(row, ['title', 'body'], 'grace clause');
      return { title:text(row.title, 140, 'Grace clause heading'), body:text(row.body, 900, 'Grace clause wording') };
    });
  }
  if (value.payout_fields != null) {
    if (!Array.isArray(value.payout_fields) || value.payout_fields.length > 8) throw workflowError('Use up to eight payout fields');
    out.payout_fields = value.payout_fields.map(row => {
      object(row, ['label', 'value'], 'payout');
      return { label:text(row.label, 140, 'Payout field label'), value:text(row.value, 300, 'Payout field value') };
    });
  }
  if (out.layout === 'detailed' && (!Number.isInteger(out.grace_days) || !out.grace_clauses || !out.payout_fields)) throw workflowError('Complete the detailed payment plan fields');
  return out;
}
