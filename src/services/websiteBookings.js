import { createHash, createHmac, randomBytes } from 'node:crypto';
import { verifyCheckoutSignature } from './websiteRazorpay.js';
import kycCaseModel from '../models/KycCase.model.js';
import { addMemberType } from './memberRoles.service.js';

export const WEBSITE_MODULE = 'booking_website_management';
export const WEBSITE_PLOT_NUMBERS = Object.freeze([
  ...Array.from({ length: 63 }, (_, i) => `A-${i + 1}`).filter((p) => p !== 'A-44'),
  ...Array.from({ length: 62 }, (_, i) => `B-${i + 1}`),
  ...Array.from({ length: 42 }, (_, i) => `C-${i + 1}`),
  ...Array.from({ length: 34 }, (_, i) => `S${i + 1}`),
]);
const mappedNumbers = new Set(WEBSITE_PLOT_NUMBERS);
const hash = (value) => createHash('sha256').update(String(value)).digest('hex');
const ACTIVE = ['ORDER_CREATING', 'AWAITING_PAYMENT', 'PAYMENT_REVIEW'];
const DEFAULT_TERMS = 'Payment submits a booking request. Allotment is subject to payment verification, availability and approval by the company. Contact the office for cancellation and refund assistance.';
export function websiteError(message, status = 400, code = 'WEBSITE_VALIDATION') {
  return Object.assign(new Error(message), { status, code, publicMessage: message });
}
export function normalizeWebsitePlotNumber(plotNo, block = '') {
  let raw = String(plotNo || '').trim().toUpperCase().replace(/[\s_-]/g, '');
  if (/^\d+$/.test(raw) && /^[ABCS]$/i.test(String(block).trim())) raw = `${String(block).trim().toUpperCase()}${raw}`;
  const match = raw.match(/^([ABCS])0*(\d+)$/);
  if (!match || Number(match[2]) < 1) return null;
  return `${match[1]}${match[1] === 'S' ? '' : '-'}${Number(match[2])}`;
}
export function normalizeWebsiteStatus(status) {
  const value = String(status || '').trim().toUpperCase();
  return ['COMPANY', 'BOOKED', 'REGISTRY'].includes(value) ? value : 'UNKNOWN';
}
export function validateWebsiteBuyer(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw websiteError('Booking details are required');
  const name = String(body.buyer_name || '').trim().replace(/\s+/g, ' ');
  const phone = String(body.buyer_phone || '').replace(/\D/g, '').replace(/^(?:91|0)(?=[6-9]\d{9}$)/, '');
  const email = String(body.buyer_email || '').trim().toLowerCase();
  const address = String(body.buyer_address || '').trim();
  const plot = normalizeWebsitePlotNumber(body.plot_number);
  const key = String(body.idempotency_key || '');
  if (name.length < 2 || name.length > 150 || /[\u0000-\u001f<>]/.test(name)) throw websiteError('Enter a valid full name');
  if (!/^[6-9]\d{9}$/.test(phone)) throw websiteError('Enter a valid 10-digit Indian mobile number');
  if (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw websiteError('Enter a valid email address');
  if (address.length < 5 || address.length > 1000 || /[\u0000-\u001f]/.test(address)) throw websiteError('Enter your address (5–1000 characters)');
  if (!mappedNumbers.has(plot)) throw websiteError('This plot is not part of the website layout', 404, 'PLOT_NOT_FOUND');
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(key)) throw websiteError('A valid booking request key is required');
  if (body.terms_accepted !== true) throw websiteError('Accept the booking terms before paying');
  return { buyer_name: name, buyer_phone: phone, buyer_email: email, buyer_address: address, plot_number: plot, idempotency_key: key };
}

export function createWebsiteBookingService({ db, gateway, siteId, tokenSecret, clock = () => new Date() }) {
  async function tx(callback) {
    const client = await db.connect();
    try { await client.query('BEGIN'); const result = await callback(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  function linkedSiteId() {
    const id = Number(typeof siteId === 'function' ? siteId() : siteId);
    if (!Number.isInteger(id) || id <= 0) throw websiteError('The website project is not configured. Contact the office.', 503, 'WEBSITE_UNCONFIGURED');
    return id;
  }
  async function requireManager(user, selectedSiteId, client = db) {
    if (!Number.isInteger(Number(user?.id))) throw websiteError('Login required', 401, 'AUTH_REQUIRED');
    // Use current database role rather than the JWT role: access changes take effect immediately.
    const { rows: users } = await client.query('SELECT id, name, role, is_active FROM users WHERE id=$1', [user.id]);
    if (!users[0]?.is_active || !['admin', 'super_admin'].includes(String(users[0].role).toLowerCase())) {
      throw websiteError('Only company administrators can manage website bookings', 403, 'WEBSITE_FORBIDDEN');
    }
    const id = Number(selectedSiteId);
    if (!Number.isInteger(id) || id <= 0) throw websiteError('Select a valid project');
    const { rows: sites } = await client.query('SELECT id,name FROM sites WHERE id=$1', [id]);
    if (!sites[0]) throw websiteError('Project not found', 404);
    return { user: users[0], site: sites[0] };
  }
  async function settingsFor(id, client = db, lock = false) {
    const { rows } = await client.query(`SELECT w.*,s.name AS site_name FROM website_booking_settings w JOIN sites s ON s.id=w.site_id WHERE w.site_id=$1${lock ? ' FOR UPDATE OF w' : ''}`, [id]);
    if (rows[0]) return rows[0];
    const { rows: sites } = await client.query('SELECT name FROM sites WHERE id=$1', [id]);
    if (!sites[0]) throw websiteError('Project not found', 404);
    return { site_id: id, site_name: sites[0].name, booking_enabled: false, status_display_enabled: true, booking_amount: 0, hold_minutes: 15, terms: DEFAULT_TERMS };
  }
  function settingsView(settings) {
    return { ...settings, booking_amount: Number(settings.booking_amount), currency: 'INR',
      razorpay_key_id: gateway.keyId || null, payment_ready: !!gateway.ready, test_mode: /^rzp_test_/.test(gateway.keyId || ''),
      website_site_id: Number(typeof siteId === 'function' ? siteId() : siteId) || null,
      is_website_site: Number(settings.site_id) === Number(typeof siteId === 'function' ? siteId() : siteId),
    };
  }
  async function inventory(id, client = db) {
    const { rows } = await client.query(`SELECT p.id,p.site_id,p.plot_no,p.block,p.plot_size,p.sale_price,p.status,
      EXISTS(SELECT 1 FROM bookings b WHERE b.plot_id=p.id AND b.site_id=p.site_id AND b.status<>'CANCELLED') AS has_active_booking
      FROM plots p WHERE p.site_id=$1 ORDER BY p.id`, [id]);
    const groups = new Map();
    for (const plot of rows) {
      const number = normalizeWebsitePlotNumber(plot.plot_no, plot.block);
      if (!mappedNumbers.has(number)) continue;
      if (!groups.has(number)) groups.set(number, []);
      groups.get(number).push(plot);
    }
    return { groups, total: rows.length };
  }
  async function config() {
    const settings=settingsView(await settingsFor(linkedSiteId()));
    return {site_id:settings.site_id,site_name:settings.site_name,booking_enabled:settings.booking_enabled,status_display_enabled:settings.status_display_enabled,
      booking_amount:settings.booking_amount,currency:'INR',hold_minutes:settings.hold_minutes,terms:settings.terms,
      razorpay_key_id:settings.razorpay_key_id,payment_ready:settings.payment_ready,test_mode:settings.test_mode};
  }
  async function plots() {
    const id = linkedSiteId();
    const [settings, { groups }, held] = await Promise.all([
      settingsFor(id), inventory(id), db.query(`SELECT plot_id FROM website_booking_requests WHERE site_id=$1
        AND (status='PAYMENT_REVIEW' OR (status IN ('ORDER_CREATING','AWAITING_PAYMENT') AND hold_expires_at>now()))`, [id]),
    ]);
    const heldIds = new Set(held.rows.map((row) => String(row.plot_id)));
    return { site_id: id, status_display_enabled: settings.status_display_enabled, updated_at: clock().toISOString(),
      plots: WEBSITE_PLOT_NUMBERS.map((number) => {
        const candidates = groups.get(number) || [];
        // Resale history shares map numbers with the current ownership row.
        // Display the one current row, but keep duplicate identities out of checkout.
        const current = candidates.filter(plot => !['RESALE', 'CANCELLED', 'TRANSFERRED'].includes(String(plot.status || '').trim().toUpperCase()));
        const plot = current.length === 1 ? current[0] : null;
        const ledgerStatus = plot ? normalizeWebsiteStatus(plot.status) : 'UNKNOWN';
        const status = plot?.has_active_booking && ledgerStatus === 'COMPANY' ? 'BOOKED' : ledgerStatus;
        const isHeld = !!plot && heldIds.has(String(plot.id));
        return { number, status: settings.status_display_enabled ? status : 'UNKNOWN',
          bookable: candidates.length === 1 && !!plot && settings.booking_enabled && settings.status_display_enabled && gateway.ready && Number(settings.booking_amount)>0 && status==='COMPANY' && !isHeld,
          held: settings.status_display_enabled ? isHeld : false,
          area_sqyd: plot ? Number(plot.plot_size) || null : null, sale_price: plot ? Number(plot.sale_price) || null : null,
          mapped: candidates.length === 1, mapping_conflict: candidates.length > 1 };
      }),
    };
  }
  async function event(client, requestId, type, actor, detail = {}) {
    await client.query('INSERT INTO website_booking_events(request_id,event_type,actor_user_id,detail) VALUES($1,$2,$3,$4)', [requestId || null, type, actor || null, JSON.stringify(detail)]);
  }
  async function getSettings(user, id) {
    await requireManager(user, id);
    const [settings, { groups, total }] = await Promise.all([settingsFor(Number(id)), inventory(Number(id))]);
    const conflicts = [...groups].filter(([, rows]) => rows.length>1).map(([number, rows]) => ({ number, count: rows.length }));
    return { ...settingsView(settings), mapping_conflicts: conflicts,
      missing_plot_numbers: WEBSITE_PLOT_NUMBERS.filter((number) => !groups.has(number)),
      mapped_count: [...groups.values()].filter((rows) => rows.length===1).length,
      unmapped_count: total-[...groups.values()].reduce((sum, rows) => sum+rows.length, 0),
    };
  }
  async function saveSettings(user, body) {
    await requireManager(user, body.site_id);
    const amount = Number(body.booking_amount);
    const hold = Number(body.hold_minutes);
    if (typeof body.booking_enabled!=='boolean' || typeof body.status_display_enabled!=='boolean') throw websiteError('Booking and status controls must be true or false');
    if (!Number.isFinite(amount) || amount<0 || amount>10000000 || Math.abs(amount*100-Math.round(amount*100))>0.00001) throw websiteError('Booking amount must be 0–10,000,000 INR with at most two decimals');
    if (!Number.isInteger(hold) || hold<5 || hold>60) throw websiteError('Payment hold must be 5–60 minutes');
    if (body.booking_enabled && (amount<1 || !gateway.ready)) throw websiteError('Configure Razorpay and a booking amount of at least ₹1 before enabling website booking');
    if (body.booking_enabled && !body.status_display_enabled) throw websiteError('Enable live plot status before enabling online booking');
    const terms = String(body.terms ?? DEFAULT_TERMS).trim();
    if (terms.length<20 || terms.length>10000) throw websiteError('Booking terms must be 20–10,000 characters');
    await tx(async (client) => {
      await client.query(`INSERT INTO website_booking_settings(site_id,booking_enabled,status_display_enabled,booking_amount,hold_minutes,terms,updated_by)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(site_id) DO UPDATE SET booking_enabled=$2,status_display_enabled=$3,booking_amount=$4,hold_minutes=$5,terms=$6,updated_by=$7,updated_at=now()`,
      [body.site_id,body.booking_enabled,body.status_display_enabled,amount,hold,terms,user.id]);
      await event(client,null,'SETTINGS_UPDATED',user.id,{ site_id:Number(body.site_id),booking_enabled:body.booking_enabled,status_display_enabled:body.status_display_enabled,booking_amount:amount,hold_minutes:hold });
    });
    return getSettings(user, body.site_id);
  }
  function requestToken(id, key) {
    if (!tokenSecret) throw websiteError('Online booking is not configured',503,'WEBSITE_UNCONFIGURED');
    return createHmac('sha256',tokenSecret).update(`website-booking:${id}:${key}`).digest('hex');
  }
  function publicRequest(row) {
    return { status: row.booking_status==='CANCELLED' ? 'CANCELLED' : row.status, plot_number: row.plot_number, amount: Number(row.amount_paise)/100, currency: row.currency,
      payment_verified: !!row.payment_verified_at, refund_required: row.refund_required,
      expires_at: row.hold_expires_at, booking_no: row.booking_no || null,
      razorpay_order_id: row.razorpay_order_id || null, test_mode: /^rzp_test_/.test(gateway.keyId || ''),
      request_id: row.id,
      updated_at: row.updated_at,
      order: row.razorpay_order_id && ['ORDER_CREATING','AWAITING_PAYMENT'].includes(row.status) && new Date(row.hold_expires_at)>clock()
        ? { id:row.razorpay_order_id,amount:Number(row.amount_paise),currency:row.currency } : null,
      key_id: gateway.keyId || null,
    };
  }
  async function lookupToken(token, client = db, lock = false) {
    if (!/^[a-f0-9]{64}$/.test(String(token||''))) throw websiteError('Booking request not found',404,'REQUEST_NOT_FOUND');
    const { rows } = await client.query(`SELECT r.*, b.booking_no,b.status AS booking_status FROM website_booking_requests r LEFT JOIN bookings b ON b.id=r.booking_id
      WHERE r.request_token_hash=$1 AND r.site_id=$2${lock ? ' FOR UPDATE OF r' : ''}`,[hash(token),linkedSiteId()]);
    if (!rows[0]) throw websiteError('Booking request not found',404,'REQUEST_NOT_FOUND');
    return rows[0];
  }
  async function requestStatus(token) {
    const row = await lookupToken(token);
    const view = publicRequest(row);
    if (['ORDER_CREATING','AWAITING_PAYMENT'].includes(view.status) && new Date(view.expires_at)<clock()) view.status='EXPIRED';
    return view;
  }
  function orderView(row, token) {
    return { request_token: token, request_id: row.id, plot_number: row.plot_number,
      key_id: gateway.keyId, order: row.razorpay_order_id ? { id: row.razorpay_order_id,amount:Number(row.amount_paise),currency:row.currency } : null,
      expires_at:row.hold_expires_at, status:row.status, amount:Number(row.amount_paise)/100,updated_at:row.updated_at };
  }
  async function createOrder(body) {
    const input = validateWebsiteBuyer(body);
    const id = linkedSiteId();
    const token = requestToken(id,input.idempotency_key);
    const payloadHash = hash(JSON.stringify({ ...input, idempotency_key: undefined }));
    const prepared = await tx(async (client) => {
      // Lock project settings before evaluating the kill switch and plot reservation.
      const settings = await settingsFor(id,client,true);
      const existing = await client.query('SELECT * FROM website_booking_requests WHERE site_id=$1 AND idempotency_key_hash=$2 FOR UPDATE',[id,hash(input.idempotency_key)]);
      if (existing.rows[0]) {
        if (existing.rows[0].payload_hash!==payloadHash) throw websiteError('This request key was already used with different details',409,'IDEMPOTENCY_CONFLICT');
        return { row:existing.rows[0],created:false };
      }
      if (!settings.booking_enabled || !settings.status_display_enabled) throw websiteError('Online booking is currently closed. Please contact the office.',403,'BOOKING_DISABLED');
      if (!gateway.ready) throw websiteError('Online payment is not configured',503,'PAYMENT_UNAVAILABLE');
      const amountPaise = Math.round(Number(settings.booking_amount)*100);
      if (!Number.isSafeInteger(amountPaise) || amountPaise<100) throw websiteError('Booking amount must be at least 100 paise',400,'INVALID_ORDER_AMOUNT');
      const { groups } = await inventory(id,client);
      const candidates = groups.get(input.plot_number)||[];
      if (candidates.length!==1) throw websiteError('This plot requires confirmation from the office',409,'PLOT_MAPPING_CONFLICT');
      const locked = await client.query('SELECT * FROM plots WHERE id=$1 AND site_id=$2 FOR UPDATE',[candidates[0].id,id]);
      const plot = locked.rows[0];
      if(normalizeWebsitePlotNumber(plot?.plot_no,plot?.block)!==input.plot_number)throw websiteError('Plot identity changed. Refresh the map and try again.',409,'PLOT_MAPPING_CONFLICT');
      if (normalizeWebsiteStatus(plot?.status)!=='COMPANY') throw websiteError('This plot is no longer available for online booking',409,'PLOT_UNAVAILABLE');
      const booked = await client.query("SELECT id FROM bookings WHERE plot_id=$1 AND status<>'CANCELLED' LIMIT 1",[plot.id]);
      if (booked.rows.length) throw websiteError('This plot already has a booking in progress. Contact the office.',409,'PLOT_UNAVAILABLE');
      await client.query("UPDATE website_booking_requests SET status='EXPIRED',updated_at=now() WHERE plot_id=$1 AND status IN ('ORDER_CREATING','AWAITING_PAYMENT') AND hold_expires_at<=now()",[plot.id]);
      const active = await client.query('SELECT id FROM website_booking_requests WHERE plot_id=$1 AND status=ANY($2) LIMIT 1',[plot.id,ACTIVE]);
      if (active.rows.length) throw websiteError('Another booking request is holding this plot. Please choose a different plot or try later.',409,'PLOT_HELD');
      const { rows } = await client.query(`INSERT INTO website_booking_requests(site_id,plot_id,plot_number,request_token_hash,idempotency_key_hash,payload_hash,buyer_name,buyer_phone,buyer_email,buyer_address,terms_snapshot,amount_paise,hold_expires_at,gateway_receipt)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now()+$13*interval '1 minute',$14) RETURNING *`,
      [id,plot.id,input.plot_number,hash(token),hash(input.idempotency_key),payloadHash,input.buyer_name,input.buyer_phone,input.buyer_email,input.buyer_address,settings.terms,amountPaise,settings.hold_minutes,`WB-${randomBytes(16).toString('hex')}`]);
      await event(client,rows[0].id,'REQUEST_CREATED',null,{ plot_number:input.plot_number,amount_paise:Number(rows[0].amount_paise) });
      return { row:rows[0],created:true };
    });
    if (!prepared.created) {
      if (prepared.row.status==='ORDER_CREATING' && !prepared.row.razorpay_order_id) throw websiteError('This payment request is being prepared. Retry shortly; do not create another request.',409,'ORDER_PREPARING');
      if (prepared.row.status!=='AWAITING_PAYMENT' || new Date(prepared.row.hold_expires_at)<clock()) throw websiteError('This request can no longer start a payment. Check its status or contact the office.',409,'REQUEST_CLOSED');
      return orderView(prepared.row,token);
    }
    let order;
    try {
      order = await gateway.createOrder({ amount:Number(prepared.row.amount_paise),currency:'INR',receipt:prepared.row.gateway_receipt,partial_payment:false,notes:{ website_request_id:String(prepared.row.id),site_id:String(id),plot_number:input.plot_number } });
      if (!/^order_[A-Za-z0-9]+$/.test(String(order.id)) || Number(order.amount)!==Number(prepared.row.amount_paise) || order.currency!=='INR' || order.receipt!==prepared.row.gateway_receipt) throw Object.assign(websiteError('Payment provider returned an invalid order',500,'GATEWAY_ORDER_MISMATCH'),{uncertain:true});
    } catch (error) {
      // A timeout might have created an order remotely. Keep it reserved, never
      // create a duplicate on retry; webhook/admin recovery can attach that order.
      if (!error.uncertain) await db.query("UPDATE website_booking_requests SET status='PAYMENT_FAILED',gateway_error=$2,updated_at=now() WHERE id=$1 AND status='ORDER_CREATING'",[prepared.row.id,error.code||'GATEWAY_ERROR']);
      throw error;
    }
    const saved = await tx(async(client) => {
      const { rows } = await client.query("UPDATE website_booking_requests SET razorpay_order_id=$2,status=CASE WHEN status='ORDER_CREATING' THEN 'AWAITING_PAYMENT' ELSE status END,updated_at=now() WHERE id=$1 RETURNING *",[prepared.row.id,order.id]);
      await event(client,prepared.row.id,'ORDER_CREATED',null,{ order_id:order.id });
      return rows[0];
    });
    return orderView(saved,token);
  }
  async function validateGatewayPayment(row, paymentId) {
    if (!/^pay_[A-Za-z0-9]+$/.test(String(paymentId))) throw websiteError('Invalid payment reference');
    const [payment,order] = await Promise.all([gateway.fetchPayment(paymentId),gateway.fetchOrder(row.razorpay_order_id)]);
    if (payment.id!==paymentId || payment.order_id!==row.razorpay_order_id || Number(payment.amount)!==Number(row.amount_paise) || payment.currency!=='INR'
      || order.id!==row.razorpay_order_id || Number(order.amount)!==Number(row.amount_paise) || order.currency!=='INR' || order.receipt!==row.gateway_receipt) {
      throw websiteError('Payment details do not match this booking request',409,'PAYMENT_MISMATCH');
    }
    if (payment.status!=='captured' || payment.captured!==true) throw websiteError('Payment has not been captured yet. Retry verification shortly or contact the office.',409,'PAYMENT_NOT_CAPTURED');
    if (Number(payment.amount_refunded)>0) throw websiteError('This payment has been refunded. Contact the office.',409,'PAYMENT_REFUNDED');
    return payment;
  }
  async function recordCaptured(row, payment, actor = null) {
    return tx(async(client) => {
      // Consistent lock order: plot first, then request, for late-payment races.
      const { rows: plots } = await client.query('SELECT id,status FROM plots WHERE id=$1 FOR UPDATE',[row.plot_id]);
      const { rows } = await client.query('SELECT * FROM website_booking_requests WHERE id=$1 FOR UPDATE',[row.id]);
      const current = rows[0];
      if (current.razorpay_payment_id && current.razorpay_payment_id!==payment.id) throw websiteError('A different payment is already linked to this request',409,'PAYMENT_REPLAY');
      if (current.status==='APPROVED') return publicRequest({...current,booking_no:row.booking_no,booking_status:row.booking_status});
      await client.query("UPDATE website_booking_requests SET status='EXPIRED',updated_at=now() WHERE plot_id=$1 AND id<>$2 AND status IN ('ORDER_CREATING','AWAITING_PAYMENT') AND hold_expires_at<=now()",[row.plot_id,row.id]);
      const other = await client.query('SELECT id FROM website_booking_requests WHERE plot_id=$1 AND id<>$2 AND status=ANY($3)',[row.plot_id,row.id,ACTIVE]);
      const conflicting = other.rows.length>0 || normalizeWebsiteStatus(plots[0]?.status)!=='COMPANY';
      let status = current.status==='REJECTED' ? 'REJECTED' : conflicting ? 'PAYMENT_CONFLICT' : 'PAYMENT_REVIEW';
      const result = await client.query(`UPDATE website_booking_requests SET status=$2,razorpay_payment_id=$3,payment_verified_at=COALESCE(payment_verified_at,now()),payment_method=$4,refund_required=$5,updated_at=now() WHERE id=$1 RETURNING *`,
        [row.id,status,payment.id,String(payment.method||'online').slice(0,50),status==='REJECTED'||status==='PAYMENT_CONFLICT']);
      if (!current.payment_verified_at) await event(client,row.id,'PAYMENT_VERIFIED',actor,{ payment_id:payment.id,status,amount_paise:Number(row.amount_paise) });
      return publicRequest(result.rows[0]);
    });
  }
  async function verifyPayment(body) {
    if (!body || ['request_token','razorpay_order_id','razorpay_payment_id','razorpay_signature'].some(field=>typeof body[field]!=='string' || !body[field].trim())) {
      throw websiteError('Booking request token, payment ID, order ID and signature are required',400,'PAYMENT_FIELDS_REQUIRED');
    }
    const row = await lookupToken(body.request_token);
    if (!row.razorpay_order_id || body.razorpay_order_id!==row.razorpay_order_id || !verifyCheckoutSignature(row.razorpay_order_id,body.razorpay_payment_id,body.razorpay_signature,gateway.secret)) throw websiteError('Payment signature is invalid',400,'PAYMENT_SIGNATURE_INVALID');
    return recordCaptured(row,await validateGatewayPayment(row,body.razorpay_payment_id));
  }
  async function reconcilePublic(token) {
    const row = await lookupToken(token);
    if (!row.razorpay_order_id) return publicRequest(row);
    const payments = await gateway.fetchOrderPayments(row.razorpay_order_id);
    const captured = payments.items?.find(payment=>payment.status==='captured' && !Number(payment.amount_refunded));
    if (captured) await recordCaptured(row,await validateGatewayPayment(row,captured.id));
    return requestStatus(token);
  }
  async function listRequests(user,id,status) {
    await requireManager(user,id);
    const params = [id];
    let where = '';
    if (status) { params.push(String(status).toUpperCase()); where=' AND r.status=$2'; }
    const [requests,counts] = await Promise.all([
      db.query(`SELECT r.id,r.site_id,r.plot_id,r.plot_number,r.buyer_name,r.buyer_phone,r.buyer_email,r.buyer_address,r.amount_paise,r.currency,r.status,r.hold_expires_at,r.razorpay_order_id,r.razorpay_payment_id,r.gateway_receipt,r.payment_verified_at,r.payment_method,r.amount_refunded_paise,r.refund_required,r.booking_id,r.plot_payment_id,r.reviewed_at,r.review_notes,r.created_at,r.updated_at,b.booking_no,u.name AS reviewer_name
        ,b.status AS booking_status FROM website_booking_requests r LEFT JOIN bookings b ON b.id=r.booking_id LEFT JOIN users u ON u.id=r.reviewed_by WHERE r.site_id=$1${where} ORDER BY r.created_at DESC LIMIT 200`,params),
      db.query('SELECT status,count(*)::int AS count FROM website_booking_requests WHERE site_id=$1 GROUP BY status',[id]),
    ]);
    return { requests:requests.rows.map(row=>({...row,amount:Number(row.amount_paise)/100,amount_refunded:Number(row.amount_refunded_paise)/100})),counts:Object.fromEntries(counts.rows.map(row=>[row.status,row.count])) };
  }
  async function managedRequest(user,id) {
    if (!/^\d+$/.test(String(id))) throw websiteError('Request not found',404);
    const { rows } = await db.query('SELECT r.*,b.booking_no FROM website_booking_requests r LEFT JOIN bookings b ON b.id=r.booking_id WHERE r.id=$1',[id]);
    if (!rows[0]) throw websiteError('Request not found',404);
    await requireManager(user,rows[0].site_id);
    return rows[0];
  }
  async function reconcile(user,id,body = {}) {
    let row = await managedRequest(user,id);
    if (!row.razorpay_order_id) {
      // Staff can recover a provider timeout using the order id from the merchant
      // dashboard; the server checks its immutable receipt/amount/project first.
      const orderId = String(body.razorpay_order_id||'');
      if (!/^order_[A-Za-z0-9]+$/.test(orderId)) throw websiteError('Enter the Razorpay order id from the dashboard to recover this request');
      const order = await gateway.fetchOrder(orderId);
      if (order.receipt!==row.gateway_receipt || Number(order.amount)!==Number(row.amount_paise) || order.currency!=='INR') throw websiteError('That order belongs to a different request',409,'PAYMENT_MISMATCH');
      await db.query("UPDATE website_booking_requests SET razorpay_order_id=$2,status=CASE WHEN status='ORDER_CREATING' THEN 'AWAITING_PAYMENT' ELSE status END,updated_at=now() WHERE id=$1",[row.id,order.id]);
      row = {...row,razorpay_order_id:order.id};
    }
    const payments = await gateway.fetchOrderPayments(row.razorpay_order_id);
    const captured = payments.items?.find(payment=>payment.status==='captured' && !Number(payment.amount_refunded));
    if (!captured) throw websiteError('No captured, unrefunded payment was found for this order',409,'PAYMENT_NOT_CAPTURED');
    await recordCaptured(row,await validateGatewayPayment(row,captured.id),user.id);
    return listRequests(user,row.site_id);
  }
  async function approve(user,id,notes = '') {
    const row = await managedRequest(user,id);
    if (row.status==='APPROVED') return { ...publicRequest(row),booking_id:row.booking_id,plot_payment_id:row.plot_payment_id };
    if (row.status!=='PAYMENT_REVIEW' || !row.payment_verified_at || !row.razorpay_payment_id) throw websiteError('Verify a captured payment before approving this request',409,'REQUEST_NOT_READY');
    await validateGatewayPayment(row,row.razorpay_payment_id); // fresh refund/capture check before financial approval
    const reviewNotes = String(notes||'').trim();
    if (reviewNotes.length>5000) throw websiteError('Review notes are too long');
    return tx(async(client) => {
      const { rows: plots } = await client.query('SELECT * FROM plots WHERE id=$1 FOR UPDATE',[row.plot_id]);
      const { rows: requests } = await client.query('SELECT * FROM website_booking_requests WHERE id=$1 FOR UPDATE',[row.id]);
      const current = requests[0];
      if (current.status==='APPROVED') return { ...publicRequest(current),booking_id:current.booking_id,plot_payment_id:current.plot_payment_id };
      if (current.status!=='PAYMENT_REVIEW') throw websiteError('This request has already been reviewed',409,'REQUEST_CLOSED');
      if(Number(current.amount_refunded_paise)>0 || current.razorpay_payment_id!==row.razorpay_payment_id || !current.payment_verified_at)throw websiteError('Payment verification changed or a refund was recorded. Review the payment before approval.',409,'PAYMENT_REFUNDED');
      const plot = plots[0];
      if (normalizeWebsiteStatus(plot?.status)!=='COMPANY') throw websiteError('Plot availability changed. Resolve this request and its payment before approval.',409,'PLOT_UNAVAILABLE');
      const {groups}=await inventory(row.site_id,client);
      const mapped=groups.get(row.plot_number)||[];
      if(mapped.length!==1 || Number(mapped[0].id)!==Number(row.plot_id)) throw websiteError('Plot mapping changed. Resolve the duplicate plot records before approval.',409,'PLOT_MAPPING_CONFLICT');
      const existing = await client.query("SELECT id FROM bookings WHERE plot_id=$1 AND status<>'CANCELLED' LIMIT 1",[row.plot_id]);
      if (existing.rows.length) throw websiteError('This plot already has a booking. Review it before proceeding.',409,'PLOT_UNAVAILABLE');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`member_quick_add:${row.site_id}:${row.buyer_phone}`]);
      const { rows: members } = await client.query("SELECT * FROM members WHERE site_id=$1 AND RIGHT(regexp_replace(COALESCE(phone,''),'\\D','','g'),10)=$2 ORDER BY id LIMIT 1",[row.site_id,row.buyer_phone]);
      let member = members[0];
      if (member && String(member.full_name).trim().toLowerCase()!==row.buyer_name.trim().toLowerCase()) throw websiteError('This mobile number belongs to a different member. Confirm customer identity in Members before approval.',409,'MEMBER_IDENTITY_CONFLICT');
      if (member) member = await addMemberType(member,'CLIENT',client);
      if (!member) {
        const result = await client.query(`INSERT INTO members(site_id,member_type,status,full_name,phone,email,address,notes,created_by) VALUES($1,'CLIENT','ACTIVE',$2,$3,$4,$5,$6,$7) RETURNING *`,[row.site_id,row.buyer_name,row.buyer_phone,row.buyer_email,row.buyer_address,`Website booking request ${row.id}`,user.id]);
        member = result.rows[0];
      }
      const staff = await requireManager(user,row.site_id,client);
      const { rows: bookings } = await client.query(`INSERT INTO bookings(site_id,plot_id,client_member_id,sale_price,token_amount,payment_plan,status,kyc_status,buyer_name,booked_by,notes,created_by,token_payment_from,token_payment_date,token_bank_details,token_narration,token_received_by)
        VALUES($1,$2,$3,$4,$5,'FULL','KYC_PENDING','NOT_STARTED',$6,$7,$8,$9,'RAZORPAY',CURRENT_DATE,$10,$11,$7) RETURNING *`,[row.site_id,row.plot_id,member.id,Number(plot.sale_price)||0,Number(row.amount_paise)/100,row.buyer_name,staff.user.name,`Website request ${row.id}. ${reviewNotes}`,user.id,row.razorpay_payment_id,`Razorpay ${row.razorpay_payment_id}, order ${row.razorpay_order_id}`]);
      const booking = bookings[0];
      const bookingNo = `BK-${clock().getFullYear()}-${String(booking.id).padStart(6,'0')}`;
      await client.query('UPDATE bookings SET booking_no=$2 WHERE id=$1',[booking.id,bookingNo]);
      await kycCaseModel.adoptForBooking(booking,client);
      // Shared accounting approval remains authoritative: received online funds
      // are inserted once as a pending BANK instrument, never as an invented cash receipt.
      const { rows: payments } = await client.query(`INSERT INTO plot_payments(plot_id,site_id,date,payment_from,payment_type,bank_details,narration,received_by,amount,created_by,status,buyer_name,booked_by)
        VALUES($1,$2,CURRENT_DATE,'RAZORPAY','BANK',$3,$4,$5,$6,$7,'pending',$8,$5) RETURNING id`,[row.plot_id,row.site_id,row.razorpay_payment_id,`Website booking ${bookingNo}; Razorpay order ${row.razorpay_order_id}`,staff.user.name,Number(row.amount_paise)/100,user.id,row.buyer_name]);
      await client.query('UPDATE bookings SET token_payment_id=$2 WHERE id=$1',[booking.id,payments[0].id]);
      await client.query("UPDATE plots SET status='BOOKED',buyer_name=$2,booking_by=$3,booking_date=CURRENT_DATE,updated_at=now() WHERE id=$1",[row.plot_id,row.buyer_name,staff.user.name]);
      const result = await client.query("UPDATE website_booking_requests SET status='APPROVED',booking_id=$2,plot_payment_id=$3,reviewed_by=$4,reviewed_at=now(),review_notes=$5,refund_required=false,updated_at=now() WHERE id=$1 RETURNING *",[row.id,booking.id,payments[0].id,user.id,reviewNotes]);
      await event(client,row.id,'REQUEST_APPROVED',user.id,{ booking_id:booking.id,plot_payment_id:payments[0].id });
      return { ...publicRequest({...result.rows[0],booking_no:bookingNo}),booking_id:booking.id,plot_payment_id:payments[0].id };
    });
  }
  async function reject(user,id,notes) {
    const row = await managedRequest(user,id);
    const reason = String(notes||'').trim();
    if (reason.length<3 || reason.length>5000) throw websiteError('Enter a rejection reason (3–5000 characters)');
    return tx(async(client) => {
      await client.query('SELECT id FROM plots WHERE id=$1 FOR UPDATE',[row.plot_id]);
      const { rows } = await client.query('SELECT * FROM website_booking_requests WHERE id=$1 FOR UPDATE',[row.id]);
      if (rows[0].status==='APPROVED') throw websiteError('An approved booking must be cancelled through the booking workflow',409,'REQUEST_CLOSED');
      if (rows[0].status==='REJECTED') return publicRequest(rows[0]);
      const result = await client.query("UPDATE website_booking_requests SET status='REJECTED',reviewed_by=$2,reviewed_at=now(),review_notes=$3,refund_required=(payment_verified_at IS NOT NULL AND amount_refunded_paise<amount_paise),updated_at=now() WHERE id=$1 RETURNING *",[row.id,user.id,reason]);
      await event(client,row.id,'REQUEST_REJECTED',user.id,{ refund_required:result.rows[0].refund_required });
      return publicRequest(result.rows[0]);
    });
  }
  async function processWebhook(payload,eventId) {
    const refundPaymentId = payload?.payload?.refund?.entity?.payment_id;
    const entity = payload?.payload?.payment?.entity || (refundPaymentId ? await gateway.fetchPayment(refundPaymentId) : null);
    if (!entity?.order_id || !entity.id) return { ignored:true };
    const prior = await db.query('SELECT 1 FROM website_payment_webhooks WHERE event_id=$1',[eventId]);
    if (prior.rows.length) return { duplicate:true };
    const order = await gateway.fetchOrder(entity.order_id);
    const { rows } = await db.query('SELECT * FROM website_booking_requests WHERE razorpay_order_id=$1 OR gateway_receipt=$2',[entity.order_id,order.receipt]);
    const row = rows[0];
    if (!row) return { ignored:true };
    if (Number(order.amount)!==Number(row.amount_paise) || order.currency!=='INR' || order.receipt!==row.gateway_receipt) throw websiteError('Webhook order mismatch',409,'PAYMENT_MISMATCH');
    if (!row.razorpay_order_id) {
      await db.query('UPDATE website_booking_requests SET razorpay_order_id=$2,updated_at=now() WHERE id=$1 AND razorpay_order_id IS NULL',[row.id,order.id]);
      row.razorpay_order_id=order.id;
    }
    if (['payment.captured','order.paid'].includes(payload.event)) {
      await recordCaptured(row,await validateGatewayPayment(row,entity.id));
    } else if (['refund.processed','payment.refunded'].includes(payload.event)) {
      const payment = await gateway.fetchPayment(entity.id);
      if(!row.razorpay_payment_id)return {ignored:true}; // never attach a refunded attempt as a verified receipt
      if (payment.id!==row.razorpay_payment_id || payment.order_id!==row.razorpay_order_id || Number(payment.amount)!==Number(row.amount_paise) || payment.currency!=='INR') throw websiteError('Refund payment mismatch',409,'PAYMENT_MISMATCH');
      await tx(async(client)=>{
        await client.query('UPDATE website_booking_requests SET amount_refunded_paise=$2,refund_required=($2<amount_paise AND (refund_required OR status IN (\'REJECTED\',\'PAYMENT_CONFLICT\'))),updated_at=now() WHERE id=$1',[row.id,Number(payment.amount_refunded)||0]);
        await event(client,row.id,'PAYMENT_REFUND_UPDATED',null,{ amount_refunded_paise:Number(payment.amount_refunded)||0,requires_accounting_review:row.status==='APPROVED' });
      });
    }
    await db.query('INSERT INTO website_payment_webhooks(event_id,event_type) VALUES($1,$2) ON CONFLICT DO NOTHING',[eventId,String(payload.event).slice(0,60)]);
    return { received:true };
  }
  return { config,plots,getSettings,saveSettings,createOrder,requestStatus,verifyPayment,reconcilePublic,listRequests,reconcile,approve,reject,processWebhook,requireManager };
}
