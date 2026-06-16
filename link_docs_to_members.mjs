// One-off: mirror existing booking documents onto their linked accounting members,
// so already-uploaded KYC docs/photos appear on /clients/:id. Idempotent.
import 'dotenv/config';
import pool from './src/config/db.js';
import { getPublicKycUrl } from './src/utils/s3.js';

const TYPE_TO_MEMBER_COL = {
  AADHAAR: 'aadhar_front_url', PAN: 'pan_card_url', PHOTO: 'photo',
  VOTER_ID: 'voter_id_url', PASSPORT: 'passport_url', DL: 'driving_license_url',
  CHEQUE: 'cheque_url', OTHER: 'other_kyc_url',
};

const dryRun = process.argv.includes('--dry');

const { rows } = await pool.query(`
  SELECT d.id, d.type, d.file_path, d.client_member_id, m.full_name
  FROM documents d JOIN members m ON m.id = d.client_member_id
  WHERE d.client_member_id IS NOT NULL AND d.file_path NOT LIKE 'local::%'
  ORDER BY d.id ASC
`);

let updated = 0;
for (const d of rows) {
  const col = TYPE_TO_MEMBER_COL[d.type];
  if (!col) { console.log(`skip doc ${d.id} (type ${d.type} has no member column)`); continue; }
  const url = getPublicKycUrl(d.file_path);
  console.log(`${dryRun ? '[dry] ' : ''}doc ${d.id} ${d.type} -> members.${col} (member ${d.client_member_id} ${d.full_name})`);
  if (!dryRun) {
    await pool.query(`UPDATE members SET ${col} = $1, updated_at = now() WHERE id = $2`, [url, d.client_member_id]);
    updated++;
  }
}
console.log(`\n${dryRun ? 'would update' : 'updated'} ${dryRun ? rows.length : updated} document link(s)`);
await pool.end();
