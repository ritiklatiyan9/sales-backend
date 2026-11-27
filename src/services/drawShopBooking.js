import { createHash } from 'node:crypto';
import pool from '../config/db.js';
import bookingModel from '../models/Booking.model.js';
import drawModel, { ACCOUNTS_BOOKED_SHOP_MATCH } from '../models/Draw.model.js';
import { ensureBookingCreditFields } from './bookingDrawCredits.js';
import { syncDrawLedgerToPlot } from './drawLedgerSync.js';
import { money, todayIST, workflowError } from './drawWorkflow.js';
import { syncPlotBookingToAccounting } from './plotBookingSync.js';
import { isFullAdmin, isSubAdmin } from './subAdminPermissions.js';
import { requireWorkspaceAccess } from './bookingWorkspaceAccess.js';

const canBookShop = user => isFullAdmin(user) || isSubAdmin(user);

export function canShowAccountsShopBookings(siteId, siteName, user) {
  return canBookShop(user) && user.organization_id != null
    && Number(siteId) === 7 && siteName?.trim().toLowerCase() === 'naya baazar unn commercial';
}

export function supportsDrawShopBooking(siteId, siteName, organizationId, user) {
  return canShowAccountsShopBookings(siteId, siteName, user) && Number(user.organization_id) === Number(organizationId);
}

export async function accountsBookedShopsForDraws(registrationIds, db = pool) {
  const shopsByDraw = new Map();
  if (!registrationIds.length) return shopsByDraw;
  const { rows } = await db.query(`
    SELECT r.id AS draw_id, shop.plot_no, shop.block,
      EXISTS (SELECT 1 FROM draw_payments dp JOIN plot_payments pp ON pp.id=dp.plot_payment_id
        WHERE dp.draw_registration_id=r.id AND pp.plot_id=shop.id AND pp.site_id=r.site_id) AS receipt_linked
    FROM draw_registrations r JOIN plots shop ON ${ACCOUNTS_BOOKED_SHOP_MATCH}
    WHERE r.id=ANY($1::int[])
    ORDER BY shop.block,shop.plot_no,shop.id`, [registrationIds]);
  for (const { draw_id, ...shop } of rows) {
    const shops = shopsByDraw.get(draw_id) || [];
    shops.push(shop);
    shopsByDraw.set(draw_id, shops);
  }
  return shopsByDraw;
}

function positiveId(value) {
  const id = Number(value);
  if (!['number', 'string'].includes(typeof value) || !/^\d+$/.test(String(value)) || !Number.isInteger(id) || id < 1 || id > 2147483647) {
    throw workflowError('Select a valid registration or shop.');
  }
  return id;
}

async function readRegistration(db, user, registrationId, lock = false) {
  if (!canBookShop(user)) throw workflowError('Only admins and sub-admins can book a shop from a draw.', 403);
  const { rows: [draw] } = await db.query(`
    SELECT r.id, r.registration_no, r.site_id, s.name AS site_name, s.organization_id,
           r.client_member_id, m.full_name AS client_name, m.status AS client_status, r.agent_user_id, r.broker_member_id, r.is_winner,
           r.status, r.required_amount, r.booking_id, r.allotted_plot_id, kyc.id AS kyc_id, kyc.status AS kyc_status
    FROM draw_registrations r JOIN sites s ON s.id=r.site_id
    JOIN members m ON m.id=r.client_member_id AND m.site_id=r.site_id
    LEFT JOIN LATERAL (${drawModel.kycCaseLateral}) kyc ON true
    WHERE r.id=$1 ${lock ? 'FOR UPDATE OF r' : ''}`, [positiveId(registrationId)]);
  if (!draw) throw workflowError('Draw registration not found.', 404);
  if (!supportsDrawShopBooking(draw.site_id, draw.site_name, draw.organization_id, user)) {
    throw workflowError('Direct shop booking is available only for Naya Baazar Unn Commercial.', 403);
  }
  if (isSubAdmin(user)) await requireWorkspaceAccess(user, draw.site_id, 'booking_draws', 'can_update', db);
  if (!draw.is_winner && !draw.booking_id) {
    const { rows: [schema] } = await db.query("SELECT to_regclass('public.pool_money_results') IS NOT NULL AS has_results");
    if (schema.has_results) {
      const { rows: [result] } = await db.query("SELECT result FROM pool_money_results WHERE source_kind='draw' AND owner_id=$1 AND site_id=$2", [draw.id, draw.site_id]);
      draw.result = result?.result;
    }
  }
  return draw;
}

async function readReceipts(db, draw, lock = false) {
  const { rows } = await db.query(`SELECT id, receipt_no, payment_date, amount, payment_from, bank_name, branch,
    bank_details, bank_account_id, cheque_no, received_by, narration, plot_payment_id
    FROM draw_payments WHERE draw_registration_id=$1 ORDER BY id ${lock ? 'FOR UPDATE' : ''}`, [draw.id]);
  const total = rows.reduce((paise, receipt) => paise + Math.round(Number(receipt.amount) * 100), 0) / 100;
  const version = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  return { rows, total, version };
}

function bookingBlock(draw, receipts) {
  if (draw.status === 'CANCELLED') return 'This draw registration was cancelled.';
  if (draw.booking_id || draw.allotted_plot_id || draw.status === 'ALLOTTED') return 'This draw already has a shop booking.';
  if (draw.result === 'NOT_SELECTED') return 'This registration was marked as not selected in the draw.';
  if (draw.client_status !== 'ACTIVE') return 'The draw client must be active in this project.';
  if (receipts.rows.some(receipt => receipt.plot_payment_id)) return 'A draw receipt is already assigned to a unit. Review it in Accounts.';
  if (draw.kyc_status !== 'VERIFIED') return 'Verify the client’s KYC before booking a shop.';
  if (!receipts.rows.length || receipts.total < Number(draw.required_amount)) return 'Collect the required draw payment before booking a shop.';
  return null;
}

async function availableShops(db, siteId, plotId = null) {
  const { rows: [schema] } = await db.query("SELECT to_regclass('public.website_booking_requests') IS NOT NULL AS has_holds");
  return (await db.query(`SELECT p.id,p.plot_no,p.block,p.plot_size,p.sale_price,p.first_installment,
      (p.installments_enabled OR EXISTS (SELECT 1 FROM plot_installments i WHERE i.plot_id=p.id)) AS has_installments
    FROM plots p
    WHERE p.site_id=$1 AND p.unit_type='shop' AND p.status IN ('COMPANY','AVAILABLE','CREATED')
      AND p.approval_status='approved' AND p.buyer_member_id IS NULL AND p.sale_price>0
      AND p.plot_tag IS DISTINCT FROM 'OLD' AND p.booking_cancelled_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.plot_id=p.id AND b.status<>'CANCELLED')
      AND NOT EXISTS (SELECT 1 FROM draw_registrations r WHERE r.allotted_plot_id=p.id AND r.status='ALLOTTED')
      AND NOT EXISTS (SELECT 1 FROM plot_payments pp WHERE pp.plot_id=p.id)
      ${schema.has_holds ? `AND NOT EXISTS (SELECT 1 FROM website_booking_requests w WHERE w.plot_id=p.id
        AND (w.status='PAYMENT_REVIEW' OR (w.status IN ('ORDER_CREATING','AWAITING_PAYMENT') AND w.hold_expires_at>now())))` : ''}
      ${plotId === null ? 'ORDER BY p.block,p.plot_no,p.id' : 'AND p.id=$2 FOR UPDATE OF p'}`,
  plotId === null ? [siteId] : [siteId, plotId])).rows;
}

export async function drawShopBookingOptions(registrationId, user, db = pool) {
  const draw = await readRegistration(db, user, registrationId);
  const receipts = await readReceipts(db, draw);
  const reason = bookingBlock(draw, receipts);
  return {
    id: draw.id, site_id: draw.site_id, registration_no: draw.registration_no, client_member_id: draw.client_member_id,
    client_name: draw.client_name, booking_id: draw.booking_id, allotted_plot_id: draw.allotted_plot_id,
    receipts: receipts.rows, receipt_version: receipts.version, total: receipts.total, reason, shops: reason ? [] : await availableShops(db, draw.site_id),
  };
}

export async function bookShopFromDraw(registrationId, body, user, database = pool) {
  if (!canBookShop(user)) throw workflowError('Only admins and sub-admins can book a shop from a draw.', 403);
  const plotId = positiveId(body.plot_id);
  const reviewedTotal = money(body.expected_draw_credit_amount, 'Reviewed draw total');
  const reviewedPrice = money(body.expected_sale_price, 'Reviewed shop price');
  await ensureBookingCreditFields(database);
  const db = await database.connect();
  try {
    await db.query('BEGIN');
    const draw = await readRegistration(db, user, registrationId, true);
    const receipts = await readReceipts(db, draw, true);
    const reason = bookingBlock(draw, receipts);
    if (reason) throw workflowError(reason, 409);
    if (draw.site_id !== Number(body.site_id) || draw.client_member_id !== Number(body.client_member_id) ||
        receipts.total !== reviewedTotal || receipts.version !== body.receipt_version) {
      throw workflowError('The registration or its receipts changed. Refresh and review the booking.', 409);
    }
    const [shop] = await availableShops(db, draw.site_id, plotId);
    if (!shop) throw workflowError('This shop is no longer available in this project. Choose another shop.', 409);
    if (Number(shop.sale_price) !== reviewedPrice) throw workflowError('The shop price changed. Refresh and review the booking.', 409);
    if (receipts.total > reviewedPrice) throw workflowError('The draw credit exceeds the shop price. Review the receipts in Accounts.', 409);

    const booking = await bookingModel.create({
      site_id: draw.site_id, plot_id: shop.id, client_member_id: draw.client_member_id, buyer_name: draw.client_name,
      agent_user_id: draw.agent_user_id, booking_agent_id: draw.broker_member_id,
      team_id: draw.agent_user_id ? (await db.query('SELECT team_id FROM users WHERE id=$1', [draw.agent_user_id])).rows[0]?.team_id : null,
      booking_date: todayIST(), sale_price: shop.sale_price, payment_plan: shop.has_installments ? 'INSTALLMENT' : 'FULL',
      first_installment_amount: Number(shop.first_installment) > 0 ? shop.first_installment : null, token_amount: 0,
      status: 'CONFIRMED', kyc_status: 'VERIFIED', booked_by: user.email || null, created_by: user.id,
      notes: `Shop booked from draw registration ${draw.registration_no || draw.id}`,
    }, db);
    const bookingNo = await bookingModel.generateBookingNo(booking.id, booking.booking_date, db);
    const kyc = await db.query(`UPDATE kyc_cases k SET booking_id=$1, updated_at=now()
      WHERE k.id=$2 AND k.client_member_id=$3 AND k.site_id=$4 AND k.status='VERIFIED'
        AND (k.booking_id IS NULL OR EXISTS (SELECT 1 FROM bookings b WHERE b.id=k.booking_id AND b.status='CANCELLED'))
      RETURNING id`, [booking.id, draw.kyc_id, draw.client_member_id, draw.site_id]);
    if (!kyc.rows.length) throw workflowError('The verified KYC is no longer available for this booking.', 409);
    await db.query(`UPDATE draw_registrations SET booking_id=$2, allotted_plot_id=$3, allotted_at=now(), allotted_by=$4,
      kyc_case_id=$5, status='ALLOTTED', updated_at=now() WHERE id=$1`, [draw.id, booking.id, shop.id, user.id, draw.kyc_id]);

    // Use the same transaction-local booking context as the main Accounts register.
    await db.query("SELECT set_config('accounts.direct_plot_booking',$1,true)", [String(shop.id)]);
    const booked = await syncPlotBookingToAccounting(booking, db);
    if (!booked.ok) throw workflowError('Accounts could not book this shop for the client. Refresh and try again.', 409);
    const ledger = await syncDrawLedgerToPlot(draw.id, db, { requireAvailableCredit: true });
    if (!ledger.ok || ledger.created !== receipts.rows.length || Math.round(ledger.total_synced * 100) !== Math.round(reviewedTotal * 100)) {
      throw workflowError(ledger.message || 'Accounts could not apply every draw receipt. The booking was rolled back.', 409);
    }
    const account = await db.query(`SELECT 1 FROM plots WHERE id=$1 AND site_id=$2 AND status='BOOKED'
      AND approval_status='approved' AND buyer_member_id=$3`, [shop.id, draw.site_id, draw.client_member_id]);
    if (!account.rows.length) throw workflowError('Accounts could not confirm this shop under the draw client. The booking was rolled back.', 409);
    await drawModel.logEvent(draw.id, 'ALLOTTED', {
      method: 'direct_shop_booking', previous_status: draw.status, booking_id: booking.id, booking_no: bookingNo,
      plot_id: shop.id, plot_no: shop.plot_no, receipt_ids: receipts.rows.map(receipt => receipt.id), amount: receipts.total,
    }, user.id, db);
    await db.query('COMMIT');
    return { booking_id: booking.id, booking_no: bookingNo, plot_id: shop.id, plot_no: shop.plot_no,
      client_name: draw.client_name, receipt_count: ledger.created, amount: receipts.total };
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}
