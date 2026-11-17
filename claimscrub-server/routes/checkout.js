const express = require('express');
const stripe = require('../stripeClient');
const { pool } = require('../db');
const asyncHandler = require('../asyncHandler');
const { fulfillCheckoutSession, isUuid } = require('../fulfill');
const { REPORT_PRICE_CENTS, CURRENCY, SUCCESS_PATH, CANCEL_PATH } = require('../config');

const router = express.Router();

router.post('/', asyncHandler(async (req, res) => {
  const reportId = req.body && req.body.reportId;
  if (!isUuid(reportId)) return res.status(400).json({ error: 'Missing or invalid reportId.' });

  const { rows } = await pool.query(`SELECT * FROM reports WHERE id = $1`, [reportId]);
  const report = rows[0];
  if (!report) return res.status(404).json({ error: 'Report not found.' });
  if (report.paid) return res.status(409).json({ error: 'This report has already been unlocked.', alreadyPaid: true });

  // Never let the same report be paid for twice (e.g. a double-click, or coming
  // back to the page while an earlier checkout is still open or still processing).
  if (report.stripe_session_id) {
    let previous = null;
    try {
      previous = await stripe.checkout.sessions.retrieve(report.stripe_session_id);
    } catch (err) {
      console.warn('could not look up the earlier checkout session; starting a new one', err.message);
    }
    if (previous) {
      if (previous.payment_status === 'paid') {
        await fulfillCheckoutSession(previous.id); // webhook was slow — unlock now
        return res.status(409).json({ error: 'This report has already been paid for.', alreadyPaid: true });
      }
      if (previous.status === 'complete') {
        return res.status(409).json({ error: 'Your payment is still processing.', pending: true });
      }
      if (previous.status === 'open' && previous.url) {
        return res.json({ url: previous.url, reused: true }); // same checkout page, no duplicate
      }
      // status "expired" -> fall through and create a fresh one
    }
  }

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    // No payment_method_types on purpose: Stripe shows each customer the best
    // options (cards, Apple Pay, Google Pay, Link, ...) based on what is turned
    // on in your Stripe Dashboard > Settings > Payment methods.
    line_items: [{
      price_data: {
        currency: CURRENCY,
        unit_amount: REPORT_PRICE_CENTS,
        product_data: {
          name: 'ClaimScrub Full Report',
          description: 'Detailed medical bill audit report. Flat fee, only charged when likely errors were found.',
        },
      },
      quantity: 1,
    }],
    // Tag BOTH the checkout session and the underlying payment with our report
    // id. Refunds and disputes attach to the payment, so this is what lets us
    // trace one back to its report later. Only a random id — never bill contents.
    client_reference_id: reportId,
    metadata: { reportId },
    payment_intent_data: {
      metadata: { reportId },
      description: 'ClaimScrub full report',
    },
    success_url: `${frontendUrl}${SUCCESS_PATH}?reportId=${reportId}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${frontendUrl}${CANCEL_PATH}?canceled=true`,
  });

  await pool.query(`UPDATE reports SET stripe_session_id = $1 WHERE id = $2`, [session.id, reportId]);

  res.json({ url: session.url });
}));

module.exports = router;
