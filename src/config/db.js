import 'dotenv/config';
import pkg from 'pg';
const { Pool, types } = pkg;

// DATE columns (OID 1082, e.g. date_of_birth, co_applicant_dob, issue_date) default to
// a JS Date parsed at LOCAL midnight; serializing that via res.json() converts to UTC,
// which rolls the date back a day whenever the server runs ahead of UTC (IST, UTC+5:30
// — this app's timezone). Keep the raw 'YYYY-MM-DD' string instead: every consumer
// already expects that shape (e.g. `String(value).slice(0, 10)` on the frontend).
types.setTypeParser(1082, (v) => v);

// Mirrors the accounting backend's db config so booking-api binds to the SAME database.
const sslOption = process.env.DB_SSL === 'true' || (process.env.DB_HOST && process.env.DB_HOST.includes('neon'))
  ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false', ...(process.env.DB_SSL_CA ? { ca: process.env.DB_SSL_CA.replace(/\\n/g, '\n') } : {}) }
  : false;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : undefined,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD != null ? String(process.env.DB_PASSWORD) : '',
  ssl: sslOption,
  max: 10,
  // Reconnecting through the Neon pooler costs 2–12 s; keep idle connections for 5 min
  // (e.g. while staff photograph a document) instead of dropping them after 30 s.
  idleTimeoutMillis: 5 * 60_000,
  connectionTimeoutMillis: 10000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  application_name: `booking-api${process.env.NODE_ENV === 'production' ? '' : '-dev'}`,
});

// Idle TLS disconnects are recoverable: pg discards that connection and opens
// another on demand. An unhandled pool event would crash the whole booking API.
pool.on('error', (error) => {
  console.error('[booking-api] Database connection interrupted:', error.code || 'CONNECTION_ERROR');
});

export const connectDB = async () => {
  const client = await pool.connect();
  console.log('[booking-api] Connected to PostgreSQL');
  client.release();
};

// Lock-free catalog read. `ADD COLUMN IF NOT EXISTS` takes ACCESS EXCLUSIVE even when the
// column exists, so callers run their idempotent DDL only when this returns false.
// Names resolve through search_path exactly like the DDL they guard.
export const schemaHas = async ({ relations = [], columns = [] }, db = pool) => {
  const { rows: [row] } = await db.query(`SELECT
      (SELECT count(*) FROM unnest($1::text[]) r WHERE to_regclass(r) IS NOT NULL)
    + (SELECT count(*) FROM unnest($2::text[], $3::text[]) c(rel, col)
        WHERE EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass(c.rel) AND a.attname = c.col AND a.attnum > 0 AND NOT a.attisdropped)) AS n`,
  [relations, columns.map(([rel]) => rel), columns.map(([, col]) => col)]);
  return Number(row.n) === relations.length + columns.length;
};

// Every object boot migrations 051, 047 and 048 create; server.js runs them only when one is missing.
// ponytail: hand-kept list; a boot migration added to server.js must add its objects here (db.test.mjs drops each one).
export const bootSchemaReady = (db = pool) => schemaHas({
  relations: ['login_otps', 'booking_broker_push_devices', 'booking_broker_push_events', 'booking_broker_push_deliveries',
    'booking_broker_push_devices_account_idx', 'booking_broker_push_event_pending_idx', 'booking_broker_push_delivery_pending_idx'],
  columns: [['members', 'booking_name'], ['users', 'can_login_accounts'], ['users', 'can_login_booking'],
    ['users', 'can_login_booking_accounts'], ['login_otps', 'app_context']],
}, db);

export default pool;
