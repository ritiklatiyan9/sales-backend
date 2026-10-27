import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// Optional, additive production optimization. CONCURRENTLY avoids blocking
// ongoing booking writes. Run separately; neither app startup nor read routes
// create schema objects or silently mutate the shared Accounts database.
export const BROKER_MOBILE_INDEX_SQL = `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bookings_mobile_current_plot
  ON bookings (plot_id,site_id,id DESC) INCLUDE (client_member_id,booking_agent_id,agent_user_id,status)`;
export async function migrateBrokerMobileIndexes(db=pool) {
  await db.query(BROKER_MOBILE_INDEX_SQL);
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  migrateBrokerMobileIndexes().then(()=>console.log('Broker mobile current-plot index ready.'))
    .catch(error=>{console.error('Broker mobile index creation failed:',error.message);process.exitCode=1;})
    .finally(()=>pool.end());
}
