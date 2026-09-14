const express = require('express');
const Stripe = require('stripe');
const { pool } = require('../db');

const router = express.Router();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const REPORT_PRICE_CENTS = 2000; // $20.00 flat, per business decision — never a percentage.

router.post('/', async (req, res) => {
  const { reportId } = req.body;
  if (!reportId) return res.status(400).json({ error: 'Missing reportId.' });

  const { rows } = await pool.query(`SELECT * FROM reports WHERE id = $1`, [reportId]);
  const report = rows[0];
  if (!report) return res.status(404).json({ error: 'Report not found.' });
  if (report.paid) return res.status(400).json({ error: 'This report has already been unlocked.' });

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: REPORT_PRICE_CENTS,
          product_data: {
            name: 'ClaimScrub Full Report',
            description: 'Detailed medical bill audit report — flat fee, only charged when likely errors were found.',
          },
        },
        quantity: 1,
      }],
      metadata: { reportId },
      success_url: `${frontendUrl}/report.html?reportId=${reportId}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/index.html?canceled=true`,
    });

    await pool.query(`UPDATE reports SET stripe_session_id = $1 WHERE id = $2`, [session.id, reportId]);

    res.json({ url: session.url });
  } catch (err) {
    console.error('stripe session creation failed', err);
    res.status(500).json({ error: 'Could not start checkout.' });
  }
});

module.exports = router;
