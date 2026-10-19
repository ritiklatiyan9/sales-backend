import test from 'node:test';
import assert from 'node:assert/strict';
import { drawFixture, TEST_BROKER_CODE } from '../test/drawFixture.mjs';
import { migrateSiteDrawEnabled } from '../migrations/035_site_draw_enabled.js';
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
  } finally { await f.close(); }
});
