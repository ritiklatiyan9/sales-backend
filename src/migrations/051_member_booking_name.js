import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

export async function migrateMemberBookingName(db = pool) {
  await db.query('ALTER TABLE members ADD COLUMN IF NOT EXISTS booking_name VARCHAR(255)');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await migrateMemberBookingName();
    console.log('Member Booking Name field ready.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { await pool.end(); }
}
