import test from 'node:test';
import assert from 'node:assert/strict';
import { drawFixture, TEST_BROKER_CODE } from '../test/drawFixture.mjs';
import * as teams from './team.controller.js';
import * as draws from './draw.controller.js';

const admin = { id: 1, role: 'admin', email: 'admin@example.test' };
const call = (handler, { body = {}, params = {}, query = {}, user = admin } = {}) => new Promise((resolve) => {
  const res = { statusCode: 200, status(v) { this.statusCode = v; return this; }, json(data) { resolve({ status: this.statusCode, data }); } };
  handler({ body, params, query, user }, res, (error) => resolve({ status: error.status || 500, data: { message: error.message } }));
});

test('dealer teams: one head, any-depth sub-dealers, safe moves, per-site counts and broker-traced draws', async () => {
  const f = await drawFixture({ broker: true });
  try {
    const { rows: brokers } = await f.query(`INSERT INTO members (site_id, member_type, status, full_name, phone) VALUES
      (1, 'BROKER', 'ACTIVE', 'Head Dealer', '9100000001'), (1, 'BROKER', 'ACTIVE', 'Sub One', '9100000002'),
      (1, 'BROKER', 'ACTIVE', 'Sub Two', '9100000003'), (1, 'CLIENT', 'ACTIVE', 'Not A Broker', '9100000004') RETURNING id`);
    const [head, sub1, sub2, client] = brokers.map((r) => r.id);
    const team = (await call(teams.createTeam, { body: { name: 'A' } })).data;
    const params = { id: team.id };

    assert.equal((await call(teams.addDealer, { params, body: { member_id: client } })).status, 400, 'only brokers join');
    assert.equal((await call(teams.addDealer, { params, body: { member_id: head } })).status, 201);
    assert.equal((await call(teams.addDealer, { params, body: { member_id: sub1 } })).status, 409, 'one head per team');
    assert.equal((await call(teams.addDealer, { params, body: { member_id: sub1, parent_broker_id: head } })).status, 201);
    assert.equal((await call(teams.addDealer, { params, body: { member_id: sub2, parent_broker_id: sub1 } })).status, 201, 'any depth');
    assert.equal((await call(teams.addDealer, { params, body: { member_id: sub2, parent_broker_id: head } })).status, 409, 'one team per dealer');
    const other = (await call(teams.createTeam, { body: { name: 'B' } })).data;
    assert.equal((await call(teams.addDealer, { params: { id: other.id }, body: { member_id: sub2 } })).status, 409, 'not in two teams');

    assert.equal((await call(teams.moveDealer, { params: { ...params, brokerId: sub1 }, body: { parent_broker_id: sub2 } })).status, 409, 'no loops');
    assert.equal((await call(teams.moveDealer, { params: { ...params, brokerId: sub2 }, body: { parent_broker_id: head } })).status, 200);

    // Counts are per working site: plots booked under the dealer's name + their draw enrollments.
    await f.query(`INSERT INTO plots (site_id, plot_no, status, booking_by) VALUES
      (1, 'B-1', 'BOOKED', 'head dealer '), (1, 'B-2', 'REGISTRY', 'HEAD DEALER'), (1, 'B-3', 'COMPANY', 'HEAD DEALER'), (2, 'C-1', 'BOOKED', 'HEAD DEALER')`);
    const list = (await call(teams.listTeams, { query: { site_id: 1 } })).data;
    const a = list.find((t) => t.id === team.id);
    assert.equal(a.dealer_count, 3);
    assert.equal(a.head.name, 'Head Dealer');
    assert.equal(a.dealers.find((d) => d.broker_id === head).booking_count, 2);
    assert.equal(a.dealers.find((d) => d.broker_id === head).code, `BRK-${String(head).padStart(5, '0')}`);

    assert.equal((await call(teams.setTeamHead, { params, body: { broker_id: sub1 } })).status, 200);
    const swapped = (await call(teams.getTeam, { params })).data.dealers;
    assert.equal(swapped.find((d) => d.broker_id === sub1).parent_broker_id, null);
    assert.equal(swapped.find((d) => d.broker_id === head).parent_broker_id, sub1, 'old head joins under the new head');

    assert.equal((await call(teams.removeDealer, { params: { ...params, brokerId: sub1 } })).status, 409, 'head with a team stays');
    assert.equal((await call(teams.removeDealer, { params: { ...params, brokerId: head } })).status, 200);
    const after = (await call(teams.getTeam, { params })).data.dealers;
    assert.equal(after.find((d) => d.broker_id === sub2).parent_broker_id, sub1, 'sub-dealers move up to the removed dealer’s upline');

    // Draw enrollment needs a valid broker code and records the dealer.
    await call(draws.setDrawSettings, { body: { site_id: 1, required_amount: 5000, scheme_name: 'A1' } });
    const body = { site_id: 1, phone: '9811111111', full_name: 'Traced Client' };
    assert.equal((await call(draws.createDraw, { body })).status, 400, 'missing broker code');
    assert.equal((await call(draws.createDraw, { body: { ...body, broker_code: 'BRK-99999' } })).status, 400, 'unknown broker');
    const created = await call(draws.createDraw, { body: { ...body, broker_code: TEST_BROKER_CODE.toLowerCase() } });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.broker_code, TEST_BROKER_CODE);
    assert.equal(created.data.broker_name, 'Test Broker');

    // A paid but unissued entry (e.g. a test) can be deleted only with explicit confirmation.
    const id = created.data.id;
    assert.equal((await call(draws.addDrawPayment, { params: { id }, body: { amount: 1000, payment_from: 'CASH' } })).status, 201);
    assert.equal((await call(draws.deleteDraw, { params: { id }, query: {} })).status, 409, 'paid entry kept without confirmation');
    const removed = await call(draws.deleteDraw, { params: { id }, query: { with_payments: 'true' } });
    assert.equal(removed.status, 200, JSON.stringify(removed.data));
    assert.equal((await f.query('SELECT count(*)::int n FROM draw_payments WHERE draw_registration_id = $1', [id])).rows[0].n, 0);
  } finally { await f.close(); }
});
