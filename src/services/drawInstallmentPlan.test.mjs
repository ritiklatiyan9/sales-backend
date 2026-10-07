import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDrawInstallmentPlan } from './drawInstallmentPlan.js';

const bookingDate = '2026-09-26';
const rows = [
  { installment_name: 'Installment 1 · Booking', amount: '250000.00', due_date: bookingDate },
  { installment_name: 'Installment 2', amount: '750000.00', due_date: '2027-09-26' },
];

test('draw installment plan uses Accounting’s booking anchor and full sale price', () => {
  const plan = validateDrawInstallmentPlan(1000000, bookingDate, rows, {
    interest_enabled: true, interest_rate: 12, interest_type: 'per_year',
    grace_period_days: 15, penalty_enabled: true, penalty_rate: 10,
    penalty_type: 'per_day', free_to_sale_days: 30,
  });
  assert.equal(plan.firstInstallment, 250000);
  assert.equal(plan.rows.length, 2);
  assert.equal(plan.settings.interest_rate, 12);
  assert.equal(plan.settings.free_to_sale_days, 30);
});

test('draw installment plan rejects incomplete, misdated, and underfunded schedules', () => {
  assert.throws(() => validateDrawInstallmentPlan(1000000, bookingDate, []), /between 2 and 120/);
  assert.throws(() => validateDrawInstallmentPlan(1000000, bookingDate, [{ ...rows[0], amount: 200000 }, rows[1]]), /25%/);
  assert.throws(() => validateDrawInstallmentPlan(1000000, bookingDate, [rows[0], { ...rows[1], amount: 700000 }]), /full sale price/);
  assert.throws(() => validateDrawInstallmentPlan(1000000, bookingDate, [rows[0], { ...rows[1], due_date: '2026-09-25' }]), /due date/);
  assert.throws(() => validateDrawInstallmentPlan(1000000, bookingDate, rows, { penalty_rate: -1 }), /Penalty rate/);
});
