import test from 'node:test';
import assert from 'node:assert/strict';
import { drawFixture } from '../test/drawFixture.mjs';
import { getMyPermissions, getUserAccess, setUserPermission } from './admin.controller.js';

const module = 'booking_accountancy_button';
const superAdmin = { id: 1, role: 'super_admin' };
const call = (handler, { user = superAdmin, id = 2, body = {} } = {}) => new Promise(resolve => {
  handler({ user, params: { id: String(id) }, body }, {
    statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(data) { resolve({ status: this.statusCode, data }); },
  }, error => resolve({ status: error.status || 500, data: { message: error.message } }));
});

test('header visibility is persisted per user and returned even for administrators', async () => {
  const f = await drawFixture();
  try {
    await f.db.exec(`CREATE TABLE user_permissions(user_id INTEGER, module TEXT, can_read BOOLEAN, can_write BOOLEAN, can_update BOOLEAN, can_delete BOOLEAN, updated_at TIMESTAMPTZ, UNIQUE(user_id,module));
      CREATE TABLE agent_activity_log(actor_user_id INTEGER,target_user_id INTEGER,action TEXT,detail JSONB);`);
    const agent = { id: 2, role: 'agent' };
    assert.equal((await call(getMyPermissions, { user: agent })).data.permissions[module], undefined);
    for (const role of ['agent', 'sub_admin', 'admin', 'super_admin']) {
      await f.query('UPDATE users SET role=$1 WHERE id=2', [role]);
      const hidden = await call(setUserPermission, { body: { module, can_read: false, can_write: true } });
      assert.equal(hidden.status, 200);
      assert.equal(hidden.data.can_read, false);
      assert.equal(hidden.data.can_write, false, 'visibility does not grant accounting actions');
      assert.equal((await call(getUserAccess)).data.permissions[module].can_read, false);
      const mine = await call(getMyPermissions, { user: { id: 2, role } });
      assert.equal(mine.data.permissions[module].can_read, false, `${role} must retain an explicit header preference`);
      assert.equal((await call(getMyPermissions)).data.permissions[module], undefined, 'other users are unaffected');
      assert.equal((await call(setUserPermission, { body: { module, can_read: true } })).data.can_read, true);
      assert.equal((await call(getMyPermissions, { user: { id: 2, role } })).data.permissions[module].can_read, true);
    }
    assert.equal((await call(setUserPermission, { user: agent, body: { module, can_read: true } })).status, 403);
    assert.equal((await call(setUserPermission, { user: { id: 1, role: 'admin' }, body: { module, can_read: false } })).status, 403, 'only super admin can change another administrator');
    assert.equal((await call(setUserPermission, { body: { module, can_read: 'false' } })).status, 400);
    assert.equal((await call(setUserPermission, { id: 999, body: { module, can_read: true } })).status, 404);
  } finally { await f.close(); }
});
