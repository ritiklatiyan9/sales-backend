import test from 'node:test';
import assert from 'node:assert/strict';
import { drawFixture } from '../test/drawFixture.mjs';
import { migrateSharedSidebarLayout } from '../migrations/034_shared_sidebar_layout.js';
import { DEFAULT_SIDEBAR_LAYOUT, validateSidebarLayout } from '../services/sidebarLayout.js';
import { getSidebarLayout, saveSidebarLayout } from './sidebarLayout.controller.js';

const admin={id:1,role:'admin'},agent={id:2,role:'agent'};
const call=(handler,{user=admin,body={},query={}}={})=>new Promise(resolve=>{
  const res={statusCode:200,headers:{},status(code){this.statusCode=code;return this;},set(key,value){this.headers[key]=value;return this;},json(data){resolve({status:this.statusCode,data,headers:this.headers});}};
  handler({user,body,query},res,error=>resolve({status:error.status||500,data:{message:error.message}}));
});
test('shared order accepts only a complete unique menu of recognised routes',()=>{
  assert.deepEqual(validateSidebarLayout(DEFAULT_SIDEBAR_LAYOUT),DEFAULT_SIDEBAR_LAYOUT);
  for(const corrupt of [null,[],DEFAULT_SIDEBAR_LAYOUT.slice(1),DEFAULT_SIDEBAR_LAYOUT.map((section,i)=>i===0?{...section,items:['javascript:alert(1)']}:section),DEFAULT_SIDEBAR_LAYOUT.map((section,i)=>i===0?{...section,items:['/home','/home']}:section)]){
    assert.throws(()=>validateSidebarLayout(corrupt),error=>error.status===400);
  }
});
test('one revisioned sidebar is shared across users and sites without changing access',async t=>{
  const fixture=await drawFixture();
  try {
    await migrateSharedSidebarLayout(fixture.pool);
    const originalUsers=(await fixture.query('SELECT id,role FROM users ORDER BY id')).rows;
    const originalSites=(await fixture.query('SELECT * FROM user_sites ORDER BY user_id,site_id')).rows;
    const first=await call(getSidebarLayout,{user:agent,query:{site_id:2}});
    assert.equal(first.status,200);assert.equal(first.data.scope,'global');assert.equal(first.data.can_edit,false);assert.equal(first.data.revision,0);
    assert.equal(first.headers['Cache-Control'],'private, no-store');
    const moved=structuredClone(DEFAULT_SIDEBAR_LAYOUT);
    moved[1].items=moved[1].items.filter(path=>path!=='/clients');moved[0].items.unshift('/clients');
    await t.test('only current Admin or Super Admin may save a global change',async()=>{
      for(const role of ['agent','sub_admin','staff','client'])assert.equal((await call(saveSidebarLayout,{user:{id:2,role},body:{layout:moved,revision:0}})).status,403);
      assert.equal((await call(saveSidebarLayout,{body:{layout:moved,revision:0,site_id:1}})).status,400);
      assert.equal((await call(getSidebarLayout)).data.revision,0);
    });
    await t.test('saved order is shared and survives a repeat migration',async()=>{
      const saved=await call(saveSidebarLayout,{body:{layout:moved,revision:0}});
      assert.equal(saved.status,200);assert.equal(saved.data.revision,1);assert.equal(saved.data.can_edit,true);
      await migrateSharedSidebarLayout(fixture.pool);
      for(const user of [agent,{id:2,role:'sub_admin'},admin]){
        const record=(await call(getSidebarLayout,{user,query:{site_id:user.id}})).data;
        assert.deepEqual(record.layout,moved);assert.equal(record.revision,1);
      }
    });
    await t.test('simultaneous administrators cannot silently overwrite a newer order',async()=>{
      const attempts=await Promise.all([call(saveSidebarLayout,{body:{layout:DEFAULT_SIDEBAR_LAYOUT,revision:1}}),call(saveSidebarLayout,{user:{id:1,role:'super_admin'},body:{layout:moved,revision:1}})]);
      assert.deepEqual(attempts.map(item=>item.status).sort(),[200,409]);
      assert.equal(attempts.find(item=>item.status===409).data.code,'SIDEBAR_LAYOUT_CONFLICT');
      assert.equal((await call(getSidebarLayout)).data.revision,2);
      assert.equal((await call(saveSidebarLayout,{body:{layout:moved,revision:0}})).status,409);
    });
    assert.deepEqual((await fixture.query('SELECT id,role FROM users ORDER BY id')).rows,originalUsers);
    assert.deepEqual((await fixture.query('SELECT * FROM user_sites ORDER BY user_id,site_id')).rows,originalSites);
  } finally {await fixture.close();}
});
