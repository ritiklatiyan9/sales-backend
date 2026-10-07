import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import pool from '../config/db.js';
import { migrateBookingWorkflow } from '../migrations/021_booking_workflow.js';

/** Isolated PostgreSQL engine; never connects to the configured/live database. */
export async function drawFixture() {
  const db = new PGlite();
  const query = async (sql, values) => {
    const result = await db.query(sql, values);
    for (const row of result.rows)
      for (const key of ['draw_opening_date', 'payment_date', 'booking_date'])
        if (row[key] instanceof Date)
          row[key] = row[key].toISOString().slice(0, 10);
    return result;
  };
  const client = { query, release() {} };
  const original = { query: pool.query, connect: pool.connect };
  pool.query = query;
  pool.connect = async () => client;
  await db.exec(`
    CREATE TABLE sites (id SERIAL PRIMARY KEY, name TEXT, address TEXT, city TEXT, state TEXT);
    CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT, email TEXT, role TEXT, referral_code TEXT, is_active BOOLEAN DEFAULT true, parent_user_id INTEGER, team_id INTEGER, phone TEXT, photo TEXT);
    CREATE TABLE team_members (team_id INTEGER, user_id INTEGER, is_head BOOLEAN);
    CREATE TABLE members (id SERIAL PRIMARY KEY, site_id INTEGER REFERENCES sites, member_type TEXT, status TEXT, full_name TEXT, phone TEXT, photo TEXT, email TEXT, address TEXT, city TEXT, state TEXT, pincode TEXT, father_name TEXT, aadhar_no TEXT, pan_no TEXT, created_by INTEGER, notes TEXT, updated_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE plots (id SERIAL PRIMARY KEY, site_id INTEGER REFERENCES sites, plot_no TEXT, block TEXT, plot_size TEXT, plot_rate NUMERIC, status TEXT, buyer_name TEXT, sale_price NUMERIC(15,2), first_installment NUMERIC(15,2) DEFAULT 0, installments_enabled BOOLEAN DEFAULT FALSE, interest_enabled BOOLEAN DEFAULT FALSE, interest_rate NUMERIC(8,4) DEFAULT 0, interest_type TEXT DEFAULT 'per_month', grace_period_days INTEGER DEFAULT 15, penalty_enabled BOOLEAN DEFAULT FALSE, penalty_rate NUMERIC DEFAULT 0, penalty_type TEXT DEFAULT 'per_day', free_to_sale_days INTEGER DEFAULT 0, booking_by TEXT, booking_date DATE, commission_rate NUMERIC, plot_commission NUMERIC, updated_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE plot_installments (id SERIAL PRIMARY KEY, plot_id INTEGER REFERENCES plots, installment_name VARCHAR(255), amount NUMERIC(15,2) NOT NULL, due_date DATE NOT NULL, status TEXT DEFAULT 'pending', paid_amount NUMERIC(15,2) DEFAULT 0, interest_amount NUMERIC(15,2) DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE plot_payments (id SERIAL PRIMARY KEY, plot_id INTEGER REFERENCES plots, site_id INTEGER, date DATE, payment_from TEXT, payment_type TEXT, bank_details TEXT, bank_name TEXT, branch TEXT, narration TEXT, received_by TEXT, amount NUMERIC(15,2), created_by INTEGER, status TEXT, cheque_no TEXT, cheque_status TEXT, buyer_name TEXT, booked_by TEXT, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
    INSERT INTO sites (name, city, state) VALUES ('Defence Garden','Meerut','Uttar Pradesh'), ('Other project','Meerut','Uttar Pradesh');
    INSERT INTO users (name, email, role) VALUES ('Test Admin','admin@example.test','admin'), ('Test Agent','agent@example.test','agent');
    INSERT INTO plots (site_id,plot_no,block,plot_size,status,sale_price) VALUES (1,'A-01','A','100','AVAILABLE',1000000),(1,'A-02','A','100','AVAILABLE',1100000);
  `);
  for (const file of [
    '001_booking_core',
    '004_booking_agent',
    '006_token_payment_link',
    '008_member_kyc',
    '011_draw_module',
    '013_draw_kyc_link',
    '015_draw_payment_link',
  ]) {
    const source = await readFile(
      new URL(`../migrations/${file}.js`, import.meta.url),
      'utf8',
    );
    for (const match of source.matchAll(
      /await (?:client|pool)\.query\(`([\s\S]*?)`\)/g,
    ))
      await db.exec(match[1]);
  }
  await db.exec(
    'ALTER TABLE bookings ADD COLUMN agent_user_id INTEGER, ADD COLUMN team_id INTEGER',
  );
  const { ensureTable } = await import('../models/ProjectSettings.model.js');
  await ensureTable();
  await migrateBookingWorkflow(pool);
  await migrateBookingWorkflow(pool);
  return {
    db,
    query,
    pool,
    async close() {
      pool.query = original.query;
      pool.connect = original.connect;
      await db.close();
    },
  };
}
