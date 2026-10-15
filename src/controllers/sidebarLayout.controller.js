import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { DEFAULT_SIDEBAR_LAYOUT, canManageSidebar, validateSidebarLayout } from '../services/sidebarLayout.js';

const response = (row, user) => ({ scope:'global', layout:row?.layout || DEFAULT_SIDEBAR_LAYOUT,
  revision:row?.revision ?? 0, updated_at:row?.updated_at || null, can_edit:canManageSidebar(user) });

export const getSidebarLayout = asyncHandler(async (req,res) => {
  const { rows } = await pool.query('SELECT layout,revision,updated_at FROM booking_sidebar_layout WHERE id=1');
  res.set('Cache-Control','private, no-store');
  res.json(response(rows[0],req.user));
});

export const saveSidebarLayout = asyncHandler(async (req,res) => {
  if (!canManageSidebar(req.user)) return res.status(403).json({ message:'Only Admin and Super Admin can arrange the sidebar for everyone.' });
  const body = req.body || {};
  if (Object.keys(body).some(key => !['layout','revision'].includes(key)) || !Number.isSafeInteger(body.revision) || body.revision < 0) {
    return res.status(400).json({ message:'Send the shared sidebar layout and its current revision.' });
  }
  const layout = validateSidebarLayout(body.layout);
  const { rows } = await pool.query(`UPDATE booking_sidebar_layout SET layout=$1::jsonb,revision=revision+1,
    updated_by=$2,updated_at=now() WHERE id=1 AND revision=$3 RETURNING layout,revision,updated_at`,
  [JSON.stringify(layout),req.user.id,body.revision]);
  if (!rows[0]) return res.status(409).json({ code:'SIDEBAR_LAYOUT_CONFLICT', message:'Another administrator changed the menu. Load the latest order before saving.' });
  res.set('Cache-Control','private, no-store');
  res.json(response(rows[0],req.user));
});
