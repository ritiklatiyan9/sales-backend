// Only business-controlled document content belongs here. Customer and payment
// facts always come from their records, never from document settings.
export const DOCUMENT_FIELDS = {
  receipt_title: 100, draw_form_title: 100, slip_title: 100, coupon_title: 100, agreement_title: 100,
  receipt_note: 1400, draw_note: 1000, slip_note: 1000, coupon_note: 400,
  footer_text: 250, applicant_signature: 100, office_signature: 100,
  signatory_name: 120, signatory_designation: 120,
  kyc_declaration: 1600, booking_declarations: 16000, booking_rules: 16000, agreement_terms: 16000,
  project_registration: 160, approval_number: 160, approval_date: 10,
  property_type: 100,
};

export function validateDocumentConfig(value) {
  const fail = (message) => { const error = new Error(message); error.status = 400; throw error; };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Document settings must be an object');
  const clean = {};
  for (const [key, input] of Object.entries(value)) {
    if (!Object.hasOwn(DOCUMENT_FIELDS, key)) fail(`Unknown document setting: ${key}`);
    if (typeof input !== 'string') fail(`${key} must be text`);
    if (input.length > DOCUMENT_FIELDS[key]) fail(`${key} exceeds ${DOCUMENT_FIELDS[key]} characters`);
    clean[key] = input.trim();
  }
  return clean;
}
