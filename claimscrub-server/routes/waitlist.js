const express = require('express');
const { pool } = require('../db');

const router = express.Router();

router.post('/', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }
  try {
    await pool.query(
      `INSERT INTO waitlist_emails (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`,
      [email]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('waitlist insert failed', err);
    res.status(500).json({ error: 'Something went wrong saving that — please try again.' });
  }
});

module.exports = router;
