import { createBrokerPresentation } from './brokerPresentation.service.js';

const amount = value => Math.round((Number(value) || 0) * 100) / 100;
const unavailable = () => { throw Object.assign(new Error('Commission details changed. Please refresh.'), { statusCode: 503 }); };
const columns = `pc.id,pc.site_id,pc.plot_id,pc.agent_id,pc.total_commission,pc.status`;
const scope = `FROM plot_commissions_v2 pc
  JOIN members bm ON bm.id=pc.agent_id AND bm.site_id=pc.site_id
  JOIN plots p ON p.id=pc.plot_id AND p.site_id=pc.site_id
  WHERE pc.agent_id=ANY($1::integer[]) AND pc.site_id=ANY($2::integer[]) AND pc.plot_id=ANY($3::integer[])
    AND 'BROKER'=ANY(COALESCE(bm.member_types,ARRAY[bm.member_type]))
    AND COALESCE(to_jsonb(bm)->>'is_active','true')<>'false'
    AND upper(trim(COALESCE(to_jsonb(bm)->>'status','ACTIVE'))) NOT IN ('INACTIVE','BLOCKED','DISABLED','DEACTIVATED','DELETED','SUSPENDED')
    AND lower(trim(COALESCE(pc.status,''))) IN ('pending','partial','completed')`;
const authority = rows => JSON.stringify(rows.map(row => [row.id,row.site_id,row.plot_id,row.agent_id,String(row.total_commission),row.status]));

/** Accounts commission amounts belong to the enrolled member, never the whole plot or its other agents. */
export function createBrokerCommissionReader(db, { scopedPlots, validateSession, now = Date.now }) {
  return async session => {
    const plots = await scopedPlots(session);
    const args = [session.brokerMemberIds,session.siteIds,plots.map(plot => plot.id)];
    const { rows } = await db.query(`SELECT ${columns},
      COALESCE((SELECT SUM(pcp.amount) FROM plot_commission_payments pcp
        WHERE pcp.plot_commission_id=pc.id AND pcp.site_id=pc.site_id
          AND pcp.date BETWEEN DATE '1900-01-01' AND DATE '2100-12-31'
          AND financial_transaction_posts(CASE WHEN pcp.amount<0 THEN 'credit' ELSE 'debit' END,
            pcp.status,pcp.payment_mode,pcp.cheque_status)),0) AS received_amount,
      COALESCE((SELECT SUM(COALESCE((to_jsonb(pcp)->>'tds_amount')::numeric,0)) FROM plot_commission_payments pcp
        WHERE pcp.plot_commission_id=pc.id AND pcp.site_id=pc.site_id
          AND pcp.date BETWEEN DATE '1900-01-01' AND DATE '2100-12-31'
          AND financial_transaction_posts(CASE WHEN pcp.amount<0 THEN 'credit' ELSE 'debit' END,
            pcp.status,pcp.payment_mode,pcp.cheque_status)),0) AS tds_amount
      ${scope} ORDER BY pc.id LIMIT 10001`, args);
    if (rows.length > 10000) unavailable();

    // A booking can still authorize the plot after its commission is reassigned.
    // Recheck both authorities after the potentially slow Accounts payment read.
    const currentPlots = await scopedPlots(session);
    const current = (await db.query(`SELECT ${columns} ${scope} ORDER BY pc.id LIMIT 10001`, args)).rows;
    if (authority(rows) !== authority(current)) unavailable();
    const byId = new Map(plots.map(plot => [plot.id,plot]));
    const currentById = new Map(currentPlots.map(plot => [plot.id,plot]));
    for (const row of rows) if (JSON.stringify(byId.get(row.plot_id)) !== JSON.stringify(currentById.get(row.plot_id))) unavailable();
    await validateSession(session);

    const presentation = createBrokerPresentation(session, {
      brands: plots.flatMap(plot => [plot.private_site_name,plot.private_org_name]),
    });
    const grouped = new Map();
    for (const row of rows) {
      const plot = byId.get(row.plot_id);
      if (!grouped.has(plot.id)) grouped.set(plot.id, {
        plotId: presentation.propertyId(plot.id), plotNumber: presentation.plotNumber(plot.plot_no),
        plotSize: amount(plot.plot_size), plotSizeUnit: plot.unit_type === 'flat' ? 'sq ft' : 'sq yd',
        buyerName: presentation.redact(plot.current_client_name || plot.ledger_buyer_name || 'Client').trim() || 'Client',
        totalAmount: 0, receivedAmount: 0, tdsAmount: 0,
      });
      const value = grouped.get(plot.id);
      value.totalAmount = amount(value.totalAmount + amount(row.total_commission));
      value.receivedAmount = amount(value.receivedAmount + amount(row.received_amount));
      value.tdsAmount = amount(value.tdsAmount + amount(row.tds_amount));
    }
    const commissions = [...grouped.values()].map(value => {
      const paidAmount = amount(value.receivedAmount + value.tdsAmount);
      const remainingAmount = amount(Math.max(0,value.totalAmount - paidAmount));
      const extraPaidAmount = amount(Math.max(0,paidAmount - value.totalAmount));
      return { ...value, paidAmount, remainingAmount, extraPaidAmount,
        status: extraPaidAmount > 0 ? 'overpaid' : remainingAmount <= 0 ? 'paid' : paidAmount > 0 ? 'part_paid' : 'unpaid' };
    }).sort((a,b) => a.plotNumber.localeCompare(b.plotNumber,'en',{numeric:true}) || a.plotId.localeCompare(b.plotId));
    const summary = { plotCount: commissions.length };
    for (const field of ['totalAmount','paidAmount','remainingAmount','receivedAmount','tdsAmount','extraPaidAmount']) {
      summary[field] = amount(commissions.reduce((sum,row) => sum + row[field],0));
    }
    return { commissionVersion: 1, commissions, summary, updatedAt: new Date(now()).toISOString() };
  };
}
