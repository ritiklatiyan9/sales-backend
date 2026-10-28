import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { createClientPortalService } from './clientPortal.service.js';
import { createMobilePortalService } from './mobilePortal.service.js';

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

let messaging = null;
export function mobileMessaging() {
  if (messaging) return messaging;
  try {
    const serviceAccount = readMobilePushServiceAccount();
    if (!serviceAccount) return null;
    const app = getApps().find(item => item.name === 'mra-fcm') || initializeApp({credential: cert(serviceAccount)}, 'mra-fcm');
    messaging = getMessaging(app);
    return messaging;
  } catch { console.error('[mra-push] Firebase credentials are invalid'); return null; }
}
export const pushEnabled = () => process.env.MRA_FCM_ENABLED === 'true';
export const pushMessage = type => ({
  notification: {
    title: 'My Real Assets',
    body: type === 'payment_update' ? 'Your payment activity has changed. Open the app to review it.'
      : type === 'refund' ? 'A refund has been recorded. Open the app to view your activity.'
      : type === 'installment' ? 'An installment is coming due. Open the app to view your plan.'
      : 'A payment has been recorded. Open the app to view your activity.',
  },
  data: { type: type === 'payment_update' ? 'payment' : type },
  android: { priority: 'high', notification: { channelId: 'property_activity' } },
  apns: { payload: { aps: { sound: 'default' } } },
});

const todayIndia = () => new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const dayDiff = (date, today) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
export function createMobilePushWorker(db, { send, today = todayIndia } = {}) {
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
            if (inst.balanceAmount > 0 && inst.dueDate && (offset === 3 || offset === 0)) {
              await db.query(`INSERT INTO booking_mobile_push_events(plot_id,source,source_id,kind,account_id,reminder_date,reminder_offset)
                VALUES($1,'installment',$2,'installment',$3,$4,$5) ON CONFLICT DO NOTHING`,
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
      WHERE a.is_active AND a.token_version=d.account_version AND d.registered_at <= $2
        AND ($3::integer IS NULL OR d.account_id=$3)
        AND EXISTS (SELECT 1 FROM booking_client_members cm JOIN members m ON m.id=cm.member_id JOIN plots p ON p.id=$4 AND p.site_id=m.site_id
          WHERE cm.account_id=d.account_id AND COALESCE(to_jsonb(m)->>'is_active','true')<>'false'
          AND upper(trim(COALESCE(p.status,''))) NOT IN ('AVAILABLE','COMPANY')
          AND COALESCE((SELECT m2.id FROM members m2 WHERE m2.id=p.buyer_member_id AND m2.site_id=p.site_id),
            (SELECT b.client_member_id FROM bookings b JOIN members m3 ON m3.id=b.client_member_id AND m3.site_id=b.site_id
             WHERE b.plot_id=p.id AND b.site_id=p.site_id AND lower(COALESCE(b.status,'')) NOT LIKE 'cancel%' ORDER BY b.id DESC LIMIT 1))=m.id)
      ON CONFLICT DO NOTHING`, [e.id,e.created_at,e.account_id,e.plot_id]);
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
      WHERE e.id=$1 AND d.registered_at<=e.created_at`, [delivery.event_id, delivery.token_hash]);
    const row=result.rows[0];
    if (!row) {
      await db.query("UPDATE booking_mobile_push_deliveries SET state='skipped',lease_until=NULL WHERE event_id=$1 AND token_hash=$2", [delivery.event_id,delivery.token_hash]);
      return true;
    }
    try {
      const portfolio = await accountPortfolio(row.device_account_id,row.account_version);
      const plot = portfolio?.details?.find(x => String(x.plot.id) === String(row.plot_id))?.plot;
      let valid = Boolean(plot) && Date.now() - new Date(row.created_at).getTime() < 48*3600*1000;
      if (row.kind === 'installment') {
        const inst = plot?.installments?.find(i => String(i.id) === row.source_id && i.dueDate === String(row.reminder_date).slice(0,10));
        valid = valid && Boolean(inst && inst.balanceAmount > 0 && dayDiff(inst.dueDate,today()) === row.reminder_offset);
      } else if (row.kind !== 'payment_update') {
        const source = row.source === 'plot_payments' ? 'payment' : 'installment';
        valid = valid && Boolean(plot?.payments?.some(p => p.id === `${source}:${row.source_id}` && (row.kind === 'refund' ? p.amount < 0 : p.amount > 0)));
      }
      if (valid) await send({...pushMessage(row.kind),token:row.token});
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
let started = false;
export function startMobilePushWorker(db) {
  if(started || !pushEnabled()) return;
  const messenger=mobileMessaging();
  if (!messenger) {console.error('[mra-push] Enabled without valid Firebase credentials; worker disabled'); return;}
  started=true;
  const worker=createMobilePushWorker(db,{send: message=>messenger.send(message)});
  let lastReminderDay='';
  const tick=async()=>{
    try {
      const date=todayIndia();
      if(lastReminderDay!==date) {
        await db.query(`DELETE FROM booking_mobile_push_devices d USING booking_client_accounts a
          WHERE a.id=d.account_id AND (NOT a.is_active OR a.token_version<>d.account_version)`);
        await db.query("DELETE FROM booking_mobile_push_events WHERE created_at < now()-interval '30 days'");
        await worker.enqueueReminders(); lastReminderDay=date;
      }
      for(let i=0;i<100 && await worker.expandOne();i++);
      for(let i=0;i<100 && await worker.dispatchOne();i++);
    } catch(e) {console.error('[mra-push] Worker error:',e.code||'ERROR');}
    finally {setTimeout(tick,60_000).unref();}
  };
  void tick();
}
