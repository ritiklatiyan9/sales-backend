import pool from '../config/db.js';
import drawModel from '../models/Draw.model.js';
import { todayIST } from './drawWorkflow.js';

let ready = false;
let pending;
export async function ensureBookingCreditFields(db = pool) {
  if (ready) return;
  if (!pending) pending = db.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS first_installment_amount NUMERIC(15,2) CHECK (first_installment_amount > 0)')
    .then(() => { ready = true; }).finally(() => { pending = null; });
  await pending;
}

export async function listBookingDrawCredits(siteId, memberId, db = pool) {
  const { rows } = await db.query(`
    SELECT r.id, r.registration_no, r.slip_no, r.status, r.is_winner, r.booking_id,
           r.draw_opening_date, r.workflow_version, r.required_amount, kyc.status AS kyc_status,
           COALESCE(pay.total_paid,0)::float AS total_paid, COALESCE(pay.payments,'[]'::json) AS payments
    FROM draw_registrations r
    LEFT JOIN LATERAL (${drawModel.kycCaseLateral}) kyc ON true
    LEFT JOIN LATERAL (
      SELECT SUM(p.amount) AS total_paid, json_agg(json_build_object(
        'id',p.id,'receipt_no',p.receipt_no,'payment_date',p.payment_date,'amount',p.amount,
        'payment_from',p.payment_from,'bank_name',p.bank_name,'branch',p.branch,
        'bank_details',p.bank_details,'cheque_no',p.cheque_no,'received_by',p.received_by,
        'narration',p.narration,'plot_payment_id',p.plot_payment_id
      ) ORDER BY p.payment_date,p.id) AS payments
      FROM draw_payments p WHERE p.draw_registration_id = r.id
    ) pay ON true
    WHERE r.site_id = $1 AND r.client_member_id = $2
    ORDER BY r.id DESC`, [siteId, memberId]);
  return rows.map(r => {
    let reason = null;
    if (r.booking_id || r.status === 'ALLOTTED') reason = 'Already applied to a booking';
    else if (r.status === 'CANCELLED') reason = 'Registration cancelled';
    else if (r.payments.some(p => p.plot_payment_id)) reason = 'Receipts already transferred; resolve the existing allocation first';
    else if (!r.total_paid || r.total_paid < Number(r.required_amount)) reason = 'Required draw payment is incomplete';
    else if (!r.is_winner || r.status !== 'WINNER') reason = 'Record the physical draw result before allotment';
    else if ((r.workflow_version > 0 && !r.draw_opening_date) || r.draw_opening_date > todayIST()) reason = 'The draw has not opened yet';
    else if (r.kyc_status !== 'VERIFIED') reason = 'Complete KYC before allotment';
    return { ...r, eligible: !reason, reason };
  });
}
