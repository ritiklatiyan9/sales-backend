import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import express from 'express';
import { gunzipSync } from 'node:zlib';
import { PGlite } from '@electric-sql/pglite';
import { createMobilePortalService, normalizeMobile, projectMobilePlot } from './mobilePortal.service.js';
import { createMobilePortalRouter, createMobileLoginLimiter } from '../routes/mobilePortal.routes.js';
import { postingPolicySql } from '../test/mobilePostingPolicy.fixture.mjs';

const credentials = { mobile: '9876500001', aadhaar: '234567890123', role: 'client' };
const fixture = async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE sites(id integer PRIMARY KEY,name text);
    CREATE TABLE members(id integer PRIMARY KEY,site_id integer,full_name text,phone text,aadhar_no text,member_type text,member_types text[],is_active boolean DEFAULT true);
    CREATE TABLE booking_client_accounts(id integer PRIMARY KEY,is_active boolean DEFAULT true);
    CREATE TABLE booking_client_members(account_id integer,member_id integer);
    CREATE TABLE plots(id integer PRIMARY KEY,site_id integer,plot_no text,plot_size numeric,sale_price numeric,booking_date date,status text,buyer_member_id integer,buyer_name text,full_payment_due boolean DEFAULT false,full_payment_due_date date);
    CREATE TABLE bookings(id integer PRIMARY KEY,site_id integer,plot_id integer,client_member_id integer,status text);
    CREATE TABLE plot_installments(id integer PRIMARY KEY,plot_id integer,installment_name text,amount numeric,due_date date,sort_order integer,status text DEFAULT 'pending');
    CREATE TABLE plot_payments(id integer PRIMARY KEY,site_id integer,plot_id integer,amount numeric,date date,payment_type text,status text,cheque_status text,reference text);
    CREATE TABLE plot_installment_payments(id integer PRIMARY KEY,plot_id integer,installment_id integer,amount numeric,payment_date date,payment_mode text,status text,cheque_status text,reference text);
    INSERT INTO sites VALUES (1,'Oak Park'),(2,'Lake Estate');
    INSERT INTO members(id,site_id,full_name,phone,aadhar_no,member_type) VALUES
      (1,1,'Example Owner','+91 9876500001','2345 6789 0123','CLIENT'),
      (2,2,'Example Owner','9876500001','234567890123','CLIENT'),
      (3,1,'Another Owner','9876500001','345678901234','CLIENT'),
      (4,1,'Example Owner','9876500002','456789012345','CLIENT');
    INSERT INTO plots(id,site_id,plot_no,plot_size,sale_price,booking_date,status,buyer_member_id,buyer_name) VALUES
      (1,1,'A-01',100,500,'2026-01-01','BOOKED',1,'Example Owner'),
      (2,2,'B-02',200,200,'2026-01-01','BOOKED',NULL,'Example Owner'),
      (3,1,'A-03',100,500,'2026-01-01','BOOKED',NULL,'Example Owner'),
      (4,1,'A-04',100,500,'2026-01-01','BOOKED',3,'Example Owner'),
      (5,1,'A-05',100,500,'2026-01-01','BOOKED',NULL,'Example Owner'),
      (6,1,'A-06',100,500,'2026-01-01','BOOKED',NULL,'Example Owner'),
      (7,1,'A-07',100,500,'2026-01-01','AVAILABLE',1,'Example Owner'),
      (8,1,'A-08',100,500,'2026-01-01','COMPANY',1,'Example Owner');
    UPDATE plots SET full_payment_due=true WHERE id=2;
    INSERT INTO bookings VALUES (1,2,2,2,'CONFIRMED'),(2,1,4,1,'CONFIRMED'),
      (3,1,5,1,'CONFIRMED'),(4,1,5,3,'CONFIRMED'),(5,1,6,1,'CANCELLED');
    INSERT INTO plot_installments(id,plot_id,installment_name,amount,due_date,sort_order) VALUES
      (1,1,'Booking',100,'2026-01-01',1),(2,1,'Second',100,'2026-05-01',2),(3,1,'Final',300,'2027-01-01',3);
    INSERT INTO plot_payments VALUES
      (1,1,1,100,'2026-01-01','BANK','approved',NULL,'BANK-1'),
      (2,1,1,100,'2026-02-01','CASH','approved',NULL,'CASH-1'),
      (3,1,1,50,'2026-03-01','BANK','pending',NULL,'PENDING-CREDIT'),
      (4,1,1,100,'2026-03-01','CHEQUE','approved','UNCLEARED','UNCLEARED'),
      (5,1,1,100,'2026-04-01','CHEQUE','approved','CLEARED','CLEARED'),
      (6,1,1,100,'2026-04-01','CHEQUE','pending','CLEARED','UNAPPROVED'),
      (7,1,1,-25,'2026-05-01','BANK','approved',NULL,'REFUND'),
      (8,1,1,-25,'2026-05-01','BANK','pending',NULL,'PENDING-REFUND'),
      (9,1,1,100,'2026-05-01','BANK','cancelled',NULL,'CANCELLED'),
      (10,1,1,100,'2026-05-01','CHEQUE','approved','BOUNCED','BOUNCED'),
      (11,1,1,100,'0021-05-01','BANK','approved',NULL,'BAD-DATE'),
      (12,2,1,999,'2026-05-01','BANK','approved',NULL,'WRONG-SITE'),
      (13,1,3,999,'2026-05-01','BANK','approved',NULL,'OTHER-PLOT');
    INSERT INTO plot_installment_payments VALUES (1,1,3,25,'2026-06-01','CASH','approved',NULL,'DIRECT-1');
  `);
  await db.exec(postingPolicySql);
  return db;
};

test('mobile customer portal enforces identity and property boundaries with real SQL', async t => {
  const previous = process.env.MOBILE_PORTAL_SECRET;
  process.env.MOBILE_PORTAL_SECRET = 'synthetic-test-only-mobile-portal-secret-32';
  const db = await fixture();
  const queries = [];
  const service = createMobilePortalService({ query: (sql, args) => { queries.push(sql); return db.query(sql, args); } }, { financeCacheMs: 0 });
  t.after(async () => { await db.close(); if (previous === undefined) delete process.env.MOBILE_PORTAL_SECRET; else process.env.MOBILE_PORTAL_SECRET = previous; });
  const login = await service.login(credentials);
  const session = await service.getSession(login.token);

  await t.test('credentials are never returned or placed in JWT payloads; staff tokens are refused', async () => {
    assert.deepEqual(login.user, { id: 'client:1', name: 'Example Owner', role: 'client' });
    const claims = jwt.decode(login.token);
    assert.equal(claims.exp - claims.iat, 3600);
    for (const value of [credentials.mobile, credentials.aadhaar, '2345 6789 0123']) {
      assert.ok(!JSON.stringify(login).includes(value));
      assert.ok(!JSON.stringify(claims).includes(value));
    }
    await assert.rejects(service.getSession(jwt.sign({ id: 1, role: 'admin' }, 'some-staff-signing-key')), { statusCode: 401 });
    await assert.rejects(service.login({ ...credentials, aadhaar: '999999999999' }), { statusCode: 401 });
    await assert.rejects(service.login({ ...credentials, role: 'broker' }), { statusCode: 401 });
  });
  await t.test('only explicit buyers or latest active booking owners across matched projects are visible', async () => {
    const portfolio = await service.portfolio(session);
    assert.deepEqual(portfolio.plots.map(row => row.id), ['1', '2']);
    assert.equal(portfolio.summary.plotCount, 2);
    assert.equal(portfolio.summary.totalAmount, 700);
    for (const id of ['3', '4', '5', '6', '7', '8', '999', '2147483648', '9007199254740991', '1 OR 1=1']) await assert.rejects(service.plot(session, id), { statusCode: 404 });
  });
  await t.test('cash, bank and direct receipts net approved refunds; canceled and uncleared entries do not pay installments', async () => {
    const { plot } = await service.plot(session, '1');
    assert.equal(plot.paidAmount, 350);
    assert.equal(plot.balanceAmount, 150);
    assert.equal(plot.progress, 0.7);
    assert.deepEqual(plot.installments.map(row => row.paidAmount), [100, 100, 150]);
    assert.deepEqual(plot.installments.map(row => row.balanceAmount), [0, 0, 150]);
    assert.equal(plot.nextDueDate, '2027-01-01');
    assert.equal(plot.nextDueAmount, 150);
    assert.equal(plot.payments.length, 6);
    assert.equal(plot.payments.find(row => row.reference === 'REFUND').amount, -25);
    assert.equal(plot.payments.find(row => row.reference === 'REFUND').status, 'refund');
    assert.ok(plot.payments.some(row => row.mode === 'CASH'));
    assert.ok(!plot.payments.some(row => /CANCELLED|BOUNCED|UNCLEARED|UNAPPROVED|BAD-DATE|WRONG-SITE|PENDING-REFUND/.test(row.reference)));
    assert.equal((await service.portfolio(session)).summary.upcomingCount, 2);
  });
  await t.test('full-payment flag does not invent a due date', async () => {
    const { plot } = await service.plot(session, '2');
    assert.equal(plot.paymentPlan.name, 'Full payment');
    assert.equal(plot.installments.length, 1);
    assert.equal(plot.installments[0].dueDate, null);
    assert.equal(plot.installments[0].status, 'upcoming');
    assert.equal(plot.nextDueDate, null);
  });
  await t.test('cancelled milestones do not remove a real posted receipt from the balance', async () => {
    await db.exec(`INSERT INTO plot_installments VALUES (4,1,'Cancelled milestone',25,'2026-01-01',0,'cancelled');
      INSERT INTO plot_installment_payments VALUES (2,1,4,25,'2026-06-01','BANK','approved',NULL,'CANCELLED-MILESTONE-RECEIPT');`);
    const { plot } = await service.plot(session, '1');
    assert.equal(plot.installments.length, 3);
    assert.equal(plot.paidAmount, 375);
    assert.equal(plot.installments.reduce((sum, row) => sum + row.paidAmount, 0), 375);
  });
  await t.test('identity corrections revoke existing access immediately', async () => {
    await db.query("UPDATE members SET aadhar_no='345678901234' WHERE id=1");
    await assert.rejects(service.getSession(login.token), { statusCode: 401 });
    await db.query('UPDATE members SET aadhar_no=$1 WHERE id=1', [credentials.aadhaar]);
  });
  await t.test('all service operations are reads', () => assert.ok(queries.every(sql => /^SELECT\b/i.test(sql))));
});

test('refunds in one receipt bucket cannot overstate installment funding', () => {
  const plot = { id: 1, site_id: 1, sale_price: 200 };
  const schedule = [{ id: 1, amount: 100, due_date: '2027-01-01' }, { id: 2, amount: 100, due_date: '2027-02-01' }];
  for (const receipts of [
    [{ id: 1, amount: 100, installment_id: 1 }, { id: 2, amount: -60 }],
    [{ id: 1, amount: 100 }, { id: 2, amount: -60, installment_id: 2 }],
  ]) {
    const result = projectMobilePlot(plot, schedule, receipts, '2026-10-27');
    assert.equal(result.paidAmount, 40);
    assert.equal(result.balanceAmount, 160);
    assert.equal(result.installments.reduce((sum, row) => sum + row.paidAmount, 0), 40);
  }
  const negative = projectMobilePlot(plot, schedule, [{ amount: -60 }], '2026-10-27');
  assert.equal(negative.paidAmount, -60);
  assert.equal(negative.balanceAmount, 260);
  assert.equal(negative.progress, 0);
  const directOverpayment = projectMobilePlot(plot, schedule, [{ installment_id: 1, amount: 150 }], '2026-10-27');
  assert.deepEqual(directOverpayment.installments.map(row => row.paidAmount), [100, 50]);
  assert.equal(directOverpayment.balanceAmount, 50);
});

test('configured overdue interest matches Accounts and remains separate from principal', () => {
  const plot = { id: 1, site_id: 1, sale_price: 300, interest_enabled: true, interest_rate: 3, interest_type: 'per_month' };
  const schedule = [
    { id: 1, amount: 100, due_date: '2026-09-27' },
    { id: 2, amount: 100, due_date: '2026-10-27' },
    { id: 3, amount: 100, due_date: '2026-11-27' },
  ];
  const result = projectMobilePlot(plot, schedule, [], '2026-10-27');
  assert.deepEqual(result.installments.map(row => row.interestAmount), [3, 0, 0]);
  assert.equal(result.balanceAmount, 300);
  assert.equal(result.interestAmount, 3);
  assert.equal(result.totalDueAmount, 303);
  assert.equal(result.nextDueAmount, 100);
  assert.equal(result.nextDueInterestAmount, 3);
  const partial = projectMobilePlot(plot, schedule, [{ amount: 50 }], '2026-10-27');
  assert.equal(partial.interestAmount, 1.5);
  assert.equal(partial.totalDueAmount, 251.5);
  const paid = projectMobilePlot(plot, schedule, [{ amount: 300 }], '2026-10-27');
  assert.equal(paid.interestAmount, 0);
  assert.equal(paid.totalDueAmount, 0);
  assert.equal(projectMobilePlot({ ...plot, interest_enabled: false }, schedule, [], '2026-10-27').interestAmount, 0);
  assert.equal(projectMobilePlot({ ...plot, interest_type: 'per_year' }, schedule, [], '2026-10-27').interestAmount, 0.25);
});

test('apartment area uses the Accounts square-foot unit while plots use square yards', () => {
  assert.equal(projectMobilePlot({ unit_type: 'flat', plot_size: 1200 }, [], []).areaUnit, 'sq ft');
  assert.equal(projectMobilePlot({ unit_type: 'plot', plot_size: 120 }, [], []).areaUnit, 'sq yd');
});

test('sign-in limiter bounds repeated phone attempts and expires without storing plaintext mobile numbers', () => {
  let now = 1000;
  const limiter = createMobileLoginLimiter({ now: () => now, windowMs: 1000 });
  const response = { statusCode: 200, headers: {}, set(key, value) { this.headers[key] = value; return this; }, status(value) { this.statusCode = value; return this; }, json() {} };
  let calls = 0;
  const req = { ip: '127.0.0.1', body: credentials };
  for (let i = 0; i < 11; i++) limiter(req, response, () => { calls++; });
  assert.equal(calls, 10);
  assert.equal(response.statusCode, 429);
  assert.equal(response.headers['Retry-After'], '1');
  now += 1001;
  limiter(req, response, () => { calls++; });
  assert.equal(calls, 11);
  assert.equal(normalizeMobile('+91 98765 00001'), credentials.mobile);
  assert.equal(normalizeMobile('0091 9876500001'), credentials.mobile);
  assert.equal(normalizeMobile('abc9876500001'), '');
});

test('HTTP router refuses unauthenticated reads and hides database errors', async t => {
  const router = createMobilePortalRouter({
    login: async () => { throw new Error('SELECT secret Aadhaar'); },
    getSession: async () => { throw Object.assign(new Error('Please sign in again.'), { statusCode: 401 }); },
  });
  const invoke = (method, url, body) => new Promise((resolve, reject) => {
    const req = { method, url, body, ip: '127.0.0.1', headers: {}, get(name) { return this.headers[name.toLowerCase()]; } };
    const res = { statusCode: 200, headers: {}, set(key, value) { this.headers[key] = value; return this; },
      status(value) { this.statusCode = value; return this; }, json(value) { resolve({ status: this.statusCode, headers: this.headers, body: value }); } };
    router.handle(req, res, error => reject(error || new Error('No route matched')));
  });
  const denied = await invoke('GET', '/plots');
  assert.equal(denied.status, 401);
  assert.equal(denied.headers['Cache-Control'], 'private, no-store');
  const failure = await invoke('POST', '/auth/login', credentials);
  assert.equal(failure.status, 503);
  assert.ok(!JSON.stringify(failure.body).includes('secret'));
});

test('batch portfolio reuses financial reads while ownership remains current and explicit refresh bypasses the cache', async t => {
  const db = await fixture();
  t.after(() => db.close());
  let time = Date.parse('2026-10-27T12:00:00Z');
  let queries = 0;
  const service = createMobilePortalService({ query: (sql, args) => { queries++; return db.query(sql, args); } }, { now: () => time });
  const session = { members: [{ id: 1, site_id: 1 }, { id: 2, site_id: 2 }] };
  const first = await service.portfolio(session, { includeDetails: true });
  assert.equal(queries, 3, 'one ownership query plus two batched financial queries, regardless of plot count');
  assert.equal(first.details.length, first.plots.length);
  assert.deepEqual(first.details.map(row => row.plot.id), first.plots.map(row => row.id));
  assert.ok(first.plots.every(row => row.projectName === 'Your Property'));
  assert.ok(!JSON.stringify(first).includes('Oak Park'));
  assert.ok(!JSON.stringify(first).includes('Lake Estate'));
  queries = 0;
  await service.portfolio(session, { includeDetails: true });
  assert.equal(queries, 1, 'financial cache never removes the ownership read');
  queries = 0;
  assert.equal((await service.plot(session, '1')).plot.paidAmount, 350);
  assert.equal(queries, 1, 'detail reuses the batched financial result');
  await db.query('UPDATE plots SET buyer_member_id=3 WHERE id=1');
  await assert.rejects(service.plot(session, '1'), { statusCode: 404 });
  await db.query('UPDATE plots SET buyer_member_id=1 WHERE id=1');
  await db.query("INSERT INTO plot_payments VALUES (20,1,1,25,'2026-10-27','CASH','approved',NULL,'NEW-RECEIPT')");
  assert.equal((await service.plot(session, '1')).plot.paidAmount, 350, 'short-lived financial snapshots are explicit');
  queries = 0;
  const fresh = await service.plot(session, '1', { forceFresh: true });
  assert.equal(fresh.plot.paidAmount, 375);
  assert.equal(queries, 3);
  await db.query("INSERT INTO plot_payments VALUES (21,1,1,25,'2026-10-27','CASH','approved',NULL,'NEWER-RECEIPT')");
  time += 5001;
  assert.equal((await service.plot(session, '1')).plot.paidAmount, 400, 'financial snapshots expire after five seconds');
});

test('simultaneous portfolio reads share one financial batch', async t => {
  const db = await fixture();
  t.after(() => db.close());
  let queries = 0;
  const service = createMobilePortalService({ query: (sql, args) => { queries++; return db.query(sql, args); } });
  const session = { members: [{ id: 1, site_id: 1 }, { id: 2, site_id: 2 }] };
  const [a, b] = await Promise.all([
    service.portfolio(session, { includeDetails: true }),
    service.portfolio(session, { includeDetails: true }),
  ]);
  assert.equal(queries, 4, 'two independent ownership checks share just two financial queries');
  assert.deepEqual(a, b);
});


test('expanded responses negotiate gzip and preserve exact JSON, no-store and refresh options', async () => {
  const payload = { plots: [], details: Array.from({ length: 100 }, (_, id) => ({ plot: { id: String(id), projectName: 'Your Property', installments: [], payments: [{ reference: `SYNTHETIC-${id}`, amount: 100 }] } })) };
  const receivedOptions = [];
  const router = createMobilePortalRouter({
    getSession: async () => ({ members: [] }),
    portfolio: async (_session, options) => { receivedOptions.push(options); return payload; },
  });
  const invoke = encoding => new Promise((resolve, reject) => {
    const req = { method: 'GET', url: '/plots?include=details', query: { include: 'details' },
      headers: { authorization: 'Bearer synthetic-only', 'accept-encoding': encoding, 'cache-control': 'no-cache' },
      get(name) { return this.headers[name.toLowerCase()]; }, acceptsEncodings: express.request.acceptsEncodings };
    const res = { statusCode: 200, headers: {},
      set(key, value) { this.headers[key] = value; return this; },
      vary(value) { this.headers.Vary = value; return this; },
      type(value) { this.headers['Content-Type'] = value; return this; },
      status(value) { this.statusCode = value; return this; },
      json(body) { resolve({ status: this.statusCode, headers: this.headers, body }); },
      send(body) { resolve({ status: this.statusCode, headers: this.headers, body }); },
    };
    router.handle(req, res, error => reject(error || new Error('No route matched')));
  });
  const compressed = await invoke('gzip');
  assert.equal(compressed.headers['Cache-Control'], 'private, no-store');
  assert.equal(compressed.headers.Vary, 'Accept-Encoding');
  assert.equal(compressed.headers['Content-Encoding'], 'gzip');
  assert.deepEqual(JSON.parse(gunzipSync(compressed.body)), payload);
  assert.ok(compressed.body.length < Buffer.byteLength(JSON.stringify(payload)) / 2);
  assert.deepEqual(receivedOptions[0], { includeDetails: true, forceFresh: true });
  const plain = await invoke('gzip;q=0, identity');
  assert.equal(plain.headers['Content-Encoding'], undefined);
  assert.deepEqual(plain.body, payload);
});
