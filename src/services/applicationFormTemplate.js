import { workflowError } from './drawWorkflow.js';

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
export function validateApplicationTemplate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw workflowError('A form template is required');
  const allowed = new Set([...Object.keys(TEMPLATE_TEXT_FIELDS), 'accent_color', 'heading_font', 'body_font', 'image_height', 'features']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw workflowError(`Unknown template field: ${key}`);
  const out = {};
  for (const [key, limit] of Object.entries(TEMPLATE_TEXT_FIELDS)) {
    const value = input[key] ?? '';
    if (typeof value !== 'string' || value.length > limit) throw workflowError(`${key} must contain at most ${limit} characters`);
    out[key] = value.trim();
    if (urlFields.has(key) && value && !/^(https?:\/\/|\/[^/])/i.test(value)) throw workflowError('Images must use an http(s) URL or a local image path');
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(input.accent_color || '')) throw workflowError('Choose a valid accent colour');
  if (!['Georgia', 'Times New Roman', 'Arial'].includes(input.heading_font)) throw workflowError('Choose a supported heading font');
  if (!['Arial', 'Helvetica Neue', 'Georgia'].includes(input.body_font)) throw workflowError('Choose a supported body font');
  if (![80, 90, 96, 105].includes(Number(input.image_height))) throw workflowError('Choose a supported artwork height');
  if (!Array.isArray(input.features) || input.features.length > 4) throw workflowError('Use up to four commercial highlights');
  out.features = input.features.map(feature => {
    if (!feature || typeof feature.title !== 'string' || feature.title.length > 80 || typeof feature.body !== 'string' || feature.body.length > 300) throw workflowError('Each highlight needs a title (80 characters) and description (300 characters)');
    return { title: feature.title.trim(), body: feature.body.trim() };
  });
  Object.assign(out, { accent_color:input.accent_color, heading_font:input.heading_font, body_font:input.body_font, image_height:Number(input.image_height) });
  if ((out.terms.match(/\n/g) || []).length > 24) throw workflowError('Use up to 25 lines of terms; separate numbered clauses with a blank line');
  return out;
}

export function requirePublishableTemplate(template) {
  for (const key of ['form_title', 'brand_name', 'terms_title', 'terms', 'commercial_title', 'commercial_heading', 'commercial_description', 'commercial_image', 'slip_title', 'token_title']) {
    if (!template[key]?.trim()) throw workflowError(`Complete ${key.replaceAll('_', ' ')} before publishing`);
  }
}
