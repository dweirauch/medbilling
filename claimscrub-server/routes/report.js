const express = require('express');
const { pool } = require('../db');
const asyncHandler = require('../asyncHandler');
const { fulfillCheckoutSession, isUuid } = require('../fulfill');

const router = express.Router();

const getReport = async (id) => (await pool.query(`SELECT * FROM reports WHERE id = $1`, [id])).rows[0];

router.get('/:id', asyncHandler(async (req, res) => {
  const id = req.params.id;
  if (!isUuid(id)) return res.status(404).json({ error: 'Report not found.' });

  let report = await getReport(id);
  if (!report) return res.status(404).json({ error: 'Report not found.' });

  // The customer has just come back from Stripe's payment page. The webhook is
  // the main way a payment gets recorded, but it can arrive a few seconds AFTER
  // the customer is redirected here. So when we're given the checkout session id,
  // ask Stripe directly rather than showing "not paid yet" to someone who just paid.
  const sessionId = req.query.session_id;
  if (!report.paid && typeof sessionId === 'string' && sessionId) {
    try {
      const result = await fulfillCheckoutSession(sessionId);
      // Only count it if that session belongs to THIS report.
      if (result.reportId === id) {
        if (result.fulfilled) report = await getReport(id);
        else if (result.reason === 'not_paid') {
          return res.status(402).json({ paid: false, pending: true, summary: report.summary, error: 'Your payment is still processing.' });
        }
      }
    } catch (err) {
      console.warn('could not verify checkout session on return:', err.message);
    }
  }

  if (!report.paid) {
    // The summary (counts and flagged total) is shown before payment anyway, so it's
    // safe to return; it lets the page rebuild the payment screen after a cancel.
    return res.status(402).json({ error: 'This report has not been unlocked yet.', paid: false, summary: report.summary });
  }

  res.json({ paid: true, results: report.items, summary: report.summary });
}));

module.exports = router;
