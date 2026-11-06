import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import { clientIdentityKey } from './clientPortal.service.js';
import { normalizeStaffPhone } from './staffIdentity.service.js';
import { memberPhoneSql } from './clientRegistry.service.js';
import { lockClientPasswordPhone, passwordUsedByAnotherAccount } from './clientPasswordUniqueness.js';

const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
const genericFailure = () => fail(401, 'Invitation is invalid or expired. Please contact the office.');
const hashCode = code => createHash('sha256').update(code).digest('hex');
const cleanAadhaar = value => String(value || '').replace(/[\s-]/g, '');
const eligible = `COALESCE(to_jsonb(m)->>'is_active','true') <> 'false'
  AND 'CLIENT' = ANY(COALESCE(m.member_types,ARRAY[m.member_type]))
  AND EXISTS (SELECT 1 FROM kyc_cases k WHERE k.client_member_id=m.id AND k.site_id=m.site_id AND k.status='VERIFIED')`;

export function createClientInvitationService(db, { now = () => new Date(), generateCode = () => randomBytes(18).toString('base64url') } = {}) {
  async function transaction(action) {
    const c = await db.connect();
    try { await c.query('BEGIN'); const result = await action(c); await c.query('COMMIT'); return result; }
    catch (error) { await c.query('ROLLBACK'); throw error; }
    finally { c.release(); }
  }
  return {
    async issue({ memberId, issuedBy, identityVerified }) {
      if (!Number.isSafeInteger(memberId) || memberId < 1 || !Number.isSafeInteger(issuedBy) || issuedBy < 1 || identityVerified !== true) {
        fail(400, 'Verify the customer in person and select their member record.');
      }
      const code = generateCode();
      if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{24}$/.test(code)) throw new Error('Invitation code generation failed');
      const expiry = new Date(now().getTime() + 24 * 60 * 60 * 1000);
      await transaction(async c => {
        const rows = (await c.query(`SELECT m.id,m.phone,m.aadhar_no FROM members m WHERE m.id=$1 AND ${eligible} FOR UPDATE OF m`, [memberId])).rows;
        const member = rows[0];
        if (!member || !normalizeStaffPhone(member.phone || '') || !/^[2-9]\d{11}$/.test(cleanAadhaar(member.aadhar_no))) {
          fail(404, 'Verified customer record unavailable.');
        }
        const linked = await c.query('SELECT a.password_changed FROM booking_client_members cm JOIN booking_client_accounts a ON a.id=cm.account_id WHERE cm.member_id=$1', [memberId]);
        if (linked.rows.some(row => row.password_changed)) fail(409, 'This customer already has an active account.');
        const sameIdentity = await c.query('SELECT password_changed FROM booking_client_accounts WHERE phone=$1 AND identity_key=$2', [normalizeStaffPhone(member.phone), clientIdentityKey(cleanAadhaar(member.aadhar_no))]);
        if (sameIdentity.rows.some(row => row.password_changed)) fail(409, 'This customer already has an active account.');
        await c.query('UPDATE booking_client_invitations SET consumed_at=$2 WHERE member_id=$1 AND consumed_at IS NULL', [memberId, now()]);
        await c.query('INSERT INTO booking_client_invitations(member_id,code_hash,issued_by,expires_at) VALUES($1,$2,$3,$4)', [memberId,hashCode(code),issuedBy,expiry]);
      });
      return { code, expiresAt: expiry.toISOString() };
    },
    async activate(body) {
      const mobile = normalizeStaffPhone(body?.mobile || '');
      const code = typeof body?.code === 'string' ? body.code.trim() : '';
      const newPassword = body?.newPassword;
      if (!mobile || !/^[A-Za-z0-9_-]{24}$/.test(code) || typeof newPassword !== 'string' || newPassword.length < 12 || Buffer.byteLength(newPassword,'utf8') > 72) genericFailure();
      const passwordHash = await bcrypt.hash(newPassword, 12);
      await transaction(async c => {
        await lockClientPasswordPhone(c, mobile);
        const invites = (await c.query('SELECT * FROM booking_client_invitations WHERE code_hash=$1 AND consumed_at IS NULL AND expires_at>$2', [hashCode(code),now()])).rows;
        if (invites.length !== 1) genericFailure();
        const invitation = invites[0];
        const selected = (await c.query(`SELECT m.id,m.phone,m.aadhar_no FROM members m WHERE m.id=$1 AND ${eligible}`, [invitation.member_id])).rows[0];
        const aadhaar = cleanAadhaar(selected?.aadhar_no);
        if (!selected || normalizeStaffPhone(selected.phone || '') !== mobile || !/^[2-9]\d{11}$/.test(aadhaar) || cleanAadhaar(newPassword) === aadhaar || newPassword === code) genericFailure();
        // The verified identity may have separate records on multiple sites.
        // Match both identifiers exactly, recheck verified KYC and lock every
        // matched row before linking; never group by name or phone alone.
        const rows = (await c.query(`SELECT m.id,m.phone,m.aadhar_no FROM members m
          WHERE ${memberPhoneSql()}=$1 AND regexp_replace(COALESCE(m.aadhar_no,''),'[[:space:]-]','','g')=$2
          AND ${eligible} ORDER BY m.id LIMIT 1001 FOR UPDATE OF m`, [mobile,aadhaar])).rows
          .filter(row => normalizeStaffPhone(row.phone || '') === mobile && cleanAadhaar(row.aadhar_no) === aadhaar);
        if (rows.length > 1000 || !rows.some(row => row.id === invitation.member_id)) genericFailure();
        const memberIds = rows.map(row => row.id);
        const verified = (await c.query(`SELECT k.client_member_id FROM kyc_cases k JOIN members m
          ON m.id=k.client_member_id AND m.site_id=k.site_id
          WHERE m.id=ANY($1::integer[]) AND k.status='VERIFIED' FOR SHARE OF k`, [memberIds])).rows;
        if (new Set(verified.map(row => row.client_member_id)).size !== memberIds.length) genericFailure();
        const locked = (await c.query('SELECT id FROM booking_client_invitations WHERE id=$1 AND consumed_at IS NULL AND expires_at>$2 FOR UPDATE', [invitation.id,now()])).rows;
        if (locked.length !== 1) genericFailure();
        const identity = clientIdentityKey(aadhaar);
        const accounts = (await c.query('SELECT * FROM booking_client_accounts WHERE phone=$1 AND identity_key=$2 FOR UPDATE', [mobile,identity])).rows;
        let account = accounts[0];
        if (account && (!account.is_active || account.password_changed)) genericFailure();
        if (await passwordUsedByAnotherAccount(c, mobile, newPassword, account?.id)) {
          fail(400, 'Choose a different password.');
        }
        const owners = (await c.query('SELECT account_id,member_id FROM booking_client_members WHERE member_id=ANY($1::integer[])', [memberIds])).rows;
        if (owners.some(owner => !account || owner.account_id !== account.id)) genericFailure();
        if (account) {
          account = (await c.query('UPDATE booking_client_accounts SET password_hash=$2,password_changed=true,token_version=token_version+1,updated_at=now() WHERE id=$1 RETURNING *', [account.id,passwordHash])).rows[0];
        } else {
          account = (await c.query('INSERT INTO booking_client_accounts(phone,identity_key,password_hash,aadhaar_last4,password_changed) VALUES($1,$2,$3,$4,true) RETURNING *', [mobile,identity,passwordHash,aadhaar.slice(-4)])).rows[0];
        }
        for (const memberId of memberIds) {
          if (!owners.some(owner => owner.member_id === memberId)) await c.query('INSERT INTO booking_client_members(account_id,member_id) VALUES($1,$2)', [account.id,memberId]);
        }
        await c.query('UPDATE booking_client_invitations SET consumed_at=$2 WHERE id=$1', [invitation.id,now()]);
      });
    },
  };
}
