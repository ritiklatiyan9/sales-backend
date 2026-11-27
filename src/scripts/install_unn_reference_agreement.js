// Install the reviewed PDF on the existing Naya Baazar default format.
// Keep the bilingual text as a fallback for clients that only support HTML.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pool from '../config/db.js';
import { validateAgreementTemplate } from '../services/agreementTemplate.js';
import { presetOf, escapeHtml } from '../../../sales-dg-frontend/src/lib/agreementStudio.js';
import { UNN_REFERENCE_ID, UNN_REFERENCE_NAME } from '../../../sales-dg-frontend/src/lib/unnAgreementReference.js';

const path = fileURLToPath(new URL('../../../sales-dg-frontend/public/agreements/unn/allotment-agreement-v1.pdf', import.meta.url));
const digest = '5beebf6bf557f9f70ff6fcbd9a581bbb2c37ecdb9f40acf3566909436bdcc1f7';
let client;
try {
  const bytes = await readFile(path);
  if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('The source PDF has changed.');
  const pages = execFileSync('pdftotext', ['-layout', '-enc', 'UTF-8', path, '-'], { encoding: 'utf8' }).split('\f').map(p => p.trim()).filter(Boolean);
  if (pages.length !== 15) throw new Error('Expected 15 pages.');
  const body = pages.map(page => '<p>' + page.split('\n').map(line => escapeHtml(line.trim())).join('<br>') + '</p>').join('<hr class="page-break">');
  const template = validateAgreementTemplate({
    name: UNN_REFERENCE_NAME, preset: 'blank', body,
    design: { ...presetOf('blank').design, header_style: 'none', border: 'none', page_numbers: false, reference_pdf: UNN_REFERENCE_ID },
  });
  client = await pool.connect();
  await client.query('BEGIN');
  const { rows: [record] } = await client.query(
    'SELECT t.*, s.name AS site_name FROM agreement_templates t JOIN sites s ON s.id=t.site_id WHERE t.id=2 AND t.site_id=7 FOR UPDATE OF t'
  );
  if (record?.site_name !== 'Naya Baazar Unn Commercial' || !record.is_default) throw new Error('The selected format is no longer the Naya Baazar default.');
  if (record.design.reference_pdf === UNN_REFERENCE_ID) {
    console.log('The reference PDF is already installed.');
  } else {
    if (record.revision !== 5 || record.name !== 'Unn Commercial — Booking & Allotment Agreement') throw new Error('The previously reviewed format changed.');
    const backup = join(await mkdtemp(join(tmpdir(), 'unn-agreement-before-')), 'format.json');
    await writeFile(backup, JSON.stringify(record), { mode: 0o600 });
    const saved = await client.query(
      'UPDATE agreement_templates SET name=$1,design=$2,body=$3,revision=revision+1,updated_at=NOW() WHERE id=$4 AND site_id=$5 AND revision=$6 RETURNING id,site_id,name,revision,is_default',
      [template.name, template.design, template.body, record.id, record.site_id, record.revision]
    );
    if (saved.rowCount !== 1) throw new Error('The template revision changed.');
    console.log(JSON.stringify({ ...saved.rows[0], backup }));
  }
  await client.query('COMMIT');
} catch (error) {
  if (client) await client.query('ROLLBACK');
  console.error(error.message);
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}
