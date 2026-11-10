import { createBrokerMobileAuthService } from './brokerMobileAuth.service.js';
import { createMobileFinancialReader, projectMobilePlot, mobileCurrentOwnerSql } from './mobilePortal.service.js';
import { createBrokerPresentation, isBrokerPropertyId } from './brokerPresentation.service.js';
import { createBrokerBookingProgressReader } from './brokerBookingProgress.service.js';
import { createBrokerCommissionReader } from './brokerCommission.service.js';

const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
const amount = value => Math.round((Number(value) || 0) * 100) / 100;
const active = alias => `(COALESCE(to_jsonb(${alias})->>'is_active','true') <> 'false'
  AND upper(trim(COALESCE(to_jsonb(${alias})->>'status','ACTIVE'))) NOT IN ('INACTIVE','BLOCKED','DISABLED','DEACTIVATED','DELETED','SUSPENDED'))`;
const brokerRole = alias => `'BROKER'=ANY(COALESCE(${alias}.member_types,ARRAY[${alias}.member_type]))`;
const clientRole = alias => `'CLIENT'=ANY(COALESCE(${alias}.member_types,ARRAY[${alias}.member_type]))`;
// Exact buyer pointer first, otherwise the latest current booking; never infer
// notification authority from a ledger buyer name or an older booking.
const reminderEligibilitySql = `upper(trim(COALESCE(p.status,''))) IN ('BOOKED','SOLD','REGISTRY','REGISTERED','UNDER CANCELLATION')
  AND EXISTS(SELECT 1 FROM members reminder_client WHERE reminder_client.id=(${mobileCurrentOwnerSql})
    AND reminder_client.site_id=p.site_id AND ${clientRole('reminder_client')} AND ${active('reminder_client')})`;
const indiaToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

// Current booking attribution is one explicit authority. Staff-created records,
// name matches, team hierarchy and a client's first referral do not grant plots.
// A member override has priority over the booking's user attribution. Even an
// invalid/moved override fails closed rather than falling back to agent_user_id.
const scopedPlotsSql = `WITH allowed_sites AS (
    SELECT s.id,s.name AS private_site_name,(SELECT o.name FROM organizations o WHERE o.id=s.organization_id) AS private_org_name FROM sites s WHERE s.id=ANY($3::integer[])
  )
  SELECT p.id,p.site_id,p.plot_no,p.plot_size,p.sale_price,p.booking_date,p.status,
    a.private_site_name,a.private_org_name,m.id AS client_id,m.full_name AS current_client_name,
    to_jsonb(p)->>'updated_at' AS access_updated_at,
    b.id AS access_booking_id,b.status AS access_booking_status,b.updated_at AS access_booking_updated_at,
    b.created_at AS access_booking_created_at,b.booking_date AS access_booking_date,
    (${reminderEligibilitySql}) AS installment_reminders_eligible,
    COALESCE((to_jsonb(p)->>'full_payment_due')::boolean,false) AS full_payment_due,
    to_jsonb(p)->>'full_payment_due_date' AS full_payment_due_date,
    COALESCE(to_jsonb(p)->>'unit_type','plot') AS unit_type,
    COALESCE((to_jsonb(p)->>'interest_enabled')::boolean,false) AS interest_enabled,
    COALESCE((to_jsonb(p)->>'interest_rate')::numeric,0) AS interest_rate,
    COALESCE(to_jsonb(p)->>'interest_type','per_month') AS interest_type
  FROM plots p JOIN allowed_sites a ON a.id=p.site_id
  JOIN LATERAL (SELECT b.id,b.client_member_id,b.booking_agent_id,b.agent_user_id,b.status,
    to_jsonb(b)->>'updated_at' AS updated_at,to_jsonb(b)->>'created_at' AS created_at,to_jsonb(b)->>'booking_date' AS booking_date
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
    s.name AS private_site_name,(SELECT o.name FROM organizations o WHERE o.id=s.organization_id) AS private_org_name,
    owner.id AS client_id,owner.full_name AS current_client_name,COALESCE(to_jsonb(p)->>'buyer_name','') AS ledger_buyer_name,
    to_jsonb(p)->>'updated_at' AS access_updated_at,
    latest_booking.id AS access_booking_id,latest_booking.status AS access_booking_status,latest_booking.updated_at AS access_booking_updated_at,
    latest_booking.created_at AS access_booking_created_at,latest_booking.booking_date AS access_booking_date,
    ((${reminderEligibilitySql}) AND owner.id=(${mobileCurrentOwnerSql})) AS installment_reminders_eligible,
    COALESCE((to_jsonb(p)->>'full_payment_due')::boolean,false) AS full_payment_due,
    to_jsonb(p)->>'full_payment_due_date' AS full_payment_due_date,
    COALESCE(to_jsonb(p)->>'unit_type','plot') AS unit_type,
    COALESCE((to_jsonb(p)->>'interest_enabled')::boolean,false) AS interest_enabled,
    COALESCE((to_jsonb(p)->>'interest_rate')::numeric,0) AS interest_rate,
    COALESCE(to_jsonb(p)->>'interest_type','per_month') AS interest_type
  FROM plots p JOIN sites s ON s.id=p.site_id
  LEFT JOIN LATERAL (
    SELECT m.id,m.full_name FROM members m WHERE m.site_id=p.site_id AND ${active('m')}
      AND CASE WHEN p.buyer_member_id IS NOT NULL THEN m.id=p.buyer_member_id ELSE
        NULLIF(BTRIM(to_jsonb(p)->>'buyer_name'),'') IS NOT NULL
        AND UPPER(BTRIM(m.full_name))=UPPER(BTRIM(to_jsonb(p)->>'buyer_name'))
        AND NOT EXISTS(SELECT 1 FROM members duplicate WHERE duplicate.site_id=p.site_id AND duplicate.id<>m.id
          AND UPPER(BTRIM(duplicate.full_name))=UPPER(BTRIM(to_jsonb(p)->>'buyer_name')))
      END
  ) owner ON true
  LEFT JOIN LATERAL (SELECT b.id,b.status,to_jsonb(b)->>'updated_at' AS updated_at,
    to_jsonb(b)->>'created_at' AS created_at,to_jsonb(b)->>'booking_date' AS booking_date
    FROM bookings b WHERE b.plot_id=p.id AND b.site_id=p.site_id ORDER BY b.id DESC LIMIT 1) latest_booking ON true
  WHERE p.site_id=ANY($2::integer[])
    AND upper(trim(COALESCE(p.status,''))) IN ('BOOKED','SOLD','REGISTRY')
    AND EXISTS(SELECT 1 FROM plot_commissions_v2 pc JOIN members bm ON bm.id=pc.agent_id AND bm.site_id=p.site_id
      WHERE pc.plot_id=p.id AND pc.site_id=p.site_id AND bm.id=ANY($1::integer[])
      AND ${brokerRole('bm')} AND ${active('bm')}
      AND lower(trim(COALESCE(pc.status,''))) IN ('pending','partial','completed'))`;

const clientColumns = `m.id,m.full_name,m.phone,m.email,m.address,m.city,m.state,m.pincode,
  s.name AS private_site_name,(SELECT o.name FROM organizations o WHERE o.id=s.organization_id) AS private_org_name`;
const safeClient = row => ({
  id: String(row.id), name: row.full_name || 'Client', phone: row.phone || '', email: row.email || '',
  address: row.address || '', city: row.city || '', state: row.state || '', pincode: row.pincode || '', plots: [],
});
// These are freeform accounting labels, not typed identity fields. Prevent an
// accidentally pasted government identifier from becoming broker-visible text.
const redactIdentityText = value => String(value || '')
  .replace(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/gi, '[private ID]')
  .replace(/(?<![0-9])(?:[0-9][ -]?){11}[0-9](?![0-9])/g, '[private ID]');


export function createBrokerMobileService(db, options = {}) {
  const { now = Date.now, includeCommissionPlots = true } = options;
  // Financial calculations, posting policy, batch queries and bounded caching
  // are shared with the client app; this instance has its own cache boundary.
  const financialsFor = createMobileFinancialReader(db, options);
  const bookingProgressFor = createBrokerBookingProgressReader(db, options);
  const auth = createBrokerMobileAuthService(db, options);
  const propertyLookups = new Map();
  const rememberProperties = (session, plots) => {
    const presentation = createBrokerPresentation(session);
    for (const [key, entry] of propertyLookups) if (entry.until <= now()) propertyLookups.delete(key);
    for (const plot of plots) {
      const key = `${session.account.id}:${presentation.propertyId(plot.id)}`;
      propertyLookups.delete(key);
      while (propertyLookups.size >= 4096) propertyLookups.delete(propertyLookups.keys().next().value);
      propertyLookups.set(key, { rawId: plot.id, until: now() + 5 * 60 * 1000 });
    }
  };
  const privateBrands = rows => rows.flatMap(row => [row.private_site_name, row.private_org_name]);
  const parameters = session => [session.userIds, session.brokerMemberIds, session.siteIds];
  async function scopedPlots(session, id, { remindersOnly = false } = {}) {
    const args = parameters(session);
    if (id !== undefined) {
      if (!/^[1-9]\d*$/.test(String(id)) || !Number.isSafeInteger(Number(id)) || Number(id)>2147483647) fail(404, 'Property unavailable.');
      args.push(Number(id));
    }
    // Notification entitlement requires an explicit current client. Historical
    // commission labels and cancelled/resale plots remain governed by the
    // existing portfolio rules, but must never produce a payment reminder.
    const reminderScope=remindersOnly?`AND (${reminderEligibilitySql})`:'';
    const querySuffix=`${id !== undefined ? 'AND p.id=$4' : ''} ${reminderScope} ORDER BY p.site_id,p.plot_no,p.id LIMIT 1001`;
    const reads=[db.query(`${scopedPlotsSql} ${querySuffix}`,args)];
    if(includeCommissionPlots){
      const commissionArgs=[session.brokerMemberIds,session.siteIds];
      if(id!==undefined)commissionArgs.push(Number(id));
      const commissionSuffix=`${id!==undefined?'AND p.id=$3':''} ${reminderScope} ORDER BY p.site_id,p.plot_no,p.id LIMIT 1001`;
      reads.push(db.query(`${commissionPlotsSql} ${commissionSuffix}`,commissionArgs));
    }
    const results=await Promise.all(reads);
    // Prefer the current Accounts buyer projection when both explicit sources
    // authorize the same plot; never use an old commission buyer snapshot.
    const byId=new Map();
    for(const result of results)for(const row of result.rows){
      // A ledger-name fallback must not replace an explicitly current booking
      // client when the commission and booking branches overlap.
      if(byId.get(row.id)?.installment_reminders_eligible===true&&row.installment_reminders_eligible!==true)continue;
      byId.set(row.id,row);
    }
    const rows=[...byId.values()].filter(row=>!remindersOnly||row.installment_reminders_eligible===true)
      .sort((a,b)=>a.site_id-b.site_id||String(a.plot_no).localeCompare(String(b.plot_no),'en',{numeric:true})||a.id-b.id);
    if (rows.length > 1000) fail(503, 'Your portfolio is temporarily unavailable.');
    if (id !== undefined && !rows.length) fail(404, 'Property unavailable.');
    return rows;
  }
  return {
    ...auth,
    features: { commissionLinkedPlots: includeCommissionPlots, confidentialPresentation: true, commissionVersion: 1 },
    commissions: createBrokerCommissionReader(db, {
      scopedPlots,
      validateSession: session => auth.getDeviceSession({ accountId: session.account.id, version: session.account.token_version, identity: session.identity }),
      now,
    }),
    async portfolio(session, { forceFresh = false, remindersOnly = false } = {}) {
      let plots = await scopedPlots(session, undefined, { remindersOnly });
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
      const presentation = createBrokerPresentation(session, { brands: privateBrands([...plots, ...rows]) });
      rememberProperties(session, plots);
      const clients = rows.map(safeClient);
      const byClient = new Map(clients.map(client => [client.id, client]));
      const financials = await financialsFor(plots.map(row => row.id), { forceFresh });
      // Finance reads can be slow. Eligibility in the mobile popup/backup plan
      // and the server worker must reflect the current buyer, broker and status
      // after those reads. Keep historical portfolio visibility unchanged.
      const current = await scopedPlots(session, undefined, { remindersOnly });
      plots = plots.map(plot=>({...plot,installment_reminders_eligible:plot.installment_reminders_eligible===true
        && current.some(row=>row.id===plot.id&&row.client_id===plot.client_id&&row.installment_reminders_eligible===true)}))
        .filter(plot=>!remindersOnly||plot.installment_reminders_eligible);
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
        const { payments, ...detail } = presentation.plot(projectMobilePlot(plot, data.schedules, data.receipts, today));
        detail.installmentRemindersEligible = plot.installment_reminders_eligible === true;
        client.plots.push(detail); projected.push(detail);
      }
      if(clients.length>1000)fail(503,'Your portfolio is temporarily unavailable.');
      const publicClients = clients.map(client => ({ ...presentation.client(client), plots: client.plots }));
      const byCollection = new Map();
      for (const client of publicClients) for (const plot of client.plots) {
        const value = byCollection.get(plot.collectionId) || { id: plot.collectionId, label: plot.collectionLabel, plotCount: 0 };
        value.plotCount++;
        byCollection.set(plot.collectionId, value);
      }
      return { presentationVersion: 3, broker: session.user, clients: publicClients, collections: [...byCollection.values()].sort((a,b)=>a.label.localeCompare(b.label)), summary: {
        clientCount: clients.length, plotCount: projected.length,
        totalAmount: amount(projected.reduce((s,p) => s+p.totalAmount,0)), paidAmount: amount(projected.reduce((s,p) => s+p.paidAmount,0)),
        balanceAmount: amount(projected.reduce((s,p) => s+p.balanceAmount,0)), interestAmount: amount(projected.reduce((s,p) => s+p.interestAmount,0)),
        totalDueAmount: amount(projected.reduce((s,p) => s+p.totalDueAmount,0)),
        upcomingCount: projected.reduce((s,p) => s+p.installments.filter(i=>i.balanceAmount>0).length,0),
        overdueCount: projected.reduce((s,p) => s+p.installments.filter(i=>i.balanceAmount>0 && i.dueDate && i.dueDate<today).length,0),
      }, updatedAt: [...financials.values()].map(row=>row.updatedAt).sort()[0] || new Date(now()).toISOString() };
    },
    async plot(session, id, { forceFresh = false } = {}) {
      if (!isBrokerPropertyId(id)) fail(404, 'Property unavailable.');
      const lookupKey = `${session.account.id}:${id}`;
      const entry = propertyLookups.get(lookupKey);
      const candidates = await scopedPlots(session, entry?.until > now() ? entry.rawId : undefined);
      const identities = createBrokerPresentation(session);
      const plot = candidates.find(row => identities.propertyId(row.id) === id);
      if (!plot) fail(404, 'Property unavailable.');
      rememberProperties(session, candidates);
      const presentation = createBrokerPresentation(session, { brands: privateBrands([plot]) });
      const scope = JSON.stringify(plot);
      const data = (await financialsFor([plot.id], { forceFresh, cacheScopes:new Map([[plot.id,scope]]) })).get(plot.id);
      const projected = projectMobilePlot(plot, data.schedules, data.receipts, indiaToday());
      const bookingProgress = await bookingProgressFor({...plot,balanceAmount:projected.balanceAmount});
      // Do not return a timeline or an old buyer's details if authority changes
      // while financial / registry records are being read.
      const current = (await scopedPlots(session,plot.id)).find(row=>row.id===plot.id);
      if (!current || JSON.stringify(current)!==scope) fail(404, 'Property unavailable.');
      await auth.getDeviceSession({accountId:session.account.id,version:session.account.token_version,identity:session.identity});
      return { plot: { ...presentation.plot(projected),
        buyerName: plot.current_client_name ? presentation.redact(plot.current_client_name) : undefined,
        installmentRemindersEligible: plot.installment_reminders_eligible === true,
        bookingProgress }, updatedAt: data.updatedAt };
    },
  };
}
