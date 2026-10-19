import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

// Tests use isolated signing keys and never query the configured database.
process.env.JWT_ACCESS_SECRET = 'isolated-booking-access-key-for-security-tests';
process.env.JWT_REFRESH_SECRET = 'isolated-booking-refresh-key-for-security-tests';
const { currentStaffSession } = await import('../services/staffSession.js');
const { verifyLoginOtp } = await import('../controllers/auth.controller.js');
const { default: pool } = await import('../config/db.js');
const { default: userModel } = await import('../models/User.model.js');
const { signAccessToken } = await import('../config/jwt.js');

const user={id:2,email:'test@example.test',role:'admin',token_version:1,is_active:true};
test('sessions use the current database role, reject revoked/inactive accounts and disallow unexpected signing algorithms', async () => {
  const token=signAccessToken({id:2,version:1,role:'super_admin'});
  assert.equal((await currentStaffSession(token,{query:async()=>({rows:[user]})})).role,'admin');
  for(const row of [{...user,is_active:false},{...user,token_version:2},{...user,role:'client'}]) await assert.rejects(currentStaffSession(token,{query:async()=>({rows:[row]})}));
  const wrongAlgorithm=jwt.sign({id:2,version:1},process.env.JWT_ACCESS_SECRET,{algorithm:'HS384',expiresIn:'5m'});
  await assert.rejects(currentStaffSession(wrongAlgorithm,{query:async()=>({rows:[user]})}));
});
const call = body => new Promise(resolve => {
  const res={statusCode:200,status(value){this.statusCode=value;return this;},json(data){resolve({status:this.statusCode,data});}};
  verifyLoginOtp({body},res,error=>resolve({status:error.status||500,data:{message:error.message}}));
});
test('OTP parallel guesses are capped and a correct code can only mint one session', async () => {
  const db=new PGlite();
  const original={query:pool.query,find:userModel.findById,save:userModel.setRefreshToken};
  let reservations=0,issued=0;
  pool.query=async(sql,values)=>{const result=await db.query(sql,values);if(sql.includes('attempts=attempts+1')&&result.rows.length)reservations++;return result;};
  userModel.findById=async()=>user;
  userModel.setRefreshToken=async()=>{issued++;};
  try {
    await db.exec('CREATE TABLE login_otps (id SERIAL PRIMARY KEY,user_id INTEGER,pending_token TEXT,otp_hash TEXT,attempts INTEGER DEFAULT 0,expires_at TIMESTAMPTZ,consumed_at TIMESTAMPTZ,last_sent_at TIMESTAMPTZ DEFAULT now())');
    const pending='a'.repeat(48),hash=await bcrypt.hash('123456',4);
    const add=()=>db.query("INSERT INTO login_otps(user_id,pending_token,otp_hash,expires_at) VALUES(2,$1,$2,now()+interval '5 minutes')",[pending,hash]);
    await add();
    const wrong=await Promise.all(Array.from({length:12},()=>call({pending_token:pending,otp:'654321'})));
    assert.ok(wrong.every(result=>result.status===401));assert.ok(reservations<=5);assert.equal(issued,0);
    await db.exec('TRUNCATE login_otps');await add();
    const correct=await Promise.all([call({pending_token:pending,otp:'123456'}),call({pending_token:pending,otp:'123456'})]);
    assert.equal(correct.filter(result=>result.status===200).length,1);
    assert.equal(correct.filter(result=>result.status===401).length,1);assert.equal(issued,1);
    assert.equal((await call({pending_token:pending,otp:'123456'})).status,401);
  } finally {pool.query=original.query;userModel.findById=original.find;userModel.setRefreshToken=original.save;await db.close();}
});
