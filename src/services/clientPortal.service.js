import { createHmac } from 'node:crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { normalizeStaffPhone } from './staffIdentity.service.js';
import { memberPhoneSql } from './clientRegistry.service.js';

const ISSUER = 'booking-client-portal';
const AUDIENCE = 'booking-client-portal';
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const invalid = () => fail(401, 'Invalid credentials');
const expired = () => fail(401, 'Session expired. Please login again.');
const cleanAadhaar = value => typeof value === 'string' ? value.replace(/[\s-]/g, '') : '';
const validAadhaar = value => /^[2-9]\d{11}$/.test(value);

/** Domain-separated keys ensure neither Accounting nor Booking staff accept these JWTs. */
function privateKey(purpose) {
  const root = process.env.CLIENT_PORTAL_SECRET || process.env.JWT_REFRESH_SECRET;
  if (!root) throw new Error('Client portal signing secret is unavailable');
  return createHmac('sha256', root).update(`booking/client-portal/v1/${purpose}`).digest('hex');
}
export const clientIdentityKey = aadhaar => createHmac('sha256', process.env.CLIENT_PORTAL_IDENTITY_SECRET || privateKey('identity')).update(aadhaar).digest('hex');
export function issueClientTokens(account) {
  const claims = { realm: 'client', version: account.token_version };
  const options = { algorithm: 'HS256', issuer: ISSUER, audience: AUDIENCE, subject: `booking-client:${account.id}` };
  return {
    accessToken: jwt.sign({ ...claims, token_type: 'access' }, privateKey('access'), { ...options, expiresIn: '24h' }),
    refreshToken: jwt.sign({ ...claims, token_type: 'refresh' }, privateKey('refresh'), { ...options, expiresIn: '24h' }),
  };
}
export function verifyClientToken(token, type = 'access') {
  try {
    const decoded = jwt.verify(token, privateKey(type), { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE });
    if (decoded.realm !== 'client' || decoded.token_type !== type || !/^booking-client:[1-9]\d*$/.test(decoded.sub || '')
      || !Number.isSafeInteger(decoded.version)) expired();
    return { accountId: Number(decoded.sub.split(':')[1]), version: decoded.version };
  } catch { expired(); }
}

const sourceSelect = `SELECT m.id AS member_id,m.site_id,m.full_name,m.phone,m.email,m.aadhar_no,m.pan_no,
  COALESCE(to_jsonb(m)->>'is_active','true') <> 'false' AS member_active,
  k.id AS kyc_case_id,k.status AS kyc_status,s.name AS site_name,s.code AS site_code
  FROM members m JOIN sites s ON s.id=m.site_id
  JOIN LATERAL (SELECT id,status FROM kyc_cases k WHERE k.client_member_id=m.id AND k.site_id=m.site_id
    AND k.status='VERIFIED' ORDER BY k.id DESC LIMIT 1) k ON true`;
const clientRole = `'CLIENT' = ANY(COALESCE(m.member_types,ARRAY[m.member_type]))`;
const maskAadhaar = value => value ? `XXXX XXXX ${cleanAadhaar(value).slice(-4)}` : null;
const maskPan = value => value ? `${String(value).slice(0,2)}******${String(value).slice(-2)}` : null;
const pageNumber = (value, fallback, max) => {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) fail(400, 'Invalid pagination');
  return number;
};

export function clientPortalSession({ account, members }) {
  const member = members[0];
  const sites = [...new Map(members.map(item => [item.site_id, { id: item.site_id, name: item.site_name, code: item.site_code }])).values()];
  return { realm: 'client', user: {
    id: `client:${account.id}`, role: 'client', name: member.full_name, phone: account.phone,
    email: member.email || null, aadhaar_masked: `XXXX XXXX ${account.aadhaar_last4}`,
    pan_masked: maskPan(member.pan_no), kyc_case_id: member.kyc_case_id,
    phone_aadhaar_enabled: !account.password_changed,
  }, sites };
}

/** Every portal request derives ownership from private account links and live KYC. */
export function createClientPortalService(db) {
  async function ownedMembers(account, connection = db) {
    const result = await connection.query(`${sourceSelect}
      JOIN booking_client_members cm ON cm.member_id=m.id AND cm.account_id=$1
      WHERE ${clientRole} ORDER BY m.id LIMIT 1001`, [account.id]);
    if (result.rows.length > 1000) expired();
    return result.rows.filter(member => normalizeStaffPhone(member.phone || '') === account.phone
      && validAadhaar(cleanAadhaar(member.aadhar_no)) && clientIdentityKey(cleanAadhaar(member.aadhar_no)) === account.identity_key);
  }
  async function getSession(claims, connection = db) {
    const { rows } = await connection.query('SELECT * FROM booking_client_accounts WHERE id=$1', [claims.accountId]);
    const account = rows[0];
    if (!account?.is_active || account.token_version !== claims.version) expired();
    const members = await ownedMembers(account, connection);
    if (!members.length) expired();
    return { account, members };
  }
  async function authenticate(identifier, password, { dryRun = false } = {}) {
    const phone = normalizeStaffPhone(identifier);
    if (!phone || typeof password !== 'string' || !password || Buffer.byteLength(password, 'utf8') > 256) return null;
    let accounts;
    try { accounts = (await db.query('SELECT * FROM booking_client_accounts WHERE phone=$1 ORDER BY id LIMIT 21', [phone])).rows; }
    catch (error) {
      // Existing staff deployments continue signing in before the additive migration.
      if (error.code === '42P01' && /booking_client_accounts/.test(error.message)) return null;
      throw error;
    }
    if (accounts.length > 20) return null;
    const matches = [];
    const aadhaar = cleanAadhaar(password);
    for (const account of accounts) {
      if (!account.is_active) continue;
      if ((!account.password_changed || Buffer.byteLength(password,'utf8') <= 72)
        && await bcrypt.compare(account.password_changed ? password : aadhaar, account.password_hash)) {
        const members = await ownedMembers(account);
        if (members.length) matches.push({ account, members });
      }
    }
    if (matches.length > 1) return null;
    if (matches.length === 1) return dryRun ? matches[0] : { ...clientPortalSession(matches[0]), ...issueClientTokens(matches[0].account) };
    if (!validAadhaar(aadhaar)) return null;
    const identityKey = clientIdentityKey(aadhaar);
    // A new KYC edit or an old Aadhaar must never reset a chosen password/deactivated account.
    if (accounts.some(account => account.identity_key === identityKey)) return null;
    const candidates = await db.query(`${sourceSelect} WHERE ${memberPhoneSql()}=$1 AND ${clientRole} ORDER BY m.id LIMIT 1001`, [phone]);
    if (candidates.rows.length > 1000) return null;
    const members = candidates.rows.filter(member => cleanAadhaar(member.aadhar_no) === aadhaar);
    if (!members.length) return null;
    if (dryRun) return { members };
    const connection = await db.connect();
    try {
      await connection.query('BEGIN');
      await connection.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`booking-client:${phone}:${identityKey}`]);
      const duplicate = await connection.query('SELECT id FROM booking_client_accounts WHERE phone=$1 AND identity_key=$2', [phone, identityKey]);
      if (duplicate.rows.length) { await connection.query('ROLLBACK'); return authenticate(identifier, password); }
      // Recheck the exact identity under row locks before creating its private credential.
      const confirmed = await connection.query(`SELECT m.id FROM members m WHERE m.id=ANY($1::integer[])
        AND ${memberPhoneSql()}=$2 AND regexp_replace(COALESCE(m.aadhar_no,''),'[[:space:]-]','','g')=$3
        AND ${clientRole} AND EXISTS (SELECT 1 FROM kyc_cases k WHERE k.client_member_id=m.id AND k.site_id=m.site_id AND k.status='VERIFIED')
        ORDER BY m.id FOR SHARE OF m`, [members.map(member => member.member_id), phone, aadhaar]);
      if (!confirmed.rows.length) { await connection.query('ROLLBACK'); return null; }
      // A later KYC correction cannot reassign someone else's existing credential.
      const claimed = await connection.query('SELECT member_id FROM booking_client_members WHERE member_id=ANY($1::integer[]) LIMIT 1', [confirmed.rows.map(member => member.id)]);
      if (claimed.rows.length) { await connection.query('ROLLBACK'); return null; }
      const inserted = await connection.query(`INSERT INTO booking_client_accounts(phone,identity_key,password_hash,aadhaar_last4)
        VALUES ($1,$2,$3,$4) RETURNING *`, [phone, identityKey, await bcrypt.hash(aadhaar, 12), aadhaar.slice(-4)]);
      const account = inserted.rows[0];
      for (const member of confirmed.rows) await connection.query('INSERT INTO booking_client_members(account_id,member_id) VALUES ($1,$2)', [account.id, member.id]);
      const fresh = { account, members: await ownedMembers(account, connection) };
      if (!fresh.members.length) invalid();
      await connection.query('COMMIT');
      return { ...clientPortalSession(fresh), ...issueClientTokens(account) };
    } catch (error) {
      await connection.query('ROLLBACK');
      if (error.code === '23505') return null;
      throw error;
    }
    finally { connection.release(); }
  }

  return {
    authenticate, getSession,
    async refresh(token) {
      const session = await getSession(verifyClientToken(token, 'refresh'));
      return { ...clientPortalSession(session), ...issueClientTokens(session.account) };
    },
    async updateProfile(session, body) {
      if (!body || Object.keys(body).some(key => !['current_password','new_password'].includes(key))) fail(400, 'Only your password can be changed here. Contact the office to correct verified KYC details.');
      const { current_password: current, new_password: next } = body;
      if (typeof current !== 'string' || Buffer.byteLength(current,'utf8') > 256) fail(400, 'Enter your current password');
      if (typeof next !== 'string' || next.length < 8 || Buffer.byteLength(next,'utf8') > 72) fail(400, 'New password must have at least 8 characters and at most 72 UTF-8 bytes');
      const account = session.account;
      if (!(await bcrypt.compare(account.password_changed ? current : cleanAadhaar(current), account.password_hash))) fail(403, 'Your current password is incorrect');
      const result = await db.query(`UPDATE booking_client_accounts SET password_hash=$1,password_changed=true,
        token_version=token_version+1,updated_at=now() WHERE id=$2 AND token_version=$3 AND is_active=true RETURNING *`,
      [await bcrypt.hash(next,12), account.id, account.token_version]);
      if (!result.rows.length) expired();
      return { ...clientPortalSession({ ...session, account: result.rows[0] }), ...issueClientTokens(result.rows[0]), session_changed: true };
    },
    async logout(session) {
      await db.query('UPDATE booking_client_accounts SET token_version=token_version+1,updated_at=now() WHERE id=$1 AND token_version=$2', [session.account.id, session.account.token_version]);
    },
    async records(session, query = {}) {
      const page = pageNumber(query.page, 1, 100000);
      const limit = pageNumber(query.limit, 20, 50);
      let members = session.members;
      if (query.site_id !== undefined && query.site_id !== '') {
        const siteId = Number(query.site_id);
        if (!Number.isSafeInteger(siteId) || !members.some(member => member.site_id === siteId)) fail(403, 'Site is unavailable');
        members = members.filter(member => member.site_id === siteId);
      }
      const ids = members.map(member => member.member_id);
      // Row ownership always includes a live member/site join. Plot IDs alone never establish payment ownership.
      const ownBookings = `SELECT b.* FROM bookings b JOIN members m ON m.id=b.client_member_id AND m.site_id=b.site_id WHERE b.client_member_id=ANY($1::integer[])`;
      const ownDraws = `SELECT r.* FROM draw_registrations r JOIN members m ON m.id=r.client_member_id AND m.site_id=r.site_id WHERE r.client_member_id=ANY($1::integer[])`;
      const payments = `WITH own_bookings AS (${ownBookings}),own_draws AS (${ownDraws}),own_payments AS (
        SELECT 'draw:'||dp.id AS id,dp.amount,dp.payment_date AS paid_at,dp.receipt_no AS reference,
          dp.payment_from AS method,COALESCE(pp.status,'recorded') AS status,r.site_id,s.name AS site_name,
          COALESCE(pp.cheque_status,'') AS cheque_status
          FROM draw_payments dp JOIN own_draws r ON r.id=dp.draw_registration_id JOIN sites s ON s.id=r.site_id
          LEFT JOIN plot_payments pp ON pp.id=dp.plot_payment_id AND pp.site_id=r.site_id
        UNION ALL
        SELECT 'booking:'||pp.id,pp.amount,pp.date,COALESCE(b.booking_no,'BOOKING-'||b.id),
          COALESCE(pp.payment_from,pp.payment_type),pp.status,b.site_id,s.name,COALESCE(pp.cheque_status,'')
          FROM plot_payments pp JOIN own_bookings b ON b.token_payment_id=pp.id AND b.site_id=pp.site_id AND b.plot_id=pp.plot_id
          JOIN sites s ON s.id=b.site_id WHERE NOT EXISTS (SELECT 1 FROM draw_payments dp JOIN own_draws r ON r.id=dp.draw_registration_id WHERE dp.plot_payment_id=pp.id)
      )`;
      const parameters = [ids, limit, (page - 1) * limit];
      const [bookingRows, drawRows, paymentRows, kycRows, summaryRows] = await Promise.all([
        db.query(`WITH own_bookings AS (${ownBookings}) SELECT b.id,b.booking_no AS booking_number,b.booking_date,b.status,b.kyc_status,
          p.plot_no AS plot_number,p.block AS plot_block,b.site_id,s.name AS site_name,b.sale_price AS total_amount,
          COALESCE((SELECT SUM(pp.amount) FROM plot_payments pp WHERE pp.id=b.token_payment_id AND pp.site_id=b.site_id
            AND lower(COALESCE(pp.status,'')) NOT IN ('rejected','cancelled') AND upper(COALESCE(pp.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')),0)
          + COALESCE((SELECT SUM(dp.amount) FROM draw_payments dp JOIN draw_registrations r ON r.id=dp.draw_registration_id
            LEFT JOIN plot_payments pp ON pp.id=dp.plot_payment_id AND pp.site_id=r.site_id
            WHERE r.booking_id=b.id AND r.client_member_id=b.client_member_id AND r.site_id=b.site_id
            AND (dp.plot_payment_id IS NULL OR dp.plot_payment_id IS DISTINCT FROM b.token_payment_id)
            AND lower(COALESCE(pp.status,'')) NOT IN ('rejected','cancelled') AND upper(COALESCE(pp.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')),0) AS paid_amount,
          count(*) OVER()::int AS _total FROM own_bookings b LEFT JOIN plots p ON p.id=b.plot_id AND p.site_id=b.site_id
          JOIN sites s ON s.id=b.site_id ORDER BY b.id DESC LIMIT $2 OFFSET $3`, parameters),
        db.query(`WITH own_draws AS (${ownDraws}) SELECT r.id,r.registration_no AS registration_number,r.scheme_name AS draw_code,
          r.draw_opening_date AS draw_date,r.status,r.is_winner,r.required_amount,r.site_id,s.name AS site_name,r.booking_id,
          COALESCE((SELECT SUM(dp.amount) FROM draw_payments dp WHERE dp.draw_registration_id=r.id),0) AS amount_paid,
          count(*) OVER()::int AS _total FROM own_draws r JOIN sites s ON s.id=r.site_id ORDER BY r.id DESC LIMIT $2 OFFSET $3`, parameters),
        db.query(`${payments} SELECT id,amount,paid_at,reference,method,status,site_id,site_name,count(*) OVER()::int AS _total
          FROM own_payments ORDER BY paid_at DESC,id DESC LIMIT $2 OFFSET $3`, parameters),
        db.query(`SELECT k.id,k.client_member_id AS member_id,k.status,k.site_id,s.name AS site_name,
          count(*) OVER()::int AS _total FROM kyc_cases k JOIN members m ON m.id=k.client_member_id AND m.site_id=k.site_id
          JOIN sites s ON s.id=k.site_id WHERE k.client_member_id=ANY($1::integer[]) ORDER BY k.id DESC LIMIT $2 OFFSET $3`, parameters),
        db.query(`${payments} SELECT (SELECT count(*)::int FROM own_bookings) AS bookings,(SELECT count(*)::int FROM own_draws) AS draws,
          count(*)::int AS payments,(SELECT count(*)::int FROM kyc_cases k JOIN members m ON m.id=k.client_member_id AND m.site_id=k.site_id WHERE k.client_member_id=ANY($1::integer[])) AS kyc,
          COALESCE(SUM(amount) FILTER(WHERE lower(COALESCE(status,'')) NOT IN ('rejected','cancelled') AND upper(cheque_status) NOT IN ('BOUNCED','RETURNED')),0) AS total_paid
          FROM own_payments`, [ids]),
      ]);
      const caseIds = kycRows.rows.map(item => item.id);
      const docs = caseIds.length ? (await db.query(`SELECT d.id,d.type,d.mime_type,d.created_at,d.kyc_case_id FROM documents d
        JOIN kyc_cases k ON k.id=d.kyc_case_id AND (d.client_member_id IS NULL OR k.client_member_id=d.client_member_id)
          AND (d.site_id IS NULL OR k.site_id=d.site_id)
        WHERE d.kyc_case_id=ANY($1::integer[]) AND k.client_member_id=ANY($2::integer[]) ORDER BY d.id DESC LIMIT 500`, [caseIds,ids])).rows : [];
      const summary = summaryRows.rows[0];
      const pack = (result, total) => ({ items: result.rows.map(({ _total, ...item }) => item), total, page, limit });
      const kyc = pack(kycRows, summary.kyc);
      kyc.items = kyc.items.map(item => {
        const member = members.find(member => member.member_id === item.member_id);
        return { ...item, aadhaar_masked: maskAadhaar(member?.aadhar_no), pan_masked: maskPan(member?.pan_no),
          documents: docs.filter(doc => doc.kyc_case_id===item.id).map(({ kyc_case_id, ...doc }) => ({ ...doc, download_path: `/client-portal/documents/${doc.id}` })) };
      });
      return { summary: { bookings: summary.bookings, draws: summary.draws, total_paid: Number(summary.total_paid) },
        bookings: pack(bookingRows, summary.bookings), draws: pack(drawRows, summary.draws), payments: pack(paymentRows, summary.payments), kyc };
    },
    async document(session, documentId) {
      const id = Number(documentId);
      if (!Number.isSafeInteger(id) || id < 1) fail(404, 'Document not found');
      const result = await db.query(`SELECT d.id,d.type,d.mime_type,d.file_path FROM documents d
        JOIN kyc_cases k ON k.id=d.kyc_case_id AND (d.client_member_id IS NULL OR k.client_member_id=d.client_member_id)
          AND (d.site_id IS NULL OR k.site_id=d.site_id)
        JOIN members m ON m.id=k.client_member_id AND m.site_id=k.site_id
        WHERE d.id=$1 AND k.client_member_id=ANY($2::integer[])`, [id,session.members.map(member => member.member_id)]);
      if (!result.rows.length) fail(404, 'Document not found');
      return result.rows[0];
    },
  };
}
