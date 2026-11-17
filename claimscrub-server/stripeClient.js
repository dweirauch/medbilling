// One shared Stripe client for the whole server.
//
// If STRIPE_SECRET_KEY isn't set yet, the server still starts: the website and
// free checks work, and anything that needs Stripe fails with a clear
// "payments aren't set up yet" error (the API answers 503) instead of the whole
// server refusing to start.
const Stripe = require('stripe');

class PaymentsNotConfiguredError extends Error {
  constructor() {
    super('Payments are not set up yet: STRIPE_SECRET_KEY is missing. Add it on the Environment tab in Render (or in .env locally).');
    this.code = 'PAYMENTS_NOT_CONFIGURED';
  }
}

const key = process.env.STRIPE_SECRET_KEY;

const client = key
  // maxNetworkRetries: automatically retry brief network hiccups talking to Stripe.
  ? Stripe(key, { maxNetworkRetries: 2 })
  : new Proxy({}, { get(_target, prop) {
      if (prop === 'isConfigured') return false;
      if (prop === 'then' || typeof prop === 'symbol') return undefined; // not a promise / inspection
      throw new PaymentsNotConfiguredError();
    } });

if (!key) console.warn('WARNING: STRIPE_SECRET_KEY is not set. The site works, but payments are disabled until it is.');

module.exports = client;
module.exports.PaymentsNotConfiguredError = PaymentsNotConfiguredError;
