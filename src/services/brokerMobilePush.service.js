import { createHash } from 'node:crypto';
import { createBrokerMobileService } from './brokerMobile.service.js';
import { INSTALLMENT_REMINDER_OFFSETS, REMINDER_SCAN_INTERVAL_MS, mobileMessaging, pushEnabled } from './mobilePush.service.js';

const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
const tokenHash = token => createHash('sha256').update(token).digest('hex');
const validToken = token => typeof token === 'string' && token.length >= 20 && token.length <= 4096 && /^[A-Za-z0-9_:.\-]+$/.test(token);
const registration = session => ({ accountId: session?.account?.id, version: session?.account?.token_version, identity: session?.identity });
const todayIndia = (now = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Kolkata', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(now));
const dayDiff = (date, today) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);

export function createBrokerMobilePushDevices(db, { brokerService = createBrokerMobileService(db) } = {}) {
  return {
    async register(session, body) {
      if (!body || Array.isArray(body) || Object.keys(body).some(k => !['token','platform'].includes(k))
        || !validToken(body.token) || !['android','ios'].includes(body.platform)) fail(400, 'Invalid device registration.');
      const c = await db.connect();
      try {
        await c.query('BEGIN');
        const identity = registration(session);
        // Lock the credential writer boundary, then repeat exact live broker
        // authorization rather than trusting a request's already-read session.
        await c.query('SELECT id FROM booking_broker_mobile_accounts WHERE id=$1 FOR UPDATE', [identity.accountId || 0]);
        await brokerService.getDeviceSession(identity, c);
        await c.query('DELETE FROM booking_broker_push_devices WHERE account_id=$1 AND (account_version<>$2 OR account_identity<>$3)', [identity.accountId,identity.version,identity.identity]);
        const { rows } = await c.query('SELECT count(*)::int AS n FROM booking_broker_push_devices WHERE account_id=$1 AND token_hash<>$2', [identity.accountId,tokenHash(body.token)]);
        if (rows[0].n >= 20) fail(429, 'Too many registered devices.');
        await c.query(`INSERT INTO booking_broker_push_devices(token_hash,token,platform,account_id,account_version,account_identity)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(token_hash) DO UPDATE SET token=excluded.token,platform=excluded.platform,
          registered_at=CASE WHEN (booking_broker_push_devices.account_id,booking_broker_push_devices.account_version,booking_broker_push_devices.account_identity)
            IS DISTINCT FROM (excluded.account_id,excluded.account_version,excluded.account_identity) THEN now() ELSE booking_broker_push_devices.registered_at END,
          account_id=excluded.account_id,account_version=excluded.account_version,account_identity=excluded.account_identity,updated_at=now()`,
        [tokenHash(body.token),body.token,body.platform,identity.accountId,identity.version,identity.identity]);
        await c.query('COMMIT');
      } catch (error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
    },
    async unregister(session, body) {
      if (!body || Array.isArray(body) || Object.keys(body).some(k => k !== 'token') || !validToken(body.token)) fail(400, 'Invalid device registration.');
      const identity = registration(session);
      await brokerService.getDeviceSession(identity);
      await db.query('DELETE FROM booking_broker_push_devices WHERE token_hash=$1 AND account_id=$2 AND account_version=$3 AND account_identity=$4',
        [tokenHash(body.token),identity.accountId,identity.version,identity.identity]);
    },
  };
}

export function brokerInstallmentPushMessage({ now = Date.now() } = {}) {
  const expiresAt = Date.parse(`${todayIndia(now)}T23:59:59+05:30`);
  return {
    notification: { title:'Client installment reminder', body:'A client installment is approaching or due. Open My Real Partners to review the current plan.' },
    // The OS displays the alert while Flutter is closed. No client identity,
    // property reference, financial amount or cached plan is carried by FCM.
    data: { type:'installment' },
    android: {
      priority:'high', restrictedPackageName:'app.myrealassets.broker', ttl:Math.max(0,expiresAt-now), collapseKey:'partner_installment_reminders',
      notification:{ channelId:'partner_installment_reminders', tag:'partner_installment_reminder', priority:'high', sound:'default' },
    },
    apns: { headers:{ 'apns-push-type':'alert','apns-priority':'10','apns-expiration':String(Math.floor(expiresAt/1000)) }, payload:{ aps:{ sound:'default' } } },
  };
}

export function createBrokerMobilePushWorker(db, { send, today = todayIndia, now = Date.now, brokerService = createBrokerMobileService(db, { financeCacheMs:0 }) } = {}) {
  async function accountPortfolio(accountId, version, identity) {
    try {
      const session = await brokerService.getDeviceSession({accountId:Number(accountId),version:Number(version),identity});
      return await brokerService.portfolio(session, {forceFresh:true,remindersOnly:true});
    } catch (error) { if (error.statusCode === 401 || error.statusCode === 403) return null; throw error; }
  }
  async function enqueueReminders() {
    const accounts = await db.query(`SELECT DISTINCT d.account_id,d.account_version,d.account_identity FROM booking_broker_push_devices d
      JOIN booking_broker_mobile_accounts a ON a.id=d.account_id AND a.is_active AND a.token_version=d.account_version`);
    const date = today();
    let failures = 0;
    for (const account of accounts.rows) {
      try {
        const portfolio = await accountPortfolio(account.account_id,account.account_version,account.account_identity);
        for (const client of portfolio?.clients || []) for (const plot of client.plots || []) for (const installment of plot.installments || []) {
          const offset = dayDiff(installment.dueDate,date);
          if (!(installment.balanceAmount > 0 && installment.dueDate && INSTALLMENT_REMINDER_OFFSETS.includes(offset))) continue;
          await db.query(`INSERT INTO booking_broker_push_events(account_id,account_version,account_identity,client_ref,plot_ref,installment_ref,due_date,reminder_day,reminder_offset)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
            ON CONFLICT(account_id,client_ref,plot_ref,installment_ref,reminder_day) DO UPDATE
            SET due_date=excluded.due_date,reminder_offset=excluded.reminder_offset,account_version=excluded.account_version,account_identity=excluded.account_identity,
              expanded_at=CASE WHEN EXISTS(SELECT 1 FROM booking_broker_push_devices d WHERE d.account_id=excluded.account_id
                AND d.account_version=excluded.account_version AND d.account_identity=excluded.account_identity
                AND NOT EXISTS(SELECT 1 FROM booking_broker_push_deliveries delivery WHERE delivery.event_id=booking_broker_push_events.id AND delivery.token_hash=d.token_hash))
                THEN NULL ELSE booking_broker_push_events.expanded_at END`,
          [account.account_id,account.account_version,account.account_identity,client.id,plot.id,installment.id,installment.dueDate,date,offset]);
        }
      } catch { failures++; }
    }
    if (failures) throw new Error('BROKER_REMINDER_SCAN_INCOMPLETE');
  }
  async function expandOne() {
    const {rows} = await db.query(`UPDATE booking_broker_push_events SET lease_until=now()+interval '2 minutes'
      WHERE id=(SELECT id FROM booking_broker_push_events WHERE expanded_at IS NULL AND (lease_until IS NULL OR lease_until<now())
        ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`);
    const event=rows[0]; if(!event) return false;
    await db.query(`INSERT INTO booking_broker_push_deliveries(event_id,token_hash)
      SELECT $1,d.token_hash FROM booking_broker_push_devices d JOIN booking_broker_mobile_accounts a ON a.id=d.account_id
      WHERE d.account_id=$2 AND d.account_version=$3 AND d.account_identity=$4 AND a.is_active AND a.token_version=d.account_version
      ON CONFLICT DO NOTHING`, [event.id,event.account_id,event.account_version,event.account_identity]);
    await db.query('UPDATE booking_broker_push_events SET expanded_at=now(),lease_until=NULL WHERE id=$1',[event.id]);
    return true;
  }
  async function dispatchOne() {
    const {rows} = await db.query(`UPDATE booking_broker_push_deliveries SET lease_until=now()+interval '2 minutes',attempts=attempts+1
      WHERE (event_id,token_hash)=(SELECT event_id,token_hash FROM booking_broker_push_deliveries WHERE state='pending' AND next_attempt<=now()
        AND (lease_until IS NULL OR lease_until<now()) ORDER BY event_id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`);
    const delivery=rows[0]; if(!delivery) return false;
    const result = await db.query(`SELECT e.*,e.due_date::text AS due_date,e.reminder_day::text AS reminder_day,d.token,d.token_hash
      FROM booking_broker_push_events e JOIN booking_broker_push_devices d ON d.token_hash=$2
        AND d.account_id=e.account_id AND d.account_version=e.account_version AND d.account_identity=e.account_identity
      WHERE e.id=$1`, [delivery.event_id,delivery.token_hash]);
    const row=result.rows[0];
    const finish = state => db.query("UPDATE booking_broker_push_deliveries SET state=$3,lease_until=NULL WHERE event_id=$1 AND token_hash=$2", [delivery.event_id,delivery.token_hash,state]);
    if (!row) { await finish('skipped'); return true; }
    try {
      const portfolio = await accountPortfolio(row.account_id,row.account_version,row.account_identity);
      const client = portfolio?.clients?.find(c => c.id === row.client_ref);
      const plot = client?.plots?.find(p => p.id === row.plot_ref);
      const installment = plot?.installments?.find(i => i.id === row.installment_ref && i.dueDate === row.due_date);
      const valid = row.reminder_day === today() && now()-new Date(row.created_at).getTime()<48*3600*1000
        && installment?.balanceAmount > 0 && dayDiff(installment.dueDate,today()) === row.reminder_offset;
      // A token may change accounts while current financial data is loaded.
      // Check its registration again immediately before calling the sender.
      const currentDevice = valid && await db.query(`SELECT 1 FROM booking_broker_push_devices d
        JOIN booking_broker_mobile_accounts a ON a.id=d.account_id AND a.is_active AND a.token_version=d.account_version
        WHERE d.token_hash=$1 AND d.account_id=$2 AND d.account_version=$3 AND d.account_identity=$4`,
      [row.token_hash,row.account_id,row.account_version,row.account_identity]);
      if (valid && currentDevice.rows.length) {
        await brokerService.getDeviceSession({accountId:Number(row.account_id),version:Number(row.account_version),identity:row.account_identity});
        await send({...brokerInstallmentPushMessage({now:now()}),token:row.token});
        await finish('sent');
      } else await finish('skipped');
    } catch (error) {
      if ([401,403].includes(error.statusCode)) {
        await finish('skipped');
      } else if (['messaging/registration-token-not-registered','messaging/invalid-registration-token','messaging/mismatched-credential','messaging/mismatched-package-name','messaging/invalid-package-name'].includes(error.code)) {
        await db.query('DELETE FROM booking_broker_push_devices WHERE token_hash=$1 AND account_id=$2 AND account_version=$3 AND account_identity=$4',
          [row.token_hash,row.account_id,row.account_version,row.account_identity]);
      } else {
        await db.query(`UPDATE booking_broker_push_deliveries SET state=CASE WHEN attempts>=8 THEN 'failed' ELSE 'pending' END,
          lease_until=NULL,next_attempt=now()+interval '5 minutes' WHERE event_id=$1 AND token_hash=$2`, [row.id,row.token_hash]);
        console.error('[partner-push] Delivery deferred:',error.code || 'ERROR');
      }
    }
    return true;
  }
  return {enqueueReminders,expandOne,dispatchOne};
}

export function createBrokerMobilePushCycle(db, worker, {now=Date.now,today=todayIndia}={}) {
  let lastCleanupDay='',lastReminderDay='',lastReminderScan=Number.NEGATIVE_INFINITY;
  return async () => {
    const date=today(); let scanError;
    if (lastCleanupDay!==date) {
      await db.query(`DELETE FROM booking_broker_push_devices d USING booking_broker_mobile_accounts a
        WHERE a.id=d.account_id AND (NOT a.is_active OR a.token_version<>d.account_version)`);
      await db.query("DELETE FROM booking_broker_push_events WHERE created_at<now()-interval '30 days'");
      lastCleanupDay=date;
    }
    if (lastReminderDay!==date || now()-lastReminderScan>=REMINDER_SCAN_INTERVAL_MS) {
      try { await worker.enqueueReminders(); lastReminderDay=date; lastReminderScan=now(); } catch(error) { scanError=error; }
    }
    for(let i=0;i<100 && await worker.expandOne();i++);
    for(let i=0;i<100 && await worker.dispatchOne();i++);
    if(scanError) throw scanError;
  };
}

let started=false;
export function startBrokerMobilePushWorker(db) {
  if(started || !pushEnabled()) return;
  const messaging=mobileMessaging();
  if(!messaging) { console.error('[partner-push] Enabled without valid Firebase credentials; worker disabled'); return; }
  started=true;
  const worker=createBrokerMobilePushWorker(db,{send:message=>messaging.send(message)});
  const cycle=createBrokerMobilePushCycle(db,worker);
  const tick=async()=>{
    try { await cycle(); } catch(error) { console.error('[partner-push] Worker error:',error.code || 'ERROR'); }
    finally { setTimeout(tick,60_000).unref(); }
  };
  void tick();
}
