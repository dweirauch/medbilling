const express = require('express');
const Stripe = require('stripe');
const { pool } = require('../db');

const router = express.Router();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// IMPORTANT: this route needs the RAW request body (not JSON-parsed) to
// verify the Stripe signature. That's wired up in index.js — this route
// must be mounted BEFORE the global express.json() middleware runs on it.
router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('webhook signature verification failed', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const reportId = session.metadata && session.metadata.reportId;
    if (reportId) {
      try {
        await pool.query(
          `UPDATE reports SET paid = true, paid_at = now() WHERE id = $1`,
          [reportId]
        );
        console.log('Report unlocked after payment:', reportId);
      } catch (err) {
        console.error('failed to mark report paid', err);
      }
    }
  }

  res.json({ received: true });
});

module.exports = router;
