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
  razorpayEnabled, createPlanOrder, verifyCheckout, markFailed, PaymentError,
} from '../lib/razorpay.js';

export const billingRouter = Router();

billingRouter.use(requireOrg);

const subView = (s) => (s ? {
  id: s.id, planId: s.plan_id, plan: s.plan_name, cycle: s.cycle, amount: money(s.amount), currency: s.currency,
  status: s.status, startedAt: s.started_at, renewsAt: s.renews_at, requestedAt: s.created_at,
} : null);

billingRouter.get('/', async (req, res, next) => {
  try {
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
    });
  } catch (err) { next(err); }
});

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
    res.json({ ok: true, activated: true, message: `Payment received — ${result.plan} is active.` });
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

