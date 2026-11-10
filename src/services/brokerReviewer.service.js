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
const invalidReset = () => fail(400, 'This verification code is invalid or expired. Request a new code.');
const bcryptHash = value => typeof value === 'string' && /^\$2[ab]\$(?:10|11|12|13|14)\$[./A-Za-z0-9]{53}$/.test(value);
const passwordAllowed = value => typeof value === 'string' && value.length >= 8 && Buffer.byteLength(value, 'utf8') <= 72;
const requirePassword = value => { if (!passwordAllowed(value)) fail(400, 'Use at least 8 characters and at most 72 UTF-8 bytes for your app password.'); };
const identity = value => typeof value === 'string' && value.length <= 32 ? value.replace(/[\s-]/g, '') : '';
const validDeviceToken = value => typeof value === 'string' && value.length >= 20 && value.length <= 4096 && /^[A-Za-z0-9_:.\-]+$/.test(value);
const tokenHash = value => createHash('sha256').update(value).digest('hex');
const deadline = async (operation, milliseconds) => {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('Sample notifications timed out.'), { statusCode: 503 })), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
};
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
    installmentRemindersEligible: !paid,
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

export function createBrokerReviewerAccess({ env = process.env, now = Date.now, getNotificationSender = () => null, notificationTimeoutMs = 5000 } = {}) {
  const notificationDeadlineMs = Number.isFinite(notificationTimeoutMs) ? Math.min(5000, Math.max(1, notificationTimeoutMs)) : 5000;
  const active = new Map();
  const sessions = new WeakSet();
  const challenges = new Map();
  const devices = new Map();
  const pendingEnrollments = new Map();
  let observedConfiguration;
  let runtimePasswordHash = '';
  let credentialRevision = 0;
  let lastResetRequest = Number.NEGATIVE_INFINITY;
  let lastSampleSendAttempt = Number.NEGATIVE_INFINITY;
  let mutations = Promise.resolve();
  const serial = action => {
    const pending = mutations.then(action);
    mutations = pending.catch(() => {});
    return pending;
  };
  const config = () => {
    const fingerprint = createHash('sha256').update(JSON.stringify([
      env.BROKER_REVIEWER_ENABLED, env.BROKER_REVIEWER_PHONE, env.BROKER_REVIEWER_PASSWORD_HASH,
      env.BROKER_REVIEWER_SECRET, env.BROKER_REVIEWER_TOKEN_VERSION,
      env.BROKER_REVIEWER_RECOVERY_ID_HASH, env.BROKER_REVIEWER_RECOVERY_CODE_HASH,
      env.BROKER_REVIEWER_NOTIFICATIONS_ENABLED,
    ])).digest('hex');
    // Disabling or rotating access is irreversible for already issued sample
    // sessions, even if an operator later restores the previous settings.
    if (fingerprint !== observedConfiguration) {
      active.clear();
      challenges.clear();
      devices.clear();
      pendingEnrollments.clear();
      runtimePasswordHash = env.BROKER_REVIEWER_PASSWORD_HASH || '';
      credentialRevision++;
      lastResetRequest = Number.NEGATIVE_INFINITY;
      lastSampleSendAttempt = Number.NEGATIVE_INFINITY;
      observedConfiguration = fingerprint;
    }
    const value = {
      phone: phone(env.BROKER_REVIEWER_PHONE), hash: env.BROKER_REVIEWER_PASSWORD_HASH || '',
      secret: env.BROKER_REVIEWER_SECRET || '', version: Number(env.BROKER_REVIEWER_TOKEN_VERSION || '0'),
      recoveryIdHash: env.BROKER_REVIEWER_RECOVERY_ID_HASH || '', recoveryCodeHash: env.BROKER_REVIEWER_RECOVERY_CODE_HASH || '',
    };
    if (env.BROKER_REVIEWER_ENABLED !== 'true' || value.phone !== RESERVED_PHONE
      || !bcryptHash(value.hash) || !bcryptHash(value.recoveryIdHash) || !bcryptHash(value.recoveryCodeHash)
      || value.secret.length < 32 || !Number.isSafeInteger(value.version) || value.version < 0) return null;
    value.binding = fingerprint;
    return value;
  };
  const prune = () => {
    for (const [id, item] of active) if (item.until <= now()) active.delete(id);
    for (const [id, item] of challenges) if (item.until <= now()) challenges.delete(id);
  };
  const requireSession = session => {
    const current = config();
    prune();
    const entry = active.get(session?.jti);
    if (!sessions.has(session) || !current || !entry || entry.binding !== current.binding || entry.revision !== credentialRevision) unauthorized();
  };
  const changeCredential = hash => {
    runtimePasswordHash = hash;
    credentialRevision++;
    active.clear();
    challenges.clear();
    devices.clear();
    pendingEnrollments.clear();
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
      const revision = credentialRevision;
      const valid = await bcrypt.compare(body.password, runtimePasswordHash);
      if (!valid || config()?.binding !== current.binding || revision !== credentialRevision) unauthorized();
      prune();
      if (active.size >= 128) fail(429, 'Sample sign-in is temporarily busy. Please try again later.');
      const jti = randomBytes(24).toString('hex');
      const issuedAt = Math.floor(now() / 1000);
      const token = jwt.sign({ realm: REALM, version: current.version, credentialRevision, iat: issuedAt }, current.secret, {
        algorithm: 'HS256', issuer: ISSUER, audience: AUDIENCE, subject: SUBJECT, jwtid: jti, expiresIn: SESSION_SECONDS,
      });
      const until = (issuedAt + SESSION_SECONDS) * 1000;
      active.set(jti, { until, binding: current.binding, revision: credentialRevision });
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
      if (claims.realm !== REALM || claims.version !== current.version || claims.credentialRevision !== credentialRevision || typeof claims.jti !== 'string'
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
    async commissions(session) {
      requireSession(session);
      const commissions = data().map((plot,index) => ({
        plotId: plot.id, plotNumber: plot.number, plotSize: plot.area, plotSizeUnit: plot.areaUnit, buyerName: plot.buyerName,
        totalAmount: 100000, paidAmount: index === 0 ? 50000 : 100000, remainingAmount: index === 0 ? 50000 : 0,
        receivedAmount: index === 0 ? 50000 : 100000, tdsAmount: 0, extraPaidAmount: 0, status: index === 0 ? 'part_paid' : 'paid',
      }));
      return { commissionVersion: 1, sampleData: true, commissions,
        summary: { plotCount: 2, totalAmount: 200000, paidAmount: 150000, remainingAmount: 50000, receivedAmount: 150000, tdsAmount: 0, extraPaidAmount: 0 },
        updatedAt: new Date(now()).toISOString() };
    },
    async commission(session, id) {
      const response = await this.commissions(session);
      const commission = response.commissions.find(value => value.plotId === id);
      if (!commission) fail(404, 'Commission unavailable.');
      const index = PROPERTY_IDS.indexOf(id);
      const date = new Date(now()).toISOString().slice(0,10);
      const transactions = [{
        id: `ct_${tokenHash(`sample-commission-${index}-paid`).slice(0,32)}`,
        date, amount: commission.receivedAmount, tdsAmount: 0, totalAmount: commission.paidAmount,
        paymentMode: 'BANK', status: 'posted', kind: 'payment', contributesToPaid: true,
      }, ...(index === 0 ? [{
        id: `ct_${tokenHash('sample-commission-pending').slice(0,32)}`,
        date, amount: 10000, tdsAmount: 0, totalAmount: 10000,
        paymentMode: 'CHEQUE', status: 'pending', kind: 'payment', contributesToPaid: false,
      }] : [])];
      requireSession(session);
      return { commissionVersion: 1, transactionVersion: 1, commission, transactions,
        updatedAt: response.updatedAt, sampleData: true };
    },
    async plot(session, id) {
      requireSession(session);
      const plot = data().find(value => value.id === id);
      if (!plot) fail(404, 'Property unavailable.');
      return { plot, updatedAt: new Date(now()).toISOString(), sampleData: true };
    },
    async requestPasswordReset(body) {
      return serial(async () => {
        const current = config();
        if (!current || !this.handlesLogin(body)) invalidReset();
        const sampleIdentity = identity(body?.aadhaar);
        const revision = credentialRevision;
        if (!/^[2-9]\d{11}$/.test(sampleIdentity) || !await bcrypt.compare(sampleIdentity, current.recoveryIdHash)) invalidReset();
        if (config()?.binding !== current.binding || revision !== credentialRevision) invalidReset();
        if (now() - lastResetRequest < 60000) fail(429, 'Please wait before requesting another verification code.');
        prune();
        // One current challenge, five attempts and no SMTP. The reusable test
        // code is supplied privately in the Google Play reviewer instructions.
        challenges.clear();
        const challengeId = `sample-reviewer:${randomBytes(24).toString('hex')}`;
        challenges.set(tokenHash(challengeId), { until: now() + 300000, attempts: 0, binding: current.binding, revision });
        lastResetRequest = now();
        return { challengeId, expiresInSeconds: 300, resendAfterSeconds: 60,
          message: 'Sample recovery: use the reusable test code supplied in the reviewer instructions. No email is sent.' };
      });
    },
    async confirmPasswordReset(body) {
      return serial(async () => {
        const current = config();
        const { challengeId, code, newPassword } = body || {};
        requirePassword(newPassword);
        if (!current || typeof challengeId !== 'string' || !/^sample-reviewer:[a-f0-9]{48}$/.test(challengeId)
          || typeof code !== 'string' || !/^\d{6}$/.test(code)) invalidReset();
        prune();
        const challenge = challenges.get(tokenHash(challengeId));
        if (!challenge || challenge.binding !== current.binding || challenge.revision !== credentialRevision || challenge.attempts >= 5) invalidReset();
        challenge.attempts++;
        if (!await bcrypt.compare(code, current.recoveryCodeHash)) invalidReset();
        if (await bcrypt.compare(newPassword, current.recoveryIdHash)) fail(400, 'Choose an app password different from the sample verification number.');
        const hash = await bcrypt.hash(newPassword, 12);
        if (config()?.binding !== current.binding || challenges.get(tokenHash(challengeId)) !== challenge
          || challenge.until <= now() || challenge.revision !== credentialRevision) invalidReset();
        changeCredential(hash);
        return { success: true };
      });
    },
    async changePassword(session, body) {
      return serial(async () => {
        requireSession(session);
        const current = config();
        const { currentPassword, newPassword } = body || {};
        requirePassword(newPassword);
        if (!passwordAllowed(currentPassword) || !await bcrypt.compare(currentPassword, runtimePasswordHash)) fail(400, 'Your current app password is incorrect.');
        if (await bcrypt.compare(newPassword, current.recoveryIdHash)) fail(400, 'Choose an app password different from the sample verification number.');
        const hash = await bcrypt.hash(newPassword, 12);
        requireSession(session);
        if (config()?.binding !== current.binding) unauthorized();
        changeCredential(hash);
        return { success: true };
      });
    },
    async registerDevice(session, body) {
      const reservation = await serial(async () => {
        requireSession(session);
        const current = config(), revision = credentialRevision;
        if (!body || Array.isArray(body) || Object.keys(body).some(key => !['token', 'platform'].includes(key))
          || !validDeviceToken(body.token) || body.platform !== 'android') fail(400, 'Invalid device registration.');
        if (env.BROKER_REVIEWER_NOTIFICATIONS_ENABLED !== 'true') fail(503, 'Sample notifications are temporarily unavailable.');
        const key = tokenHash(body.token);
        if (pendingEnrollments.has(key)) fail(429, 'This sample device enrollment is already in progress.');
        const duplicate = devices.has(key);
        const newPending = [...pendingEnrollments.keys()].filter(value => !devices.has(value)).length;
        if (!duplicate && devices.size + newPending >= 20) fail(429, 'Too many registered devices.');
        if (!duplicate) {
          if (now() - lastSampleSendAttempt < 60000) fail(429, 'Please wait before enrolling another sample notification device.');
          lastSampleSendAttempt = now();
        }
        const value = { key, binding: current.binding, revision, duplicate, token: body.token };
        pendingEnrollments.set(key, value);
        return value;
      });
      const checkReservation = () => {
        requireSession(session);
        if (config()?.binding !== reservation.binding || reservation.revision !== credentialRevision) unauthorized();
        if (pendingEnrollments.get(reservation.key) !== reservation) fail(400, 'Sample enrollment was cancelled.');
      };
      try {
        // Network waits stay outside the mutation queue: recovery, password
        // changes, unregister and revocation remain available during an outage.
        const sender = await deadline(Promise.resolve().then(getNotificationSender), notificationDeadlineMs);
        checkReservation();
        if (typeof sender !== 'function') fail(503, 'Sample notifications are temporarily unavailable.');
        if (reservation.duplicate) return await serial(async () => {
          checkReservation(); return { ok: true };
        });
        // Only the token explicitly enrolled by this authenticated sample
        // request is addressed. No real-account recipient lookup or worker.
        checkReservation();
        await deadline(Promise.resolve(sender({
          token: reservation.token,
          notification: { title: 'Sample reminder', body: 'This is a fictional sample installment reminder. Open My Real Partners to review sample data.' },
          data: { type: 'installment', sample: 'true' },
          android: { priority: 'high', restrictedPackageName: 'app.myrealassets.broker', ttl: 300000,
            collapseKey: 'partner_sample_reminder', notification: { channelId: 'partner_installment_reminders', tag: 'partner_sample_reminder', sound: 'default' } },
        })), notificationDeadlineMs);
        // Revocation can prevent storage, but cannot unsend an already
        // dispatched network request containing this generic sample alert.
        return await serial(async () => {
          checkReservation();
          devices.set(reservation.key, { token: reservation.token, platform: 'android', revision: reservation.revision });
          return { ok: true };
        });
      } finally {
        await serial(async () => {
          if (pendingEnrollments.get(reservation.key) === reservation) pendingEnrollments.delete(reservation.key);
        });
      }
    },
    async unregisterDevice(session, body) {
      return serial(async () => {
        requireSession(session);
        if (!body || Array.isArray(body) || Object.keys(body).some(key => key !== 'token') || !validDeviceToken(body.token)) fail(400, 'Invalid device registration.');
        devices.delete(tokenHash(body.token));
        pendingEnrollments.delete(tokenHash(body.token));
        return { ok: true };
      });
    },
  };
}
