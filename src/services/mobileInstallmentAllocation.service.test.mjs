import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateInstallmentPayments } from './mobileInstallmentAllocation.service.js';

const schedule = [
  { id: 1, installment_name: 'Booking', amount: 100, due_date: '2026-01-01' },
  { id: 2, installment_name: 'Installment 2', amount: 100, due_date: '2026-02-01' },
  { id: 3, installment_name: 'Installment 3', amount: 100, due_date: '2027-03-01' },
];

test('canonical plot payments waterfall through the installment schedule', () => {
  const result = allocateInstallmentPayments(schedule, {
    genericPaid: 150,
    asOf: new Date('2026-06-01'),
  });

  assert.deepEqual(result.installments.map((row) => row.paid), [100, 50, 0]);
  assert.deepEqual(result.installments.map((row) => row.remaining), [0, 50, 100]);
  assert.deepEqual(result.installments.map((row) => row.status), ['paid', 'overdue', 'pending']);
  assert.equal(result.totalRemaining, 150);
});

test('direct legacy receipts claim their installment before generic waterfall', () => {
  const result = allocateInstallmentPayments(schedule, {
    genericPaid: 150,
    directPaidByInstallment: { 2: 75 },
    asOf: new Date('2026-06-01'),
  });

  assert.deepEqual(result.installments.map((row) => row.paid), [100, 100, 25]);
  assert.deepEqual(result.installments.map((row) => row.direct_paid), [0, 75, 0]);
  assert.deepEqual(result.installments.map((row) => row.waterfall_paid), [100, 25, 25]);
});

test('overpayments are reported as unapplied and never overfill an installment', () => {
  const result = allocateInstallmentPayments(schedule, { genericPaid: 350 });

  assert.deepEqual(result.installments.map((row) => row.paid), [100, 100, 100]);
  assert.equal(result.unapplied, 50);
  assert.equal(result.totalPaid, 300);
  assert.equal(result.totalRemaining, 0);
});

test('invalid and negative totals are safely treated as zero', () => {
  const result = allocateInstallmentPayments(schedule, {
    genericPaid: -25,
    directPaidByInstallment: { 1: 'not-a-number' },
    asOf: new Date('2025-01-01'),
  });

  assert.deepEqual(result.installments.map((row) => row.paid), [0, 0, 0]);
  assert.deepEqual(result.installments.map((row) => row.status), ['pending', 'pending', 'pending']);
});
