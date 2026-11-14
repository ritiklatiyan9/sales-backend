import { workflowError } from './drawWorkflow.js';

export const BOOKING_FORM_FIELDS = {
  form_title:100, subtitle:180, brand_name:160, legal_name:255, contact_line:500,
  logo_url:1000, cover_image:1000, cover_caption:180, cover_note:500, footer_text:160,
  applicant_title:100, related_title:100, property_title:100, kyc_title:100,
  declarations_title:100, declarations:3800, terms_title:100, terms:3800,
  office_title:100, acceptance_note:500, payment_note:600,
  applicant_signature:100, office_signature:100, signatory_name:120, signatory_designation:120,
};

export function validateBookingTemplate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw workflowError('A booking form template is required');
  const allowed = new Set([...Object.keys(BOOKING_FORM_FIELDS), 'form_type', 'installment_dates', 'accent_color', 'heading_font', 'body_font', 'design']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw workflowError(`Unknown template field: ${key}`);
  const out = {};
  if (Object.hasOwn(input, 'form_type')) {
    if (!['booking', 'booking_allotment'].includes(input.form_type)) throw workflowError('Choose a supported booking form type');
    out.form_type = input.form_type;
  }
  if (Object.hasOwn(input, 'installment_dates')) {
    const dates = input.installment_dates;
    const validDate = value => {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const parsed = new Date(`${value}T00:00:00.000Z`);
      return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    };
    if (!Array.isArray(dates) || dates.length !== 4 || !Array.from(dates).every(validDate)
      || dates.some((date, index) => index > 0 && date <= dates[index - 1])) {
      throw workflowError('Provide four valid installment dates in YYYY-MM-DD format, in strictly increasing order');
    }
    out.installment_dates = [...dates];
  }
  for (const [key, limit] of Object.entries(BOOKING_FORM_FIELDS)) {
    const value = input[key] ?? '';
    if (typeof value !== 'string' || value.length > limit) throw workflowError(`${key.replaceAll('_', ' ')} must contain at most ${limit} characters`);
    out[key] = value.trim();
  }
  for (const key of ['logo_url', 'cover_image']) {
    if (out[key] && !/^(https?:\/\/|\/[^/])/i.test(out[key])) throw workflowError('Images must use an http(s) URL or a local image path');
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(input.accent_color || '')) throw workflowError('Choose a valid accent colour');
  if (!['Georgia', 'Times New Roman', 'Arial'].includes(input.heading_font)) throw workflowError('Choose a supported heading font');
  if (!['Arial', 'Helvetica Neue', 'Georgia'].includes(input.body_font)) throw workflowError('Choose a supported body font');
  if (!['classic', 'modern', 'minimal'].includes(input.design)) throw workflowError('Choose a supported design');
  for (const key of ['declarations', 'terms']) {
    if ((out[key].match(/\n/g) || []).length > 24) throw workflowError(`Use up to 25 lines for ${key}; separate clauses with a blank line`);
  }
  return { ...out, accent_color:input.accent_color, heading_font:input.heading_font, body_font:input.body_font, design:input.design };
}

export function requirePublishableBookingTemplate(template) {
  if (template.form_type === 'booking_allotment' && (!Array.isArray(template.installment_dates) || template.installment_dates.length !== 4)) {
    throw workflowError('Complete all four installment dates before publishing a Booking Cum Allotment Form');
  }
  for (const key of ['form_title','brand_name','applicant_title','related_title','property_title','kyc_title','declarations_title','declarations','terms_title','terms','office_title','acceptance_note']) {
    if (!template[key]?.trim()) throw workflowError(`Complete ${key.replaceAll('_', ' ')} before publishing`);
  }
}
