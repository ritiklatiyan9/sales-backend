import 'dotenv/config';
import http from 'http';
import app from './app.js';
import pool, { bootSchemaReady, connectDB } from './config/db.js';
import { initSocket } from './config/socket.js';
import { recoverOcrQueue } from './queue/ocrQueue.js';
import { validateProductionSecurity } from './security/production.js';
import { startWhatsAppWorker } from './services/whatsapp.service.js';
import { startMobilePushWorker } from './services/mobilePush.service.js';
import { startBrokerMobilePushWorker } from './services/brokerMobilePush.service.js';
import { migrateBookingAccountsLoginAccess } from './migrations/047_booking_accounts_login_access.js';
import { migrateBrokerMobilePush } from './migrations/048_broker_mobile_push.js';
import { migrateMemberBookingName } from './migrations/051_member_booking_name.js';

validateProductionSecurity();

const PORT = process.env.PORT || 8001;
const server = http.createServer(app);
// Same values as brokerOnly.server.js (Render advises raising Node's 5 s keep-alive default).
server.headersTimeout = 15000;
server.keepAliveTimeout = 60000;

const io = initSocket(server);   // socket.io (OCR events emitted in-process; no Redis relay)
const uptimeMs = () => Math.round(process.uptime() * 1000);

async function start() {
  console.log(`[booking-api] boot start ${uptimeMs()} ms`);
  try {
    await connectDB();
    // One lock-free catalog read; the DDL (ACCESS EXCLUSIVE on shared users/members) runs only when something is missing.
    if (!(await bootSchemaReady(pool))) {
      await migrateMemberBookingName(pool);
      await migrateBookingAccountsLoginAccess(pool);
      await migrateBrokerMobilePush(pool);
    }
    console.log(`[booking-api] migrations checked ${uptimeMs()} ms`);
  } catch (err) {
    console.error('[booking-api] Failed to connect to DB:', err.code || 'CONNECTION_ERROR');
    // A temporary network failure must not leave the local integration stopped.
    setTimeout(start, 5000);
    return;
  }
  server.listen(PORT, () => console.log(`[booking-api] running on port ${PORT} (${uptimeMs()} ms)`));
  // After listen these only log: the retry above would call server.listen a second time.
  await recoverOcrQueue(pool).catch(err => console.error('[booking-api] OCR queue recovery failed:', err.code || 'ERROR'));
  try {
    startWhatsAppWorker();
    startMobilePushWorker(pool);
    startBrokerMobilePushWorker(pool);
  } catch (err) {
    console.error('[booking-api] Worker start failed:', err.code || 'ERROR');
  }
}
void start();

// Render sends SIGTERM on deploy/spin-down (30 s grace). io.close() drops the websockets, then runs
// server.close(): stop accepting, let in-flight requests finish, then release the pool and exit.
// nodemon restarts send SIGUSR2 and Ctrl-C sends SIGINT, so neither waits on this.
process.once('SIGTERM', () => {
  setTimeout(() => process.exit(0), 20_000).unref(); // ponytail: requests still running after 20 s are cut (Render kills at 30 s anyway)
  setInterval(() => server.closeIdleConnections(), 500).unref(); // keep-alive sockets close once their response ends
  io.close(() => pool.end().finally(() => process.exit(0)));
});
