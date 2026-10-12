import test from 'node:test';
import assert from 'node:assert/strict';
import Razorpay from 'razorpay';
import { createRazorpayGateway } from './websiteRazorpay.js';

function fixture(adapter) {
  return createRazorpayGateway({ keyId:'rzp_test_fixture',secret:'server_fixture_secret',clientFactory:options=>{
    const client = new Razorpay(options);
    client.api.rq.defaults.adapter = adapter;
    return client;
  } });
}

test('SDK creates a ₹101 INR order server-side and rejects amounts below 100 paise',async()=>{
  const calls=[];
  const gateway=fixture(async config=>{
    calls.push(config);
    const data=JSON.parse(config.data);
    return {status:200,data:{id:'order_Test101',...data},headers:{},config};
  });
  for (const amount of [0,99,100.5,NaN,'10100']) await assert.rejects(gateway.createOrder({amount}),{status:400,code:'INVALID_ORDER_AMOUNT'});
  assert.equal(calls.length,0);
  const result=await gateway.createOrder({amount:10100,currency:'INR',receipt:'token-101'});
  assert.equal(calls[0].url,'/v1/orders');
  assert.equal(calls[0].method,'post');
  assert.equal(calls[0].timeout,15000);
  assert.equal(result.amount,10100);
  assert.equal(result.currency,'INR');
  assert.deepEqual(calls[0].auth,{username:'rzp_test_fixture',password:'server_fixture_secret'});
});

test('SDK errors return safe 401/500 responses and preserve uncertain orders',async()=>{
  for (const [status,expected,uncertain] of [[401,401,false],[400,500,false],[500,500,true]]) {
    const gateway=fixture(async()=>{throw {response:{status,data:{error:{code:'BAD_REQUEST_ERROR',description:'private provider credentials'}}}};});
    await assert.rejects(gateway.createOrder({amount:10100,currency:'INR'}),error=>{
      assert.equal(error.status,expected);
      assert.equal(error.uncertain,uncertain);
      assert.doesNotMatch(error.message,/private|credentials/);
      return true;
    });
  }
  const timeout=fixture(async()=>{throw new Error('Network failure');});
  await assert.rejects(timeout.createOrder({amount:10100}),{status:500,code:'GATEWAY_TIMEOUT',uncertain:true});
  const unconfigured=createRazorpayGateway({keyId:'',secret:''});
  await assert.rejects(unconfigured.createOrder({amount:10100}),{status:503,code:'PAYMENT_UNAVAILABLE'});
});
