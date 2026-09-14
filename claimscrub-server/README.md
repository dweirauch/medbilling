# ClaimScrub Server

Backend for ClaimScrub: re-runs the audit server-side (so the paywall can't
be bypassed by editing browser JavaScript), creates Stripe Checkout sessions,
confirms payment via webhook, and stores waitlist emails.

## What this does NOT do yet
- OCR and initial parsing still happen in the browser (claimscrub-tool.html).
  This server only re-runs the *rules engine* on the parsed line items.
- No user accounts / login — reports are accessed by a random ID, not tied
  to a person.
- Uses a demo ~85-code reference set (rulesEngine.js), same limitation as
  the browser tool, until the CPT license/data file is ready.

## Local setup

1. Install dependencies:
   ```
   npm install
   ```
2. Copy `.env.example` to `.env` and fill in real values (a local Postgres
   connection string, and TEST-mode Stripe keys from your Stripe dashboard).
3. Run it:
   ```
   npm run dev
   ```
4. Test the health check: `curl http://localhost:3000/api/health`

## Testing Stripe webhooks locally

Stripe needs a way to reach your webhook endpoint. Install the [Stripe CLI](https://stripe.com/docs/stripe-cli), then:

```
stripe login
stripe listen --forward-to localhost:3000/api/stripe-webhook
```

This prints a webhook signing secret (`whsec_...`) — put that in your `.env`
as `STRIPE_WEBHOOK_SECRET`. Leave this running while you test.

## Deploying to Render (free tier)

1. Push this folder to a GitHub repository.
2. In the Render dashboard: **New > PostgreSQL** — create a free database.
   Copy its "Internal Database URL" once created.
3. In the Render dashboard: **New > Web Service** — connect your GitHub repo.
   - Build command: `npm install`
   - Start command: `npm start`
4. Under the web service's **Environment** tab, add:
   - `DATABASE_URL` — paste the Internal Database URL from step 2
   - `STRIPE_SECRET_KEY` — your Stripe TEST key to start
   - `STRIPE_WEBHOOK_SECRET` — see below
   - `FRONTEND_URL` — wherever the frontend ends up hosted
5. Deploy. Render gives you a public URL like `https://claimscrub-server.onrender.com`.
6. In the Stripe dashboard (test mode): **Developers > Webhooks > Add endpoint**
   — point it at `https://claimscrub-server.onrender.com/api/stripe-webhook`,
   subscribe to the `checkout.session.completed` event, and copy the signing
   secret into Render's `STRIPE_WEBHOOK_SECRET`.

## Remember (per our earlier conversation)
- Free tier is fine for this testing phase. Before taking real payments,
  upgrade to a paid web service (avoids cold starts delaying webhook
  delivery) and a paid database (the free one expires after 30 days).
- Switch `STRIPE_SECRET_KEY` and the webhook endpoint from test mode to
  live mode only once you're actually ready to charge real cards.
