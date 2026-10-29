import test from 'node:test';
import assert from 'node:assert/strict';

test('privacy policy is public without opening private API endpoints', async t => {
  process.env.MOBILE_PORTAL_ENABLED = 'true';
  const { default: app } = await import('../app.js');
  const server = app.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const policy = await fetch(`${base}/my-real-assets/privacy.html`);
  assert.equal(policy.status, 200);
  assert.match(policy.headers.get('content-type'), /text\/html/);
  assert.match(await policy.text(), /SM SOLUTIONS MARKETING/);
  const corsHeaders = { Origin: 'https://dgdefence.com', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' };
  const preflight = await fetch(`${base}/api/mobile/admin/accounts`, {method: 'OPTIONS', headers: corsHeaders});
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://dgdefence.com');
  const unrelated = await fetch(`${base}/api/mobile/me`, {method: 'OPTIONS', headers: corsHeaders});
  assert.notEqual(unrelated.headers.get('access-control-allow-origin'), 'https://dgdefence.com');
  const privateResponse = await fetch(`${base}/api/mobile/me`);
  assert.equal(privateResponse.status, 401);
});
