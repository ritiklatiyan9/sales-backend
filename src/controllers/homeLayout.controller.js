import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';

// The launcher screen's own data — an ordered array of icon tiles and folder tiles.
// Shape is UI-owned (icons/folders/positions), so we only guard size/type here, not
// the internal structure.
const MAX_LAYOUT_BYTES = 200_000;

/** GET /home-layout — this user's saved launcher layout, or null if never customised. */
export const getLayout = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT layout, updated_at FROM user_home_layouts WHERE user_id = $1',
    [req.user.id]
  );
  res.json({ layout: rows[0]?.layout ?? null, updated_at: rows[0]?.updated_at ?? null });
});

/** PUT /home-layout — replace this user's launcher layout. Body: { layout: [...] } */
export const saveLayout = asyncHandler(async (req, res) => {
  const { layout } = req.body || {};
  if (!Array.isArray(layout)) {
    return res.status(400).json({ message: 'layout must be an array' });
  }
  const json = JSON.stringify(layout);
  if (json.length > MAX_LAYOUT_BYTES) {
    return res.status(400).json({ message: 'Layout is too large' });
  }

  await pool.query(
    `INSERT INTO user_home_layouts (user_id, layout, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (user_id) DO UPDATE SET layout = $2::jsonb, updated_at = now()`,
    [req.user.id, json]
  );
  res.json({ message: 'Layout saved' });
});
