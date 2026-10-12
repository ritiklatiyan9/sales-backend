# Booking API — website booking integration

The River Green website reads OM ASSOCIATES inventory from the existing shared PostgreSQL database. `WEBSITE_SITE_ID` explicitly selects the project; no public request can select another site. The website's existing geometry has 200 identities (A, B, C and S units); H units and A-44 are outside that geometry. Leading zeroes, spaces and hyphens normalize to those identities. Duplicate identities are `UNKNOWN`, cannot be purchased, and appear in Website Management diagnostics so staff can resolve the accounting records.

## Local setup

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
