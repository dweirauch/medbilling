const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db');
const asyncHandler = require('../asyncHandler');
const { auditItems, summarize } = require('../rulesEngine');
const { getReference } = require('../referenceStore');
const { MAX_ITEMS } = require('../config');

const router = express.Router();

// Keep only the fields the audit uses, with sane types and lengths. Anything else
// the browser sends is dropped, so it never reaches the database.
function cleanItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const code = typeof raw.code === 'string' ? raw.code.trim().toUpperCase().slice(0, 10) : '';
  if (!code) return null;
  const modifier = typeof raw.modifier === 'string' && raw.modifier.trim()
    ? raw.modifier.trim().toUpperCase().slice(0, 4) : null;
  const desc = typeof raw.desc === 'string' ? raw.desc.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  const qtyNum = Number(raw.qty);
  const qty = Number.isFinite(qtyNum) && qtyNum >= 1 && qtyNum <= 9999 ? Math.floor(qtyNum) : 1;
  const chargeNum = Number(raw.charge);
  const charge = raw.charge == null || !Number.isFinite(chargeNum) || chargeNum < 0 || chargeNum > 10000000
    ? null : Math.round(chargeNum * 100) / 100;
  return { code, modifier, desc, qty, charge };
}

// The browser reads the bill and sends the parsed line items. The AUDIT DECISION
// happens here, so it can't be changed by editing the page.
router.post('/', asyncHandler(async (req, res) => {
  const raw = req.body && req.body.items;
  if (!Array.isArray(raw) || raw.length === 0) {
    return res.status(400).json({ error: 'No line items provided.' });
  }
  if (raw.length > MAX_ITEMS) {
    return res.status(413).json({ error: `That bill has more than ${MAX_ITEMS} lines. Please split it into smaller parts.` });
  }
  const items = raw.map(cleanItem).filter(Boolean);
  if (items.length === 0) return res.status(400).json({ error: 'No usable line items provided.' });

  const results = auditItems(items, await getReference());
  const summary = summarize(results);

  if (summary.redCount === 0) {
    // Nothing likely wrong: free, and nothing is stored.
    return res.json({ paid: true, free: true, results, summary });
  }

  // Likely errors: store the full report, return only the summary. The details
  // are released by /api/report/:id after payment.
  const reportId = uuidv4();
  await pool.query(
    `INSERT INTO reports (id, items, summary, paid) VALUES ($1, $2, $3, false)`,
    [reportId, JSON.stringify(results), JSON.stringify(summary)]
  );
  res.json({ paid: false, free: false, reportId, summary });
}));

module.exports = router;
