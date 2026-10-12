import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';
import { createRazorpayGateway } from '../services/websiteRazorpay.js';

// Apply the requested token using existing website tables, preserving terms,
// hold duration and every existing payment's snapshotted amount.
export async function configureOmWebsiteToken(db, { siteId, paymentReady }) {
  if (Number(siteId)!==5) throw new Error('WEBSITE_SITE_ID must be 5 for OM ASSOCIATES.');
  if (!paymentReady) throw new Error('Configure Razorpay server credentials first.');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: sites } = await client.query('SELECT id,name FROM sites WHERE id=$1 FOR UPDATE',[5]);
    if (sites[0]?.name?.trim().toUpperCase()!=='OM ASSOCIATES') throw new Error('Site 5 is not OM ASSOCIATES; no settings were changed.');
    const { rows } = await client.query(`INSERT INTO website_booking_settings(site_id,booking_amount,booking_enabled,status_display_enabled)
      VALUES($1,101,true,true) ON CONFLICT(site_id) DO UPDATE
      SET booking_amount=101,booking_enabled=true,status_display_enabled=true,updated_at=now()
      RETURNING site_id,booking_amount,booking_enabled,status_display_enabled`,[5]);
    await client.query(`INSERT INTO website_booking_events(event_type,detail) VALUES('SETTINGS_UPDATED',$1)`,[
      JSON.stringify({site_id:5,booking_amount:101,booking_enabled:true,status_display_enabled:true,source:'configure_website_token'}),
    ]);
    await client.query('COMMIT');
    return rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  configureOmWebsiteToken(pool,{siteId:process.env.WEBSITE_SITE_ID,paymentReady:createRazorpayGateway().ready})
    .then(settings=>console.log('OM ASSOCIATES website token configured:',JSON.stringify(settings)))
    .catch(error=>{console.error('Token setup failed:',error.code || error.message);process.exitCode=1;})
    .finally(()=>pool.end());
}
