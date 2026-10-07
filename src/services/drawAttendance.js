import pool from '../config/db.js';
import { requireWorkspaceAccess } from './bookingWorkspaceAccess.js';
import { todayIST, validDate, workflowError } from './drawWorkflow.js';

const dateOnly = value => value instanceof Date ? value.toISOString().slice(0,10) : String(value).slice(0,10);
export const ATTENDANCE_MODULE = 'booking_draw_attendance';
export function attendanceDate(value) {
  if (!validDate(value)) throw workflowError('Select a valid draw date');
  return value;
}
export function attendanceToken(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000) throw workflowError('Scan a draw token or enter its slip number');
  const raw = value.trim();
  if (/^https?:\/\//i.test(raw)) {
    let token;
    try { token = new URL(raw).searchParams.get('token'); } catch { /* validation below */ }
    if (!token || token.length > 150) throw workflowError('This QR code is not a draw token');
    return token;
  }
  if (raw.length > 150) throw workflowError('This code is too long');
  return raw;
}

export async function checkInDraw({ user, siteId, date, token, now = new Date() }, db = pool) {
  await requireWorkspaceAccess(user, siteId, ATTENDANCE_MODULE, 'can_write', db);
  attendanceDate(date);
  if (date !== todayIST(now)) throw workflowError('Attendance can only be marked on the draw day (India time)', 409);
  const code = attendanceToken(token);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`SELECT id,slip_no,draw_opening_date,status FROM draw_registrations WHERE site_id=$1 AND (qr_token=$2 OR upper(slip_no)=$3) FOR UPDATE`, [siteId,code,code.toUpperCase()]);
    const draw = rows[0];
    if (!draw) throw workflowError('No issued token matches this site. Check the token and selected project.', 404);
    if (!draw.slip_no || !['SLIP_ISSUED','WINNER','ALLOTTED'].includes(draw.status)) throw workflowError('This token is cancelled or has not been issued',409);
    if (dateOnly(draw.draw_opening_date) !== date) throw workflowError('This token belongs to a different draw date',409);
    const saved = await client.query(`INSERT INTO draw_attendance(draw_registration_id,attendance_date,checked_in_by) VALUES($1,$2,$3)
      ON CONFLICT(draw_registration_id,attendance_date) DO UPDATE SET present=true,checked_in_at=now(),checked_in_by=EXCLUDED.checked_in_by,updated_at=now()
      WHERE draw_attendance.present=false RETURNING *`, [draw.id,date,user.id]);
    const already_present = !saved.rows.length;
    const attendance = saved.rows[0] || (await client.query('SELECT * FROM draw_attendance WHERE draw_registration_id=$1 AND attendance_date=$2',[draw.id,date])).rows[0];
    if (!already_present) await client.query("INSERT INTO draw_attendance_events(attendance_id,action,actor_id) VALUES($1,'CHECKED_IN',$2)", [attendance.id,user.id]);
    const person = (await client.query(`SELECT r.id,r.registration_no,r.slip_no,m.full_name AS client_name,m.phone AS client_phone,m.photo AS client_photo FROM draw_registrations r JOIN members m ON m.id=r.client_member_id WHERE r.id=$1`,[draw.id])).rows[0];
    await client.query('COMMIT');
    return { already_present, attendance, registration:person };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function correctAttendance({ user, siteId, id, reason, now = new Date() }, db = pool) {
  await requireWorkspaceAccess(user, siteId, ATTENDANCE_MODULE, 'can_update', db);
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 300) throw workflowError('Give a correction reason (up to 300 characters)');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(`SELECT a.* FROM draw_attendance a JOIN draw_registrations r ON r.id=a.draw_registration_id WHERE a.id=$1 AND r.site_id=$2 FOR UPDATE OF a`,[id,siteId]);
    const row=found.rows[0];
    if (!row) throw workflowError('Attendance record not found',404);
    if (dateOnly(row.attendance_date)!==todayIST(now)) throw workflowError('Only today’s attendance can be corrected',409);
    if (row.present) {
      await client.query('UPDATE draw_attendance SET present=false,updated_at=now() WHERE id=$1',[id]);
      await client.query("INSERT INTO draw_attendance_events(attendance_id,action,actor_id,reason) VALUES($1,'CORRECTED',$2,$3)",[id,user.id,reason.trim()]);
    }
    await client.query('COMMIT');
    return { corrected:true };
  } catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
