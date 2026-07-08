import pool from '../config/db.js';

/**
 * Per-site Company + Payment details shown on the printable booking form
 * ("Project Details" module). 100% additive: a NEW table only, FK to sites uses
 * ON DELETE CASCADE so it can never affect accounting data. The table is created
 * lazily (CREATE TABLE IF NOT EXISTS) so the feature works even before the
 * dedicated migration is run.
 */
const ENSURE_SQL = `
  CREATE TABLE IF NOT EXISTS project_settings (
    id                  SERIAL PRIMARY KEY,
    site_id             INTEGER UNIQUE REFERENCES sites(id) ON DELETE CASCADE,
    company_legal_name  VARCHAR(255),
    company_brand_name  VARCHAR(255),
    company_address     TEXT,
    company_city        VARCHAR(160),
    company_phone       VARCHAR(60),
    company_email       VARCHAR(160),
    company_gstin       VARCHAR(40),
    company_website     VARCHAR(160),
    payable_to          VARCHAR(160),
    logo_url            VARCHAR(500),
    bank_name           VARCHAR(160),
    bank_account_no     VARCHAR(60),
    bank_ifsc           VARCHAR(40),
    bank_branch         VARCHAR(160),
    payment_terms       TEXT,
    milestones          JSONB DEFAULT '[]'::jsonb,
    draw_required_amount NUMERIC(15,2),
    draw_scheme_name    VARCHAR(150),
    created_at          TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at          TIMESTAMP WITH TIME ZONE DEFAULT now()
  )
`;

const FIELDS = [
  'company_legal_name', 'company_brand_name', 'company_address', 'company_city',
  'company_phone', 'company_email', 'company_gstin', 'company_website', 'payable_to',
  'logo_url', 'bank_name', 'bank_account_no', 'bank_ifsc', 'bank_branch',
  'payment_terms', 'milestones',
];

let ensured = false;
async function ensure() {
  if (ensured) return;
  await pool.query(ENSURE_SQL);
  ensured = true;
}

export async function ensureTable() {
  await ensure();
}

export async function getBySite(siteId) {
  await ensure();
  const { rows } = await pool.query('SELECT * FROM project_settings WHERE site_id = $1', [siteId]);
  return rows[0] || null;
}

/**
 * Draw Settings — the per-site draw money DECIDED BY Admin/Super Admin. Deliberately
 * NOT in FIELDS: the general PUT /project-settings endpoint is not role-gated, so the
 * draw amount is only writable through the decider-gated PUT /draws/settings.
 * Lazy ALTER keeps the same works-before-migration behaviour as the table itself.
 */
let drawEnsured = false;
async function ensureDraw() {
  if (drawEnsured) return;
  await ensure();
  await pool.query(`
    ALTER TABLE project_settings
      ADD COLUMN IF NOT EXISTS draw_required_amount NUMERIC(15,2),
      ADD COLUMN IF NOT EXISTS draw_scheme_name VARCHAR(150)
  `);
  drawEnsured = true;
}

export async function getDrawSettings(siteId) {
  await ensureDraw();
  const { rows } = await pool.query(
    'SELECT site_id, draw_required_amount, draw_scheme_name, updated_at FROM project_settings WHERE site_id = $1',
    [siteId]
  );
  return rows[0] || null;
}

export async function upsertDrawSettings(siteId, { required_amount, scheme_name }) {
  await ensureDraw();
  const { rows } = await pool.query(
    `INSERT INTO project_settings (site_id, draw_required_amount, draw_scheme_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (site_id) DO UPDATE
       SET draw_required_amount = EXCLUDED.draw_required_amount,
           draw_scheme_name = EXCLUDED.draw_scheme_name,
           updated_at = now()
     RETURNING site_id, draw_required_amount, draw_scheme_name, updated_at`,
    [siteId, required_amount, scheme_name ?? null]
  );
  return rows[0];
}

export async function upsertBySite(siteId, data) {
  await ensure();
  const cols = ['site_id'];
  const vals = [siteId];
  for (const f of FIELDS) {
    if (data[f] === undefined) continue;
    cols.push(f);
    if (f === 'milestones') vals.push(JSON.stringify(Array.isArray(data[f]) ? data[f] : []));
    else vals.push(data[f] === '' ? null : data[f]);
  }
  const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
  const updates = cols.filter((c) => c !== 'site_id').map((c) => `${c} = EXCLUDED.${c}`).join(', ');
  const sql = `
    INSERT INTO project_settings (${cols.join(', ')}) VALUES (${placeholders})
    ON CONFLICT (site_id) DO UPDATE SET ${updates ? `${updates}, ` : ''}updated_at = now()
    RETURNING *
  `;
  const { rows } = await pool.query(sql, vals);
  return rows[0];
}
