# My Real Partners — broker mobile API

The separate broker app uses the existing Bookings HTTPS backend at
`https://sales-backend-ponq.onrender.com/api/broker-mobile`. Financial access is
read-only. Independent app credentials and recovery never change shared staff,
Bookings web or client app passwords. `MOBILE_PORTAL_ENABLED=true` enables this
mobile realm alongside the existing client app; the paused web client portal
remains separate.

## Mobile sign-in and recovery

- `GET /status`: public `{service:"my-real-assets-broker",apiVersion:1,authVersion:2,
  portfolioVersion:3,commissionLinkedPlots:true,installmentNotifications:true,bookingProgressVersion:1,enabled:true,sessionDurationDays:30,passwordReset:"registered-email-otp",
  recoveryEmailEnabled:true}`. The email flag reports transport configuration;
  it does not send a test message or guarantee delivery to every address.
- `POST /auth/login`: `{mobile,password}`. Initial app password is the broker's
  registered Aadhaar. `{mobile,aadhaar}` is an equivalent initial-login alias.
  Exact normalized mobile plus Aadhaar must identify active `BROKER` members;
  mixed CLIENT/BROKER membership is supported. A Bookings `users` account or KYC
  login enrollment is not required for member-only brokers.
- Login returns `{token,expiresAt,sessionDurationDays:30,user:{id,name,role:"broker"}}`.
  The token contains no mobile, Aadhaar, PAN or password. Every reopening/read
  revalidates current authority, and encrypted app storage persists only the
  scoped session and minimal profile.
- `POST /auth/password-reset/request`: `{mobile,aadhaar}`. Aadhaar identifies the
  correct person among families sharing a phone; it does not bypass a chosen app
  password. Returns `{challengeId,emailHint?,expiresInSeconds:300,
  resendAfterSeconds:60,message}`. A code is sent only to one unambiguous current
  registered broker email, never a caller-supplied destination. Unknown details
  receive a generic opaque challenge. Valid identities with missing/ambiguous
  recovery email or unavailable transport receive 503 and contact-admin advice.
- `POST /auth/password-reset/confirm`: `{challengeId,code,newPassword}`. Returns
  `{success:true}`; the app then requires a fresh sign-in. Codes expire in five
  minutes, allow at most five attempts, work once and are invalidated on resend.
  Sending is bounded by account and IP/identifier limits; the durable account
  quota is five codes in fifteen minutes with sixty seconds between sends.
- Authenticated `POST /auth/password/change`: `{currentPassword,newPassword}`.
  Returns `{success:true}` and revokes all app sessions, including the current
  device. A wrong current password returns 400 without treating the session as
  expired.
- Authenticated `POST /auth/logout`: `{}` returns `{success:true}` and increments
  the broker credential version, revoking all its app sessions and notification
  registrations. Call it on explicit sign-out, never on app close or ordinary
  session expiry. Offline local sign-out still clears the device's local state.

New app passwords require at least eight characters, at most 72 UTF-8 bytes, and
must differ from the registered Aadhaar number. After a custom password is set,
raw Aadhaar can never sign in or recreate the initial credential. Reset challenges
bind the account/version, exact identity, current authority and registered email;
identity/email edits, revocation or another password change invalidate them.
Passwords use bcrypt. OTP and challenge tokens are stored only as keyed hashes
or SHA-256 digests, never plaintext. Confirmation reserves attempts atomically,
locks/consumes the challenge once and rotates only the broker app credential.

## Portfolio contract

All authenticated requests require `Authorization: Bearer <token>`.

- `GET /me`: `{user:{id,name,role:"broker"}}`.
- `GET /portfolio`: `{broker,clients,summary,updatedAt}`. A client contains only
  `id,name,phone,email,address,city,state,pincode,plots`. Plots use the existing
  My Real Assets projection with payment plan and installments; payment histories
  are omitted from this response.
- `GET /plots/:id`: `{plot,updatedAt}`, adding the full payment history for that
  currently assigned plot. Invalid/unassigned IDs receive a generic 404.

### Booking progress

Detail responses add `plot.bookingProgress` without expanding the portfolio or
changing plot entitlement. It contains `currentStage`, `nextAction` and
`milestones:[{code,state,date}]`. Codes and actions are a fixed allowlist; no
raw status notes, document paths, bank information, company names or internal
record IDs are exposed. Public `/status` advertises `bookingProgressVersion:1`.

This is current recorded progress, not a reconstructed status audit. The
backend has no complete booking/status-transition history. Booking dates,
eligible registry/deed/handover dates and posted refund-entry dates are shown
only when the records establish them. Unrelated `updated_at` values are never
used as milestone dates. A `REGISTRY` plot status or an auto-created registry
workspace does not establish completion; document handover requires a current
deed on file. Missing evidence remains pending or unavailable with an Admin
Office next action.

Historical evidence is bound to the latest current-client booking and exact
plot/site IDs. Registry rows predating that booking or contradicting the
current buyer are excluded; matching plot numbers never join records. Refund
entries follow the existing posting/approval/cheque policy, exclude transfer
debits, and cannot establish settlement of the entire booking. A recorded
refund therefore asks the user to confirm any remaining refund with the Admin
Office.

A later booking edit is a conservative evidence boundary: older registry,
deed, handover and refund records may no longer establish the current client's
progress. Edit timestamps are used only to exclude ambiguous history, never
displayed as milestone dates. This can produce a neutral Admin Office fallback
after unrelated edits. Legacy records without a safe current-booking boundary
also show current status without inventing historical milestones. Existing
retired/unassigned plot denials are preserved; the timeline does not restore
plots that the broker is no longer entitled to view.

Details are rechecked after financial and progress reads, including current
broker identity and plot/client/status snapshots. A concurrent reassignment,
access removal or account revocation cannot release the previous snapshot.
The app refreshes detail progress when opened or resumed and hides stale
details during refresh, backgrounding or denial. This release is read-only and
requires no new database migration.

Each plot includes `installmentRemindersEligible`. The app must require explicit
`true` before showing an installment reminder or scheduling a local backup;
missing/false is ineligible. This narrower notification rule does not change
historical portfolio visibility. It requires a currently entitled plot in
Booked, Sold, Registry/Registered or Under Cancellation status and an exact,
active same-site CLIENT association: the explicit buyer pointer, otherwise the
latest noncancelled current booking. Cancelled, Canceled, Resale, available,
company, unassigned, ambiguous and guessed ledger-name owners cannot remind.
The same scope is checked again after financial reads. A current booking client
takes priority over an overlapping commission row with a stale buyer label.

`summary` contains `clientCount,plotCount,totalAmount,paidAmount,balanceAmount,
interestAmount,totalDueAmount,upcomingCount,overdueCount`. Currency amounts,
cash/bank receipts, refunds, allocations and overdue interest use the same shared
financial projection as My Real Assets. `projectName` is `Your Property`; company
and site names are not returned. Client Aadhaar, PAN, banking, other government
identifiers, document links, photos and KYC payloads are never selected for client
DTOs. Freeform financial labels/references redact accidental PAN/Aadhaar patterns.

Responses are `private, no-store`; larger responses negotiate asynchronous gzip.
`Cache-Control: no-cache` bypasses the bounded five-second financial cache.

## Authority and revocation

An independent member account sees only its exact active BROKER registrations'
sites. Matching names, shared phones and BRK display codes grant no access.
Private account/member links prevent a later Aadhaar edit from reprovisioning a
claimed member. Fresh password sign-in safely discovers additional exact-person
registrations and captures new explicit staff enrollment bindings.

Where explicit Bookings user/KYC enrollment exists, historical bindings are
preserved. Current user active status, agent role/status, `can_login_booking`,
verified broker KYC, assigned sites and organization are enforced; removing a link
cannot silently turn a previously linked account into an independent account.
A database trigger records later staff enrollments even if the enrollment is
removed between app calls. Linked web password/version edits revoke old mobile
sessions without changing or replacing the independent app credential. Before
an app password is customized, initial Aadhaar sign-in remains available as
explicitly requested for this separate app.

A plot is visible through either explicit current booking attribution or its
structured Accounts commission relationship. The existing booking rule requires
its latest booking/current buyer; same-site `booking_agent_id` takes priority
over `agent_user_id`, and cancelled/withdrawn bookings do not revive older
booking access.

The approved commission rule additionally includes `plot_commissions_v2` rows
whose `plot_id`, `site_id` and member `agent_id` match the plot and the current
broker identity. Pending, Partial and Completed master records grant this
relationship; rejected, cancelled, deleted and other invalid masters do not.
The broker may be a co-broker while another person is recorded as Booking By.
A name typo or a different primary broker does not hide an explicit commission
relationship. Legacy name-only commission rows grant no access. Commission
scope is queried afresh on every request, including when finance is cached.

For commission-linked plots, current client contact comes from the plot's
explicit same-site active buyer member, regardless of the member's registration
role. If no explicit buyer is recorded, an exact same-site buyer name may resolve
contact only when it identifies exactly one member across the entire directory;
inactive duplicates still make the name ambiguous. An invalid explicit buyer
pointer never falls through to a guessed name match. When buyer identity is
missing, inactive or ambiguous, the plot remains visible under a synthetic
`plot-owner:<plotId>` client with its current ledger buyer name and blank contact
fields. Historical commission buyer snapshots and similarly named people are
never used to invent a current client ID or contact details.

Direct client referral links may expose contact with zero plots; a referral
alone never grants another broker's plots. `referred_by_member_id` takes priority
over `referred_by_user_id`. Staff creation, team hierarchy, `booking_by` names and
buyer names do not independently grant private plot access. Only committed Booked, Sold and Registry plots qualify for the commission
branch; transferred, under-cancellation, available/company and other inactive
states do not inherit access from an old commission record.

## Deployment and performance

Apply the additive credential migration before deploying auth version 2:

```sh
npm run migrate:broker-mobile-auth
```

This creates private account/member/history/reset tables plus the historical
staff-enrollment trigger. It does not alter existing users' passwords. Migration
is separate from startup and is idempotent. Existing normalized phone/referral
indexes are reused. The optional current-booking covering index can be applied
separately outside a transaction:

```sh
npm run migrate:broker-mobile
```

This index uses `CREATE INDEX CONCURRENTLY`; source deployment alone does not
apply it. Portfolio reads never perform schema migrations. The additive partner
notification migration described below runs at service startup.

## Installment notifications

Authenticated device endpoints use the broker JWT realm and return `{ok:true}`:

- `POST /device-tokens`: `{token,platform:"android"}` (or `"ios"`). Validates the
  exact current broker account, credential version, identity and authority again
  under the account lock. At most 20 devices may be registered per broker. The
  newest registration owns a token when the app changes signed-in accounts.
- `DELETE /device-tokens`: `{token}` removes only that current broker's matching
  registration. It cannot delete a different broker's or the client app's token.

Migration `048_broker_mobile_push.js` creates separate broker device, reminder
event and delivery tables. Main and standalone broker startup run it
idempotently before starting the worker; it can also be applied explicitly with
`npm run migrate:broker-mobile-push`. It does not change ledger rows, add financial
triggers, or reuse client notification tables. The existing broker auth
migration remains a prerequisite for a new installation.

The sender reuses the existing My Real Assets Firebase project
`myrealassets-380f8`, its Firebase Admin initialization and server-only FCM service
account configured through `MRA_FCM_ENABLED=true` and
`MRA_FCM_SERVICE_ACCOUNT_FILE` (or the existing JSON/base64 alternative). No new
private key is required. Register the separate Android package
`app.myrealassets.broker` in that project and use its own generated Firebase app
configuration. Never copy the client app's package configuration or embed server
credentials in the app. Android sends are restricted to the broker package and
use channel `partner_installment_reminders`.

The worker polls its durable queue every minute and rescans current portfolios
every five minutes. It reminds at three days, one day and due day in India time,
once per installment/device/day, including devices registered after an earlier
scan. Each send reloads current scoped financial data and checks the captured
client association, plan, due date, positive balance, account version and exact
live identity/staff/KYC/site grants. Password changes, sign-out, disablement,
unassignment, cancellation, resale, paid/replaced plans and broker reassignment
fail closed. A registered device may continue background notifications after its
30-day JWT expires only while that exact authority remains current; reopening
the app still requires an unexpired authenticated session.

FCM contains only `{type:"installment"}` and a generic client-installment alert.
It includes no client name, property ID, amount or saved plan. The OS displays
the notification when Flutter is closed; opening it reloads current account data
before the app shows a reminder popup. Alerts expire at the end of their India
reminder day. Invalid, revoked and wrong-package FCM tokens are removed only from
the broker registry. Delivery retries are bounded and old outbox rows are pruned.

The existing Free hosting plan sleeps when idle, so in-process scans are delayed
while the backend is asleep. The Android app's generic scheduled local reminders
provide a limited backup based on its latest authorized refresh; opening the
alert always checks current access. An offline backup cannot learn a later
payment or reassignment until the next refresh. No billing change is required
or performed. Server push and local notification timing remain subject to OS
notification permissions, device power controls and connectivity.

```sh
npm run test:broker-mobile-push
npm run test:broker-only
npm run test:broker-gateway
```

The portfolio reads booking and commission scope in parallel, then uses batched financial reads; concurrent financial misses
share work, cache entries/bytes are bounded, and histories load on opening one
plot. Above 1,000 clients or 1,000 plots, the API returns explicit 503 instead of
partial totals. Pagination is not currently exposed.

`BROKER_MOBILE_IDENTITY_SECRET`, when set, is a stable separate identity key;
keep it stable across ordinary signing-key rotations. For existing deployments
it defaults to a derivation of `MOBILE_PORTAL_SECRET`/`JWT_ACCESS_SECRET`, requiring
no extra variable. Rotating that fallback also changes stored identity HMACs and
requires a planned credential migration; do not rotate it casually. Session and
reset signing keys use their own broker-only domain-separated derivations.

```sh
npm run test:broker-mobile
npm run test:mobile-portal
```

Tests use synthetic PGlite records and an injected email sender. No real client
identity or actual OTP delivery is used. They cover independent/mixed-role broker
login, shared phones, custom passwords and recovery, historical enrollment and
revocation, concurrent OTP operations, cross-broker/co-broker plots, Accounts-only commission relationships, current
buyer resolution and masked contacts, privacy and posting math. Existing client financial calculations and API remain unchanged.
