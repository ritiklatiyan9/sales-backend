import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const ISSUER = 'my-real-partners-sample-reviewer';
const AUDIENCE = 'my-real-partners-sample-only';
const SUBJECT = 'sample-reviewer';
const REALM = 'broker-synthetic-reviewer-v1';
const RESERVED_PHONE = '9999900016';
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const USER = Object.freeze({ id: 'sample-reviewer', name: 'Sample data · Play reviewer', role: 'broker' });
const PROPERTY_IDS = [`pr_${'1'.repeat(32)}`, `pr_${'2'.repeat(32)}`];
const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
const unauthorized = () => fail(401, 'Please sign in again.');
const readonly = () => fail(403, 'This sample account is read-only. Contact support for reviewer access.');
const phone = value => typeof value === 'string' && value.length <= 32
  ? /^(?:0091|91|0)?([6-9]\d{9})$/.exec(value.replace(/[\s()+-]/g, ''))?.[1] || '' : '';

// Every value below is fictional. This module imports no database, mailer or
// push service and cannot resolve an identifier into a real customer record.
function samplePlot(index, today) {
  const paid = index === 1;
  const date = offset => new Date(Date.parse(`${today}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
  const installments = [
    { id: `sample-${index}-booking`, title: 'Booking amount', amount: 300000, paidAmount: 300000, balanceAmount: 0, status: 'paid', dueDate: date(-30) },
    { id: `sample-${index}-installment-1`, title: 'Installment 1', amount: 500000, paidAmount: paid ? 500000 : 300000, balanceAmount: paid ? 0 : 200000, status: paid ? 'paid' : 'partial', dueDate: date(-2) },
    { id: `sample-${index}-installment-2`, title: 'Installment 2', amount: 1000000, paidAmount: paid ? 1000000 : 0, balanceAmount: paid ? 0 : 1000000, status: paid ? 'paid' : 'upcoming', dueDate: date(3) },
  ];
  return {
    id: PROPERTY_IDS[index], number: paid ? 'SAMPLE-18' : 'SAMPLE-17', projectName: 'Your Property',
    collectionId: `col_${'a'.repeat(32)}`, collectionLabel: 'Collection AAAA-AAAA', propertyRef: `RA-AAAA-AAAA-${paid ? '0018' : '0017'}`,
    area: 120, areaUnit: 'sq yd', status: paid ? 'REGISTRY' : 'BOOKED', buyerName: paid ? 'Sample Client Two' : 'Sample Client One',
    totalAmount: 1800000, paidAmount: paid ? 1800000 : 600000, balanceAmount: paid ? 0 : 1200000,
    interestAmount: 0, totalDueAmount: paid ? 0 : 1200000, progress: paid ? 1 : 1 / 3,
    nextDueDate: paid ? null : date(-2), nextDueAmount: paid ? 0 : 200000, nextDueInterestAmount: 0,
    installmentRemindersEligible: false,
    paymentPlan: { name: 'Sample installment plan', installmentCount: 3, bookingDate: date(-30) }, installments,
    bookingProgress: {
      currentStage: paid ? 'registry_handover_pending' : 'booked',
      nextAction: paid ? 'await_registry_handover' : 'review_installments',
      milestones: [
        { code: 'booking', state: 'complete', date: date(-30) },
        ...(paid ? [
          { code: 'registry_started', state: 'complete', date: date(-7) },
          { code: 'registry_deed', state: 'complete', date: date(-3) },
          { code: 'registry_handover', state: 'pending', date: null },
        ] : []),
      ],
    },
    payments: installments.filter(row => row.paidAmount > 0).map((row, i) => ({
      id: `sample-payment-${index}-${i}`, date: row.dueDate, amount: row.paidAmount,
      mode: i === 0 ? 'cash' : 'bank transfer', reference: 'Sample payment', status: 'recorded',
    })),
  };
}

export function createBrokerReviewerAccess({ env = process.env, now = Date.now } = {}) {
  const active = new Map();
  const sessions = new WeakSet();
  let observedConfiguration;
  const config = () => {
    const fingerprint = createHash('sha256').update(JSON.stringify([
      env.BROKER_REVIEWER_ENABLED, env.BROKER_REVIEWER_PHONE, env.BROKER_REVIEWER_PASSWORD_HASH,
      env.BROKER_REVIEWER_SECRET, env.BROKER_REVIEWER_TOKEN_VERSION,
    ])).digest('hex');
    // Disabling or rotating access is irreversible for already issued sample
    // sessions, even if an operator later restores the previous settings.
    if (fingerprint !== observedConfiguration) {
      active.clear();
      observedConfiguration = fingerprint;
    }
    const value = {
      phone: phone(env.BROKER_REVIEWER_PHONE), hash: env.BROKER_REVIEWER_PASSWORD_HASH || '',
      secret: env.BROKER_REVIEWER_SECRET || '', version: Number(env.BROKER_REVIEWER_TOKEN_VERSION || '0'),
    };
    if (env.BROKER_REVIEWER_ENABLED !== 'true' || value.phone !== RESERVED_PHONE
      || !/^\$2[ab]\$(?:10|11|12|13|14)\$[./A-Za-z0-9]{53}$/.test(value.hash)
      || value.secret.length < 32 || !Number.isSafeInteger(value.version) || value.version < 0) return null;
    value.binding = fingerprint;
    return value;
  };
  const prune = () => {
    for (const [id, item] of active) if (item.until <= now()) active.delete(id);
  };
  const requireSession = session => {
    const current = config();
    prune();
    const entry = active.get(session?.jti);
    if (!sessions.has(session) || !current || !entry || entry.binding !== current.binding) unauthorized();
  };
  const data = () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now()));
    return PROPERTY_IDS.map((_id, index) => samplePlot(index, today));
  };
  return {
    // The fixed sample identifier stays reserved when access is disabled. Never
    // fall through to real broker lookup for wrong sample credentials.
    handlesLogin(body) {
      config();
      return phone(body?.mobile ?? body?.identifier) === RESERVED_PHONE;
    },
    handlesToken(token) {
      config();
      // Decoding is only a deny/dispatch hint; getSession verifies signature,
      // issuer, audience, expiry and the active allowlist before authorization.
      const value = jwt.decode(token);
      return Boolean(value && typeof value === 'object' &&
        (value.iss === ISSUER || value.aud === AUDIENCE || value.sub === SUBJECT || value.realm === REALM));
    },
    handlesReset(body) {
      return this.handlesLogin(body) || (typeof body?.challengeId === 'string' && body.challengeId.startsWith('sample-reviewer:'));
    },
    async login(body) {
      const current = config();
      if (!current || !this.handlesLogin(body) || (body.role !== undefined && body.role !== 'broker')
        || typeof body.password !== 'string' || body.password.length < 8 || Buffer.byteLength(body.password, 'utf8') > 72) unauthorized();
      const valid = await bcrypt.compare(body.password, current.hash);
      if (!valid || config()?.binding !== current.binding) unauthorized();
      prune();
      if (active.size >= 128) fail(429, 'Sample sign-in is temporarily busy. Please try again later.');
      const jti = randomBytes(24).toString('hex');
      const issuedAt = Math.floor(now() / 1000);
      const token = jwt.sign({ realm: REALM, version: current.version, iat: issuedAt }, current.secret, {
        algorithm: 'HS256', issuer: ISSUER, audience: AUDIENCE, subject: SUBJECT, jwtid: jti, expiresIn: SESSION_SECONDS,
      });
      const until = (issuedAt + SESSION_SECONDS) * 1000;
      active.set(jti, { until, binding: current.binding });
      return { token, user: { ...USER }, expiresAt: new Date(until).toISOString(), sessionDurationDays: 30 };
    },
    async getSession(token) {
      const current = config();
      if (!current) unauthorized();
      let claims;
      try {
        claims = jwt.verify(token, current.secret, { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE, subject: SUBJECT, clockTimestamp: Math.floor(now() / 1000) });
      } catch { unauthorized(); }
      prune();
      if (claims.realm !== REALM || claims.version !== current.version || typeof claims.jti !== 'string'
        || active.get(claims.jti)?.binding !== current.binding) unauthorized();
      const session = Object.freeze({ jti: claims.jti, user: { ...USER } });
      sessions.add(session);
      return session;
    },
    async logout(session) { requireSession(session); active.delete(session.jti); return { success: true }; },
    async portfolio(session) {
      requireSession(session);
      const plots = data();
      return {
        presentationVersion: 3, broker: { ...USER }, sampleData: true,
        clients: plots.map((plot, i) => {
          const { payments, ...summary } = plot;
          return { id: `sample-client-${i + 1}`, name: plot.buyerName, phone: '', email: `sample-client-${i + 1}@example.test`,
            address: 'Fictional sample address', city: 'Sample City', state: '', pincode: '', plots: [summary] };
        }),
        collections: [{ id: `col_${'a'.repeat(32)}`, label: 'Collection AAAA-AAAA', plotCount: 2 }],
        summary: { clientCount: 2, plotCount: 2, totalAmount: 3600000, paidAmount: 2400000, balanceAmount: 1200000,
          interestAmount: 0, totalDueAmount: 1200000, upcomingCount: 2, overdueCount: 1 },
        updatedAt: new Date(now()).toISOString(),
      };
    },
    async plot(session, id) {
      requireSession(session);
      const plot = data().find(value => value.id === id);
      if (!plot) fail(404, 'Property unavailable.');
      return { plot, updatedAt: new Date(now()).toISOString(), sampleData: true };
    },
    async requestPasswordReset() { readonly(); },
    async confirmPasswordReset() { readonly(); },
    async changePassword() { readonly(); },
    async registerDevice(session) { requireSession(session); readonly(); },
    async unregisterDevice(session) { requireSession(session); readonly(); },
  };
}
