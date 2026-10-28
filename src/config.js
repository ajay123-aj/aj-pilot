import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });

/**
 * Master key used to encrypt every secret at rest (server passwords, SSH keys,
 * git tokens, docker hub tokens, cloudflare tokens).
 * Prefer APP_ENCRYPTION_KEY from .env; otherwise generate one and keep it in
 * data/master.key so a fresh clone still boots.
 */
function loadMasterKey() {
  const fromEnv = process.env.APP_ENCRYPTION_KEY;
  if (fromEnv && fromEnv.trim()) {
    return crypto.createHash('sha256').update(fromEnv.trim()).digest();
  }
  const keyFile = path.join(DATA_DIR, 'master.key');
  if (!fs.existsSync(keyFile)) {
    fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    console.warn('[config] Generated a new master key at data/master.key — back it up, losing it makes stored secrets unreadable.');
  }
  return Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
}

export const config = {
  port: Number(process.env.PORT || 4000),
  host: process.env.HOST || '0.0.0.0',

  /** The panel's own storage. Point this at any MySQL you control. */
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'auto_deploy',
    connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
  },

  /** Legacy SQLite file, imported once on boot if it still holds data. */
  sqliteFile: process.env.SQLITE_FILE || path.join(DATA_DIR, 'auto-deploy.db'),

  /**
   * Browser sign-in for git hosting. Each provider needs an OAuth app
   * registered with it; without one the panel falls back to pasting a token.
   */
  oauth: {
    callbackBase: process.env.OAUTH_CALLBACK_BASE || `http://localhost:${Number(process.env.PORT || 4000)}`,
    github: {
      clientId: process.env.GITHUB_CLIENT_ID || '',
      clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
      webUrl: process.env.GITHUB_WEB_URL || 'https://github.com',
      apiUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
    },
    gitlab: {
      clientId: process.env.GITLAB_CLIENT_ID || '',
      clientSecret: process.env.GITLAB_CLIENT_SECRET || '',
      webUrl: process.env.GITLAB_WEB_URL || 'https://gitlab.com',
      apiUrl: process.env.GITLAB_API_URL || 'https://gitlab.com/api/v4',
    },
    bitbucket: {
      clientId: process.env.BITBUCKET_CLIENT_ID || '',
      clientSecret: process.env.BITBUCKET_CLIENT_SECRET || '',
      webUrl: 'https://bitbucket.org',
      apiUrl: 'https://api.bitbucket.org/2.0',
    },
  },

  /** Sign-in sessions: how long a cookie lasts, and whether it is HTTPS-only. */
  auth: {
    sessionDays: Number(process.env.AUTH_SESSION_DAYS || 14),
    // HTTPS-only by default once SITE_URL says the site is served over HTTPS; AUTH_SECURE_COOKIE overrides.
    secureCookie: process.env.AUTH_SECURE_COOKIE
      ? String(process.env.AUTH_SECURE_COOKIE).toLowerCase() === 'true'
      : String(process.env.SITE_URL || '').trim().toLowerCase().startsWith('https://'),
  },

  /**
   * The one-time code asked for at sign-in and sign-up. "fixed" uses OTP_FIXED_CODE
   * for everyone (testing, until an SMS provider is connected); "random" makes a
   * fresh code each time and, with no provider yet, writes it to the server log.
   */
  otp: {
    mode: String(process.env.OTP_MODE || 'fixed').trim().toLowerCase() === 'random' ? 'random' : 'fixed',
    fixedCode: /^\d{6}$/.test(String(process.env.OTP_FIXED_CODE || '')) ? String(process.env.OTP_FIXED_CODE) : '123456',
    minutes: Math.max(1, Number(process.env.OTP_MINUTES || 10)),
    /*
     * Signing in with just a mobile number and a code. The code is then the only
     * proof, so with a fixed code (anyone can type 123456) it is off unless
     * OTP_LOGIN=on says so — for testing. With random codes it is on unless OTP_LOGIN=off.
     */
    login: (() => {
      const set = String(process.env.OTP_LOGIN || '').trim().toLowerCase();
      if (set === 'on' || set === 'off') return set === 'on';
      return String(process.env.OTP_MODE || 'fixed').trim().toLowerCase() === 'random';
    })(),
  },

  /** Outgoing email (verification links). Without SMTP_HOST the message is written to the server log instead. */
  mail: {
    host: String(process.env.SMTP_HOST || '').trim(),
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
    user: String(process.env.SMTP_USER || '').trim(),
    pass: process.env.SMTP_PASS || '',
    from: String(process.env.MAIL_FROM || '').trim() || 'AJ Pilot <no-reply@localhost>',
  },
  emailVerifyHours: Math.max(1, Number(process.env.EMAIL_VERIFY_HOURS || 24)),

  /**
   * Razorpay: paying for a plan online. With both keys set, choosing a paid
   * plan opens Razorpay Checkout and the plan starts as soon as the payment is
   * verified; without them a paid plan stays a request a super admin switches on.
   */
  razorpay: {
    keyId: String(process.env.RAZORPAY_KEY_ID || '').trim(),
    keySecret: String(process.env.RAZORPAY_KEY_SECRET || '').trim(),
    webhookSecret: String(process.env.RAZORPAY_WEBHOOK_SECRET || '').trim(),
    apiBase: String(process.env.RAZORPAY_API_BASE || 'https://api.razorpay.com/v1').trim().replace(/\/+$/, ''),
  },

  /**
   * The platform owner, kept in .env. When both are set, boot makes sure this
   * account exists as an active super admin with exactly this password.
   */
  superAdmin: {
    email: String(process.env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase(),
    password: process.env.SUPER_ADMIN_PASSWORD || '',
    name: String(process.env.SUPER_ADMIN_NAME || '').trim(),
    phone: String(process.env.SUPER_ADMIN_PHONE || '').trim(),
  },

  /** The public address of this site (https://deploy.example.com), for canonical links, the sitemap and link previews. */
  siteUrl: String(process.env.SITE_URL || '').trim(),

  /**
   * Set when a reverse proxy (nginx, Cloudflare) sits in front of the panel, so
   * X-Forwarded-For / CF-Connecting-IP are believed. Off, they are ignored —
   * otherwise any visitor could claim any address.
   */
  trustProxy: String(process.env.TRUST_PROXY || '').toLowerCase() === 'true',

  /** Where lead IP addresses are looked up: "ipwho.is" (default) or "off". */
  geoip: String(process.env.GEOIP || 'ipwho.is').trim(),

  masterKey: loadMasterKey(),
  ssh: {
    connectTimeout: Number(process.env.SSH_CONNECT_TIMEOUT || 15000),
    execTimeout: Number(process.env.SSH_EXEC_TIMEOUT || 45000),
  },

  /**
   * Background reachability sweep.
   *
   * The fast tier opens a TCP connection to each server's SSH port on this
   * cadence and flips its status to online or offline. The slow tier actually
   * signs in now and then, which is the only way to know the stored credentials
   * still work — and far too expensive to do every few seconds.
   */
  monitor: {
    enabled: String(process.env.HEALTH_CHECK_ENABLED ?? 'true').toLowerCase() !== 'false',
    intervalMs: Math.max(2, Number(process.env.HEALTH_CHECK_INTERVAL_SECONDS || 5)) * 1000,
    timeoutMs: Number(process.env.HEALTH_CHECK_TIMEOUT || 4000),
    concurrency: Math.max(1, Number(process.env.HEALTH_CHECK_CONCURRENCY || 10)),
    sshMinutes: Math.max(1, Number(process.env.HEALTH_CHECK_SIGNIN_MINUTES || 10)),
    sshTimeoutMs: Number(process.env.HEALTH_CHECK_SIGNIN_TIMEOUT || 12000),
  },
};
