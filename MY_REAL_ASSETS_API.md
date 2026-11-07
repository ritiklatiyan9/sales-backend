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
Clients need active member records and verified KYC. On first use, their
registered mobile number and Aadhaar can create a linked client account; they
must then choose a password before accessing financial data. Unverified member
records cannot enroll until KYC is verified.

Set these server environment variables:

```text
MOBILE_PORTAL_ENABLED=true
MOBILE_PORTAL_SECRET=<independent random value with at least 32 characters>
```

The dedicated secret is recommended. If absent, a domain-separated key is derived
from the existing strong `JWT_ACCESS_SECRET`; staff secrets need not be rotated.
Never put signing secrets in Flutter, Vite variables, git, or client configuration.
The existing stable `CLIENT_PORTAL_IDENTITY_SECRET` (or its configured client
portal fallback secrets) must match the one used when client accounts were created.

Mobile access defaults off unless explicitly enabled, in every environment. It is separate
from `CLIENT_PORTAL_ENABLED`, so activating the app does not reopen the paused web
client portal. Local development must also set `MOBILE_PORTAL_ENABLED=true`.
Changing a signing secret revokes that mobile realm's sessions.

After deployment, anonymous readiness must return:

```text
GET /api/mobile/status
200 {"service":"my-real-assets","apiVersion":1,"enabled":true,"sessionDurationDays":1,"authMode":"client-password-v1"}
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
| POST | `/api/mobile/auth/login` | `{mobile,password,role:"client"}` → `{token,user}` |
| POST | `/api/mobile/auth/password` | Authenticated `{currentPassword,newPassword}` → `{ok:true}` and invalidates all client sessions |
| POST | `/api/mobile/auth/logout` | Authenticated request → `{ok:true}` and invalidates all client sessions |
| GET | `/api/mobile/me` | Scoped owner profile |
| GET | `/api/mobile/plots?include=details` | Portfolio, totals and all plot details in one response |
| GET | `/api/mobile/plots/:id` | One owned plot's plan, allocations and posted receipts |

Mobile sign-in uses the registered Indian mobile number and password. When a
verified client has no chosen password, Aadhaar works for initial setup only. The
API issues a ten-minute setup token that may only change the password or sign
out. The client must choose a password and sign in again. Once a password is
chosen, Aadhaar cannot be used to sign in. Accounts must be linked to verified
KYC and active members. A different account sharing a phone remains separate; if
the same password matches more than one account, sign-in fails closed.

**Enrollment risk:** a mobile number and Aadhaar are identifiers, not secret
proof of identity. Anyone who knows both can claim an uninitialized account and
choose its password. Database KYC confirms a record exists but does not verify
the person entering it. A trusted activation procedure or verified independent
factor is needed to remove this first-login takeover risk.

Mobile tokens expire after one day and use a dedicated signing realm. Each read
rechecks the client account's token version and current verified ownership. Client
portal password changes, logout, account deactivation, or revoked KYC invalidate
mobile access. Tokens from the former Aadhaar-only mobile API are rejected after
this backend is deployed. Staff and web portal tokens cannot authenticate mobile
endpoints. Passwords and Aadhaar are never returned or put into mobile tokens.
Mobile password changes require the current password, a different new password
of at least 12 characters and at most 72 UTF-8 bytes, and are rate-limited. Both
password change and successful online mobile sign-out revoke every mobile and web
client portal session for that account, because both share the account's token
version. An offline sign-out can clear the device but cannot revoke a server token.
The app keeps its scoped token in device-secured storage; financial caches remain
memory-only. The existing web client portal has separate availability controls;
this change does not enable it. Mobile enrollment creates an account only when
the verified KYC and identity checks pass.

Plot ownership requires its explicit buyer member or, if no explicit link exists,
the latest booking's client in the same site. An invalid explicit link or a
cancelled latest booking fails closed; an older booking never restores access.
Buyer-name matching never grants access. Legacy name-only records need a correct
member link in the existing software before appearing. Booked, Registry and
Under Cancellation remain visible to the current client. Cancelled (including
Canceled) and Resale rows are inaccessible to clients even when an old buyer link
remains. The resale workflow retains that retired row and creates a separate
purchase row for the new client; only their current linked row is visible.
Available/company inventory and another owner's receipts remain inaccessible.
Unavailable plots are omitted from lists, expanded details and totals. A
portfolio with withheld prior associations includes an optional `accessNotice`.
Direct inaccessible or unknown plot requests return 404 with the same message:
“This plot is no longer available in your account. Please contact the Admin
Office for assistance.” Staff/admin plot routes keep their existing access.
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
The app does not collect payments or change accounting records. First login and
password management create or update client authentication records.

The optimized normalized-phone lookup uses the existing expression index. One
expanded request replaces per-plot N+1 calls. Financial rows use a bounded 5-second
process cache, with current status and ownership checked before every lookup and
rechecked after financial reads before releasing a response.
Financial snapshots are scoped to the owner, status and plot update revision so
they cannot be reused after reassignment. Concurrent financial reads deduplicate.
`Cache-Control:no-cache` on reads bypasses this cache
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

## Deployment compatibility

Deploy the backend and updated app together. Older mobile builds use Aadhaar and
will be unable to sign in, and previously issued mobile tokens will be rejected.
Confirm the public `authMode` marker before distributing the app; the old API is
still vulnerable to anyone who knows the registered mobile number and Aadhaar.
The per-process sign-in limiter needs an equivalent shared gateway limit when
running multiple workers or instances.

## Firebase notifications (requires deployment and migration)

Run `npm run migrate:mobile-push` on the shared Bookings/Accounts Postgres database
before deploying the backend. It adds mobile device registrations, a durable event
outbox and transactional triggers on both `plot_payments` and
`plot_installment_payments`; no historic transactions are backfilled. The trigger
uses the same `financial_transaction_posts` function as the mobile portfolio, so
uncleared cheques and unapproved refunds are not presented as posted payments.
An outbox failure does not reject an otherwise valid financial write: the
trigger emits a PostgreSQL warning and that notification may be missed. Monitor
database logs for `My Real Assets push capture failed`; this fallback is not a
substitute for verifying the Accounts database role can write the outbox.

In Firebase Console, select **myrealassets-380f8 → Project settings → Cloud
Messaging** and enable **Firebase Cloud Messaging API (V1)** in Google Cloud.
This API was verified enabled on 7 November 2026. The existing dedicated sender,
`my-real-assets-fcm-sender@myrealassets-380f8.iam.gserviceaccount.com`, has the
**Firebase Cloud Messaging API Admin** role (`roles/firebasecloudmessaging.admin`)
and an existing key. Reuse its configured backend credential where available.
Keep general Firebase administrator and Google sign-in credentials separate.

Set `MRA_FCM_ENABLED=true`, `MRA_FCM_PROJECT_ID=myrealassets-380f8` and configure the
service account for that same project as the Android app. A mismatched project
disables the sender. For a Render secret file, set
`MRA_FCM_SERVICE_ACCOUNT_FILE=/etc/secrets/my-real-assets-fcm.json` to its absolute
server-side path. Alternatively use `MRA_FCM_SERVICE_ACCOUNT_B64` or
`MRA_FCM_SERVICE_ACCOUNT_JSON` for the server-only credential. The file setting
takes precedence and an invalid or unreadable file disables the sender rather
than falling back to another credential. The existing Google sign-in
Firebase credential may target a different project and is not reused. Grant the
service account the Firebase Cloud Messaging permissions; never bundle the key in
the app. Restart the Bookings service after configuring these values. Verify the
super-admin-only `GET /mobile-notifications/status`: `schemaReady`, `enabled`, and
`firebaseConfigured` must all be true and `workerMode` must be `in-process`.
The counts contain no device identifiers. `failedDeliveries` counts entries
that exhausted eight attempts. The worker processes up to 100 queued events and
100 deliveries per polling cycle; sustained volume requires monitoring and
potentially a dedicated worker. Old events are removed after 30 days.

Authenticated `POST /api/mobile/device-tokens` accepts `{token,platform}` and
`DELETE /api/mobile/device-tokens` accepts `{token}`. Registrations are tied to
account and credential version rather than the one-day access token lifetime;
sign-out/password changes invalidate old versions. Ownership, active account,
verified identity, and current posted status are checked again before delivery.
Notifications contain no amounts, names, or property identifiers. The app can
open the relevant activity view after a tap. FCM does not guarantee delivery;
invalid device tokens are removed. Retries are bounded, and a crash after FCM
accepts a message but before the database records success may cause a duplicate.

The in-process worker polls the queue every minute and rescans installment
reminders every five minutes while Bookings is running. It queues one reminder
three days before, one day before and on the due date in Asia/Kolkata, only while
an installment remains unpaid. A newly registered phone can receive the current
day's reminder even when that reminder was scanned earlier. Database delivery
records deduplicate repeated scans and multiple workers; a crash after FCM
accepts a message can still cause a duplicate.

Installment notifications use the high-importance `installment_reminders`
Android channel and expire at the end of the India reminder day. Normal payment
activity keeps its existing channel. These are notification messages so Android
can display them while the app is backgrounded or terminated. The phone must
have opened the app at least once, registered its token and allowed notifications.
Android force-stop from Settings blocks delivery until the app is reopened.
The app shows the reminder modal after opening/resuming and loading current
authorized data; it does not launch a modal over other apps. No financial details
are included in the push text. Paid, cancelled, resale, reassigned and disabled
accounts are checked again before delivery or showing financial details.

If hosting sleeps or is offline, notifications are delayed; an always-on
Bookings instance is required for reliable reminders. The worker skips stale
events and does not replay reminders missed while offline. The free host must
not be treated as an accurate scheduler.

From this backend directory, verify configuration without sending a message:

```sh
node scripts/check-mobile-fcm.mjs
```

For the optional FCM API validation, follow the script's `--help` instructions
using a private device-token file. It uses FCM dry-run validation, never real
delivery. A successful dry run still requires a separate phone test: sign in,
allow notifications, leave the app in the background, receive a reminder, then
tap it and verify the freshly loaded modal. Repeat after removing the app from
Recents. Do not use Android's Force stop for this test. iOS additionally needs
its own Firebase app configuration, APNs key and Push Notifications capability;
the current configured target is Android.
