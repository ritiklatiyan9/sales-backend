import test from 'node:test';
import assert from 'node:assert/strict';
import { realtimeRoomAccess, deliverOcrUpdate } from './realtimeAccess.js';
const user={id:2,role:'agent'};
function dependencies(record, overrides={}) {
  return {session:async()=>user,visibleUsers:async()=>[2,3],permission:async()=>true,
    siteAccess:async(u,id)=>{if(id!==1)throw new Error('Wrong site');},
    db:{query:async sql=>({rows:sql.startsWith('SELECT 1')?[]:record?[record]:[]})},...overrides};
}
test('realtime subscriptions enforce site, network and module access before exposing a resource', async () => {
  const owned=dependencies({id:1,site_id:1,created_by:3});
  assert.equal((await realtimeRoomAccess('token','booking',1,owned)).room,'booking_1');
  await assert.rejects(realtimeRoomAccess('token','booking',-1,owned));
  await assert.rejects(realtimeRoomAccess('token','booking','1 OR 1=1',owned));
  await assert.rejects(realtimeRoomAccess('token','booking',2,dependencies({id:2,site_id:1,created_by:9})));
  await assert.rejects(realtimeRoomAccess('token','booking',2,dependencies({id:2,site_id:2,created_by:2})));
  await assert.rejects(realtimeRoomAccess('token','booking',1,{...owned,permission:async()=>false}));
  await assert.rejects(realtimeRoomAccess('token','booking',1,{...owned,session:async()=>{throw new Error('Revoked');}}));
});
test('case subscription permits a related draw in the same site but denies unrelated cases', async () => {
  const dependenciesWithoutDraw=dependencies({id:5,site_id:1,created_by:9,client_member_id:10});
  await assert.rejects(realtimeRoomAccess('token','kyc_case',5,dependenciesWithoutDraw));
  const withDraw={...dependenciesWithoutDraw,db:{query:async sql=>({rows:sql.startsWith('SELECT 1')?[{exists:1}]:[{id:5,site_id:1,created_by:9,client_member_id:10}]})}};
  assert.equal((await realtimeRoomAccess('token','kyc_case',5,withDraw)).room,'kyc_case_5');
});

test('events reach only authorized subscribers and revoked subscriptions are removed without global broadcast', async () => {
  const emissions=[];
  const socket=(token,room)=>({connected:true,handshake:{auth:{token}},data:{ocrSubscriptions:new Map(room?[[room,{kind:'booking',id:1}]]:[])},emit:(event,data)=>emissions.push({token,event,data})});
  const authorized=socket('allowed','booking_1'), revoked=socket('revoked','booking_1'), bystander=socket('bystander');
  const server={sockets:{sockets:new Map([['1',authorized],['2',revoked],['3',bystander]])},emit:()=>assert.fail('Must never broadcast globally')};
  await deliverOcrUpdate(server,{bookingId:1,documentId:7,status:'DONE'},async token=>{if(token!=='allowed')throw new Error('Denied');});
  assert.equal(emissions.length,1);assert.equal(emissions[0].token,'allowed');assert.equal(revoked.data.ocrSubscriptions.size,0);
});
