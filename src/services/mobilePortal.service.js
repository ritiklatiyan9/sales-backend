import { createHmac } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { allocateInstallmentPayments } from './mobileInstallmentAllocation.service.js';
import { createClientPortalService, verifyClientToken } from './clientPortal.service.js';

const ISSUER = 'my-real-assets-bookings';
const AUDIENCE = 'my-real-assets-client';
// Broker mobile uses the existing 30-day duration independently.
export const MOBILE_SESSION_DAYS = 30;
export const CLIENT_MOBILE_SESSION_DAYS = 1;
const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
const unauthorized = () => fail(401, 'Please sign in again.');
const amount = value => Math.round((Number(value) || 0) * 100) / 100;
const dateOnly = value => {
  const text = value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
};
const todayInIndia = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
export const normalizeMobile = value => {
  if (typeof value !== 'string' || value.length > 32) return '';
  const digits = value.replace(/[\s()+-]/g, '');
  const local = /^(?:0091|91|0)?([6-9]\d{9})$/.exec(digits);
  return local?.[1] || '';
};
const rootSecret = () => {
  const root = process.env.MOBILE_PORTAL_SECRET || process.env.JWT_ACCESS_SECRET;
  if (!root || root.length < 32) fail(503, 'Sign-in is temporarily unavailable.');
  return root;
};
const privateKey = purpose => createHmac('sha256', rootSecret()).update(`bookings/my-real-assets/v1/${purpose}`).digest();

// Public customers require an explicit link. Staff-only name matching must
// never turn a similarly named member into the owner of a property.
const ownershipSql = `p.site_id=ANY($2::integer[]) AND COALESCE(
  (SELECT m.id FROM members m WHERE m.id=p.buyer_member_id AND m.site_id=p.site_id),
  (SELECT b.client_member_id FROM bookings b JOIN members m ON m.id=b.client_member_id AND m.site_id=b.site_id
    WHERE b.plot_id=p.id AND b.site_id=p.site_id AND lower(COALESCE(b.status,'')) NOT LIKE 'cancel%'
    ORDER BY b.id DESC LIMIT 1)
) = ANY($1::integer[])`;

// Sign-encoded refunds are debits and require approval. Pending ordinary
// credits follow the Accounts credit-first policy; uncleared cheques never post.
const postsSql = (alias, mode, date) => `financial_transaction_posts(
  CASE WHEN ${alias}.amount < 0 THEN 'debit' ELSE 'credit' END,
  ${alias}.status,${alias}.${mode},${alias}.cheque_status)
  AND ${alias}.${date} BETWEEN DATE '1900-01-01' AND DATE '2100-12-31'`;

// Match Accounts listInstallments: simple interest on the currently unpaid
// overdue principal. This is an estimate, separate from posted sale receipts.
const installmentInterest = (plot, installment, today) => {
  const rate = Number(plot.interest_rate) || 0;
  const due = dateOnly(installment.due_date);
  if (!plot.interest_enabled || rate <= 0 || installment.remaining <= 0 || !due || due >= today) return 0;
  const days = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86400000;
  const divisor = { per_day: 1, per_month: 30, per_quarter: 90, per_year: 365 }[plot.interest_type] || 30;
  return days > 0 ? amount(installment.remaining * rate / 100 * days / divisor) : 0;
};

export function projectMobilePlot(plot, schedule, receipts, today = todayInIndia()) {
  const direct = {};
  const scheduleIds = new Set(schedule.map(row => String(row.id)));
  for (const receipt of receipts) {
    if (receipt.installment_id != null && scheduleIds.has(String(receipt.installment_id))) {
      direct[receipt.installment_id] = amount((direct[receipt.installment_id] || 0) + amount(receipt.amount));
    }
  }
  const netPaid = amount(receipts.reduce((sum, row) => sum + amount(row.amount), 0));
  // Refunds can exceed one receipt bucket. Retain direct assignments while
  // ensuring the plan never claims more paid than all posted receipts net.
  for (const row of schedule) direct[row.id] = Math.min(Math.max(direct[row.id] || 0, 0), Math.max(amount(row.amount), 0));
  let directTotal = Object.values(direct).reduce((sum, value) => sum + Math.max(value, 0), 0);
  let offset = Math.max(directTotal - Math.max(netPaid, 0), 0);
  for (const row of [...schedule].reverse()) {
    const paid = Math.max(direct[row.id] || 0, 0);
    const reduction = Math.min(paid, offset);
    direct[row.id] = amount(paid - reduction);
    offset = amount(offset - reduction);
  }
  directTotal = Object.values(direct).reduce((sum, value) => sum + Math.max(value, 0), 0);
  const genericPaid = Math.max(amount(netPaid - directTotal), 0);
  let actualSchedule = schedule;
  if (plot.full_payment_due) actualSchedule = [{
    id: `full-${plot.id}`, installment_name: 'Full payment', amount: plot.sale_price,
    due_date: dateOnly(plot.full_payment_due_date) || undefined, sort_order: 0,
  }];
  const allocations = allocateInstallmentPayments(actualSchedule, {
    genericPaid: plot.full_payment_due ? Math.max(netPaid, 0) : genericPaid,
    directPaidByInstallment: plot.full_payment_due ? {} : direct,
    asOf: `${today}T00:00:00Z`,
  }).installments;
  const installments = allocations.map(row => ({
    id: String(row.id), title: row.installment_name || 'Installment',
    dueDate: dateOnly(row.due_date), amount: amount(row.amount), paidAmount: amount(row.paid),
    balanceAmount: amount(row.remaining), status: row.status === 'pending' ? 'upcoming' : row.status,
    interestAmount: installmentInterest(plot, row, today),
  }));
  const next = installments.filter(row => row.balanceAmount > 0 && row.dueDate)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
  const totalAmount = amount(plot.sale_price);
  const balanceAmount = Math.max(amount(totalAmount - netPaid), 0);
  const interestAmount = amount(installments.reduce((sum, row) => sum + row.interestAmount, 0));
  return {
    id: String(plot.id), number: plot.plot_no || 'Plot', projectName: 'Your Property',
    projectId: String(plot.site_id), area: amount(plot.plot_size),
    areaUnit: plot.unit_type === 'flat' ? 'sq ft' : 'sq yd',
    status: plot.status || 'Active', totalAmount, paidAmount: netPaid,
    balanceAmount, interestAmount, totalDueAmount: amount(balanceAmount + interestAmount),
    progress: totalAmount > 0 ? Math.min(1, Math.max(netPaid / totalAmount, 0)) : 0,
    nextDueDate: next?.dueDate || null, nextDueAmount: next?.balanceAmount || 0,
    nextDueInterestAmount: next?.interestAmount || 0,
    paymentPlan: {
      name: plot.full_payment_due ? 'Full payment' : installments.length ? 'Installment plan' : 'Payment plan not set',
      installmentCount: installments.length, bookingDate: dateOnly(plot.booking_date),
    },
    installments,
    payments: receipts.map(row => ({
      id: `${row.source}:${row.id}`, date: dateOnly(row.date), amount: amount(row.amount),
      mode: row.mode || 'Payment', reference: row.reference || '',
      status: amount(row.amount) < 0 ? 'refund' : row.status || 'recorded',
    })).sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.id.localeCompare(a.id)),
  };
}

export function createMobileFinancialReader(db, {
  financeCacheMs = 5000,
  financeCacheMaxEntries = 256,
  financeCacheMaxBytes = 8 * 1024 * 1024,
  now = Date.now,
} = {}) {
  // Cache financial rows only. Every request still verifies current identity and
  // current plot ownership, so removing access is never delayed by this cache.
  const financeCache = new Map();
  const financePending = new Map();
  let financeCacheBytes = 0;
  const ttlMs = Math.min(15000, Math.max(0, Number(financeCacheMs) || 0));
  function removeCached(id) {
    const entry = financeCache.get(id);
    if (entry) financeCacheBytes -= entry.bytes;
    financeCache.delete(id);
  }
  function cachedFinance(id) {
    const entry = financeCache.get(id);
    if (!entry) return null;
    if (entry.until <= now()) { removeCached(id); return null; }
    financeCache.delete(id);
    financeCache.set(id, entry);
    return entry.value;
  }
  function rememberFinance(id, value) {
    if (!ttlMs) return;
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > financeCacheMaxBytes) return;
    removeCached(id);
    for (const [key, entry] of financeCache) if (entry.until <= now()) removeCached(key);
    while (financeCache.size && (financeCache.size >= financeCacheMaxEntries || financeCacheBytes + bytes > financeCacheMaxBytes)) {
      removeCached(financeCache.keys().next().value);
    }
    financeCache.set(id, { value, bytes, until: now() + ttlMs });
    financeCacheBytes += bytes;
  }
  async function queryFinancials(ids) {
    const [schedules, receipts] = await Promise.all([
      db.query(`SELECT pi.id,pi.plot_id,pi.installment_name,pi.amount,pi.due_date::text AS due_date,pi.sort_order
        FROM plot_installments pi WHERE pi.plot_id=ANY($1::integer[])
        AND lower(COALESCE(pi.status,'')) NOT IN ('cancelled','canceled','deleted','void','voided')
        ORDER BY pi.plot_id,pi.sort_order,pi.due_date,pi.id`, [ids]),
      db.query(`SELECT 'payment' AS source,pp.id,pp.plot_id,NULL::integer AS installment_id,pp.amount,
        pp.date::text AS date,pp.payment_type AS mode,COALESCE(to_jsonb(pp)->>'receipt_no',to_jsonb(pp)->>'reference','') AS reference,pp.status
        FROM plot_payments pp JOIN plots p ON p.id=pp.plot_id AND p.site_id=pp.site_id
        WHERE pp.plot_id=ANY($1::integer[]) AND ${postsSql('pp', 'payment_type', 'date')}
        UNION ALL
        SELECT 'installment',pip.id,pip.plot_id,pip.installment_id,pip.amount,pip.payment_date::text,
        pip.payment_mode,COALESCE(pip.reference,''),pip.status
        FROM plot_installment_payments pip JOIN plot_installments pi ON pi.id=pip.installment_id AND pi.plot_id=pip.plot_id
        WHERE pip.plot_id=ANY($1::integer[]) AND ${postsSql('pip', 'payment_mode', 'payment_date')}
        ORDER BY plot_id,date,id`, [ids]),
    ]);
    const updatedAt = new Date(now()).toISOString();
    const grouped = new Map(ids.map(id => [id, { schedules: [], receipts: [], updatedAt }]));
    for (const row of schedules.rows) grouped.get(row.plot_id)?.schedules.push(row);
    for (const row of receipts.rows) grouped.get(row.plot_id)?.receipts.push(row);
    return grouped;
  }
  async function financialsFor(ids, { forceFresh = false } = {}) {
    const values = new Map();
    const waiting = new Map();
    const missing = [];
    for (const id of ids) {
      const cached = forceFresh ? null : cachedFinance(id);
      if (cached) values.set(id, cached);
      else if (!forceFresh && financePending.has(id)) waiting.set(id, financePending.get(id).promise);
      else missing.push(id);
    }
    if (missing.length) {
      const token = Symbol('financial-read');
      const batch = queryFinancials(missing);
      for (const id of missing) {
        const promise = batch.then(grouped => {
          const value = grouped.get(id);
          // A newer explicit refresh wins even if an older request finishes last.
          if (financePending.get(id)?.token === token) rememberFinance(id, value);
          return value;
        }).finally(() => { if (financePending.get(id)?.token === token) financePending.delete(id); });
        financePending.set(id, { token, promise });
        waiting.set(id, promise);
      }
    }
    await Promise.all([...waiting].map(async ([id, promise]) => values.set(id, await promise)));
    return values;
  }
  return financialsFor;
}

export function createMobilePortalService(db, options = {}) {
  const { now = Date.now } = options;
  const financialsFor = createMobileFinancialReader(db, options);
  const clientPortal = createClientPortalService(db);
  const userFor = members => ({ id: `client:${members[0].id}`, name: members[0].full_name || 'Property owner', role: 'client' });
  async function getClientSession(accountId, version, { setup = false } = {}) {
    try {
      const session = await clientPortal.getSession({ accountId, version });
      if (session.account.password_changed === setup || !session.members.some(row => row.member_active !== false)) unauthorized();
      return session;
    }
    catch (error) { if (error.status === 401) unauthorized(); throw error; }
  }
  async function accountSession(accountId, version, { setup = false } = {}) {
    const session = await getClientSession(accountId, version, { setup });
    // Setup sessions may only change a password or sign out, never read data.
    const members = session.members.filter(row => row.member_active !== false)
      .map(row => ({ id: row.member_id, site_id: row.site_id, full_name: row.full_name }));
    if (!members.length) unauthorized();
    return { members, user: userFor(members), accountId, version, setupRequired: setup };
  }
  async function getSession(token) {
    let claims;
    try {
      claims = jwt.verify(token, privateKey('access'), { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE });
    } catch { unauthorized(); }
    if (!['mobile-client-password-v2', 'mobile-client-password-setup-v1'].includes(claims.realm) || !/^mra-client-account:[1-9]\d*$/.test(claims.sub || '')
      || !Number.isSafeInteger(claims.version)) unauthorized();
    const accountId = Number(claims.sub.split(':')[1]);
    if (!Number.isSafeInteger(accountId)) unauthorized();
    return accountSession(accountId, claims.version, { setup: claims.realm === 'mobile-client-password-setup-v1' });
  }
  async function loadPlots(session, plotId = null, options = {}) {
    if (session.setupRequired) fail(403, 'Set a new password to continue.');
    const parameters = [session.members.map(row => row.id), [...new Set(session.members.map(row => row.site_id))]];
    if (plotId !== null) {
      if (!/^[1-9]\d*$/.test(String(plotId)) || !Number.isSafeInteger(Number(plotId)) || Number(plotId) > 2147483647) fail(404, 'Property unavailable.');
      parameters.push(Number(plotId));
    }
    const { rows: plots } = await db.query(`SELECT p.id,p.site_id,p.plot_no,p.plot_size,p.sale_price,p.booking_date,p.status,
      COALESCE((to_jsonb(p)->>'full_payment_due')::boolean,false) AS full_payment_due,
      to_jsonb(p)->>'full_payment_due_date' AS full_payment_due_date,
      COALESCE(to_jsonb(p)->>'unit_type','plot') AS unit_type,
      COALESCE((to_jsonb(p)->>'interest_enabled')::boolean,false) AS interest_enabled,
      COALESCE((to_jsonb(p)->>'interest_rate')::numeric,0) AS interest_rate,
      COALESCE(to_jsonb(p)->>'interest_type','per_month') AS interest_type
      FROM plots p WHERE ${ownershipSql}
      AND upper(trim(COALESCE(p.status,''))) NOT IN ('AVAILABLE','COMPANY')
      ${plotId !== null ? 'AND p.id=$3' : ''} ORDER BY p.site_id,p.plot_no,p.id LIMIT 1001`, parameters);
    if (plots.length > 1000) fail(503, 'Your portfolio is temporarily unavailable.');
    if (plotId !== null && !plots.length) fail(404, 'Property unavailable.');
    if (!plots.length) return { details: [], updatedAt: new Date(now()).toISOString() };
    const ids = plots.map(row => row.id);
    const financials = await financialsFor(ids, options);
    const today = todayInIndia();
    const details = plots.map(plot => {
      const data = financials.get(plot.id);
      // Site IDs are needed internally by broker presentation, not by owner apps.
      const { projectId: _projectId, ...ownerView } = projectMobilePlot(plot, data.schedules, data.receipts, today);
      return ownerView;
    });
    const updatedAt = [...financials.values()].map(row => row.updatedAt).sort()[0] || new Date(now()).toISOString();
    return { details, updatedAt };
  }
  return {
    getSession,
    async login(body) {
      if (!body || typeof body !== 'object' || Array.isArray(body) || (body.role !== undefined && body.role !== 'client')) {
        fail(401, 'Mobile number or password did not match.');
      }
      const mobile = normalizeMobile(body.mobile);
      const password = body.password;
      if (!mobile || typeof password !== 'string' || !password || Buffer.byteLength(password, 'utf8') > 72) {
        fail(401, 'Mobile number or password did not match.');
      }
      let match = await clientPortal.authenticate(mobile, password, { dryRun: true });
      if (!match) fail(401, 'Mobile number or password did not match.');
      if (!match.account) {
        // Existing verified-KYC enrollment creates the private account; this
        // is restricted to first-time identity credentials and carries a risk
        // of account takeover if someone knows both identifiers.
        const enrolled = await clientPortal.authenticate(mobile, password);
        if (!enrolled?.accessToken) fail(401, 'Mobile number or password did not match.');
        match = await clientPortal.getSession(verifyClientToken(enrolled.accessToken));
      }
      const setup = !match.account.password_changed;
      if (!setup && match.members.some(row => String(row.aadhar_no || '').replace(/[\s-]/g, '') === password.replace(/[\s-]/g, ''))) {
        fail(401, 'Mobile number or password did not match.');
      }
      const session = await accountSession(match.account.id, match.account.token_version, { setup });
      const token = jwt.sign({ realm: setup ? 'mobile-client-password-setup-v1' : 'mobile-client-password-v2', version: match.account.token_version }, privateKey('access'), {
        algorithm: 'HS256', issuer: ISSUER, audience: AUDIENCE, subject: `mra-client-account:${match.account.id}`, expiresIn: setup ? '10m' : `${CLIENT_MOBILE_SESSION_DAYS}d`,
      });
      return {
        token,
        expiresAt: new Date(jwt.decode(token).exp * 1000).toISOString(),
        sessionDurationDays: setup ? null : CLIENT_MOBILE_SESSION_DAYS,
        passwordChangeRequired: setup,
        user: session.user,
      };
    },
    async logout(session) {
      // This version is shared with the web portal: sign-out revokes all
      // currently issued client sessions for this account, on every device.
      const current = await getClientSession(session.accountId, session.version, { setup: session.setupRequired });
      await clientPortal.logout(current);
    },
    async changePassword(session, body) {
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some(key => !['currentPassword', 'newPassword'].includes(key))) {
        fail(400, 'Enter your current and new password.');
      }
      const { currentPassword, newPassword } = body;
      if (typeof currentPassword !== 'string' || !currentPassword || Buffer.byteLength(currentPassword, 'utf8') > 72
        || typeof newPassword !== 'string' || newPassword.length < 12 || Buffer.byteLength(newPassword, 'utf8') > 72
        || newPassword === currentPassword) {
        fail(400, 'Choose a different password of at least 12 characters and at most 72 UTF-8 bytes.');
      }
      const current = await getClientSession(session.accountId, session.version, { setup: session.setupRequired });
      if (current.members.some(row => String(row.aadhar_no || '').replace(/[\s-]/g, '') === newPassword.replace(/[\s-]/g, ''))) {
        fail(400, 'Choose a different password of at least 12 characters and at most 72 UTF-8 bytes.');
      }
      try {
        // Optimistic token_version guard inside updateProfile makes concurrent
        // changes safe and invalidates existing web and mobile tokens.
        await clientPortal.updateProfile(current, { current_password: currentPassword, new_password: newPassword });
      } catch (error) {
        if (error.status === 403) fail(403, 'Your current password is incorrect.');
        if (error.status === 400) fail(400, 'Choose a different password of at least 12 characters and at most 72 UTF-8 bytes.');
        if (error.status === 401) unauthorized();
        throw error;
      }
    },
    async portfolio(session, { includeDetails = false, forceFresh = false } = {}) {
      const { details, updatedAt } = await loadPlots(session, null, { forceFresh });
      const plots = details.map(({ paymentPlan, installments, payments, ...plot }) => plot);
      return { plots, summary: {
        plotCount: plots.length, totalAmount: amount(plots.reduce((sum, row) => sum + row.totalAmount, 0)),
        paidAmount: amount(plots.reduce((sum, row) => sum + row.paidAmount, 0)),
        balanceAmount: amount(plots.reduce((sum, row) => sum + row.balanceAmount, 0)),
        interestAmount: amount(plots.reduce((sum, row) => sum + row.interestAmount, 0)),
        totalDueAmount: amount(plots.reduce((sum, row) => sum + row.totalDueAmount, 0)),
        upcomingCount: details.reduce((sum, row) => sum + row.installments.filter(item => item.balanceAmount > 0).length, 0),
      }, updatedAt, ...(includeDetails ? { details: details.map(plot => ({ plot, updatedAt })) } : {}) };
    },
    async plot(session, id, { forceFresh = false } = {}) {
      const { details, updatedAt } = await loadPlots(session, id, { forceFresh });
      return { plot: details[0], updatedAt };
    },
  };
}
