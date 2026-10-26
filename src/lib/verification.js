/**
 * Proving it is really you: a one-time code at sign-in and sign-up, and a
 * link that confirms a new account's email address.
 *
 * A code waits in auth_challenges behind a random token the browser holds;
 * only SHA-256 hashes of the token and the code are stored. A sign-up has no
 * account yet, so what was typed rides along encrypted with the master key and
 * the account is only created once the code checks out.
 *
 * Codes go to the mobile number (or the email, for an account without one).
 * No SMS provider is wired in yet: OTP_MODE=fixed accepts OTP_FIXED_CODE
 * (123456 by default), and OTP_MODE=random writes each code to the server log.
 */

import crypto from 'node:crypto';
import { config } from '../config.js';
import { one, all, run } from '../db/index.js';
import { encrypt, decrypt } from './crypto.js';
import { hashToken, newSessionToken } from './auth.js';
import { sendMail } from './mailer.js';

const MAX_ATTEMPTS = 5;
const MAX_SENDS = 5;
const RESEND_AFTER_SECONDS = 30;

export class VerifyError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

/* ------------------------------------------------------------- masking */

/** "+91 98765 43210" → "+91 •••••• 3210" — enough to recognise, not enough to copy. */
export function maskPhone(phone) {
  const value = String(phone || '').trim();
  const digits = value.replace(/\D/g, '');
  const code = /^\+\d{1,4}(?=[\s-])/.exec(value)?.[0] || (value.startsWith('+') ? `+${digits.slice(0, 2)}` : '');
  return `${code ? `${code} ` : ''}${'•'.repeat(Math.max(2, digits.length - code.replace(/\D/g, '').length - 4))} ${digits.slice(-4)}`;
}

/** "jane.doe@company.com" → "ja•••••@company.com". */
export function maskEmail(email) {
  const [local, domain] = String(email || '').split('@');
  if (!domain) return '•••';
  return `${local.slice(0, 2)}${'•'.repeat(Math.max(3, local.length - 2))}@${domain}`;
}

/** Digits only, so "+91 98765-43210" and "+919876543210" are the same number. */
export const phoneDigits = (phone) => String(phone || '').replace(/\D/g, '');

/* ---------------------------------------------------------- the codes */

const newCode = () => (config.otp.mode === 'fixed' ? config.otp.fixedCode : String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'));

/** Where the code goes. With no SMS provider yet, a random code is written to the server log. */
function deliverCode(code, { channel, to, purpose }) {
  if (config.otp.mode === 'random') {
    console.log(`[otp] ${purpose} code for ${channel === 'sms' ? 'mobile' : 'email'} ${to}: ${code} (no SMS provider configured — read it here)`);
  }
}

const clearExpired = () => run('DELETE FROM auth_challenges WHERE expires_at < NOW()');

/**
 * Start a one-time-code step. `user` (sign-in) or `payload` (sign-up) says what
 * the code unlocks. Returns what the browser needs to show the code form.
 */
export async function createChallenge({ purpose, user = null, payload = null, phone = null, email = null }) {
  await clearExpired();
  const token = newSessionToken();
  const code = newCode();
  const channel = phone ? 'sms' : 'email';
  const to = phone || email;

  await run(
    `INSERT INTO auth_challenges (token_hash, purpose, user_id, payload, code_hash, channel, sent_to, expires_at)
     VALUES (?,?,?,?,?,?,?, DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
    [hashToken(token), purpose, user?.id || null, payload ? encrypt(JSON.stringify(payload)) : null,
      hashToken(code), channel, to, config.otp.minutes],
  );
  deliverCode(code, { channel, to, purpose });

  return challengeView(token, { channel, to });
}

function challengeView(token, { channel, to }) {
  return {
    otpRequired: true,
    challenge: token,
    channel,
    sentTo: channel === 'sms' ? maskPhone(to) : maskEmail(to),
    expiresInMinutes: config.otp.minutes,
    resendAfterSeconds: RESEND_AFTER_SECONDS,
    // Says so on screen, so nobody waits for a text message that is never coming. A fixed
    // code protects nothing anyway, so showing it costs nothing — OTP_MODE=random hides it.
    testMode: config.otp.mode === 'fixed',
    testCode: config.otp.mode === 'fixed' ? config.otp.fixedCode : undefined,
  };
}

async function findChallenge(token, purpose) {
  const row = token
    ? await one('SELECT *, TIMESTAMPDIFF(SECOND, last_sent_at, NOW()) AS since_sent FROM auth_challenges WHERE token_hash = ? AND expires_at > NOW()', [hashToken(token)])
    : null;
  if (!row || row.purpose !== purpose) {
    throw new VerifyError('This code has expired — start again.', 410, { restart: true });
  }
  return row;
}

/**
 * Check a typed code. Five wrong tries and the challenge is gone; the right one
 * uses it up. Resolves to { userId, payload }.
 */
export async function verifyChallenge(token, code, purpose) {
  const row = await findChallenge(token, purpose);
  const typed = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(typed)) throw new VerifyError('Enter the 6-digit code');

  const ok = crypto.timingSafeEqual(Buffer.from(hashToken(typed)), Buffer.from(row.code_hash));
  if (!ok) {
    const attempts = row.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await run('DELETE FROM auth_challenges WHERE id = ?', [row.id]);
      throw new VerifyError('Too many wrong codes — start again.', 429, { restart: true });
    }
    await run('UPDATE auth_challenges SET attempts = ? WHERE id = ?', [attempts, row.id]);
    const left = MAX_ATTEMPTS - attempts;
    throw new VerifyError(`That code is not right — ${left} ${left === 1 ? 'try' : 'tries'} left.`);
  }

  // Used once: a second request with the same code finds nothing.
  const { affectedRows } = await run('DELETE FROM auth_challenges WHERE id = ?', [row.id]);
  if (!affectedRows) throw new VerifyError('This code has already been used — start again.', 410, { restart: true });

  return { userId: row.user_id, payload: row.payload ? JSON.parse(decrypt(row.payload)) : null };
}

/** A new code for the same step, at most every 30 seconds and five times in all. */
export async function resendChallenge(token, purpose) {
  const row = await findChallenge(token, purpose);
  if (row.since_sent < RESEND_AFTER_SECONDS) {
    throw new VerifyError(`Wait ${RESEND_AFTER_SECONDS - row.since_sent} seconds before asking for another code.`, 429);
  }
  if (row.sends >= MAX_SENDS) throw new VerifyError('No more codes for this attempt — start again.', 429, { restart: true });

  const code = newCode();
  await run(
    `UPDATE auth_challenges SET code_hash = ?, attempts = 0, sends = sends + 1, last_sent_at = NOW(),
       expires_at = DATE_ADD(NOW(), INTERVAL ? MINUTE) WHERE id = ?`,
    [hashToken(code), config.otp.minutes, row.id],
  );
  deliverCode(code, { channel: row.channel, to: row.sent_to, purpose });
  return challengeView(token, { channel: row.channel, to: row.sent_to });
}

/* ------------------------------------------------ email verification */

/** The address the link should point at: SITE_URL, or the address this request came in on. */
export function siteBase(req) {
  if (config.siteUrl) return config.siteUrl.replace(/\/+$/, '');
  const proto = config.trustProxy && req.headers['x-forwarded-proto'] ? String(req.headers['x-forwarded-proto']).split(',')[0].trim() : req.protocol;
  const host = (config.trustProxy && req.headers['x-forwarded-host']) || req.headers.host;
  return `${proto}://${host}`;
}

/** Make a fresh link (older ones for this account stop working) and email it. */
export async function sendVerificationEmail(req, user) {
  const token = newSessionToken();
  await run('DELETE FROM email_verifications WHERE user_id = ?', [user.id]);
  await run(
    'INSERT INTO email_verifications (token_hash, user_id, email, expires_at) VALUES (?,?,?, DATE_ADD(NOW(), INTERVAL ? HOUR))',
    [hashToken(token), user.id, user.email, config.emailVerifyHours],
  );

  const link = `${siteBase(req)}/verify-email?token=${encodeURIComponent(token)}`;
  const hours = config.emailVerifyHours;
  const text = [
    `Hi ${user.name},`,
    '',
    'Confirm your email address to finish creating your AJ Pilot account:',
    link,
    '',
    `The link works for ${hours} hour${hours === 1 ? '' : 's'}. If you did not sign up, ignore this email.`,
  ].join('\n');
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0b1a36">
    <h2 style="margin:0 0 12px">Confirm your email</h2>
    <p>Hi ${escapeHtml(user.name)},</p>
    <p>Click the button to confirm <b>${escapeHtml(user.email)}</b> and finish creating your AJ Pilot account.</p>
    <p style="margin:24px 0"><a href="${escapeHtml(link)}" style="background:#1d4ed8;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Verify my email</a></p>
    <p style="color:#55627a;font-size:13px">Or paste this link into your browser:<br><span style="word-break:break-all">${escapeHtml(link)}</span></p>
    <p style="color:#55627a;font-size:13px">The link works for ${hours} hour${hours === 1 ? '' : 's'}. If you did not sign up, ignore this email.</p>
  </div>`;

  try {
    return await sendMail({ to: user.email, subject: 'Verify your email for AJ Pilot', text, html });
  } catch (err) {
    console.error(`[mail] Could not send the verification email to ${user.email}: ${err.message}`);
    return { delivered: false, error: true };
  }
}

/** Use a link. Resolves to 'verified', 'already', 'expired' or 'invalid'. */
export async function confirmEmail(token) {
  if (!token || String(token).length > 200) return { result: 'invalid' };
  const row = await one('SELECT *, expires_at > NOW() AS live FROM email_verifications WHERE token_hash = ?', [hashToken(token)]);
  if (!row) return { result: 'invalid' };
  const user = await one('SELECT * FROM users WHERE id = ?', [row.user_id]);
  // The account's email changed since the link was sent: the link no longer proves anything.
  if (!user || user.email !== row.email) {
    await run('DELETE FROM email_verifications WHERE id = ?', [row.id]);
    return { result: 'invalid' };
  }
  if (!Number(row.live)) return { result: 'expired', user };

  await run('DELETE FROM email_verifications WHERE user_id = ?', [user.id]);
  if (Number(user.email_verified)) return { result: 'already', user };
  await run('UPDATE users SET email_verified = 1, email_verified_at = NOW() WHERE id = ?', [user.id]);
  return { result: 'verified', user };
}

/* -------------------------------------------- signing in with a number */

/**
 * The account a mobile number signs in to. Numbers are compared by their
 * digits; one shared by several accounts cannot be used (they sign in by email).
 */
export async function usersByPhone(phone) {
  const digits = phoneDigits(phone);
  if (digits.length < 8) return [];
  const candidates = await all('SELECT * FROM users WHERE phone LIKE ?', [`%${digits.slice(-4)}%`]);
  return candidates.filter((u) => {
    const d = phoneDigits(u.phone);
    // "+91 98765 43210" and "98765 43210" are the same number with and without its country code.
    if (d === digits) return true;
    const sameTail = d.length > digits.length ? d.endsWith(digits) : digits.endsWith(d);
    return sameTail && Math.min(d.length, digits.length) >= 10;
  });
}

function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
