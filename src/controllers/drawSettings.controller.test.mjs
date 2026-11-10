import test from 'node:test';
import assert from 'node:assert/strict';
import { drawFixture, TEST_BROKER_CODE } from '../test/drawFixture.mjs';
import { migrateSiteDrawEnabled } from '../migrations/035_site_draw_enabled.js';
import { migrateDrawPartialReceipts } from '../migrations/049_draw_partial_receipts.js';
import * as controller from './draw.controller.js';

const admin = { id: 1, role: 'admin' };
const call = (handler, { body = {}, params = {}, query = {}, user = admin } = {}) => new Promise(resolve => {
  handler({ body, params, query, user }, {
    statusCode: 200,
    status(value) { this.statusCode = value; return this; },
    json(data) { resolve({ status: this.statusCode, data }); },
  }, error => resolve({ status: error.status || 500, data: { message: error.message } }));
});

test('site draw availability preserves legacy sites, rejects new disabled enrollments and respects access', async t => {
  const f = await drawFixture({ broker: true });
  let existing;
  const settings = { site_id: 1, required_amount: 5000, wait_days: 10 };
  try {
    await t.test('unconfigured sites are distinct from enabled legacy configured sites', async () => {
      const unconfigured = await call(controller.getDrawSettingsHandler, { query: { site_id: 1 } });
      assert.equal(unconfigured.status, 200);
      assert.equal(unconfigured.data.enabled, true);
      assert.equal(unconfigured.data.configured, false);
      assert.equal(unconfigured.data.allow_partial_receipts, false);
      const saved = await call(controller.setDrawSettings, { body: settings });
      assert.equal(saved.status, 200, JSON.stringify(saved.data));
      assert.equal(saved.data.enabled, true);
      assert.equal(saved.data.configured, true);
      existing = await call(controller.createDraw, { body: { site_id: 1, broker_code: TEST_BROKER_CODE, phone: '9876543210', full_name: 'Existing draw client' } });
      assert.equal(existing.status, 201, JSON.stringify(existing.data));
    });

    await t.test('only deciders can change availability, and the setting is a strict boolean', async () => {
      for (const role of ['agent', 'sub_admin']) {
        assert.equal((await call(controller.setDrawSettings, { body: { ...settings, enabled: false }, user: { id: 2, role } })).status, 403);
      }
      for (const enabled of ['false', 0, null]) {
        assert.equal((await call(controller.setDrawSettings, { body: { ...settings, enabled } })).status, 400);
      }
    });

    await t.test('disabling is persistent, rerunnable migrations preserve it and omitted flags do not re-enable it', async () => {
      assert.equal((await call(controller.setDrawSettings, { body: { ...settings, enabled: false } })).data.enabled, false);
      await migrateSiteDrawEnabled(f.pool);
      await migrateSiteDrawEnabled(f.pool);
      assert.equal((await call(controller.setDrawSettings, { body: settings })).data.enabled, false);
      const read = await call(controller.getDrawSettingsHandler, { query: { site_id: 1 } });
      assert.equal(read.data.enabled, false);
      assert.equal(read.data.configured, true);
      assert.equal((await call(controller.getDrawSettingsHandler, { query: { site_id: 2 } })).data.enabled, true);
    });

    await t.test('new registrations are blocked before client or KYC writes, while existing records remain accessible', async () => {
      const before = (await f.query('SELECT (SELECT count(*) FROM members)::int AS members, (SELECT count(*) FROM draw_registrations)::int AS draws, (SELECT count(*) FROM kyc_cases)::int AS kycs')).rows[0];
      const blocked = await call(controller.createDraw, { body: { site_id: 1, broker_code: TEST_BROKER_CODE, phone: '9876543211', full_name: 'Blocked new client' } });
      assert.equal(blocked.status, 409);
      assert.equal(blocked.data.code, 'DRAW_DISABLED');
      assert.deepEqual((await f.query('SELECT (SELECT count(*) FROM members)::int AS members, (SELECT count(*) FROM draw_registrations)::int AS draws, (SELECT count(*) FROM kyc_cases)::int AS kycs')).rows[0], before);
      const readable = await call(controller.getDraw, { params: { id: existing.data.id } });
      assert.equal(readable.status, 200);
      assert.equal(readable.data.id, existing.data.id);
      assert.equal((await call(controller.setDrawSettings, { body: { ...settings, enabled: true } })).data.enabled, true);
      assert.equal((await call(controller.createDraw, { body: { site_id: 1, broker_code: TEST_BROKER_CODE, phone: '9876543211', full_name: 'Now enabled client' } })).status, 201);
    });

    await t.test('draw rules are only readable for sites the account can access', async () => {
      for (const role of ['agent', 'sub_admin']) {
        const user = { id: 2, role };
        assert.equal((await call(controller.getDrawSettingsHandler, { query: { site_id: 1 }, user })).status, 200);
        assert.equal((await call(controller.getDrawSettingsHandler, { query: { site_id: 2 }, user })).status, 403);
      }
      assert.equal((await call(controller.getDrawSettingsHandler, { query: { site_id: 999 } })).status, 404);
    });

    await t.test('partial receipt preference persists per site, survives migrations and is preserved when omitted', async () => {
      const saved = await call(controller.setDrawSettings, { body: { ...settings, allow_partial_receipts: true } });
      assert.equal(saved.status, 200, JSON.stringify(saved.data));
      assert.equal(saved.data.allow_partial_receipts, true);
      await migrateDrawPartialReceipts(f.pool);
      await migrateDrawPartialReceipts(f.pool);
      assert.equal((await call(controller.getDrawSettingsHandler, { query: { site_id: 1 } })).data.allow_partial_receipts, true);
      assert.equal((await call(controller.getDrawSettingsHandler, { query: { site_id: 2 } })).data.allow_partial_receipts, false);
      assert.equal((await call(controller.setDrawSettings, { body: settings })).data.allow_partial_receipts, true);
      const rescheduled = await call(controller.setDrawSettings, { body: { ...settings, allow_partial_receipts: false, opening_date: '2099-11-20', apply_to_existing: true } });
      assert.equal(rescheduled.status, 200, JSON.stringify(rescheduled.data));
      assert.equal(rescheduled.data.allow_partial_receipts, false);
      assert.equal((await call(controller.getDrawSettingsHandler, { query: { site_id: 1 } })).data.allow_partial_receipts, false);
    });

    await t.test('receipt preference requires an admin and a boolean', async () => {
      for (const role of ['agent', 'sub_admin']) {
        assert.equal((await call(controller.setDrawSettings, { body: { ...settings, allow_partial_receipts: true }, user: { id: 2, role } })).status, 403);
      }
      for (const allow_partial_receipts of ['true', 'false', 0, 1, null]) {
        assert.equal((await call(controller.setDrawSettings, { body: { ...settings, allow_partial_receipts } })).status, 400);
      }
      assert.equal((await call(controller.getDrawSettingsHandler, { query: { site_id: 1 } })).data.allow_partial_receipts, false);
    });

    await t.test('allowing partial receipts does not qualify a ₹5,100 payment for a ₹1 lakh draw slip', async () => {
      assert.equal((await call(controller.setDrawSettings, { body: { ...settings, required_amount: 100000, allow_partial_receipts: true } })).status, 200);
      const created = await call(controller.createDraw, { body: { site_id: 1, broker_code: TEST_BROKER_CODE, phone: '9876543212', full_name: 'Partial payment client' } });
      assert.equal(created.status, 201, JSON.stringify(created.data));
      const params = { id: created.data.id };
      const payment = await call(controller.addDrawPayment, { params, body: { amount: 5100, payment_from: 'CASH' } });
      assert.equal(payment.status, 201, JSON.stringify(payment.data));
      const detail = (await call(controller.getDraw, { params })).data;
      assert.equal(Number(detail.payments[0].amount), 5100);
      assert.equal(detail.total_paid, 5100);
      assert.equal(detail.balance_due, 94900);
      assert.equal(detail.is_eligible, false);
      assert.equal(detail.status, 'REGISTERED');
      assert.equal((await call(controller.issueSlip, { params })).status, 400);
    });
  } finally { await f.close(); }
});
