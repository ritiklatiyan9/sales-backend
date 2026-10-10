import test from 'node:test';
import assert from 'node:assert/strict';
import { getDashboard } from './booking.controller.js';
import kycCaseModel from '../models/KycCase.model.js';
import { drawFixture } from '../test/drawFixture.mjs';

const dashboard = (user, siteId = 1) => new Promise((resolve, reject) => {
  const res = {
    status() { return this; },
    json(data) { resolve(data); },
  };
  getDashboard({ user, query: { site_id: siteId } }, res, reject);
});

test('dashboard KYC totals agree with the current-member register, preserving site and network scope', async () => {
  const fixture = await drawFixture();
  try {
    await fixture.query(`INSERT INTO members (id, site_id, full_name, member_type)
      SELECT id, 1, 'Member ' || id, 'customer' FROM generate_series(1, 515) id`);
    await fixture.query(`INSERT INTO kyc_cases (client_member_id, site_id, created_by, status)
      SELECT id, 1, CASE WHEN id <= 4 THEN 2 ELSE 1 END,
             CASE WHEN id = 515 THEN 'OPEN' ELSE 'VERIFIED' END
      FROM generate_series(1, 515) id`);
    await fixture.query(`INSERT INTO kyc_cases (client_member_id, site_id, created_by, status)
      SELECT id, 1, 1, 'OPEN' FROM generate_series(1, 38) id`);
    await fixture.query(`INSERT INTO kyc_cases (site_id, created_by, status)
      SELECT 1, 2, 'VERIFIED' FROM generate_series(1, 17)`);
    await fixture.query(`INSERT INTO members (id, site_id, full_name, member_type)
      VALUES (516, 2, 'Other site member', 'customer')`);
    await fixture.query(`INSERT INTO kyc_cases (client_member_id, site_id, created_by, status)
      VALUES (516, 2, 1, 'VERIFIED')`);

    assert.equal((await kycCaseModel.list({ siteId: 1 }, fixture.pool)).length, 570);
    const current = await kycCaseModel.list({ siteId: 1, currentMembers: true }, fixture.pool);
    const siteDashboard = await dashboard({ id: 1, role: 'admin' });
    assert.equal(siteDashboard.my_kyc.total, current.length);
    assert.deepEqual(siteDashboard.my_kyc, { total: 515, pending: 1, verified: 514, not_booked: 515 });
    assert.equal(siteDashboard.kpi.total, 0);

    const agentDashboard = await dashboard({ id: 2, role: 'agent' });
    const scoped = await kycCaseModel.list({ siteId: 1, currentMembers: true, visibleUserIds: [2] }, fixture.pool);
    assert.equal(agentDashboard.scoped, true);
    assert.equal(agentDashboard.my_kyc.total, scoped.length);
    assert.deepEqual(agentDashboard.my_kyc, { total: 4, pending: 0, verified: 4, not_booked: 4 });

    assert.deepEqual((await dashboard({ id: 1, role: 'admin' }, 2)).my_kyc,
      { total: 1, pending: 0, verified: 1, not_booked: 1 });
  } finally {
    await fixture.close();
  }
});
