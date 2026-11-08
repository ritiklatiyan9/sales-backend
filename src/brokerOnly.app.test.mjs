import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createBrokerOnlyApp } from './brokerOnly.app.js';

async function fixture(t, overrides = {}) {
  const calls = [];
  const service = {
    getSession: async token => { calls.push(['session', token]); return { account: { id: 1 }, user: { name: 'Partner' } }; },
    portfolio: async () => ({ presentationVersion: 3, clients: [], confidentialPresentation: true }),
    plot: async (_session, id) => ({ plot: { id, projectName: 'Your Property' } }),
    login: async body => { calls.push(['login', body]); return { token: 'fictional.token', user: { name: 'Partner' } }; },
    ...overrides,
  };
  const server = createBrokerOnlyApp({ service, routerOptions: { isEnabled: () => true,
    pushDevices:{register:async(session,body)=>calls.push(['register',session,body]),unregister:async(session,body)=>calls.push(['unregister',session,body])},
  } }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { calls, request: (path, init) => fetch(`http://127.0.0.1:${server.address().port}${path}`, init) };
}

test('standalone service excludes website, client/staff, numeric ids, queries and unintended methods', async t => {
  const f = await fixture(t);
  const health = await f.request('/health');
  assert.deepEqual(await health.json(), { status: 'ok', service: 'my-real-partners-api' });
  for (const path of ['/', '/public/website/config', '/api/mobile/status', '/api/users', '/uploads/private.pdf',
    '/api/broker-mobile/plots/117', '/api/broker-mobile/status?url=anything', '/api/broker-mobile/status/']) {
    const response = await f.request(path);
    assert.equal(response.status, 404, path);
    assert.match(response.headers.get('content-type'), /application\/json/);
  }
  assert.equal((await f.request('/api/broker-mobile/portfolio', { method: 'DELETE' })).status, 404);
  assert.equal((await f.request('/api/broker-mobile/status', { method: 'HEAD' })).status, 404);
  assert.equal(f.calls.length, 0);
});
test('standalone reuses broker auth, safe DTOs, opaque detail and private headers directly', async t => {
  const f = await fixture(t);
  const status = await f.request('/api/broker-mobile/status');
  assert.equal((await status.json()).portfolioVersion, 3);
  assert.equal(status.headers.get('x-powered-by'), null);
  assert.match(status.headers.get('cache-control'), /no-store/);
  assert.match(status.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal((await f.request('/api/broker-mobile/portfolio')).status, 401);
  const headers = { Authorization: 'Bearer fictional.token' };
  assert.equal((await (await f.request('/api/broker-mobile/portfolio', { headers })).json()).presentationVersion, 3);
  const id = `pr_${'a'.repeat(32)}`;
  assert.equal((await (await f.request(`/api/broker-mobile/plots/${id}`, { headers })).json()).plot.id, id);
  assert.equal(f.calls.filter(call => call[0] === 'session').length, 2);
});
test('malformed and oversized login bodies fail before credentials reach the service', async t => {
  const f = await fixture(t);
  const post = body => f.request('/api/broker-mobile/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  assert.equal((await post('{bad')).status, 400);
  assert.equal((await post('[]')).status, 400);
  assert.equal((await post(JSON.stringify({ password: 'x'.repeat(17000) }))).status, 413);
  assert.equal((await f.request('/api/broker-mobile/auth/login', { method: 'POST', body: '{}' })).status, 415);
  assert.equal(f.calls.length, 0);
  assert.equal((await post(JSON.stringify({ mobile: 'fictional', password: 'fictional' }))).status, 200);
  assert.equal(f.calls.length, 1);
});
test('standalone errors never expose database or signing diagnostics', async t => {
  const f = await fixture(t, { portfolio: async () => { throw new Error('company database password=private'); } });
  const response = await f.request('/api/broker-mobile/portfolio', { headers: { Authorization: 'Bearer fictional.token' } });
  assert.equal(response.status, 503);
  assert.ok(!/company|database|password/i.test(await response.text()));
});
test('standalone permits only authenticated JSON device registration/unregistration and logout',async t=>{
  const f=await fixture(t,{logout:async session=>{assert.equal(session.account.id,1);return {success:true};}});
  const body=JSON.stringify({token:'synthetic_partner_token_1234567890',platform:'android'});
  const headers={'Content-Type':'application/json',Authorization:'Bearer fictional.token'};
  assert.equal((await f.request('/api/broker-mobile/device-tokens',{method:'POST',headers,body})).status,200);
  assert.equal((await f.request('/api/broker-mobile/device-tokens',{method:'DELETE',headers,body:JSON.stringify({token:'synthetic_partner_token_1234567890'})})).status,200);
  assert.equal((await f.request('/api/broker-mobile/device-tokens',{method:'DELETE',headers:{Authorization:headers.Authorization},body:'{}'})).status,415);
  assert.equal((await f.request('/api/broker-mobile/device-tokens',{method:'DELETE',headers,body:'[]'})).status,400);
  assert.equal((await f.request('/api/broker-mobile/device-tokens',{method:'GET',headers})).status,404);
  assert.deepEqual(await(await f.request('/api/broker-mobile/auth/logout',{method:'POST',headers,body:'{}'})).json(),{success:true});
  assert.deepEqual(f.calls.filter(c=>c[0]==='register'||c[0]==='unregister').map(c=>c[0]),['register','unregister']);
});
