# Booking intake and physical draw workflow

The new frontend module is **Booking Payments** (`/booking-payments`). Quick intake is **User Registration** (`/draws/new`). The existing direct booking, KYC, accounting and installment screens remain available.

1. Register a customer using name and Indian mobile number. Existing site members are reused. Each submission has a retry key; registration does not open a KYC case.
2. An admin/sub-admin collects the configured booking amount and prints the numbered receipt from the payment ledger. Non-cash payments require a reference. Retrying the same payment request cannot insert another receipt.
3. After the full booking amount is recorded, staff can print the KYC form, open the existing KYC workspace, upload documents and verify the customer. The workspace links back to draw documents.
4. An admin/sub-admin can issue the unique slip and two-page draw booking form as soon as full payment is recorded, even when KYC has not started or is pending. Terms are copied into the registration at issue time. Verified KYC is still required before recording the physical draw result or allotting a unit.
5. Staff record the exact number physically picked from the bucket. Only admin/super-admin can record a selection, on or after the scheduled opening date in Asia/Kolkata. The software does not perform a random selection.
6. Admin/super-admin chooses an available unit, agreed price and FULL/INSTALLMENT plan. Unit reservation, booking creation, KYC adoption and receipt transfer commit together. The existing accounting approval, commission enrichment and subsequent payment flows continue.

## Enable the release

This change needs **both repositories** deployed. The frontend's current environment points to a hosted API; changing the local frontend alone does not update that API.

After the existing migrations through 020, run from `Bookings/sales-backend` against the intended deployment database:

```sh
npm ci
npm run migrate:booking-workflow
npm run test:booking-workflow
```

Set `DRAW_PUBLIC_VERIFY_URL` to the deployed frontend’s `/verify/draw` URL so printed QR codes resolve correctly. Then deploy/restart the backend and deploy the frontend build (`npm run build:booking` in `Bookings/sales-dg-frontend`). Migration 021 is additive and rerunnable. It adds schedule, terms and request-key columns plus indexes. It has been exercised on an isolated PostgreSQL engine, including a second run; it has not been applied to the live database by this implementation task.

In **Draw Settings**, configure the amount, scheme, default 10/25-day period and editable terms. Optionally set one common opening date for new registrations. Without a common date, intake uses the chosen period from registration. Existing entries retain their schedule. Old entries without a date must be scheduled from their detail page before selection; already-selected legacy winners can still be allotted. The migration does not invent historical opening dates. Notify affected customers after a date change and reprint their documents.

Existing issued entries retain the prior form's English terms through a migration snapshot. New forms use the current settings at issue time. Paid or issued entries cannot be hard-deleted; allotted receipts are corrected through Accounting.

## Terms

The starter wording is original and editable, covering application scope, identity, payment receipts, physical draw participation, allotment, payment plans, cancellation/refund communications, disclosures and declarations. It does not certify this scheme's legal compliance or reproduce DLF/M3M contracts. Set the project's actual refund policy and applicable disclosures before operational use. No refund deadline, forfeiture percentage or guaranteed allotment has been invented.

Structural references consulted: [DLF application form](https://dlfcityfloors.dlf.in/compliance/pdf/Application-Ind-Floors-Dec20.pdf), [DLF allotment letter](https://central67.dlf.in/download/allotment-letter.pdf). These are references for document topics, not terms incorporated into this scheme.

## Verification and performance

`npm run test:booking-workflow` uses PGlite (development dependency) to execute the actual SQL and controllers entirely in memory. It tests deferred KYC, duplicate registration/payment requests, role and network restrictions, immutable issued terms, date/physical-slip gates, rollback on failed accounting transfer, KYC adoption, installment-plan preservation, repeated receipt sync, competing unit selection and pagination. Existing member-role and OCR tests also pass.

The workflow endpoint returns 25 customers per page with filtered counts in one query. Search is debounced; new site/date and KYC indexes support lookups. Routes load independently, reducing the initial production JavaScript entry from about 3.8 MB to 526 KB before compression. This is a build-size measurement, not a production latency benchmark. Remaining large vendor chunks are loaded as needed.

Browser verification used a separate browser session with simulated API responses, not live customer data: desktop/mobile layout, registration → payment → receipt, early-draw blocking, settings editing, and exactly two A4 form pages without signature/footer overlap. PostgreSQL transaction tests are single-process; concurrent multi-server load testing and deployment-environment trigger verification remain deployment checks.
