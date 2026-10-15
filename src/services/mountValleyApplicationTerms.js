export const MOUNT_VALLEY_CANCELLATION_CLAUSES = [
  'Earnest money. An amount of ₹1,00,000 (Rupees One Lakh only) paid towards the booking shall be treated as earnest money and shall be non-refundable, subject to applicable law.',
  'Cancellation at the applicant’s request. If the applicant requests cancellation of the allotted plot, 30% (thirty per cent) of the total amount collected towards that plot shall be deducted as cancellation charges, subject to applicable law. The cancellation request must be submitted in writing, together with the relevant payment references. Non-allotment refunds, where applicable, shall be governed by the disclosed scheme policy and applicable law.',
];

/** Replace the old combined ₹30,000 policy in this site's copy only. Repeated
 * updates retain one copy of each clause and preserve all other clause wording. */
export function withMountValleyCancellationTerms(terms) {
  const clauses = String(terms || '').trim().split(/\n\s*(?=\d{1,2}[.)]\s)/)
    .map(clause => clause.trim().replace(/^\d{1,2}[.)]\s*/, '')).filter(Boolean);
  const isPolicy = clause => /^(Earnest money(?: and cancellation charges)?|Cancellation at the applicant[’']s request|Non-allotment, cancellation and refunds)\.\s/i.test(clause);
  const index = clauses.findIndex(isPolicy);
  const remaining = clauses.filter(clause => !isPolicy(clause));
  remaining.splice(index < 0 ? remaining.length : index, 0, ...MOUNT_VALLEY_CANCELLATION_CLAUSES);
  return remaining.map((clause, i) => `${i + 1}. ${clause}`).join('\n\n');
}
