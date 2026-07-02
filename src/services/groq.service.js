/**
 * Groq AI service for intelligent OCR data extraction.
 * Uses Groq's free mixtral model to parse OCR text and extract relevant KYC fields.
 * This keeps only required data and intelligently fills form fields.
 */
// Node 18+ has a global fetch; fall back to node-fetch only if it's missing.
const fetchFn = globalThis.fetch
  ? globalThis.fetch.bind(globalThis)
  : (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const GROQ_API_KEY = process.env.GROQ_API_KEY;
// llama-3.3-70b-versatile is Groq's current free, high-quality model. Override via env.
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * Extract and classify KYC fields from OCR text using AI.
 * Returns only the fields actually found in the document. On any failure returns
 * an empty object (never dumps raw OCR text into the form).
 */
export async function extractKycFieldsWithAi(ocrText, documentType) {
  if (!GROQ_API_KEY) {
    console.warn('[groq] GROQ_API_KEY not set; skipping AI extraction');
    return {};
  }
  if (!ocrText || !String(ocrText).trim()) {
    console.warn('[groq] empty OCR text; skipping AI extraction');
    return {};
  }

  const prompt = buildExtractionPrompt(ocrText, documentType);

  try {
    const response = await fetchFn(GROQ_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: 'You are a precise KYC data extraction engine. You always reply with a single valid JSON object and nothing else.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 600,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('[groq] API error:', response.status, error);
      return {};
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    const parsed = parseAiResponse(content, documentType);
    console.log(`[groq] extracted ${Object.keys(parsed).join(', ')} for ${documentType}`);
    return parsed;
  } catch (err) {
    console.error('[groq] extraction failed:', err.message);
    return {};
  }
}

/**
 * Build a prompt that extracts only relevant fields for the document type.
 */
function buildExtractionPrompt(text, type) {
  const fieldsByType = {
    AADHAAR: [
      'name (full name from Aadhaar)',
      'aadhaar_number (12-digit number)',
      'dob (date of birth in DD/MM/YYYY)',
      'gender',
      'address (full address line)',
      'city',
      'state',
      'pincode (6-digit PIN code)',
    ],
    PAN: [
      'name (full name from PAN)',
      'pan_number (10-character PAN)',
      'dob (date of birth if visible)',
      'father_name',
      'address (if visible on card)',
      'city',
    ],
    VOTER_ID: [
      'name',
      'voter_id_number',
      'dob',
      'gender',
      'address (full address)',
      'city',
      'state',
      'pincode',
    ],
    PASSPORT: [
      'name',
      'passport_number',
      'dob',
      'gender',
      'nationality',
      'address (if visible)',
    ],
    DL: [
      'name',
      'dl_number (driving license number)',
      'dob',
      'gender',
      'address (full address from DL)',
      'city',
      'state',
      'pincode',
    ],
    DOMICILE: [
      'name',
      'certificate_number (domicile / serial / registration number on the certificate)',
      'issue_date (DD/MM/YYYY)',
      'district',
      'state',
    ],
    INCOME: [
      'name',
      'certificate_number (income certificate / serial number)',
      'annual_income (amount in rupees)',
      'issue_date (DD/MM/YYYY)',
      'district',
      'state',
    ],
  };

  const fields = fieldsByType[type] || ['name', 'dob', 'address'];

  return `You are extracting structured KYC data from raw OCR text of an Indian identity document.
The OCR text may be noisy, contain Hindi/Devanagari garble, or have words out of order — use your knowledge of how Indian IDs are laid out to reconstruct correct values.

Document type: ${type}
Extract these fields (snake_case JSON keys): ${fields.join(', ')}

Rules:
- Return a single JSON object. Use an empty string "" for any field you cannot confidently read.
- For "address": reconstruct a clean, properly ordered single-line address (house/street, locality, area). Do NOT include city, state or pincode in the address — put those in their own fields.
- "city" = town/district, "state" = Indian state name, "pincode" = 6 digits only.
- Keep "dob" in DD/MM/YYYY if visible.
- Do not invent values that are not supported by the text.

OCR Text:
"""
${text}
"""

Return only the JSON object:`;
}

/**
 * Parse Groq's response and normalize field names to booking form schema.
 */
function parseAiResponse(content, documentType) {
  try {
    // Extract JSON from response (may have extra text)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};

    const extracted = JSON.parse(jsonMatch[0]);
    return normalizeExtracted(extracted, documentType);
  } catch (err) {
    console.error('[groq] failed to parse response:', err.message);
    return {};
  }
}

/**
 * Normalize a raw extracted-field object (from a text OR vision model) to the booking
 * form's field names, dropping anything empty. Shared by the text extractor and the
 * in-process vision OCR engine so both produce identical field shapes.
 */
export function normalizeExtracted(extracted, documentType) {
  try {
    if (!extracted || typeof extracted !== 'object') return {};

    // Normalize to booking form field names
    const normalized = {
      name: extracted.name || extracted.full_name || '',
      father_name: extracted.father_name || '',
      dob: formatDob(extracted.dob || extracted.date_of_birth || ''),
      address: extracted.address || '',
      city: extracted.city || extracted.district || '',
      state: extracted.state || '',
      pincode: extracted.pincode || extracted.pin || '',
      gender: extracted.gender || '',
      mobile: extracted.mobile || extracted.phone || '',
    };

    // Document-type-specific fields
    switch (documentType) {
      case 'AADHAAR':
        normalized.aadhaar = extracted.aadhaar_number || extracted.aadhaar || '';
        break;
      case 'PAN':
        normalized.pan = extracted.pan_number || extracted.pan || '';
        normalized.father_name = extracted.father_name || '';
        break;
      case 'VOTER_ID':
        normalized.voter_id = extracted.voter_id_number || extracted.voter_id || '';
        break;
      case 'PASSPORT':
        normalized.passport = extracted.passport_number || extracted.passport || '';
        normalized.nationality = extracted.nationality || '';
        break;
      case 'DL':
        normalized.dl = extracted.dl_number || extracted.dl || '';
        break;
      case 'DOMICILE':
        normalized.domicile_no = extracted.certificate_number || extracted.domicile_no || extracted.certificate_no || extracted.serial_number || '';
        normalized.issue_date = formatDob(extracted.issue_date || '');
        normalized.village = extracted.village || '';
        normalized.tehsil = extracted.tehsil || '';
        break;
      case 'INCOME':
        normalized.income_no = extracted.certificate_number || extracted.income_no || extracted.certificate_no || extracted.serial_number || '';
        normalized.annual_income = extracted.annual_income || extracted.income || '';
        normalized.issue_date = formatDob(extracted.issue_date || '');
        break;
      case 'OTHER':
        // Property / legal documents — registry, patta, land records.
        normalized.plot_number = extracted.plot_number || extracted.plot_no || '';
        normalized.khasra_number = extracted.khasra_number || extracted.khasra_no || '';
        normalized.area = extracted.area || '';
        normalized.registry_number = extracted.registry_number || extracted.registry_no || '';
        normalized.village = extracted.village || '';
        normalized.tehsil = extracted.tehsil || '';
        normalized.date = formatDob(extracted.date || '');
        normalized.amount = extracted.amount || '';
        break;
    }

    // Remove empty fields to keep only what was found
    return Object.fromEntries(
      Object.entries(normalized).filter(([, v]) => v && String(v).trim())
    );
  } catch (err) {
    console.error('[groq] failed to normalize fields:', err.message);
    return {};
  }
}

/**
 * Normalize various date formats to ISO (YYYY-MM-DD).
 */
export function formatDob(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return '';
  dateStr = dateStr.trim();

  // DD/MM/YYYY
  const ddmmyyyy = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (ddmmyyyy) {
    const [, d, m, y] = ddmmyyyy;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  // DD-MM-YYYY
  const ddmmyyyy2 = dateStr.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (ddmmyyyy2) {
    const [, d, m, y] = ddmmyyyy2;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  // YYYY-MM-DD (already ISO)
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;

  return '';
}
