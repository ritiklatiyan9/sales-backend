import test from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_ACCESS_SECRET = 'accounts-provision-integration-test-secret';
const { default: pool } = await import('../config/db.js');
const { signAccessToken } = await import('../config/jwt.js');
const { createMobilePortalRouter } = await import('../routes/mobilePortal.routes.js');

const invoke = (router, role, body, { url = '/admin/accounts', token } = {}) => new Promise((resolve, reject) => {
  const req = {method:'POST',url,body,role,headers:token ? {authorization:`Bearer ${token}`} : {},
    header(name) { return this.get(name); }, get(name) { return this.headers[name.toLowerCase()]; }};
  const res = {statusCode:200,headers:{},set(k,v){this.headers[k]=v;return this;},status(n){this.statusCode=n;return this;},json(x){resolve({status:this.statusCode,body:x,headers:this.headers});}};
  router.handle(req,res,error => reject(error || new Error('No route matched')));
});

test('only a current super administrator can issue office app access', async () => {
  let called = 0;
  const staffAuth = (req,res,next) => { if (!req.role) return res.status(401).json({message:'No token'}); req.user = {id:1,role:req.role,version:2}; next(); };
  const accountProvisioner = {async provision(payload) { called++; assert.deepEqual(payload,{memberId:9,identityVerified:true,actorId:1,actorVersion:2}); return {ok:true}; }};
  const router = createMobilePortalRouter({}, {accountProvisionAuth:staffAuth,accountProvisioner});
  const body = {memberId:9,identityVerified:true};
  assert.equal((await invoke(router,null,body)).status,401);
  assert.equal((await invoke(router,'admin',body)).status,403);
  const allowed = await invoke(router,'super_admin',body);
  assert.equal(allowed.status,200);
  assert.deepEqual(allowed.body,{ok:true});
  assert.equal(allowed.headers['Cache-Control'],'private, no-store');
  assert.equal(called,1);
});

test('only the provision route accepts a current Accounts super-admin session', async () => {
  const savedQuery = pool.query;
  let user = { id: 7, role: 'super_admin', token_version: 2, is_active: true, can_login_accounts: true, can_login_booking: true };
  pool.query = async () => ({ rows: [user] });
  try {
    const token = signAccessToken({ id: 7, app: 'accounts', version: 2 });
    let provisioned = 0;
    const router = createMobilePortalRouter({}, {
      accountProvisioner: { async provision(args) {
        assert.deepEqual(args, { memberId: 9, identityVerified: true, actorId: 7, actorVersion: 2 });
        provisioned++;
        return { ok: true };
      } },
      invitationService: { async issue() { assert.fail('Accounts session reached the Bookings invitation handler'); } },
    });
    const body = { memberId: 9, identityVerified: true };
    assert.equal((await invoke(router, null, body, { token })).status, 200);
    assert.equal((await invoke(router, null, body, { token, url: '/admin/invitations' })).status, 401);
    user = { ...user, can_login_accounts: false };
    assert.equal((await invoke(router, null, body, { token })).status, 401);
    user = { ...user, can_login_accounts: true, token_version: 3 };
    assert.equal((await invoke(router, null, body, { token })).status, 401);
    assert.equal(provisioned, 1);
  } finally {
    pool.query = savedQuery;
  }
});
