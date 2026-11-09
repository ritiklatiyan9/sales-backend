# My Real Partners sample reviewer access

This account uses the normal app sign-in, navigation and read-only screens. Its
profile reads **Sample data · Play reviewer**. All client names, contacts,
properties, plans, payments and booking milestones are fixed fictional fixtures;
dates move relative to the current day so the Dues screen remains reviewable.
It never looks up or creates a real broker/client account.

## Prepare and enable

Run `node scripts/prepare-broker-reviewer.mjs` from this backend directory. It
creates two new files under the already git-ignored `secrets/` directory, both
with mode 0600. It refuses to overwrite existing material and prints no password,
password hash or signing secret. Keep those files private.

- `secrets/broker-reviewer.env` contains deployment environment values.
- `secrets/broker-reviewer-credentials.json` contains the generated password and
  reviewer sign-in instructions for Google Play's App access section.

Deploy the reviewed code and configure all five `BROKER_REVIEWER_*` environment
values on the API host. `BROKER_REVIEWER_ENABLED` must be exactly `true`, the phone
must be exactly `9999900016`, the bcrypt hash must have cost 10–14, and the separate signing
secret must have at least 32 characters. Incomplete settings deny sample sign-in.
Do not put these values in the mobile app, public policy, repository or listing.
The synthetic login identifier `9999900016` satisfies the app's existing mobile
validator. It is never contacted, sent an OTP or queried against customer data.

## Isolation and revocation

The router always reserves `9999900016`, including without configuration or when
sample access is disabled. A different configured phone cannot enable sample
access or shadow a real broker identifier.
Wrong sample credentials never fall through to real broker authentication.
Sample JWTs have a separate key, issuer, audience, subject and realm. Detection
of any reviewer claim only selects the isolated verifier; it never authenticates
a request. Invalid, expired, disabled and revoked sample tokens fail without
fallback into the real broker, database, push or email services.

Only two fixed sample property IDs can be read. Any other detail ID returns 404.
Sample password changes, password recovery and remote device-token registration
or removal return a read-only error before any production service is called.
Local display and privacy preferences are handled normally by the app. No hidden
app features or access to actual customer records are enabled for this account.

Sample sessions use a bounded in-memory allowlist (maximum 128 sessions) and a
30-day JWT expiry. Logout removes that session. A server restart removes every
sample session, so sign in again; multiple processes/instances may require a new
sign-in when routing changes. This deliberately fails closed rather than using
the production account database. It does not change real broker sessions.

To revoke all sample access, set `BROKER_REVIEWER_ENABLED=false` and redeploy,
keeping `BROKER_REVIEWER_PHONE` configured so that identifier stays reserved.
Changing the password hash, signing secret or token version also invalidates
sample sessions. On observing any reviewer configuration change, the service
clears its active-session allowlist. Restoring previous settings cannot revive
those tokens; a new sign-in is required. Do not remove the reserved phone as a
way of disabling access.

## Validation

`node --test src/services/brokerReviewer.service.test.mjs` checks authentication,
expiry, revocation, synthetic DTOs and every sample route using real-service and
push mocks that throw if touched. Existing broker auth, portfolio, reminder and
standalone router tests provide regression coverage for real users.
