import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createMobilePortalService } from './mobilePortal.service.js';
import { createMobilePortalRouter } from '../routes/mobilePortal.routes.js';
import { postingPolicySql } from '../test/mobilePostingPolicy.fixture.mjs';

const unavailable = 'This plot is no longer available in your account. Please contact the Admin Office for assistance.';
const previousClient = { members: [{ id: 1, site_id: 1 }] };
const newClient = { members: [{ id: 2, site_id: 1 }] };
const unassignedClient = { members: [{ id: 3, site_id: 1 }] };

async function fixture() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE members(id integer PRIMARY KEY,site_id integer);
    CREATE TABLE plots(id integer PRIMARY KEY,site_id integer,plot_no text,plot_size numeric,sale_price numeric,booking_date date,status text,buyer_member_id integer);
    CREATE TABLE bookings(id integer PRIMARY KEY,site_id integer,plot_id integer,client_member_id integer,status text);
    CREATE TABLE plot_installments(id integer PRIMARY KEY,plot_id integer,installment_name text,amount numeric,due_date date,sort_order integer,status text);
    CREATE TABLE plot_payments(id integer PRIMARY KEY,site_id integer,plot_id integer,amount numeric,date date,payment_type text,status text,cheque_status text,reference text);
    CREATE TABLE plot_installment_payments(id integer PRIMARY KEY,plot_id integer,installment_id integer,amount numeric,payment_date date,payment_mode text,status text,cheque_status text,reference text);
    INSERT INTO members VALUES (1,1),(2,1),(3,1),(4,2);
    INSERT INTO plots VALUES (1,1,'PRIVATE-A-01',120,100000,'2026-01-01','BOOKED',1);
    INSERT INTO plot_installments VALUES (1,1,'Private payment plan',100000,'2027-01-01',1,'pending');
    INSERT INTO plot_payments VALUES (1,1,1,20000,'2026-01-01','BANK','approved',NULL,'PRIVATE-RECEIPT');
  `);
  await db.exec(postingPolicySql);
  return db;
}

const denied = operation => assert.rejects(operation, { statusCode: 404, message: unavailable });

function invoke(router, path, token = 'previous') {
  return new Promise((resolve, reject) => {
    const [pathname, search = ''] = path.split('?');
    const req = {
      method: 'GET', url: path, path: pathname,
      query: Object.fromEntries(new URLSearchParams(search)),
      headers: { authorization: `Bearer ${token}` },
      get(name) { return this.headers[name.toLowerCase()]; },
    };
    const res = {
      statusCode: 200, headers: {},
      set(name, value) { this.headers[name] = value; return this; },
      vary() { return this; },
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, headers: this.headers, body }); },
    };
    router.handle(req, res, error => reject(error || new Error('No route matched')));
  });
}

test('current plot status and client association govern every customer response', async t => {
  const db = await fixture();
  t.after(() => db.close());
  const service = createMobilePortalService(db, { financeCacheMs: 15000 });

  await t.test('current buyer retains booked, registry, under-cancellation and other existing status access', async () => {
    for (const status of ['BOOKED', ' Registry ', 'UNDER CANCELLATION', 'SOLD', 'TRANSFERRED']) {
      await db.query('UPDATE plots SET status=$1 WHERE id=1', [status]);
      const { plot } = await service.plot(previousClient, '1');
      assert.equal(plot.status, status);
      assert.equal(plot.number, 'PRIVATE-A-01');
      assert.equal(plot.paidAmount, 20000);
      await denied(service.plot(unassignedClient, '1'));
    }
  });

  await t.test('cancellation and resale revoke warm details and remove all financial summaries', async () => {
    for (const status of ['CANCELLED', ' cancelled ', 'CANCELED', 'RESALE', ' resale ']) {
      await db.query("UPDATE plots SET status='BOOKED',buyer_member_id=1 WHERE id=1");
      assert.equal((await service.plot(previousClient, '1')).plot.payments[0].reference, 'PRIVATE-RECEIPT');
      await db.query('UPDATE plots SET status=$1 WHERE id=1', [status]);
      await denied(service.plot(previousClient, '1'));
      const portfolio = await service.portfolio(previousClient, { includeDetails: true });
      assert.deepEqual(portfolio.plots, []);
      assert.deepEqual(portfolio.details, []);
      assert.equal(portfolio.summary.plotCount, 0);
      assert.equal(portfolio.summary.totalAmount, 0);
      assert.equal(portfolio.summary.paidAmount, 0);
      assert.equal(portfolio.summary.balanceAmount, 0);
      assert.equal(portfolio.summary.upcomingCount, 0);
      assert.equal(portfolio.accessNotice, unavailable);
      assert.ok(!JSON.stringify(portfolio).includes('PRIVATE-'));
      await denied(service.plot(unassignedClient, '1'));
    }
  });

  await t.test('resale assignment grants only the newly booked record to its new client', async () => {
    await db.exec(`
      UPDATE plots SET status='RESALE' WHERE id=1;
      INSERT INTO plots VALUES (2,1,'PRIVATE-A-01',120,140000,'2026-11-07','BOOKED',2);
      INSERT INTO plot_installments VALUES (2,2,'New client plan',140000,'2027-02-01',1,'pending');
    `);
    await denied(service.plot(previousClient, '1'));
    await denied(service.plot(previousClient, '2'));
    await denied(service.plot(newClient, '1'));
    const { plot } = await service.plot(newClient, '2');
    assert.equal(plot.status, 'BOOKED');
    assert.equal(plot.totalAmount, 140000);
    assert.equal(plot.paidAmount, 0);
    assert.equal(plot.paymentPlan.bookingDate, '2026-11-07');
    assert.equal(plot.installments[0].title, 'New client plan');
    assert.deepEqual(plot.payments, []);
    const current = await service.portfolio(newClient, { includeDetails: true });
    assert.deepEqual(current.plots.map(row => row.id), ['2']);
    assert.deepEqual(current.details.map(row => row.plot.id), ['2']);
    assert.equal(current.summary.totalAmount, 140000);
    const previous = await service.portfolio(previousClient, { includeDetails: true });
    assert.deepEqual(previous.plots, []);
    assert.equal(previous.accessNotice, unavailable);
    assert.ok(!JSON.stringify(previous).includes('140000'));
    await db.exec('DELETE FROM plot_installments WHERE plot_id=2; DELETE FROM plots WHERE id=2;');
  });

  await t.test('reassigning the same plot record refreshes the financial snapshot for its new buyer', async () => {
    await db.exec("UPDATE plots SET status='BOOKED',buyer_member_id=1 WHERE id=1");
    await service.plot(previousClient, '1');
    await db.exec("UPDATE plots SET status='RESALE' WHERE id=1");
    await denied(service.plot(previousClient, '1'));
    await db.exec(`
      UPDATE plots SET buyer_member_id=2,status='BOOKED',sale_price=150000 WHERE id=1;
      UPDATE plot_installments SET installment_name='Reassigned payment plan',amount=150000 WHERE plot_id=1;
      UPDATE plot_payments SET amount=500,reference='CURRENT-RECEIPT' WHERE plot_id=1;
    `);
    await denied(service.plot(previousClient, '1'));
    const { plot } = await service.plot(newClient, '1');
    assert.equal(plot.status, 'BOOKED');
    assert.equal(plot.totalAmount, 150000);
    assert.equal(plot.installments[0].title, 'Reassigned payment plan');
    assert.equal(plot.payments[0].reference, 'CURRENT-RECEIPT');
    assert.equal(plot.paidAmount, 500);
    assert.ok(!JSON.stringify(plot).includes('PRIVATE-RECEIPT'));
    assert.deepEqual((await service.portfolio(previousClient, { includeDetails: true })).details, []);
  });

  await t.test('clearing assignment does not revive an older booking after the latest booking was cancelled', async () => {
    await db.exec(`
      UPDATE plots SET buyer_member_id=NULL,status='BOOKED' WHERE id=1;
      INSERT INTO bookings VALUES (1,1,1,1,'CONFIRMED'),(2,1,1,2,'CANCELLED');
    `);
    await denied(service.plot(previousClient, '1'));
    await denied(service.plot(newClient, '1'));
    await db.exec("UPDATE bookings SET status='CONFIRMED' WHERE id=2");
    assert.equal((await service.plot(newClient, '1')).plot.id, '1');
    await denied(service.plot(previousClient, '1'));
  });

  await t.test('invalid explicit buyers fail closed rather than falling back to an old booking', async () => {
    await db.exec("UPDATE bookings SET client_member_id=1,status='CONFIRMED' WHERE id=2");
    for (const invalidBuyer of [999, 4]) {
      await db.query('UPDATE plots SET buyer_member_id=$1 WHERE id=1', [invalidBuyer]);
      await denied(service.plot(previousClient, '1'));
      await denied(service.plot(unassignedClient, '1'));
    }
    await db.exec('DELETE FROM bookings; UPDATE plots SET buyer_member_id=NULL WHERE id=1;');
    await denied(service.plot(previousClient, '1'));
    await denied(service.plot(unassignedClient, '1'));
  });

  await t.test('a mixed portfolio reports the unavailable plot without disclosing it or suppressing authorized plots', async () => {
    await db.exec(`
      UPDATE plots SET status='CANCELLED',buyer_member_id=1 WHERE id=1;
      INSERT INTO plots VALUES (2,1,'CURRENT-B-02',60,300,'2026-11-07','REGISTRY',1);
    `);
    for (const includeDetails of [false, true]) {
      const portfolio = await service.portfolio(previousClient, { includeDetails });
      assert.deepEqual(portfolio.plots.map(row => row.id), ['2']);
      assert.equal(portfolio.summary.plotCount, 1);
      assert.equal(portfolio.summary.totalAmount, 300);
      assert.equal(portfolio.summary.paidAmount, 0);
      assert.equal(portfolio.accessNotice, unavailable);
      assert.ok(!JSON.stringify(portfolio).includes('PRIVATE-A-01'));
      assert.ok(!JSON.stringify(portfolio).includes('CURRENT-RECEIPT'));
      if (includeDetails) assert.deepEqual(portfolio.details.map(row => row.plot.id), ['2']);
      else assert.equal(portfolio.details, undefined);
    }
    await db.exec('DELETE FROM plots WHERE id=2');
  });

  await t.test('HTTP responses hide revoked details and give the same contact-office response to unassigned clients', async () => {
    await db.exec("UPDATE plots SET buyer_member_id=1,status='BOOKED' WHERE id=1");
    const router = createMobilePortalRouter({
      ...service,
      getSession: async token => token === 'previous' ? previousClient : unassignedClient,
    }, { isEnabled: () => true });
    const visible = await invoke(router, '/plots/1');
    assert.equal(visible.status, 200);
    assert.equal(visible.headers['Cache-Control'], 'private, no-store');
    assert.equal(visible.body.plot.number, 'PRIVATE-A-01');
    await db.exec("UPDATE plots SET status='CANCELLED' WHERE id=1");
    for (const token of ['previous', 'unassigned']) {
      for (const id of ['1', '999']) {
        const response = await invoke(router, `/plots/${id}`, token);
        assert.equal(response.status, 404);
        assert.equal(response.headers['Cache-Control'], 'private, no-store');
        assert.deepEqual(response.body, { message: unavailable });
      }
    }
    const portfolio = await invoke(router, '/plots?include=details');
    assert.equal(portfolio.status, 200);
    assert.equal(portfolio.headers['Cache-Control'], 'private, no-store');
    assert.deepEqual(portfolio.body.details, []);
    assert.equal(portfolio.body.accessNotice, unavailable);
    assert.ok(!JSON.stringify(portfolio.body).includes('PRIVATE-'));
  });
});

test('revocation during a financial read cannot escape through the response', async t => {
  const db = await fixture();
  t.after(() => db.close());
  await db.exec("INSERT INTO plots VALUES (2,1,'STILL-AUTHORIZED',60,300,'2026-11-07','BOOKED',1)");
  for (const change of [
    { name: 'cancellation', sql: "UPDATE plots SET status='CANCELLED' WHERE id=1" },
    { name: 'resale', sql: "UPDATE plots SET status='RESALE' WHERE id=1" },
    { name: 'reassignment', sql: 'UPDATE plots SET buyer_member_id=2 WHERE id=1' },
  ]) {
    for (const endpoint of ['detail', 'portfolio']) {
      await t.test(`${change.name} committed during the ${endpoint} read revokes only the affected plot`, async () => {
        await db.exec("UPDATE plots SET status='BOOKED',buyer_member_id=1 WHERE id=1");
        let changed = false;
        const service = createMobilePortalService({
          async query(sql, args) {
            const result = await db.query(sql, args);
            // Force a committed revocation after initial authorization and
            // before the awaited financial batch can return to loadPlots.
            if (!changed && sql.includes('FROM plot_installments pi')) {
              changed = true;
              await db.exec(change.sql);
            }
            return result;
          },
        }, { financeCacheMs: 0 });
        if (endpoint === 'detail') {
          await denied(service.plot(previousClient, '1'));
        } else {
          const result = await service.portfolio(previousClient, { includeDetails: true });
          assert.deepEqual(result.plots.map(row => row.id), ['2']);
          assert.deepEqual(result.details.map(row => row.plot.id), ['2']);
          assert.equal(result.summary.plotCount, 1);
          assert.equal(result.summary.totalAmount, 300);
          assert.equal(result.summary.paidAmount, 0);
          assert.equal(result.accessNotice, unavailable);
          assert.ok(!JSON.stringify(result).includes('PRIVATE-'));
        }
        assert.equal(changed, true, 'the fixture must revoke access during the financial query');
      });
    }
  }
});
