// The Express app itself. Kept separate from index.js so it can be tested
// without opening a network port.
const express = require('express');
const cors = require('cors');

const auditRoute = require('./routes/audit');
const checkoutRoute = require('./routes/checkout');
const webhookRoute = require('./routes/webhook');
const reportRoute = require('./routes/report');

const app = express();

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));

// Stripe's webhook needs the RAW body for signature verification, so it must be
// mounted before express.json() touches the request.
app.use('/api/stripe-webhook', webhookRoute);

app.use(express.json());

app.use('/api/audit', auditRoute);
app.use('/api/create-checkout-session', checkoutRoute);
app.use('/api/report', reportRoute);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Anything that throws inside a route lands here instead of crashing the server.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

module.exports = app;
