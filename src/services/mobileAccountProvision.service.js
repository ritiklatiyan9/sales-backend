import bcrypt from 'bcrypt';
import { clientIdentityKey } from './clientPortal.service.js';
import { normalizeStaffPhone } from './staffIdentity.service.js';
import { memberPhoneSql } from './clientRegistry.service.js';

const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
const cleanIdentity = value => String(value || '').replace(/[\s-]/g, '');
const eligible = `COALESCE(to_jsonb(m)->>'is_active','true') <> 'false'
 AND 'CLIENT' = ANY(COALESCE(m.member_types,ARRAY[m.member_type]))
 AND EXISTS (SELECT 1 FROM kyc_cases k WHERE k.client_member_id=m.id AND k.site_id=m.site_id AND k.status='VERIFIED')`;

// Only the authenticated office route may call this. It creates an initial
// setup-only account; it never returns identity numbers or password hashes.
export function createMobileAccountProvisioner(db) {
  return {
    async provision({ memberId, identityVerified, actorId, actorVersion }) {
      if (!Number.isSafeInteger(memberId) || memberId < 1 || !Number.isSafeInteger(actorId) || actorId < 1 || !Number.isSafeInteger(actorVersion) || identityVerified !== true) {
        fail(400, 'Verify the customer in person and select their client record.');
      }
      const c = await db.connect();
      try {
        await c.query('BEGIN');
        const actor = (await c.query('SELECT role,is_active,token_version,can_login_booking FROM users WHERE id=$1 FOR SHARE', [actorId])).rows[0];
        if (!actor?.is_active || actor.role !== 'super_admin' || actor.can_login_booking === false || actor.token_version !== actorVersion) fail(403, 'Your staff access changed. Please sign in again.');
        const initial = (await c.query(`SELECT m.id,m.phone,m.aadhar_no,m.site_id,s.organization_id FROM members m JOIN sites s ON s.id=m.site_id WHERE m.id=$1 AND ${eligible}`, [memberId])).rows[0];
        const mobile = normalizeStaffPhone(initial?.phone || '');
        const identity = cleanIdentity(initial?.aadhar_no);
        if (!mobile || !/^[2-9]\d{11}$/.test(identity)) fail(400, 'A verified customer with a valid mobile and numeric Aadhaar is required.');
        const identityKey = clientIdentityKey(identity);
        // Share the legacy enrolment lock so either path cannot race another.
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`booking-client:${mobile}:${identityKey}`]);
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`booking-client-password:${mobile}`]);
        const matches = (await c.query(`SELECT m.id,m.phone,m.aadhar_no FROM members m
          WHERE ${memberPhoneSql()}=$1 AND regexp_replace(COALESCE(m.aadhar_no,''),'[[:space:]-]','','g')=$2
          AND ${eligible} ORDER BY m.id LIMIT 1001 FOR UPDATE OF m`, [mobile, identity])).rows
          .filter(row => normalizeStaffPhone(row.phone || '') === mobile && cleanIdentity(row.aadhar_no) === identity);
        if (matches.length > 1000 || !matches.some(row => row.id === memberId)) fail(409, 'The customer record changed. Review it and retry.');
        const ids = matches.map(row => row.id);
        const verified = (await c.query(`SELECT k.client_member_id FROM kyc_cases k JOIN members m ON m.id=k.client_member_id AND m.site_id=k.site_id
          WHERE m.id=ANY($1::integer[]) AND k.status='VERIFIED' FOR SHARE OF k`, [ids])).rows;
        if (new Set(verified.map(row => row.client_member_id)).size !== ids.length) fail(409, 'Customer verification changed. Review it and retry.');
        const accounts = (await c.query('SELECT id,identity_key,password_hash,password_changed FROM booking_client_accounts WHERE phone=$1 ORDER BY id LIMIT 21 FOR UPDATE', [mobile])).rows;
        if (accounts.length >= 20 || accounts.some(row => row.identity_key === identityKey)) fail(409, 'An app account already exists or cannot be created for this mobile.');
        for (const account of accounts) {
          if (await bcrypt.compare(identity, account.password_hash)) fail(409, 'This initial credential conflicts with an existing app account.');
        }
        const owners = (await c.query('SELECT member_id FROM booking_client_members WHERE member_id=ANY($1::integer[])', [ids])).rows;
        if (owners.length) fail(409, 'A linked client record already belongs to an app account.');
        const hash = await bcrypt.hash(identity, 12);
        const account = (await c.query(`INSERT INTO booking_client_accounts(phone,identity_key,password_hash,aadhaar_last4,password_changed)
          VALUES($1,$2,$3,$4,false) RETURNING id`, [mobile, identityKey, hash, identity.slice(-4)])).rows[0];
        for (const id of ids) await c.query('INSERT INTO booking_client_members(account_id,member_id) VALUES($1,$2)', [account.id, id]);
        await c.query(`INSERT INTO audit_logs(organization_id,site_id,user_id,action,event_type,module,entity_type,entity_id,request_method,request_path,status_code,outcome,description)
          VALUES($1,$2,$3,'CREATE','HTTP','my_real_assets','client_account',$4,'POST','/api/mobile/admin/accounts',200,'SUCCESS','Office created My Real Assets access after identity verification.')`,
          [initial.organization_id,initial.site_id,actorId,String(account.id)]);
        await c.query('COMMIT');
        return { ok: true };
      } catch (error) {
        await c.query('ROLLBACK');
        throw error;
      } finally { c.release(); }
    },
  };
}
