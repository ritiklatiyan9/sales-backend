import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrokerCommissionReader } from './brokerCommission.service.js';

test('commission list database round trips stay constant as the portfolio grows', async t => {
  const previous = process.env.MOBILE_PORTAL_SECRET;
  process.env.MOBILE_PORTAL_SECRET = 'synthetic-commission-query-budget-secret-long-enough';
  t.after(() => {
    if (previous === undefined) delete process.env.MOBILE_PORTAL_SECRET;
    else process.env.MOBILE_PORTAL_SECRET = previous;
  });
  const session = { account: { id: 1 }, brokerMemberIds: [101], siteIds: [1] };
  for (const count of [1, 1000]) {
    const plots = Array.from({ length: count }, (_, index) => ({
      id: index + 1, plot_no: `A${index + 1}`, plot_size: 120, unit_type: 'plot',
    }));
    const rows = plots.map(plot => ({
      id: plot.id, site_id: 1, plot_id: plot.id, agent_id: 101,
      total_commission: '3000', status: 'Partial', received_amount: '900', tds_amount: '100',
      allocation_type: 'percentage', allocation_value: '30',
    }));
    const queries = [];
    let scopeReads = 0;
    let sessionReads = 0;
    const read = createBrokerCommissionReader({ query: async (sql, args) => {
      queries.push({ sql, args });
      return { rows };
    } }, {
      scopedPlots: async () => { scopeReads++; return plots; },
      validateSession: async () => { sessionReads++; },
    });
    const response = await read(session);
    assert.equal(response.summary.plotCount, count);
    assert.equal(response.summary.totalAmount, count * 3000);
    assert.equal(response.summary.paidAmount, count * 1000);
    assert.equal(queries.length, 2, 'one batch payment read and one current-authority recheck');
    assert.equal(scopeReads, 2);
    assert.equal(sessionReads, 1);
    assert.equal(queries[0].args[2].length, count);
    assert.equal((queries[0].sql.match(/FROM plot_commission_payments/g) || []).length, 1,
      'cash and tax summaries share a single payment scan');
    assert.ok(!queries.some(query => /json_agg/.test(query.sql)), 'histories stay lazy on list requests');
  }
});

test('post-read session recheck starts after the reads and its 401 never hides a changed-commission 503', async () => {
  const session = { account: { id: 1 }, brokerMemberIds: [101], siteIds: [1] };
  const plots = [{ id: 1, plot_no: 'A1', plot_size: 120, unit_type: 'plot' }];
  const row = { id: 1, site_id: 1, plot_id: 1, agent_id: 101, total_commission: '3000', status: 'Partial', received_amount: '0', tds_amount: '0' };
  const run = async ({ changed }) => {
    const order = [];
    const read = createBrokerCommissionReader({ query: async sql => {
      order.push(/AS received_amount/.test(sql) ? 'payments' : 'recheck');
      return { rows: [changed && order.at(-1) === 'recheck' ? { ...row, agent_id: 102 } : row] };
    } }, {
      scopedPlots: async () => { order.push('scope'); return plots; },
      validateSession: async () => { order.push('session'); throw Object.assign(new Error('Please sign in again.'), { statusCode: 401 }); },
    });
    await assert.rejects(read(session), { statusCode: changed ? 503 : 401 });
    assert.deepEqual(order.slice(0, 2), ['scope', 'payments']);
    assert.deepEqual(order.slice(2).sort(), ['recheck', 'scope', 'session']);
  };
  await run({ changed: true });
  await run({ changed: false });
});
