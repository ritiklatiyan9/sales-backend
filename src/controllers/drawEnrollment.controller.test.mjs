import test from 'node:test';
import assert from 'node:assert/strict';
import { drawFixture, TEST_BROKER_CODE } from '../test/drawFixture.mjs';
import { migrateDrawEnrollment } from '../migrations/031_draw_enrollment.js';
import * as controller from './draw.controller.js';

const admin = { id: 1, role: 'admin' };
const invoke = (handler, { body = {}, params = {}, user = admin } = {}) => new Promise(resolve => {
  const res = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(data) { resolve({ status: this.statusCode, data }); } };
  handler({ body, params, query: {}, user }, res, error => resolve({ status: error.status || 500, data: { message: error.message } }));
});

test('registered clients enroll in distinct named draws with retry and database duplicate protection', async t => {
  const fixture = await drawFixture({ broker: true });
  try {
    await invoke(controller.setDrawSettings, { body: { site_id: 1, required_amount: 5000, scheme_name: 'Default scheme' } });
    const { rows: members } = await fixture.query(`INSERT INTO members (site_id, member_type, full_name, phone, created_by)
      VALUES (1, 'CLIENT', 'Reusable client', '9876543210', 1), (2, 'CLIENT', 'Other site client', '9876543211', 1),
        (1, 'VENDOR', 'Vendor', '9876543212', 1) RETURNING id`);
    const clientId = members[0].id;
    const base = { site_id: 1, broker_code: TEST_BROKER_CODE, client_member_id: clientId, scheme_name: 'A1', request_key: 'named-draw-test-001' };
    let a1;

    await t.test('A1 and B5 share client identity and KYC but retain separate entries and ledgers', async () => {
      const first = await invoke(controller.createDraw, { body: base });
      assert.equal(first.status, 201, JSON.stringify(first.data));
      a1 = first.data;
      const second = await invoke(controller.createDraw, { body: { ...base, scheme_name: 'B5', request_key: 'named-draw-test-002' } });
      assert.equal(second.status, 201, JSON.stringify(second.data));
      assert.equal(second.data.client_member_id, a1.client_member_id);
      assert.equal(second.data.kyc_case_id, a1.kyc_case_id);
      assert.notEqual(second.data.id, a1.id);
      assert.notEqual(second.data.registration_no, a1.registration_no);
      assert.notEqual(second.data.qr_token, a1.qr_token);
      assert.equal(second.data.total_paid, 0);
      assert.equal((await fixture.query('SELECT count(*)::int AS n FROM members WHERE phone = $1', ['9876543210'])).rows[0].n, 1);
    });

    await t.test('same request replays; another request for the normalized draw is rejected without side effects', async () => {
      const replay = await invoke(controller.createDraw, { body: base });
      assert.equal(replay.status, 200);
      assert.equal(replay.data.id, a1.id);
      const duplicate = await invoke(controller.createDraw, { body: { ...base, scheme_name: ' a1 ', request_key: 'another-enrollment', amount: 5000, payment_from: 'CASH' } });
      assert.equal(duplicate.status, 409, JSON.stringify(duplicate.data));
      assert.equal(duplicate.data.code, 'DRAW_ALREADY_ENROLLED');
      assert.equal(duplicate.data.existing_registration_id, a1.id);
      assert.equal((await fixture.query('SELECT count(*)::int AS n FROM draw_registrations')).rows[0].n, 2);
      assert.equal((await fixture.query('SELECT count(*)::int AS n FROM draw_payments')).rows[0].n, 0);
      assert.equal((await fixture.query('SELECT count(*)::int AS n FROM kyc_cases')).rows[0].n, 1);
    });

    await t.test('the unique index rejects writers that bypass the controller lock', async () => {
      await assert.rejects(fixture.query(`INSERT INTO draw_registrations (site_id, client_member_id, scheme_name, enrollment_key, required_amount, status, qr_token)
        VALUES (1, $1, 'A1', 'name:A1', 5000, 'REGISTERED', 'duplicate-index-token')`, [clientId]), error => error.code === '23505');
    });

    await t.test('wrong-site and non-client IDs fail even with an explicit valid referral', async () => {
      await fixture.query("UPDATE users SET referral_code = 'AGT-TEST' WHERE id = 2");
      for (const member of members.slice(1)) {
        const result = await invoke(controller.createDraw, { body: { ...base, client_member_id: member.id, referral_code: 'AGT-TEST', request_key: undefined } });
        assert.equal(result.status, 400, JSON.stringify(result.data));
      }
      const body = { site_id: 2, client_member_id: members[1].id, scheme_name: 'A1' };
      assert.equal((await invoke(controller.createDraw, { body, user: { id: 2, role: 'agent' } })).status, 403);
      assert.equal((await invoke(controller.createDraw, { body, user: { id: 2, role: 'sub_admin' } })).status, 403);
    });

    await t.test('rename cannot merge entries; cancelling permits enrollment again', async () => {
      const b5 = (await fixture.query("SELECT id FROM draw_registrations WHERE scheme_name = 'B5'")).rows[0];
      const conflict = await invoke(controller.updateDraw, { params: { id: b5.id }, body: { scheme_name: 'a1' } });
      assert.equal(conflict.status, 409);
      assert.equal((await fixture.query('SELECT enrollment_key FROM draw_registrations WHERE id = $1', [b5.id])).rows[0].enrollment_key, 'name:B5');
      await invoke(controller.cancelDraw, { params: { id: a1.id } });
      const replacement = await invoke(controller.createDraw, { body: { ...base, request_key: 'replacement-draw-A1' } });
      assert.equal(replacement.status, 201, JSON.stringify(replacement.data));
      assert.notEqual(replacement.data.id, a1.id);
    });

    await t.test('legacy duplicates survive rerunnable migration and block new duplicates', async () => {
      await fixture.query(`INSERT INTO draw_registrations (site_id, client_member_id, scheme_name, required_amount, status, qr_token)
        VALUES (1, $1, 'Legacy Draw', 5000, 'REGISTERED', 'legacy-token-1'), (1, $1, 'Legacy Draw', 5000, 'REGISTERED', 'legacy-token-2')`, [clientId]);
      await migrateDrawEnrollment(fixture.pool);
      const conflict = await invoke(controller.createDraw, { body: { ...base, scheme_name: ' legacy   draw ', request_key: 'legacy-conflict-test' } });
      assert.equal(conflict.status, 409, JSON.stringify(conflict.data));
      assert.equal((await fixture.query("SELECT count(*)::int AS n FROM draw_registrations WHERE scheme_name = 'Legacy Draw'")).rows[0].n, 2);
    });

    await t.test('site-authorized agents enroll existing clients in another named draw', async () => {
      const agent = { id: 2, role: 'agent' };
      const result = await invoke(controller.createDraw, { body: { site_id: 1, broker_code: TEST_BROKER_CODE, client_member_id: clientId, scheme_name: 'C3', request_key: 'agent-client-draw-C3' }, user: agent });
      assert.equal(result.status, 201, JSON.stringify(result.data));
      assert.equal(result.data.client_member_id, clientId);
      const conflict = await invoke(controller.createDraw, { body: { site_id: 1, broker_code: TEST_BROKER_CODE, client_member_id: clientId, scheme_name: 'B5' }, user: agent });
      assert.equal(conflict.status, 409);
      assert.equal(conflict.data.existing_registration_id, undefined);
    });

    await t.test('one client can hold several entries in the same draw once each extra entry is confirmed', async () => {
      const warned = await invoke(controller.createDraw, { body: { ...base, request_key: 'multi-entry-0' } });
      assert.equal(warned.status, 409, 'an unconfirmed repeat is never created by accident');
      assert.equal(warned.data.entry_count, 1);
      const add = (key) => invoke(controller.createDraw, { body: { ...base, request_key: key, additional_entry: true } });
      const second = await add('multi-entry-2');
      const third = await add('multi-entry-3');
      assert.equal(second.status, 201, JSON.stringify(second.data));
      assert.equal(third.status, 201, JSON.stringify(third.data));
      assert.notEqual(second.data.registration_no, third.data.registration_no);
      assert.equal(second.data.kyc_case_id, third.data.kyc_case_id, 'entries share the client’s KYC');
      assert.equal((await invoke(controller.createDraw, { body: { ...base, request_key: 'multi-entry-4' } })).data.entry_count, 3);
      // Cancelling a middle entry never makes the next one clash with a live entry.
      await invoke(controller.cancelDraw, { params: { id: second.data.id } });
      assert.equal((await add('multi-entry-5')).status, 201);
      const keys = (await fixture.query(`SELECT enrollment_key FROM draw_registrations WHERE client_member_id = $1 AND scheme_name = 'A1' AND status <> 'CANCELLED' ORDER BY id`, [clientId])).rows.map((r) => r.enrollment_key);
      assert.deepEqual(keys, ['name:A1', 'name:A1#ENTRY-3', 'name:A1#ENTRY-4']);
    });
  } finally {
    await fixture.close();
  }
});
