/**
 * What every test file shares: a client that keeps its own session cookie and
 * comes from its own address (the panel runs with TRUST_PROXY, so sign-in rate
 * limits are per client, as they would be for real visitors), sign-in through
 * the one-time code, and the panel's log, where verification links land.
 */

import fs from 'node:fs';
import assert from 'node:assert/strict';

export const BASE = process.env.TEST_BASE;
export const OWNER = { email: process.env.TEST_OWNER_EMAIL, password: process.env.TEST_OWNER_PASSWORD };
export const OTP = '123456';
export const SSH = process.env.TEST_SSH_HOST ? { host: process.env.TEST_SSH_HOST, port: Number(process.env.TEST_SSH_PORT) } : null;

if (!BASE) throw new Error('Run the suite with `npm test` — it starts the panel these tests talk to.');

let ipCounter = 0;
const nextIp = () => { ipCounter += 1; return `203.0.113.${(process.pid * 7 + ipCounter) % 250 + 1}`; };

/** A short unique suffix, so test files never collide on names or emails. */
export const uid = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

/** A distinct valid Indian mobile number per call. */
let phoneCounter = 0;
export const phone = () => { phoneCounter += 1; return `+9198${String(process.pid % 1000).padStart(3, '0')}${String(phoneCounter).padStart(5, '0')}`; };

export class Client {
  constructor({ ip = nextIp(), origin = null } = {}) {
    this.ip = ip;
    this.origin = origin;
    this.cookie = '';
    this.user = null;
  }

  async raw(method, path, { body, headers = {}, redirect = 'manual' } = {}) {
    const res = await fetch(`${BASE}${path}`, {
      method, redirect,
      headers: {
        'x-forwarded-for': this.ip,
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(this.origin ? { origin: this.origin } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.getSetCookie?.() || [];
    for (const c of set) {
      const [pair] = c.split(';');
      if (pair.startsWith('ad_session=')) this.cookie = pair.endsWith('=') ? '' : pair;
    }
    return res;
  }

  /** JSON call: { status, body }. */
  async call(method, path, body) {
    const res = await this.raw(method, path, { body });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    return { status: res.status, body: json, headers: res.headers };
  }

  get(p) { return this.call('GET', p); }
  post(p, b = {}) { return this.call('POST', p, b); }
  put(p, b = {}) { return this.call('PUT', p, b); }
  del(p, b) { return this.call('DELETE', p, b); }

  /** Email and password. Throws with the panel's message when it fails. */
  async login(login, password) {
    const r = await this.post('/api/auth/login', { login, password });
    if (r.status !== 200) throw Object.assign(new Error(r.body?.error || `login ${r.status}`), { res: r });
    this.user = r.body.user;
    return this;
  }

  /** Mobile number, then the one-time code. */
  async loginWithOtp(phoneNumber) {
    const first = await this.post('/api/auth/login/otp', { phone: phoneNumber });
    if (first.status !== 200) throw Object.assign(new Error(first.body?.error || `otp start ${first.status}`), { res: first });
    const second = await this.post('/api/auth/login/verify', { challenge: first.body.challenge, otp: OTP });
    if (second.status !== 200) throw Object.assign(new Error(second.body?.error || `otp ${second.status}`), { res: second });
    this.user = second.body.user;
    return this;
  }
}

export async function owner() {
  return new Client().login(OWNER.email, OWNER.password);
}

/** Expect a status, showing the body when it is wrong. */
export function expectStatus(res, status, what = '') {
  assert.equal(res.status, status, `${what} → expected ${status}, got ${res.status}: ${JSON.stringify(res.body).slice(0, 400)}`);
  return res.body;
}

/** The newest email-verification link the panel wrote to its log for this address. */
export function verificationLink(email) {
  const text = fs.readFileSync(process.env.TEST_LOG, 'utf8');
  const blocks = text.split(/\n(?=\[mail\]|\[mailer\]|To:|\s*to:)/i);
  const mine = blocks.filter((b) => b.includes(email));
  const hay = (mine.length ? mine : [text]).join('\n');
  const all = [...hay.matchAll(/\/verify-email\?token=([A-Za-z0-9_%.-]+)/g)];
  return all.length ? `/verify-email?token=${all[all.length - 1][1]}` : null;
}

let sharedPlans = null;

/**
 * Plans every file can use: a free trial, a small paid plan with tight limits
 * and a roomy one. Made once per run by the super admin (409 means another
 * file already made them).
 */
export async function plans(admin) {
  if (sharedPlans) return sharedPlans;
  const want = [
    { name: 'Test Free', price_monthly: 0, price_yearly: 0, limits: { servers: 1, apps: 1, users: 3 }, sort_order: 1 },
    { name: 'Test Starter', price_monthly: 499, price_yearly: 4990, limits: { servers: 1, apps: 2, users: 3, databases: 1, domains: 1 }, sort_order: 2 },
    { name: 'Test Pro', price_monthly: 1999, price_yearly: 19990, limits: { servers: 20, apps: 50, users: 20, databases: 20, domains: 20 }, sort_order: 3, highlighted: true },
  ];
  const list = (await admin.get('/api/platform/plans')).body;
  const existing = Array.isArray(list) ? list : list?.plans || [];
  const out = {};
  for (const p of want) {
    let plan = existing.find((x) => x.name === p.name);
    if (!plan) {
      const r = await admin.post('/api/platform/plans', { ...p, currency: 'INR', is_public: true });
      if (r.status === 409) plan = ((await admin.get('/api/platform/plans')).body.plans || []).find((x) => x.name === p.name);
      else plan = expectStatus(r, 201, `create plan ${p.name}`);
    }
    out[p.name.split(' ')[1].toLowerCase()] = plan;
  }
  sharedPlans = out;
  return out;
}

/**
 * A client organisation with its own admin, on a plan: { org, admin (signed-in
 * Client), email, password }.
 */
export async function organisation(admin, { plan, name = `Org ${uid()}` } = {}) {
  const email = `admin.${uid()}@test.local`;
  const password = 'Admin-Pass-12345';
  const r = await admin.post('/api/platform/organisations', {
    name, admin_email: email, admin_password: password, admin_name: 'Org Admin', admin_phone: phone(),
    plan_id: plan?.id, cycle: 'monthly',
  });
  const { id } = expectStatus(r, 201, `create organisation ${name}`);
  const client = await new Client().login(email, password);
  return { id, name, admin: client, email, password };
}

/** Add a member with a role to the signed-in admin's organisation and sign them in. */
export async function member(orgAdmin, role) {
  const email = `${role}.${uid()}@test.local`;
  const password = 'Member-Pass-12345';
  expectStatus(await orgAdmin.post('/api/team/members', { email, name: `${role} person`, role, password, phone: phone() }), 201, `add ${role}`);
  return new Client().login(email, password);
}
