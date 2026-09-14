const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db');
const { auditItems, summarize } = require('../rulesEngine');

const router = express.Router();

// Client sends the parsed line items (code, modifier, desc, qty, charge) —
// parsing/OCR still happens in the browser, but the AUDIT DECISION happens
// here, server-side, so it can't be spoofed by editing client JS.
router.post('/', async (req, res) => {
  const items = req.body.items;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'No line items provided.' });
  }

  let results;
  try {
    results = auditItems(items);
  } catch (err) {
    console.error('audit failed', err);
    return res.status(500).json({ error: 'Could not run the audit on that data.' });
  }

  const summary = summarize(results);

  if (summary.redCount === 0) {
    // Nothing likely wrong — free, return the full report immediately.
    return res.json({ paid: true, free: true, results, summary });
  }

  // Likely errors found — store the full results server-side, only return
  // the summary. The detailed report is fetched later via /api/report/:id,
  // and only after payment is confirmed.
  const reportId = uuidv4();
  try {
    await pool.query(
      `INSERT INTO reports (id, items, summary, paid) VALUES ($1, $2, $3, false)`,
      [reportId, JSON.stringify(results), JSON.stringify(summary)]
    );
  } catch (err) {
    console.error('report insert failed', err);
    return res.status(500).json({ error: 'Could not save the report.' });
  }

  res.json({ paid: false, free: false, reportId, summary });
});

module.exports = router;
