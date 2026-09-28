/**
 * What an organisation's plan lets it do.
 *
 * A client organisation needs a subscription in good standing (active, trial
 * or past due) before anything that belongs to it can be used, and each plan
 * caps how many servers, apps, people, databases and domains it may hold.
 * Super admins run the platform, so none of this applies to them.
 */

import { one, run, scalar } from '../db/index.js';

export const ACCESS_STATUSES = ['active', 'trial', 'past_due'];
export const LIMIT_KEYS = ['servers', 'apps', 'users', 'databases', 'domains'];
export const DB_PROVIDERS = ['mysql', 'postgres', 'mongodb', 'redis'];

const LIMIT_WORDS = {
  servers: 'servers', apps: 'apps', users: 'team members', databases: 'database connections', domains: 'domains',
};

const USAGE_SQL = {
  servers: 'SELECT COUNT(*) FROM servers WHERE org_id = ?',
  apps: 'SELECT COUNT(*) FROM apps WHERE org_id = ?',
  users: 'SELECT COUNT(*) FROM users WHERE org_id = ?',
  databases: `SELECT COUNT(*) FROM credentials WHERE org_id = ? AND provider IN (${DB_PROVIDERS.map((p) => `'${p}'`).join(',')})`,
  domains: 'SELECT COUNT(*) FROM app_domains WHERE org_id = ?',
};

export const asJson = (v, fallback) => {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return fallback; } }
  return v;
};
export const money = (v) => Math.round(Number(v || 0) * 100) / 100;

/** A free plan is a trial: it runs this many days (FREE_TRIAL_DAYS, default 30), then stops. */
export const FREE_TRIAL_DAYS = Math.max(1, Number(process.env.FREE_TRIAL_DAYS || 30));
const DAY_MS = 86400000;
const utcMs = (v) => (v instanceof Date ? v.getTime() : Date.parse(`${String(v).replace(' ', 'T')}${/[zZ]|[+-]\d\d:?\d\d$/.test(String(v)) ? '' : 'Z'}`));

/**
 * When a subscription stops giving access, or null when it never does:
 *  - an end date a super admin set (expires_at) — on any plan, free or paid;
 *  - otherwise, for a free plan, its trial end: renews_at, or for one written
 *    before trials existed, its start plus the trial length;
 *  - a paid plan without an end date runs on (renewals are handled by payments).
 */
export function planEnd(sub) {
  if (!sub) return null;
  if (sub.expires_at) return utcMs(sub.expires_at);
  if (money(sub.amount) > 0) return null;
  const start = utcMs(sub.started_at) || Date.now();
  return sub.renews_at ? utcMs(sub.renews_at) : start + FREE_TRIAL_DAYS * DAY_MS;
}

/**
 * Where a subscription is on its way to its end: day number, days left,
 * whether it has run out. `null` when it has no end. `free` says whether this
 * is the free trial, `set` whether a super admin set the date.
 */
export function trialState(sub) {
  const end = planEnd(sub);
  if (!end) return null;
  const start = utcMs(sub.started_at) || Date.now();
  const total = Math.max(1, Math.round((end - start) / DAY_MS));
  const used = Math.max(0, Math.floor((Date.now() - start) / DAY_MS));
  const left = Math.max(0, Math.ceil((end - Date.now()) / DAY_MS));
  return {
    free: money(sub.amount) === 0,
    set: Boolean(sub.expires_at),
    plan: sub.plan_name || null,
    startedAt: new Date(start).toISOString(),
    endsAt: new Date(end).toISOString(),
    totalDays: total,
    day: Math.min(total, used + 1),
    daysLeft: left,
    expired: Date.now() >= end,
    percent: end > start ? Math.max(0, Math.min(100, Math.round(((Date.now() - start) / (end - start)) * 100))) : 100,
  };
}

/** The refusal an organisation gets once its plan has ended. */
export const endedMessage = (t) => (t.free && !t.set
  ? `Your ${FREE_TRIAL_DAYS}-day free plan has ended. Upgrade to a paid plan to keep adding and changing things.`
  : `Your ${t.plan || ''} plan has expired. Renew or upgrade to keep adding and changing things.`.replace('  ', ' '));

/** Has this organisation already had a free trial? Then it cannot start another. */
export async function usedFreeTrial(orgId) {
  return Boolean(await scalar(
    "SELECT COUNT(*) FROM subscriptions WHERE org_id = ? AND amount = 0 AND status <> 'pending'", [orgId]
  ));
}

/** The subscription that gives an organisation access right now, with its plan. */
export async function currentSubscription(orgId) {
  if (!orgId) return null;
  return one(
    `SELECT s.*, p.name AS plan_name, p.slug AS plan_slug, p.limits AS plan_limits
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.org_id = ? AND s.status IN ('active','trial','past_due')
      ORDER BY s.id DESC LIMIT 1`,
    [orgId]
  );
}

/** A plan the organisation asked for and the super admin has not switched on yet. */
export async function pendingRequest(orgId) {
  if (!orgId) return null;
  return one(
    `SELECT s.*, p.name AS plan_name FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.org_id = ? AND s.status = 'pending' ORDER BY s.id DESC LIMIT 1`,
    [orgId]
  );
}

export async function usageOf(orgId) {
  const out = {};
  for (const k of LIMIT_KEYS) out[k] = Number(await scalar(USAGE_SQL[k], [orgId]));
  return out;
}

/**
 * Put an organisation on a plan: whatever it was on (or had asked for) ends,
 * and a new subscription starts. A free plan never needs renewing.
 */
export async function setSubscription(orgId, plan, { cycle = 'monthly', status = 'active', amount, renewsAt, notes } = {}) {
  const c = cycle === 'yearly' ? 'yearly' : 'monthly';
  const st = ['active', 'trial', 'past_due', 'pending'].includes(status) ? status : 'active';
  const price = amount !== undefined && amount !== '' && amount !== null ? money(amount) : money(c === 'yearly' ? plan.price_yearly : plan.price_monthly);
  if (st === 'pending') {
    // A new request replaces an older one; what is running keeps running.
    await run("UPDATE subscriptions SET status = 'ended', ended_at = NOW() WHERE org_id = ? AND status = 'pending'", [orgId]);
  } else {
    await run("UPDATE subscriptions SET status = 'ended', ended_at = NOW() WHERE org_id = ? AND status IN ('active','trial','past_due','pending')", [orgId]);
  }
  let renews = null;
  if (renewsAt) renews = new Date(renewsAt);
  else if (price > 0 && st !== 'pending') renews = new Date(Date.now() + (c === 'yearly' ? 365 : 30) * 86400000);
  // A free plan is a trial: it ends after FREE_TRIAL_DAYS.
  else if (price === 0 && st !== 'pending') renews = new Date(Date.now() + FREE_TRIAL_DAYS * DAY_MS);
  const { insertId } = await run(
    'INSERT INTO subscriptions (org_id, plan_id, cycle, amount, currency, status, renews_at, notes) VALUES (?,?,?,?,?,?,?,?)',
    [orgId, plan.id, c, price, plan.currency, st, renews && !Number.isNaN(renews.getTime()) ? renews : null, notes || null]
  );
  return insertId;
}

/** Turn a requested plan on: the old subscription ends and the request becomes the live one. */
export async function activateRequest(orgId) {
  const req = await pendingRequest(orgId);
  if (!req) return null;
  await run("UPDATE subscriptions SET status = 'ended', ended_at = NOW() WHERE org_id = ? AND status IN ('active','trial','past_due')", [orgId]);
  const renews = Number(req.amount) > 0
    ? new Date(Date.now() + (req.cycle === 'yearly' ? 365 : 30) * 86400000)
    : new Date(Date.now() + FREE_TRIAL_DAYS * DAY_MS);
  await run("UPDATE subscriptions SET status = 'active', started_at = NOW(), renews_at = ? WHERE id = ?", [renews, req.id]);
  return req;
}

/** Everything organisation-scoped sits behind this: no plan, no access. */
export async function requirePlan(req, res, next) {
  try {
    if (req.user?.role === 'super_admin') return next();
    const sub = await currentSubscription(req.orgId);
    if (!sub) {
      return res.status(402).json({ error: 'Your organisation has no active plan. Activate a plan to continue.', needsPlan: true });
    }
    // A plan that has ended — the free trial or any plan a super admin expired: nothing is shown
    // or changed until it is renewed. Only Plan & billing (not behind this) stays open.
    const trial = trialState(sub);
    if (trial?.expired) {
      return res.status(402).json({
        error: endedMessage(trial),
        needsPlan: true, trialExpired: true,
      });
    }
    req.subscription = sub;
    next();
  } catch (err) { next(err); }
}

/**
 * For routes that sit outside requirePlan (the team, the activity log): a
 * client whose plan has ended sees nothing there either.
 */
export async function blockIfExpired(req, res, next) {
  try {
    if (!req.user || req.user.role === "super_admin" || !req.orgId) return next();
    const t = trialState(await currentSubscription(req.orgId));
    if (t?.expired) return res.status(402).json({ error: endedMessage(t), needsPlan: true, trialExpired: true });
    next();
  } catch (err) { next(err); }
}

/**
 * Creating one more of something counts against the plan. Each rule is
 * [method, path pattern under /api, limit key, optional test on the request].
 */
export const enforceLimits = (rules) => async (req, res, next) => {
  try {
    if (!req.user || req.user.role === 'super_admin' || !req.orgId) return next();
    const path = req.path.replace(/\/+$/, '') || '/';
    const matched = rules.filter(([method, re, , test]) => method === req.method && re.test(path) && (!test || test(req)));
    if (!matched.length) return next();
    const sub = req.subscription || await currentSubscription(req.orgId);
    if (!sub) return res.status(402).json({ error: 'Your organisation has no active plan. Activate a plan to continue.', needsPlan: true });
    const ended = trialState(sub);
    if (ended?.expired) {
      return res.status(402).json({ error: endedMessage(ended), needsPlan: true, trialExpired: true });
    }
    const limits = asJson(sub.plan_limits, {});
    for (const [, , key] of matched) {
      const limit = limits[key];
      if (limit === undefined || limit === null) continue;
      const used = Number(await scalar(USAGE_SQL[key], [req.orgId]));
      if (used >= limit) {
        return res.status(403).json({
          error: `Your ${sub.plan_name} plan allows ${limit} ${LIMIT_WORDS[key]} and you have ${used}. Upgrade your plan to add more.`,
          limitReached: true, limit: key,
        });
      }
    }
    next();
  } catch (err) { next(err); }
};
