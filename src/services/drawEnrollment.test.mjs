import test from 'node:test';
import assert from 'node:assert/strict';
import { drawFixture, TEST_BROKER_CODE } from '../test/drawFixture.mjs';
import { canEnrollDraws, clientDrawBlock, drawAvailability, drawEnrollmentState, drawOpenState } from './drawEnrollment.js';
import { todayIST } from './drawWorkflow.js';
import { getDrawSettings } from '../models/ProjectSettings.model.js';
import * as controller from '../controllers/draw.controller.js';

const now = new Date('2026-10-24T06:30:00Z'); // 12:00 IST
const configured = { draw_enabled: true, draw_required_amount: '5000.00', draw_wait_days: 10, draw_opening_date: null, draw_scheme_name: 'A1' };

test('drawOpenState mirrors POST /draws site checks in order, on the IST calendar', () => {
  const cases = [
    [null, {}, { open: false, reason: 'NOT_CONFIGURED' }],
    [{ draw_enabled: false }, {}, { open: false, reason: 'DRAW_DISABLED' }], // disabled wins, as createDraw's 409 runs first
    [{ ...configured, draw_enabled: false }, {}, { open: false, reason: 'DRAW_DISABLED' }],
    [{ ...configured, draw_required_amount: '0.00' }, {}, { open: false, reason: 'NOT_CONFIGURED' }],
    [{ ...configured, draw_required_amount: null }, {}, { open: false, reason: 'NOT_CONFIGURED' }],
    [{ ...configured, draw_opening_date: '2026-10-24' }, {}, { open: true, reason: null, required: 5000, scheduledDate: '2026-10-24' }],
    [{ ...configured, draw_opening_date: '2026-11-15' }, {}, { open: true, reason: null, required: 5000, scheduledDate: '2026-11-15' }],
    [{ ...configured, draw_wait_days: 25 }, {}, { open: true, reason: null, required: 5000, scheduledDate: '2026-11-18' }],
    [configured, { waitDays: 25 }, { open: true, reason: null, required: 5000, scheduledDate: '2026-11-18' }],
  ];
  for (const [setting, options, expected] of cases) {
    assert.deepEqual(drawOpenState(setting, { now, ...options }), expected, JSON.stringify(setting));
  }
  for (const [setting, options, reason, message] of [
    [{ ...configured, draw_opening_date: '2026-10-23' }, {}, 'OPENING_DATE_PASSED', 'Set a current or future draw opening date in Draw Settings'],
    [{ ...configured, draw_opening_date: '2026-02-30' }, {}, 'OPENING_DATE_PASSED', 'Set a current or future draw opening date in Draw Settings'],
    [configured, { waitDays: 7 }, 'INVALID_DRAW_PERIOD', 'Choose a 10-day or 25-day draw period'],
  ]) {
    const state = drawOpenState(setting, { now, ...options });
    assert.equal(state.open, false);
    assert.equal(state.reason, reason);
    assert.equal(state.error.message, message);
    assert.equal(state.error.status, 400);
  }
  const openingDay = { ...configured, draw_opening_date: '2026-10-23' };
  assert.equal(drawOpenState(openingDay, { now: new Date('2026-10-23T18:29:59Z') }).open, true, '23:59:59 IST on the opening day');
  assert.equal(drawOpenState(openingDay, { now: new Date('2026-10-23T18:30:00Z') }).reason, 'OPENING_DATE_PASSED', 'midnight IST');
});

test('drawAvailability adds the scheme name DrawRegister needs, after the server gate', () => {
  assert.deepEqual(drawAvailability({ ...configured, draw_scheme_name: '  Commercial   Lucky Draw ' }, { now }),
    { open: true, reason: null, scheme: { name: 'Commercial Lucky Draw', key: 'name:COMMERCIAL LUCKY DRAW' } });
  for (const draw_scheme_name of [null, '', '   ']) {
    const state = drawAvailability({ ...configured, draw_scheme_name }, { now });
    assert.deepEqual([state.open, state.reason, state.scheme.key], [false, 'NO_SCHEME', 'default']);
  }
  assert.equal(drawAvailability({ ...configured, draw_scheme_name: null, draw_enabled: false }, { now }).reason, 'DRAW_DISABLED');
});

test('clientDrawBlock applies the member checks createDraw runs under its lock', () => {
  assert.equal(clientDrawBlock(null, 1), 'WRONG_SITE');
  assert.equal(clientDrawBlock({ site_id: 2, member_type: 'CLIENT' }, 1), 'WRONG_SITE');
  assert.equal(clientDrawBlock({ site_id: '1', member_type: 'CLIENT' }, 1), null);
  assert.equal(clientDrawBlock({ site_id: 1, member_type: 'EMPLOYEE', member_types: ['EMPLOYEE', 'CLIENT'] }, '1'), null);
  assert.equal(clientDrawBlock({ site_id: 1, member_type: 'VENDOR', member_types: null }, 1), 'NOT_CLIENT');
  assert.equal(clientDrawBlock({ site_id: 1, member_type: 'CLIENT', member_types: ['BROKER'] }, 1), 'NOT_CLIENT', 'the role set wins over the primary type');
});

test('canEnrollDraws = the /draws/new nav rule plus the sub-admin Create grant, from raw rows', () => {
  const rows = {
    none: {},
    sales: { booking_draws: { can_read: true, can_write: true }, booking_item_draws_new: { can_read: false } },
    hidden: { booking_draws: { can_read: false, can_write: true } },
    viewOnly: { booking_draws: { can_read: true, can_write: false } },
    showOn: { booking_item_draws_new: { can_read: true }, booking_draws: { can_read: null, can_write: null } },
  };
  const expected = {
    super_admin: { none: true, sales: false, hidden: false, viewOnly: true, showOn: true },
    admin: { none: true, sales: false, hidden: false, viewOnly: true, showOn: true },
    sub_admin: { none: true, sales: false, hidden: false, viewOnly: false, showOn: true },
    agent: { none: true, sales: false, hidden: false, viewOnly: true, showOn: true },
    client: { none: false, sales: false, hidden: false, viewOnly: false, showOn: false },
  };
  for (const [role, byRows] of Object.entries(expected)) {
    for (const [name, allowed] of Object.entries(byRows)) {
      assert.equal(canEnrollDraws({ id: 9, role }, rows[name]), allowed, `${role} × ${name}`);
    }
  }
  assert.equal(canEnrollDraws({ id: 9, role: 'admin' }, null), true, 'json_object_agg over no rows is NULL');
  assert.equal(canEnrollDraws(null, {}), false);
});

test('drawEnrollmentState.open agrees with what POST /draws does for each settings variant', async t => {
  const f = await drawFixture({ broker: true });
  const admin = { id: 1, role: 'admin' };
  const call = (handler, { body = {}, query = {}, params = {}, user = admin } = {}) => new Promise(resolve => {
    handler({ body, query, params, user }, {
      statusCode: 200, set() { return this; },
      status(value) { this.statusCode = value; return this; },
      json(data) { resolve({ status: this.statusCode, data }); },
    }, error => resolve({ status: error.status || 500, data: { message: error.message, code: error.code } }));
  });
  try {
    await f.db.exec(`CREATE TABLE user_permissions(user_id INTEGER, module TEXT, can_read BOOLEAN, can_write BOOLEAN, can_update BOOLEAN, can_delete BOOLEAN)`);
    const { rows: clients } = await f.query(`INSERT INTO members (site_id, member_type, full_name, phone, created_by)
      SELECT 1, 'CLIENT', 'Variant client ' || n, (9100000000 + n)::text, 1 FROM generate_series(1, 8) n RETURNING id`);
    const save = body => call(controller.setDrawSettings, { body: { site_id: 1, required_amount: 5000, wait_days: 10, ...body } });
    let next = 0;
    const enroll = (siteId, body = {}) => call(controller.createDraw, { body: { site_id: siteId, client_member_id: clients[next].id, broker_code: TEST_BROKER_CODE, ...body } });
    const agree = async (label, reason, siteId = 1) => {
      const setting = await getDrawSettings(siteId);
      const state = await drawEnrollmentState({ user: admin, siteId });
      const rules = (await call(controller.getDrawSettingsHandler, { query: { site_id: siteId } })).data;
      assert.deepEqual([rules.open, rules.reason], [state.open, state.reason], `${label}: GET /draws/settings says the same`);
      const clientId = clients[next].id;
      const created = await enroll(siteId);
      next += 1;
      const accepted = [200, 201].includes(created.status);
      assert.equal(drawOpenState(setting).open, accepted, `${label}: gate vs POST ${created.status} ${created.data.message || ''}`);
      assert.equal(state.open, accepted && !!state.scheme_name, `${label}: UI open`);
      assert.equal(state.reason, reason, label);
      assert.equal(state.can_enroll, true, 'admin, no rows');
      return { created, state, clientId };
    };

    await t.test('unconfigured site', async () => {
      const { created } = await agree('unconfigured', 'NOT_CONFIGURED', 2);
      assert.match(created.data.message, /draw amount for this site has not been set/);
    });
    await t.test('configured with a scheme, no fixed date', async () => {
      assert.equal((await save({ scheme_name: 'A1' })).status, 200);
      const { created, state, clientId } = await agree('open', null);
      assert.equal(created.status, 201, JSON.stringify(created.data));
      assert.equal(state.scheme_name, 'A1');
      const enrolled = await drawEnrollmentState({ user: admin, siteId: 1, memberId: clientId });
      assert.deepEqual([enrolled.enrolled, enrolled.entry_count, enrolled.entries.length, enrolled.client_block], [true, 1, 1, null]);
      assert.deepEqual(Object.keys(enrolled.entries[0]).sort(), ['id', 'registration_no', 'scheme_name', 'slip_no', 'status']);
    });
    await t.test('a request with an invalid draw period fails exactly like its gate', async () => {
      const gate = drawOpenState(await getDrawSettings(1), { waitDays: 7 });
      const created = await enroll(1, { wait_days: 7 });
      next += 1;
      assert.deepEqual([gate.reason, created.status, created.data.message], ['INVALID_DRAW_PERIOD', 400, gate.error.message]);
    });
    await t.test('configured without a scheme: POST accepts it, the UI does not offer it', async () => {
      await save({ scheme_name: null });
      const { created } = await agree('no scheme', 'NO_SCHEME');
      assert.equal(created.status, 201, JSON.stringify(created.data));
    });
    await t.test('disabled', async () => {
      await save({ scheme_name: 'A1', enabled: false });
      const { created } = await agree('disabled', 'DRAW_DISABLED');
      assert.equal(created.data.code, 'DRAW_DISABLED');
    });
    await t.test('opening day, then the day after', async () => {
      await save({ scheme_name: 'A1', enabled: true });
      await f.query('UPDATE project_settings SET draw_opening_date = $1::date WHERE site_id = 1', [todayIST()]);
      assert.equal((await agree('opening day', null)).created.status, 201);
      await f.query("UPDATE project_settings SET draw_opening_date = $1::date - 1 WHERE site_id = 1", [todayIST()]);
      const { created } = await agree('passed', 'OPENING_DATE_PASSED');
      assert.equal(created.data.message, 'Set a current or future draw opening date in Draw Settings');
    });
  } finally { await f.close(); }
});
