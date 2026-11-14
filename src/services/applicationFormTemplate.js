import { workflowError } from './drawWorkflow.js';
import { validateApplicationPaymentPlan } from './applicationPaymentPlan.js';

export const TEMPLATE_TEXT_FIELDS = {
  form_title:100, applicant_subtitle:180, brand_name:160, legal_name:255, contact_line:500, logo_url:1000,
  terms_title:100, terms_subtitle:180, terms:4500, applicant_section:100, project_section:100,
  verification_title:140, verification_note:500,
  commercial_title:100, commercial_location:80, commercial_tagline:180, commercial_eyebrow:100,
  commercial_image:1000, commercial_image_caption:200, commercial_heading:180, commercial_description:900,
  commercial_disclosure:450, slip_title:100, slip_subtitle:180, slip_instructions_title:100, slip_instructions:1000,
  token_title:100, token_note:400, applicant_signature:100, office_signature:100, footer_text:250,
};
const urlFields = new Set(['logo_url', 'commercial_image']);
const amenityIcons = new Set(['roads', 'courtyard', 'retail', 'landscape', 'lighting', 'access']);
export function validateApplicationTemplate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw workflowError('A form template is required');
  const allowed = new Set([...Object.keys(TEMPLATE_TEXT_FIELDS), 'accent_color', 'heading_font', 'body_font', 'image_height', 'features', 'payment_plan', 'design_style', 'document_language', 'commercial_images']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw workflowError(`Unknown template field: ${key}`);
  const out = {};
  for (const [key, limit] of Object.entries(TEMPLATE_TEXT_FIELDS)) {
    const value = input[key] ?? '';
    if (typeof value !== 'string' || value.length > limit) throw workflowError(`${key} must contain at most ${limit} characters`);
    out[key] = value.trim();
    if (urlFields.has(key) && value && !/^(https?:\/\/|\/[^/])/i.test(value)) throw workflowError('Images must use an http(s) URL or a local image path');
  }
  if (input.commercial_images != null) {
    if (!Array.isArray(input.commercial_images) || input.commercial_images.length > 3) throw workflowError('Use up to three commercial images');
    out.commercial_images = input.commercial_images.map(value => {
      if (typeof value !== 'string' || !value.trim() || value.length > 1000 || !/^(https?:\/\/|\/[^/])/i.test(value.trim())) throw workflowError('Commercial images must use an http(s) URL or a local image path');
      return value.trim();
    });
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(input.accent_color || '')) throw workflowError('Choose a valid accent colour');
  if (!['Georgia', 'Times New Roman', 'Arial'].includes(input.heading_font)) throw workflowError('Choose a supported heading font');
  if (!['Arial', 'Helvetica Neue', 'Georgia'].includes(input.body_font)) throw workflowError('Choose a supported body font');
  if (![52, 60, 64, 68, 80, 90, 96, 105].includes(Number(input.image_height))) throw workflowError('Choose a supported artwork height');
  if (!Array.isArray(input.features) || input.features.length > 6) throw workflowError('Use up to six commercial amenities');
  out.features = input.features.map(feature => {
    if (!feature || typeof feature.title !== 'string' || feature.title.length > 80 || typeof feature.body !== 'string' || feature.body.length > 300) throw workflowError('Each highlight needs a title (80 characters) and description (300 characters)');
    if (feature.icon != null && feature.icon !== '' && !amenityIcons.has(feature.icon)) throw workflowError('Choose a supported commercial amenity icon');
    return { title: feature.title.trim(), body: feature.body.trim(), ...(feature.icon ? { icon: feature.icon } : {}) };
  });
  Object.assign(out, { accent_color:input.accent_color, heading_font:input.heading_font, body_font:input.body_font, image_height:Number(input.image_height) });
  if ((out.terms.match(/\n/g) || []).length > 24) throw workflowError('Use up to 25 lines of terms; separate numbered clauses with a blank line');
  if (input.payment_plan != null) out.payment_plan = validateApplicationPaymentPlan(input.payment_plan);
  if (input.design_style != null) {
    if (!['classic', 'signature'].includes(input.design_style)) throw workflowError('Choose a supported document design');
    out.design_style = input.design_style;
  }
  if (input.document_language != null) {
    if (!['en', 'en-hi'].includes(input.document_language)) throw workflowError('Choose English or English and Hindi for the document');
    out.document_language = input.document_language;
  }
  return out;
}

export function requirePublishableTemplate(template) {
  const required = {
    form_title:'Form title', brand_name:'Brand name', terms_title:'Terms page title', terms:'Terms and conditions',
    commercial_title:'Commercial name', slip_title:'Slip page title', token_title:'Token title',
  };
  for (const [key, label] of Object.entries(required)) {
    if (!template[key]?.trim()) throw workflowError(`Complete ${label} before publishing`);
  }
  if (!template.commercial_image?.trim() && !template.commercial_images?.length) throw workflowError('Complete Commercial artwork before publishing');
  const plan = template.payment_plan;
  if (plan?.enabled) {
    if (!plan.title?.trim()) throw workflowError('Complete Payment page title before publishing');
    if (plan.show_installments && !plan.installments.some(row => row.enabled && row.milestone.trim())) throw workflowError('Add a visible installment before publishing');
    if (plan.show_rental_conditions && (!plan.rental_title?.trim() || !(plan.rental_clauses.length || (plan.layout === 'detailed' && plan.rental_introduction?.trim() && plan.payout_fields?.length)))) throw workflowError('Complete the rental conditions before publishing');
  }
}
