import test from 'node:test';
import assert from 'node:assert/strict';
import {
  money,
  todayIST,
  openingDate,
  validatePayment,
  validateWinner,
  DEFAULT_DRAW_TERMS,
} from './drawWorkflow.js';

test('money rejects non-finite, negative, oversized and fractional-paisa amounts', () => {
  for (const value of [
    NaN,
    Infinity,
    -1,
    0,
    '1.001',
    '1e3',
    ' ',
    '10000000000000',
  ])
    assert.throws(() => money(value));
  assert.equal(money('0.01'), 0.01);
  assert.equal(money('12345.67'), 12345.67);
});
test('schedule uses India calendar boundaries and validates real dates', () => {
  const now = new Date('2026-09-17T19:00:00Z');
  assert.equal(todayIST(now), '2026-09-18');
  assert.equal(openingDate(null, 10, now), '2026-09-28');
  assert.equal(openingDate(null, 25, now), '2026-10-13');
  assert.equal(openingDate('2026-10-01', 10, now), '2026-10-01');
  for (const date of ['2026-09-17', '2026-02-30', 'invalid'])
    assert.throws(() => openingDate(date, 10, now));
  assert.throws(() => openingDate(null, 11, now));
});
test('non-cash payments require traceable references', () => {
  assert.equal(validatePayment({ amount: '500', payment_from: 'CASH' }), 500);
  assert.throws(
    () => validatePayment({ amount: 500, payment_from: 'UPI' }),
    /reference/,
  );
  assert.throws(
    () => validatePayment({ amount: 500, payment_from: 'CHEQUE' }),
    /Cheque/,
  );
  assert.equal(
    validatePayment({
      amount: 500,
      payment_from: 'UPI',
      bank_details: 'UTR-123',
    }),
    500,
  );
  assert.throws(
    () => validatePayment({ amount: 500, payment_date: '2099-01-01' }),
    /date/,
  );
});
test('physical result gate rejects early, wrong, unpaid, revoked or unverified entries', () => {
  const reg = {
    status: 'SLIP_ISSUED',
    draw_opening_date: '2026-09-18',
    slip_no: 'SLIP-2026-000001',
    required_amount: '1000',
  };
  const args = {
    total: 1000,
    kycStatus: 'VERIFIED',
    slipNumber: reg.slip_no,
    now: new Date('2026-09-18T03:00:00Z'),
  };
  assert.doesNotThrow(() => validateWinner(reg, args));
  assert.throws(
    () =>
      validateWinner(reg, { ...args, now: new Date('2026-09-17T03:00:00Z') }),
    /opening date/,
  );
  assert.throws(
    () => validateWinner(reg, { ...args, slipNumber: 'SLIP-2026-000002' }),
    /exact slip/,
  );
  assert.throws(
    () => validateWinner(reg, { ...args, total: 999 }),
    /fully paid/,
  );
  assert.throws(
    () => validateWinner(reg, { ...args, kycStatus: 'REJECTED' }),
    /KYC/,
  );
  assert.throws(
    () => validateWinner({ ...reg, status: 'CANCELLED' }, args),
    /issued/,
  );
  assert.throws(
    () => validateWinner({ ...reg, draw_opening_date: null }, args),
    /opening date/,
  );
});
test('editable terms fit the two-page document allowance', () =>
  assert.ok(DEFAULT_DRAW_TERMS.length <= 4500));
