/**
 * An organisation's own plan, as its people see it.
 *
 * Anyone in the organisation can see what it is on and how much of the plan
 * it uses. Its admin picks a plan: a free one starts straight away; a paid one
 * is paid for with Razorpay and starts once the payment is verified — or, on a
 * panel without Razorpay keys, becomes a request the super admin switches on.
 */

import { Router } from 'express';
import { all, one, run, logActivity } from '../db/index.js';
import { requireOrg } from '../lib/authGuard.js';
import { can } from '../lib/auth.js';
import { publicPlan } from './platform.js';
import {
  currentSubscription, pendingRequest, usageOf, setSubscription, asJson, money, trialState, usedFreeTrial, FREE_TRIAL_DAYS,
} from '../lib/plans.js';
import {
  razorpayEnabled, createPlanOrder, verifyCheckout, markFailed, reconcileOrders, PaymentError,
} from '../lib/razorpay.js';

export const billingRouter = Router();

billingRouter.use(requireOrg);

const subView = (s) => (s ? {
  id: s.id, planId: s.plan_id, plan: s.plan_name, cycle: s.cycle, amount: money(s.amount), currency: s.currency,
  status: s.status, startedAt: s.started_at, renewsAt: s.renews_at, requestedAt: s.created_at,
} : null);

billingRouter.get('/', async (req, res, next) => {
  try {
    // A payment that went through but whose confirmation was lost is switched on here.
    const recovered = await reconcileOrders(req.orgId).catch(() => []);
    const sub = await currentSubscription(req.orgId);
    const pending = await pendingRequest(req.orgId);
    const plans = await all("SELECT * FROM plans WHERE status = 'active' AND is_public = 1 ORDER BY sort_order, price_monthly");
    res.json({
      organisation: req.organisation ? { id: req.organisation.id, name: req.organisation.name } : null,
      active: Boolean(sub),
      subscription: subView(sub),
      // A free plan is a trial: which day it is on, how many are left, and whether it has ended.
      trial: trialState(sub),
      trialDays: FREE_TRIAL_DAYS,
      freeTrialUsed: await usedFreeTrial(req.orgId),
      limits: sub ? asJson(sub.plan_limits, {}) : null,
      pending: subView(pending),
      usage: await usageOf(req.orgId),
      plans: plans.map(publicPlan),
      canChoose: can(req.user, 'members'),
      // Paid plans are paid for online when Razorpay is set up; otherwise they are requests.
      payOnline: razorpayEnabled(),
      payments: await paymentHistory(req.orgId),
      recovered,
    });
  } catch (err) { next(err); }
});

/**
 * Everything the organisation has paid — online or recorded by hand — and the
 * online attempts that did not go through, newest first.
 */
async function paymentHistory(orgId) {
  const paid = await all(
    `SELECT p.id, p.amount, p.currency, p.paid_at, p.method, p.reference, pl.name AS plan_name, s.cycle
       FROM payments p
       LEFT JOIN subscriptions s ON s.id = p.subscription_id
       LEFT JOIN plans pl ON pl.id = s.plan_id
      WHERE p.org_id = ? ORDER BY p.paid_at DESC, p.id DESC LIMIT 200`,
    [orgId],
  );
  const unpaid = await all(
    `SELECT o.id, o.amount, o.currency, o.created_at, o.status, o.error, o.provider_order_id, o.cycle, pl.name AS plan_name
       FROM payment_orders o LEFT JOIN plans pl ON pl.id = o.plan_id
      WHERE o.org_id = ? AND o.status <> 'paid' ORDER BY o.id DESC LIMIT 50`,
    [orgId],
  );
  return [
    ...paid.map((p) => ({
      id: `pay-${p.id}`, status: 'paid', at: p.paid_at, amount: money(p.amount), currency: p.currency,
      plan: p.plan_name, cycle: p.cycle, method: p.method, reference: p.reference,
    })),
    ...unpaid.map((o) => ({
      id: `order-${o.id}`, status: o.status === 'failed' ? 'failed' : 'incomplete', at: o.created_at, amount: money(o.amount),
      currency: o.currency, plan: o.plan_name, cycle: o.cycle, method: 'razorpay', reference: o.provider_order_id, error: o.error,
    })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at));
}

/**
 * The plan and cycle asked for, checked the same way whether it is chosen or
 * paid for: { plan, cycle, price, current, currentEnded } or { error }.
 */
async function pickPlan(req) {
  if (!can(req.user, 'members')) return { status: 403, error: 'Only an admin of your organisation can choose the plan' };
  const plan = await one("SELECT * FROM plans WHERE id = ? AND status = 'active' AND is_public = 1", [Number(req.body.plan_id)]);
  if (!plan) return { error: 'That plan is not available' };
  const cycle = req.body.cycle === 'yearly' && Number(plan.price_yearly) > 0 ? 'yearly' : 'monthly';
  const price = Number(cycle === 'yearly' ? plan.price_yearly : plan.price_monthly);

  const current = await currentSubscription(req.orgId);
  // The same plan again is only refused while it is still running — an expired one is being renewed.
  const currentEnded = trialState(current)?.expired;
  if (current && current.plan_id === plan.id && current.cycle === cycle && !currentEnded) {
    return { error: `You are already on ${plan.name}` };
  }
  if (price === 0 && await usedFreeTrial(req.orgId)) {
    return { error: `The ${FREE_TRIAL_DAYS}-day free plan can only be used once. Choose a paid plan to continue.` };
  }
  return { plan, cycle, price, current, currentEnded };
}

/** Pick a plan: a free one is on at once, a paid one waits for the super admin. */
billingRouter.post('/choose', async (req, res, next) => {
  try {
    const picked = await pickPlan(req);
    if (picked.error) return res.status(picked.status || 400).json({ error: picked.error });
    const { plan, cycle, price, current, currentEnded } = picked;

    // With Razorpay on, a paid plan is paid for first; the paid order becomes the request
    // and is accepted automatically (POST /checkout). An unpaid request is not taken.
    if (price > 0 && razorpayEnabled()) {
      return res.status(402).json({ error: `Pay for ${plan.name} to switch to it — the plan starts as soon as the payment is confirmed.`, payFirst: true });
    }

    if (price === 0) {
      await setSubscription(req.orgId, plan, { cycle, status: 'active' });
      await logActivity('organisation', req.orgId, 'plan_chosen', `${req.user.name} switched "${req.organisation.name}" to the free ${plan.name} plan`);
      return res.json({ ok: true, activated: true, message: `${plan.name} is active — you can start now.` });
    }

    await setSubscription(req.orgId, plan, { cycle, status: 'pending' });
    await logActivity('organisation', req.orgId, 'plan_requested',
      `${req.user.name} asked for ${plan.name} (${cycle}, ${plan.currency} ${price}) for "${req.organisation.name}"`);
    res.json({ ok: true, activated: false, message: `${currentEnded && current.plan_id === plan.id ? 'Renewal of' : 'Requested'} ${plan.name} sent. It will be switched on as soon as your payment is confirmed.` });
  } catch (err) { next(err); }
});

/* ------------------------------------------------- paying with Razorpay */

/** Open a Razorpay order for a paid plan; the browser opens Checkout on it. */
billingRouter.post('/checkout', async (req, res, next) => {
  try {
    const picked = await pickPlan(req);
    if (picked.error) return res.status(picked.status || 400).json({ error: picked.error });
    const checkout = await createPlanOrder({ org: req.organisation, user: req.user, plan: picked.plan, cycle: picked.cycle });
    await logActivity('organisation', req.orgId, 'payment_started',
      `${req.user.name} started paying for ${picked.plan.name} (${picked.cycle}) — Razorpay ${checkout.orderId}`);
    res.json({ ok: true, checkout });
  } catch (err) {
    if (err instanceof PaymentError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/** Checkout finished: verify it with Razorpay and switch the plan on. */
billingRouter.post('/checkout/verify', async (req, res, next) => {
  try {
    const result = await verifyCheckout({
      orgId: req.orgId,
      orderId: req.body.razorpay_order_id,
      paymentId: req.body.razorpay_payment_id,
      signature: req.body.razorpay_signature,
    });
    res.json({ ok: true, activated: true, plan: result.plan, message: `Payment received — ${result.plan} is active.` });
  } catch (err) {
    if (err instanceof PaymentError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/**
 * Checkout closed without a confirmed answer: ask Razorpay whether the money
 * went through anyway, and switch the plan on if it did.
 */
billingRouter.post('/checkout/recheck', async (req, res, next) => {
  try {
    const recovered = await reconcileOrders(req.orgId, { force: true });
    res.json({ ok: true, recovered, message: recovered.length ? `Payment received — ${recovered[0]} is active.` : null });
  } catch (err) {
    if (err instanceof PaymentError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/** Checkout reported a failed or abandoned payment: keep the reason on the order. */
billingRouter.post('/checkout/failed', async (req, res, next) => {
  try {
    await markFailed(req.orgId, req.body.razorpay_order_id, req.body.reason);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/** Withdraw a request that has not been switched on yet. */
billingRouter.delete('/request', async (req, res, next) => {
  try {
    if (!can(req.user, 'members')) return res.status(403).json({ error: 'Only an admin of your organisation can change the plan' });
    const pending = await pendingRequest(req.orgId);
    if (!pending) return res.status(400).json({ error: 'There is no request to withdraw' });
    await run("UPDATE subscriptions SET status = 'withdrawn', ended_at = NOW() WHERE id = ?", [pending.id]);
    await logActivity('organisation', req.orgId, 'plan_request_withdrawn', `${req.user.name} withdrew the request for ${pending.plan_name}`);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

