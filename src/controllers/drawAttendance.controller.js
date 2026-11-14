import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { requireWorkspaceAccess } from '../services/bookingWorkspaceAccess.js';
import { ATTENDANCE_MODULE, ISSUED_TOKEN, attendanceDate, checkInDraw, correctAttendance, setAttendance } from '../services/drawAttendance.js';
import { todayIST, workflowError } from '../services/drawWorkflow.js';

export const listDrawAttendance = asyncHandler(async (req,res) => {
  const site = await requireWorkspaceAccess(req.user,req.query.site_id,ATTENDANCE_MODULE);
  const date = attendanceDate(req.query.date || todayIST());
  const status = req.query.status || 'all';
  if (!['all','present','remaining'].includes(status)) throw workflowError('Choose all, present or remaining');
  const page = Math.max(1,parseInt(req.query.page,10)||1);
  // ponytail: register loads a whole draw date in one page; paginate the register if a date ever passes 1000 tokens.
  const limit = Math.min(1000,Math.max(1,parseInt(req.query.limit,10)||50));
  const order = req.query.sort === 'name' ? 'm.full_name,r.slip_no,r.id' : 'COALESCE(a.present,false) DESC,a.checked_in_at DESC NULLS LAST,m.full_name,r.id';
  const search = String(req.query.q || '').trim().slice(0,150);
  const base = `FROM draw_registrations r JOIN members m ON m.id=r.client_member_id
    LEFT JOIN draw_attendance a ON a.draw_registration_id=r.id AND a.attendance_date=$2 LEFT JOIN users u ON u.id=a.checked_in_by
    WHERE r.site_id=$1 AND r.draw_opening_date=$2 AND ${ISSUED_TOKEN}`;
  const [counts,roster] = await Promise.all([
    pool.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE a.present=true)::int AS present, count(*) FILTER (WHERE COALESCE(a.present,false)=false)::int AS remaining ${base}`,[site.id,date]),
    pool.query(`SELECT r.id,r.registration_no,r.slip_no,r.status,m.full_name AS client_name,m.phone AS client_phone,m.photo AS client_photo,
      a.id AS attendance_id,COALESCE(a.present,false) AS present,a.checked_in_at,a.checked_in_by,
      u.name AS checked_in_by_name,count(*) OVER()::int AS matched_count
      ${base} AND ($3='all' OR ($3='present' AND a.present=true) OR ($3='remaining' AND COALESCE(a.present,false)=false))
      AND ($4='' OR m.full_name ILIKE '%' || $4 || '%' OR m.phone ILIKE '%' || $4 || '%' OR r.slip_no ILIKE '%' || $4 || '%')
      ORDER BY ${order} LIMIT $5 OFFSET $6`,[site.id,date,status,search,limit,(page-1)*limit]),
  ]);
  res.json({ site,date,today:todayIST(),can_mark:date===todayIST(),summary:counts.rows[0],items:roster.rows,total:roster.rows[0]?.matched_count||0,page,limit });
});
// Draw dates that have issued tokens, newest first, for the date picker.
export const listDrawAttendanceDates = asyncHandler(async (req,res) => {
  const site = await requireWorkspaceAccess(req.user,req.query.site_id,ATTENDANCE_MODULE);
  const { rows } = await pool.query(`SELECT r.draw_opening_date::text AS date,count(*)::int AS total,count(*) FILTER (WHERE a.present)::int AS present
    FROM draw_registrations r LEFT JOIN draw_attendance a ON a.draw_registration_id=r.id AND a.attendance_date=r.draw_opening_date
    WHERE r.site_id=$1 AND r.draw_opening_date IS NOT NULL AND ${ISSUED_TOKEN} GROUP BY r.draw_opening_date ORDER BY r.draw_opening_date DESC LIMIT 60`,[site.id]);
  res.json({ today:todayIST(),dates:rows });
});
export const setDrawAttendance = asyncHandler(async(req,res)=>{
  const { site_id, date, ids, present } = req.body || {};
  res.json(await setAttendance({user:req.user,siteId:site_id,date,ids,present}));
});
export const markDrawAttendance = asyncHandler(async(req,res)=>{
  const result=await checkInDraw({user:req.user,siteId:req.body.site_id,date:req.body.date,token:req.body.token});
  res.status(result.already_present?200:201).json(result);
});
export const undoDrawAttendance = asyncHandler(async(req,res)=>{
  res.json(await correctAttendance({user:req.user,siteId:req.body.site_id,id:req.params.id,reason:req.body.reason}));
});
