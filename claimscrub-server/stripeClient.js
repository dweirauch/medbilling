// One shared Stripe client for the whole server (instead of one per route file).
const Stripe = require('stripe');

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error(
    'STRIPE_SECRET_KEY is not set. Add it to your .env file (local) or the Environment tab on Render (deployed).'
  );
}

// maxNetworkRetries: automatically retry brief network hiccups talking to Stripe.
module.exports = Stripe(process.env.STRIPE_SECRET_KEY, { maxNetworkRetries: 2 });
