import { createHash } from 'node:crypto';
import drawModel from '../models/Draw.model.js';
import { requireSiteAccess } from './bookingWorkspaceAccess.js';
import { workflowError } from './drawWorkflow.js';

// Only the complete print inputs, never audit events or unrelated account data.
const fields = ['id','site_id','registration_no','slip_no','slip_issued_at','terms_snapshot','client_name','client_booking_name','client_father','client_phone','client_email','client_aadhar','client_pan','client_photo','client_address','client_city','client_state','client_pincode','site_name','scheme_name','draw_opening_date','broker_name','broker_phone','kyc_status','plot_no','floor','allotted_plot_no','allotted_plot_block','allotted_plot_size'];
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key,stable(value[key])])) : value;
export const applicationFormHash = snapshot => createHash('sha256').update(JSON.stringify(stable(snapshot))).digest('hex');
export async function applicationSigningContext({id,user,visibleUserIds,db}) {
  const detail = await drawModel.getDetail(id,db);
  if (!detail) throw workflowError('Draw registration not found',404);
  await requireSiteAccess(user,detail.site_id,db);
  if (visibleUserIds && !visibleUserIds.includes(detail.agent_user_id) && !visibleUserIds.includes(detail.created_by)) throw workflowError('You are not authorised to sign this draw registration',403);
  if (detail.status==='CANCELLED' || !detail.slip_no || !detail.terms_snapshot) throw workflowError('An active issued application is required for signing',409);
  const [{rows:[form]},{rows:[settings]},payments] = await Promise.all([
    db.query('SELECT published,published_revision FROM application_form_templates WHERE site_id=$1',[detail.site_id]),
    db.query('SELECT * FROM project_settings WHERE site_id=$1',[detail.site_id]),
    drawModel.getPayments(id,db),
  ]);
  if (!form?.published) throw workflowError('Publish a form before collecting signatures',409);
  const draw = Object.fromEntries(fields.map(key=>[key,detail[key]??null]));
  draw.payments = payments.map(p=>({receipt_no:p.receipt_no,amount:p.amount,payment_date:p.payment_date}));
  draw.total_paid = payments.reduce((sum,p)=>sum+Math.round(Number(p.amount||0)*100),0)/100;
  draw.required_amount = Number(detail.required_amount||0);
  draw.verifyUrl = `${process.env.DRAW_PUBLIC_VERIFY_URL || 'http://localhost:5173/verify/draw'}?token=${detail.qr_token}`;
  // Round-trip dates exactly as the API will serialize them before hashing.
  const snapshot = JSON.parse(JSON.stringify({schema_version:1,template_revision:form.published_revision,template:form.published,settings:settings||{},draw}));
  return {snapshot,context_hash:applicationFormHash(snapshot)};
}
