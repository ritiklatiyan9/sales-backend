import { createBrokerPresentation, isBrokerPropertyId } from './brokerPresentation.service.js';
import { allInOrder } from './clientRegistry.service.js';

const amount = value => Math.round((Number(value) || 0) * 100) / 100;
const unavailable = () => { throw Object.assign(new Error('Commission details changed. Please refresh.'), { statusCode: 503 }); };
// Optional JSON projections let the read-only mobile API remain compatible
// while the additive Accounts allocation migration is rolled out separately.
const columns = `pc.id,pc.site_id,pc.plot_id,pc.agent_id,pc.total_commission,pc.status,
  to_jsonb(pc)->>'allocation_type' AS allocation_type,
  to_jsonb(pc)->>'allocation_value' AS allocation_value,
  to_jsonb(pc)->>'settlement_commission' AS settlement_commission,
  to_jsonb(pc)->>'settlement_percent' AS settlement_percent,
  to_jsonb(pc)->>'settled_at' AS settled_at`;
const scope = (paymentJoin = '') => `FROM plot_commissions_v2 pc
  JOIN members bm ON bm.id=pc.agent_id
  JOIN sites broker_site ON broker_site.id=bm.site_id
  JOIN plots p ON p.id=pc.plot_id AND p.site_id=pc.site_id
  JOIN sites property_site ON property_site.id=p.site_id AND property_site.organization_id=broker_site.organization_id
  ${paymentJoin}
  WHERE pc.agent_id=ANY($1::integer[]) AND bm.site_id=ANY($2::integer[]) AND pc.plot_id=ANY($3::integer[])
    AND 'BROKER'=ANY(COALESCE(bm.member_types,ARRAY[bm.member_type]))
    AND COALESCE(to_jsonb(bm)->>'is_active','true')<>'false'
    AND upper(trim(COALESCE(to_jsonb(bm)->>'status','ACTIVE'))) NOT IN ('INACTIVE','BLOCKED','DISABLED','DEACTIVATED','DELETED','SUSPENDED')
    AND lower(trim(COALESCE(pc.status,''))) IN ('pending','partial','completed')`;
const authority = rows => JSON.stringify(rows.map(row => [row.id,row.site_id,row.plot_id,row.agent_id,String(row.total_commission),row.status,row.allocation_type,row.allocation_value,row.settlement_commission,row.settlement_percent,row.settled_at]));
const notFound = () => { throw Object.assign(new Error('Commission unavailable.'), { statusCode: 404 }); };
const paymentModes = new Set(['CASH','BANK','CHEQUE','UPI','CARD','ONLINE','NEFT','RTGS','IMPS','NET_BANKING','BANK_TRANSFER','DD']);
const postedPayment = `financial_transaction_posts(CASE WHEN pcp.amount<0 THEN 'credit' ELSE 'debit' END,
  pcp.status,pcp.payment_mode,pcp.cheque_status)`;
// Read cash and TDS in the same indexed pass. The list never fetches histories;
// detail loads only the selected property's own master/payment rows.
const paymentSummary = `LEFT JOIN LATERAL (
  SELECT COALESCE(SUM(pcp.amount),0) AS received_amount,
    COALESCE(SUM(COALESCE((to_jsonb(pcp)->>'tds_amount')::numeric,0)),0) AS tds_amount,
    COALESCE(SUM(GREATEST(pcp.amount+COALESCE((to_jsonb(pcp)->>'tds_amount')::numeric,0),0)),0) AS paid_out_amount,
    COALESCE(SUM(GREATEST(-(pcp.amount+COALESCE((to_jsonb(pcp)->>'tds_amount')::numeric,0)),0)),0) AS recovered_amount
  FROM plot_commission_payments pcp
  WHERE pcp.plot_commission_id=pc.id AND pcp.site_id=pc.site_id
    AND pcp.date BETWEEN DATE '1900-01-01' AND DATE '2100-12-31'
    AND ${postedPayment}
) settled ON true`;
const paymentRecords = `COALESCE((SELECT json_agg(payment ORDER BY payment.date DESC,payment.id DESC)
  FROM (SELECT pcp.id,pcp.date::text AS date,pcp.amount,
      COALESCE((to_jsonb(pcp)->>'tds_amount')::numeric,0) AS tds_amount,
      pcp.payment_mode,pcp.status,pcp.cheque_status,${postedPayment} AS posts
    FROM plot_commission_payments pcp
    WHERE pcp.plot_commission_id=pc.id AND pcp.site_id=pc.site_id
      AND pcp.date BETWEEN DATE '1900-01-01' AND DATE '2100-12-31'
    ORDER BY pcp.date DESC,pcp.id DESC LIMIT 10001) payment),'[]'::json) AS payment_records`;

function projectTransaction(row, presentation) {
  const status = String(row.status || '').trim().toLowerCase();
  const cheque = String(row.cheque_status || '').trim().toUpperCase();
  const mode = String(row.payment_mode || '').trim().toUpperCase().replace(/[ -]+/g,'_');
  return {
    id: presentation.commissionTransactionId(row.id), date: row.date,
    amount: amount(row.amount), tdsAmount: amount(row.tds_amount),
    totalAmount: amount(Number(row.amount) + Number(row.tds_amount)),
    paymentMode: mode === 'CHECK' ? 'CHEQUE' : paymentModes.has(mode) ? mode : 'OTHER',
    status: status === 'rejected' ? 'rejected'
      : ['cancelled','deleted','void','voided'].includes(status) ? 'cancelled'
      : ['BOUNCED','RETURNED'].includes(cheque) ? 'bounced'
      : row.posts ? 'posted' : 'pending',
    kind: Number(row.amount) < 0 || Number(row.tds_amount) < 0 ? 'refund' : 'payment',
    contributesToPaid: row.posts === true,
  };
}

/** Accounts commission amounts belong to the enrolled member, never the whole plot or its other agents. */
export function createBrokerCommissionReader(db, { scopedPlots, validateSession, now = Date.now }) {
  return createCommissionReader(db,{scopedPlots,validateSession,now},false);
}

export function createBrokerCommissionDetailReader(db, { scopedPlots, validateSession, now = Date.now }) {
  return createCommissionReader(db,{scopedPlots,validateSession,now},true);
}

function createCommissionReader(db, { scopedPlots, validateSession, now }, detail) {
  return async (session, id) => {
    if (detail && !isBrokerPropertyId(id)) notFound();
    let plots = await scopedPlots(session);
    if (detail) {
      const identities = createBrokerPresentation(session);
      plots = plots.filter(plot => identities.propertyId(plot.id) === id);
      if (plots.length !== 1) notFound();
    }
    const args = [session.brokerMemberIds,session.siteIds,plots.map(plot => plot.id)];
    const { rows } = await db.query(`SELECT ${columns},${detail ? paymentRecords : 'settled.received_amount,settled.tds_amount,settled.paid_out_amount,settled.recovered_amount'}
      ${scope(detail ? '' : paymentSummary)} ORDER BY pc.id LIMIT 10001`, args);
    if (rows.length > 10000) unavailable();
    if (detail) {
      if (!rows.length) notFound();
      if (rows.reduce((sum,row) => sum + row.payment_records.length,0) > 10000) unavailable();
      for (const row of rows) {
        row.received_amount = row.payment_records.reduce((sum,payment) => sum + (payment.posts ? Number(payment.amount) : 0),0);
        row.tds_amount = row.payment_records.reduce((sum,payment) => sum + (payment.posts ? Number(payment.tds_amount) : 0),0);
        row.paid_out_amount = row.payment_records.reduce((sum,payment) => sum + (payment.posts ? Math.max(0,Number(payment.amount)+Number(payment.tds_amount)) : 0),0);
        row.recovered_amount = row.payment_records.reduce((sum,payment) => sum + (payment.posts ? Math.max(0,-(Number(payment.amount)+Number(payment.tds_amount))) : 0),0);
      }
    }

    // A booking can still authorize the plot after its commission is reassigned.
    // Recheck both authorities after the potentially slow Accounts payment read.
    // The session is revalidated alongside; its error still comes after the 503s.
    const [currentPlots, { rows: current }, sessionError] = await allInOrder([scopedPlots(session),
      db.query(`SELECT ${columns} ${scope()} ORDER BY pc.id LIMIT 10001`, args),
      validateSession(session).then(() => null, error => error)]);
    if (authority(rows) !== authority(current)) unavailable();
    const byId = new Map(plots.map(plot => [plot.id,plot]));
    const currentById = new Map(currentPlots.map(plot => [plot.id,plot]));
    for (const row of rows) if (JSON.stringify(byId.get(row.plot_id)) !== JSON.stringify(currentById.get(row.plot_id))) unavailable();
    if (sessionError) throw sessionError;

    const presentation = createBrokerPresentation(session, {
      brands: plots.flatMap(plot => [plot.private_site_name,plot.private_org_name]),
    });
    const grouped = new Map();
    for (const row of rows) {
      const plot = byId.get(row.plot_id);
      const original = amount(row.total_commission);
      const hasSettlement = row.settlement_commission !== null && row.settlement_commission !== undefined;
      const proposal = hasSettlement ? Number(row.settlement_commission) : original;
      if (!Number.isFinite(proposal) || proposal < 0 || proposal > original) unavailable();
      const rawApproval = String(plot.settlement_approval_status || 'approved').trim().toLowerCase();
      const settlementApprovalStatus = hasSettlement ? (['approved','rejected'].includes(rawApproval) ? rawApproval : 'pending') : null;
      const effective = hasSettlement && settlementApprovalStatus === 'approved' ? proposal : original;
      const bookingStatus = String(plot.status || 'BOOKED').trim().toUpperCase();
      const historicalBooking = hasSettlement || ['CANCEL','CANCELLATION','CANCELLED','RESALE','TRANSFERRED'].includes(bookingStatus);
      if (!grouped.has(plot.id)) grouped.set(plot.id, {
        plotId: presentation.propertyId(plot.id), plotNumber: presentation.plotNumber(plot.plot_no),
        plotSize: amount(plot.plot_size), plotSizeUnit: ['flat','shop'].includes(plot.unit_type) ? 'sq ft' : 'sq yd',
        propertyType: plot.unit_type === 'shop' ? 'SHOP' : plot.unit_type === 'flat' ? 'FLAT' : 'PLOT',
        buyerName: presentation.redact(plot.current_client_name || plot.ledger_buyer_name || 'Client').trim() || 'Client',
        bookingStatus, bookingDate: plot.booking_date ? String(plot.booking_date).slice(0,10) : null,
        historicalBooking, originalCommission: 0, settlementAmount: null, settlementKind: null,
        settlementApprovalStatus: null, proposedSettlementAmount: 0,
        settlementPercentage: null, settledAt: null,
        totalAmount: 0, receivedAmount: 0, tdsAmount: 0, paidOutAmount: 0, recoveredAmount: 0, allocations: [],
      });
      const value = grouped.get(plot.id);
      const percentage = row.allocation_type === 'percentage' && Number.isFinite(Number(row.allocation_value))
        && row.allocation_value !== null && Number(row.allocation_value) > 0 && Number(row.allocation_value) <= 100;
      value.allocations.push({
        type: percentage ? 'percentage' : 'amount',
        value: percentage ? Number(row.allocation_value) : original,
        amount: amount(effective), originalAmount: original,
      });
      value.totalAmount = amount(value.totalAmount + amount(effective));
      value.originalCommission = amount(value.originalCommission + original);
      value.proposedSettlementAmount = amount(value.proposedSettlementAmount + amount(proposal));
      value.historicalBooking ||= historicalBooking;
      if (hasSettlement) {
        value.settlementKind = 'manual';
        value.settlementApprovalStatus = settlementApprovalStatus;
        value.settledAt = row.settled_at || value.settledAt;
      }
      value.receivedAmount = amount(value.receivedAmount + amount(row.received_amount));
      value.tdsAmount = amount(value.tdsAmount + amount(row.tds_amount));
      const net = amount(Number(row.received_amount) + Number(row.tds_amount));
      value.paidOutAmount = amount(value.paidOutAmount + (row.paid_out_amount == null ? Math.max(0,net) : amount(row.paid_out_amount)));
      value.recoveredAmount = amount(value.recoveredAmount + (row.recovered_amount == null ? Math.max(0,-net) : amount(row.recovered_amount)));
    }
    const commissions = [...grouped.values()].map(value => {
      const paidAmount = amount(value.receivedAmount + value.tdsAmount);
      const remainingAmount = amount(Math.max(0,value.totalAmount - paidAmount));
      const extraPaidAmount = amount(Math.max(0,paidAmount - value.totalAmount));
      const approvalBlocked = value.settlementApprovalStatus && value.settlementApprovalStatus !== 'approved';
      const recoverableAmount = approvalBlocked ? 0 : amount(Math.min(extraPaidAmount,Math.max(0,value.receivedAmount)));
      const tdsAdjustmentAmount = approvalBlocked ? 0 : amount(extraPaidAmount - recoverableAmount);
      const { proposedSettlementAmount, ...publicValue } = value;
      return { ...publicValue, settlementAmount: value.settlementKind ? proposedSettlementAmount : null, paidAmount, remainingAmount, extraPaidAmount, recoverableAmount,tdsAdjustmentAmount,
        status: extraPaidAmount > 0 ? 'overpaid' : remainingAmount <= 0 ? 'paid' : paidAmount > 0 ? 'part_paid' : 'unpaid' };
    }).sort((a,b) => a.plotNumber.localeCompare(b.plotNumber,'en',{numeric:true}) || a.plotId.localeCompare(b.plotId));
    const summary = { plotCount: commissions.length };
    for (const field of ['totalAmount','paidAmount','remainingAmount','receivedAmount','tdsAmount','extraPaidAmount','originalCommission','paidOutAmount','recoveredAmount','recoverableAmount','tdsAdjustmentAmount']) {
      summary[field] = amount(commissions.reduce((sum,row) => sum + row[field],0));
    }
    const updatedAt = new Date(now()).toISOString();
    if (detail) {
      const transactions = rows.flatMap(row => row.payment_records)
        .sort((a,b) => b.date.localeCompare(a.date) || Number(b.id) - Number(a.id))
        .map(row => projectTransaction(row,presentation));
      return { commissionVersion: 1, transactionVersion: 1, commission: commissions[0], transactions, updatedAt };
    }
    return { commissionVersion: 1, commissions, summary, updatedAt };
  };
}
