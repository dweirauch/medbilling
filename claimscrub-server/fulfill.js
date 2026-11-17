const stripe = require('./stripeClient');
const { pool } = require('./db');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

/**
 * Confirm with Stripe that a Checkout Session was actually PAID, and unlock the
 * matching report. Safe to call any number of times (webhook retries, the
 * customer reloading the return page, both at once) — unlocking is idempotent.
 *
 * Why it asks Stripe instead of trusting the event/URL it was handed:
 *  - "checkout.session.completed" does NOT always mean money arrived. For slower
 *    payment methods the session completes while payment_status is still "unpaid".
 *  - A fresh lookup is the authoritative answer.
 *
 * Returns { fulfilled, reportId, reason }.
 * Throws only on real failures (Stripe unreachable, database error) — callers
 * should let the webhook answer 500 so Stripe retries later.
 */
async function fulfillCheckoutSession(sessionId) {
  const session = await stripe.checkout.sessions.retrieve(sessionId);

  const reportId = session.client_reference_id || (session.metadata && session.metadata.reportId) || null;
  if (!isUuid(reportId)) {
    console.warn('Checkout session has no valid report id:', session.id);
    return { fulfilled: false, reportId: null, reason: 'no_report_id' };
  }

  if (session.payment_status !== 'paid') {
    // Not an error: e.g. a delayed payment method that hasn't cleared yet.
    // A later "async_payment_succeeded" event will call us again.
    return { fulfilled: false, reportId, reason: 'not_paid', paymentStatus: session.payment_status };
  }

  const paymentIntentId = typeof session.payment_intent === 'string'
    ? session.payment_intent
    : (session.payment_intent && session.payment_intent.id) || null;

  const { rowCount } = await pool.query(
    `UPDATE reports
        SET paid = true,
            paid_at = COALESCE(paid_at, now()),
            stripe_session_id = $2,
            stripe_payment_intent_id = COALESCE($3, stripe_payment_intent_id)
      WHERE id = $1`,
    [reportId, session.id, paymentIntentId]
  );

  if (rowCount === 0) {
    // Paid, but we have no such report. Needs a human look — log loudly.
    console.error('PAID session for a report that does not exist:', { reportId, session: session.id });
    return { fulfilled: false, reportId, reason: 'unknown_report' };
  }

  return { fulfilled: true, reportId };
}

/**
 * Refunds and disputes are attached to the PAYMENT, not the checkout page. We
 * tag each payment with its report id at checkout, so we can find the report
 * again here. This only RECORDS the event (it does not lock the report) —
 * whether a refunded report should stay unlocked is a business-policy decision.
 */
async function reportIdForPayment(paymentIntentId, ownMetadata) {
  if (ownMetadata && isUuid(ownMetadata.reportId)) return ownMetadata.reportId;
  if (!paymentIntentId) return null;
  const pi = await stripe.paymentIntents.retrieve(
    typeof paymentIntentId === 'string' ? paymentIntentId : paymentIntentId.id
  );
  return pi.metadata && isUuid(pi.metadata.reportId) ? pi.metadata.reportId : null;
}

async function recordPaymentEvent(column, paymentIntentId, ownMetadata, label) {
  if (!['refunded_at', 'disputed_at'].includes(column)) throw new Error('bad column'); // never user input
  const reportId = await reportIdForPayment(paymentIntentId, ownMetadata);
  if (!reportId) {
    console.error(`${label}: could not match this payment to a report`, { paymentIntentId });
    return { recorded: false };
  }
  await pool.query(`UPDATE reports SET ${column} = COALESCE(${column}, now()) WHERE id = $1`, [reportId]);
  console.warn(`${label} for report ${reportId} — review in the Stripe dashboard.`);
  return { recorded: true, reportId };
}

module.exports = { fulfillCheckoutSession, recordPaymentEvent, isUuid };
