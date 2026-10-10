import test from 'node:test';
import assert from 'node:assert/strict';
import kycCaseModel from './KycCase.model.js';
import { drawFixture } from '../test/drawFixture.mjs';

test('current KYC register counts members and uses the Accounting case selection rule', async () => {
  const fixture = await drawFixture();
  try {
    await fixture.query(`INSERT INTO members (id, site_id, full_name, member_type)
      VALUES (1, 1, 'First member', 'customer'), (2, 1, 'Second member', 'farmer'),
             (3, 1, 'Third member', 'customer'), (4, 2, 'Other site', 'customer')`);
    await fixture.query(`INSERT INTO kyc_cases
      (id, client_member_id, site_id, created_by, status, updated_at)
      VALUES (1, 1, 1, 2, 'OPEN', '2026-10-10'),
             (2, 1, 1, 1, 'VERIFIED', '2026-10-01'),
             (3, 2, 1, 1, 'VERIFIED', '2026-10-01'),
             (4, 2, 1, 1, 'VERIFIED', '2026-10-02'),
             (5, 2, 1, 1, 'VERIFIED', '2026-10-02'),
             (6, 3, 1, 1, 'OCR_DONE', '2026-10-01'),
             (7, 3, 1, 1, 'OCR_PENDING', '2026-10-10'),
             (8, NULL, 1, 1, 'VERIFIED', '2026-10-10'),
             (9, 4, 2, 1, 'OPEN', '2026-10-10'),
             (10, 4, 1, 1, 'VERIFIED', '2026-10-10')`);

    const options = { siteId: 1, currentMembers: true, visibleUserIds: null };
    const current = await kycCaseModel.list(options, fixture.pool);
    assert.deepEqual(current.map(row => row.id).sort((a, b) => a - b), [2, 5, 6]);
    assert.equal(new Set(current.map(row => row.account_member_id)).size, 3);
    assert.ok(current.every(row => row.client_name && row.site_id === 1));

    const verified = await kycCaseModel.list({ ...options, status: 'VERIFIED' }, fixture.pool);
    assert.deepEqual(verified.map(row => row.id).sort((a, b) => a - b), [2, 5]);
    const pending = await kycCaseModel.list({ ...options, pending: true }, fixture.pool);
    assert.deepEqual(pending.map(row => row.id), [6]);
    assert.equal((await kycCaseModel.list({ ...options, memberType: 'farmer' }, fixture.pool))[0].id, 5);
    assert.equal((await kycCaseModel.list({ ...options, q: 'First member' }, fixture.pool))[0].id, 2);

    const scoped = await kycCaseModel.list({ ...options, visibleUserIds: [2] }, fixture.pool);
    assert.deepEqual(scoped.map(row => row.id), [1]);
    assert.equal((await kycCaseModel.list({ ...options, visibleUserIds: [] }, fixture.pool)).length, 0);
    assert.deepEqual((await kycCaseModel.list({ ...options, siteId: 2 }, fixture.pool)).map(row => row.id), [9]);

    // Historical and removed-member records remain available and untouched.
    assert.equal((await kycCaseModel.list({ siteId: 1 }, fixture.pool)).length, 9);
    assert.equal((await fixture.query('SELECT count(*)::int AS count FROM kyc_cases')).rows[0].count, 10);
  } finally {
    await fixture.close();
  }
});
