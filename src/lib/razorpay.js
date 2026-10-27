/**
 * Paying for a plan with Razorpay.
 *
 *   1. The panel creates a Razorpay order for the plan's price (createPlanOrder)
 *      and remembers it in payment_orders.
 *   2. The browser opens Razorpay Checkout on that order.
 *   3. Checkout hands back order id + payment id + signature; the signature is
 *      an HMAC of the two ids with our key secret, so it cannot be forged, and
 *      the payment is fetched from Razorpay to make sure it was really captured
 *      for the right amount (verifyCheckout).
 *   4. The webhook (payment.captured / order.paid) does the same for anyone who
 *      closed the tab before step 3 came back.
 *
 * Steps 3 and 4 meet in fulfilOrder, which turns the paid order into a plan
 * request and accepts it at once — exactly once, however many times it is called.
 */

import crypto from 'node:crypto';
import { config } from '../config.js';
import { all, one, run, logActivity } from '../db/index.js';
import { setSubscription, pendingRequest, activateRequest, money } from './plans.js';

export class PaymentError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export const razorpayEnabled = () => Boolean(config.razorpay.keyId && config.razorpay.keySecret);

// Razorpay takes amounts in the currency's smallest unit; these have none.
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'PYG', 'UGX', 'XAF', 'XOF']);
export const toMinorUnits = (amount, currency) => Math.round(Number(amount) * (ZERO_DECIMAL.has(currency) ? 1 : 100));

async function razorpay(path, { method = 'GET', body } = {}) {
  const auth = Buffer.from(`${config.razorpay.keyId}:${config.razorpay.keySecret}`).toString('base64');
  let res;
  try {
    res = await fetch(`${config.razorpay.apiBase}${path}`, {
      method,
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new PaymentError(`Razorpay could not be reached: ${err.message}`, 502);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = data?.error?.description || `HTTP ${res.status}`;
    if (res.status === 401) throw new PaymentError('Razorpay refused the API keys — check RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.', 502);
    throw new PaymentError(`Razorpay: ${why}`, 502);
  }
  return data;
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** Checkout's signature: HMAC-SHA256("<order_id>|<payment_id>") with the key secret. */
export const checkoutSignatureOk = (orderId, paymentId, signature) => safeEqual(
  crypto.createHmac('sha256', config.razorpay.keySecret).update(`${orderId}|${paymentId}`).digest('hex'), signature,
);

/** A webhook's X-Razorpay-Signature: HMAC-SHA256 of the raw body with the webhook secret. */
export const webhookSignatureOk = (rawBody, signature) => Boolean(config.razorpay.webhookSecret) && safeEqual(
  crypto.createHmac('sha256', config.razorpay.webhookSecret).update(rawBody).digest('hex'), signature,
);

/** Start paying for a plan: a Razorpay order, and what Checkout needs to open on it. */
export async function createPlanOrder({ org, user, plan, cycle }) {
  if (!razorpayEnabled()) throw new PaymentError('Online payment is not set up on this panel.', 400);
  const amount = money(cycle === 'yearly' ? plan.price_yearly : plan.price_monthly);
  if (!(amount > 0)) throw new PaymentError(`${plan.name} is free — there is nothing to pay.`);
  const currency = String(plan.currency || 'INR').toUpperCase();

  const order = await razorpay('/orders', {
    method: 'POST',
    body: {
      amount: toMinorUnits(amount, currency),
      currency,
      // Shows in the Razorpay dashboard; at most 40 characters.
      receipt: `org${org.id}-plan${plan.id}-${Date.now().toString(36)}`.slice(0, 40),
      notes: { org_id: String(org.id), organisation: org.name.slice(0, 200), plan: plan.name, cycle },
    },
  });

  await run(
    `INSERT INTO payment_orders (org_id, plan_id, user_id, cycle, amount, currency, provider_order_id)
     VALUES (?,?,?,?,?,?,?)`,
    [org.id, plan.id, user?.id || null, cycle, amount, currency, order.id],
  );

  return {
    keyId: config.razorpay.keyId,
    orderId: order.id,
    amount: order.amount,
    currency: order.currency,
    name: 'AJ Pilot',
    description: `${plan.name} — ${cycle === 'yearly' ? 'yearly' : 'monthly'} plan for ${org.name}`.slice(0, 255),
    prefill: { name: user?.name || '', email: user?.email || '', contact: String(user?.phone || '').replace(/[^\d+]/g, '') },
    notes: { org_id: String(org.id) },
  };
}

/** Checkout came back: check the signature and the payment itself, then switch the plan on. */
export async function verifyCheckout({ orgId, orderId, paymentId, signature }) {
  if (!razorpayEnabled()) throw new PaymentError('Online payment is not set up on this panel.');
  if (!/^order_\w+$/.test(String(orderId || '')) || !/^pay_\w+$/.test(String(paymentId || ''))) {
    throw new PaymentError('That payment response is incomplete.');
  }
  const order = await one('SELECT * FROM payment_orders WHERE provider_order_id = ? AND org_id = ?', [orderId, orgId]);
  if (!order) throw new PaymentError('That payment does not belong to this organisation.', 404);
  if (!checkoutSignatureOk(orderId, paymentId, signature)) {
    await run("UPDATE payment_orders SET status = IF(status = 'paid', status, 'failed'), error = ? WHERE id = ?", ['Signature did not match', order.id]);
    throw new PaymentError('The payment could not be verified. If money was taken, it will be refunded by Razorpay or switched on once confirmed.');
  }
  return fulfilOrder(order, await confirmedPayment(order, paymentId));
}

/** The payment as Razorpay has it — it must belong to this order, be captured, and be for the full amount. */
async function confirmedPayment(order, paymentId) {
  let payment = await razorpay(`/payments/${encodeURIComponent(paymentId)}`);
  if (payment.order_id !== order.provider_order_id) throw new PaymentError('That payment is for a different order.');
  // Authorized but not yet captured (manual capture is on in the dashboard): capture it now.
  if (payment.status === 'authorized') {
    payment = await razorpay(`/payments/${encodeURIComponent(paymentId)}/capture`, {
      method: 'POST', body: { amount: payment.amount, currency: payment.currency },
    });
  }
  if (payment.status !== 'captured') throw new PaymentError(`The payment is ${payment.status}, not complete.`);
  if (Number(payment.amount) !== toMinorUnits(order.amount, order.currency) || payment.currency !== order.currency) {
    throw new PaymentError('The amount paid does not match the plan price.');
  }
  return payment;
}

/**
 * Switch the plan on and record the payment — once. A second call for the same
 * order (Checkout and the webhook both arriving) finds it already paid and stops.
 */
export async function fulfilOrder(order, payment) {
  const claimed = await run(
    "UPDATE payment_orders SET status = 'paid', provider_payment_id = ?, paid_at = NOW(), error = NULL WHERE id = ? AND status <> 'paid'",
    [payment.id, order.id],
  );
  const plan = await one('SELECT * FROM plans WHERE id = ?', [order.plan_id]);
  if (!claimed.affectedRows) return { alreadyDone: true, plan: plan?.name };

  // Paid first, then requested, then accepted — the same request a super admin would switch
  // on by hand, accepted automatically because the money is already in. A request already
  // waiting for this plan (chosen at sign-up, say) is the one accepted; any other is replaced.
  const note = `Paid online — Razorpay ${payment.id}; accepted automatically`;
  const waiting = await pendingRequest(order.org_id);
  if (waiting && waiting.plan_id === order.plan_id && waiting.cycle === order.cycle) {
    await run('UPDATE subscriptions SET amount = ?, currency = ?, notes = ? WHERE id = ?', [order.amount, order.currency, note, waiting.id]);
  } else {
    await setSubscription(order.org_id, plan, { cycle: order.cycle, status: 'pending', amount: order.amount, notes: note });
  }
  const accepted = await activateRequest(order.org_id);
  const subId = accepted.id;
  const method = ['card', 'upi', 'netbanking', 'wallet', 'emi'].includes(payment.method) ? `razorpay/${payment.method}` : 'razorpay';
  const { insertId } = await run(
    'INSERT INTO payments (org_id, subscription_id, amount, currency, paid_at, method, reference, notes, created_by) VALUES (?,?,?,?,NOW(),?,?,?,?)',
    [order.org_id, subId, order.amount, order.currency, method, payment.id, `Order ${order.provider_order_id}`, order.user_id],
  );
  await run('UPDATE payment_orders SET payment_id = ? WHERE id = ?', [insertId, order.id]);

  const org = await one('SELECT name FROM organisations WHERE id = ?', [order.org_id]);
  await logActivity('organisation', order.org_id, 'payment_online',
    `"${org?.name}" paid ${order.currency} ${money(order.amount)} with Razorpay for ${plan.name} (${order.cycle})`);
  await logActivity('organisation', order.org_id, 'subscription_activated',
    `Accepted the ${plan.name} (${order.cycle}) request of "${org?.name}" automatically — payment ${payment.id} verified`);
  return { alreadyDone: false, plan: plan.name };
}

/** Razorpay calls this; the raw body's signature is the only proof it is them. */
export async function handleWebhook(rawBody, signature) {
  if (!webhookSignatureOk(rawBody, signature)) throw new PaymentError('Bad signature', 401);
  const event = JSON.parse(rawBody.toString('utf8'));
  const payment = event?.payload?.payment?.entity;
  const orderId = payment?.order_id || event?.payload?.order?.entity?.id;
  if (!['payment.captured', 'order.paid', 'payment.failed'].includes(event?.event) || !orderId) return { ignored: true };

  const order = await one('SELECT * FROM payment_orders WHERE provider_order_id = ?', [orderId]);
  if (!order) return { ignored: true };

  if (event.event === 'payment.failed') {
    const why = String(payment?.error_description || 'Payment failed').slice(0, 500);
    await run("UPDATE payment_orders SET status = IF(status = 'paid', status, 'failed'), error = ? WHERE id = ?", [why, order.id]);
    return { failed: true };
  }
  if (!payment || payment.status !== 'captured') return { ignored: true };
  if (Number(payment.amount) !== toMinorUnits(order.amount, order.currency) || payment.currency !== order.currency) {
    await run('UPDATE payment_orders SET error = ? WHERE id = ?', ['Webhook amount did not match the plan price', order.id]);
    return { mismatch: true };
  }
  return fulfilOrder(order, payment);
}

/**
 * Payments Razorpay took that never reached the panel — Checkout's answer was
 * lost (tab closed, popup cut off) and the webhook cannot reach a panel on a
 * private network. Razorpay is asked about the organisation's recent unpaid
 * orders and any that were paid are switched on, through the same checks.
 * At most once a minute per organisation.
 */
const lastReconcile = new Map();

export async function reconcileOrders(orgId, { force = false } = {}) {
  if (!razorpayEnabled() || !orgId) return [];
  if (!force && Date.now() - (lastReconcile.get(orgId) || 0) < 60_000) return [];
  lastReconcile.set(orgId, Date.now());

  const open = await all(
    `SELECT * FROM payment_orders WHERE org_id = ? AND status <> 'paid'
       AND created_at > DATE_SUB(NOW(), INTERVAL 7 DAY) ORDER BY id DESC LIMIT 5`,
    [orgId],
  );
  const recovered = [];
  for (const order of open) {
    try {
      const { items = [] } = await razorpay(`/orders/${encodeURIComponent(order.provider_order_id)}/payments`);
      const paid = items.find((p) => p.status === 'captured') || items.find((p) => p.status === 'authorized');
      if (!paid) continue;
      const r = await fulfilOrder(order, await confirmedPayment(order, paid.id));
      if (!r.alreadyDone) recovered.push(r.plan);
    } catch (err) {
      console.error(`[razorpay] could not check order ${order.provider_order_id}:`, err.message);
    }
  }
  return recovered;
}

/** The browser reports Checkout's own failure, so the order says why. */
export async function markFailed(orgId, orderId, reason) {
  await run(
    "UPDATE payment_orders SET status = IF(status = 'paid', status, 'failed'), error = ? WHERE provider_order_id = ? AND org_id = ?",
    [String(reason || 'Payment failed').slice(0, 500), String(orderId || ''), orgId],
  );
}
