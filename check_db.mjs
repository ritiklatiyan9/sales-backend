// Read-only DB inspector: proves accounting tables are untouched and lists booking tables.
import 'dotenv/config';
import pool from './src/config/db.js';

const q = async (sql) => (await pool.query(sql)).rows;

const main = async () => {
  const accounting = ['members', 'plots', 'plot_payments', 'sites', 'users'];
  console.log('── Accounting table row counts (must not change) ──');
  for (const t of accounting) {
    try {
      const [{ c }] = await q(`SELECT count(*)::int AS c FROM ${t}`);
      console.log(`  ${t.padEnd(16)} ${c}`);
    } catch (e) { console.log(`  ${t.padEnd(16)} ERROR: ${e.message}`); }
  }

  console.log('\n── Booking module tables ──');
  const booking = ['bookings', 'kyc_cases', 'documents', 'ocr_results'];
  for (const t of booking) {
    const reg = await q(`SELECT to_regclass('public.${t}') AS r`);
    if (!reg[0].r) { console.log(`  ${t.padEnd(16)} (not created yet)`); continue; }
    const [{ c }] = await q(`SELECT count(*)::int AS c FROM ${t}`);
    console.log(`  ${t.padEnd(16)} exists, rows=${c}`);
  }
  await pool.end();
};

main().catch((e) => { console.error(e); process.exit(1); });
