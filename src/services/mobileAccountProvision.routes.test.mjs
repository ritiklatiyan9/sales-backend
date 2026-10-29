import test from 'node:test';
import assert from 'node:assert/strict';
import { createMobilePortalRouter } from '../routes/mobilePortal.routes.js';

const invoke = (router, role, body) => new Promise((resolve, reject) => {
  const req = {method:'POST',url:'/admin/accounts',body,role,headers:{},get(name) { return this.headers[name.toLowerCase()]; }};
  const res = {statusCode:200,headers:{},set(k,v){this.headers[k]=v;return this;},status(n){this.statusCode=n;return this;},json(x){resolve({status:this.statusCode,body:x,headers:this.headers});}};
  router.handle(req,res,error => reject(error || new Error('No route matched')));
});

test('only a current super administrator can issue office app access', async () => {
  let called = 0;
  const staffAuth = (req,res,next) => { if (!req.role) return res.status(401).json({message:'No token'}); req.user = {id:1,role:req.role,version:2}; next(); };
  const accountProvisioner = {async provision(payload) { called++; assert.deepEqual(payload,{memberId:9,identityVerified:true,actorId:1,actorVersion:2}); return {ok:true}; }};
  const router = createMobilePortalRouter({}, {staffAuth,accountProvisioner});
  const body = {memberId:9,identityVerified:true};
  assert.equal((await invoke(router,null,body)).status,401);
  assert.equal((await invoke(router,'admin',body)).status,403);
  const allowed = await invoke(router,'super_admin',body);
  assert.equal(allowed.status,200);
  assert.deepEqual(allowed.body,{ok:true});
  assert.equal(allowed.headers['Cache-Control'],'private, no-store');
  assert.equal(called,1);
});
