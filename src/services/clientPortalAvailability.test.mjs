import test from 'node:test';
import assert from 'node:assert/strict';
import { clientPortalEnabled, requireClientPortalEnabled } from './clientPortalAvailability.js';

test('client access is paused by default and rejects login-era tokens, refresh, documents and profile routes', () => {
  const original = process.env.CLIENT_PORTAL_ENABLED;
  try {
    delete process.env.CLIENT_PORTAL_ENABLED;
    assert.equal(clientPortalEnabled(), false);
    for (const path of ['/me','/records','/auth/refresh','/profile','/documents/1']) {
      let response;
      const res = { status(code) { this.code=code; return this; }, json(data) { response={status:this.code,...data}; } };
      requireClientPortalEnabled({ path, headers: { authorization: 'Bearer previously-issued-token' } }, res, () => assert.fail('A paused portal must reject all client access'));
      assert.equal(response.status,403); assert.equal(response.code,'CLIENT_PORTAL_DISABLED');
    }
    process.env.CLIENT_PORTAL_ENABLED='true';
    let allowed=false;
    requireClientPortalEnabled({}, {}, () => { allowed=true; });
    assert.equal(allowed,true);
  } finally { if (original === undefined) delete process.env.CLIENT_PORTAL_ENABLED; else process.env.CLIENT_PORTAL_ENABLED=original; }
});
