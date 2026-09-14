require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initSchema } = require('./db');

const waitlistRoute = require('./routes/waitlist');
const auditRoute = require('./routes/audit');
const checkoutRoute = require('./routes/checkout');
const webhookRoute = require('./routes/webhook');
const reportRoute = require('./routes/report');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));

// Stripe webhook needs the RAW body for signature verification, so it must
// be mounted before express.json() applies to it.
app.use('/api/stripe-webhook', webhookRoute);

app.use(express.json());

app.use('/api/waitlist', waitlistRoute);
app.use('/api/audit', auditRoute);
app.use('/api/create-checkout-session', checkoutRoute);
app.use('/api/report', reportRoute);

app.get('/api/health', (req, res) => res.json({ ok: true }));

initSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`ClaimScrub server running on port ${PORT}`));
  })
  .catch(err => {
    console.error('Failed to initialize database schema:', err);
    process.exit(1);
  });
