// The server must start and serve the site even before Stripe keys are added.
const { it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const run = (code, env) => spawnSync(process.execPath, ['-e', code], {
  cwd: path.join(__dirname, '..'), env: { PATH: process.env.PATH, ...env }, encoding: 'utf8',
});

it('without STRIPE_SECRET_KEY the app still loads, and using Stripe gives a clear error', () => {
  const r = run(`
    const stripe = require('./stripeClient');
    require('./app');                       // the whole app loads
    try { stripe.checkout; console.log('NO ERROR'); }
    catch (e) { console.log('CODE=' + e.code); }
  `, { DATABASE_URL: 'postgresql://x:y@localhost:5/z' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /CODE=PAYMENTS_NOT_CONFIGURED/);
  assert.match(r.stderr, /payments are disabled/);
});

it('with STRIPE_SECRET_KEY set, a real Stripe client is created', () => {
  const r = run(`const s = require('./stripeClient'); console.log(typeof s.checkout.sessions.create);`,
    { STRIPE_SECRET_KEY: 'sk_test_dummy' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /function/);
});
