import 'dotenv/config';
import pkg from 'pg';
const { Pool } = pkg;

// Mirrors the accounting backend's db config so booking-api binds to the SAME database.
const sslOption = process.env.DB_SSL === 'true' || (process.env.DB_HOST && process.env.DB_HOST.includes('neon'))
  ? { rejectUnauthorized: false }
  : false;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : undefined,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD != null ? String(process.env.DB_PASSWORD) : '',
  ssl: sslOption,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

export const connectDB = async () => {
  const client = await pool.connect();
  console.log('[booking-api] Connected to PostgreSQL');
  client.release();
};

export default pool;
