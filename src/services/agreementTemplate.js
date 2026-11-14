import { workflowError } from './drawWorkflow.js';

// Keep in sync with sales-dg-frontend/src/lib/agreementStudio.js (PRESETS / design controls).
export const AGREEMENT_PRESETS = ['dlf', 'm3m', 'ace', 'godrej', 'rera', 'blank'];
const ENUMS = {
  header_style: ['centered', 'split', 'band', 'minimal', 'none', 'application'],
  heading_style: ['classic', 'rule', 'boxed', 'modern', 'application'],
  border: ['none', 'single', 'double', 'ornate'],
};
const NUMBERS = { font_size: [8, 16], line_height: [1, 2.4], paragraph_gap: [0, 24], margin_mm: [8, 35], stamp_space_mm: [0, 160] };
const TEXTS = { watermark: 60, footer_text: 160, letterhead_brand:160, letterhead_logo_url:1000, letterhead_contact_line:500 };
const FONT = /^[A-Za-z0-9 ]{1,40}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const MAX_BODY = 500_000;

export function validateAgreementProjectOverview(value) {
  if(!value||typeof value!=='object'||Array.isArray(value))throw workflowError('Project overview must be an object');
  const limits={commercial_title:100,commercial_location:80,commercial_tagline:180,commercial_image_caption:200,commercial_description:900,commercial_disclosure:450};
  for(const key of Object.keys(value))if(!Object.hasOwn(limits,key)&&!['commercial_images','features'].includes(key))throw workflowError(`Unknown project overview field: ${key}`);
  const out={};
  for(const [key,max] of Object.entries(limits)){
    if(typeof (value[key]??'')!=='string'||(value[key]||'').length>max)throw workflowError(`${key} must contain at most ${max} characters`);
    out[key]=(value[key]||'').trim();
  }
  if(!Array.isArray(value.commercial_images)||value.commercial_images.length>3)throw workflowError('Use up to three agreement project images');
  out.commercial_images=value.commercial_images.map(url=>{
    if(typeof url!=='string'||url.length>1000||!/^(https?:\/\/|\/[^/])/i.test(url.trim()))throw workflowError('Choose a valid project image URL');
    return url.trim();
  });
  if(!Array.isArray(value.features)||value.features.length>6)throw workflowError('Use up to six project amenities');
  out.features=value.features.map(feature=>{
    if(!feature||typeof feature.title!=='string'||feature.title.length>80||typeof feature.body!=='string'||feature.body.length>300||!['roads','courtyard','retail','landscape','lighting','access','',undefined].includes(feature.icon))throw workflowError('Choose valid project amenity wording and icon');
    return {title:feature.title.trim(),body:feature.body.trim(),...(feature.icon?{icon:feature.icon}:{})};
  });
  return out;
}

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
    if(key.startsWith('letterhead_')&&input[key]==null)continue;
    const value = input[key] ?? '';
    if (typeof value !== 'string' || value.length > limit) throw workflowError(`${key.replace('_', ' ')} must contain at most ${limit} characters`);
    if(key==='letterhead_logo_url'&&value&&!/^(https?:\/\/|\/[^/])/i.test(value))throw workflowError('Choose a valid application logo URL');
    out[key] = value.trim();
  }
  out.justify = input.justify === true;
  out.page_numbers = input.page_numbers !== false;
  for(const key of ['show_project_overview','show_applicant_photo'])if(input[key]!=null){
    if(typeof input[key]!=='boolean')throw workflowError(`${key} must be on or off`);
    out[key]=input[key];
  }
  if(input.project_overview!=null)out.project_overview=validateAgreementProjectOverview(input.project_overview);
  if(out.show_project_overview&&!out.project_overview?.commercial_images.length)throw workflowError('Add a project image before showing the project overview');
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
