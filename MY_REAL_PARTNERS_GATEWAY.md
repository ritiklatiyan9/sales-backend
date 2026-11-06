# Neutral broker-only gateway

For a dedicated domain deployment, prefer the direct broker-only entry point
`npm run start:broker-only`; see `MY_REAL_PARTNERS_DOMAIN_SETUP.md`. It reuses
Bookings services without the gateway hop or its aggregate upstream IP budget.
The gateway below remains an optional alternative, not the installed app target.

Run a separate service with `node src/brokerGateway.server.js`. It imports only
Node built-ins and requires Node 22 or newer. Its only upstream is the configured
`BROKER_UPSTREAM_ORIGIN` HTTPS origin (defaults to the existing Bookings server).
It needs no database credentials, signing keys or SMTP credentials.

The gateway exposes only minimal `/health` and the allowlisted
`/api/broker-mobile` status, login, password recovery, portfolio, profile and opaque
property-detail routes. It rejects website/config, staff/client app routes,
numeric property IDs, arbitrary paths, query-string proxy targets and redirects.
It forwards only required authorization/content/cache headers, strips upstream
cookies and infrastructure headers, bounds bodies and returns generic errors.
No credentials, request bodies, emails or responses are logged.

For deployment, create a separate neutral web service from this repository and
set its start command to `node src/brokerGateway.server.js`. Point the Flutter
`API_BASE_URL` at that new HTTPS origin only after testing its allowlist and
privacy API readiness. An always-on service avoids adding a second cold start;
a free sleeping service may make the first request slower. Existing upstream
rate limits continue to apply and can aggregate requests from this gateway.
For high broker volumes, configure trusted, authenticated proxy identity or
dedicated gateway-aware rate limits before broad rollout.

The upstream website remains publicly accessible at its existing address; this
gateway does not disable it. A neutral gateway removes the direct shared-origin
link from the app, but cannot guarantee company anonymity. Property/client facts,
mail sender domains, public source repositories, legal records and external
research may still reveal connections. Use a separately verified neutral email
sender for recovery mail; changing only its display name does not conceal the
actual sender address. The platform and app publisher also have their own public
metadata.

## Validation

```sh
node --test src/brokerGateway.server.test.mjs
```

Tests use fake upstream responses and local listeners only, without customer
credentials or outbound mail.
