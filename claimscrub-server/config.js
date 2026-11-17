// Settings shared across the server. Change the price here, in one place.
module.exports = {
  REPORT_PRICE_CENTS: 2000, // $20.00 flat — never a percentage of anything.
  CURRENCY: 'usd',

  // Where Stripe sends the customer after checkout. These are paths on your
  // FRONTEND_URL. They are placeholders until the website pages are wired up.
  SUCCESS_PATH: process.env.SUCCESS_PATH || '/report.html',
  CANCEL_PATH: process.env.CANCEL_PATH || '/index.html',
};
