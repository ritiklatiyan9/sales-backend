import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { createClientPortalService } from './clientPortal.service.js';
import { createMobilePortalService, mobileCurrentOwnerSql, mobileVisibleStatusSql } from './mobilePortal.service.js';

const error = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
const tokenHash = token => createHash('sha256').update(token).digest('hex');
function validToken(token) { return typeof token === 'string' && token.length >= 20 && token.length <= 4096 && /^[A-Za-z0-9_:.\-]+$/.test(token); }
export function createMobilePushDevices(db) {
  return {
    async register(session, body) {
      if (!body || Object.keys(body).some(k => !['token','platform'].includes(k)) || !validToken(body.token) || !['android','ios'].includes(body.platform)) error(400, 'Invalid device registration.');
      const connection = await db.connect();
      try {
        await connection.query('BEGIN');
        const account = await connection.query('SELECT id FROM booking_client_accounts WHERE id=$1 AND token_version=$2 AND is_active=true FOR UPDATE', [session.accountId,session.version]);
        if (!account.rows.length) error(401, 'Please sign in again.');
        await connection.query('DELETE FROM booking_mobile_push_devices WHERE account_id=$1 AND account_version<>$2', [session.accountId,session.version]);
        const count = await connection.query('SELECT count(*)::int AS n FROM booking_mobile_push_devices WHERE account_id=$1 AND token_hash<>$2', [session.accountId,tokenHash(body.token)]);
        if (count.rows[0].n >= 20) error(429, 'Too many registered devices.');
        await connection.query(`INSERT INTO booking_mobile_push_devices(token_hash,token,platform,account_id,account_version)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(token_hash) DO UPDATE SET token=excluded.token,platform=excluded.platform,
        registered_at=CASE WHEN booking_mobile_push_devices.account_id<>excluded.account_id OR booking_mobile_push_devices.account_version<>excluded.account_version THEN now() ELSE booking_mobile_push_devices.registered_at END,
        account_id=excluded.account_id,account_version=excluded.account_version,updated_at=now()`,
        [tokenHash(body.token),body.token,body.platform,session.accountId,session.version]);
        await connection.query('COMMIT');
      } catch (e) { await connection.query('ROLLBACK'); throw e; } finally { connection.release(); }
    },
    async unregister(session, body) {
      if (!body || Object.keys(body).some(k => k !== 'token') || !validToken(body.token)) error(400, 'Invalid device registration.');
      await db.query('DELETE FROM booking_mobile_push_devices WHERE token_hash=$1 AND account_id=$2', [tokenHash(body.token),session.accountId]);
    },
  };
}

// Server configuration only: never accept a path or credential from a request.
// A configured file takes precedence and fails closed if it cannot be read.
export function readMobilePushServiceAccount(env = process.env) {
  let raw;
  if (env.MRA_FCM_SERVICE_ACCOUNT_FILE) {
    const path = env.MRA_FCM_SERVICE_ACCOUNT_FILE;
    if (!isAbsolute(path) || path.includes('\0')) throw new Error('Invalid service account file');
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('Invalid service account file');
    raw = readFileSync(path, 'utf8');
  } else {
    raw = env.MRA_FCM_SERVICE_ACCOUNT_JSON || (env.MRA_FCM_SERVICE_ACCOUNT_B64 ? Buffer.from(env.MRA_FCM_SERVICE_ACCOUNT_B64, 'base64').toString('utf8') : '');
  }
  if (!raw) return null;
  const serviceAccount = JSON.parse(raw);
  if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) throw new Error('Invalid service account');
  return serviceAccount;
}

export function validateMobilePushProject(serviceAccount, env = process.env) {
  const projectId = String(env.MRA_FCM_PROJECT_ID || 'myrealassets-380f8').trim();
  if (!projectId || serviceAccount?.project_id !== projectId) throw new Error('Firebase project mismatch');
  return projectId;
}

let messaging = null;
export function mobileMessaging() {
  if (messaging) return messaging;
  try {
    const serviceAccount = readMobilePushServiceAccount();
    if (!serviceAccount) return null;
    const projectId = validateMobilePushProject(serviceAccount);
    const app = getApps().find(item => item.name === 'mra-fcm') || initializeApp({credential: cert(serviceAccount),projectId}, 'mra-fcm');
    if (app.options.projectId !== projectId) throw new Error('Firebase project mismatch');
    messaging = getMessaging(app);
    return messaging;
  } catch { console.error('[mra-push] Firebase credentials are invalid or target a different project'); return null; }
}
export const pushEnabled = () => process.env.MRA_FCM_ENABLED === 'true';
const todayIndia = (now = Date.now()) => new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
export const INSTALLMENT_REMINDER_OFFSETS = Object.freeze([3, 1, 0]);
export const REMINDER_SCAN_INTERVAL_MS = 5 * 60_000;
export function pushMessage(type, { reminderOffset, now = Date.now() } = {}) {
  const reminder = type === 'installment';
  // The OS displays this notification even when the Flutter process is closed.
  // A generic replacement tag avoids a stack of private installment messages.
  // Expire at midnight in India so a delayed alert cannot claim "due today"
  // after its reminder day. Current account data is loaded only inside the app.
  const expiresAt = Date.parse(`${todayIndia(now)}T23:59:59+05:30`);
  const ttl = Math.max(0, expiresAt - now);
  return {
    notification: {
      title: reminder ? 'Installment reminder' : 'My Real Assets',
      body: type === 'payment_update' ? 'Your payment activity has changed. Open the app to review it.'
        : type === 'refund' ? 'A refund has been recorded. Open the app to view your activity.'
        : reminder ? reminderOffset === 0 ? 'An installment is due today. Open the app to view your plan.'
          : reminderOffset === 1 ? 'An installment is due tomorrow. Open the app to view your plan.'
          : 'An installment is coming due. Open the app to view your plan.'
        : 'A payment has been recorded. Open the app to view your activity.',
    },
    data: { type: type === 'payment_update' ? 'payment' : type },
    android: {
      priority: 'high',
      ...(reminder ? { ttl, collapseKey: 'installment_reminders' } : {}),
      notification: {
        channelId: reminder ? 'installment_reminders' : 'property_activity',
        ...(reminder ? { tag: 'installment_reminder', priority: 'high', sound: 'default' } : {}),
      },
    },
    apns: {
      headers: {
        'apns-push-type': 'alert', 'apns-priority': '10',
        ...(reminder ? { 'apns-expiration': String(Math.floor(expiresAt / 1000)) } : {}),
      },
      payload: { aps: { sound: 'default' } },
    },
  };
}

const dayDiff = (date, today) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
export function createMobilePushWorker(db, { send, today = todayIndia, now = Date.now } = {}) {
  const clientPortal = createClientPortalService(db);
  const portal = createMobilePortalService(db, {financeCacheMs:0});
  async function accountPortfolio(accountId, version) {
    try {
      const identity = await clientPortal.getSession({accountId:Number(accountId),version:Number(version)});
      const members = identity.members.filter(m => m.member_active !== false).map(m => ({id:m.member_id,site_id:m.site_id,full_name:m.full_name}));
      if (!identity.account.password_changed || !members.length) return null;
      return await portal.portfolio({accountId:Number(accountId),version:Number(version),members}, {includeDetails:true,forceFresh:true});
    } catch (e) { if (e.status === 401 || e.statusCode === 401) return null; throw e; }
  }
  async function enqueueReminders() {
    const accounts = await db.query(`SELECT DISTINCT d.account_id,d.account_version FROM booking_mobile_push_devices d
      JOIN booking_client_accounts a ON a.id=d.account_id AND a.is_active AND a.token_version=d.account_version`);
    const date = today();
    let failures = 0;
    for (const account of accounts.rows) {
      try {
        const portfolio = await accountPortfolio(account.account_id, account.account_version);
        for (const detail of portfolio?.details || []) {
          for (const inst of detail.plot.installments || []) {
            const offset = dayDiff(inst.dueDate, date);
            if (inst.balanceAmount > 0 && inst.dueDate && INSTALLMENT_REMINDER_OFFSETS.includes(offset)) {
              await db.query(`INSERT INTO booking_mobile_push_events(plot_id,source,source_id,kind,account_id,reminder_date,reminder_offset)
                VALUES($1,'installment',$2,'installment',$3,$4,$5)
                ON CONFLICT(account_id,plot_id,source_id,reminder_date,reminder_offset) WHERE kind='installment'
                DO UPDATE SET expanded_at=NULL
                WHERE booking_mobile_push_events.expanded_at IS NOT NULL AND EXISTS (
                  SELECT 1 FROM booking_mobile_push_devices d JOIN booking_client_accounts a ON a.id=d.account_id
                  WHERE d.account_id=booking_mobile_push_events.account_id AND a.is_active AND a.token_version=d.account_version
                  AND NOT EXISTS (SELECT 1 FROM booking_mobile_push_deliveries delivery
                    WHERE delivery.event_id=booking_mobile_push_events.id AND delivery.token_hash=d.token_hash))`,
                [detail.plot.id,inst.id,account.account_id,inst.dueDate,offset]);
            }
          }
        }
      } catch { failures++; }
    }
    // Continue scanning other accounts, then retry the incomplete day next tick.
    if (failures) throw new Error('REMINDER_SCAN_INCOMPLETE');
  }
  async function expandOne() {
    const {rows} = await db.query(`UPDATE booking_mobile_push_events SET lease_until=now()+interval '2 minutes'
      WHERE id=(SELECT id FROM booking_mobile_push_events WHERE expanded_at IS NULL AND (lease_until IS NULL OR lease_until<now())
        ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`);
    const e=rows[0]; if(!e) return false;
    await db.query(`INSERT INTO booking_mobile_push_deliveries(event_id,token_hash)
      SELECT $1,d.token_hash FROM booking_mobile_push_devices d JOIN booking_client_accounts a ON a.id=d.account_id
      WHERE a.is_active AND a.token_version=d.account_version AND (d.registered_at <= $2 OR $5='installment')
        AND ($3::integer IS NULL OR d.account_id=$3)
        AND EXISTS (SELECT 1 FROM booking_client_members cm JOIN members m ON m.id=cm.member_id JOIN plots p ON p.id=$4 AND p.site_id=m.site_id
          WHERE cm.account_id=d.account_id AND COALESCE(to_jsonb(m)->>'is_active','true')<>'false'
          AND ${mobileVisibleStatusSql}
          AND (${mobileCurrentOwnerSql})=m.id)
      ON CONFLICT DO NOTHING`, [e.id,e.created_at,e.account_id,e.plot_id,e.kind]);
    await db.query('UPDATE booking_mobile_push_events SET expanded_at=now(),lease_until=NULL WHERE id=$1',[e.id]);
    return true;
  }
  async function dispatchOne() {
    const {rows} = await db.query(`UPDATE booking_mobile_push_deliveries SET lease_until=now()+interval '2 minutes',attempts=attempts+1
      WHERE (event_id,token_hash)=(SELECT event_id,token_hash FROM booking_mobile_push_deliveries WHERE state='pending' AND next_attempt<=now()
        AND (lease_until IS NULL OR lease_until<now()) ORDER BY event_id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`);
    const delivery=rows[0]; if(!delivery) return false;
    const result = await db.query(`SELECT e.*,e.reminder_date::text AS reminder_date,d.token,d.account_id AS device_account_id,d.account_version,d.token_hash
      FROM booking_mobile_push_events e JOIN booking_mobile_push_devices d ON d.token_hash=$2
      WHERE e.id=$1 AND ((e.kind='installment' AND e.account_id=d.account_id)
        OR (e.kind<>'installment' AND d.registered_at<=e.created_at))`, [delivery.event_id, delivery.token_hash]);
    const row=result.rows[0];
    if (!row) {
      await db.query("UPDATE booking_mobile_push_deliveries SET state='skipped',lease_until=NULL WHERE event_id=$1 AND token_hash=$2", [delivery.event_id,delivery.token_hash]);
      return true;
    }
    try {
      const portfolio = await accountPortfolio(row.device_account_id,row.account_version);
      const plot = portfolio?.details?.find(x => String(x.plot.id) === String(row.plot_id))?.plot;
      let valid = Boolean(plot) && now() - new Date(row.created_at).getTime() < 48*3600*1000;
      if (row.kind === 'installment') {
        const inst = plot?.installments?.find(i => String(i.id) === row.source_id && i.dueDate === String(row.reminder_date).slice(0,10));
        valid = valid && Boolean(inst && inst.balanceAmount > 0 && dayDiff(inst.dueDate,today()) === row.reminder_offset);
      } else if (row.kind !== 'payment_update') {
        const source = row.source === 'plot_payments' ? 'payment' : 'installment';
        valid = valid && Boolean(plot?.payments?.some(p => p.id === `${source}:${row.source_id}` && (row.kind === 'refund' ? p.amount < 0 : p.amount > 0)));
      }
      if (valid) await send({...pushMessage(row.kind, { reminderOffset: row.reminder_offset, now: now() }),token:row.token});
      await db.query("UPDATE booking_mobile_push_deliveries SET state=$3,lease_until=NULL WHERE event_id=$1 AND token_hash=$2",[row.id,row.token_hash,valid?'sent':'skipped']);
    } catch (e) {
      if (['messaging/registration-token-not-registered','messaging/invalid-registration-token'].includes(e.code)) {
        await db.query('DELETE FROM booking_mobile_push_devices WHERE token_hash=$1',[row.token_hash]);
      } else {
        await db.query(`UPDATE booking_mobile_push_deliveries SET state=CASE WHEN attempts>=8 THEN 'failed' ELSE 'pending' END,
          lease_until=NULL,next_attempt=now()+interval '5 minutes' WHERE event_id=$1 AND token_hash=$2`,[row.id,row.token_hash]);
        console.error('[mra-push] Delivery deferred:', e.code || 'ERROR');
      }
    }
    return true;
  }
  return {enqueueReminders,expandOne,dispatchOne};
}

// A reminder scan is periodic, rather than once per process/day: clients may
// register a device, receive a new plan, or get a due-date correction later.
// Database reminder/delivery keys make repeated scans safe across instances.
export function createMobilePushCycle(db, worker, { now = Date.now, today = todayIndia } = {}) {
  let lastCleanupDay = '';
  let lastReminderDay = '';
  let lastReminderScan = Number.NEGATIVE_INFINITY;
  return async () => {
    const date = today();
    let scanError;
    if (lastCleanupDay !== date) {
      await db.query(`DELETE FROM booking_mobile_push_devices d USING booking_client_accounts a
        WHERE a.id=d.account_id AND (NOT a.is_active OR a.token_version<>d.account_version)`);
      await db.query("DELETE FROM booking_mobile_push_events WHERE created_at < now()-interval '30 days'");
      lastCleanupDay = date;
    }
    if (lastReminderDay !== date || now() - lastReminderScan >= REMINDER_SCAN_INTERVAL_MS) {
      try {
        await worker.enqueueReminders();
        lastReminderDay = date;
        lastReminderScan = now();
      } catch (error) { scanError = error; }
    }
    for(let i=0;i<100 && await worker.expandOne();i++);
    for(let i=0;i<100 && await worker.dispatchOne();i++);
    // A broken account/plan must not block already queued deliveries for
    // everyone else. Report the incomplete scan and retry it on the next poll.
    if (scanError) throw scanError;
  };
}
let started = false;
export function startMobilePushWorker(db) {
  if(started || !pushEnabled()) return;
  const messenger=mobileMessaging();
  if (!messenger) {console.error('[mra-push] Enabled without valid Firebase credentials; worker disabled'); return;}
  started=true;
  const worker=createMobilePushWorker(db,{send: message=>messenger.send(message)});
  const cycle=createMobilePushCycle(db,worker);
  const tick=async()=>{
    try {
      await cycle();
    } catch(e) {console.error('[mra-push] Worker error:',e.code||'ERROR');}
    finally {setTimeout(tick,60_000).unref();}
  };
  void tick();
}
