const express = require('express');
const stripe = require('../stripeClient');
const asyncHandler = require('../asyncHandler');
const { fulfillCheckoutSession, recordPaymentEvent } = require('../fulfill');

const router = express.Router();

async function handleEvent(event) {
  const obj = event.data.object;

  switch (event.type) {
    // Instant payments (cards, wallets) arrive here already paid. Slower payment
    // methods arrive here "unpaid" and are finished by async_payment_succeeded.
    // fulfillCheckoutSession() checks the real payment status either way.
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const result = await fulfillCheckoutSession(obj.id);
      if (result.fulfilled) console.log('Report unlocked after payment:', result.reportId);
      break;
    }
    case 'checkout.session.async_payment_failed':
      console.warn('A delayed payment FAILED for report', obj.client_reference_id || (obj.metadata && obj.metadata.reportId));
      break;

    case 'charge.refunded':
      await recordPaymentEvent('refunded_at', obj.payment_intent, obj.metadata, 'REFUND');
      break;
    case 'charge.dispute.created':
      await recordPaymentEvent('disputed_at', obj.payment_intent, null, 'DISPUTE');
      break;

    default:
      break; // events we don't need are acknowledged and ignored
  }
}

// IMPORTANT: this route needs the RAW request body (not JSON-parsed) to verify
// Stripe's signature. app.js mounts it BEFORE express.json().
router.post('/', express.raw({ type: 'application/json' }), asyncHandler(async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    await handleEvent(event);
  } catch (err) {
    // A real failure (database down, Stripe unreachable). Answer 500 so Stripe
    // RETRIES this event later — answering 200 here would silently drop a paid
    // customer's unlock with no second chance.
    console.error(`webhook handler failed for ${event.type} (${event.id}); asking Stripe to retry`, err);
    return res.status(500).json({ error: 'temporary failure, please retry' });
  }

  res.json({ received: true });
}));

module.exports = router;
