import {pathToFileURL} from 'node:url';
import pool from '../config/db.js';
export async function migrateMemberCodeReferrals(db=pool) {
  await db.query('ALTER TABLE members ADD COLUMN IF NOT EXISTS referred_by_member_id INTEGER REFERENCES members(id) ON DELETE RESTRICT');
  await db.query('ALTER TABLE members ADD COLUMN IF NOT EXISTS referred_by_member_code VARCHAR(40)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_members_referring_member ON members(referred_by_member_id)');
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {await migrateMemberCodeReferrals();console.log('Member code referrals ready');}
  catch(e){console.error(e.message);process.exitCode=1;}
  finally{await pool.end();}
}
