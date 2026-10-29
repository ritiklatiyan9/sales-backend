import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import { PGlite } from '@electric-sql/pglite';
import { createMobileAccountProvisioner } from './mobileAccountProvision.service.js';
import { createClientPortalService } from './clientPortal.service.js';

process.env.CLIENT_PORTAL_IDENTITY_SECRET = 'isolated-test-identity-secret';
process.env.CLIENT_PORTAL_SECRET = 'isolated-test-client-secret';

test('office provisioning binds only verified matching clients and never resets an account', async t => {
  const raw = new PGlite();
  const query = (sql, args) => raw.query(sql, args);
  const db = { query, connect: async () => ({ query, release() {} }) };
  t.after(() => raw.close());
  await raw.exec(`CREATE TABLE sites(id integer primary key,name text,code text,organization_id integer);
    CREATE TABLE users(id integer primary key,role text,is_active boolean,token_version integer,can_login_booking boolean);
    CREATE TABLE audit_logs(organization_id integer,site_id integer,user_id integer,action text,event_type text,module text,entity_type text,entity_id text,request_method text,request_path text,status_code integer,outcome text,description text);
    INSERT INTO users VALUES(7,'super_admin',true,2,true);
    CREATE TABLE members(id integer primary key,site_id integer,full_name text,phone text,aadhar_no text,member_type text,member_types text[],is_active boolean DEFAULT true,email text,pan_no text);
    CREATE TABLE kyc_cases(id integer primary key,client_member_id integer,site_id integer,status text);
    CREATE TABLE booking_client_accounts(id serial primary key,phone text,identity_key text,password_hash text,password_changed boolean DEFAULT false,token_version integer DEFAULT 0,is_active boolean DEFAULT true,aadhaar_last4 text,updated_at timestamptz DEFAULT now(),UNIQUE(phone,identity_key));
    CREATE TABLE booking_client_members(account_id integer,member_id integer UNIQUE);
    INSERT INTO sites VALUES(1,'Example','ONE',1),(2,'Example 2','TWO',1);
    INSERT INTO members(id,site_id,full_name,phone,aadhar_no,member_type) VALUES
      (1,1,'Example','9876500001','234567890123','CLIENT'),(2,2,'Example','9876500001','234567890123','CLIENT'),
      (3,1,'Other','9876500001','345678901234','CLIENT'),(4,1,'Unverified','9876500001','234567890123','CLIENT'),
      (5,1,'Invalid','9876500002','invalid','CLIENT');
    INSERT INTO kyc_cases VALUES(1,1,1,'VERIFIED'),(2,2,2,'VERIFIED'),(3,3,1,'VERIFIED'),(4,4,1,'OPEN'),(5,5,1,'VERIFIED');`);
  const service = createMobileAccountProvisioner(db);
  const actor = {actorId:7,actorVersion:2};
  await assert.rejects(service.provision({memberId:1,identityVerified:true,actorId:7,actorVersion:1}), {statusCode:403});
  await assert.rejects(service.provision({memberId:1, identityVerified:false,...actor}), {statusCode:400});
  await assert.rejects(service.provision({memberId:5, identityVerified:true,...actor}), {statusCode:400});
  assert.deepEqual(await service.provision({memberId:1, identityVerified:true,...actor}), {ok:true});
  const account = (await query('SELECT * FROM booking_client_accounts')).rows[0];
  assert.equal(account.password_changed, false);
  assert.equal((await query('SELECT user_id FROM audit_logs')).rows[0].user_id, 7);
  assert.equal(await bcrypt.compare('234567890123', account.password_hash), true);
  assert.deepEqual((await query('SELECT member_id FROM booking_client_members ORDER BY member_id')).rows.map(x => x.member_id), [1,2]);
  const portal = createClientPortalService(db);
  const match = await portal.authenticate('9876500001','234567890123',{dryRun:true});
  assert.equal(match.account.id, account.id);
  await assert.rejects(service.provision({memberId:2, identityVerified:true,...actor}), {statusCode:409});
  assert.equal(Number((await query('SELECT count(*) AS n FROM booking_client_accounts')).rows[0].n), 1);
});
