const express = require('express');
const { pool } = require('../db');

const router = express.Router();

router.get('/:id', async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM reports WHERE id = $1`, [req.params.id]);
  const report = rows[0];
  if (!report) return res.status(404).json({ error: 'Report not found.' });

  if (!report.paid) {
    return res.status(402).json({ error: 'This report has not been unlocked yet.', paid: false });
  }

  res.json({ paid: true, results: report.items, summary: report.summary });
});

module.exports = router;
