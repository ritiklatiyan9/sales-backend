# My Real Partners — broker mobile API

The separate broker app uses the existing Bookings HTTPS backend at
`https://sales-backend-ponq.onrender.com/api/broker-mobile`. Financial access is
read-only. Independent app credentials and recovery never change shared staff,
Bookings web or client app passwords. `MOBILE_PORTAL_ENABLED=true` enables this
mobile realm alongside the existing client app; the paused web client portal
remains separate.

## Mobile sign-in and recovery

- `GET /status`: public `{service:"my-real-assets-broker",apiVersion:1,authVersion:2,
  portfolioVersion:2,commissionLinkedPlots:true,enabled:true,sessionDurationDays:30,passwordReset:"registered-email-otp",
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
apply it. Neither portfolio reads nor app startup perform schema migrations.

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
