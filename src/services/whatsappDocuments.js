import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';

/**
 * PDFs that WhatsApp Studio can attach to a stage's message. Each document renders from
 * the same row the stage's lookup SQL returns, so a message and its attachment always
 * describe the same record. Add a document here and list the stages it can follow.
 */

// Figtree (SIL OFL, see assets/fonts/OFL.txt) is the booking app's font and has the ₹ glyph.
const FONTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../assets/fonts');

export const money = (value) => `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const formatDate = (value) => {
  if (!value) return '';
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

// Indian numbering (crore, lakh, thousand) — same wording as the printed receipt.
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const two = (n) => (n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : ''));
const three = (n) => [n >= 100 ? `${ONES[Math.floor(n / 100)]} Hundred` : '', two(n % 100)].filter(Boolean).join(' ');
function words(n) {
  for (const [size, unit, part] of [[1e7, 'Crore', words], [1e5, 'Lakh', two], [1e3, 'Thousand', two]]) {
    if (n >= size) return [`${part(Math.floor(n / size))} ${unit}`, words(n % size)].filter(Boolean).join(' ');
  }
  return three(n);
}
export function amountInWords(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return '';
  const paise = Math.round(amount * 100) % 100;
  const rupees = Math.floor(Math.round(amount * 100) / 100);
  return `Rupees ${rupees ? words(rupees) : 'Zero'}${paise ? ` and ${two(paise)} Paise` : ''} Only`;
}

// Payment receipt terms when a site has not written its own (Booking settings → Documents).
// One clause per line; *text* prints bold. Keep in sync with DEFAULT_RECEIPT_TERMS in
// sales-dg-frontend/src/lib/documentSettings.js.
export const DEFAULT_RECEIPT_TERMS = [
  '*₹1,00,000 (Rupees One Lakh only) of the booking amount is non-refundable.*',
  'This receipt acknowledges only the payment recorded above. It does not confirm allotment, ownership or possession of any property.',
  'Cheque and other banking payments are subject to clearance and confirmation of credit to the company account.',
  'Allotment, cancellation and refund requests are governed by the applicable scheme terms and issued application or agreement.',
  'Keep this receipt for your records and quote the receipt and registration numbers in all payment enquiries.',
].join('\n');
export const receiptTerms = (config = {}) => String(config.receipt_terms || DEFAULT_RECEIPT_TERMS)
  .split('\n').map((line) => line.trim()).filter(Boolean);

// Fail-soft: a missing or non-PNG/JPEG logo just leaves the header text-only.
async function fetchLogo(url) {
  if (!/^https?:\/\//i.test(url || '')) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok || !/image\/(png|jpe?g)/i.test(res.headers.get('content-type') || '')) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

// Same palette as sales-dg-frontend/src/styles/draw-receipt.css.
const C = { ink: '#13231a', body: '#2b3a31', muted: '#5d6b63', line: '#dbe3dd', soft: '#f3f7f4', accent: '#1e5d3b', dark: '#143f28', gold: '#b8893a', white: '#ffffff' };

/** A4 customer copy of a draw payment receipt, laid out like the web receipt. */
export async function renderDrawReceipt(d) {
  const s = d.settings || {};
  const config = s.document_config || {};
  const logo = await fetchLogo(s.logo_url);
  const reference = d.receipt_no || `Payment #${d.id}`;
  const company = s.company_legal_name || s.company_brand_name || d.site_name;
  const project = d.scheme_name || d.site_name;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 44, left: 42, right: 42 }, info: { Title: `Receipt ${reference}` } });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk)).on('end', () => resolve(Buffer.concat(chunks))).on('error', reject);
    for (const [name, file] of [['R', 'Regular'], ['S', 'SemiBold'], ['B', 'Bold']]) doc.registerFont(name, path.join(FONTS, `Figtree-${file}.ttf`));
    const W = doc.page.width;
    const L = doc.page.margins.left;
    const R = W - doc.page.margins.right;
    const width = R - L;
    const text = (font, size, color, value, x, y, options = {}) => doc.font(font).fontSize(size).fillColor(color).text(value ?? '', x, y, options);
    const label = (value, x, y, w, color = C.muted, options = {}) => text('B', 6.5, color, value.toUpperCase(), x, y, { width: w, characterSpacing: 1, ...options });
    const field = (name, value, x, y, w) => {
      text('R', 7.5, C.muted, name, x, y, { width: w });
      text('S', 9.5, C.ink, value || '—', x, doc.y + 1.5, { width: w });
      return doc.y;
    };
    const rule = (y, x1 = L, x2 = R, color = C.line) => doc.moveTo(x1, y).lineTo(x2, y).lineWidth(0.8).strokeColor(color).stroke();
    const section = (title, y) => {
      const caps = title.toUpperCase();
      doc.font('B').fontSize(7.5);
      const titleWidth = doc.widthOfString(caps, { characterSpacing: 1.3 });
      text('B', 7.5, C.accent, caps, L, y, { characterSpacing: 1.3, lineBreak: false });
      rule(y + 4.5, L + titleWidth + 10, R);
      return y + 16;
    };

    // Brand band across the top: green bar with a gold hairline.
    doc.rect(0, 0, W, 7).fill(doc.linearGradient(0, 0, W, 0).stop(0, C.dark).stop(1, C.accent));
    doc.rect(0, 7, W, 1.6).fill(C.gold);

    // Letterhead (left) and receipt badge (right)
    const top = 34;
    const badgeW = 150;
    const badgeX = R - badgeW;
    const headX = logo ? L + 84 : L;
    const headW = badgeX - 16 - headX;
    if (logo) { try { doc.image(logo, L, top + 2, { fit: [72, 52] }); } catch { /* unsupported image */ } }
    text('B', 17, C.dark, s.company_brand_name || d.site_name || '', headX, top, { width: headW });
    if (s.company_legal_name) text('S', 8.5, C.ink, s.company_legal_name, headX, doc.y + 2, { width: headW });
    for (const line of [
      [s.company_address, s.company_city].filter(Boolean).join(', '),
      [s.company_phone, s.company_email, s.company_website].filter(Boolean).join(' · '),
      s.company_gstin && `GSTIN: ${s.company_gstin}`,
      config.project_registration && `Project registration: ${config.project_registration}`,
    ].filter(Boolean)) text('R', 7.8, C.muted, line, headX, doc.y + 1.5, { width: headW });
    const headBottom = doc.y;
    const badgeH = 84;
    doc.roundedRect(badgeX, top - 4, badgeW, badgeH, 8).lineWidth(0.8).fillAndStroke(C.soft, C.line);
    label('Receipt', badgeX + 12, top + 6, badgeW - 24, C.accent, { characterSpacing: 1.6 });
    const badgeNext = field('Receipt number', reference, badgeX + 12, doc.y + 6, badgeW - 24);
    field('Receipt date', formatDate(d.payment_date), badgeX + 12, badgeNext + 6, badgeW - 24);
    let y = Math.max(headBottom, top - 4 + badgeH, logo ? top + 56 : 0) + 12;
    rule(y);

    // Title + customer-copy pill
    y += 14;
    text('B', 19, C.ink, config.receipt_title || 'Booking payment receipt', L, y, { width: width - 110 });
    text('R', 8.5, C.muted, 'Acknowledgement of pre-allotment collection', L, doc.y + 2, { width: width - 110 });
    const titleBottom = doc.y;
    const pillW = 88;
    doc.roundedRect(R - pillW, titleBottom - 16, pillW, 16, 8).lineWidth(0.9).stroke(C.accent);
    label('Customer copy', R - pillW, titleBottom - 11.3, pillW, C.accent, { align: 'center' });
    y = titleBottom + 14;

    if (d.registration_status === 'CANCELLED') {
      const notice = 'Registration cancelled. This receipt is a historical record of collection and is not proof of a refund.';
      doc.font('S').fontSize(8.5);
      const noticeH = doc.heightOfString(notice, { width: width - 20 }) + 12;
      doc.roundedRect(L, y, width, noticeH, 6).lineWidth(0.8).fillAndStroke('#fff7ed', '#e9c9a6');
      text('S', 8.5, '#7c2d12', notice, L + 10, y + 6, { width: width - 20 });
      y += noticeH + 10;
    }

    // Customer card (left) and amount card (right)
    const gap = 10;
    const pad = 12;
    const leftW = (width - gap) * 0.56;
    const rightW = width - gap - leftW;
    const rightX = L + leftW + gap;
    doc.font('B').fontSize(14);
    const nameH = doc.heightOfString(d.full_name || '—', { width: leftW - pad * 2 });
    doc.font('R').fontSize(8);
    const wordsH = doc.heightOfString(amountInWords(d.amount), { width: rightW - pad * 2 });
    const cardH = Math.max(pad + 12 + nameH + (d.phone ? 14 : 0) + 46 + pad, pad + 12 + 28 + wordsH + 30 + pad, 108);
    doc.roundedRect(L, y, leftW, cardH, 9).lineWidth(0.8).stroke(C.line);
    doc.roundedRect(rightX, y, rightW, cardH, 9).fill(doc.linearGradient(rightX, y, rightX + rightW, y + cardH).stop(0, C.dark).stop(1, C.accent));
    doc.save();
    doc.roundedRect(rightX, y, rightW, cardH, 9).clip();
    doc.circle(rightX + rightW - 6, y + 6, 42).fillOpacity(0.07).fill(C.white);
    doc.restore();

    label('Received with thanks from', L + pad, y + pad, leftW - pad * 2);
    text('B', 14, C.ink, d.full_name || '—', L + pad, doc.y + 4, { width: leftW - pad * 2 });
    if (d.phone) text('R', 8.5, C.muted, `Mobile: ${d.phone}`, L + pad, doc.y + 2, { width: leftW - pad * 2 });
    const metaY = y + cardH - pad - 30;
    doc.save().moveTo(L + pad, metaY - 7).lineTo(L + leftW - pad, metaY - 7).dash(2, { space: 2 }).lineWidth(0.6).strokeColor(C.line).stroke().restore();
    const colW = (leftW - pad * 2 - 10) / 2;
    field('Registration number', d.registration_no, L + pad, metaY, colW);
    field('Project / scheme', project, L + pad + colW + 10, metaY, colW);

    label('Amount received', rightX + pad, y + pad, rightW - pad * 2, '#cfe3d7');
    text('B', 22, C.white, money(d.amount), rightX + pad, doc.y + 4, { width: rightW - pad * 2 });
    text('R', 8, '#e3efe7', amountInWords(d.amount), rightX + pad, doc.y + 3, { width: rightW - pad * 2 });
    const chipX = rightX + pad;
    const chipY = y + cardH - pad - 15;
    doc.roundedRect(chipX, chipY, 94, 15, 7.5).lineWidth(0.8).fillOpacity(0.16).fillAndStroke(C.white, C.gold);
    doc.fillOpacity(1);
    doc.moveTo(chipX + 8, chipY + 7.8).lineTo(chipX + 10.6, chipY + 10.4).lineTo(chipX + 14.8, chipY + 5).lineWidth(1.3).strokeColor(C.white).stroke();
    text('S', 7.5, C.white, 'Payment received', chipX + 19, chipY + 3.6, { width: 72, lineBreak: false });
    y += cardH + 14;

    // Particulars
    const amountW = 150;
    const headH = 22;
    const rowH = 46;
    const totalH = 30;
    const tableH = headH + rowH + totalH;
    doc.save();
    doc.roundedRect(L, y, width, tableH, 8).clip();
    doc.rect(L, y, width, headH).fill(C.soft);
    doc.rect(L, y + headH + rowH, width, totalH).fill(C.soft);
    doc.restore();
    doc.roundedRect(L, y, width, tableH, 8).lineWidth(0.8).stroke(C.line);
    rule(y + headH);
    rule(y + headH + rowH);
    label('Particulars', L + 12, y + 8, 200);
    label('Amount (INR)', R - amountW, y + 8, amountW - 12, C.muted, { align: 'right' });
    text('S', 10, C.ink, 'Booking registration payment', L + 12, y + headH + 11, { width: width - amountW - 24 });
    text('R', 8, C.muted, project || '', L + 12, doc.y + 2, { width: width - amountW - 24 });
    text('R', 10, C.ink, money(d.amount), R - amountW, y + headH + 11, { width: amountW - 12, align: 'right' });
    text('B', 10, C.ink, 'Total amount received', L + 12, y + headH + rowH + 10, { width: width - amountW - 24 });
    text('B', 13, C.dark, money(d.amount), R - amountW, y + headH + rowH + 8, { width: amountW - 12, align: 'right' });
    y += tableH + 16;

    // Payment details, three per row
    y = section('Payment details', y);
    const colW3 = (width - 32) / 3;
    const details = [
      ['Payment mode', d.payment_from],
      ['Transaction / cheque reference', d.cheque_no || d.bank_details],
      (d.bank_name || d.branch) && ['Bank / branch', [d.bank_name, d.branch].filter(Boolean).join(' · ')],
      ['Received / recorded by', d.received_by || d.created_by_name],
      d.required_amount != null && ['Required booking amount', money(d.required_amount)],
      d.draw_opening_date && ['Scheduled draw opening', formatDate(d.draw_opening_date)],
    ].filter(Boolean);
    for (let i = 0; i < details.length; i += 3) {
      const ends = details.slice(i, i + 3).map(([name, value], col) => field(name, value, L + col * (colW3 + 16), y, colW3));
      y = Math.max(...ends) + 9;
    }
    if (d.narration) {
      text('B', 8.5, C.ink, 'Remarks: ', L, y, { width, continued: true }).font('R').text(d.narration);
      y = doc.y + 4;
    }

    // Terms (*text* prints bold, like the web receipt)
    y = section('Terms & conditions', y + 8);
    receiptTerms(config).forEach((term, i) => {
      text('R', 8, C.body, `${i + 1}.`, L, y, { width: 14 });
      const parts = term.split(/\*([^*]+)\*/g).map((value, j) => ({ value, bold: j % 2 === 1 })).filter((part) => part.value);
      parts.forEach((part, j) => {
        doc.font(part.bold ? 'B' : 'R').fontSize(8).fillColor(part.bold ? C.dark : C.body);
        const more = j < parts.length - 1;
        if (j === 0) doc.text(part.value, L + 14, y, { width: width - 14, lineGap: 1.5, continued: more });
        else doc.text(part.value, { continued: more });
      });
      y = doc.y + 3;
    });
    if (config.receipt_note) {
      doc.font('R').fontSize(8);
      const noteH = doc.heightOfString(config.receipt_note, { width: width - 24 }) + 26;
      doc.rect(L, y + 4, width, noteH).fill(C.soft);
      doc.rect(L, y + 4, 2.5, noteH).fill(C.gold);
      text('B', 8, C.ink, 'Project acknowledgement', L + 12, y + 10, { width: width - 24 });
      text('R', 8, C.ink, config.receipt_note, L + 12, doc.y + 2, { width: width - 24 });
      y += noteH + 8;
    }

    // Sign-off
    y += 18;
    const half = (width - 28) / 2;
    const signX = L + half + 28;
    text('R', 8, C.muted, `For ${company || 'the company'}`, signX, y, { width: half, align: 'center' });
    rule(y + 40, signX + 10, R - 10, '#9aa79e');
    text('S', 9.5, C.ink, config.signatory_name || config.office_signature || 'Authorised signatory', signX, y + 46, { width: half, align: 'center' });
    text('R', 7.5, C.muted, config.signatory_designation || 'Signature / office seal', signX, doc.y + 1, { width: half, align: 'center' });
    text('S', 11, C.dark, 'Thank you for your payment.', L, y + 30, { width: half });
    text('R', 8, C.muted, 'Please retain this customer copy.', L, doc.y + 2, { width: half });

    // Footer, drawn inside the bottom margin (pdfkit would otherwise start a new page).
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const footerY = doc.page.height - 30;
    rule(footerY - 8);
    text('R', 7, C.muted, config.footer_text || 'Payment acknowledgement · Not a tax invoice', L, footerY, { width: width / 2, lineBreak: false });
    text('R', 7, C.muted, reference, L + width / 2, footerY, { width: width / 2, align: 'right', lineBreak: false });
    doc.page.margins.bottom = bottom;
    doc.end();
  });
}

/** Sample used for Meta's template review and the Studio preview. */
export const SAMPLE_RECEIPT = {
  id: 7, receipt_no: 'DRC-2026-000007', payment_date: '2026-10-20', amount: 100000, payment_from: 'UPI',
  cheque_no: 'UTR 452177889012', bank_details: null, bank_name: 'ICICI BANK', branch: 'SHAMLI',
  received_by: 'Accounts office', narration: null, created_by_name: 'Admin',
  registration_no: 'DRW-2026-000016', scheme_name: 'Diwali Draw', required_amount: 100000,
  draw_opening_date: '2026-11-05', registration_status: 'ELIGIBLE',
  full_name: 'Rahul Sharma', phone: '9876543210', site_name: 'Mount Valley Residency',
  settings: {
    company_brand_name: 'Defence Garden Group', company_legal_name: 'Defence Garden Group',
    company_address: 'Defence Garden Office', company_phone: '+91 99176 65577',
    company_website: 'www.defencegarden.com', document_config: {},
  },
};

export const DOCUMENTS = {
  DRAW_RECEIPT: {
    label: 'Payment receipt (PDF)',
    events: ['PAYMENT_RECEIVED'],
    filename: (d) => `Receipt-${d.receipt_no || d.id}.pdf`,
    render: renderDrawReceipt,
    sample: SAMPLE_RECEIPT,
  },
};
