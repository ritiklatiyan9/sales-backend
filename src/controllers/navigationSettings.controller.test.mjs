import test from 'node:test';
import assert from 'node:assert/strict';
import { drawFixture } from '../test/drawFixture.mjs';
import { getMyPermissions, getUserAccess, setUserPermission } from './admin.controller.js';
import { NAVIGATION_SETTINGS } from '../services/navigationSettings.js';

const call = (handler, { user = { id: 1, role: 'super_admin' }, id = 2, body = {} } = {}) => new Promise(resolve => {
  handler({ user, params: { id: String(id) }, body }, {
    statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(data) { resolve({ status: this.statusCode, data }); },
  }, error => resolve({ status: error.status || 500, data: { message: error.message } }));
});

test('mobile navigation preferences persist for every staff role without granting other access', async () => {
  assert.ok(NAVIGATION_SETTINGS.every(key => key.length <= 50), 'setting keys fit the existing database column');
  const fixture = await drawFixture();
  try {
    await fixture.db.exec(`CREATE TABLE user_permissions(user_id INTEGER, module VARCHAR(50), can_read BOOLEAN, can_write BOOLEAN, can_update BOOLEAN, can_delete BOOLEAN, updated_at TIMESTAMPTZ, UNIQUE(user_id,module));
      CREATE TABLE agent_activity_log(actor_user_id INTEGER,target_user_id INTEGER,action TEXT,detail JSONB);`);
    await fixture.query(`INSERT INTO user_permissions(user_id,module,can_read,can_write,can_update,can_delete) VALUES (2,'booking_clients',true,false,true,false)`);
    for (const role of ['agent', 'sub_admin', 'admin', 'super_admin']) {
      await fixture.query('UPDATE users SET role=$1 WHERE id=2', [role]);
      for (const module of ['booking_mobile_navigation', 'booking_mobile_shortcut_home', 'booking_mobile_shortcut_draws_new']) {
        const response = await call(setUserPermission, { body: { module, can_read: false, can_write: true, can_update: true, can_delete: true } });
        assert.equal(response.status, 200);
        assert.deepEqual(response.data, { module, can_read: false, can_write: false, can_update: false, can_delete: false });
        assert.equal((await call(getUserAccess)).data.permissions[module].can_read, false);
        assert.equal((await call(getMyPermissions, { user: { id: 2, role } })).data.permissions[module].can_read, false);
        assert.equal((await call(getMyPermissions)).data.permissions[module], undefined);
      }
    }
    const access = (await call(getUserAccess)).data;
    assert.deepEqual(access.permissions.booking_clients, { can_read: true, can_write: false, can_update: true, can_delete: false });
    const module = NAVIGATION_SETTINGS[0];
    assert.equal((await call(setUserPermission, { body: { module, can_read: 'false' } })).status, 400);
    assert.equal((await call(setUserPermission, { body: { module: 'booking_mobile_shortcut_unknown', can_read: true } })).status, 400);
    assert.equal((await call(setUserPermission, { user: { id: 2, role: 'agent' }, body: { module, can_read: true } })).status, 403);
    assert.equal((await call(setUserPermission, { user: { id: 1, role: 'admin' }, body: { module, can_read: true } })).status, 403, 'another administrator remains protected');
    await fixture.query("UPDATE users SET role='admin' WHERE id=2");
    const ownAdmin = { id: 2, role: 'admin' };
    assert.equal((await call(setUserPermission, { user: ownAdmin, body: { module, can_read: true } })).status, 200, 'an administrator can customize their own navigation');
    assert.equal((await call(setUserPermission, { user: ownAdmin, body: { module: 'booking_clients', can_read: false } })).status, 403, 'self-service navigation never expands to access administration');
  } finally { await fixture.close(); }
});
