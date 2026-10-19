import test from 'node:test';
import assert from 'node:assert/strict';
import { drawFixture } from '../test/drawFixture.mjs';
import { setUserPermission, setUserSites, getMyPermissions } from '../controllers/admin.controller.js';
import { hasPermission } from './permissions.service.js';
import { requireWorkspaceAccess, requireAnyWorkspaceReadAccess } from './bookingWorkspaceAccess.js';
import { signAccessToken } from '../config/jwt.js';
import bookingRoutes from '../routes/booking.routes.js';
import drawRoutes from '../routes/draw.routes.js';
import kycRoutes from '../routes/kyc.routes.js';
import teamRoutes from '../routes/team.routes.js';
import lookupRoutes from '../routes/lookups.routes.js';
import { updateAgent } from '../controllers/agent.controller.js';
import { saveProjectSettings } from '../controllers/settings.controller.js';

const admin={id:1,role:'admin'}, sub={id:2,role:'sub_admin'};
const call=(handler,{user=admin,id=2,body={}}={})=>new Promise(resolve=>handler({user,params:{id:String(id)},body},response(resolve),error=>resolve({status:error.status||500,data:{message:error.message}})));
function response(resolve){return {statusCode:200,set(){return this;},status(code){this.statusCode=code;return this;},json(data){resolve({status:this.statusCode,data});return this;}};}
const request=(router,method,url,token,body={})=>new Promise(resolve=>{
  const req={method,url,originalUrl:url,headers:{authorization:`Bearer ${token}`},header(name){return this.headers[name.toLowerCase()];},body};
  router.handle(req,response(resolve),error=>resolve({status:error?.status||404,data:{message:error?.message}}));
});

test('admins control sub-admin grants and APIs honor them without allowing self escalation',async t=>{
  const fixture=await drawFixture();
  try{
    await fixture.db.exec(`ALTER TABLE users ADD COLUMN token_version INTEGER DEFAULT 1;
      UPDATE users SET role='sub_admin' WHERE id=2;
      CREATE TABLE user_permissions(user_id INTEGER,module TEXT,can_read BOOLEAN,can_write BOOLEAN,can_update BOOLEAN,can_delete BOOLEAN,updated_at TIMESTAMPTZ,UNIQUE(user_id,module));
      CREATE TABLE agent_activity_log(actor_user_id INTEGER,target_user_id INTEGER,action TEXT,detail JSONB);`);
    await t.test('admin can save every CRUD flag for a sub-admin and grants are returned without an admin bypass',async()=>{
      const changed=await call(setUserPermission,{body:{module:'booking_members',can_read:true,can_write:false,can_update:true,can_delete:false}});
      assert.equal(changed.status,200);
      assert.equal((await call(getMyPermissions,{user:sub})).data.is_admin,false);
      assert.equal(await hasPermission(sub,'booking_members','can_write'),false);
      assert.equal(await hasPermission(sub,'booking_members','can_update'),true);
      await requireWorkspaceAccess(sub,1,'booking_members','can_update');
      await assert.rejects(requireWorkspaceAccess(sub,1,'booking_members','can_write'),error=>error.status===403);
      await requireWorkspaceAccess(sub,1,'booking_form_studio','can_update'); // unchanged legacy default
      await assert.rejects(requireWorkspaceAccess(sub,2,'booking_members'),error=>error.status===403);
    });
    await t.test('sub-admins cannot restore their own permissions or sites; full administrators remain protected',async()=>{
      assert.equal((await call(setUserPermission,{user:sub,body:{module:'booking_members',can_read:true,can_write:true}})).status,403);
      assert.equal((await call(setUserSites,{user:sub,body:{site_ids:[1,2]}})).status,403);
      assert.equal((await call(setUserPermission,{user:sub,body:{module:'booking_mobile_navigation',can_read:false}})).status,200,'own navigation stays customizable');
      assert.equal((await call(setUserPermission,{id:1,body:{module:'booking_members',can_read:false}})).status,403);
      assert.equal(await hasPermission(admin,'booking_members','can_write'),true);
      assert.equal((await call(updateAgent,{user:sub,id:1,body:{new_password:'attempted-admin-reset'}})).status,403,'network editing cannot bypass account protections');
    });
    await t.test('read access is required for every action and shared workspaces honor denials',async()=>{
      await call(setUserPermission,{body:{module:'booking_members',can_read:false,can_write:true,can_update:true,can_delete:true}});
      await assert.rejects(requireWorkspaceAccess(sub,1,'booking_members','can_update'),error=>error.status===403);
      await assert.rejects(requireAnyWorkspaceReadAccess(sub,1,['booking_members']),error=>error.status===403);
    });
    await t.test('denied CRUD flags block direct requests across the actual resource routers',async()=>{
      const modules=['booking_bookings','booking_new_booking','booking_dashboard','booking_draws','booking_kyc_all','booking_kyc_new','booking_teams','booking_members','booking_clients'];
      for(const module of modules)await call(setUserPermission,{body:{module,can_read:false,can_write:true,can_update:true,can_delete:true}});
      const token=signAccessToken({id:2,version:1,role:'sub_admin'});
      for(const [router,method,path,body] of [
        [bookingRoutes,'GET','/'],[bookingRoutes,'POST','/'],[bookingRoutes,'PUT','/1'],[bookingRoutes,'DELETE','/1'],
        [drawRoutes,'GET','/'],[drawRoutes,'POST','/1/payments'],[drawRoutes,'POST','/1/cancel'],[drawRoutes,'DELETE','/1'],
        [kycRoutes,'GET','/cases'],[kycRoutes,'POST','/cases'],[kycRoutes,'PATCH','/case/1/customer'],[kycRoutes,'DELETE','/case/1'],
        [teamRoutes,'POST','/'],[lookupRoutes,'PUT','/clients/1'],[lookupRoutes,'POST','/clients',{registration:true}],
      ]){
        const result=await request(router,method,path,token,body);
        assert.equal(result.status,403,`${method} ${path}: ${JSON.stringify(result.data)}`);
        assert.equal(result.data.code,'MODULE_ACCESS_DENIED');
      }
    });
    await t.test('company and banking edits follow separate sub-admin Update grants',async()=>{
      await call(setUserPermission,{body:{module:'booking_company_details',can_read:true,can_write:true,can_update:true,can_delete:false}});
      await call(setUserPermission,{body:{module:'booking_payment_details',can_read:true,can_write:false,can_update:false,can_delete:false}});
      assert.equal((await call(saveProjectSettings,{user:sub,body:{site_id:1,company_brand_name:'Allowed company'}})).status,200);
      assert.equal((await call(saveProjectSettings,{user:sub,body:{site_id:1,bank_name:'Blocked bank'}})).status,403);
    });
  }finally{await fixture.close();}
});
