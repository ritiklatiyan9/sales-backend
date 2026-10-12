// Shared by ordinary bookings and draw allotments through BookingModel. All plot
// assignment paths take the same row lock as website reservation/approval.
export async function assertBookingPlotAvailable(client,{plotId,siteId,bookingId=null}) {
  if (!plotId) return;
  const {rows:plots}=await client.query('SELECT id,site_id FROM plots WHERE id=$1 FOR UPDATE',[plotId]);
  if (!plots[0] || Number(plots[0].site_id)!==Number(siteId)) throw Object.assign(new Error('The selected plot does not belong to this project'),{status:409,code:'PLOT_SITE_CONFLICT'});
  const {rows:bookings}=await client.query("SELECT id FROM bookings WHERE plot_id=$1 AND status<>'CANCELLED' AND ($2::integer IS NULL OR id<>$2) LIMIT 1",[plotId,bookingId]);
  if (bookings.length) throw Object.assign(new Error('This plot already has a booking. Open the existing booking instead.'),{status:409,code:'PLOT_ALREADY_BOOKED'});
  const {rows:tables}=await client.query("SELECT to_regclass('public.website_booking_requests') AS requests_table");
  if (!tables[0]?.requests_table) return; // additive deployment / older installations
  const {rows:holds}=await client.query(`SELECT id FROM website_booking_requests WHERE plot_id=$1
    AND (status='PAYMENT_REVIEW' OR (status IN ('ORDER_CREATING','AWAITING_PAYMENT') AND hold_expires_at>now())) LIMIT 1`,[plotId]);
  if (holds.length) throw Object.assign(new Error('A website booking request is holding this plot. Review it in Website Management first.'),{status:409,code:'WEBSITE_PLOT_HELD'});
}

export async function websitePaymentForBooking(client,bookingId) {
  if(!bookingId)return null;
  const {rows:tables}=await client.query("SELECT to_regclass('public.website_booking_requests') AS requests_table");
  if(!tables[0]?.requests_table)return null;
  const {rows}=await client.query('SELECT id,plot_id,amount_paise,plot_payment_id,payment_verified_at FROM website_booking_requests WHERE booking_id=$1 AND payment_verified_at IS NOT NULL',[bookingId]);
  return rows[0]||null;
}

export async function assertWebsitePaymentImmutable(client,id,data) {
  const request=await websitePaymentForBooking(client,id);
  if(!request)return;
  const {rows}=await client.query('SELECT * FROM bookings WHERE id=$1',[id]);
  const existing=rows[0];
  for(const key of Object.keys(data)) {
    if(key!=='plot_id' && !key.startsWith('token_'))continue;
    const same=key==='plot_id'||key==='token_amount'?Number(data[key])===Number(existing[key]):String(data[key]??'')===String(existing[key]??'');
    if(!same)throw Object.assign(new Error('Captured website payment details and its plot cannot be changed here. Use Website Management and the accounting refund workflow.'),{status:409,code:'WEBSITE_PAYMENT_LOCKED'});
  }
}
