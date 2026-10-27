# My Real Partners — broker mobile API

The independent broker app uses the existing Bookings HTTPS backend at
`https://sales-backend-ponq.onrender.com/api/broker-mobile`. It is read-only and
does not alter the existing client app or staff/web authentication endpoints.
`MOBILE_PORTAL_ENABLED=true` enables this dedicated mobile realm alongside the
existing client mobile realm; the paused web client portal remains separate.

## Contract

- `GET /status`: public `{service:"my-real-assets-broker",apiVersion:1,enabled:true,sessionDurationDays:30}`.
- `POST /auth/login`: `{identifier,password}`. The identifier is the broker's
  registered Bookings email or mobile number. Mobile sign-in requires the
  existing verified broker KYC enrollment; the initial Aadhaar credential works
  only while it remains enrolled in Bookings. A changed password is respected.
  Legacy `{mobile,aadhaar}` is accepted through exactly the same credential check,
  never by comparing raw member Aadhaar. No users or links are provisioned.
- Login returns `{token,expiresAt,sessionDurationDays:30,user:{id,name,role:"broker"}}`.
- `GET /me`: `{user:{id,name,role:"broker"}}`.
- `GET /portfolio`: `{broker,clients,summary,updatedAt}`.
  Each client has only `id,name,phone,email,address,city,state,pincode,plots`.
  A plot uses the existing My Real Assets projection, including payment plan and
  installments. Payment histories are omitted from this response.
- `GET /plots/:id`: `{plot,updatedAt}`, adding the full payment history for that
  one currently assigned plot. Invalid or unassigned IDs return a generic 404.

`summary` contains `clientCount,plotCount,totalAmount,paidAmount,balanceAmount,
interestAmount,totalDueAmount,upcomingCount,overdueCount`. All currency amounts,
cash/bank receipts, refunds, allocations and overdue interest use the same shared
financial projection as My Real Assets. `projectName` is the generic
`Your Property`; company and site names are not returned.

All authenticated requests require `Authorization: Bearer <token>`. Responses are
`private, no-store`; large responses negotiate asynchronous gzip. Explicit
`Cache-Control: no-cache` bypasses the bounded five-second financial cache.

## Access boundaries

Only active `agent` Bookings login accounts with `can_login_booking` enabled are
eligible. Phone sign-in additionally requires its current verified broker link.
Email/password sign-in can use an existing agent account without a member link;
it receives only records explicitly attributed to that user. Every request
rechecks the account, current password/enrollment fingerprint and token version.
Passwords, deactivation, revoked KYC/member links and role changes invalidate
saved sessions. Tokens use a broker-only issuer, audience, realm and derived key;
client/staff/web tokens do not authenticate the broker API.

Every contact and plot must be inside the broker's current `user_sites` grants
and organization. A plot requires its latest booking, current explicit buyer,
and direct broker attribution. `booking_agent_id` (same-site member override)
takes priority over `agent_user_id`. A cancelled/withdrawn latest booking never
revives an older broker's access. Broker identity across site registrations
requires the full exact mobile and Aadhaar match to the explicitly linked
verified broker; shared phones, names and BRK display codes grant no access.

Direct client referral links may show client contact with zero plots. A referral
never grants access to that customer's plots assigned to other brokers.
`referred_by_member_id` takes priority over `referred_by_user_id`. Staff creation,
team hierarchy, commission rows, buyer names and `booking_by` names grant no
private access. Inactive/blocked client and broker members are excluded.

Client Aadhaar, PAN, bank details, other government identifiers, document links,
photos and KYC payloads are never selected for client DTOs. Freeform financial
labels/references also redact accidental PAN/12-digit Aadhaar patterns.

## Performance and rollout

The app receives a single batched portfolio with current scope checks. Finance
queries are batched across plot IDs, concurrent misses share work, the cache has
entry and byte limits, and full histories load only when a plot is opened.
Portfolios above 1,000 clients or 1,000 plots fail explicitly with 503 instead of
silently returning partial totals. Pagination is not currently exposed.

Existing normalized-user-phone and referral indexes are reused. The optional
latest-booking covering index is additive and should be applied separately on
the database used by Bookings:

```sh
npm run migrate:broker-mobile
```

This uses `CREATE INDEX CONCURRENTLY`; run it outside a transaction. Neither
deployment nor server startup runs this migration automatically. The API works
without this optional index, but do not claim the index is live merely because
the code was deployed.

```sh
npm run test:broker-mobile
npm run test:mobile-portal
```

Tests use only synthetic PGlite records, including two brokers sharing a client,
conflicting attribution, cancellations, cross-site/organization boundaries,
revocation, privacy, posting math, lazy histories and bounded batched reads.
