// End-to-end tests for the payment flow.
//
// Uses a REAL Postgres (embedded-postgres) and a FAKE Stripe API, but real
// webhook signature checking (events are signed exactly the way Stripe signs them).
//
// To run:  npm install && npm install --no-save embedded-postgres && npm test
// (embedded-postgres is deliberately NOT in package.json so Render never installs it.)

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const WEBHOOK_SECRET = 'whsec_test_secret';
const PG_PORT = 54000 + Math.floor(Math.random() * 900);

let pg, server, baseUrl, pool, stripeCalls, sessions, paymentIntents, failNextUpdate, realStripe;

// ---------------------------------------------------------------- fake Stripe
function installFakeStripe() {
  realStripe = require('stripe')('sk_test_dummy');
  sessions = new Map();
  paymentIntents = new Map();
  stripeCalls = { create: [] };
  let n = 0;

  const notFound = (what, id) => {
    const e = new Error(`No such ${what}: '${id}'`);
    e.type = 'StripeInvalidRequestError';
    return e;
  };

  const fake = {
    webhooks: realStripe.webhooks, // REAL signature verification
    checkout: {
      sessions: {
        create: async (params) => {
          if (fake.failCreate) throw new Error('Stripe is down');
          stripeCalls.create.push(params);
          const id = 'cs_test_' + ++n;
          const s = {
            id, object: 'checkout.session', url: 'https://checkout.stripe.test/' + id,
            status: 'open', payment_status: 'unpaid',
            client_reference_id: params.client_reference_id, metadata: params.metadata,
            payment_intent: null,
          };
          sessions.set(id, s);
          return { ...s };
        },
        retrieve: async (id) => {
          if (!sessions.has(id)) throw notFound('checkout.session', id);
          return { ...sessions.get(id) };
        },
      },
    },
    paymentIntents: {
      retrieve: async (id) => {
        if (!paymentIntents.has(id)) throw notFound('payment_intent', id);
        return paymentIntents.get(id);
      },
    },
  };

  const modPath = require.resolve(path.join(__dirname, '..', 'stripeClient'));
  require.cache[modPath] = { id: modPath, filename: modPath, loaded: true, exports: fake };
  return fake;
}

// Simulate the customer finishing checkout.
function customerPays(sessionId, { delayed = false } = {}) {
  const s = sessions.get(sessionId);
  s.status = 'complete';
  s.payment_status = delayed ? 'unpaid' : 'paid';
  s.payment_intent = 'pi_' + sessionId;
  paymentIntents.set(s.payment_intent, { id: s.payment_intent, metadata: { reportId: s.client_reference_id } });
}
function paymentClears(sessionId) { sessions.get(sessionId).payment_status = 'paid'; }

// ---------------------------------------------------------------- helpers
async function api(method, url, body) {
  const res = await fetch(baseUrl + url, {
    method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

async function deliverWebhook(type, object, { secret = WEBHOOK_SECRET } = {}) {
  const payload = JSON.stringify({ id: 'evt_' + Math.random().toString(36).slice(2), object: 'event', type, data: { object } });
  const header = realStripe.webhooks.generateTestHeaderString({ payload, secret });
  const res = await fetch(baseUrl + '/api/stripe-webhook', {
    method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': header }, body: payload,
  });
  return res.status;
}

const DUPLICATE_BILL = [
  { code: '99284', modifier: null, desc: '', qty: 1, charge: 2190 },
  { code: '99284', modifier: null, desc: '', qty: 1, charge: 2190 },
  { code: '80053', modifier: null, desc: '', qty: 1, charge: 395 },
];
const CLEAN_BILL = [
  { code: '80053', modifier: null, desc: '', qty: 1, charge: 395 },
  { code: '71046', modifier: null, desc: '', qty: 1, charge: 298 },
];

async function newUnpaidReport() {
  const { json } = await api('POST', '/api/audit', { items: DUPLICATE_BILL });
  assert.equal(json.paid, false);
  return json.reportId;
}
async function startCheckout(reportId) {
  const r = await api('POST', '/api/create-checkout-session', { reportId });
  assert.equal(r.status, 200, 'checkout should start');
  const sessionId = [...sessions.values()].find(s => r.json.url.endsWith(s.id)).id;
  return { sessionId, url: r.json.url };
}
const dbRow = async (id) => (await pool.query('SELECT * FROM reports WHERE id = $1', [id])).rows[0];

// ---------------------------------------------------------------- setup
describe('ClaimScrub payment flow', () => {
  before(async () => {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    pg = new EmbeddedPostgres({
      databaseDir: '/tmp/claimscrub-test-pg-' + PG_PORT, user: 'postgres', password: 'pw', port: PG_PORT,
      persistent: false, createPostgresUser: process.getuid && process.getuid() === 0,
    });
    await pg.initialise();
    await pg.start();

    process.env.DATABASE_URL = `postgresql://postgres:pw@localhost:${PG_PORT}/postgres`;
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.FRONTEND_URL = 'https://site.test';

    installFakeStripe();
    ({ pool } = require('../db'));
    await require('../db').initSchema();

    // Lets one test make the next "mark as paid" database write fail.
    failNextUpdate = false;
    const originalQuery = pool.query.bind(pool);
    pool.query = (...args) => {
      if (failNextUpdate && /UPDATE reports\s+SET paid/i.test(String(args[0]))) {
        failNextUpdate = false;
        return Promise.reject(new Error('simulated database outage'));
      }
      return originalQuery(...args);
    };

    const app = require('../app');
    await new Promise(resolve => { server = app.listen(0, resolve); });
    baseUrl = 'http://127.0.0.1:' + server.address().port;
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
    await pool.end();
    await pg.stop();
  });

  beforeEach(() => { stripeCalls.create.length = 0; });

  // ------------------------------------------------------------ basics
  it('a clean bill is free and returns the full report immediately', async () => {
    const r = await api('POST', '/api/audit', { items: CLEAN_BILL });
    assert.equal(r.status, 200);
    assert.equal(r.json.paid, true);
    assert.equal(r.json.free, true);
    assert.ok(Array.isArray(r.json.results));
  });

  it('a bill with errors returns ONLY a summary, and the report stays locked', async () => {
    const r = await api('POST', '/api/audit', { items: DUPLICATE_BILL });
    assert.equal(r.json.paid, false);
    assert.equal(r.json.results, undefined, 'detailed results must not be sent before payment');
    assert.ok(r.json.summary.redCount >= 1);
    const locked = await api('GET', '/api/report/' + r.json.reportId);
    assert.equal(locked.status, 402);
    assert.equal(locked.json.results, undefined);
  });

  it('rejects malformed JSON and bad ids without crashing', async () => {
    const res = await fetch(baseUrl + '/api/audit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
    assert.equal(res.status, 400);
    assert.equal((await api('POST', '/api/create-checkout-session', { reportId: 'nope' })).status, 400);
    assert.equal((await api('POST', '/api/create-checkout-session', { reportId: '11111111-1111-4111-8111-111111111111' })).status, 404);
    assert.equal((await api('GET', '/api/report/not-a-uuid')).status, 404);
  });

  // ------------------------------------------------------------ FIX 4 + 5: checkout parameters
  it('FIX 4 + 5: checkout tags the payment with the report id and lets Stripe pick payment methods', async () => {
    const reportId = await newUnpaidReport();
    const { sessionId } = await startCheckout(reportId);
    const p = stripeCalls.create[0];

    assert.equal(p.mode, 'payment');
    assert.equal(p.payment_method_types, undefined, 'must NOT force card-only');
    assert.equal(p.line_items[0].price_data.unit_amount, 2000);
    assert.equal(p.line_items[0].price_data.currency, 'usd');
    assert.equal(p.client_reference_id, reportId);
    assert.equal(p.metadata.reportId, reportId);
    assert.equal(p.payment_intent_data.metadata.reportId, reportId, 'the PAYMENT itself must carry the report id');
    assert.ok(p.success_url.includes('{CHECKOUT_SESSION_ID}'));
    assert.ok(p.success_url.startsWith('https://site.test/'));
    // privacy: nothing from the bill itself goes to Stripe
    const sent = JSON.stringify(p);
    assert.ok(!sent.includes('99284') && !sent.includes('2190'), 'no bill contents may be sent to Stripe');
    assert.equal((await dbRow(reportId)).stripe_session_id, sessionId);
  });

  it('asking for checkout twice reuses the open page instead of creating a second one', async () => {
    const reportId = await newUnpaidReport();
    const first = await startCheckout(reportId);
    const second = await api('POST', '/api/create-checkout-session', { reportId });
    assert.equal(second.status, 200);
    assert.equal(second.json.url, first.url);
    assert.equal(stripeCalls.create.length, 1, 'only one Stripe session may exist');
  });

  it('a Stripe outage while starting checkout returns a clean error, not a crash', async () => {
    const reportId = await newUnpaidReport();
    require('../stripeClient').failCreate = true;
    const r = await api('POST', '/api/create-checkout-session', { reportId });
    require('../stripeClient').failCreate = false;
    assert.equal(r.status, 500);
    assert.ok(r.json.error);
    assert.equal((await api('GET', '/api/health')).status, 200, 'server still alive');
  });

  // ------------------------------------------------------------ webhook security
  it('rejects webhooks with a bad signature (400) and never unlocks anything', async () => {
    const reportId = await newUnpaidReport();
    const { sessionId } = await startCheckout(reportId);
    customerPays(sessionId);
    const status = await deliverWebhook('checkout.session.completed', { id: sessionId }, { secret: 'whsec_WRONG' });
    assert.equal(status, 400);
    assert.equal((await dbRow(reportId)).paid, false);
  });

  // ------------------------------------------------------------ FIX 1: confirm it was really paid
  it('FIX 1: "completed" with payment still UNPAID (delayed method) does NOT unlock', async () => {
    const reportId = await newUnpaidReport();
    const { sessionId } = await startCheckout(reportId);
    customerPays(sessionId, { delayed: true });

    assert.equal(await deliverWebhook('checkout.session.completed', { id: sessionId }), 200);
    assert.equal((await dbRow(reportId)).paid, false, 'must stay locked until money actually arrives');
    assert.equal((await api('GET', '/api/report/' + reportId)).status, 402);
    // and the customer can't start a second payment while the first is processing
    const again = await api('POST', '/api/create-checkout-session', { reportId });
    assert.equal(again.status, 409);
    assert.equal(again.json.pending, true);
  });

  it('FIX 1: the later "async payment succeeded" event unlocks it', async () => {
    const reportId = await newUnpaidReport();
    const { sessionId } = await startCheckout(reportId);
    customerPays(sessionId, { delayed: true });
    await deliverWebhook('checkout.session.completed', { id: sessionId });
    assert.equal((await dbRow(reportId)).paid, false);

    paymentClears(sessionId);
    assert.equal(await deliverWebhook('checkout.session.async_payment_succeeded', { id: sessionId }), 200);
    const row = await dbRow(reportId);
    assert.equal(row.paid, true);
    assert.equal(row.stripe_payment_intent_id, 'pi_' + sessionId);
  });

  it('a failed delayed payment is acknowledged and leaves the report locked', async () => {
    const reportId = await newUnpaidReport();
    const { sessionId } = await startCheckout(reportId);
    customerPays(sessionId, { delayed: true });
    assert.equal(await deliverWebhook('checkout.session.async_payment_failed', { id: sessionId, client_reference_id: reportId }), 200);
    assert.equal((await dbRow(reportId)).paid, false);
  });

  it('a normal paid card payment unlocks, and duplicate webhook deliveries are harmless', async () => {
    const reportId = await newUnpaidReport();
    const { sessionId } = await startCheckout(reportId);
    customerPays(sessionId);

    assert.equal(await deliverWebhook('checkout.session.completed', { id: sessionId }), 200);
    const firstPaidAt = (await dbRow(reportId)).paid_at;
    assert.equal(await deliverWebhook('checkout.session.completed', { id: sessionId }), 200);
    const row = await dbRow(reportId);
    assert.equal(row.paid, true);
    assert.equal(row.paid_at.getTime(), firstPaidAt.getTime(), 'paid_at must not change on a repeat delivery');

    const r = await api('GET', '/api/report/' + reportId);
    assert.equal(r.status, 200);
    assert.equal(r.json.paid, true);
    assert.ok(r.json.results.length > 0);
    assert.equal((await api('POST', '/api/create-checkout-session', { reportId })).status, 409);
  });

  // ------------------------------------------------------------ FIX 2: retry on failure
  it('FIX 2: if saving "paid" fails, the webhook answers 500 so Stripe retries — and the retry succeeds', async () => {
    const reportId = await newUnpaidReport();
    const { sessionId } = await startCheckout(reportId);
    customerPays(sessionId);

    failNextUpdate = true;
    assert.equal(await deliverWebhook('checkout.session.completed', { id: sessionId }), 500, 'must tell Stripe to retry');
    assert.equal((await dbRow(reportId)).paid, false);

    assert.equal(await deliverWebhook('checkout.session.completed', { id: sessionId }), 200, 'Stripe retry');
    assert.equal((await dbRow(reportId)).paid, true, 'the customer still gets their report');
  });

  it('an unrecognised event type is acknowledged (200) and ignored', async () => {
    assert.equal(await deliverWebhook('customer.created', { id: 'cus_1' }), 200);
  });

  // ------------------------------------------------------------ FIX 3: return page
  it('FIX 3: the return page unlocks the report even when the webhook has NOT arrived yet', async () => {
    const reportId = await newUnpaidReport();
    const { sessionId } = await startCheckout(reportId);
    customerPays(sessionId);
    // no webhook delivered at all
    assert.equal((await dbRow(reportId)).paid, false);

    const r = await api('GET', `/api/report/${reportId}?session_id=${sessionId}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.paid, true);
    assert.ok(r.json.results.length > 0);
    assert.equal((await dbRow(reportId)).paid, true);
  });

  it('FIX 3: return page shows "still processing" for a delayed payment, not "unpaid"', async () => {
    const reportId = await newUnpaidReport();
    const { sessionId } = await startCheckout(reportId);
    customerPays(sessionId, { delayed: true });
    const r = await api('GET', `/api/report/${reportId}?session_id=${sessionId}`);
    assert.equal(r.status, 402);
    assert.equal(r.json.pending, true);
  });

  it('FIX 3 (security): a paid session for ANOTHER report cannot unlock this one', async () => {
    const reportA = await newUnpaidReport();
    const reportB = await newUnpaidReport();
    await startCheckout(reportA);
    const b = await startCheckout(reportB);
    customerPays(b.sessionId);

    const r = await api('GET', `/api/report/${reportA}?session_id=${b.sessionId}`);
    assert.equal(r.status, 402, 'report A must stay locked');
    assert.equal(r.json.results, undefined);
    assert.equal((await dbRow(reportA)).paid, false);
  });

  it('FIX 3 (security): a made-up session id is rejected without errors or leaks', async () => {
    const reportId = await newUnpaidReport();
    const r = await api('GET', `/api/report/${reportId}?session_id=cs_test_totally_fake`);
    assert.equal(r.status, 402);
    assert.equal(r.json.results, undefined);
  });

  it('paying twice is prevented: if an earlier session was paid but the webhook is late, a new checkout request unlocks and refuses', async () => {
    const reportId = await newUnpaidReport();
    const { sessionId } = await startCheckout(reportId);
    customerPays(sessionId); // paid, webhook slow

    const again = await api('POST', '/api/create-checkout-session', { reportId });
    assert.equal(again.status, 409);
    assert.equal(again.json.alreadyPaid, true);
    assert.equal(stripeCalls.create.length, 1, 'no second Stripe session');
    assert.equal((await dbRow(reportId)).paid, true);
  });

  // ------------------------------------------------------------ FIX 4: tracing refunds & disputes
  it('FIX 4: a refund is traced to its report from the payment tag, and the report is not re-locked', async () => {
    const reportId = await newUnpaidReport();
    const { sessionId } = await startCheckout(reportId);
    customerPays(sessionId);
    await deliverWebhook('checkout.session.completed', { id: sessionId });

    // Stripe copies the payment's metadata onto the charge, so it arrives on the event
    const status = await deliverWebhook('charge.refunded', { id: 'ch_1', payment_intent: 'pi_' + sessionId, metadata: { reportId } });
    assert.equal(status, 200);
    const row = await dbRow(reportId);
    assert.ok(row.refunded_at, 'refund recorded');
    assert.equal(row.paid, true, 'access policy unchanged by a refund record');
  });

  it('FIX 4: a dispute is traced to its report by looking up the payment', async () => {
    const reportId = await newUnpaidReport();
    const { sessionId } = await startCheckout(reportId);
    customerPays(sessionId);
    await deliverWebhook('checkout.session.completed', { id: sessionId });

    // Disputes carry no metadata of their own — only the payment id.
    const status = await deliverWebhook('charge.dispute.created', { id: 'dp_1', charge: 'ch_1', payment_intent: 'pi_' + sessionId });
    assert.equal(status, 200);
    assert.ok((await dbRow(reportId)).disputed_at, 'dispute recorded against the right report');
  });

  it('a dispute for a payment we cannot match is logged and acknowledged, not fatal', async () => {
    paymentIntents.set('pi_orphan', { id: 'pi_orphan', metadata: {} });
    assert.equal(await deliverWebhook('charge.dispute.created', { id: 'dp_2', payment_intent: 'pi_orphan' }), 200);
  });
});
