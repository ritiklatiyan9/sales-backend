import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createBrokerGateway } from './brokerGateway.server.js';

async function fixture(t, upstreamFetch, options = {}) {
  const calls = [];
  const server = createBrokerGateway({ upstreamOrigin: 'https://private-upstream.example.test', fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init });
    return upstreamFetch ? upstreamFetch(url, init) : Response.json({ plots: [], confidentialPresentation: true });
  }, ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { calls, request: (path, init) => fetch(origin + path, init) };
}

test('gateway exposes minimal health and only the approved broker paths', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/health')).status, 200);
  for (const path of ['/', '/public/website/config', '/api/mobile/status', '/api/broker-mobile/plots/117', '/api/broker-mobile/status?url=https://evil.test', '/api/broker-mobile/%2fpublic']) {
    const response = await f.request(path); assert.equal(response.status, 404, path);
    assert.ok(!(await response.text()).includes('private-upstream'));
  }
  assert.equal(f.calls.length, 0);
  assert.equal((await f.request('/api/broker-mobile/status')).status, 200);
  assert.equal(f.calls.length, 1);
});
test('gateway forwards only needed auth/cache headers and JSON, never cookies or upstream metadata', async t => {
  const f = await fixture(t, () => Response.json({ clients: [] }, { headers: { 'Set-Cookie': 'internal=secret', Server: 'upstream', 'X-Powered-By': 'company', 'Retry-After': '60' } }));
  const response = await f.request('/api/broker-mobile/auth/login', { method: 'POST', headers: {
    'Content-Type': 'application/json', Authorization: 'Bearer synthetic.token.value', Cookie: 'staff=secret', 'Cache-Control': 'no-cache', 'X-Forwarded-For': 'untrusted',
  }, body: JSON.stringify({ mobile: 'synthetic', password: 'synthetic' }) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null); assert.equal(response.headers.get('server'), null);
  assert.equal(response.headers.get('x-powered-by'), null); assert.equal(response.headers.get('retry-after'), '60');
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer synthetic.token.value');
  assert.equal(f.calls[0].init.headers.Cookie, undefined); assert.equal(f.calls[0].init.headers['X-Forwarded-For'], undefined);
  assert.equal(f.calls[0].init.redirect, 'manual'); assert.match(response.headers.get('cache-control'), /no-store/);
});
test('invalid JSON, oversized bodies and unsupported methods never reach upstream', async t => {
  const f = await fixture(t, null, { maximumRequestBytes: 64 });
  assert.equal((await f.request('/api/broker-mobile/auth/login', { method: 'POST', body: '[]', headers: { 'Content-Type': 'application/json' } })).status, 400);
  assert.equal((await f.request('/api/broker-mobile/auth/login', { method: 'POST', body: 'x'.repeat(100), headers: { 'Content-Type': 'application/json' } })).status, 413);
  assert.equal((await f.request('/api/broker-mobile/auth/login', { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await f.request('/api/broker-mobile/portfolio', { method: 'DELETE' })).status, 404);
  assert.equal(f.calls.length, 0);
});
test('upstream redirects, HTML, malformed JSON and infrastructure errors are generic', async t => {
  for (const upstream of [() => new Response('company', { status: 302, headers: { Location: 'https://company.example' } }),
    () => new Response('<title>Company</title>', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response('invalid', { headers: { 'Content-Type': 'application/json' } }),
    () => { throw new Error('https://private-upstream.example.test company internal'); }]) {
    const f = await fixture(t, upstream); const r = await f.request('/api/broker-mobile/status');
    assert.ok([502, 503].includes(r.status)); const text = await r.text();
    assert.ok(!/company|private-upstream/i.test(text)); assert.equal(r.headers.get('location'), null);
  }
});
test('gateway origin validation forbids HTTP, userinfo and path overrides', () => {
  for (const upstreamOrigin of ['http://upstream.test', 'https://user:password@upstream.test', 'https://upstream.test/path']) {
    assert.throws(() => createBrokerGateway({ upstreamOrigin }), /HTTPS origin/);
  }
});
