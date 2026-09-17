// Original, editable scheme wording. No developer's proprietary contract is copied.
export const DEFAULT_DRAW_TERMS = `1. Application and scope. This application records participation in the named draw scheme. Registration, payment or a draw slip alone does not confer ownership, possession or a right to a particular shop or plot. Final allotment is subject to availability, verification and the applicable agreement for sale.

2. Applicant particulars. The applicant must provide accurate identity, address and contact information, complete KYC and disclose co-applicants where applicable. Corrections must be submitted to the office with supporting documents.

3. Payments and receipts. Pay only through the project's authorised collection channels and retain the numbered receipt. Cheques and transfers remain subject to realisation. The payment receipt acknowledges the recorded collection; it does not replace an allotment letter or sale agreement.

4. Draw participation. Entry requires the specified booking amount, completed KYC and an issued unique draw slip. Bring the slip and identity proof on the stated opening date. Staff will record the slip physically drawn and verify it before allotment. Changes to the opening date must be communicated to applicants.

5. Allotment and price. Selection in the draw is followed by identification of an available unit and written confirmation of its area, price, applicable charges and payment plan. Draw payments are credited to the allotted unit's ledger, subject to collection verification, and must not be charged twice.

6. Further payments and documents. After allotment, the applicant must follow the agreed installment schedule and execute the required documents. Taxes, duties, registration and other charges apply only as disclosed in the written price statement and as permitted by law. No oral assurance changes the signed terms.

7. Non-allotment, cancellation and refunds. An unsuccessful applicant or an applicant seeking cancellation may submit a written request with payment references. The office must communicate the applicable refund amount, permitted deductions and processing date in writing, consistent with the disclosed scheme policy, the signed agreement and applicable law. These terms do not authorise automatic forfeiture or waive statutory refund rights.

8. Project disclosures and rights. The applicant should review the project's approvals, plans, applicable registration particulars and written disclosures before final booking. Statutory rights and remedies remain available; no clause overrides mandatory law or the applicable agreement for sale.

9. Declaration and communication. The applicant confirms that the particulars are correct and that both pages have been read and understood. Contact details may be used for KYC, receipts, draw notices and booking administration. Any dispute may be raised with the project's office without prejudice to remedies before the competent authority.`;

export function workflowError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

export function money(value, label = 'Amount') {
  const raw = String(value ?? '');
  if (
    !/^\d+(\.\d{1,2})?$/.test(raw) ||
    !Number.isFinite(Number(raw)) ||
    Number(raw) <= 0 ||
    Number(raw) > 9_999_999_999_999
  ) {
    throw workflowError(
      `${label} must be a positive amount with at most two decimal places`,
    );
  }
  return Number(raw);
}

export const todayIST = (now = new Date()) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
export function validDate(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}
export function openingDate(configured, days = 10, now = new Date()) {
  const today = todayIST(now);
  if (configured) {
    if (!validDate(configured) || configured < today)
      throw workflowError(
        'Set a current or future draw opening date in Draw Settings',
      );
    return configured;
  }
  if (![10, 25].includes(Number(days)))
    throw workflowError('Choose a 10-day or 25-day draw period');
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + Number(days));
  return date.toISOString().slice(0, 10);
}
export function validatePayment(body) {
  const amount = money(body.amount);
  if (
    body.payment_date &&
    (!validDate(body.payment_date) || body.payment_date > todayIST())
  )
    throw workflowError('Payment date must be a valid date on or before today');
  const mode = body.payment_from || 'CASH';
  if (
    ![
      'CASH',
      'BANK',
      'TRANSFER',
      'CHEQUE',
      'UPI',
      'NEFT',
      'RTGS',
      'IMPS',
    ].includes(mode)
  )
    throw workflowError('Select a valid payment mode');
  if (mode === 'CHEQUE' && !String(body.cheque_no || '').trim())
    throw workflowError('Cheque number is required');
  if (
    mode !== 'CASH' &&
    mode !== 'CHEQUE' &&
    !String(body.bank_details || '').trim()
  )
    throw workflowError(
      'Transaction / UTR reference is required for non-cash payments',
    );
  return amount;
}
export function validateWinner(
  registration,
  { total, kycStatus, slipNumber, now = new Date() },
) {
  if (registration.status !== 'SLIP_ISSUED')
    throw workflowError('Only an issued draw slip can be selected', 409);
  if (
    !registration.draw_opening_date ||
    registration.draw_opening_date > todayIST(now)
  )
    throw workflowError(
      'The scheduled draw opening date has not arrived or is not configured',
      409,
    );
  if (
    String(slipNumber || '')
      .trim()
      .toUpperCase() !== registration.slip_no
  )
    throw workflowError(
      'Enter the exact slip number physically drawn from the bucket',
    );
  if (kycStatus !== 'VERIFIED')
    throw workflowError(
      'KYC must still be verified before recording a draw result',
      409,
    );
  if (
    Number(registration.required_amount) <= 0 ||
    total < Number(registration.required_amount)
  )
    throw workflowError('The booking amount is not fully paid', 409);
}

export const WORKFLOW_STAGE_SQL = `CASE
  WHEN r.status = 'CANCELLED' THEN 'CANCELLED'
  WHEN r.status = 'ALLOTTED' THEN 'BOOKED'
  WHEN r.status = 'WINNER' THEN 'ALLOTMENT'
  WHEN r.slip_no IS NOT NULL THEN 'DRAW'
  WHEN COALESCE(pay.total_paid, 0) < r.required_amount OR r.required_amount <= 0 THEN 'PAYMENT'
  WHEN COALESCE(kyc.status, '') <> 'VERIFIED' THEN 'KYC'
  ELSE 'DOCUMENTS' END`;
