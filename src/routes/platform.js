/**
 * The platform, as the super admin sees it: every organisation and every
 * person, the plans on sale, who is on which, what has been paid, and the
 * numbers that come out of all that.
 *
 * Everything here is super-admin only. Payments are recorded by hand — the
 * panel keeps the books, it does not take the money.
 */

import { Router } from 'express';
import { all, one, run, scalar, logActivity } from '../db/index.js';
import { hashPassword, checkPassword, checkEmail, checkPhone, phoneRequired, ROLES } from '../lib/auth.js';
import { endAllSessions } from '../lib/authGuard.js';
import { config } from '../config.js';
import { setSubscription, activateRequest, usageOf, LIMIT_KEYS, trialState } from '../lib/plans.js';
import { createOrganisation, OrgError, slugify } from '../lib/organisations.js';
import { leadsRouter, leadSummary } from './leads.js';
import { docsFor } from '../lib/docs.js';

/** The roles a person in a client organisation can have. */
const CLIENT_ROLES = ['admin', 'editor', 'viewer'];

export const platformRouter = Router();

platformRouter.use((req, res, next) => {
  if (req.user?.role !== 'super_admin') return res.status(403).json({ error: 'Only a super admin can manage the platform', forbidden: true });
  next();
});

platformRouter.use('/leads', leadsRouter);

/** Every guide, including the ones only super admins see. */
platformRouter.get('/docs', (req, res) => res.json({ docs: docsFor({ admin: true }) }));

const asJson = (v, fallback) => {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return fallback; } }
  return v;
};
const money = (v) => Math.round(Number(v || 0) * 100) / 100;
/** A DATETIME as the database hands it over ("2026-09-27 04:05:42", UTC) → milliseconds. */
const utcMs = (v) => (v ? Date.parse(`${String(v).replace(' ', 'T')}Z`) : NaN);

/** What a subscription is worth per month: a yearly one counts a twelfth. */
const monthlyValue = (s) => (s.status === 'active' ? money(s.cycle === 'yearly' ? Number(s.amount) / 12 : s.amount) : 0);

/* ---------------------------------------------------------------- plans */

export function publicPlan(p) {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    tagline: p.tagline,
    priceMonthly: money(p.price_monthly),
    priceYearly: money(p.price_yearly),
    currency: p.currency,
    limits: asJson(p.limits, {}),
    features: asJson(p.features, []),
    highlighted: Boolean(p.highlighted),
    isPublic: Boolean(p.is_public),
    sortOrder: p.sort_order,
    status: p.status,
  };
}

/** The plan form, checked. Limits left empty mean unlimited. */
function planFrom(body) {
  const name = String(body.name || '').trim();
  if (!name || name.length > 120) return { error: 'A plan needs a name (up to 120 characters)' };
  const monthly = Number(body.price_monthly);
  const yearly = Number(body.price_yearly);
  if (!Number.isFinite(monthly) || monthly < 0) return { error: 'The monthly price must be 0 or more' };
  if (!Number.isFinite(yearly) || yearly < 0) return { error: 'The yearly price must be 0 or more' };
  const currency = String(body.currency || 'INR').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return { error: 'The currency is a three-letter code, like INR or USD' };

  const limits = {};
  for (const k of LIMIT_KEYS) {
    const raw = body.limits?.[k] ?? body[`limit_${k}`];
    if (raw === '' || raw === null || raw === undefined) continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) return { error: `The ${k} limit must be a whole number, or empty for unlimited` };
    limits[k] = n;
  }
  const features = (Array.isArray(body.features) ? body.features : String(body.features || '').split('\n'))
    .map((f) => String(f).trim()).filter(Boolean).slice(0, 30);

  return {
    value: {
      name,
      slug: slugify(body.slug || name),
      tagline: String(body.tagline || '').trim().slice(0, 255) || null,
      price_monthly: money(monthly),
      price_yearly: money(yearly),
      currency,
      limits: JSON.stringify(limits),
      features: JSON.stringify(features),
      highlighted: body.highlighted === true || body.highlighted === 'on' ? 1 : 0,
      is_public: body.is_public === false || body.is_public === 'off' ? 0 : 1,
      sort_order: Number.isInteger(Number(body.sort_order)) ? Number(body.sort_order) : 0,
    },
  };
}

platformRouter.get('/plans', async (req, res, next) => {
  try {
    const plans = await all('SELECT * FROM plans ORDER BY status = "archived", sort_order, price_monthly');
    const counts = await all("SELECT plan_id, COUNT(*) AS n FROM subscriptions WHERE status IN ('active','trial','past_due') GROUP BY plan_id");
    const byPlan = Object.fromEntries(counts.map((c) => [c.plan_id, Number(c.n)]));
    res.json({ plans: plans.map((p) => ({ ...publicPlan(p), subscribers: byPlan[p.id] || 0 })), limitKeys: LIMIT_KEYS });
  } catch (err) { next(err); }
});

platformRouter.post('/plans', async (req, res, next) => {
  try {
    const { value, error } = planFrom(req.body || {});
    if (error) return res.status(400).json({ error });
    if (await one('SELECT id FROM plans WHERE slug = ?', [value.slug])) return res.status(409).json({ error: `A plan called "${value.name}" already exists` });
    const { insertId } = await run(
      `INSERT INTO plans (name, slug, tagline, price_monthly, price_yearly, currency, limits, features, highlighted, is_public, sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [value.name, value.slug, value.tagline, value.price_monthly, value.price_yearly, value.currency, value.limits, value.features, value.highlighted, value.is_public, value.sort_order]
    );
    await logActivity('plan', insertId, 'plan_created', `Created the plan "${value.name}" (${value.currency} ${value.price_monthly}/month)`);
    res.status(201).json(publicPlan(await one('SELECT * FROM plans WHERE id = ?', [insertId])));
  } catch (err) { next(err); }
});

platformRouter.put('/plans/:id', async (req, res, next) => {
  try {
    const plan = await one('SELECT * FROM plans WHERE id = ?', [req.params.id]);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    const { value, error } = planFrom({ ...req.body, slug: req.body.slug || plan.slug });
    if (error) return res.status(400).json({ error });
    if (await one('SELECT id FROM plans WHERE slug = ? AND id <> ?', [value.slug, plan.id])) return res.status(409).json({ error: 'Another plan already uses that name' });
    const status = ['active', 'archived'].includes(req.body.status) ? req.body.status : plan.status;
    await run(
      `UPDATE plans SET name=?, slug=?, tagline=?, price_monthly=?, price_yearly=?, currency=?, limits=?, features=?, highlighted=?, is_public=?, sort_order=?, status=? WHERE id=?`,
      [value.name, value.slug, value.tagline, value.price_monthly, value.price_yearly, value.currency, value.limits, value.features, value.highlighted, value.is_public, value.sort_order, status, plan.id]
    );
    await logActivity('plan', plan.id, 'plan_updated', `Updated the plan "${value.name}"`);
    res.json(publicPlan(await one('SELECT * FROM plans WHERE id = ?', [plan.id])));
  } catch (err) { next(err); }
});

/** A plan someone is on is archived (hidden, kept); one nobody ever used is deleted. */
platformRouter.delete('/plans/:id', async (req, res, next) => {
  try {
    const plan = await one('SELECT * FROM plans WHERE id = ?', [req.params.id]);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    const used = Number(await scalar('SELECT COUNT(*) FROM subscriptions WHERE plan_id = ?', [plan.id]));
    if (used) {
      await run("UPDATE plans SET status = 'archived', is_public = 0 WHERE id = ?", [plan.id]);
      await logActivity('plan', plan.id, 'plan_archived', `Archived the plan "${plan.name}" (it has ${used} subscription(s))`);
      return res.json({ ok: true, archived: true });
    }
    await run('DELETE FROM plans WHERE id = ?', [plan.id]);
    await logActivity('plan', null, 'plan_deleted', `Deleted the plan "${plan.name}"`, 'warn');
    res.json({ ok: true, deleted: true });
  } catch (err) { next(err); }
});

/* -------------------------------------------------------- organisations */

async function organisationRows() {
  const rows = await all(`
    SELECT o.*,
      (SELECT COUNT(*) FROM users u WHERE u.org_id = o.id) AS users,
      (SELECT COUNT(*) FROM users u WHERE u.org_id = o.id AND u.status = 'active') AS active_users,
      (SELECT COUNT(*) FROM servers s WHERE s.org_id = o.id) AS servers,
      (SELECT COUNT(*) FROM apps a WHERE a.org_id = o.id) AS apps,
      (SELECT COUNT(*) FROM app_domains d WHERE d.org_id = o.id) AS domains,
      (SELECT COUNT(*) FROM credentials c WHERE c.org_id = o.id AND c.provider IN ('mysql','postgres','mongodb','redis')) AS databases_,
      (SELECT COALESCE(SUM(p.amount), 0) FROM payments p WHERE p.org_id = o.id) AS paid,
      (SELECT MAX(u.last_login_at) FROM users u WHERE u.org_id = o.id) AS last_active
    FROM organisations o ORDER BY o.created_at DESC`);
  const subs = await all(`SELECT s.*, p.name AS plan_name FROM subscriptions s JOIN plans p ON p.id = s.plan_id
    WHERE s.status IN ('active','trial','past_due') ORDER BY s.id DESC`);
  const subByOrg = new Map();
  for (const s of subs) if (!subByOrg.has(s.org_id)) subByOrg.set(s.org_id, s);
  const requests = await all(`SELECT s.*, p.name AS plan_name FROM subscriptions s JOIN plans p ON p.id = s.plan_id
    WHERE s.status = 'pending' ORDER BY s.id DESC`);
  const reqByOrg = new Map();
  for (const r of requests) if (!reqByOrg.has(r.org_id)) reqByOrg.set(r.org_id, r);

  return rows.map((o) => {
    const s = subByOrg.get(o.id);
    const r = reqByOrg.get(o.id);
    return {
      id: o.id,
      name: o.name,
      slug: o.slug,
      notes: o.notes,
      status: o.status || 'active',
      createdAt: o.created_at,
      lastActive: o.last_active,
      counts: {
        users: Number(o.users), activeUsers: Number(o.active_users), servers: Number(o.servers),
        apps: Number(o.apps), domains: Number(o.domains), databases: Number(o.databases_),
      },
      paid: money(o.paid),
      request: r ? {
        id: r.id, planId: r.plan_id, plan: r.plan_name, cycle: r.cycle, amount: money(r.amount), currency: r.currency, requestedAt: r.created_at,
      } : null,
      subscription: s ? {
        id: s.id, planId: s.plan_id, plan: s.plan_name, cycle: s.cycle, amount: money(s.amount), currency: s.currency,
        status: s.status, startedAt: s.started_at, renewsAt: s.renews_at, mrr: monthlyValue(s),
        expiresAt: s.expires_at || null,
        // When it stops giving access (a set end date, or the free trial's end) and whether it has.
        end: trialState(s),
      } : null,
    };
  });
}

platformRouter.get('/organisations', async (req, res, next) => {
  try {
    res.json({ organisations: await organisationRows(), plans: (await all("SELECT * FROM plans WHERE status = 'active' ORDER BY sort_order")).map(publicPlan) });
  } catch (err) { next(err); }
});

/** A new organisation, optionally with its first admin and a plan. */
platformRouter.post('/organisations', async (req, res, next) => {
  try {
    const id = await createOrganisation(req.body || {}, req.user.id);
    res.status(201).json({ ok: true, id });
  } catch (err) {
    if (err instanceof OrgError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

platformRouter.put('/organisations/:id', async (req, res, next) => {
  try {
    const org = await one('SELECT * FROM organisations WHERE id = ?', [req.params.id]);
    if (!org) return res.status(404).json({ error: 'Organisation not found' });
    const name = String(req.body.name ?? org.name).trim();
    if (!name) return res.status(400).json({ error: 'An organisation needs a name' });
    if (name !== org.name && await one('SELECT id FROM organisations WHERE name = ? AND id <> ?', [name, org.id])) {
      return res.status(409).json({ error: `An organisation called "${name}" already exists` });
    }
    const status = ['active', 'suspended'].includes(req.body.status) ? req.body.status : org.status;
    if (status === 'suspended' && org.id === req.orgId) return res.status(400).json({ error: 'Leave this organisation before suspending it' });
    await run('UPDATE organisations SET name = ?, slug = ?, notes = ?, status = ? WHERE id = ?',
      [name, slugify(name), String(req.body.notes ?? org.notes ?? '').trim() || null, status, org.id]);
    await logActivity('organisation', org.id, status !== org.status ? `org_${status}` : 'updated',
      `${status !== org.status ? `${status === 'suspended' ? 'Suspended' : 'Reactivated'} ` : 'Updated '}the organisation "${name}"`, status === 'suspended' ? 'warn' : 'info');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

platformRouter.put('/organisations/:id/subscription', async (req, res, next) => {
  try {
    const org = await one('SELECT * FROM organisations WHERE id = ?', [req.params.id]);
    if (!org) return res.status(404).json({ error: 'Organisation not found' });
    const b = req.body || {};
    if (b.cancel) {
      await run("UPDATE subscriptions SET status = 'cancelled', ended_at = NOW() WHERE org_id = ? AND status IN ('active','trial','past_due')", [org.id]);
      await logActivity('organisation', org.id, 'subscription_cancelled', `Cancelled the subscription of "${org.name}"`, 'warn');
      return res.json({ ok: true });
    }
    const plan = await one('SELECT * FROM plans WHERE id = ?', [Number(b.plan_id)]);
    if (!plan) return res.status(400).json({ error: 'Pick a plan' });
    if (b.amount !== undefined && b.amount !== '' && (!Number.isFinite(Number(b.amount)) || Number(b.amount) < 0)) return res.status(400).json({ error: 'The amount must be 0 or more' });
    await setSubscription(org.id, plan, { cycle: b.cycle, status: b.status, amount: b.amount, renewsAt: b.renews_at, notes: b.notes });
    await logActivity('organisation', org.id, 'subscription_set', `Put "${org.name}" on ${plan.name} (${b.cycle === 'yearly' ? 'yearly' : 'monthly'}, ${b.status || 'active'})`);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/**
 * End any plan — free or paid — on a date, or now: after it the organisation
 * sees only the renew page until the plan is renewed; nothing is deleted.
 *   { action: 'now' }                      expires straight away
 *   { action: 'date', date: '2026-10-31' } ends at the end of that day
 *   { action: 'extend', days: 15 }         moves the end (or today) on by that many days
 *   { action: 'clear' }                    no end date: a paid plan runs on, a free plan
 *                                          falls back to its trial end
 */
platformRouter.put('/organisations/:id/subscription/expiry', async (req, res, next) => {
  try {
    const org = await one('SELECT * FROM organisations WHERE id = ?', [req.params.id]);
    if (!org) return res.status(404).json({ error: 'Organisation not found' });
    const sub = await one(`SELECT s.*, p.name AS plan_name FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.org_id = ? AND s.status IN ('active','trial','past_due') ORDER BY s.id DESC LIMIT 1`, [org.id]);
    if (!sub) return res.status(400).json({ error: `"${org.name}" has no plan to expire` });

    const b = req.body || {};
    let expires = null;
    let words;
    if (b.action === 'now') {
      expires = new Date();
      words = 'now';
    } else if (b.action === 'date') {
      const d = new Date(`${String(b.date || '').slice(0, 10)}T23:59:59Z`);
      if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'Pick the date the plan ends' });
      expires = d;
      words = `on ${d.toISOString().slice(0, 10)}`;
    } else if (b.action === 'extend') {
      const days = Math.round(Number(b.days));
      if (!Number.isFinite(days) || days < 1 || days > 3650) return res.status(400).json({ error: 'Extend by 1 to 3650 days' });
      const current = trialState(sub);
      const from = current && !current.expired ? Date.parse(current.endsAt) : Date.now();
      expires = new Date(from + days * 86400000);
      words = `on ${expires.toISOString().slice(0, 10)} (extended by ${days} day${days === 1 ? '' : 's'})`;
    } else if (b.action === 'clear') {
      words = 'with no end date';
    } else {
      return res.status(400).json({ error: 'Choose what to do: now, date, extend or clear' });
    }

    await run('UPDATE subscriptions SET expires_at = ? WHERE id = ?', [expires, sub.id]);
    const state = trialState({ ...sub, expires_at: expires });
    await logActivity('organisation', org.id, 'subscription_expiry',
      `${b.action === 'now' ? 'Expired' : 'Set'} the ${sub.plan_name} plan of "${org.name}" ${b.action === 'now' ? 'now' : `to end ${words}`}`,
      b.action === 'now' ? 'warn' : 'info');
    res.json({ ok: true, end: state });
  } catch (err) { next(err); }
});

/** Switch on the plan an organisation asked for. */
platformRouter.post('/organisations/:id/subscription/activate', async (req, res, next) => {
  try {
    const org = await one('SELECT * FROM organisations WHERE id = ?', [req.params.id]);
    if (!org) return res.status(404).json({ error: 'Organisation not found' });
    const done = await activateRequest(org.id);
    if (!done) return res.status(400).json({ error: `"${org.name}" has not asked for a plan` });
    await logActivity('organisation', org.id, 'subscription_activated', `Activated ${done.plan_name} for "${org.name}" (${done.cycle})`);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/** Turn down a plan request; whatever the organisation is on stays as it is. */
platformRouter.delete('/organisations/:id/subscription/request', async (req, res, next) => {
  try {
    const org = await one('SELECT * FROM organisations WHERE id = ?', [req.params.id]);
    if (!org) return res.status(404).json({ error: 'Organisation not found' });
    const r = await run("UPDATE subscriptions SET status = 'declined', ended_at = NOW() WHERE org_id = ? AND status = 'pending'", [org.id]);
    if (!r.affectedRows) return res.status(400).json({ error: 'There is no request to decline' });
    await logActivity('organisation', org.id, 'subscription_declined', `Declined the plan request of "${org.name}"`, 'warn');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/** One organisation in full: its people, its plan history, its payments and what it uses. */
platformRouter.get('/organisations/:id', async (req, res, next) => {
  try {
    const row = (await organisationRows()).find((o) => o.id === Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Organisation not found' });
    const users = await all(`SELECT u.id, u.name, u.email, u.phone, u.role, u.status, u.last_login_at, u.created_at,
      (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > NOW()) AS sessions
      FROM users u WHERE u.org_id = ? ORDER BY FIELD(u.role,'admin','editor','viewer'), u.name`, [row.id]);
    const history = await all(`SELECT s.*, p.name AS plan_name FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.org_id = ? ORDER BY s.id DESC LIMIT 50`, [row.id]);
    const payments = await all(`SELECT p.*, u.name AS by_name FROM payments p LEFT JOIN users u ON u.id = p.created_by
      WHERE p.org_id = ? ORDER BY p.paid_at DESC, p.id DESC LIMIT 100`, [row.id]);
    const plan = row.subscription ? await one('SELECT limits FROM plans WHERE id = ?', [row.subscription.planId]) : null;
    res.json({
      organisation: row,
      limits: plan ? asJson(plan.limits, {}) : null,
      usage: await usageOf(row.id),
      users: users.map((u) => ({
        id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, roleLabel: ROLES[u.role]?.label || u.role, status: u.status,
        lastLoginAt: u.last_login_at, createdAt: u.created_at, sessions: Number(u.sessions),
      })),
      history: history.map((h) => ({
        id: h.id, plan: h.plan_name, cycle: h.cycle, amount: money(h.amount), currency: h.currency, status: h.status,
        startedAt: h.started_at, renewsAt: h.renews_at, endedAt: h.ended_at, createdAt: h.created_at, notes: h.notes,
      })),
      payments: payments.map((p) => ({
        id: p.id, amount: money(p.amount), currency: p.currency, paidAt: p.paid_at, method: p.method, reference: p.reference, notes: p.notes, by: p.by_name,
      })),
      roles: CLIENT_ROLES.map((key) => ({ key, label: ROLES[key].label })),
    });
  } catch (err) { next(err); }
});

/** A new person in a client organisation. */
platformRouter.post('/organisations/:id/users', async (req, res, next) => {
  try {
    const org = await one('SELECT * FROM organisations WHERE id = ?', [req.params.id]);
    if (!org) return res.status(404).json({ error: 'Organisation not found' });
    const email = checkEmail(req.body.email);
    if (email.error) return res.status(400).json({ error: email.error });
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'A name is required' });
    const role = String(req.body.role || 'viewer');
    if (!CLIENT_ROLES.includes(role)) return res.status(400).json({ error: 'Pick admin, editor or viewer' });
    const pwError = checkPassword(req.body.password);
    if (pwError) return res.status(400).json({ error: pwError });
    const phone = checkPhone(req.body.phone, { required: phoneRequired(role) });
    if (phone.error) return res.status(400).json({ error: phone.error });
    if (await one('SELECT id FROM users WHERE email = ?', [email.value])) return res.status(409).json({ error: `${email.value} already has an account` });
    const { insertId } = await run(
      `INSERT INTO users (org_id, active_org_id, email, name, phone, password_hash, role, status, created_by) VALUES (?,?,?,?,?,?,?, 'active', ?)`,
      [org.id, org.id, email.value, name, phone.value, hashPassword(req.body.password), role, req.user.id]
    );
    await logActivity('user', insertId, 'member_added', `Added ${name} (${ROLES[role].label}) to "${org.name}"`);
    res.status(201).json({ ok: true, id: insertId });
  } catch (err) { next(err); }
});

/* --------------------------------------------------------- super admins */

/**
 * Super admins run the platform and belong to no organisation. Any super
 * admin can add, change or remove another; there is always at least one
 * active, and nobody can lock themselves out.
 */
async function otherActiveSuperAdmins(id) {
  return Number(await scalar("SELECT COUNT(*) FROM users WHERE role = 'super_admin' AND status = 'active' AND id <> ?", [id]));
}

platformRouter.get('/admins', async (req, res, next) => {
  try {
    const rows = await all(`SELECT u.id, u.name, u.email, u.phone, u.status, u.last_login_at, u.created_at, c.name AS created_by_name,
      (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > NOW()) AS sessions
      FROM users u LEFT JOIN users c ON c.id = u.created_by WHERE u.role = 'super_admin' ORDER BY u.created_at`);
    const env = config.superAdmin.email && config.superAdmin.password ? config.superAdmin.email : null;
    res.json({ admins: rows.map((u) => ({
      id: u.id, name: u.name, email: u.email, phone: u.phone, status: u.status, lastLoginAt: u.last_login_at, createdAt: u.created_at,
      createdBy: u.created_by_name, sessions: Number(u.sessions), you: u.id === req.user.id, fromEnv: u.email === env,
    })) });
  } catch (err) { next(err); }
});

platformRouter.post('/admins', async (req, res, next) => {
  try {
    const email = checkEmail(req.body.email);
    if (email.error) return res.status(400).json({ error: email.error });
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'A name is required' });
    const pwError = checkPassword(req.body.password);
    if (pwError) return res.status(400).json({ error: pwError });
    const phone = checkPhone(req.body.phone, { required: true });
    if (phone.error) return res.status(400).json({ error: phone.error });
    if (await one('SELECT id FROM users WHERE email = ?', [email.value])) return res.status(409).json({ error: `${email.value} already has an account` });
    const { insertId } = await run(
      `INSERT INTO users (org_id, active_org_id, email, name, phone, password_hash, role, status, created_by) VALUES (NULL, NULL, ?,?,?,?, 'super_admin', 'active', ?)`,
      [email.value, name, phone.value, hashPassword(req.body.password), req.user.id]
    );
    await logActivity('user', insertId, 'super_admin_created', `Created the super admin ${name} (${email.value})`, 'warn');
    res.status(201).json({ ok: true, id: insertId });
  } catch (err) { next(err); }
});

platformRouter.put('/admins/:id', async (req, res, next) => {
  try {
    const u = await one("SELECT * FROM users WHERE id = ? AND role = 'super_admin'", [req.params.id]);
    if (!u) return res.status(404).json({ error: 'Super admin not found' });
    const name = String(req.body.name ?? u.name).trim();
    if (!name) return res.status(400).json({ error: 'A name is required' });
    const email = checkEmail(req.body.email ?? u.email);
    if (email.error) return res.status(400).json({ error: email.error });
    if (email.value !== u.email && await one('SELECT id FROM users WHERE email = ? AND id <> ?', [email.value, u.id])) {
      return res.status(409).json({ error: `${email.value} already has an account` });
    }
    const phone = checkPhone(req.body.phone !== undefined ? req.body.phone : u.phone, { required: true });
    if (phone.error) return res.status(400).json({ error: phone.error });
    const status = ['active', 'disabled'].includes(req.body.status) ? req.body.status : u.status;
    if (status === 'disabled' && u.id === req.user.id) return res.status(400).json({ error: 'You cannot disable your own account' });
    if (status === 'disabled' && u.status !== 'disabled' && !(await otherActiveSuperAdmins(u.id))) {
      return res.status(400).json({ error: 'This is the only active super admin' });
    }
    let hash = u.password_hash;
    if (req.body.password) {
      const pwError = checkPassword(req.body.password);
      if (pwError) return res.status(400).json({ error: pwError });
      hash = hashPassword(req.body.password);
    }
    await run('UPDATE users SET name = ?, email = ?, phone = ?, status = ?, password_hash = ? WHERE id = ?', [name, email.value, phone.value, status, hash, u.id]);
    // A disabled account or a new password signs that person out — never the one making the change.
    if ((status !== u.status || req.body.password) && u.id !== req.user.id) await endAllSessions(u.id);
    await logActivity('user', u.id, 'super_admin_updated',
      `Updated the super admin ${name}${status !== u.status ? ` (${status})` : ''}${req.body.password ? ' with a new password' : ''}`, 'warn');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

platformRouter.delete('/admins/:id', async (req, res, next) => {
  try {
    const u = await one("SELECT * FROM users WHERE id = ? AND role = 'super_admin'", [req.params.id]);
    if (!u) return res.status(404).json({ error: 'Super admin not found' });
    if (u.id === req.user.id) return res.status(400).json({ error: 'You cannot remove your own account' });
    if (u.status === 'active' && !(await otherActiveSuperAdmins(u.id))) return res.status(400).json({ error: 'This is the only active super admin' });
    await run('DELETE FROM users WHERE id = ?', [u.id]);
    await logActivity('user', null, 'super_admin_removed', `Removed the super admin ${u.name} (${u.email})`, 'warn');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------- payments */

platformRouter.get('/payments', async (req, res, next) => {
  try {
    const rows = await all(`SELECT p.*, o.name AS org_name, pl.name AS plan_name, u.name AS by_name FROM payments p
      JOIN organisations o ON o.id = p.org_id
      LEFT JOIN subscriptions s ON s.id = p.subscription_id LEFT JOIN plans pl ON pl.id = s.plan_id
      LEFT JOIN users u ON u.id = p.created_by
      ORDER BY p.paid_at DESC, p.id DESC LIMIT 500`);
    res.json({ payments: rows.map((p) => ({
      id: p.id, orgId: p.org_id, organisation: p.org_name, plan: p.plan_name, amount: money(p.amount), currency: p.currency,
      paidAt: p.paid_at, method: p.method, reference: p.reference, notes: p.notes, by: p.by_name,
    })) });
  } catch (err) { next(err); }
});

platformRouter.post('/organisations/:id/payments', async (req, res, next) => {
  try {
    const org = await one('SELECT * FROM organisations WHERE id = ?', [req.params.id]);
    if (!org) return res.status(404).json({ error: 'Organisation not found' });
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'The amount must be more than 0' });
    const sub = await one("SELECT * FROM subscriptions WHERE org_id = ? AND status IN ('active','trial','past_due') ORDER BY id DESC LIMIT 1", [org.id]);
    const paidAt = req.body.paid_at ? new Date(req.body.paid_at) : new Date();
    if (Number.isNaN(paidAt.getTime())) return res.status(400).json({ error: 'That payment date is not a date' });
    const currency = String(req.body.currency || sub?.currency || 'INR').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) return res.status(400).json({ error: 'The currency is a three-letter code' });
    await run('INSERT INTO payments (org_id, subscription_id, amount, currency, paid_at, method, reference, notes, created_by) VALUES (?,?,?,?,?,?,?,?,?)',
      [org.id, sub?.id || null, money(amount), currency, paidAt, String(req.body.method || '').slice(0, 40) || null,
        String(req.body.reference || '').slice(0, 190) || null, String(req.body.notes || '').trim() || null, req.user.id]);
    // A payment against a subscription that was behind puts it back in good standing.
    if (sub && req.body.extend) {
      const next = new Date(Math.max(Date.now(), (utcMs(sub.renews_at) || Date.now())) + (sub.cycle === 'yearly' ? 365 : 30) * 86400000);
      await run("UPDATE subscriptions SET status = 'active', renews_at = ? WHERE id = ?", [next, sub.id]);
    }
    await logActivity('organisation', org.id, 'payment_recorded', `Recorded ${currency} ${money(amount)} from "${org.name}"`);
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

platformRouter.delete('/payments/:id', async (req, res, next) => {
  try {
    const p = await one('SELECT p.*, o.name AS org_name FROM payments p JOIN organisations o ON o.id = p.org_id WHERE p.id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Payment not found' });
    await run('DELETE FROM payments WHERE id = ?', [p.id]);
    await logActivity('organisation', p.org_id, 'payment_deleted', `Deleted a payment of ${p.currency} ${money(p.amount)} from "${p.org_name}"`, 'warn');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* ---------------------------------------------------------------- users */

platformRouter.get('/users', async (req, res, next) => {
  try {
    const rows = await all(`SELECT u.id, u.name, u.email, u.phone, u.role, u.status, u.org_id, u.last_login_at, u.created_at, o.name AS org_name,
      (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > NOW()) AS sessions
      FROM users u LEFT JOIN organisations o ON o.id = u.org_id WHERE u.role <> 'super_admin' ORDER BY u.created_at DESC`);
    res.json({
      users: rows.map((u) => ({
        id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, roleLabel: ROLES[u.role]?.label || u.role, status: u.status,
        orgId: u.org_id, organisation: u.org_name, lastLoginAt: u.last_login_at, createdAt: u.created_at, sessions: Number(u.sessions),
        you: u.id === req.user.id,
      })),
      roles: CLIENT_ROLES.map((key) => ({ key, label: ROLES[key].label })),
    });
  } catch (err) { next(err); }
});

/** Move someone to another organisation (roles, status and passwords go through /api/team). */
platformRouter.put('/users/:id/organisation', async (req, res, next) => {
  try {
    const u = await one('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!u) return res.status(404).json({ error: 'User not found' });
    if (u.role === 'super_admin') return res.status(400).json({ error: 'Super admins do not belong to an organisation' });
    const org = await one('SELECT * FROM organisations WHERE id = ?', [Number(req.body.org_id)]);
    if (!org) return res.status(400).json({ error: 'Pick an organisation' });
    await run('UPDATE users SET org_id = ?, active_org_id = ? WHERE id = ?', [org.id, org.id, u.id]);
    await logActivity('user', u.id, 'moved', `Moved ${u.name} to "${org.name}"`);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------ dashboard */

/** The last `n` months as "YYYY-MM", oldest first. */
function lastMonths(n) {
  const out = [];
  const d = new Date();
  d.setDate(1);
  for (let i = n - 1; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push(`${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

platformRouter.get('/dashboard', async (req, res, next) => {
  try {
    const orgs = await organisationRows();
    const count = async (sql, params = []) => Number(await scalar(sql, params));
    const months = lastMonths(12);

    const subs = await all(`SELECT s.*, p.name AS plan_name FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.status IN ('active','trial','past_due')`);
    const mrr = money(subs.reduce((n, s) => n + monthlyValue(s), 0));
    const currencies = [...new Set([...subs.map((s) => s.currency), ...(await all('SELECT DISTINCT currency FROM payments')).map((r) => r.currency)])];

    const revRows = await all(`SELECT DATE_FORMAT(paid_at, '%Y-%m') AS m, SUM(amount) AS total, COUNT(*) AS n FROM payments
      WHERE paid_at >= DATE_SUB(DATE_FORMAT(NOW(), '%Y-%m-01'), INTERVAL 11 MONTH) GROUP BY m`);
    const revByMonth = Object.fromEntries(revRows.map((r) => [r.m, money(r.total)]));
    const orgRows = await all(`SELECT DATE_FORMAT(created_at, '%Y-%m') AS m, COUNT(*) AS n FROM organisations
      WHERE created_at >= DATE_SUB(DATE_FORMAT(NOW(), '%Y-%m-01'), INTERVAL 11 MONTH) GROUP BY m`);
    const orgByMonth = Object.fromEntries(orgRows.map((r) => [r.m, Number(r.n)]));
    const userRows = await all(`SELECT DATE_FORMAT(created_at, '%Y-%m') AS m, COUNT(*) AS n FROM users
      WHERE created_at >= DATE_SUB(DATE_FORMAT(NOW(), '%Y-%m-01'), INTERVAL 11 MONTH) GROUP BY m`);
    const userByMonth = Object.fromEntries(userRows.map((r) => [r.m, Number(r.n)]));

    const thisMonth = months[months.length - 1];
    const lastMonth = months[months.length - 2];

    const plans = await all('SELECT * FROM plans ORDER BY sort_order');
    const byPlan = plans.map((p) => {
      const ps = subs.filter((s) => s.plan_id === p.id);
      return { id: p.id, name: p.name, status: p.status, subscribers: ps.length, mrr: money(ps.reduce((n, s) => n + monthlyValue(s), 0)) };
    }).filter((p) => p.subscribers || p.status === 'active');

    const recentPayments = await all(`SELECT p.amount, p.currency, p.paid_at, p.method, o.name AS org_name FROM payments p
      JOIN organisations o ON o.id = p.org_id ORDER BY p.paid_at DESC LIMIT 8`);
    const renewing = subs.filter((s) => s.renews_at && utcMs(s.renews_at) - Date.now() < 14 * 86400000)
      .map((s) => ({ org: orgs.find((o) => o.id === s.org_id)?.name, plan: s.plan_name, renewsAt: s.renews_at, amount: money(s.amount), currency: s.currency, cycle: s.cycle, status: s.status }))
      .sort((a, b) => utcMs(a.renewsAt) - utcMs(b.renewsAt));

    res.json({
      currency: currencies.length === 1 ? currencies[0] : (currencies[0] || 'INR'),
      mixedCurrencies: currencies.length > 1,
      revenue: {
        mrr,
        arr: money(mrr * 12),
        thisMonth: revByMonth[thisMonth] || 0,
        lastMonth: revByMonth[lastMonth] || 0,
        total: money(await scalar('SELECT COALESCE(SUM(amount), 0) FROM payments')),
        byMonth: months.map((m) => ({ month: m, total: revByMonth[m] || 0 })),
        arpa: subs.filter((s) => s.status === 'active').length ? money(mrr / subs.filter((s) => s.status === 'active').length) : 0,
      },
      subscriptions: {
        active: subs.filter((s) => s.status === 'active').length,
        trial: subs.filter((s) => s.status === 'trial').length,
        pastDue: subs.filter((s) => s.status === 'past_due').length,
        cancelledThisMonth: await count("SELECT COUNT(*) FROM subscriptions WHERE status = 'cancelled' AND DATE_FORMAT(ended_at, '%Y-%m') = ?", [thisMonth]),
        byPlan,
        withoutPlan: orgs.filter((o) => !o.subscription).length,
      },
      organisations: {
        total: orgs.length,
        active: orgs.filter((o) => o.status === 'active').length,
        suspended: orgs.filter((o) => o.status === 'suspended').length,
        newThisMonth: orgByMonth[thisMonth] || 0,
        byMonth: months.map((m) => ({ month: m, total: orgByMonth[m] || 0 })),
        top: [...orgs].sort((a, b) => (b.counts.servers + b.counts.apps) - (a.counts.servers + a.counts.apps)).slice(0, 5),
      },
      users: {
        total: await count("SELECT COUNT(*) FROM users WHERE role <> 'super_admin'"),
        active: await count("SELECT COUNT(*) FROM users WHERE status = 'active' AND role <> 'super_admin'"),
        activeLast30: await count("SELECT COUNT(*) FROM users WHERE role <> 'super_admin' AND last_login_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)"),
        superAdmins: await count("SELECT COUNT(*) FROM users WHERE role = 'super_admin'"),
        newThisMonth: userByMonth[thisMonth] || 0,
        byMonth: months.map((m) => ({ month: m, total: userByMonth[m] || 0 })),
      },
      resources: {
        servers: await count('SELECT COUNT(*) FROM servers'),
        serversOnline: await count("SELECT COUNT(*) FROM servers WHERE status = 'online'"),
        apps: await count('SELECT COUNT(*) FROM apps'),
        appsRunning: await count("SELECT COUNT(*) FROM apps WHERE status = 'running'"),
        domains: await count('SELECT COUNT(*) FROM app_domains'),
        domainsLive: await count("SELECT COUNT(*) FROM app_domains WHERE status = 'active'"),
        databases: await count("SELECT COUNT(*) FROM credentials WHERE provider IN ('mysql','postgres','mongodb','redis')"),
        installs: await count('SELECT COUNT(*) FROM installations'),
      },
      leads: await leadSummary(),
      requests: orgs.filter((o) => o.request).map((o) => ({ orgId: o.id, organisation: o.name, ...o.request })),
      recentPayments: recentPayments.map((p) => ({ amount: money(p.amount), currency: p.currency, paidAt: p.paid_at, method: p.method, organisation: p.org_name })),
      renewing,
    });
  } catch (err) { next(err); }
});
