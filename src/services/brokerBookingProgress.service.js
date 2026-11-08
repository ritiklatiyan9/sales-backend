const normalizeStatus = value => String(value || '').trim().toUpperCase().replace(/[_-]+/g, ' ');
const normalizeName = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-IN');
const positiveId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const timestamp = value => {
  const result = value instanceof Date ? value.getTime() : Date.parse(String(value || ''));
  return Number.isFinite(result) ? result : null;
};
const indiaDay = value => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(value));
const dateOnly = (value, today) => {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === text
    && text >= '1900-01-01' && text <= today ? text : null;
};
const eventDay = (value, today) => {
  const parsed = timestamp(value);
  return parsed === null ? null : dateOnly(indiaDay(parsed), today);
};
const positiveNumber = value => Number.isFinite(Number(value)) && Number(value) > 0;
const milestone = (code, state, date = null) => ({ code, state, date });

/** A current-stage projection, not a reconstructed status-change audit log. */
export function projectBrokerBookingProgress(plot, evidence = {}) {
  const status = normalizeStatus(plot.status);
  const booking = milestone('booking', evidence.bookingRecorded ? 'complete' : 'unavailable', evidence.bookingDate || null);
  const milestones = [booking];
  let currentStage = 'unknown';
  let nextAction = 'contact_admin';
  const cancellation = ['UNDER CANCELLATION', 'CANCELLED', 'CANCELED', 'RESALE'].includes(status);

  if (['BOOKED', 'SOLD', 'ACTIVE'].includes(status)) {
    currentStage = 'booked';
    nextAction = Number(plot.balanceAmount) > 0 ? 'review_installments' : 'contact_admin';
  } else if (['REGISTRY', 'REGISTERED'].includes(status)) {
    currentStage = 'registry_pending';
    nextAction = 'await_registry_details';
    milestones.push(milestone('registry_started', evidence.registryStarted ? 'complete' : 'current', evidence.registryDate || null));
    milestones.push(milestone('registry_deed', evidence.deedOnFile ? 'complete' : 'pending', evidence.deedDate || null));
    milestones.push(milestone('registry_handover', evidence.deedOnFile && evidence.handedOver ? 'complete' : 'pending',
      evidence.deedOnFile && evidence.handedOver ? evidence.handoverDate || null : null));
    if (evidence.deedOnFile && evidence.handedOver) {
      currentStage = 'registry_complete'; nextAction = 'none';
    } else if (evidence.deedOnFile) {
      currentStage = 'registry_handover_pending'; nextAction = 'await_registry_handover';
    } else if (evidence.registryStarted && evidence.registryDetailsComplete) {
      currentStage = 'registry_deed_pending'; nextAction = 'await_registry_deed';
    }
  } else if (status === 'UNDER CANCELLATION') {
    currentStage = 'cancellation_pending'; nextAction = 'await_cancellation';
    milestones.push(milestone('cancellation', 'current'));
  } else if (['CANCELLED', 'CANCELED'].includes(status)) {
    currentStage = 'cancelled';
    // Current status establishes cancellation, but there is no transition date.
    milestones.push(milestone('cancellation', 'complete'));
  } else if (status === 'RESALE') {
    currentStage = 'resale';
  } else if (status === 'TRANSFERRED') {
    currentStage = 'transferred';
  }

  if (evidence.refundRecorded) {
    milestones.push(milestone('refund', 'complete', evidence.refundDate || null));
    if (cancellation) { currentStage = 'refund_recorded'; nextAction = 'confirm_refund'; }
  } else if (evidence.refundPending) {
    milestones.push(milestone('refund', 'current'));
    if (cancellation) { currentStage = 'refund_pending'; nextAction = 'await_refund'; }
  } else if (cancellation) {
    // Cancellation does not prove that a refund is owed or already requested.
    milestones.push(milestone('refund', 'unavailable'));
  }
  if (evidence.associationVerified !== true) nextAction = 'contact_admin';
  return { currentStage, nextAction, milestones };
}

// A date by itself cannot establish the current buyer's ownership of a record.
// Every historical source also needs the latest exact booking and a timestamp
// boundary, so changing a buyer never revives an older registry or refund.
// Booking edits conservatively advance that boundary because there is no
// field-level owner audit. The edit time is never presented as a milestone.
export function createBrokerBookingProgressReader(db, { now = Date.now } = {}) {
  return async function readProgress(plot) {
    const evidence = {};
    if (!positiveId(plot.id) || !positiveId(plot.site_id) || !positiveId(plot.client_id)) {
      return projectBrokerBookingProgress(plot, evidence);
    }
    const asOf = new Date(now()).toISOString();
    const today = indiaDay(asOf);
    const { rows: bookings } = await db.query(`SELECT b.id,b.client_member_id,b.status,
      to_jsonb(b)->>'booking_date' AS booking_date,NULLIF(to_jsonb(b)->>'created_at','')::timestamptz AS created_at,
      NULLIF(to_jsonb(b)->>'updated_at','')::timestamptz AS updated_at
      FROM bookings b WHERE b.plot_id=$1 AND b.site_id=$2 ORDER BY b.id DESC LIMIT 1`, [plot.id, plot.site_id]);
    const booking = bookings[0];
    const rejectedBooking = ['DELETED', 'VOID', 'VOIDED', 'WITHDRAWN'].includes(normalizeStatus(booking?.status));
    if (!booking || String(booking.client_member_id) !== String(plot.client_id) || rejectedBooking) {
      return projectBrokerBookingProgress(plot, evidence);
    }
    const status = normalizeStatus(plot.status);
    if (normalizeStatus(booking.status).startsWith('CANCEL') && !['CANCELLED', 'CANCELED', 'UNDER CANCELLATION', 'RESALE'].includes(status)) {
      return projectBrokerBookingProgress(plot, evidence);
    }
    const created = timestamp(booking.created_at);
    if (created !== null && created > Date.parse(asOf)) return projectBrokerBookingProgress(plot, evidence);
    const edited = booking.updated_at == null ? null : timestamp(booking.updated_at);
    if (booking.updated_at != null && (edited === null || edited > Date.parse(asOf) || (created !== null && edited < created))) {
      return projectBrokerBookingProgress(plot, evidence);
    }
    const cutoff = created === null ? edited : Math.max(created, edited ?? created);
    const cutoffDay = cutoff === null ? null : dateOnly(indiaDay(cutoff), today);
    evidence.associationVerified = true;
    evidence.bookingRecorded = true;
    const recordedBookingDate = dateOnly(booking.booking_date, today);
    const wasEdited = edited !== null && (created === null || edited > created);
    evidence.bookingDate = recordedBookingDate && (!wasEdited || !cutoffDay || recordedBookingDate >= cutoffDay) ? recordedBookingDate
      : !wasEdited ? eventDay(booking.created_at, today) : null;
    // Optional legacy creation dates cannot safely bound another owner's rows.
    if (created === null) return projectBrokerBookingProgress(plot, evidence);
    const boundaryAt = new Date(cutoff).toISOString();

    const { rows: available } = await db.query(`SELECT
      to_regclass('plot_registries') IS NOT NULL AS registries,
      to_regclass('documents') IS NOT NULL AS documents,
      to_regclass('kyc_cases') IS NOT NULL AS cases,
      to_regclass('registry_document_handovers') IS NOT NULL AS handovers,
      to_regclass('plot_payments') IS NOT NULL AS payments,
      to_regclass('plot_installment_payments') IS NOT NULL AS installment_payments,
      to_regclass('plot_installments') IS NOT NULL AS installments,
      to_regclass('website_booking_requests') IS NOT NULL AS website`);
    const tables = available[0] || {};
    const registryFlow = ['REGISTRY', 'REGISTERED'].includes(status);
    if (registryFlow && tables.registries) {
      const legacyScope = tables.cases ? `OR (NULLIF(to_jsonb(d)->>'plot_id','') IS NULL AND EXISTS(
        SELECT 1 FROM kyc_cases k WHERE k.id=d.kyc_case_id AND to_jsonb(k)->>'booking_id'=boundary.booking_id::text
          AND (to_jsonb(k)->>'site_id' IS NULL OR to_jsonb(k)->>'site_id'=boundary.site_id::text)))` : '';
      // Workspace, current deed and current handover share one SQL snapshot.
      // A deed deleted between separate queries cannot leave a completed step.
      const deedJoin = tables.documents ? `LEFT JOIN LATERAL (
        SELECT max(d.created_at)::timestamptz AS created_at FROM documents d
        WHERE ((to_jsonb(d)->>'plot_id')=boundary.plot_id::text ${legacyScope})
          AND (to_jsonb(d)->>'site_id' IS NULL OR to_jsonb(d)->>'site_id'=boundary.site_id::text)
          AND (to_jsonb(d)->>'client_member_id' IS NULL OR to_jsonb(d)->>'client_member_id'=boundary.client_id::text)
          AND upper(trim(COALESCE(to_jsonb(d)->>'category','')))='REGISTRY'
          AND upper(trim(COALESCE(to_jsonb(d)->>'uploaded_source','BOOKING')))<>'DMS'
          AND NULLIF(trim(to_jsonb(d)->>'file_path'),'') IS NOT NULL
          AND d.created_at >= boundary.created_at AND d.created_at <= boundary.as_of
      ) deed ON true` : 'LEFT JOIN LATERAL (SELECT NULL::timestamptz AS created_at) deed ON true';
      const handoverJoin = tables.documents && tables.handovers ? `LEFT JOIN LATERAL (
        SELECT max(h.given_at)::timestamptz AS given_at FROM registry_document_handovers h
        WHERE h.registry_id=pr.id
          AND (to_jsonb(h)->>'site_id' IS NULL OR to_jsonb(h)->>'site_id'=boundary.site_id::text)
          AND h.given_at >= deed.created_at AND h.given_at <= boundary.as_of
      ) handover ON true` : 'LEFT JOIN LATERAL (SELECT NULL::timestamptz AS given_at) handover ON true';
      const { rows } = await db.query(`WITH boundary AS (SELECT $1::integer AS plot_id,$2::integer AS site_id,
        $3::integer AS booking_id,$4::integer AS client_id,$5::timestamptz AS created_at,$6::timestamptz AS as_of)
        SELECT pr.id,to_jsonb(pr)->>'customer_name' AS customer_name,
          NULLIF(to_jsonb(pr)->>'created_at','')::timestamptz AS created_at,
          to_jsonb(pr)->>'registry_date' AS registry_date,to_jsonb(pr)->>'size_meter' AS size_meter,
          to_jsonb(pr)->>'size_sqyard' AS size_sqyard,to_jsonb(pr)->>'circle_rate' AS circle_rate,
          to_jsonb(pr)->>'farmer_name' AS farmer_name,to_jsonb(pr)->>'seller_name' AS seller_name,
          to_jsonb(pr)->>'registry_payment' AS registry_payment,deed.created_at AS deed_at,handover.given_at AS handover_at
        FROM boundary JOIN plot_registries pr ON pr.plot_id=boundary.plot_id AND pr.site_id=boundary.site_id
        ${deedJoin} ${handoverJoin} ORDER BY pr.id DESC LIMIT 1`,
      [plot.id, plot.site_id, booking.id, plot.client_id, boundaryAt, asOf]);
      const registry = rows[0];
      const registryCreated = timestamp(registry?.created_at);
      const currentName = normalizeName(plot.current_client_name);
      const recordedName = normalizeName(registry?.customer_name);
      const registryMatches = registry && registryCreated !== null && registryCreated >= cutoff && registryCreated <= Date.parse(asOf)
        && currentName && (!recordedName || recordedName === currentName);
      if (registryMatches) {
        evidence.registryStarted = true;
        evidence.registryDate = eventDay(registry.created_at, today);
        evidence.registryDetailsComplete = Boolean(recordedName && dateOnly(registry.registry_date, '2100-12-31')
          && (positiveNumber(registry.size_meter) || positiveNumber(registry.size_sqyard)) && positiveNumber(registry.circle_rate)
          && normalizeName(registry.farmer_name || registry.seller_name) && positiveNumber(registry.registry_payment));
        evidence.deedOnFile = Boolean(registry.deed_at);
        evidence.deedDate = eventDay(registry.deed_at, today);
        evidence.handedOver = Boolean(registry.deed_at && registry.handover_at);
        evidence.handoverDate = evidence.handedOver ? eventDay(registry.handover_at, today) : null;
      }
    }

    const refundQueries = [];
    const paymentSource = (table, alias, date, mode, extraJoin = '') => `SELECT ${alias}.${date}::text AS date,
      ${alias}.status,${alias}.cheque_status,financial_transaction_posts('debit',${alias}.status,${alias}.${mode},${alias}.cheque_status) AS posted
      FROM ${table} ${alias} ${extraJoin}
      WHERE ${alias}.plot_id=$1 AND ${alias}.amount<0
        AND ${alias}.${date} BETWEEN $3::date AND $4::date
        AND NULLIF(to_jsonb(${alias})->>'created_at','')::timestamptz >= $5::timestamptz
        AND NULLIF(to_jsonb(${alias})->>'created_at','')::timestamptz <= $6::timestamptz
        AND NULLIF(to_jsonb(${alias})->>'money_transfer_id','') IS NULL
        AND NULLIF(to_jsonb(${alias})->>'entry_transfer_id','') IS NULL`;
    if (tables.payments) refundQueries.push(db.query(`${paymentSource('plot_payments', 'pp', 'date', 'payment_type')} AND pp.site_id=$2`,
      [plot.id, plot.site_id, cutoffDay, today, boundaryAt, asOf]));
    if (tables.installment_payments && tables.installments) refundQueries.push(db.query(paymentSource('plot_installment_payments', 'pip', 'payment_date', 'payment_mode',
      'JOIN plot_installments pi ON pi.id=pip.installment_id AND pi.plot_id=pip.plot_id JOIN plots refund_plot ON refund_plot.id=pip.plot_id AND refund_plot.site_id=$2'),
    [plot.id, plot.site_id, cutoffDay, today, boundaryAt, asOf]));
    for (const { rows } of await Promise.all(refundQueries)) {
      for (const refund of rows) {
        if (refund.posted) {
          evidence.refundRecorded = true;
          const date = dateOnly(refund.date, today);
          if (date && (!evidence.refundDate || date > evidence.refundDate)) evidence.refundDate = date;
        } else if (['PENDING', 'APPROVED'].includes(normalizeStatus(refund.status))
          && !['BOUNCED', 'RETURNED', 'CANCELLED', 'CANCELED', 'REJECTED'].includes(normalizeStatus(refund.cheque_status))) {
          evidence.refundPending = true;
        }
      }
    }
    if (tables.website) {
      // Original website requests precede approval/booking creation. After a
      // later booking edit their mutable booking pointer alone cannot prove
      // that an old buyer's refund belongs to the current client.
      const { rows } = await db.query(`SELECT w.amount_refunded_paise,w.refund_required FROM website_booking_requests w
        WHERE w.booking_id=$1 AND w.plot_id=$2 AND w.site_id=$3
          AND NULLIF(to_jsonb(w)->>'created_at','')::timestamptz <= $4::timestamptz
          AND (NOT $5::boolean OR NULLIF(to_jsonb(w)->>'created_at','')::timestamptz >= $6::timestamptz)`,
      [booking.id, plot.id, plot.site_id, asOf, wasEdited, boundaryAt]);
      for (const row of rows) {
        if (Number(row.amount_refunded_paise) > 0) evidence.refundRecorded = true;
        if (row.refund_required === true) evidence.refundPending = true;
      }
    }
    return projectBrokerBookingProgress(plot, evidence);
  };
}
