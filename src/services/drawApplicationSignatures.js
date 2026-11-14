import sharp from 'sharp';
import { migrateApplicationFormVersions } from '../migrations/052_application_form_versions.js';
import { applicationSigningContext } from './applicationFormSnapshot.js';
import pool from '../config/db.js';
import drawModel from '../models/Draw.model.js';
import { migrateDrawApplicationSignatures } from '../migrations/050_draw_application_signatures.js';
import { requireSiteAccess } from './bookingWorkspaceAccess.js';
import { workflowError } from './drawWorkflow.js';

// Key by the query function so isolated databases do not inherit schema state.
const schemaReady = new WeakMap();
export async function ensureDrawApplicationSignatures(db = pool) {
  let pending = schemaReady.get(db.query);
  if (!pending) {
    pending = migrateDrawApplicationSignatures(db).then(()=>migrateApplicationFormVersions(db)).catch(error => {
      schemaReady.delete(db.query);
      throw error;
    });
    schemaReady.set(db.query, pending);
  }
  await pending;
}

export async function getDrawApplicationSignatures(id, db = pool) {
  await ensureDrawApplicationSignatures(db);
  const { rows } = await db.query(
    'SELECT applicant, authority, signed_by, signed_at, form_snapshot, form_hash FROM draw_application_signatures WHERE draw_registration_id = $1', [id],
  );
  return rows[0] || null;
}

/** Decode before storing; reject blank canvases and unrelated/oversized uploads. */
export async function normalizeApplicationSignature(value, label) {
  if (typeof value !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw workflowError(`${label} signature must be a PNG drawing`);
  }
  if (value.length > 700_000) throw workflowError(`${label} signature is too large`, 413);
  const bytes = Buffer.from(value.slice('data:image/png;base64,'.length), 'base64');
  if (bytes.length < 8 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw workflowError(`${label} signature must be a valid PNG drawing`);
  }
  try {
    const image = sharp(bytes, { limitInputPixels: 4_000_000 });
    const metadata = await image.metadata();
    if (metadata.format !== 'png' || metadata.pages > 1 || !metadata.width || !metadata.height
      || metadata.width > 2400 || metadata.height > 1600) {
      throw workflowError(`${label} signature dimensions are too large`);
    }
    const { data } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let inkPixels = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 16 && Math.min(data[i], data[i + 1], data[i + 2]) < 245) inkPixels++;
      if (inkPixels >= 8) break;
    }
    if (inkPixels < 8) throw workflowError(`${label} signature is empty. Draw your signature before saving.`);
    // Re-encoding strips attached metadata; only a raster PNG is persisted.
    const png = await sharp(bytes, { limitInputPixels: 4_000_000 }).png().toBuffer();
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch (error) {
    if (error.status) throw error;
    throw workflowError(`${label} signature could not be read. Draw it again and retry.`);
  }
}

export async function saveDrawApplicationSignatures({ id, user, body, visibleUserIds, db = pool }) {
  if (!Number.isInteger(Number(id)) || Number(id) <= 0) throw workflowError('Select a valid registration');
  await ensureDrawApplicationSignatures(db);
  const client = await db.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const { rows } = await client.query('SELECT * FROM draw_registrations WHERE id = $1 FOR UPDATE', [id]);
    const draw = rows[0];
    if (!draw) throw workflowError('Draw registration not found', 404);
    await requireSiteAccess(user, draw.site_id, client);
    if (visibleUserIds && !visibleUserIds.includes(draw.agent_user_id) && !visibleUserIds.includes(draw.created_by)) {
      throw workflowError('You are not authorised to sign this draw registration', 403);
    }
    if (draw.status === 'CANCELLED') throw workflowError('A cancelled registration cannot be signed', 409);
    if (!draw.slip_no || !draw.terms_snapshot) throw workflowError('Issue the booking application before collecting signatures', 409);
    const context = await applicationSigningContext({id,user,visibleUserIds,db:client});
    if (body?.context_hash !== context.context_hash) throw workflowError('The application changed. Reopen the signature form, review it and sign again.',409);
    const [applicant, authority] = await Promise.all([
      normalizeApplicationSignature(body?.applicant, 'Applicant'),
      normalizeApplicationSignature(body?.authority, 'Authorized signatory'),
    ]);
    const saved = await client.query(`INSERT INTO draw_application_signatures
      (draw_registration_id, applicant, authority, signed_by, signed_at, form_snapshot, form_hash)
      VALUES ($1, $2, $3, $4, now(), $5, $6)
      ON CONFLICT (draw_registration_id) DO UPDATE SET applicant = EXCLUDED.applicant,
        authority = EXCLUDED.authority, signed_by = EXCLUDED.signed_by, signed_at = now(), form_snapshot=EXCLUDED.form_snapshot, form_hash=EXCLUDED.form_hash
      RETURNING applicant, authority, signed_by, signed_at, form_snapshot, form_hash`, [id, applicant, authority, user.id, JSON.stringify(context.snapshot), context.context_hash]);
    const version=await client.query(`INSERT INTO draw_application_signature_versions(draw_registration_id,applicant,authority,signed_by,signed_at,form_snapshot,form_hash) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,[id,applicant,authority,user.id,saved.rows[0].signed_at,JSON.stringify(context.snapshot),context.context_hash]);
    await drawModel.logEvent(Number(id), 'APPLICATION_SIGNED', { fields: ['applicant', 'authority'], form_hash:context.context_hash, version_id:version.rows[0].id }, user.id, client);
    await client.query('COMMIT');
    return saved.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
