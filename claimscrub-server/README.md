# ClaimScrub Server

Backend for ClaimScrub. It re-runs the audit on the server (so the paywall can't
be bypassed by editing browser JavaScript), starts Stripe Checkout, confirms
payment, and releases the full report only after payment.

## How a payment works

1. The browser reads the bill (OCR + parsing happen in the browser) and sends
   the parsed line items to `POST /api/audit`.
2. The server runs the rules engine.
   - No likely errors: the full report comes back immediately, free.
   - Likely errors: the server stores the report, returns only a **summary** and
     a random `reportId`. The details stay locked.
3. `POST /api/create-checkout-session` with the `reportId` returns a Stripe
   Checkout URL ($20, one time). Asking again for the same report returns the
   same open checkout page, so nobody can be charged twice.
4. The customer pays on Stripe's hosted page and comes back to the website.
5. The report is unlocked in **two** ways, whichever happens first:
   - Stripe's webhook (`/api/stripe-webhook`), and
   - the return page calling `GET /api/report/:id?session_id=...`, which asks
     Stripe directly (the webhook can arrive a few seconds late).
   Both go through one function (`fulfill.js`) that confirms with Stripe that the
   session is actually **paid** before unlocking. It is safe to run repeatedly.

Nothing from the bill is ever sent to Stripe. Only a random report id and a
generic product name.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /api/audit` | Audit parsed line items. Free report, or summary + `reportId`. |
| `POST /api/create-checkout-session` | Start (or resume) payment for a `reportId`. |
| `POST /api/stripe-webhook` | Stripe calls this. Signature-verified. |
| `GET /api/report/:id` | Full report once paid. Optional `?session_id=` from the return URL. |
| `GET /api/health` | Health check. |

Status codes the website should handle: `402` locked (`pending: true` means a
slower payment is still processing), `409` already paid / payment processing.

## Stripe Dashboard setup (do this in your SANDBOX first)

Menu names change from time to time; these are the settings to look for.

1. **Webhook endpoint:** Developers > Webhooks > add endpoint
   `https://YOUR-SERVER/api/stripe-webhook` and subscribe to exactly these events:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `charge.refunded`
   - `charge.dispute.created`
   Copy its signing secret (`whsec_...`) into `STRIPE_WEBHOOK_SECRET`.
2. **Payment methods:** leave cards, Apple Pay, Google Pay and Link on. Consider
   turning **off** slower bank-debit methods (e.g. ACH): the code handles them
   correctly, but a customer waiting days for a $20 report is a poor experience.
3. **Customer emails:** turn on receipts for successful payments.
4. **Public business details:** set the business name / statement descriptor to
   something recognizable (e.g. `CLAIMSCRUB`). A familiar name on the card
   statement is the best defense against disputes.

## Refunds and disputes

Each payment is tagged with its `reportId`. When a refund or dispute event
arrives, the server finds the report and records `refunded_at` / `disputed_at`
and logs a warning. It does **not** lock the report: whether a refunded report
should stay unlocked is a business decision to settle together with the refund
policy in the Terms of Service.

## Loading billing codes (CPT / HCPCS)

The audit checks each code against a list stored in the database. Until a list
is imported, it uses a small built-in sample. Each kind of code is handled
separately: importing CPT does not affect letter codes (HCPCS) until an HCPCS
file is imported too.

**Keep licensed files private.** Put the AMA file in the `licensed-data/`
folder. That folder is in `.gitignore`, so it never goes to GitHub. Check your
license before sharing the file anywhere, including with an AI assistant.

1. **Preview first.** This reads the file and shows what *would* change. It
   changes nothing, and it does not print any description text:
   ```
   npm run import-codes -- --file licensed-data/YOUR_FILE --set CPT
   ```
   If the file is tab- or pipe-separated, add `--delimiter tab` (or `pipe`). If
   it can't find the right columns, it lists the column names it found; tell it
   which to use with `--code-col` and `--desc-col`. `--help` shows every option,
   including fixed-width files.
2. **Import for real** by adding a name for the import and `--apply`:
   ```
   npm run import-codes -- --file licensed-data/YOUR_FILE --set CPT --source "AMA CPT 2027" --apply
   ```
   It is all-or-nothing: if anything fails, nothing changes. The running server
   picks up the new list within about 30 seconds, without a restart.
3. **Each year,** run the same two steps with the new file. Codes that are no
   longer in the new file are marked *retired*, not deleted, so a bill from an
   earlier year gets a gentle "retired code, check the date of service" note
   instead of "not found." As a safety net, a file that would retire more than
   half of the current list is refused unless you add `--force`.
4. **HCPCS letter codes** are published free by CMS. Load them the same way
   with `--set HCPCS`.

Use `--mode add` for a small supplement file that should only add codes, never
retire any.

To share the importer's output when asking for help, the default output is
safe to share: it shows counts, line numbers and codes, never descriptions.

## Running locally

```
npm install
cp .env.example .env      # then fill in real values
npm run dev
```

Forward Stripe webhooks to your machine with the [Stripe CLI](https://stripe.com/docs/stripe-cli):

```
stripe login
stripe listen --forward-to localhost:3000/api/stripe-webhook
```

It prints a signing secret (`whsec_...`) for `STRIPE_WEBHOOK_SECRET`.

## Tests

```
npm install
npm install --no-save embedded-postgres
npm test
```

The tests run against a real PostgreSQL database and a stand-in for Stripe's
servers, with real webhook signature checking. They cover: no unlock before
payment, delayed payments, webhook retry on failure, return-page confirmation,
double-payment prevention, and refund/dispute tracing. The importer tests use
only made-up codes and cover file formats, bad rows, yearly updates, retired
codes, the partial-file safety net, all-or-nothing imports, and the live
server picking up a new list. `embedded-postgres` is deliberately not in
`package.json`, so Render never installs it.

## Deploying to Render (free tier)

1. Push this folder to GitHub.
2. Render: New > PostgreSQL (free). Copy its **Internal Database URL**.
3. Render: New > Web Service, connect the repo. Build `npm install`, start `npm start`.
4. Environment variables: `DATABASE_URL`, `STRIPE_SECRET_KEY` (test key first),
   `STRIPE_WEBHOOK_SECRET`, `FRONTEND_URL`.
5. Check `https://YOUR-SERVER.onrender.com/api/health` shows `{"ok":true}`.
6. Add the webhook endpoint in Stripe (see above).

Before taking real payments: move to a paid web service (no cold starts delaying
webhooks) and a paid database (the free one expires after 30 days). Then swap in
live Stripe keys and create the webhook endpoint again in live mode.

## Not done yet

- **Website wiring.** The tool page still reveals reports locally. It needs to
  call `/api/audit`, redirect to the checkout URL, and, on return, call
  `/api/report/:id?session_id=...`. `SUCCESS_PATH` / `CANCEL_PATH` (in `config.js`
  or the environment) are placeholders until those pages exist.
- **Sales tax.** Not enabled. Add Stripe Tax only if your accountant says the
  report is taxable.
- **Licensed CPT data.** The importer is ready (see below). Until a file is
  imported, the server uses a small built-in sample of about 85 codes.
- **Data retention.** Reports hold bill line items; set a cleanup schedule that
  matches the final Privacy Policy.
