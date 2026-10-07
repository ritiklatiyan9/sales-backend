import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';
import { ensureBookingCreditFields } from '../services/bookingDrawCredits.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await ensureBookingCreditFields(); console.log('Booking first installment field ready.'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { await pool.end(); }
}
