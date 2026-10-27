import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { STAFF_AUTH_SELECT } from './staffIdentity.service.js';
import { MOBILE_SESSION_DAYS, normalizeMobile } from './mobilePortal.service.js';
import { mailerEnabled, sendBrokerPasswordResetEmail } from './mailer.service.js';
import { createCompanyRedactor } from './brokerPresentation.service.js';

const ISSUER='my-real-assets-broker-bookings';
const AUDIENCE='my-real-assets-broker';
const fail=(statusCode,message)=>{throw Object.assign(new Error(message),{statusCode});};
const unauthorized=()=>fail(401,'Please sign in again.');
const invalid=()=>fail(401,'Mobile number or app password did not match.');
const invalidReset=()=>fail(400,'This verification code is invalid or expired. Request a new code.');
const cleanAadhaar=value=>typeof value==='string'&&value.length<=32?value.replace(/[\s-]/g,''):'';
const validAadhaar=value=>/^[2-9]\d{11}$/.test(value);
const activeSql=alias=>`(COALESCE(to_jsonb(${alias})->>'is_active','true')<>'false'
  AND upper(trim(COALESCE(to_jsonb(${alias})->>'status','ACTIVE'))) NOT IN ('INACTIVE','BLOCKED','DISABLED','DEACTIVATED','DELETED','SUSPENDED'))`;
const brokerRole=alias=>`'BROKER'=ANY(COALESCE(${alias}.member_types,ARRAY[${alias}.member_type]))`;
const key=purpose=>{
  const root=process.env.MOBILE_PORTAL_SECRET||process.env.JWT_ACCESS_SECRET;
  if(!root||root.length<32)fail(503,'Sign-in is temporarily unavailable.');
  return createHmac('sha256',root).update(`bookings/my-real-assets-broker/v2/${purpose}`).digest();
};
// Keep an explicitly configured identity secret stable across signing-key
// rotation. The fallback needs no extra environment setting on existing hosts.
const identityKey=(phone,aadhaar)=>{
  const dedicated=process.env.BROKER_MOBILE_IDENTITY_SECRET;
  if(dedicated!==undefined&&dedicated.length<32)fail(503,'Sign-in is temporarily unavailable.');
  return createHmac('sha256',dedicated||key('member-identity')).update(`${phone}:${aadhaar}`).digest('hex');
};
const sameHash=(a,b)=>typeof a==='string'&&typeof b==='string'&&/^[a-f0-9]{64}$/.test(a)&&/^[a-f0-9]{64}$/.test(b)
  &&timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
const digest=value=>createHash('sha256').update(value).digest('hex');
const codeHash=(tokenHash,code)=>createHmac('sha256',key('reset-code')).update(`${tokenHash}:${code}`).digest('hex');
const validPassword=value=>typeof value==='string'&&value.length>=8&&Buffer.byteLength(value,'utf8')<=72;
const requirePassword=value=>{if(!validPassword(value))fail(400,'Use at least 8 characters and at most 72 UTF-8 bytes for your app password.');};
const memberColumns=`m.id,m.site_id,m.full_name,m.phone,m.email,m.aadhar_no,s.organization_id,
  s.name AS private_site_name,(SELECT o.name FROM organizations o WHERE o.id=s.organization_id) AS private_org_name,
  ${activeSql('m')} AS broker_active,${brokerRole('m')} AS broker_role`;
const resetMessage='If the registered details can receive a verification code, it will arrive shortly. Otherwise, contact your account administrator.';
const emailHint=email=>{const [local]=email.split('@');return `${local.slice(0,Math.min(2,local.length))}${'•'.repeat(Math.max(3,local.length-2))}@•••`;};

export function createBrokerMobileAuthService(db,{
  now=Date.now,sendResetEmail=sendBrokerPasswordResetEmail,isResetMailerEnabled=mailerEnabled,
  bcryptRounds=12,generateCode=()=>String(randomInt(100000,1000000)),generateToken=()=>randomBytes(24).toString('hex'),
}={}){
  async function transaction(handler){
    const connection=await db.connect();
    try{await connection.query('BEGIN');const value=await handler(connection);await connection.query('COMMIT');return value;}
    catch(error){await connection.query('ROLLBACK');throw error;}
    finally{connection.release();}
  }
  const matchingIdentity=(member,account)=>normalizeMobile(member.phone)===account.phone&&validAadhaar(cleanAadhaar(member.aadhar_no))
    &&sameHash(identityKey(account.phone,cleanAadhaar(member.aadhar_no)),account.identity_key);
  async function sourceMembers(phone,aadhaar,connection=db,{lock=false}={}){
    const {rows}=await connection.query(`SELECT ${memberColumns} FROM members m JOIN sites s ON s.id=m.site_id
      WHERE ${brokerRole('m')} AND right(regexp_replace(COALESCE(m.phone,''),'[^0-9]','','g'),10)=$1
      ORDER BY m.id LIMIT 1001 ${lock?'FOR SHARE OF m':''}`,[phone]);
    if(rows.length>1000)invalid();
    return rows.filter(member=>normalizeMobile(member.phone)===phone&&cleanAadhaar(member.aadhar_no)===aadhaar);
  }
  async function appendMembersAndBindings(account,members,connection){
    if(!members.length||!members.some(m=>m.broker_active))invalid();
    const ids=members.map(m=>m.id);
    const {rows:claimed}=await connection.query(`SELECT member_id,account_id FROM booking_broker_mobile_members WHERE member_id=ANY($1::integer[])`,[ids]);
    if(claimed.some(row=>row.account_id!==account.id))invalid();
    for(const member of members)await connection.query(`INSERT INTO booking_broker_mobile_members(account_id,member_id)
      VALUES($1,$2) ON CONFLICT(member_id) DO NOTHING`,[account.id,member.id]);
    const {rows:links}=await connection.query(`SELECT user_id,member_id,kyc_case_id FROM booking_user_kyc_links WHERE member_id=ANY($1::integer[])`,[ids]);
    for(const link of links){
      if(!link.kyc_case_id)unauthorized();
      await connection.query(`INSERT INTO booking_broker_mobile_user_bindings(account_id,user_id,member_id,kyc_case_id)
        VALUES($1,$2,$3,$4) ON CONFLICT(account_id,user_id) DO NOTHING`,[account.id,link.user_id,link.member_id,link.kyc_case_id]);
    }
  }
  async function contextFor(account,connection=db){
    if(!account||account.is_active!==true)unauthorized();
    const {rows:linkedMembers}=await connection.query(`SELECT ${memberColumns} FROM members m
      JOIN sites s ON s.id=m.site_id JOIN booking_broker_mobile_members bm ON bm.member_id=m.id AND bm.account_id=$1
      ORDER BY m.id`,[account.id]);
    const members=linkedMembers.filter(m=>m.broker_active&&m.broker_role&&matchingIdentity(m,account));
    if(!members.length)unauthorized();
    const {rows:bindings}=await connection.query(`SELECT b.user_id,b.member_id,b.kyc_case_id,
      EXISTS(SELECT 1 FROM kyc_cases k JOIN members m ON m.id=k.client_member_id AND m.site_id=k.site_id
        WHERE k.id=b.kyc_case_id AND k.client_member_id=b.member_id AND k.status='VERIFIED'
        AND ${brokerRole('m')} AND ${activeSql('m')}) AS binding_verified
      FROM booking_broker_mobile_user_bindings b WHERE b.account_id=$1 ORDER BY b.user_id`,[account.id]);
    const currentLinks=(await connection.query(`SELECT user_id,member_id,kyc_case_id FROM booking_user_kyc_links
      WHERE member_id=ANY($1::integer[])`,[linkedMembers.map(m=>m.id)])).rows;
    // New staff enrollment changes the authority boundary. An older member-only
    // token cannot ignore it; fresh password authentication captures the binding.
    if(currentLinks.some(link=>!bindings.some(b=>b.user_id===link.user_id&&b.member_id===link.member_id&&b.kyc_case_id===link.kyc_case_id)))unauthorized();
    let users=[];let sites=members.map(m=>m.site_id);
    if(bindings.length){
      users=(await connection.query(`${STAFF_AUTH_SELECT} WHERE u.id=ANY($1::integer[]) ORDER BY u.id`,[bindings.map(b=>b.user_id)])).rows;
      for(const binding of bindings){
        const user=users.find(u=>u.id===binding.user_id);
        if(!user||user.role!=='agent'||user.is_active!==true||user.can_login_booking===false
          ||(user.agent_status!=null&&user.agent_status!=='ACTIVE')||!binding.binding_verified
          ||user.booking_kyc_member_id!==binding.member_id||user.booking_kyc_case_id!==binding.kyc_case_id
          ||!members.some(m=>m.id===binding.member_id))unauthorized();
      }
      const grants=(await connection.query(`SELECT us.user_id,us.site_id,s.organization_id FROM user_sites us
        JOIN sites s ON s.id=us.site_id WHERE us.user_id=ANY($1::integer[])`,[users.map(u=>u.id)])).rows;
      sites=members.filter(m=>grants.some(g=>g.site_id===m.site_id&&users.some(u=>u.id===g.user_id
        &&(u.organization_id==null||u.organization_id===g.organization_id)))).map(m=>m.site_id);
    }
    const siteIds=[...new Set(sites)].sort((a,b)=>a-b);
    const scopeMembers=members.filter(m=>siteIds.includes(m.site_id));
    const redactor=createCompanyRedactor(members.flatMap(member=>[member.private_site_name,member.private_org_name]));
    const name=redactor.text(members[0].full_name||'Partner').replace(/\[Private\]/g,'').trim().replace(/^[-–—|: ]+|[-–—|: ]+$/g,'').trim()||'Partner';
    const user={id:`broker:${account.id}`,name,role:'broker'};
    const identity=createHmac('sha256',key('session-identity')).update(JSON.stringify([
      account.id,account.phone,account.identity_key,account.password_hash,account.password_changed,account.token_version,
      members.map(m=>[m.id,m.site_id,m.email||'']),siteIds,
      users.map(u=>[u.id,u.password,u.token_version,u.booking_aadhaar_password_hash,u.booking_aadhaar_password_fingerprint,u.booking_kyc_member_id,u.booking_kyc_case_id]),
    ])).digest('hex');
    const emails=[...new Set(members.map(m=>String(m.email||'').trim().toLowerCase()).filter(e=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)&&e.length<=254))];
    return {account,members:scopeMembers,brokerMemberIds:scopeMembers.map(m=>m.id),userIds:users.map(u=>u.id),siteIds,user,identity,email:emails.length===1?emails[0]:null};
  }
  async function getAccount(id,connection=db,{lock=false}={}){
    return (await connection.query(`SELECT * FROM booking_broker_mobile_accounts WHERE id=$1 ${lock?'FOR UPDATE':''}`,[id])).rows[0];
  }
  async function provisionIdentity(phone,aadhaar){
    const identity=identityKey(phone,aadhaar);
    return transaction(async connection=>{
      await connection.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`broker-mobile:${phone}:${identity}`]);
      let account=(await connection.query(`SELECT * FROM booking_broker_mobile_accounts WHERE phone=$1 AND identity_key=$2 FOR UPDATE`,[phone,identity])).rows[0];
      const members=await sourceMembers(phone,aadhaar,connection,{lock:true});
      if(!members.length||!members.some(m=>m.broker_active))invalid();
      if(!account){
        const claimed=await connection.query(`SELECT member_id FROM booking_broker_mobile_members WHERE member_id=ANY($1::integer[]) LIMIT 1`,[members.map(m=>m.id)]);
        if(claimed.rows.length)invalid();
        account=(await connection.query(`INSERT INTO booking_broker_mobile_accounts(phone,identity_key,password_hash)
          VALUES($1,$2,$3) RETURNING *`,[phone,identity,await bcrypt.hash(aadhaar,bcryptRounds)])).rows[0];
      }
      if(!account.is_active)unauthorized();
      await appendMembersAndBindings(account,members,connection);
      return contextFor(account,connection);
    });
  }
  async function syncAccountIdentity(account){
    return transaction(async connection=>{
      const current=await getAccount(account.id,connection,{lock:true});
      if(!current||!current.is_active||current.password_hash!==account.password_hash||current.token_version!==account.token_version)unauthorized();
      const {rows}=await connection.query(`SELECT ${memberColumns} FROM members m JOIN sites s ON s.id=m.site_id
        WHERE ${brokerRole('m')} AND right(regexp_replace(COALESCE(m.phone,''),'[^0-9]','','g'),10)=$1
        ORDER BY m.id LIMIT 1001 FOR SHARE OF m`,[current.phone]);
      if(rows.length>1000)unauthorized();
      await appendMembersAndBindings(current,rows.filter(m=>matchingIdentity(m,current)),connection);
      return contextFor(current,connection);
    });
  }
  function requireDifferentFromAadhaar(account,password){
    const aadhaar=cleanAadhaar(password);
    if(validAadhaar(aadhaar)&&sameHash(identityKey(account.phone,aadhaar),account.identity_key))fail(400,'Choose an app password different from your Aadhaar number.');
  }
  function issue(session){
    const token=jwt.sign({realm:'mobile-broker-member',version:session.account.token_version,identity:session.identity,iat:Math.floor(now()/1000)},key('access'),{
      algorithm:'HS256',issuer:ISSUER,audience:AUDIENCE,subject:`mra-broker-member:${session.account.id}`,expiresIn:`${MOBILE_SESSION_DAYS}d`,
    });
    return {token,user:session.user,expiresAt:new Date(jwt.decode(token).exp*1000).toISOString(),sessionDurationDays:MOBILE_SESSION_DAYS};
  }
  async function getSession(token){
    let claims;
    try{claims=jwt.verify(token,key('access'),{algorithms:['HS256'],issuer:ISSUER,audience:AUDIENCE,clockTimestamp:Math.floor(now()/1000)});}catch{unauthorized();}
    if(claims.realm!=='mobile-broker-member'||!/^mra-broker-member:[1-9]\d*$/.test(claims.sub||'')||!Number.isSafeInteger(claims.version))unauthorized();
    const account=await getAccount(Number(claims.sub.split(':')[1]));
    if(!account||account.token_version!==claims.version)unauthorized();
    const session=await contextFor(account);
    if(!sameHash(session.identity,claims.identity))unauthorized();
    return session;
  }
  async function login(body){
    if(!body||typeof body!=='object'||Array.isArray(body)||(body.role!==undefined&&body.role!=='broker'))invalid();
    const mobile=normalizeMobile(body.mobile??body.identifier);
    const password=body.password??body.aadhaar;
    if(!mobile||typeof password!=='string'||!password||Buffer.byteLength(password,'utf8')>256)invalid();
    const aadhaar=cleanAadhaar(password);
    const {rows:accounts}=await db.query('SELECT * FROM booking_broker_mobile_accounts WHERE phone=$1 ORDER BY id LIMIT 21',[mobile]);
    if(accounts.length>20)invalid();
    const matches=[];
    for(const account of accounts){
      if(!account.is_active||account.password_changed&&Buffer.byteLength(password,'utf8')>72)continue;
      if(!account.password_changed&&(!validAadhaar(aadhaar)||!sameHash(account.identity_key,identityKey(mobile,aadhaar))))continue;
      if(await bcrypt.compare(account.password_changed?password:aadhaar,account.password_hash)){
        try{matches.push(await syncAccountIdentity(account));}catch(error){if(error.statusCode!==401)throw error;}
      }
    }
    if(matches.length!==0){if(matches.length!==1)invalid();return issue(matches[0]);}
    if(!validAadhaar(aadhaar))invalid();
    const identity=identityKey(mobile,aadhaar);
    // Existing chosen/disabled credentials are final. A matching raw member
    // record or later OCR edit can never recreate an initial Aadhaar password.
    if(accounts.some(a=>sameHash(a.identity_key,identity)))invalid();
    const session=await provisionIdentity(mobile,aadhaar);
    if(session.account.password_changed)invalid();
    return issue(session);
  }
  async function requestPasswordReset(body){
    const fake=()=>({challengeId:generateToken(),expiresInSeconds:300,resendAfterSeconds:60,message:resetMessage});
    const mobile=normalizeMobile(body?.mobile);const aadhaar=cleanAadhaar(body?.aadhaar);
    if(!mobile||!validAadhaar(aadhaar))return fake();
    let session;
    try{session=await provisionIdentity(mobile,aadhaar);}catch(error){if([400,401,403,404].includes(error.statusCode))return fake();throw error;}
    if(!session.email||!isResetMailerEnabled())fail(503,'A recovery email is unavailable for these registered details. Please contact your account administrator.');
    const date=new Date(now());
    const challengeId=generateToken();const tokenHash=digest(challengeId);const code=generateCode();
    if(!/^[a-f0-9]{48}$/.test(challengeId)||!/^\d{6}$/.test(code))fail(503,'Password recovery is temporarily unavailable.');
    session=await transaction(async connection=>{
      const account=await getAccount(session.account.id,connection,{lock:true});
      const current=await contextFor(account,connection);
      if(!current.email)fail(503,'A recovery email is unavailable. Please contact your account administrator.');
      const recent=(await connection.query(`SELECT created_at FROM booking_broker_mobile_resets WHERE account_id=$1
        AND created_at>$2 ORDER BY created_at DESC`,[account.id,new Date(now()-15*60*1000)])).rows;
      if(recent.length>=5||recent.some(r=>new Date(r.created_at).getTime()>now()-60000))fail(429,'Please wait before requesting another verification code.');
      await connection.query(`UPDATE booking_broker_mobile_resets SET consumed_at=$2 WHERE account_id=$1 AND consumed_at IS NULL`,[account.id,date]);
      await connection.query(`INSERT INTO booking_broker_mobile_resets(token_hash,account_id,account_version,identity_key,scope_fingerprint,email_snapshot,code_hash,expires_at,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[tokenHash,account.id,account.token_version,account.identity_key,
        current.identity,current.email,codeHash(tokenHash,code),new Date(now()+5*60*1000),date]);
      return current;
    });
    try{await sendResetEmail({to:session.email,name:session.user.name,code,minutes:5});}
    catch{await db.query('UPDATE booking_broker_mobile_resets SET consumed_at=$2 WHERE token_hash=$1',[tokenHash,date]);fail(503,'The verification email could not be delivered. Please try again later.');}
    return {challengeId,emailHint:emailHint(session.email),expiresInSeconds:300,resendAfterSeconds:60,message:resetMessage};
  }
  async function confirmPasswordReset(body){
    const {challengeId,code,newPassword}=body||{};requirePassword(newPassword);
    if(typeof challengeId!=='string'||! /^[a-f0-9]{48}$/.test(challengeId)||typeof code!=='string'||!/^\d{6}$/.test(code))invalidReset();
    const tokenHash=digest(challengeId);const date=new Date(now());
    // Reserve an attempt atomically before checking the code so parallel guesses
    // cannot all share a stale attempts counter.
    const reserved=(await db.query(`UPDATE booking_broker_mobile_resets SET attempts=attempts+1
      WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>$2 AND attempts<5 RETURNING *`,[tokenHash,date])).rows[0];
    if(!reserved||!sameHash(reserved.code_hash,codeHash(tokenHash,code)))invalidReset();
    const passwordHash=await bcrypt.hash(newPassword,bcryptRounds);
    return transaction(async connection=>{
      // All credential writers lock the account before its reset rows. Keeping
      // this order matches resend/change and avoids account↔challenge deadlocks.
      const account=await getAccount(reserved.account_id,connection,{lock:true});
      const challenge=(await connection.query('SELECT * FROM booking_broker_mobile_resets WHERE id=$1 FOR UPDATE',[reserved.id])).rows[0];
      if(!challenge||challenge.consumed_at||new Date(challenge.expires_at).getTime()<=now()||challenge.attempts>5)invalidReset();
      if(!account||account.id!==challenge.account_id||account.token_version!==challenge.account_version||!sameHash(account.identity_key,challenge.identity_key))invalidReset();
      requireDifferentFromAadhaar(account,newPassword);
      let session;try{session=await contextFor(account,connection);}catch(error){if(error.statusCode===401)invalidReset();throw error;}
      if(session.email!==challenge.email_snapshot||!sameHash(session.identity,challenge.scope_fingerprint))invalidReset();
      const consumed=await connection.query(`UPDATE booking_broker_mobile_resets SET consumed_at=$2
        WHERE id=$1 AND consumed_at IS NULL AND expires_at>$2 RETURNING id`,[challenge.id,date]);
      if(!consumed.rows.length)invalidReset();
      await connection.query(`UPDATE booking_broker_mobile_accounts SET password_hash=$2,password_changed=true,
        token_version=token_version+1,updated_at=$3 WHERE id=$1`,[account.id,passwordHash,date]);
      await connection.query('UPDATE booking_broker_mobile_resets SET consumed_at=$2 WHERE account_id=$1 AND consumed_at IS NULL',[account.id,date]);
      return {success:true};
    });
  }
  async function changePassword(session,body){
    const {currentPassword,newPassword}=body||{};requirePassword(newPassword);
    if(typeof currentPassword!=='string'||!currentPassword||Buffer.byteLength(currentPassword,'utf8')>256)fail(400,'Your current app password is incorrect.');
    const hash=await bcrypt.hash(newPassword,bcryptRounds);
    return transaction(async connection=>{
      const account=await getAccount(session.account.id,connection,{lock:true});
      const current=await contextFor(account,connection);
      if(account.token_version!==session.account.token_version||!sameHash(current.identity,session.identity))unauthorized();
      requireDifferentFromAadhaar(account,newPassword);
      if(!await bcrypt.compare(account.password_changed?currentPassword:cleanAadhaar(currentPassword),account.password_hash))fail(400,'Your current app password is incorrect.');
      await connection.query(`UPDATE booking_broker_mobile_accounts SET password_hash=$2,password_changed=true,
        token_version=token_version+1,updated_at=$3 WHERE id=$1`,[account.id,hash,new Date(now())]);
      await connection.query('UPDATE booking_broker_mobile_resets SET consumed_at=$2 WHERE account_id=$1 AND consumed_at IS NULL',[account.id,new Date(now())]);
      return {success:true};
    });
  }
  return {login,getSession,requestPasswordReset,confirmPasswordReset,changePassword};
}
