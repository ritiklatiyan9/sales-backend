import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePaymentCollector } from './paymentCollector.js';

test('agent code resolves canonical collector name and code within the payment site', async () => {
  const db = { query: async (sql, params) => {
    assert.match(sql, /is_active = true/);
    assert.match(sql, /user_sites/);
    assert.deepEqual(params, ['AGT-42', 8]);
    return { rows: [{id:42,name:'Payment Collector',referral_code:'AGT-42'}] };
  }};
  assert.deepEqual(await resolvePaymentCollector({received_by:'Forged name',received_by_agent_code:' agt-42 '},8,db),
    {id:42,name:'Payment Collector',code:'AGT-42',receivedBy:'Payment Collector (AGT-42)'});
});
test('invalid, inactive, or out-of-site collectors cannot be recorded', async () => {
  await assert.rejects(resolvePaymentCollector({received_by_agent_code:'UNKNOWN'},8,{query:async()=>({rows:[]})}), /invalid, inactive or unavailable/);
  await assert.rejects(resolvePaymentCollector({received_by_agent_code:''},8,{}), /agent code/);
});
test('existing payment callers without the new field retain compatibility', async () => {
  assert.equal(await resolvePaymentCollector({received_by:'Historical staff'},8,{}),null);
});
