# myrealpartners.in deployment

Status: deferred at the user’s request. No domain, DNS, hosting subscription or
server environment changes were made. The source below is prepared locally only.

Prepared 27 October 2026. The existing installed app and Bookings service stay on
the current working origin until the replacement passes readiness checks.

## Recommended server

Create a separate Node web service from this repository using:

- Neutral service name: `my-real-partners-api` (Render assigns the actual hostname).
- Same region as the database and existing Bookings service.
- Build command: `npm ci --omit=dev`.
- Start command: `npm run start:broker-only`.
- Health path: `/health`.
- Production Node version supported by the existing repository (Node 22+).
- An always-on compute plan for production, with its displayed monthly charge
  approved before provisioning. Free instances can sleep and delay first access.

`src/brokerOnly.app.js` mounts only the broker realm. It directly reuses the
existing scoped services and database, without an HTTP proxy hop, staff/client
routes, public website configuration, uploads, SPA, OCR queue or messaging worker.
The original Bookings service is not renamed, disabled or redirected.

## Private server configuration

Use the existing Bookings database configuration and EXACT existing signing and
identity configuration. Configure them through Render's server environment,
never a DNS record, app build, chat message or committed file:

- `NODE_ENV=production`, `MOBILE_PORTAL_ENABLED=true`.
- `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_SSL` and any
  existing `DB_SSL_CA`; TLS certificate verification must remain enabled.
- `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` and, if configured on Bookings,
  `MOBILE_PORTAL_SECRET` and `BROKER_MOBILE_IDENTITY_SECRET` with identical values
  and identical optional-variable presence. Do not generate replacement values:
  existing app passwords, saved sessions and private references depend on them.
- A narrowly verified `TRUST_PROXY` configuration matching the actual Render
  ingress. Do not trust arbitrary forwarded headers or set `TRUST_PROXY=true`.
  Validate per-client login limits before broad rollout.
- A verified neutral SMTP account: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
  `SMTP_PASS`, and `SMTP_SECURE` where needed. Broker recovery uses `SMTP_USER` as
  the real sender. A neutral display name alone does not hide a company address.
  Domain purchase alone does not create a mailbox or SMTP service.

No S3 keys, Google credentials, WhatsApp credentials or staff-login OTP setting
are required by the broker-only entry point. Database access remains as scoped by
the existing broker service; it is not a database copy or migration.

Creating this separate service provisions another process with access to broker
credentials, contacts and payment data. Confirm its environment sharing and
hosting charge immediately before the Render creation action.

## Domain activation and GoDaddy DNS

1. Confirm the domain appears under GoDaddy My Products → Domains. Finish any
   purchase, registry activation or email-verification step in the user's own UI.
   Public DNS returned NXDOMAIN during the initial check; that does not by itself
   prove payment failed or registration is unavailable.
2. Once the new service is live, add `api.myrealpartners.in` under that service's
   Settings → Custom Domains in Render.
3. Open GoDaddy → Domain Portfolio → myrealpartners.in → DNS → Manage DNS.
4. Add one CNAME: Name `api`, Value the EXACT new service hostname displayed by
   Render, TTL the registrar's default. The value is a hostname only, with no
   `https://` or path. Do not guess the hostname and do not use the shared
   Bookings origin as a substitute.
5. Resolve only a conflicting record for the `api` hostname if one exists. Leave
   root, www, MX, nameservers and unrelated records alone. Do not change
   nameservers or buy an additional website-hosting package for this connection.
6. Verify the custom domain in Render; wait for DNS and its TLS certificate.

## Verification and app switch

Run against the new service first, then the verified custom domain:

```sh
python3 MyRealPartners/check-backend.py --broker-only \
  --base-url https://api.myrealpartners.in
```

This uses public readiness/anonymous-denial checks only. Confirm no public
website/staff/client routes, status version 3, configured neutral recovery mail,
30-day sessions and unauthenticated portfolio rejection. Test an actual broker
sign-in on the phone without reading or sharing Aadhaar/passwords. Ensure saved
session and commission-linked plots still work with the same private references.

Only then rebuild/install the app with:

```sh
flutter build apk --release --obfuscate --split-debug-info=output/symbols/domain \
  --target-platform android-arm64 \
  --dart-define=API_BASE_URL=https://api.myrealpartners.in
```

The production app source should also use that verified domain as its default
before distribution. Once all callers of the new broker-only Render host use the
custom domain, consider disabling ONLY that new service's default Render
subdomain. Do not disable the original Bookings host: the existing client app and
website still use it.

A neutral domain reduces exposure but does not guarantee anonymous ownership.
.IN registration does not support proxy/privacy registrations; use accurate
registration details. Property facts, registry records and external research can
still reveal relationships.

## Tests and sources

`npm run test:broker-only` tests the real Express middleware with fictional
services: public-route exclusion, scoped auth, private headers, opaque detail
paths, body bounds and generic errors. No real OTP is sent or credentials read.

- https://render.com/docs/custom-domains
- https://render.com/docs/compute-plans
- https://render.com/docs/free
- https://www.godaddy.com/en-in/help/add-a-cname-record-19236
- https://expressjs.com/en/guide/behind-proxies/
