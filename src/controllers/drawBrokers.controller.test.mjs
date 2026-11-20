import test from 'node:test';
import assert from 'node:assert/strict';
import { drawFixture } from '../test/drawFixture.mjs';
import * as controller from './draw.controller.js';

const call = (
  handler,
  { body = {}, params = {}, query = {}, user } = {},
) =>
  new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(value) {
        this.statusCode = value;
        return this;
      },
      json(value) {
        resolve({ status: this.statusCode, data: value });
      },
    };
    handler({ body, params, query, user }, res, (error) =>
      resolve({
        status: error.status || 500,
        data: { message: error.message },
      }),
    );
  });

test('draw and booking payment broker filters use site and network scoped results', async (t) => {
  const fixture = await drawFixture();
  try {
    await fixture.db.exec(`
      INSERT INTO members (id, site_id, member_type, full_name) VALUES
        (11, 1, 'CLIENT', 'Draw Client'), (12, 2, 'CLIENT', 'Other Site Client'),
        (21, 1, 'BROKER', 'Shared Name'), (22, 1, 'BROKER', 'Shared Name'),
        (23, 1, 'BROKER', 'Outside Network'), (24, 2, 'BROKER', 'Other Site Broker');
      INSERT INTO draw_registrations (site_id, client_member_id, registration_no, qr_token, status,
                                     agent_user_id, created_by, broker_id, broker_member_id, broker_code, created_at)
      VALUES
        (1, 11, 'OLDER-A', 'older-a', 'REGISTERED', 2, 1, 21, 21, 'BRK-00021', '2024-01-02'),
        (1, 11, 'OLDER-B', 'older-b', 'ELIGIBLE', NULL, 2, 22, 22, NULL, '2024-01-01'),
        (1, 11, 'HIDDEN-A', 'hidden-a', 'REGISTERED', NULL, 1, 21, 21, 'BRK-00021', '2024-01-03'),
        (1, 11, 'HIDDEN-C', 'hidden-c', 'REGISTERED', NULL, 1, 23, 23, 'BRK-00023', '2024-01-03'),
        (2, 12, 'OTHER-SITE', 'other-site', 'REGISTERED', NULL, 2, 24, 24, 'BRK-00024', '2024-01-03');
      INSERT INTO draw_registrations (site_id, client_member_id, registration_no, qr_token, created_by, created_at)
      SELECT 1, 11, 'NEWER-' || n, 'newer-' || n, 2, '2024-02-01' FROM generate_series(1, 501) n;
    `);
    const user = { id: 2, role: 'agent' };
    await t.test('draws match any selected broker before the list limit', async () => {
      const list = (query) => call(controller.listDraws, { user, query: { site_id: 1, ...query } });
      const options = await call(controller.listDrawBrokers, { user, query: { site_id: 1 } });
      assert.deepEqual(options.data, [
        { id: 21, name: 'Shared Name', code: 'BRK-00021' },
        { id: 22, name: 'Shared Name', code: 'BRK-00022' },
      ]);

      const unfiltered = await list();
      assert.equal(unfiltered.data.length, 500);
      assert.ok(unfiltered.data.every((row) => row.registration_no.startsWith('NEWER-')));
      const selected = await list({ broker_ids: '22,21' });
      assert.deepEqual(selected.data.map((row) => row.registration_no), ['OLDER-A', 'OLDER-B']);
      const combined = await list({ broker_ids: '21,22', q: 'older', status: 'ELIGIBLE' });
      assert.deepEqual(combined.data.map((row) => row.registration_no), ['OLDER-B']);
      assert.equal((await list({ broker_ids: '21,invalid' })).status, 400);
      assert.equal((await list({ site_id: 2, broker_ids: '24' })).status, 403);
      assert.equal((await call(controller.listDrawBrokers, { user, query: { site_id: 2 } })).status, 403);
    });

    await t.test('booking payments use the same selected brokers for counts, totals and statements', async () => {
      await fixture.db.exec(`
        UPDATE users SET name = 'Legacy Broker, West' WHERE id = 2;
        UPDATE draw_registrations SET broker_id = NULL, broker_member_id = NULL, agent_user_id = 2
          WHERE registration_no = 'OLDER-B';
        UPDATE draw_registrations SET status = 'CANCELLED' WHERE registration_no = 'HIDDEN-A';
        UPDATE draw_registrations SET broker_code = 'BRK-00021' WHERE registration_no = 'OTHER-SITE';
        UPDATE draw_registrations SET required_amount = 1000 WHERE registration_no IN ('OLDER-A', 'OLDER-B');
        INSERT INTO draw_payments (draw_registration_id, payment_date, amount)
          SELECT id, '2024-02-01', CASE registration_no WHEN 'OLDER-A' THEN 250 WHEN 'OLDER-B' THEN 500 ELSE 900 END
          FROM draw_registrations WHERE registration_no IN ('OLDER-A', 'OLDER-B', 'HIDDEN-A', 'HIDDEN-C', 'OTHER-SITE', 'NEWER-1');
      `);
      const query = { site_id: 1, broker: ['BRK-00021', 'Legacy Broker, West'] };
      const registrations = (rows) => rows.map(row => row.registration_no).sort();
      const queue = (extra) => call(controller.listWorkflow, { user, query: { ...query, ...extra } });
      const result = await queue({ payment: 'PARTIAL', stage: 'PAYMENT' });
      assert.equal(result.status, 200);
      assert.equal(result.data.total, 2);
      assert.deepEqual(result.data.counts, { PAYMENT: 2 });
      assert.deepEqual(result.data.totals, { total_paid: 750, required_amount: 2000 });
      assert.deepEqual(registrations(result.data.items), ['OLDER-A', 'OLDER-B']);
      assert.deepEqual(result.data.options.brokers.map(broker => broker.value), ['Legacy Broker, West', 'BRK-00021']);
      assert.deepEqual(registrations((await queue({ broker: 'Legacy Broker, West' })).data.items), ['OLDER-B']);
      assert.equal((await queue({ broker: { unexpected: 'BRK-00021' } })).status, 400);

      const summary = await queue({ page_size: 'all', stage: 'PAYMENT' });
      assert.deepEqual(registrations(summary.data.items), ['OLDER-A', 'OLDER-B']);
      const receipts = await call(controller.paymentStatement, { user: { id: 1, role: 'admin' }, query });
      assert.equal(receipts.status, 200);
      assert.deepEqual(registrations(receipts.data.rows), ['OLDER-A', 'OLDER-B']);
      assert.equal(receipts.data.rows.find(row => row.registration_no === 'OLDER-B').broker_name, 'Legacy Broker, West');
      assert.equal(receipts.data.rows.reduce((total, row) => total + row.amount, 0), 750);
    });
  } finally {
    await fixture.close();
  }
});
