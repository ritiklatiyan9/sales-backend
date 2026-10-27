import { createHmac, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { STAFF_AUTH_SELECT, PHONE_LOOKUP_SQL, matchesStaffPassword, normalizeLoginIdentifier } from './staffIdentity.service.js';
import { createMobileFinancialReader, projectMobilePlot, MOBILE_SESSION_DAYS, normalizeMobile } from './mobilePortal.service.js';

const ISSUER = 'my-real-assets-broker-bookings';
const AUDIENCE = 'my-real-assets-broker';
const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
const unauthorized = () => fail(401, 'Please sign in again.');
const invalidLogin = () => fail(401, 'Broker sign-in details did not match.');
const amount = value => Math.round((Number(value) || 0) * 100) / 100;
const privateKey = purpose => {
  const root = process.env.MOBILE_PORTAL_SECRET || process.env.JWT_ACCESS_SECRET;
  if (!root || root.length < 32) fail(503, 'Sign-in is temporarily unavailable.');
  return createHmac('sha256', root).update(`bookings/my-real-assets-broker/v1/${purpose}`).digest();
};
const fingerprint = (user, anchorIdentity = '') => createHmac('sha256', privateKey('identity')).update(JSON.stringify([
  user.id, user.password, user.token_version, user.phone, user.email,
  user.booking_aadhaar_password_hash, user.booking_aadhaar_password_fingerprint,
  user.booking_kyc_member_id, user.booking_kyc_case_id, anchorIdentity,
])).digest('hex');
const equalFingerprint = (a, b) => typeof a === 'string' && typeof b === 'string'
  && /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b)
  && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
const safeUser = user => ({ id: `broker:${user.id}`, name: user.name || 'Partner', role: 'broker' });
const active = alias => `(COALESCE(to_jsonb(${alias})->>'is_active','true') <> 'false'
  AND upper(trim(COALESCE(to_jsonb(${alias})->>'status','ACTIVE'))) NOT IN ('INACTIVE','BLOCKED','DISABLED','DEACTIVATED','DELETED','SUSPENDED'))`;
const brokerRole = alias => `'BROKER'=ANY(COALESCE(${alias}.member_types,ARRAY[${alias}.member_type]))`;
const clientRole = alias => `'CLIENT'=ANY(COALESCE(${alias}.member_types,ARRAY[${alias}.member_type]))`;
const normalizedAadhaar = value => typeof value === 'string' ? value.replace(/[\s-]/g, '') : '';
const indiaToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

// Staff-created records, name matches, team hierarchy, commission rows and a
// client's first referral must never grant access to another broker's plot.
// A member override has priority over the booking's user attribution. Even an
// invalid/moved override fails closed rather than falling back to agent_user_id.
const scopedPlotsSql = `WITH allowed_sites AS (
    SELECT s.id FROM sites s JOIN user_sites us ON us.site_id=s.id AND us.user_id=$1
    WHERE ($3::integer IS NULL OR s.organization_id=$3)
  )
  SELECT p.id,p.site_id,p.plot_no,p.plot_size,p.sale_price,p.booking_date,p.status,
    m.id AS client_id,
    COALESCE((to_jsonb(p)->>'full_payment_due')::boolean,false) AS full_payment_due,
    to_jsonb(p)->>'full_payment_due_date' AS full_payment_due_date,
    COALESCE(to_jsonb(p)->>'unit_type','plot') AS unit_type,
    COALESCE((to_jsonb(p)->>'interest_enabled')::boolean,false) AS interest_enabled,
    COALESCE((to_jsonb(p)->>'interest_rate')::numeric,0) AS interest_rate,
    COALESCE(to_jsonb(p)->>'interest_type','per_month') AS interest_type
  FROM plots p JOIN allowed_sites a ON a.id=p.site_id
  JOIN LATERAL (SELECT b.id,b.client_member_id,b.booking_agent_id,b.agent_user_id,b.status
    FROM bookings b WHERE b.site_id=p.site_id AND b.plot_id=p.id ORDER BY b.id DESC LIMIT 1) b ON true
  JOIN members m ON m.id=COALESCE(p.buyer_member_id,b.client_member_id) AND m.site_id=p.site_id
  WHERE b.client_member_id=m.id AND ${clientRole('m')} AND ${active('m')}
    AND lower(trim(COALESCE(b.status,''))) NOT LIKE 'cancel%'
    AND lower(trim(COALESCE(b.status,''))) NOT IN ('deleted','void','voided','withdrawn')
    AND upper(trim(COALESCE(p.status,''))) NOT IN ('AVAILABLE','COMPANY')
    AND CASE WHEN b.booking_agent_id IS NOT NULL THEN EXISTS (
      SELECT 1 FROM members bm WHERE bm.id=b.booking_agent_id AND bm.site_id=p.site_id AND bm.id=ANY($2::integer[])
      AND ${brokerRole('bm')} AND ${active('bm')}) ELSE b.agent_user_id=$1 END`;

const clientColumns = `m.id,m.full_name,m.phone,m.email,m.address,m.city,m.state,m.pincode`;
const safeClient = row => ({
  id: String(row.id), name: row.full_name || 'Client', phone: row.phone || '', email: row.email || '',
  address: row.address || '', city: row.city || '', state: row.state || '', pincode: row.pincode || '', plots: [],
});
// These are freeform accounting labels, not typed identity fields. Prevent an
// accidentally pasted government identifier from becoming broker-visible text.
const redactIdentityText = value => String(value || '')
  .replace(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/gi, '[private ID]')
  .replace(/(?<![0-9])(?:[0-9][ -]?){11}[0-9](?![0-9])/g, '[private ID]');
const safePlot = plot => ({
  ...plot,
  installments: plot.installments.map(item => ({ ...item, title: redactIdentityText(item.title) })),
  payments: plot.payments.map(item => ({ ...item, reference: redactIdentityText(item.reference), mode: redactIdentityText(item.mode) })),
});

export function createBrokerMobileService(db, options = {}) {
  const { now = Date.now } = options;
  // Financial calculations, posting policy, batch queries and bounded caching
  // are shared with the client app; this instance has its own cache boundary.
  const financialsFor = createMobileFinancialReader(db, options);
  function assertBroker(user) {
    if (!user || user.role !== 'agent' || user.is_active !== true || user.can_login_booking === false
      || (user.agent_status != null && user.agent_status !== 'ACTIVE')) unauthorized();
  }
  async function brokerIdentityFor(user) {
    if (user.booking_kyc_member_id == null) return { ids: [], anchorIdentity: '' };
    // An enrolled link must remain a verified, active broker at its actual site.
    const anchor = (await db.query(`SELECT m.id,m.site_id,m.phone,m.aadhar_no
      FROM members m JOIN kyc_cases k ON k.id=$2 AND k.client_member_id=m.id AND k.site_id=m.site_id AND k.status='VERIFIED'
      JOIN sites s ON s.id=m.site_id
      WHERE m.id=$1 AND ${active('m')} AND ${brokerRole('m')}
      AND ($3::integer IS NULL OR s.organization_id=$3)`,
    [user.booking_kyc_member_id, user.booking_kyc_case_id, user.organization_id ?? null])).rows[0];
    if (!anchor) unauthorized();
    const mobile = normalizeMobile(anchor.phone);
    const aadhaar = normalizedAadhaar(anchor.aadhar_no);
    const anchorIdentity = `${mobile}:${aadhaar}`;
    // Cross-site registrations require the full exact person identity. Shared
    // phone numbers, names and canonical BRK codes are not access authorities.
    if (!mobile || !/^[2-9]\d{11}$/.test(aadhaar)) return { ids: [anchor.id], anchorIdentity };
    const { rows } = await db.query(`SELECT m.id,m.phone,m.aadhar_no FROM members m
      JOIN sites s ON s.id=m.site_id JOIN user_sites us ON us.site_id=s.id AND us.user_id=$1
      WHERE ${brokerRole('m')} AND ${active('m')} AND ($3::integer IS NULL OR s.organization_id=$3)
      AND right(regexp_replace(COALESCE(m.phone,''),'[^0-9]','','g'),10)=$2 ORDER BY m.id LIMIT 1001`,
    [user.id, mobile, user.organization_id ?? null]);
    if (rows.length > 1000) unauthorized();
    return { ids: rows.filter(row => normalizeMobile(row.phone) === mobile && normalizedAadhaar(row.aadhar_no) === aadhaar).map(row => row.id), anchorIdentity };
  }
  async function makeSession(user, method = 'email') {
    assertBroker(user);
    if (method === 'phone' && user.booking_linked_broker !== true) unauthorized();
    const identity = await brokerIdentityFor(user);
    return { sourceUser: user, brokerMemberIds: identity.ids, user: safeUser(user), identity: fingerprint(user, identity.anchorIdentity) };
  }
  async function getSession(token) {
    let claims;
    try { claims = jwt.verify(token, privateKey('access'), { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE }); }
    catch { unauthorized(); }
    if (claims.realm !== 'mobile-broker' || !/^mra-broker:[1-9]\d*$/.test(claims.sub || '') || !['phone','email'].includes(claims.method)) unauthorized();
    const user = (await db.query(`${STAFF_AUTH_SELECT} WHERE u.id=$1`, [Number(claims.sub.split(':')[1])])).rows[0];
    assertBroker(user);
    const session = await makeSession(user, claims.method);
    if (!equalFingerprint(claims.identity, session.identity)) unauthorized();
    return session;
  }
  const parameters = session => [session.sourceUser.id, session.brokerMemberIds, session.sourceUser.organization_id ?? null];
  async function scopedPlots(session, id) {
    const args = parameters(session);
    if (id !== undefined) {
      if (!/^[1-9]\d*$/.test(String(id)) || !Number.isSafeInteger(Number(id)) || Number(id)>2147483647) fail(404, 'Property unavailable.');
      args.push(Number(id));
    }
    const { rows } = await db.query(`${scopedPlotsSql} ${id !== undefined ? 'AND p.id=$4' : ''} ORDER BY p.site_id,p.plot_no,p.id LIMIT 1001`, args);
    if (rows.length > 1000) fail(503, 'Your portfolio is temporarily unavailable.');
    if (id !== undefined && !rows.length) fail(404, 'Property unavailable.');
    return rows;
  }
  return {
    getSession,
    async login(body) {
      if (!body || typeof body !== 'object' || Array.isArray(body) || (body.role !== undefined && body.role !== 'broker')) invalidLogin();
      const identifier = body.identifier ?? body.mobile;
      const password = body.password ?? body.aadhaar;
      const parsed = normalizeLoginIdentifier(identifier);
      if (!parsed || typeof password !== 'string' || !password || password.length > 256) invalidLogin();
      const query = parsed.type === 'phone'
        ? `${STAFF_AUTH_SELECT} WHERE ${PHONE_LOOKUP_SQL.replace(/\bphone\b/g,'u.phone')}=$1 LIMIT 2`
        : `${STAFF_AUTH_SELECT} WHERE lower(btrim(u.email))=$1 LIMIT 2`;
      const candidates = (await db.query(query, [parsed.value])).rows;
      if (candidates.length !== 1) invalidLogin();
      const user = candidates[0];
      if (user.role !== 'agent' || !await matchesStaffPassword(user, password, { phoneLogin: parsed.type === 'phone' })) invalidLogin();
      const session = await makeSession(user, parsed.type);
      const token = jwt.sign({ realm: 'mobile-broker', identity: session.identity, method: parsed.type }, privateKey('access'), {
        algorithm: 'HS256', issuer: ISSUER, audience: AUDIENCE, subject: `mra-broker:${user.id}`, expiresIn: `${MOBILE_SESSION_DAYS}d`,
      });
      return { token, user: session.user, expiresAt: new Date(jwt.decode(token).exp*1000).toISOString(), sessionDurationDays: MOBILE_SESSION_DAYS };
    },
    async portfolio(session, { forceFresh = false } = {}) {
      const plots = await scopedPlots(session);
      const args = parameters(session);
      args.push(plots.map(row => row.client_id));
      // Referral precedence is explicit member first, then user only when the
      // member referral is absent. Referrals expose contact, never other plots.
      const { rows } = await db.query(`SELECT ${clientColumns} FROM members m JOIN sites s ON s.id=m.site_id
        JOIN user_sites us ON us.site_id=s.id AND us.user_id=$1
        WHERE ($3::integer IS NULL OR s.organization_id=$3) AND ${clientRole('m')} AND ${active('m')}
        AND (m.id=ANY($4::integer[]) OR CASE WHEN m.referred_by_member_id IS NOT NULL THEN EXISTS (
          SELECT 1 FROM members bm WHERE bm.id=m.referred_by_member_id AND bm.site_id=m.site_id AND bm.id=ANY($2::integer[])
          AND ${brokerRole('bm')} AND ${active('bm')}) ELSE m.referred_by_user_id=$1 END)
        ORDER BY lower(m.full_name),m.id LIMIT 1001`, args);
      if (rows.length > 1000) fail(503, 'Your portfolio is temporarily unavailable.');
      const clients = rows.map(safeClient);
      const byClient = new Map(clients.map(client => [client.id, client]));
      const financials = await financialsFor(plots.map(row => row.id), { forceFresh });
      const today = indiaToday();
      const projected = [];
      for (const plot of plots) {
        const client = byClient.get(String(plot.client_id));
        if (!client) continue;
        const data = financials.get(plot.id);
        const { payments, ...detail } = safePlot(projectMobilePlot(plot, data.schedules, data.receipts, today));
        client.plots.push(detail); projected.push(detail);
      }
      return { broker: session.user, clients, summary: {
        clientCount: clients.length, plotCount: projected.length,
        totalAmount: amount(projected.reduce((s,p) => s+p.totalAmount,0)), paidAmount: amount(projected.reduce((s,p) => s+p.paidAmount,0)),
        balanceAmount: amount(projected.reduce((s,p) => s+p.balanceAmount,0)), interestAmount: amount(projected.reduce((s,p) => s+p.interestAmount,0)),
        totalDueAmount: amount(projected.reduce((s,p) => s+p.totalDueAmount,0)),
        upcomingCount: projected.reduce((s,p) => s+p.installments.filter(i=>i.balanceAmount>0).length,0),
        overdueCount: projected.reduce((s,p) => s+p.installments.filter(i=>i.balanceAmount>0 && i.dueDate && i.dueDate<today).length,0),
      }, updatedAt: [...financials.values()].map(row=>row.updatedAt).sort()[0] || new Date(now()).toISOString() };
    },
    async plot(session, id, { forceFresh = false } = {}) {
      const [plot] = await scopedPlots(session, id);
      const data = (await financialsFor([plot.id], { forceFresh })).get(plot.id);
      return { plot: safePlot(projectMobilePlot(plot, data.schedules, data.receipts, indiaToday())), updatedAt: data.updatedAt };
    },
  };
}
