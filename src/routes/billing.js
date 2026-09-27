/**
 * An organisation's own plan, as its people see it.
 *
 * Anyone in the organisation can see what it is on and how much of the plan
 * it uses. Its admin picks a plan: a free one starts straight away, a paid one
 * becomes a request the platform's super admin switches on once paid.
 */

import { Router } from 'express';
import { all, one, run, logActivity } from '../db/index.js';
import { requireOrg } from '../lib/authGuard.js';
import { can } from '../lib/auth.js';
import { publicPlan } from './platform.js';
import {
  currentSubscription, pendingRequest, usageOf, setSubscription, asJson, money,
} from '../lib/plans.js';

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
      limits: sub ? asJson(sub.plan_limits, {}) : null,
      pending: subView(pending),
      usage: await usageOf(req.orgId),
      plans: plans.map(publicPlan),
      canChoose: can(req.user, 'members'),
    });
  } catch (err) { next(err); }
});

/** Pick a plan: a free one is on at once, a paid one waits for the super admin. */
billingRouter.post('/choose', async (req, res, next) => {
  try {
    if (!can(req.user, 'members')) return res.status(403).json({ error: 'Only an admin of your organisation can choose the plan' });
    const plan = await one("SELECT * FROM plans WHERE id = ? AND status = 'active' AND is_public = 1", [Number(req.body.plan_id)]);
    if (!plan) return res.status(400).json({ error: 'That plan is not available' });
    const cycle = req.body.cycle === 'yearly' && Number(plan.price_yearly) > 0 ? 'yearly' : 'monthly';
    const price = Number(cycle === 'yearly' ? plan.price_yearly : plan.price_monthly);

    const current = await currentSubscription(req.orgId);
    if (current && current.plan_id === plan.id && current.cycle === cycle) {
      return res.status(400).json({ error: `You are already on ${plan.name}` });
    }

    if (price === 0) {
      await setSubscription(req.orgId, plan, { cycle, status: 'active' });
      await logActivity('organisation', req.orgId, 'plan_chosen', `${req.user.name} switched "${req.organisation.name}" to the free ${plan.name} plan`);
      return res.json({ ok: true, activated: true, message: `${plan.name} is active — you can start now.` });
    }

    await setSubscription(req.orgId, plan, { cycle, status: 'pending' });
    await logActivity('organisation', req.orgId, 'plan_requested',
      `${req.user.name} asked for ${plan.name} (${cycle}, ${plan.currency} ${price}) for "${req.organisation.name}"`);
    res.json({ ok: true, activated: false, message: `Requested ${plan.name}. It will be switched on as soon as your payment is confirmed.` });
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

