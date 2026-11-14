# Partner commission split contract

The Accounts API owns allocation writes and payment posting. This Sales API reads
the shared `plot_commissions_v2` and `plot_commission_payments` tables; it never
creates a second commission ledger.

Apply Accounts migrations `241_plot_commission_allocations` and
`242_plot_commission_allocation_guards` before enabling split writes. It adds nullable `allocation_type`, `allocation_value`, and
`allocation_base` fields, payment integrity guards, and indexes for broker reads.
The Sales readers tolerate the columns being absent during a staged rollout:
legacy rows are presented as fixed rupee allocations. Deploy this Sales API and
the updated My Real Partners app to display percentage breakdowns.

Both `GET /api/broker-mobile/commissions` and
`GET /api/broker-mobile/commissions/:opaquePropertyId` retain
`commissionVersion: 1` and add these fields to each commission card:

```json
{
  "propertyType": "SHOP",
  "allocations": [{ "type": "percentage", "value": 30, "amount": 30000 }]
}
```

`type` is `percentage` or `amount`. Percentage `value` is the agreed percentage
of the property commission pool; `amount` is the actual assigned rupee amount
stored in `total_commission`. Fixed rupee rows use their own rupee amount for both
`value` and `amount`. Multiple legacy records owned by the same broker remain
separate allocations on one property card. The server returns no whole-property
commission pool, co-broker amounts, member IDs, or freeform accounting remarks.
Property types are `PLOT`, `FLAT`, and `SHOP`; shops and flats use square feet.

The detail endpoint loads only that property's own commission transactions.
Posted cash plus posted TDS reconcile to `paidAmount`; pending, bounced,
rejected, and cancelled transactions remain distinct. Opaque property and
transaction IDs remain broker-specific. Both endpoints recheck current
assignment, property authority, and account/session state after reading payments.

An explicit assignment to an active enrolled broker can grant that one property
in another site within the same organization. Its source member site must remain
authorized in the broker session. This does not extend staff/site grants, grant
unassigned properties in the target site, or cross organization boundaries.
Removing the assignment revokes this access on the next read.

The receiver directory can include any organization member. Partner app login
still requires an active `BROKER` member role, valid registered mobile/Aadhaar,
and the existing account/staff binding checks. Saving an allocation does not
create an app account or change a member's role.

Lists fetch cash and TDS summaries in one indexed payment scan and leave payment
histories lazy. A query-budget test checks that the number of commission database
round trips stays constant between one and 1,000 properties. Existing private
`no-store` responses and negotiated gzip remain in use; no deployment latency
claim is implied by the automated tests.

Validation:

```sh
npm run test:broker-mobile
node --test src/services/mobilePortal.service.test.mjs
```

The real-SQL tests cover a 30/50/20 shop split, per-broker transaction isolation,
legacy rows, reassignment during a read, same-organization cross-site assignment,
cross-organization denial, and immediate removal of commission authority.

## Cancelled bookings and rebooking history

Accounts migration 244 adds nullable `settlement_commission`, `settlement_percent`
and settlement audit fields to each original commission record. The original
`total_commission`, receiver ID, payment IDs and booking row remain intact.
Rebooking creates a different plot row linked through `previous_booking_plot_id`;
Sales KYC synchronization refuses to reactivate the cancelled source row.

Commission cards now include `bookingStatus`, `bookingDate`, `historicalBooking`,
`originalCommission`, `settlementAmount`, `settlementKind`, `settledAt`,
`paidOutAmount`, `recoveredAmount`, `recoverableAmount` and `tdsAdjustmentAmount`.
`totalAmount` is the approved effective manually decided entitlement, including an
explicit zero. `settlementApprovalStatus` identifies pending, rejected and approved
proposals. Until approval, `totalAmount` and allocation amounts retain the original
entitlement while `settlementAmount` separately carries the proposed amount.
Recoverable cash and tax adjustments remain zero while approval is pending or
rejected. `settlementAmount`/`settlementKind` remain null before a proposal;
`settlementPercentage` is null for manual decisions. No automatic 25% calculation
is performed. Each allocation retains `originalAmount`; its `amount` is the
effective entitlement, so effective allocations reconcile to `totalAmount`.

`paidAmount` is the net posted cash plus tax held. `paidOutAmount` and
`recoveredAmount` split the positive and negative posted gross transactions.
After settlement approval, cash recoverable from the broker is
`min(max(paidAmount-totalAmount,0),max(receivedAmount,0))`; any remaining gross
overpayment is `tdsAdjustmentAmount`, separately identified as a tax adjustment.
An uncleared recovery cheque does not reduce paid/recoverable amounts.

Historical authority is isolated to the signed-in broker's commission records.
It grants no general property ledger, installment reminders, client contacts,
new buyer details or other brokers' settlements. Historical cards use only the
old booking row's recorded buyer label. A broker who also joins the new booking
receives two opaque property IDs and separate transaction histories.

Public readiness advertises `commissionHistoryVersion:1` after the updated Sales
API is deployed. Local source changes do not deploy that API. The real SQL tests
cover three old brokers plus two new brokers, manual zero settlements, cash/TDS
reconciliation, recovery posting, same-broker separate booking cards, reassignment
and concurrent settlement or approval updates. Missing legacy approval columns
retain compatibility; a present null or unknown approval status fails closed.
