// The Express app itself. Kept separate from index.js so it can be tested
// without opening a network port.
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const cors = require('cors');

const auditRoute = require('./routes/audit');
const checkoutRoute = require('./routes/checkout');
const webhookRoute = require('./routes/webhook');
const reportRoute = require('./routes/report');

const app = express();

// On Render (and most hosts) requests arrive through a proxy; this makes
// req.protocol report "https" correctly, which the Stripe return links rely on.
app.set('trust proxy', 1);

// Basic safety headers for every response.
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  res.set('X-Frame-Options', 'DENY');
  next();
});

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));

// Stripe's webhook needs the RAW body for signature verification, so it must be
// mounted before express.json() touches the request.
app.use('/api/stripe-webhook', webhookRoute);

app.use(express.json({ limit: '300kb' }));

app.use('/api/audit', auditRoute);
app.use('/api/create-checkout-session', checkoutRoute);
app.use('/api/report', reportRoute);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Unknown /api/ addresses get a JSON 404 rather than a web page.
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// The website. By default it's the "website" folder next to this server folder in
// the repository; WEBSITE_DIR overrides that. The home page is served at "/".
const WEBSITE_DIR = process.env.WEBSITE_DIR || path.join(__dirname, '..', 'website');
if (fs.existsSync(WEBSITE_DIR)) {
  app.use(express.static(WEBSITE_DIR, { index: 'claimscrub-home.html', extensions: ['html'], dotfiles: 'ignore' }));
} else {
  console.warn('Website folder not found at', WEBSITE_DIR, '- only the API will be served.');
}

// Anything that throws inside a route lands here instead of crashing the server.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
  if (err && err.code === 'PAYMENTS_NOT_CONFIGURED') {
    console.error(err.message);
    return res.status(503).json({ error: 'Payments are not available right now. Nothing was charged.' });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

module.exports = app;
