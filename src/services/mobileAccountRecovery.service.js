import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import { clientIdentityKey } from './clientPortal.service.js';
import { lockClientPasswordPhone, passwordUsedByAnotherAccount } from './clientPasswordUniqueness.js';
import { normalizeStaffPhone } from './staffIdentity.service.js';

const codePattern = /^[A-Za-z0-9_-]{43}$/;
const lifetimeMs = 30 * 60 * 1000;
const codeHash = code => createHash('sha256').update(code).digest('hex');
const cleanIdentity = value => String(value || '').replace(/[\s-]/g, '');
const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
const invalidLink = () => fail(401, 'This reset link is invalid or expired. Ask the office for a new link.');

async function verifiedAccount(connection, memberId) {
  const { rows: [account] } = await connection.query(`
    SELECT a.id, a.phone, a.identity_key, a.token_version, a.password_hash,
           m.phone AS member_phone, m.aadhar_no, m.site_id, s.organization_id
      FROM booking_client_members cm
      JOIN booking_client_accounts a ON a.id=cm.account_id
      JOIN members m ON m.id=cm.member_id
      JOIN sites s ON s.id=m.site_id
      JOIN LATERAL (
        SELECT k.id FROM kyc_cases k
         WHERE k.client_member_id=m.id AND k.site_id=m.site_id AND k.status='VERIFIED'
         ORDER BY k.id DESC LIMIT 1 FOR SHARE
      ) kyc ON true
     WHERE cm.member_id=$1 AND a.is_active
       AND COALESCE(to_jsonb(m)->>'is_active','true') <> 'false'
       AND 'CLIENT' = ANY(COALESCE(m.member_types, ARRAY[m.member_type]))
     FOR UPDATE OF a, m FOR SHARE OF cm`, [memberId]);
  if (!account) return null;
  const identity = cleanIdentity(account.aadhar_no);
  if (normalizeStaffPhone(account.member_phone) !== account.phone
    || !/^[2-9]\d{11}$/.test(identity) || clientIdentityKey(identity) !== account.identity_key) return null;
  return account;
}

export function createMobileAccountRecovery(db, { now = () => new Date() } = {}) {
  async function transaction(action) {
    const connection = await db.connect();
    try {
      await connection.query('BEGIN');
      const result = await action(connection);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }

  return {
    async issue({ memberId, identityVerified, actor }) {
      if (!Number.isSafeInteger(memberId) || memberId < 1 || identityVerified !== true) {
        fail(400, 'Verify the client in person and select their record.');
      }
      if (actor?.role !== 'super_admin' || !Number.isSafeInteger(actor.id) || !Number.isSafeInteger(actor.version)) {
        fail(403, 'Only a super administrator can issue a password reset link.');
      }
      return transaction(async connection => {
        const { rows: [staff] } = await connection.query(`
          SELECT role, is_active, token_version, can_login_accounts, can_login_booking, organization_id
            FROM users WHERE id=$1 FOR SHARE`, [actor.id]);
        const hasAccess = actor.app === 'accounts' ? staff?.can_login_accounts === true : staff?.can_login_booking !== false;
        if (!staff?.is_active || staff.role !== 'super_admin' || staff.token_version !== actor.version || !hasAccess) {
          fail(403, 'Your staff access changed. Please sign in again.');
        }
        const account = await verifiedAccount(connection, memberId);
        if (!account || (staff.organization_id != null && staff.organization_id !== account.organization_id)) {
          fail(404, 'No active app account is linked to this verified client record.');
        }
        const code = randomBytes(32).toString('base64url');
        const expiresAt = new Date(now().getTime() + lifetimeMs);
        await connection.query(`
          INSERT INTO booking_client_password_resets(account_id, member_id, code_hash, token_version, expires_at)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (account_id) DO UPDATE SET member_id=EXCLUDED.member_id, code_hash=EXCLUDED.code_hash,
            token_version=EXCLUDED.token_version, expires_at=EXCLUDED.expires_at, consumed_at=NULL`,
        [account.id, memberId, codeHash(code), account.token_version, expiresAt]);
        await connection.query(`
          INSERT INTO audit_logs(organization_id,site_id,user_id,action,event_type,module,entity_type,entity_id,
            request_method,request_path,status_code,outcome,description)
          VALUES($1,$2,$3,'CREATE','HTTP','my_real_assets','client_account',$4,'POST',
            '/api/mobile/admin/password-resets',200,'SUCCESS','Office issued a My Real Assets password reset link after identity verification.')`,
        [account.organization_id, account.site_id, actor.id, String(account.id)]);
        return { code, expiresAt: expiresAt.toISOString() };
      });
    },

    async confirm({ mobile, code, newPassword } = {}) {
      const phone = normalizeStaffPhone(mobile);
      if (!phone || typeof code !== 'string' || !codePattern.test(code)) invalidLink();
      if (typeof newPassword !== 'string' || newPassword.length < 12 || Buffer.byteLength(newPassword, 'utf8') > 72) {
        fail(400, 'Choose a password of at least 12 characters and at most 72 bytes.');
      }
      const digest = codeHash(code);
      return transaction(async connection => {
        await lockClientPasswordPhone(connection, phone);
        const { rows: [reset] } = await connection.query(`
          SELECT r.account_id, r.member_id, r.token_version
            FROM booking_client_password_resets r
            JOIN booking_client_accounts a ON a.id=r.account_id
           WHERE r.code_hash=$1 AND r.consumed_at IS NULL AND r.expires_at>$2 AND a.phone=$3`,
        [digest, now(), phone]);
        if (!reset) invalidLink();
        const account = await verifiedAccount(connection, reset.member_id);
        if (!account || account.id !== reset.account_id || account.phone !== phone
          || account.token_version !== reset.token_version) invalidLink();
        if (cleanIdentity(newPassword) === cleanIdentity(account.aadhar_no) || newPassword === code
          || await bcrypt.compare(newPassword, account.password_hash)
          || await passwordUsedByAnotherAccount(connection, phone, newPassword, account.id)) {
          fail(400, 'Choose a different password.');
        }
        const hash = await bcrypt.hash(newPassword, 12);
        const consumedAt = now();
        const { rowCount } = await connection.query(`
          UPDATE booking_client_password_resets SET consumed_at=$2
           WHERE account_id=$1 AND code_hash=$3 AND consumed_at IS NULL AND expires_at>$2`,
        [account.id, consumedAt, digest]);
        if (rowCount !== 1) invalidLink();
        await connection.query(`
          UPDATE booking_client_accounts SET password_hash=$2, password_changed=true,
            token_version=token_version+1, updated_at=now() WHERE id=$1`, [account.id, hash]);
        return { ok: true };
      });
    },
  };
}
