import test from 'node:test';
import assert from 'node:assert/strict';
import kycCaseModel from './KycCase.model.js';
import { drawFixture } from '../test/drawFixture.mjs';

test('KYC register returns all matching cases beyond 500 and preserves access filters', async () => {
  const fixture = await drawFixture();
  try {
    await fixture.query(`
      INSERT INTO members (id, site_id, full_name, phone, member_type)
      VALUES (1, 1, 'Register customer', '9999999999', 'customer')
    `);
    await fixture.query(`
      INSERT INTO kyc_cases (client_member_id, site_id, created_by, status, created_at)
      SELECT 1, 1, 2, 'OPEN', '2026-01-01'::timestamptz
      FROM generate_series(1, 650)
    `);
    await fixture.query(`
      INSERT INTO kyc_cases (client_member_id, site_id, created_by, status)
      VALUES (1, 2, 2, 'OPEN'), (1, 1, 1, 'VERIFIED')
    `);

    const all = await kycCaseModel.list({ siteId: 1, visibleUserIds: null }, fixture.pool);
    assert.equal(all.length, 651);
    assert.equal(new Set(all.map(row => row.id)).size, 651);
    assert.deepEqual(all.slice(1).map(row => row.id), Array.from({ length: 650 }, (_, i) => 650 - i));

    const scoped = await kycCaseModel.list({ siteId: 1, visibleUserIds: [2] }, fixture.pool);
    assert.equal(scoped.length, 650);
    assert.ok(scoped.every(row => row.site_id === 1 && row.created_by === 2));
    assert.equal((await kycCaseModel.list({ siteId: 2 }, fixture.pool)).length, 1);
    assert.equal((await kycCaseModel.list({ siteId: 1, status: 'VERIFIED' }, fixture.pool)).length, 1);
    assert.equal((await kycCaseModel.list({ siteId: 1, pending: true }, fixture.pool)).length, 650);
    assert.equal((await kycCaseModel.list({ siteId: 1, q: 'Register customer' }, fixture.pool)).length, 651);
    assert.equal((await kycCaseModel.list({ siteId: 1, q: 'Missing customer' }, fixture.pool)).length, 0);
    assert.equal((await kycCaseModel.list({ siteId: 1, visibleUserIds: [] }, fixture.pool)).length, 0);
  } finally {
    await fixture.close();
  }
});
