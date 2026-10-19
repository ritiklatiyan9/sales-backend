import test from 'node:test';
import assert from 'node:assert/strict';
import { rateLimit } from '../middlewares/rateLimit.middleware.js';
import { originAllowed } from './origins.js';
import { uploadTypeAllowed, validUploadBytes } from './uploadPolicy.js';
import { validateProductionSecurity } from './production.js';
import errorMiddleware from '../middlewares/error.middleware.js';

const response = () => ({ statusCode:200, headers:{}, set(key,value){this.headers[key]=value;return this;},status(value){this.statusCode=value;return this;},json(value){this.body=value;return this;} });
test('request limiter counts attempts, ignores spoofed forwarding headers, expires and bounds its memory', () => {
  let now = 0, passes = 0;
  const limiter = rateLimit({limit:2,windowMs:1000,maxKeys:2,clock:()=>now});
  for(let i=0;i<3;i++){const res=response();limiter({ip:'same-ip',headers:{'x-forwarded-for':String(i)}},res,()=>passes++);if(i===2){assert.equal(res.statusCode,429);assert.equal(res.headers['Retry-After'],'1');}}
  assert.equal(passes,2);
  limiter({ip:'other-ip'},response(),()=>passes++);
  const overflow=response();limiter({ip:'third-ip'},overflow,()=>passes++);assert.equal(overflow.statusCode,429);
  now=1001;limiter({ip:'third-ip'},response(),()=>passes++);assert.equal(passes,4);
});
test('CORS defaults deny arbitrary origins and production does not implicitly allow localhost', () => {
  assert.equal(originAllowed('https://evil.example',{CORS_ORIGIN:'*',NODE_ENV:'production'}),false);
  assert.equal(originAllowed('https://dgbooking.com',{NODE_ENV:'production'}),true);
  assert.equal(originAllowed('http://localhost:5173',{NODE_ENV:'production'}),false);
  assert.equal(originAllowed('http://localhost:5173',{}),true);
  assert.equal(originAllowed('https://dgbooking.com.evil.example',{}),false);
});
test('uploads require exact extensions, matching MIME and recognizable file signatures', () => {
  assert.equal(uploadTypeAllowed({originalname:'file.pdf.exe',mimetype:'application/pdf'}),false);
  assert.equal(uploadTypeAllowed({originalname:'file.pdf',mimetype:'image/jpeg'}),false);
  assert.equal(uploadTypeAllowed({originalname:'file.PDF',mimetype:'application/octet-stream'}),true);
  assert.equal(validUploadBytes({originalname:'file.pdf',buffer:Buffer.from('<script>bad()</script>')}),false);
  assert.equal(validUploadBytes({originalname:'file.pdf',buffer:Buffer.from('%PDF-1.7 document')}),true);
  assert.equal(validUploadBytes({originalname:'file.png',buffer:Buffer.from([137,80,78,71,13,10,26,10])}),true);
});
test('production refuses weak/equal secrets, wildcard CORS, unverified DB TLS and incomplete second factor', () => {
  const env={NODE_ENV:'production',JWT_ACCESS_SECRET:'a'.repeat(40),JWT_REFRESH_SECRET:'b'.repeat(40)};
  assert.doesNotThrow(()=>validateProductionSecurity(env));
  for(const patch of [{JWT_ACCESS_SECRET:'weak'},{JWT_REFRESH_SECRET:env.JWT_ACCESS_SECRET},{CORS_ORIGIN:'*'},{TRUST_PROXY:'0.0.0.0/0'},{DB_SSL_REJECT_UNAUTHORIZED:'false'},{LOGIN_OTP_ENABLED:'true'}]) assert.throws(()=>validateProductionSecurity({...env,...patch}));
});
test('unexpected failures hide internal messages while expected validation stays actionable', () => {
  const server=response();errorMiddleware(new Error('postgres password secret and SQL'),{},server,()=>{});
  assert.equal(server.statusCode,500);assert.doesNotMatch(server.body.message,/postgres|password|SQL/);
  const client=response();errorMiddleware(Object.assign(new Error('Broker code is required'),{status:400,code:'BROKER_CODE_REQUIRED'}),{},client,()=>{});
  assert.equal(client.body.message,'Broker code is required');assert.equal(client.body.code,'BROKER_CODE_REQUIRED');
  const malformed=response();errorMiddleware(Object.assign(new Error('private body'),{status:400,type:'entity.parse.failed'}),{},malformed,()=>{});
  assert.equal(malformed.body.message,'Request body must be valid JSON.');
});
