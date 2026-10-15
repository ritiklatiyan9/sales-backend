# Booking API

## Client registration, staff profile and named draws

Run `npm run migrate:client-flow` before starting this version. The repeatable migrations 029–033 add private staff and client credential tables, explicit KYC identity links, lookup indexes, a normalized mobile duplicate guard, and named-draw enrollment protection. Existing members, KYC, draw history and financial entries are retained. Sub-admins and agents use assigned sites; Admin and Super Admin retain access to all sites.

The Booking sidebar has **Clients** (`/clients`) for every authenticated site user. Register a name and Indian mobile number; optionally add PAN, Aadhaar, supporting Aadhaar front/back and PAN files, and an agent referral code. Uploaded identity files can fill blank fields through OCR before registration; users review the extracted details before saving. A client photo can be captured with the camera or uploaded. Registration creates or reuses the shared Accounting CLIENT and an accessible KYC case. Reusing a phone preserves the existing name and referring agent, fills missing identifiers/contact details, and rejects conflicting PAN/Aadhaar or referral claims. Registered details prefill KYC; documents and photos use the existing KYC storage and are not automatically marked verified.

**New Booking** (`/bookings/new`) starts with registered-client mobile lookup. Select the person and enter a draw name/code such as A1 or B5, then continue into the existing payment, KYC, slip, physical result and allotment workflow. A client can have separate entries in multiple named draws. Retries reuse the request; a second active entry for the same normalized draw name returns `409 DRAW_ALREADY_ENROLLED`. Cancelling an entry permits a new enrollment. Staff can switch to Direct booking.

**My Profile** (`/profile`) updates name, email, mobile and password. Super Admin, Admin and Sub-Admin can sign in with registered email/password or phone/password. Staff may enroll Aadhaar as an initial phone password from Profile using their current password. The existing users table has no trusted Aadhaar field/link, so existing staff must enroll it once rather than borrowing a client’s KYC identity. Aadhaar is hashed in `booking_staff_identities`, never returned as plain text. A new custom password replaces the initial Aadhaar password and works with both email and phone. Sensitive profile changes revoke old access/refresh tokens and OTP challenges while issuing replacement tokens to the current browser. An Accounting password change also disables an older Aadhaar credential.

New/extended APIs:

- `POST /auth/login`: `{identifier,password}`; legacy `{email,password}` remains accepted.
- `PATCH /auth/profile`: own `{name,email,phone,current_password,new_password,aadhaar_number}`; send only fields being changed. Role/permission changes are rejected.
- `GET /clients?site_id=&q=&page=&limit=`: paginated directory with masked PAN/Aadhaar and grouped draw counts. Search uses indexed name/mobile prefixes.
- `POST /clients`: `{site_id,full_name,phone,pan_no?,aadhar_no?,agent_referral_code?,father_name?,date_of_birth?,gender?,address?,city?,state?,pincode?,registration:true}`.
- `POST /clients/identity/preview`: multipart `file`, `site_id`, and `type` (`AADHAAR` or `PAN`). Site-authorized OCR preview, limited to 10 MB PDF/JPG/PNG/WebP, with normalized `member_fields` and a short-lived `preview_key`. No client or KYC record is created by a preview.
- `POST /clients/:id/documents`: multipart `file`, `type` (`AADHAAR`, `PAN`, `PHOTO`, `OTHER`), optional `member_document_field`, and optional `preview_key`; `GET` lists accessible documents with view URLs. A preview is reused only for the same actor, site, type and file bytes within 10 minutes. Photos allow JPG/PNG/WebP up to 5 MB and also update the shared client photo.
- `POST /draws`: existing contract with registered `client_member_id`, `scheme_name`, and a stable `request_key`.

Validation: `npm run test:client-flow` in both Booking repositories; `npm run test:booking-workflow` in this backend; `npm run build:booking` in the frontend. Database tests run on isolated PostgreSQL and do not create live clients, staff credentials, payments or draw entries.

## Shared sidebar

Clients has its own `booking_clients` entry in Access Control. Directory reads require View; client registration, identity preview and intake attachments require View and Create. Existing accounts with no stored Clients permission retain access. Shared client search/detail lookups stay available to permitted booking, draw and KYC flows.

Run `npm run migrate:shared-sidebar` to add the singleton `booking_sidebar_layout` setting. Every authenticated staff user reads the same order from `GET /sidebar-layout`; only current Admin and Super Admin roles may save with `PUT /sidebar-layout` and `{layout,revision}`. Each of the fixed sections and menu route keys must occur exactly once. Writes use the revision as an atomic comparison and return `409 SIDEBAR_LAYOUT_CONFLICT` if another administrator saved first. Re-running the migration preserves the saved order. This setting has no site/user filter and does not change module permissions or site assignments.

The desktop sidebar and phone drawer have local menu search, Enter to open the first result, Escape to clear, and Ctrl/Command+K to focus search. Admins choose **Arrange**, drag the grip (or use Space/arrow keys or move buttons), then **Save for all users**. Items can move between sections. **Default order** changes only the draft until saved; Cancel discards the draft. Active windows refresh the global order within 30 seconds and when focused. New modules are reconciled into existing layouts. Validate with `npm run test:sidebar` in both Booking repositories.

## Site draw availability and agreement access

Run `npm run migrate:site-draw-enabled` for the additive `project_settings.draw_enabled` setting. `GET /draws/settings?site_id=` returns `enabled` and `configured` independently; draw initiation is available only when both are true. Admin/Super Admin can save the boolean `enabled` through `PUT /draws/settings`. Existing configured sites remain enabled by default. Omitting `enabled` when saving older clients preserves the stored value. Disabling blocks new `POST /draws` enrollments with `409 DRAW_DISABLED`; existing registrations, payments and issued documents retain their usual access. Settings reads enforce assigned-site access for agents and sub-admins. Validate with `npm run test:site-draw-enabled`.

Agreement template reads require a View grant for `booking_agreements` or `booking_agreement_studio`, plus site access. A print-only reader does not receive studio modification rights. Admin roles retain their existing bypass. Validate with `npm run test:agreement-templates`.

## Application form duplex printing

Application Form Studio and issued forms use four A4 faces in sequence: applicant, terms, commercial, and slip/token. Print all four pages, one page per side, double-sided with **long-edge flip**, **100% / actual size**, and browser headers/footers disabled. Pages 1/2 share sheet 1; pages 3/4 share sheet 2. The page 4 token cut is fixed at 216 mm from the top. Page 3 has no content from 211 mm down, including its footer, leaving a 5 mm alignment allowance behind the cut. The shaded reserve is a studio guide and does not print. Publishing and the print button check the reserved area and reject overflowing content.

Mount Valley Residency / Unn Commercial has separate ₹1,00,000 non-refundable earnest-money and 30% of total collected plot-cancellation clauses. The reviewed copy can be previewed with `node src/scripts/update_mount_valley_terms.js`; applying it requires `--apply --revision=<reviewed revision>` and saves a private backup. It changes only this site's draft/published template and future issue terms; recorded `terms_snapshot` values are retained. `npm run test:form-studio-attendance` covers the template workflow and policy copy; frontend `npm run test:form-studio` covers four-page order and reserved-area overflow.

## Private client dashboard and KYC identity links

**Client login is currently disabled.** `CLIENT_PORTAL_ENABLED` defaults to false and is set to false in the local environment. Client phone sign-in, refresh, and every client portal API return no client access, including requests with previously issued client tokens. Staff and linked broker login remain available. The Clients staff page uses a directory-first phone layout with Clients/Register tabs, document reading, camera/upload controls and a sticky save action.

The retained client portal is available only if explicitly enabled with `CLIENT_PORTAL_ENABLED=true`. In that mode, verified CLIENT members can sign in at `/login` using their KYC mobile and Aadhaar. First successful sign-in creates a private `booking_client_accounts` entry and links only verified CLIENT records with the same normalized mobile and exact Aadhaar. It never creates or modifies a shared staff `users` account. Clients land at `/client-portal`, which has their own bookings, draw entries, payments, masked KYC details, documents and password change.

Client JWTs use a distinct issuer, audience and purpose-specific keys derived from `CLIENT_PORTAL_SECRET`. Accounting and Booking staff APIs reject these tokens. Client refresh is at `/client-portal/auth/refresh`; ownership is resolved from private account/member links on every request. Record IDs or client-supplied site/member filters cannot grant access. Payment visibility uses owned booking token references and owned draw payments; historical plot ownership never exposes another buyer’s ledger. Documents stream through an authenticated ownership check. Password changes and logout revoke client sessions; the old Aadhaar cannot restore a chosen custom password.

Set independent random `CLIENT_PORTAL_SECRET` and `CLIENT_PORTAL_IDENTITY_SECRET` values in the backend environment. Keep the identity key stable when rotating signing keys; it protects identity matching without storing raw Aadhaar in the account table. Never expose these through frontend variables.

Staff phone login remains limited to Super Admin, Admin, Sub-Admin and `agent` users explicitly linked to a verified BROKER member. An operator/referrer is never assumed to be the KYC subject. **Link staff login** on a KYC page requires an authorized Admin/Super Admin, explicit account selection and the actor’s current password. Initial Sub-Admin and broker links require this confirmation. Linked profiles display imported mobile, source KYC and masked Aadhaar. Ordinary OCR/KYC edits cannot silently reset account credentials.

`npm run migrate:client-flow` includes all required migrations. Run `npm run test:client-portal` and `npm run test:kyc-login` for isolated ownership, credential and token-isolation checks. No test signs into a real customer’s account or creates live financial rows.

## Website inventory

The River Green website reads OM ASSOCIATES inventory from the existing shared PostgreSQL database. `WEBSITE_SITE_ID` explicitly selects the project; no public request can select another site. The website's existing geometry has 200 identities (A, B, C and S units); H units and A-44 are outside that geometry. Leading zeroes, spaces and hyphens normalize to those identities. Duplicate identities are `UNKNOWN`, cannot be purchased, and appear in Website Management diagnostics so staff can resolve the accounting records.

## Website booking setup

1. Keep the Razorpay key id and secret in this backend's ignored `.env` as `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`. Add a stable random `WEBSITE_REQUEST_TOKEN_SECRET`. Never use a `VITE_` variable for secrets.
2. Set `WEBSITE_SITE_ID=5` for the confirmed OM ASSOCIATES project.
3. Run `npm run migrate:website-bookings`. Migration 028 only creates four new website tables/indexes. It does not change existing plots, members, bookings or financial rows.
4. Start this API and configure the website's server proxy `BOOKING_API_URL` to its address. Browser calls use the website's same-origin `/api/booking/` proxy; credentials remain on the backend.
5. Run `npm run setup:website-token` to set the requested **₹101 token (10,100 paise)** and enable website booking for OM ASSOCIATES only. This uses the existing tables and preserves customer terms, hold duration and prior payment amounts. The script requires configured gateway credentials and checks that site 5 is OM ASSOCIATES before writing. Fresh projects otherwise start with booking off and amount zero. Sign into Website Management as an active `admin` or `super_admin` to review terms or change settings later.

Status mapping is Company → green, Booked → yellow, Registry → red. Unsupported and ambiguous records have neutral status and remain unbookable. Status responses contain no buyer name, phone, email or address. Website Management and financial approval use the current database role, not a stale JWT claim; agents and sub-admins cannot approve website money.

## Payment and approval lifecycle

`POST /public/website/orders` accepts `{plot_number,buyer_name,buyer_phone,buyer_email,buyer_address,terms_accepted:true,idempotency_key}`. It ignores client-supplied amounts and project ids. The server locks settings and the selected Company plot, checks existing bookings, reserves it once and creates an INR Razorpay order. A retry with the same random key reuses its saved order; changed details are rejected. Native booking creation and draw allotments use the same plot lock and cannot bypass a website hold.

The website's framework-equivalent endpoints are `POST /api/booking/orders` and `POST /api/booking/payments/verify`. Order responses retain the existing format `{request_token,key_id,order:{id,amount,currency},...}`; **`order.amount` is in paise**, whereas the request's display `amount` is in rupees. The Node Razorpay SDK makes the authenticated server request to `POST https://api.razorpay.com/v1/orders`. Orders below 100 paise return 400; provider authentication failures return 401; other provider failures return 500 with safe messages. Timeout/uncertain responses preserve the reservation for reconciliation.

Checkout callbacks call `POST /public/website/payments/verify` with `{request_token,razorpay_order_id,razorpay_payment_id,razorpay_signature}`. The HMAC uses the saved server order id. The server also fetches payment and order, requiring the exact INR amount, captured payment and no refund. Payment moves the request into `PAYMENT_REVIEW`; it does not automatically allot the plot.

Missing callback fields and signature mismatches return 400 without marking the request paid. The frontend loads `https://checkout.razorpay.com/v1/checkout.js`, shows cancellation/payment failure messages, and waits for server verification before reporting payment received. A dismiss callback after successful checkout cannot interrupt that verification. The public key ID is returned from backend environment configuration, so no frontend key variable is needed; the secret never enters the website bundle.

An opaque request token permits only its own sanitized recovery at `GET /public/website/requests/:token` and `POST /public/website/requests/:token/reconcile`. Recovery fetches the saved order's payments when a browser callback was lost. Valid unpaid requests expose the saved order/key for Checkout resumption. Access logs redact these recovery tokens. Never put them into analytics events or external URLs.

Staff uses `POST /website-management/requests/:id/reconcile`, `/approve` or `/reject`. Approval rechecks the gateway and the locked refund state, mapping, plot availability and duplicate bookings. One transaction creates/reuses the verified customer's CLIENT record, creates a KYC booking with a case, updates the plot to BOOKED and writes exactly one shared `plot_payments` BANK/RAZORPAY entry. That entry remains `pending` for the Accounting application's existing approval workflow; website approval does not invent a financial receipt or bypass Accounting permissions.

Captured website payment/plot fields are immutable in booking edits. Cancelling a booking preserves its captured ledger entry and flags refund assistance; its public status becomes `CANCELLED`. Its audit record cannot be deleted. Rejecting a paid request also flags `refund_required`. No refund is issued automatically. Complete refunds in Razorpay and use the Accounting workflow for any approved ledger/booking correction.

Expired or late captures can become `PAYMENT_CONFLICT` if another request holds the plot or availability changed. Staff must resolve the payment/refund; such requests cannot take the other customer's reservation. A gateway creation timeout preserves `ORDER_CREATING` and never creates a second order on retry. Staff can recover it with the merchant dashboard's order id; the server verifies the saved receipt and amount before linking it. The queue displays the receipt for that purpose.

## Webhooks and deployment

Configure the HTTPS backend route `/public/website/webhook` in the Razorpay dashboard for `payment.captured`, `order.paid`, `payment.refunded` and `refund.processed`, with a secret matching backend `RAZORPAY_WEBHOOK_SECRET`. This route verifies HMAC over the original bytes before JSON parsing. Gateway verification and event id deduplication make retries safe. Refund events must match the request's linked payment, amount and currency. A local localhost route is not reachable from Razorpay; opaque token recovery and staff reconciliation remain available during local testing.

Enable automatic capture in the Razorpay dashboard. Test keys simulate payments; use separate live credentials only after test checkout, callback recovery and staff approval have been exercised. Keep the webhook secret independent of the API secret.

The website proxy applies per-visitor limits. Backend public routes have a coarser bounded process-local limit because proxy connections can share an IP. For direct external API access, enforce visitor limits at the deployment ingress; configure `TRUST_PROXY` only for known proxy subnets (for example `loopback` locally), and preserve the actual visitor IP at that trusted ingress. The database plot locks, unique active reservation index and idempotency keys remain authoritative across workers; process-local rate limits are not a substitute for ingress limiting.

Official Razorpay integration guidance: [Checkout signatures and captured status](https://razorpay.com/docs/server-integration/python/test-app/), [security checklist](https://razorpay.com/security/checklist/).

## Verification

`npm run test:website-bookings` uses an isolated in-memory PostgreSQL engine, fake gateway and mocked SDK transport. It never connects to the configured database or spends money. Tests cover the ₹101 setup, minimum amounts, missing fields, provider errors, status/PII controls, invalid signatures, wrong amount/currency, duplicate identities, concurrent reservations/approvals, callback and timeout recovery, replay protection, refunds, manual booking holds and immutable ledger cancellation. Website tests run with `npm run test:booking` in `Rivergreen Website` and cover modal cancellation, provider failures and dismiss-during-verification. Existing draw workflow checks run with `npm run test:booking-workflow`.

For a manual test, start the API with `npm run dev` (8001) and the River Green website with `npm run dev` (5173). Open `http://127.0.0.1:5173/#experience`, select an eligible Company plot and complete the form. The button opens an OM ASSOCIATES checkout for ₹101. In Razorpay test mode, select Netbanking and use the mock bank's Success or Failure button. A successful captured payment appears under Website Management for staff review. Closing checkout should offer request recovery. Use an isolated test inventory for completed checkout/approval tests because staff approval writes a booking and shared ledger entry.
