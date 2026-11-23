import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

export async function migrateDrawBookingBin(db = pool) {
  const { rows } = await db.query(`
    WITH candidates AS (
      SELECT r.id, r.status, b.id AS booking_id, b.updated_at AS cancelled_at, NULL::integer AS actor_user_id
        FROM draw_registrations r
        JOIN bookings b ON b.id = r.booking_id AND b.site_id = r.site_id
       WHERE r.status = 'ALLOTTED' AND b.status = 'CANCELLED'
      UNION ALL
      SELECT r.id, r.status, b.id, event.created_at, event.actor_user_id
        FROM draw_registrations r
        CROSS JOIN LATERAL (
          SELECT event_type, detail, created_at, actor_user_id
            FROM draw_events
           WHERE draw_registration_id = r.id
           ORDER BY created_at DESC, id DESC LIMIT 1
        ) event
        JOIN bookings b ON b.id::text = event.detail->>'booking_id'
                      AND b.site_id = r.site_id AND b.client_member_id = r.client_member_id
       WHERE r.status = 'WINNER' AND r.booking_id IS NULL AND r.allotted_plot_id IS NULL
         AND event.event_type = 'ALLOTMENT_REVERTED' AND b.status = 'CANCELLED'
    ), archived AS (
      UPDATE draw_registrations r
         SET status = 'CANCELLED', booking_id = c.booking_id,
             allotted_plot_id = NULL, allotted_at = NULL, allotted_by = NULL,
             updated_at = GREATEST(r.updated_at, c.cancelled_at)
        FROM candidates c
       WHERE r.id = c.id AND r.status = c.status
         AND (r.booking_id IS NULL OR r.booking_id = c.booking_id)
       RETURNING r.id, r.booking_id, c.cancelled_at, c.actor_user_id
    )
    INSERT INTO draw_events (draw_registration_id, event_type, detail, actor_user_id, created_at)
    SELECT id, 'CANCELLED', jsonb_build_object('booking_id', booking_id), actor_user_id, cancelled_at FROM archived
    RETURNING draw_registration_id`);
  return rows.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const archived = await migrateDrawBookingBin();
    console.log(`Moved ${archived} previously cancelled draw bookings to Booking Bin.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
