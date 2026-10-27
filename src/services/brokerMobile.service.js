import { createBrokerMobileAuthService } from './brokerMobileAuth.service.js';
import { createMobileFinancialReader, projectMobilePlot } from './mobilePortal.service.js';

const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
const amount = value => Math.round((Number(value) || 0) * 100) / 100;
const active = alias => `(COALESCE(to_jsonb(${alias})->>'is_active','true') <> 'false'
  AND upper(trim(COALESCE(to_jsonb(${alias})->>'status','ACTIVE'))) NOT IN ('INACTIVE','BLOCKED','DISABLED','DEACTIVATED','DELETED','SUSPENDED'))`;
const brokerRole = alias => `'BROKER'=ANY(COALESCE(${alias}.member_types,ARRAY[${alias}.member_type]))`;
const clientRole = alias => `'CLIENT'=ANY(COALESCE(${alias}.member_types,ARRAY[${alias}.member_type]))`;
const indiaToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

// Current booking attribution is one explicit authority. Staff-created records,
// name matches, team hierarchy and a client's first referral do not grant plots.
// A member override has priority over the booking's user attribution. Even an
// invalid/moved override fails closed rather than falling back to agent_user_id.
const scopedPlotsSql = `WITH allowed_sites AS (
    SELECT s.id FROM sites s WHERE s.id=ANY($3::integer[])
  )
  SELECT p.id,p.site_id,p.plot_no,p.plot_size,p.sale_price,p.booking_date,p.status,
    m.id AS client_id,
    COALESCE((to_jsonb(p)->>'full_payment_due')::boolean,false) AS full_payment_due,
    to_jsonb(p)->>'full_payment_due_date' AS full_payment_due_date,
    COALESCE(to_jsonb(p)->>'unit_type','plot') AS unit_type,
    COALESCE((to_jsonb(p)->>'interest_enabled')::boolean,false) AS interest_enabled,
    COALESCE((to_jsonb(p)->>'interest_rate')::numeric,0) AS interest_rate,
    COALESCE(to_jsonb(p)->>'interest_type','per_month') AS interest_type
  FROM plots p JOIN allowed_sites a ON a.id=p.site_id
  JOIN LATERAL (SELECT b.id,b.client_member_id,b.booking_agent_id,b.agent_user_id,b.status
    FROM bookings b WHERE b.site_id=p.site_id AND b.plot_id=p.id ORDER BY b.id DESC LIMIT 1) b ON true
  JOIN members m ON m.id=COALESCE(p.buyer_member_id,b.client_member_id) AND m.site_id=p.site_id
  WHERE b.client_member_id=m.id AND ${clientRole('m')} AND ${active('m')}
    AND lower(trim(COALESCE(b.status,''))) NOT LIKE 'cancel%'
    AND lower(trim(COALESCE(b.status,''))) NOT IN ('deleted','void','voided','withdrawn')
    AND upper(trim(COALESCE(p.status,''))) NOT IN ('AVAILABLE','COMPANY')
    AND CASE WHEN b.booking_agent_id IS NOT NULL THEN EXISTS (
      SELECT 1 FROM members bm WHERE bm.id=b.booking_agent_id AND bm.site_id=p.site_id AND bm.id=ANY($2::integer[])
      AND ${brokerRole('bm')} AND ${active('bm')}) ELSE b.agent_user_id=ANY($1::integer[]) END`;

// Accounts stores explicit co-broker relationships in the commission master.
// The approved mobile entitlement includes those plots even when another broker
// is the primary Booking By person. Names never grant plot access here.
const commissionPlotsSql = `SELECT p.id,p.site_id,p.plot_no,p.plot_size,p.sale_price,p.booking_date,p.status,
    owner.id AS client_id,COALESCE(to_jsonb(p)->>'buyer_name','') AS ledger_buyer_name,
    COALESCE((to_jsonb(p)->>'full_payment_due')::boolean,false) AS full_payment_due,
    to_jsonb(p)->>'full_payment_due_date' AS full_payment_due_date,
    COALESCE(to_jsonb(p)->>'unit_type','plot') AS unit_type,
    COALESCE((to_jsonb(p)->>'interest_enabled')::boolean,false) AS interest_enabled,
    COALESCE((to_jsonb(p)->>'interest_rate')::numeric,0) AS interest_rate,
    COALESCE(to_jsonb(p)->>'interest_type','per_month') AS interest_type
  FROM plots p
  LEFT JOIN LATERAL (
    SELECT m.id FROM members m WHERE m.site_id=p.site_id AND ${active('m')}
      AND CASE WHEN p.buyer_member_id IS NOT NULL THEN m.id=p.buyer_member_id ELSE
        NULLIF(BTRIM(to_jsonb(p)->>'buyer_name'),'') IS NOT NULL
        AND UPPER(BTRIM(m.full_name))=UPPER(BTRIM(to_jsonb(p)->>'buyer_name'))
        AND NOT EXISTS(SELECT 1 FROM members duplicate WHERE duplicate.site_id=p.site_id AND duplicate.id<>m.id
          AND UPPER(BTRIM(duplicate.full_name))=UPPER(BTRIM(to_jsonb(p)->>'buyer_name')))
      END
  ) owner ON true
  WHERE p.site_id=ANY($2::integer[])
    AND upper(trim(COALESCE(p.status,''))) IN ('BOOKED','SOLD','REGISTRY')
    AND EXISTS(SELECT 1 FROM plot_commissions_v2 pc JOIN members bm ON bm.id=pc.agent_id AND bm.site_id=p.site_id
      WHERE pc.plot_id=p.id AND pc.site_id=p.site_id AND bm.id=ANY($1::integer[])
      AND ${brokerRole('bm')} AND ${active('bm')}
      AND lower(trim(COALESCE(pc.status,''))) IN ('pending','partial','completed'))`;

const clientColumns = `m.id,m.full_name,m.phone,m.email,m.address,m.city,m.state,m.pincode`;
const safeClient = row => ({
  id: String(row.id), name: row.full_name || 'Client', phone: row.phone || '', email: row.email || '',
  address: row.address || '', city: row.city || '', state: row.state || '', pincode: row.pincode || '', plots: [],
});
// These are freeform accounting labels, not typed identity fields. Prevent an
// accidentally pasted government identifier from becoming broker-visible text.
const redactIdentityText = value => String(value || '')
  .replace(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/gi, '[private ID]')
  .replace(/(?<![0-9])(?:[0-9][ -]?){11}[0-9](?![0-9])/g, '[private ID]');
const safePlot = plot => ({
  ...plot,
  installments: plot.installments.map(item => ({ ...item, title: redactIdentityText(item.title) })),
  payments: plot.payments.map(item => ({ ...item, reference: redactIdentityText(item.reference), mode: redactIdentityText(item.mode) })),
});

export function createBrokerMobileService(db, options = {}) {
  const { now = Date.now, includeCommissionPlots = true } = options;
  // Financial calculations, posting policy, batch queries and bounded caching
  // are shared with the client app; this instance has its own cache boundary.
  const financialsFor = createMobileFinancialReader(db, options);
  const auth = createBrokerMobileAuthService(db, options);
  const parameters = session => [session.userIds, session.brokerMemberIds, session.siteIds];
  async function scopedPlots(session, id) {
    const args = parameters(session);
    if (id !== undefined) {
      if (!/^[1-9]\d*$/.test(String(id)) || !Number.isSafeInteger(Number(id)) || Number(id)>2147483647) fail(404, 'Property unavailable.');
      args.push(Number(id));
    }
    const querySuffix=`${id !== undefined ? 'AND p.id=$4' : ''} ORDER BY p.site_id,p.plot_no,p.id LIMIT 1001`;
    const reads=[db.query(`${scopedPlotsSql} ${querySuffix}`,args)];
    if(includeCommissionPlots){
      const commissionArgs=[session.brokerMemberIds,session.siteIds];
      if(id!==undefined)commissionArgs.push(Number(id));
      const commissionSuffix=`${id!==undefined?'AND p.id=$3':''} ORDER BY p.site_id,p.plot_no,p.id LIMIT 1001`;
      reads.push(db.query(`${commissionPlotsSql} ${commissionSuffix}`,commissionArgs));
    }
    const results=await Promise.all(reads);
    // Prefer the current Accounts buyer projection when both explicit sources
    // authorize the same plot; never use an old commission buyer snapshot.
    const byId=new Map();
    for(const result of results)for(const row of result.rows)byId.set(row.id,row);
    const rows=[...byId.values()].sort((a,b)=>a.site_id-b.site_id||String(a.plot_no).localeCompare(String(b.plot_no),'en',{numeric:true})||a.id-b.id);
    if (rows.length > 1000) fail(503, 'Your portfolio is temporarily unavailable.');
    if (id !== undefined && !rows.length) fail(404, 'Property unavailable.');
    return rows;
  }
  return {
    ...auth,
    features: { commissionLinkedPlots: includeCommissionPlots },
    async portfolio(session, { forceFresh = false } = {}) {
      const plots = await scopedPlots(session);
      const args = parameters(session);
      args.push(plots.map(row => row.client_id));
      // Referral precedence is explicit member first, then user only when the
      // member referral is absent. Referrals expose contact, never other plots.
      const { rows } = await db.query(`SELECT ${clientColumns} FROM members m JOIN sites s ON s.id=m.site_id
        WHERE s.id=ANY($3::integer[]) AND ${active('m')}
        AND (m.id=ANY($4::integer[]) OR (${clientRole('m')} AND CASE WHEN m.referred_by_member_id IS NOT NULL THEN EXISTS (
          SELECT 1 FROM members bm WHERE bm.id=m.referred_by_member_id AND bm.site_id=m.site_id AND bm.id=ANY($2::integer[])
          AND ${brokerRole('bm')} AND ${active('bm')}) ELSE m.referred_by_user_id=ANY($1::integer[]) END))
        ORDER BY lower(m.full_name),m.id LIMIT 1001`, args);
      if (rows.length > 1000) fail(503, 'Your portfolio is temporarily unavailable.');
      const clients = rows.map(safeClient);
      const byClient = new Map(clients.map(client => [client.id, client]));
      const financials = await financialsFor(plots.map(row => row.id), { forceFresh });
      const today = indiaToday();
      const projected = [];
      for (const plot of plots) {
        let client = byClient.get(String(plot.client_id));
        if (!client) {
          // Plot authority is explicit even when its current client record is
          // unlinked, inactive or ambiguous. Show ledger identity only; never
          // borrow contact details from a guessed/historical member.
          client={id:`plot-owner:${plot.id}`,name:redactIdentityText(plot.ledger_buyer_name).trim()||'Client',
            phone:'',email:'',address:'',city:'',state:'',pincode:'',plots:[]};
          clients.push(client);byClient.set(client.id,client);
        }
        const data = financials.get(plot.id);
        const { payments, ...detail } = safePlot(projectMobilePlot(plot, data.schedules, data.receipts, today));
        client.plots.push(detail); projected.push(detail);
      }
      if(clients.length>1000)fail(503,'Your portfolio is temporarily unavailable.');
      return { broker: session.user, clients, summary: {
        clientCount: clients.length, plotCount: projected.length,
        totalAmount: amount(projected.reduce((s,p) => s+p.totalAmount,0)), paidAmount: amount(projected.reduce((s,p) => s+p.paidAmount,0)),
        balanceAmount: amount(projected.reduce((s,p) => s+p.balanceAmount,0)), interestAmount: amount(projected.reduce((s,p) => s+p.interestAmount,0)),
        totalDueAmount: amount(projected.reduce((s,p) => s+p.totalDueAmount,0)),
        upcomingCount: projected.reduce((s,p) => s+p.installments.filter(i=>i.balanceAmount>0).length,0),
        overdueCount: projected.reduce((s,p) => s+p.installments.filter(i=>i.balanceAmount>0 && i.dueDate && i.dueDate<today).length,0),
      }, updatedAt: [...financials.values()].map(row=>row.updatedAt).sort()[0] || new Date(now()).toISOString() };
    },
    async plot(session, id, { forceFresh = false } = {}) {
      const [plot] = await scopedPlots(session, id);
      const data = (await financialsFor([plot.id], { forceFresh })).get(plot.id);
      return { plot: safePlot(projectMobilePlot(plot, data.schedules, data.receipts, indiaToday())), updatedAt: data.updatedAt };
    },
  };
}
