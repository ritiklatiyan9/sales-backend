import pool from '../config/db.js';
import { currentStaffSession } from './staffSession.js';
import { getVisibleUserIds } from './agentNetwork.service.js';
import { requireSiteAccess } from './bookingWorkspaceAccess.js';
import { hasPermission } from './permissions.service.js';

/** IDs from Socket.IO are untrusted, just like REST route parameters. */
export async function realtimeRoomAccess(token, kind, value, { db = pool, session = currentStaffSession, visibleUsers = getVisibleUserIds, permission = hasPermission, siteAccess = requireSiteAccess } = {}) {
  const id = Number(value);
  if (!['booking', 'kyc_case'].includes(kind) || !Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid resource');
  const user = await session(token, db);
  const module = kind === 'booking' ? 'booking_bookings' : 'booking_kyc_all';
  if (!await permission(user, module, 'can_read')) throw new Error('Access denied');
  const { rows } = kind === 'booking'
    ? await db.query('SELECT id, site_id, agent_user_id, created_by FROM bookings WHERE id = $1', [id])
    : await db.query('SELECT k.id, k.site_id, k.created_by, k.client_member_id, b.agent_user_id, b.created_by AS booking_creator FROM kyc_cases k LEFT JOIN bookings b ON b.id=k.booking_id WHERE k.id=$1', [id]);
  const record = rows[0];
  if (!record) throw new Error('Access denied');
  await siteAccess(user, record.site_id, db);
  const visible = await visibleUsers(user);
  if (visible && ![record.created_by, record.agent_user_id, record.booking_creator].some(actor => visible.includes(actor))) {
    if (kind !== 'kyc_case') throw new Error('Access denied');
    const draw = await db.query('SELECT 1 FROM draw_registrations WHERE site_id=$4 AND (kyc_case_id=$1 OR client_member_id=$2) AND (agent_user_id=ANY($3) OR created_by=ANY($3)) LIMIT 1', [id, record.client_member_id, visible, record.site_id]);
    if (!draw.rows.length) throw new Error('Access denied');
  }
  return { room: `${kind}_${id}`, user };
}

/** Recheck every delivery so revocation also applies to already connected tabs. */
export async function deliverOcrUpdate(server, evt, authorize = realtimeRoomAccess) {
  const rooms = new Set([evt.bookingId && `booking_${evt.bookingId}`, evt.caseId && `kyc_case_${evt.caseId}`].filter(Boolean));
  await Promise.all([...server.sockets.sockets.values()].map(async socket => {
    const subscriptions = socket.data.ocrSubscriptions;
    for (const [room, record] of subscriptions || []) {
      if (!rooms.has(room)) continue;
      try {
        await authorize(socket.handshake.auth?.token, record.kind, record.id);
        if (socket.connected && subscriptions.has(room)) socket.emit('ocr_update', { ...evt });
        return;
      } catch { subscriptions.delete(room); }
    }
  }));
}
