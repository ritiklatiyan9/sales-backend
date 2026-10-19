import test from 'node:test';
import assert from 'node:assert/strict';
import { drawFixture, TEST_BROKER_CODE } from '../test/drawFixture.mjs';
import { deleteClientMember } from './booking.controller.js';
import * as draws from './draw.controller.js';

const admin = { id: 1, role: 'admin' };
const call = (handler, { params = {}, body = {}, user = admin } = {}) => new Promise((resolve) => {
  const res = { statusCode: 200, status(v) { this.statusCode = v; return this; }, json(data) { resolve({ status: this.statusCode, data }); } };
  handler({ params, body, query: {}, user }, res, (error) => resolve({ status: error.status || 500, data: { message: error.message } }));
});

test('members can be deleted unless they carry bookings or draw entries', async () => {
  const f = await drawFixture({ broker: true });
  try {
    const { rows: [free] } = await f.query(`INSERT INTO members (site_id, member_type, full_name, phone) VALUES (1, 'CLIENT', 'Free Member', '9555500011') RETURNING id`);
    const { rows: [kyc] } = await f.query(`INSERT INTO kyc_cases (client_member_id, site_id, status) VALUES ($1, 1, 'OPEN') RETURNING id`, [free.id]);
    await f.query(`INSERT INTO documents (kyc_case_id, client_member_id, site_id, type, file_path, mime_type, file_size, ocr_status) VALUES ($1, $2, 1, 'PAN', 'x', 'image/jpeg', 1, 'DONE')`, [kyc.id, free.id]);
    assert.equal((await call(deleteClientMember, { params: { id: free.id }, user: { id: 2, role: 'agent' } })).status, 403);
    assert.equal((await call(deleteClientMember, { params: { id: free.id } })).status, 200);
    assert.equal((await f.query('SELECT count(*)::int n FROM kyc_cases WHERE id = $1', [kyc.id])).rows[0].n, 0, 'its KYC goes with it');

    await call(draws.setDrawSettings, { body: { site_id: 1, required_amount: 5000, scheme_name: 'A1' } });
    const enrolled = await call(draws.createDraw, { body: { site_id: 1, broker_code: TEST_BROKER_CODE, phone: '9555500012', full_name: 'Enrolled Member' } });
    assert.equal(enrolled.status, 201, JSON.stringify(enrolled.data));
    const blocked = await call(deleteClientMember, { params: { id: enrolled.data.client_member_id } });
    assert.equal(blocked.status, 409, JSON.stringify(blocked.data));
    assert.equal((await f.query('SELECT count(*)::int n FROM members WHERE id = $1', [enrolled.data.client_member_id])).rows[0].n, 1);
  } finally { await f.close(); }
});
