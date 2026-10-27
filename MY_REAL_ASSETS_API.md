# My Real Assets on the Bookings backend

The mobile app uses the deployed Bookings origin:

`https://sales-backend-ponq.onrender.com`

The Flutter API base is the origin only. The app appends `/api/mobile/...` itself.
It must not point at the dgbooking.com website, a localhost address, or the older
`/client-portal` web API.

## Deploy and enable

Deploy this repository's current revision to the existing Bookings Render service.
No schema migrations, new npm packages, or accounting-server changes are needed.
The API reads the shared Bookings/Accounts database. Before enabling, the database
must already contain the canonical plot and installment tables, `buyer_member_id`,
the Bookings private client-account link tables and `financial_transaction_posts`.

Set these server environment variables:

```text
MOBILE_PORTAL_ENABLED=true
MOBILE_PORTAL_SECRET=<independent random value with at least 32 characters>
```

The dedicated secret is recommended. If absent, a domain-separated key is derived
from the existing strong `JWT_ACCESS_SECRET`; staff secrets need not be rotated.
Never put signing secrets in Flutter, Vite variables, git, or client configuration.

Mobile access defaults off unless explicitly enabled, in every environment. It is separate
from `CLIENT_PORTAL_ENABLED`, so activating the app does not reopen the paused web
client portal. Local development must also set `MOBILE_PORTAL_ENABLED=true`.
Changing a signing secret revokes that mobile realm's sessions.

After deployment, anonymous readiness must return:

```text
GET /api/mobile/status
200 {"service":"my-real-assets","apiVersion":1,"enabled":true}
```

This status endpoint is available when disabled too, with `enabled:false`, so it
can distinguish the deployed mobile API from an old staff-only revision. Disabled
data and sign-in endpoints return 503 with `MOBILE_PORTAL_DISABLED`. Readiness
exposes no client, project, database, credential or secret values. Requests without
mobile authentication to `/api/mobile/plots` must return 401 once enabled. The old
staff response `No token provided` is not evidence that this revision is deployed.

Only after this readiness check succeeds should the phone's live build be used.
It needs HTTPS and internet access; USB forwarding and a running laptop API are
not required. Render hosting sleep/cold starts, if enabled on the service's plan,
can still affect the first request and are independent of app/database caching.

## Contract and identity

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/mobile/status` | Public service/version/enabled marker |
| GET | `/api/mobile/health` | Public health when mobile access is enabled |
| POST | `/api/mobile/auth/login` | `{mobile,aadhaar,role:"client"}` → `{token,user}` |
| GET | `/api/mobile/me` | Scoped owner profile |
| GET | `/api/mobile/plots?include=details` | Portfolio, totals and all plot details in one response |
| GET | `/api/mobile/plots/:id` | One owned plot's plan, allocations and posted receipts |

Mobile credentials remain the registered Indian mobile number and Aadhaar, as
requested for this app. This is a separate mobile credential realm, not a change
to web portal password-change behavior or staff login. Tokens expire after 30
days and use issuer `my-real-assets-bookings`, a dedicated key derivation and
`mobile-client` realm. Staff, older Accounts-mobile and web portal tokens cannot
authenticate these endpoints. Neither raw mobile nor Aadhaar is included in the
token or response. The app keeps the scoped token in device-secured encrypted
storage for the session duration; financial caches remain memory-only.

Each request rechecks the current exact mobile/Aadhaar identity. Inactive members
are denied. A deactivated private Bookings client account explicitly linked to a
member revokes that matching identity across its sites. A different Aadhaar that
shares the same phone remains separate. A web portal account or web registration
is not required for an otherwise valid registered mobile-app client.

Plot ownership requires its explicit buyer member or latest noncancelled booking
client in the same site. Buyer-name matching never grants access. Legacy name-only
records need a correct member link in the existing software before appearing.
Available/company inventory and another owner's receipts remain inaccessible.
All public project/site labels say **Your Property**, not the source site's name.

## Financial and performance behavior

The API includes the complete canonical Accounts ledger, including cash, as
requested for My Real Assets. It does not inherit the staff Bookings screen's
cash presentation filter. Posted bank/cash receipts and legacy direct installment
receipts are combined without registry mirrors. Approved refunds reduce net paid;
cancelled/rejected transactions and uncleared/bounced/unapproved cheques do not pay
the plan. The shared `financial_transaction_posts` database policy is authoritative.

Agreement value and remaining principal stay separate from estimated overdue
interest, using the same configured interest period/rate as the Accounts tracker.
The app does not collect payments or create/change any records.

The optimized normalized-phone lookup uses the existing expression index. One
expanded request replaces per-plot N+1 calls. Financial rows use a bounded 5-second
process cache, with current ownership checked before every lookup. Concurrent
financial reads deduplicate. `Cache-Control:no-cache` on reads bypasses this cache
for explicit refresh. JSON larger than 2 KiB uses asynchronous gzip level 1 when
negotiated. Browser/proxy responses remain `private,no-store`; no credentials or
entire customer responses are globally cached. Sign-in is limited per IP and
normalized phone; multiple production workers should share equivalent limits in
the gateway or a common store.

## Checks

```sh
npm run test:mobile-portal
npm run test:security
npm run test:client-portal
```

Mobile tests use synthetic PGlite records and assert read-only behavior, exact
identity boundaries, account deactivation, domain separation, cash/refunds,
allocation math, batching/cache revocation, explicit refresh, gzip and production
enablement. No real client's Aadhaar is used to run the tests.

## Persistent mobile sessions

Login returns `expiresAt` and `sessionDurationDays:30` alongside the access token. The public status reports `sessionDurationDays:30` so deployment checks can verify the duration. Clients store only the scoped token and minimal profile in device-secured encrypted storage; Aadhaar is never stored. Signature, expiry, current identity, inactive/deactivated status and ownership remain server-validated on authenticated reads. Signing-key rotation revokes saved sessions. Existing one-hour tokens retain their original expiry; sign in once after this update to receive a 30-day session.
