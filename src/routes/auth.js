/**
 * Signing in.
 *
 * Signing in and signing up both end in a one-time code sent to the mobile
 * number (lib/verification.js), and a self sign-up must also click the link
 * emailed to it before its first sign-in.
 *
 * The very first run has no accounts at all, so the panel asks whoever gets
 * there first to create the super admin. A super admin runs the platform and
 * belongs to no organisation. After that this router issues and ends
 * sessions, and lets a visitor sign up: their own organisation, with them as
 * its admin (ALLOW_SIGNUP=false turns that off). Everyone else is created by
 * a super admin or an organisation's admin.
 */

import { Router } from 'express';
import { config } from '../config.js';
import { one, run, scalar, logActivity } from '../db/index.js';
import {
  hashPassword, verifyPassword, checkPassword, checkEmail, checkPhone, phoneRequired,
  newSessionToken, hashToken, sessionCookie, clearedCookie, publicRoles,
} from '../lib/auth.js';
import { publicUser, orgOf, endSession, endAllSessions, requireAuth } from '../lib/authGuard.js';
import { createOrganisation, OrgError } from '../lib/organisations.js';
import { setSubscription } from '../lib/plans.js';
import { clientIp, rateLimiter } from '../lib/security.js';
import {
  createChallenge, verifyChallenge, resendChallenge, VerifyError, sendVerificationEmail, usersByPhone, phoneDigits,
} from '../lib/verification.js';
import { TERMS_VERSION } from '../lib/terms.js';

export const authRouter = Router();

/*
 * Password guessing: an address gets 20 tries and one account 8 tries per
 * quarter hour, whichever runs out first. A right password clears the account's count.
 */
const loginByIp = rateLimiter({ windowMs: 15 * 60_000, max: 20 });
const loginByEmail = rateLimiter({ windowMs: 15 * 60_000, max: 8 });

/** Checked against when the email has no account, so a miss takes as long as a wrong password. */
const DUMMY_HASH = hashPassword(newSessionToken());

const tooMany = (res, wait) => res.status(429)
  .set('Retry-After', String(wait))
  .json({ error: `Too many attempts — try again in ${Math.ceil(wait / 60)} minute${wait > 60 ? 's' : ''}.` });

const cookieOptions = () => ({ maxAge: config.auth.sessionDays * 86400, secure: config.auth.secureCookie });

/** Has anybody set this panel up yet? */
const userCount = async () => Number(await scalar('SELECT COUNT(*) FROM users'));

async function startSession(req, res, user) {
  const token = newSessionToken();
  const expires = new Date(Date.now() + config.auth.sessionDays * 86400 * 1000);

  await run(
    'INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent) VALUES (?,?,?,?,?)',
    [hashToken(token), user.id, expires.toISOString().slice(0, 19).replace('T', ' '),
      clientIp(req),
      String(req.headers['user-agent'] || '').slice(0, 255)]
  );
  await run('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);
  res.setHeader('Set-Cookie', sessionCookie(token, cookieOptions()));
}

/* ---------------------------------------------------------------- state */

/** What the browser needs before it can draw anything: set up, signed in, or neither. */
authRouter.get('/state', async (req, res, next) => {
  try {
    const needsSetup = (await userCount()) === 0;
    res.json({
      needsSetup,
      signupOpen: !needsSetup && signupOpen(),
      user: publicUser(req.user, req.organisation),
      roles: publicRoles(),
    });
  } catch (err) { next(err); }
});

/* ---------------------------------------------------------------- setup */

/** First run only: create the super admin, who runs the platform and belongs to no organisation. */
authRouter.post('/setup', async (req, res, next) => {
  try {
    if (await userCount()) {
      return res.status(409).json({ error: 'This panel already has accounts. Sign in instead.' });
    }

    const email = checkEmail(req.body.email);
    if (email.error) return res.status(400).json({ error: email.error });

    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Your name is required' });

    const passwordError = checkPassword(req.body.password);
    if (passwordError) return res.status(400).json({ error: passwordError });

    const phone = checkPhone(req.body.phone, { required: true });
    if (phone.error) return res.status(400).json({ error: phone.error });

    const { insertId } = await run(
      `INSERT INTO users (org_id, active_org_id, email, name, phone, password_hash, role, status)
       VALUES (NULL, NULL, ?,?,?,?,'super_admin','active')`,
      [email.value, name, phone.value, hashPassword(req.body.password)]
    );

    const user = await one('SELECT * FROM users WHERE id = ?', [insertId]);
    await startSession(req, res, user);
    await logActivity('user', insertId, 'setup', `${name} set up the panel as super admin`);

    res.status(201).json({ ok: true, user: publicUser(user, null) });
  } catch (err) { next(err); }
});

/* --------------------------------------------------------------- sign up */

/** Sign-up is on unless ALLOW_SIGNUP=false, and only once the panel has its super admin. */
const signupOpen = () => String(process.env.ALLOW_SIGNUP ?? 'true').toLowerCase() !== 'false';

// A few sign-ups per address an hour is plenty for a person, and slows down anything else.
const signupHits = new Map();
const SIGNUP_WINDOW_MS = 60 * 60 * 1000;
const SIGNUP_PER_WINDOW = 5;

/** The free plan a new organisation starts on: public, active and costing nothing. */
const freePlan = () => one(
  "SELECT * FROM plans WHERE status = 'active' AND is_public = 1 AND price_monthly = 0 AND price_yearly = 0 ORDER BY sort_order, id LIMIT 1"
);

/** An organisation name nobody has yet: "Acme", then "Acme 2", "Acme 3"… */
async function freeOrgName(base) {
  const name = base.slice(0, 180);
  if (!await one('SELECT id FROM organisations WHERE name = ?', [name])) return name;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${name} ${n}`;
    if (!await one('SELECT id FROM organisations WHERE name = ?', [candidate])) return candidate;
  }
  return `${name} ${Date.now()}`;
}

/**
 * Anyone can create their own organisation, in three steps:
 *
 *   1. POST /signup         everything is checked, then a one-time code goes to the mobile number
 *   2. POST /signup/verify  the right code creates the organisation, with them as its admin,
 *                           on the free plan (when there is one) — and emails a verification link
 *   3. GET  /verify-email   the link marks the email verified; only then can they sign in
 *
 * Without a free plan the organisation waits on the "choose a plan" page.
 */
authRouter.post('/signup', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!signupOpen()) return res.status(403).json({ error: 'Sign-up is closed on this panel. Ask an admin for an account.' });
    if (!(await userCount())) return res.status(409).json({ error: 'This panel has not been set up yet.' });

    // The hidden field is only ever filled in by bots.
    if (b.hp_check) return res.status(400).json({ error: 'Sign-up could not be completed.' });

    const ip = clientIp(req);
    const now = Date.now();
    const hits = (signupHits.get(ip) || []).filter((t) => now - t < SIGNUP_WINDOW_MS);
    if (hits.length >= SIGNUP_PER_WINDOW) return res.status(429).json({ error: 'Too many sign-ups from this network — please try again in an hour.' });
    // Every attempt counts, so the "already has an account" answer cannot be used to test emails in bulk.
    hits.push(now);
    signupHits.set(ip, hits);
    if (signupHits.size > 5000) for (const [k, v] of signupHits) if (!v.some((t) => now - t < SIGNUP_WINDOW_MS)) signupHits.delete(k);

    const checked = await checkSignup(b);
    if (checked.error) return res.status(checked.status || 400).json(checked);

    const challenge = await createChallenge({ purpose: 'signup', payload: checked.value, phone: checked.value.phone });
    res.json({ ok: true, ...challenge });
  } catch (err) { next(err); }
});

/** Step 2: the code is right — create the organisation and email the verification link. */
authRouter.post('/signup/verify', async (req, res, next) => {
  try {
    const wait = loginByIp.hit(clientIp(req));
    if (wait) return tooMany(res, wait);
    if (!signupOpen()) return res.status(403).json({ error: 'Sign-up is closed on this panel. Ask an admin for an account.' });

    const { payload } = await verifyChallenge(req.body.challenge, req.body.otp, 'signup');
    // Checked again: somebody may have taken the email or number while the code was on its way.
    const checked = await checkSignup(payload);
    if (checked.error) return res.status(checked.status || 400).json(checked);
    const b = checked.value;

    const isFree = (p) => p && Number(p.price_monthly) === 0 && Number(p.price_yearly) === 0;
    const chosen = b.plan_id ? await one("SELECT * FROM plans WHERE id = ? AND status = 'active' AND is_public = 1", [b.plan_id]) : null;
    const plan = isFree(chosen) ? chosen : await freePlan();
    const requested = chosen && !isFree(chosen) ? chosen : null;

    const orgId = await createOrganisation({
      name: await freeOrgName(b.company || `${b.name}'s workspace`),
      notes: `Signed up from the website${requested ? ` — asked for ${requested.name} (${b.cycle})` : ''}`,
      admin_email: b.email, admin_password: b.password, admin_name: b.name, admin_phone: b.phone,
      plan_id: plan?.id, sub_status: 'active',
    }, null);
    if (requested) await setSubscription(orgId, requested, { cycle: b.cycle, status: 'pending', notes: 'Chosen at sign-up' });

    // Signed up from the website: the email must be confirmed before the first sign-in.
    await run(
      'UPDATE users SET email_verified = 0, email_verified_at = NULL, terms_version = ?, terms_accepted_at = NOW() WHERE email = ?',
      [TERMS_VERSION, b.email],
    );
    const user = await one('SELECT * FROM users WHERE email = ?', [b.email]);
    const org = await one('SELECT * FROM organisations WHERE id = ?', [orgId]);
    const mail = await sendVerificationEmail(req, user);

    await logActivity('user', user.id, 'signup', `${b.name} signed up and created "${org.name}"`
      + `${plan ? ` on ${plan.name}` : ' (no free plan — waiting for one)'}${requested ? `, asking for ${requested.name} (${b.cycle})` : ''}`
      + ' — mobile verified, waiting for the email to be verified');

    res.status(201).json({
      ok: true,
      verifyEmail: true,
      email: user.email,
      emailSent: Boolean(mail.delivered),
      plan: plan ? { id: plan.id, name: plan.name } : null,
      requested: requested ? { id: requested.id, name: requested.name, cycle: b.cycle } : null,
    });
  } catch (err) {
    if (err instanceof VerifyError) return res.status(err.status).json({ error: err.message, restart: Boolean(err.restart) });
    if (err instanceof OrgError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/** A new code for a sign-up or sign-in that is waiting on one. */
authRouter.post('/otp/resend', async (req, res, next) => {
  try {
    const wait = loginByIp.hit(clientIp(req));
    if (wait) return tooMany(res, wait);
    const purpose = req.body.purpose === 'signup' ? 'signup' : 'login';
    res.json({ ok: true, ...(await resendChallenge(req.body.challenge, purpose)) });
  } catch (err) {
    if (err instanceof VerifyError) return res.status(err.status).json({ error: err.message, restart: Boolean(err.restart) });
    next(err);
  }
});

/**
 * Everything a sign-up form says, checked: { value } ready to use, or { error }
 * (with the field it is about, so the form can point at it).
 */
async function checkSignup(b) {
  const fail = (field, error, extra = {}) => ({ error, field, ...extra });

  const name = String(b.name || '').trim().slice(0, 190);
  if (!name) return fail('name', 'Your name is required');
  if (name.length < 2) return fail('name', 'Your name is too short');
  const email = checkEmail(b.email);
  if (email.error) return fail('email', email.error);
  const phone = checkPhone(b.phone, { required: true });
  if (phone.error) return fail('phone', phone.error);
  const passwordError = checkPassword(b.password);
  if (passwordError) return fail('password', passwordError);
  if (b.confirm !== undefined && b.confirm !== b.password) return fail('confirm', 'The two passwords do not match');
  if (!(b.terms === true || b.terms === 'on' || b.terms === 'true')) return fail('terms', 'Please read and accept the Terms & Conditions to create an account');

  if (await one('SELECT id FROM users WHERE email = ?', [email.value])) {
    return fail('email', `${email.value} already has an account — sign in instead.`, { status: 409, signIn: true });
  }
  if ((await usersByPhone(phone.value)).length) {
    return fail('phone', `${phone.value} is already on an account — sign in instead, or use another number.`, { status: 409, signIn: true });
  }

  // The plan they picked. A free one starts at once; a paid one starts them on the free
  // plan and is recorded as a request, which a super admin switches on once it is paid for.
  const cycle = b.cycle === 'yearly' ? 'yearly' : 'monthly';
  const chosen = b.plan_id ? await one("SELECT * FROM plans WHERE id = ? AND status = 'active' AND is_public = 1", [Number(b.plan_id)]) : null;
  if (b.plan_id && !chosen) return fail('plan', 'That plan is not available — pick another one');
  const paid = chosen && !(Number(chosen.price_monthly) === 0 && Number(chosen.price_yearly) === 0);
  if (paid && cycle === 'yearly' && !(Number(chosen.price_yearly) > 0)) {
    return fail('plan', `${chosen.name} is not sold yearly — choose monthly`);
  }

  return {
    value: {
      name, email: email.value, phone: phone.value, password: String(b.password), terms: true,
      company: String(b.company || '').trim().slice(0, 180), plan_id: chosen ? chosen.id : null, cycle,
    },
  };
}

/* ---------------------------------------------------------------- login */

/**
 * Sign in with an email or a mobile number and the password, then a one-time
 * code. An account that signed up itself must have verified its email first.
 */
authRouter.post('/login', async (req, res, next) => {
  try {
    const login = String(req.body.login ?? req.body.email ?? '').trim().toLowerCase().slice(0, 190);
    const byEmail = login.includes('@');
    const wait = Math.max(loginByIp.hit(clientIp(req)), loginByEmail.hit(byEmail ? login : phoneDigits(login)));
    if (wait) return tooMany(res, wait);

    if (!login) return res.status(400).json({ error: 'Enter your email or mobile number', field: 'login' });
    if (byEmail && checkEmail(login).error) return res.status(400).json({ error: 'That does not look like an email address', field: 'login' });
    if (!byEmail && checkPhone(login).error) {
      return res.status(400).json({ error: 'Enter your email or mobile number (e.g. 98765 43210)', field: 'login' });
    }
    if (!req.body.password) return res.status(400).json({ error: 'Enter your password', field: 'password' });

    // A number can be on more than one account; the password says which one is meant.
    const candidates = byEmail ? [await one('SELECT * FROM users WHERE email = ?', [login])].filter(Boolean) : await usersByPhone(login);
    let user = null;
    for (const c of candidates) if (verifyPassword(req.body.password, c.password_hash)) user = user || c;
    // The same answer, and the same time taken, either way — so this cannot be used to find out who has an account.
    if (!candidates.length) verifyPassword(req.body.password, DUMMY_HASH);
    if (!user) {
      return res.status(401).json({ error: `That ${byEmail ? 'email' : 'mobile number'} and password do not match an account` });
    }
    loginByEmail.reset(byEmail ? login : phoneDigits(login));
    if (user.status !== 'active') {
      return res.status(403).json({ error: 'This account has been disabled. Ask an admin to turn it back on.' });
    }
    if (!Number(user.email_verified)) {
      return res.status(403).json({
        error: `Verify your email first — we sent a link to ${user.email}.`,
        needsEmailVerification: true,
        email: user.email,
      });
    }

    const challenge = await createChallenge({ purpose: 'login', user, phone: user.phone, email: user.email });
    res.json({ ok: true, ...challenge });
  } catch (err) { next(err); }
});

/** Step 2 of signing in: the code, then the session. */
authRouter.post('/login/verify', async (req, res, next) => {
  try {
    const wait = loginByIp.hit(clientIp(req));
    if (wait) return tooMany(res, wait);

    const { userId } = await verifyChallenge(req.body.challenge, req.body.otp, 'login');
    const user = await one('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user || user.status !== 'active') {
      return res.status(403).json({ error: 'This account has been disabled. Ask an admin to turn it back on.', restart: true });
    }

    // A super admin always lands on the platform, not inside the last organisation they opened.
    if (user.role === 'super_admin' && user.active_org_id) {
      await run('UPDATE users SET active_org_id = NULL WHERE id = ?', [user.id]);
      user.active_org_id = null;
    }

    await startSession(req, res, user);
    const org = orgOf(user) ? await one('SELECT * FROM organisations WHERE id = ?', [orgOf(user)]) : null;
    await logActivity('user', user.id, 'login', `${user.name} signed in`);

    res.json({ ok: true, user: publicUser(user, org) });
  } catch (err) {
    if (err instanceof VerifyError) return res.status(err.status).json({ error: err.message, restart: Boolean(err.restart) });
    next(err);
  }
});

/* ------------------------------------------------- email verification */

const verifyResends = rateLimiter({ windowMs: 60 * 60_000, max: 5 });

/**
 * Send the verification link again. The answer is the same whether or not the
 * address has an account waiting, so it cannot be used to look accounts up.
 */
authRouter.post('/verify-email/resend', async (req, res, next) => {
  try {
    const email = checkEmail(req.body.email);
    if (email.error) return res.status(400).json({ error: email.error });
    const wait = Math.max(loginByIp.hit(clientIp(req)), verifyResends.hit(email.value));
    if (wait) return tooMany(res, wait);

    const user = await one('SELECT * FROM users WHERE email = ?', [email.value]);
    if (user && !Number(user.email_verified) && user.status === 'active') await sendVerificationEmail(req, user);
    res.json({ ok: true, message: `If ${email.value} is waiting to be verified, a new link is on its way.` });
  } catch (err) { next(err); }
});

authRouter.post('/logout', async (req, res, next) => {
  try {
    if (req.session) await endSession(req.session.id);
    res.setHeader('Set-Cookie', clearedCookie(cookieOptions()));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------- account */

/** Change your own name, mobile number or the email you sign in with. */
authRouter.put('/profile', requireAuth, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Your name is required' });

    const email = checkEmail(req.body.email ?? req.user.email);
    if (email.error) return res.status(400).json({ error: email.error });

    // Moving the account to another email is a takeover if the session was stolen: it needs the password.
    if (email.value !== req.user.email) {
      const wait = loginByEmail.hit(req.user.email);
      if (wait) return tooMany(res, wait);
      if (!verifyPassword(req.body.current || '', req.user.password_hash)) {
        return res.status(400).json({ error: 'Enter your current password to change the email you sign in with', needsPassword: true });
      }
    }

    if (email.value !== req.user.email
      && await one('SELECT id FROM users WHERE email = ? AND id <> ?', [email.value, req.user.id])) {
      return res.status(409).json({ error: `Somebody else already signs in with ${email.value}` });
    }

    // Keep the number already there when the form does not send one.
    const phone = checkPhone(req.body.phone !== undefined ? req.body.phone : req.user.phone, { required: phoneRequired(req.user.role) });
    if (phone.error) return res.status(400).json({ error: phone.error });

    await run('UPDATE users SET name = ?, email = ?, phone = ? WHERE id = ?', [name, email.value, phone.value, req.user.id]);
    const user = await one('SELECT * FROM users WHERE id = ?', [req.user.id]);
    await logActivity('user', user.id, 'profile_updated', `${name} updated their profile`);

    res.json({ ok: true, user: publicUser(user, req.organisation) });
  } catch (err) { next(err); }
});

/** Change your own password. Every other session of yours is ended. */
authRouter.post('/password', requireAuth, async (req, res, next) => {
  try {
    const wait = loginByEmail.hit(req.user.email);
    if (wait) return tooMany(res, wait);
    if (!verifyPassword(req.body.current || '', req.user.password_hash)) {
      return res.status(400).json({ error: 'Your current password is not right' });
    }
    const passwordError = checkPassword(req.body.password);
    if (passwordError) return res.status(400).json({ error: passwordError });

    await run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(req.body.password), req.user.id]);
    await endAllSessions(req.user.id);
    await startSession(req, res, req.user);
    await logActivity('user', req.user.id, 'password_changed', `${req.user.name} changed their password`);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/** A super admin opens a client organisation to work inside it, or (org_id empty) goes back to the platform. */
authRouter.post('/organisation', requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Only a super admin can work in another organisation' });
    }
    if (!req.body.org_id) {
      await run('UPDATE users SET active_org_id = NULL WHERE id = ?', [req.user.id]);
      return res.json({ ok: true, user: publicUser({ ...req.user, active_org_id: null }, null) });
    }
    const org = await one('SELECT * FROM organisations WHERE id = ?', [Number(req.body.org_id)]);
    if (!org) return res.status(404).json({ error: 'That organisation does not exist' });

    await run('UPDATE users SET active_org_id = ? WHERE id = ?', [org.id, req.user.id]);
    res.json({ ok: true, user: publicUser({ ...req.user, active_org_id: org.id }, org) });
  } catch (err) { next(err); }
});
