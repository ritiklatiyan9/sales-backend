# My Real Partners sample reviewer access

This account uses the normal app sign-in, navigation and screens. Its
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

Deploy the reviewed code and configure all `BROKER_REVIEWER_*` environment
values on the API host. `BROKER_REVIEWER_ENABLED` must be exactly `true`, the phone
must be exactly `9999900016`, the bcrypt hash must have cost 10–14, and the separate signing
secret must have at least 32 characters. Incomplete settings deny sample sign-in.
The two recovery settings must also contain bcrypt hashes. For an existing
reviewer setup, run `node scripts/prepare-broker-reviewer.mjs --add-recovery` to
add these values privately while preserving the original password hash, signing
secret and token version. The script refuses to replace existing recovery data
and leaves the new sample notification gate false until explicitly enabled.
Do not put these values in the mobile app, public policy, repository or listing.
The synthetic login identifier `9999900016` satisfies the app's existing mobile
validator. It is never contacted, sent an OTP or queried against customer data.
The generated repeated-digit recovery identity is fictional; the existing app
requires a 12-digit number beginning 2–9, so an all-zero test value is invalid.

## Isolation and revocation

The router always reserves `9999900016`, including without configuration or when
sample access is disabled. A different configured phone cannot enable sample
access or shadow a real broker identifier.
Wrong sample credentials never fall through to real broker authentication.
Sample JWTs have a separate key, issuer, audience, subject and realm. Detection
of any reviewer claim only selects the isolated verifier; it never authenticates
a request. Invalid, expired, disabled and revoked sample tokens fail without
fallback into the real broker, database or email services.

Only two fixed sample property IDs can be read. Any other detail ID returns 404.
Local display and privacy preferences are handled normally by the app. No hidden
app features or access to actual customer records are enabled for this account.

## Functional sandbox credentials

Password change checks the current sandbox credential, hashes the selected new
password in memory and revokes every sample session, recovery challenge and
notification registration. The old password stops working; no success response
is faked. The initial password hash in the environment remains unchanged.

Forgot password accepts only the fixed sample phone and generated fictional
verification identity. It creates one random challenge valid for five minutes,
with at most five code attempts and a one-minute resend interval. The reusable
test code in the private reviewer instructions replaces email only for this
sample realm. No SMTP message is sent and no actual Aadhaar record is checked.
Successful reset consumes the challenge, changes the sandbox password and
revokes prior sample sessions, challenges and device registrations. Credential
writes are serialized and check the configuration and credential generation
after asynchronous work, so stale or parallel operations cannot revive access.

After testing a password change, reviewers can use Forgot password with the
provided sample identity and reusable code, then choose the supplied password
again. A server restart also restores that original supplied password. All
runtime sandbox state is deliberately temporary and shared by sample sign-ins
on the same process; the documented recovery path remains available if another
reviewer changes it.

## Sample notifications

Set `BROKER_REVIEWER_NOTIFICATIONS_ENABLED=true` only when the sample reminder
behavior has been approved. The existing `MRA_FCM_ENABLED=true` and validated
Firebase configuration are also required. Without a configured sender, sample
enrollment returns 503 rather than pretending to succeed.

The Play rollout accepts Android sample enrollment only and rejects iOS tokens.
The normal app notification enrollment validates the normal token/platform body,
then sends one clearly labelled **Sample reminder** to that request's token only.
The alert contains generic fictional reminder text, no client identity, plot
reference or amount. Android delivery is restricted to `app.myrealassets.broker`,
uses the normal `partner_installment_reminders` channel, and expires after five
minutes. There is no recipient lookup, real-account notification registration,
database write or production reminder worker call.

Registrations are held only in sample memory, capped at 20 devices. Duplicate
registration is idempotent. At most one send attempt is allowed per minute,
including failed attempts. Unregister removes that sample registration. Credential
changes, configuration changes and restart remove all registrations. Authorization
and credential generation are checked after asynchronous sender resolution,
immediately before dispatch, and after dispatch before storing the registration.
Revocation cannot unsend an already dispatched generic sample alert.
Sender resolution and dispatch each have a five-second deadline and run outside
the state mutation queue. Password changes, recovery and unregister continue
while a network request is pending. Pending enrollments reserve bounded capacity
and cannot store data after timeout, cancellation or revocation.

The unpaid fictional plan is eligible for the app's existing local reminder
schedule. Real office-triggered business events never occur for this account;
the synthetic enrollment alert demonstrates remote delivery instead. All
notification tests inject a capture-only sender and make no actual FCM requests.
When enrollment happens while the app is open, its existing foreground handler
refreshes the fictional records and reminder prompt; a system notification shade
alert is not guaranteed to appear immediately in the foreground.

Sample sessions use a bounded in-memory allowlist (maximum 128 sessions) and a
30-day JWT expiry. Logout removes that session. A server restart removes every
sample session, so sign in again; multiple processes/instances may require a new
sign-in when routing changes. This deliberately fails closed rather than using
the production account database. It does not change real broker sessions.

To revoke all sample access, set `BROKER_REVIEWER_ENABLED=false` and redeploy,
keeping `BROKER_REVIEWER_PHONE` configured so that identifier stays reserved.
Changing the password hash, signing secret, recovery settings or token version also invalidates
sample sessions. On observing any reviewer configuration change, the service
clears its active-session allowlist. Restoring previous settings cannot revive
those tokens; a new sign-in is required. Do not remove the reserved phone as a
way of disabling access.

## Validation

`node --test src/services/brokerReviewer.service.test.mjs` checks authentication,
expiry, revocation, synthetic DTOs and every sample route using real-service and
production-service mocks that throw if touched. Existing broker auth, portfolio, reminder and
standalone router tests provide regression coverage for real users.

Google's [sign-in details requirements](https://support.google.com/googleplay/android-developer/answer/15748846?hl=en)
allow an active demo account and reusable verification access, while requiring
access to all app functionality. Keep the private English reviewer instructions
complete and accurate; do not claim unavailable production events are tested.
