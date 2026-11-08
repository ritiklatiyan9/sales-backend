import 'dotenv/config';
import http from 'node:http';
import { createBrokerOnlyApp } from './brokerOnly.app.js';
import pool, { connectDB } from './config/db.js';
import { validateProductionSecurity } from './security/production.js';
import { migrateBrokerMobilePush } from './migrations/048_broker_mobile_push.js';
import { startBrokerMobilePushWorker } from './services/brokerMobilePush.service.js';

// Keep existing Bookings signing/identity values to preserve credentials,
// saved sessions and private collection references. Never regenerate on migration.
validateProductionSecurity();
const root = process.env.MOBILE_PORTAL_SECRET || process.env.JWT_ACCESS_SECRET;
if (!root || root.length < 32 || (process.env.BROKER_MOBILE_IDENTITY_SECRET !== undefined
    && process.env.BROKER_MOBILE_IDENTITY_SECRET.length < 32)) {
  throw new Error('Broker authentication configuration is incomplete.');
}
const trustProxy = process.env.TRUST_PROXY?.split(',').map(value => value.trim()).filter(Boolean);
const server = http.createServer(createBrokerOnlyApp({ trustProxy }));
server.requestTimeout = 100000;
server.headersTimeout = 15000;
server.keepAliveTimeout = 60000;

try {
  await connectDB();
  await migrateBrokerMobilePush(pool);
  startBrokerMobilePushWorker(pool);
  server.listen(Number(process.env.PORT) || 8001, '0.0.0.0', () => console.log('My Real Partners API ready.'));
} catch {
  console.error('My Real Partners API could not start.');
  await pool.end();
  process.exitCode = 1;
}
