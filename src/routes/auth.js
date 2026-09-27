/**
 * Signing in.
 *
 * The very first run has no accounts at all, so the panel asks whoever gets
 * there first to create the super admin. A super admin runs the platform and
 * belongs to no organisation. After that this router only issues and ends
 * sessions — accounts are created by a super admin or an organisation's admin.
 */

import { Router } from 'express';
import { config } from '../config.js';
import { one, run, scalar, logActivity } from '../db/index.js';
import {
  hashPassword, verifyPassword, checkPassword, checkEmail, checkPhone, phoneRequired,
  newSessionToken, hashToken, sessionCookie, clearedCookie, publicRoles,
} from '../lib/auth.js';
import { publicUser, orgOf, endSession, endAllSessions, requireAuth } from '../lib/authGuard.js';

export const authRouter = Router();

const cookieOptions = () => ({ maxAge: config.auth.sessionDays * 86400, secure: config.auth.secureCookie });

/** Has anybody set this panel up yet? */
const userCount = async () => Number(await scalar('SELECT COUNT(*) FROM users'));

async function startSession(req, res, user) {
  const token = newSessionToken();
  const expires = new Date(Date.now() + config.auth.sessionDays * 86400 * 1000);

  await run(
    'INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent) VALUES (?,?,?,?,?)',
    [hashToken(token), user.id, expires.toISOString().slice(0, 19).replace('T', ' '),
      (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().slice(0, 64),
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

/* ---------------------------------------------------------------- login */

authRouter.post('/login', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const user = email ? await one('SELECT * FROM users WHERE email = ?', [email]) : null;

    // The same answer either way, so this cannot be used to find out who has an account.
    if (!user || !verifyPassword(req.body.password || '', user.password_hash)) {
      return res.status(401).json({ error: 'That email and password do not match an account' });
    }
    if (user.status !== 'active') {
      return res.status(403).json({ error: 'This account has been disabled. Ask an admin to turn it back on.' });
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
