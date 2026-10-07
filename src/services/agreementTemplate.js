import { workflowError } from './drawWorkflow.js';

// Keep in sync with sales-dg-frontend/src/lib/agreementStudio.js (PRESETS / design controls).
export const AGREEMENT_PRESETS = ['dlf', 'm3m', 'ace', 'godrej', 'rera', 'blank'];
const ENUMS = {
  header_style: ['centered', 'split', 'band', 'minimal', 'none'],
  heading_style: ['classic', 'rule', 'boxed', 'modern'],
  border: ['none', 'single', 'double', 'ornate'],
};
const NUMBERS = { font_size: [8, 16], line_height: [1, 2.4], paragraph_gap: [0, 24], margin_mm: [8, 35], stamp_space_mm: [0, 160] };
const TEXTS = { watermark: 60, footer_text: 160 };
const FONT = /^[A-Za-z0-9 ]{1,40}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const MAX_BODY = 500_000;

export function validateAgreementDesign(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw workflowError('Design settings are required');
  const out = {};
  for (const key of ['heading_font', 'body_font']) {
    if (!FONT.test(input[key] || '')) throw workflowError(`Choose a valid ${key.replace('_', ' ')}`);
    out[key] = input[key];
  }
  for (const key of ['accent_color', 'ink_color']) {
    if (!HEX.test(input[key] || '')) throw workflowError(`Choose a valid ${key.replace('_', ' ')}`);
    out[key] = input[key];
  }
  for (const [key, values] of Object.entries(ENUMS)) {
    if (!values.includes(input[key])) throw workflowError(`Choose a valid ${key.replace('_', ' ')}`);
    out[key] = input[key];
  }
  for (const [key, [min, max]] of Object.entries(NUMBERS)) {
    const value = Number(input[key]);
    if (!Number.isFinite(value) || value < min || value > max) throw workflowError(`${key.replaceAll('_', ' ')} must be between ${min} and ${max}`);
    out[key] = value;
  }
  for (const [key, limit] of Object.entries(TEXTS)) {
    const value = input[key] ?? '';
    if (typeof value !== 'string' || value.length > limit) throw workflowError(`${key.replace('_', ' ')} must contain at most ${limit} characters`);
    out[key] = value.trim();
  }
  out.justify = input.justify === true;
  out.page_numbers = input.page_numbers !== false;
  return out;
}

// Body HTML is sanitised with an allowlist wherever it is rendered (browser DOM);
// here we only enforce type and size.
export function validateAgreementTemplate(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw workflowError('Template details are required');
  const out = {};
  if (!partial || input.name !== undefined) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 120) throw workflowError('Give the format a name of up to 120 characters');
    out.name = name;
  }
  if (!partial || input.preset !== undefined) {
    if (!AGREEMENT_PRESETS.includes(input.preset)) throw workflowError('Choose a valid agreement format');
    out.preset = input.preset;
  }
  if (!partial || input.design !== undefined) out.design = validateAgreementDesign(input.design);
  if (!partial || input.body !== undefined) {
    if (typeof input.body !== 'string' || input.body.length > MAX_BODY) throw workflowError('The agreement wording is too long to save');
    out.body = input.body;
  }
  return out;
}
