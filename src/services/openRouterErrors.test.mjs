import test from 'node:test';
import assert from 'node:assert/strict';
import { openRouterChat } from './openRouter.service.js';
import errorMiddleware from '../middlewares/error.middleware.js';

const response = () => ({statusCode:200,headers:{},set(key,value){this.headers[key]=value;return this;},status(code){this.statusCode=code;return this;},json(value){this.body=value;return this;}});
test('missing OCR configuration reaches the client as a safe actionable 503 without leaking internal details', async () => {
  const key=process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    let problem;
    try { await openRouterChat('fictional diagnostic text'); } catch(error){problem=error;}
    assert.equal(problem.code,'OCR_NOT_CONFIGURED');
    const res=response();errorMiddleware(problem,{},res,()=>{});
    assert.equal(res.statusCode,503);assert.equal(res.body.code,'OCR_NOT_CONFIGURED');
    assert.match(res.body.message,/not configured/);
    assert.doesNotMatch(res.body.message,/OPENROUTER_API_KEY|not set — cannot/);
  } finally { if(key===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=key; }
});
test('provider credentials, credits and missing models have stable errors without returning provider response bodies', async () => {
  const saved={fetch:globalThis.fetch,key:process.env.OPENROUTER_API_KEY};process.env.OPENROUTER_API_KEY='isolated-test-key';
  try {
    for(const [status,code] of [[401,'OCR_PROVIDER_AUTH'],[403,'OCR_PROVIDER_AUTH'],[402,'OCR_PROVIDER_BILLING'],[404,'OCR_MODEL_UNAVAILABLE']]){
      globalThis.fetch=async()=>new Response('private provider payload with secret-token',{status});
      let problem;try{await openRouterChat('fictional document');}catch(error){problem=error;}
      const res=response();errorMiddleware(problem,{},res,()=>{});
      assert.equal(res.statusCode,503);assert.equal(res.body.code,code);
      assert.doesNotMatch(JSON.stringify(res.body),/secret-token|isolated-test-key|private provider payload/);
    }
  }finally{globalThis.fetch=saved.fetch;if(saved.key===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=saved.key;}
});
test('unexpected 5xx messages stay private even when an unapproved publicMessage is attached',()=>{
 const res=response();errorMiddleware(Object.assign(new Error('database password'),{status:500,code:'UNEXPECTED_INTERNAL',publicMessage:'private credentials'}),{},res,()=>{});
 assert.equal(res.body.code,undefined);assert.doesNotMatch(res.body.message,/credentials|password/);
});
