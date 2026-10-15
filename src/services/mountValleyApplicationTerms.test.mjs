import test from 'node:test';
import assert from 'node:assert/strict';
import { withMountValleyCancellationTerms, MOUNT_VALLEY_CANCELLATION_CLAUSES } from './mountValleyApplicationTerms.js';
import { DEFAULT_DRAW_TERMS } from './drawWorkflow.js';

test('site terms replace the fixed cancellation charge with the two requested clauses', () => {
  const old = '1. Applicant. Keep the identity details accurate.\n\n2. Earnest money and cancellation charges. ₹1,00,000 is non-refundable and an additional ₹30,000 applies.\n\n3. Rights. Existing rights wording stays intact.';
  const updated = withMountValleyCancellationTerms(old);
  assert.match(updated, /₹1,00,000.*non-refundable/);
  assert.match(updated, /30% \(thirty per cent\) of the total amount collected/);
  assert.doesNotMatch(updated, /₹30,000|additional/);
  assert.match(updated, /^1\. Applicant\. Keep the identity details accurate\./);
  assert.match(updated, /4\. Rights\. Existing rights wording stays intact\.$/);
  for (const clause of MOUNT_VALLEY_CANCELLATION_CLAUSES) assert.ok(updated.includes(clause));
  assert.equal(withMountValleyCancellationTerms(updated), updated);
});

test('fresh Mount Valley seeds replace the generic refund clause without duplicating it',()=>{
  const updated=withMountValleyCancellationTerms(DEFAULT_DRAW_TERMS);
  assert.equal(updated.split('\n\n').length,10);
  assert.doesNotMatch(updated,/Non-allotment, cancellation and refunds\./);
  assert.match(updated,/30%/);
  assert.equal(withMountValleyCancellationTerms(updated),updated);
});
