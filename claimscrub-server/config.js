// Settings shared across the server. Change the price here, in one place.
module.exports = {
  REPORT_PRICE_CENTS: 2000, // $20.00 flat — never a percentage of anything.
  CURRENCY: 'usd',

  // The page Stripe sends the customer back to after paying or cancelling.
  // The tool page reads the report id from the address and picks up from there.
  SUCCESS_PATH: process.env.SUCCESS_PATH || '/claimscrub-tool.html',
  CANCEL_PATH: process.env.CANCEL_PATH || '/claimscrub-tool.html',

  // Limits on what /api/audit accepts, so a bad or hostile request can't flood it.
  MAX_ITEMS: 500,
};
