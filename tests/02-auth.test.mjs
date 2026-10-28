// Sign-in (email + password, or mobile + code), sign-up with "verify later",
// email verification, sessions, profile and password.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { Client, OWNER, OTP, expectStatus, verificationLink, uid, phone, owner, plans, organisation, member } from './helpers.mjs';

describe('sign-in with email and password', () => {
  it('reports the state before sign-in', async () => {
    const s = expectStatus(await new Client().get('/api/auth/state'), 200);
    assert.equal(s.user, null);
    assert.equal(s.needsSetup, false, 'the super admin from .env exists');
    assert.equal(s.signupOpen, true);
    assert.equal(s.otpLogin, true, 'the test panel runs with OTP_LOGIN=on');
  });

  it('signs straight in — no code step', async () => {
    const c = new Client();
    const r = expectStatus(await c.post('/api/auth/login', { login: OWNER.email, password: OWNER.password }), 200);
    assert.equal(r.user.role, 'super_admin');
    assert.equal(r.challenge, undefined, 'no one-time code');
    assert.ok(c.cookie.startsWith('ad_session='));
    expectStatus(await c.get('/api/platform/dashboard'), 200);
  });

  it('refuses a wrong password with the same answer as an unknown account', async () => {
    const a = await new Client().post('/api/auth/login', { login: OWNER.email, password: 'Wrong-Pass-999' });
    const b = await new Client().post('/api/auth/login', { login: `nobody.${uid()}@test.local`, password: 'Wrong-Pass-999' });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.equal(a.body.error, b.body.error);
  });

  it('validates the fields', async () => {
    assert.equal((await new Client().post('/api/auth/login', { login: '', password: 'x' })).status, 400);
    assert.equal((await new Client().post('/api/auth/login', { login: 'not-an-email@', password: 'x' })).status, 400);
    assert.equal((await new Client().post('/api/auth/login', { login: OWNER.email })).status, 400);
  });

  it('rate-limits repeated failures for one account', async () => {
    const email = `target.${uid()}@test.local`;
    let last;
    for (let i = 0; i < 9; i += 1) last = await new Client().post('/api/auth/login', { login: email, password: 'Wrong-Pass-999' });
    assert.equal(last.status, 429);
  });

  it('signs out and the session stops working', async () => {
    const c = await owner();
    const cookie = c.cookie;
    expectStatus(await c.post('/api/auth/logout'), 200);
    const stale = new Client();
    stale.cookie = cookie;
    assert.equal((await stale.get('/api/platform/dashboard')).status, 401);
  });
});

describe('sign-in with mobile and code', () => {
  let boss;
  let org;
  let adminPhone;
  before(async () => {
    boss = await owner();
    adminPhone = phone();
    const email = `otp.${uid()}@test.local`;
    const r = await boss.post('/api/platform/organisations', {
      name: `OTP Org ${uid()}`, admin_email: email, admin_password: 'Admin-Pass-12345', admin_phone: adminPhone,
      plan_id: (await plans(boss)).pro.id,
    });
    org = { id: expectStatus(r, 201).id, email };
  });

  it('sends a code and signs in with it', async () => {
    const c = new Client();
    const first = expectStatus(await c.post('/api/auth/login/otp', { phone: adminPhone }), 200);
    assert.equal(first.otpRequired, true);
    assert.equal(first.channel, 'sms');
    assert.match(first.sentTo, /•/, 'the number is masked');
    assert.equal(c.cookie, '', 'no session before the code');
    const wrong = await c.post('/api/auth/login/verify', { challenge: first.challenge, otp: '000000' });
    assert.equal(wrong.status, 400);
    const ok = expectStatus(await c.post('/api/auth/login/verify', { challenge: first.challenge, otp: OTP }), 200);
    assert.equal(ok.user.email, org.email);
    expectStatus(await c.get('/api/servers'), 200);
  });

  it('accepts the number with or without the country code', async () => {
    const local = adminPhone.replace(/^\+91/, '');
    const c = await new Client().loginWithOtp(local);
    assert.equal(c.user.email, org.email);
  });

  it('answers the same for a number with no account, then says so only after the code', async () => {
    const c = new Client();
    const first = expectStatus(await c.post('/api/auth/login/otp', { phone: phone() }), 200);
    assert.equal(first.otpRequired, true, 'looks like any other number');
    const r = await c.post('/api/auth/login/verify', { challenge: first.challenge, otp: OTP });
    assert.equal(r.status, 404);
    assert.equal(r.body.restart, true);
  });

  it('a number on two accounts must sign in with email', async () => {
    const orgAdmin = await new Client().login(org.email, 'Admin-Pass-12345');
    const shared = phone();
    for (const role of ['viewer', 'editor']) {
      expectStatus(await orgAdmin.post('/api/team/members', {
        email: `${role}.${uid()}@test.local`, name: role, role, password: 'Member-Pass-12345', phone: shared,
      }), 201);
    }
    const c = new Client();
    const first = expectStatus(await c.post('/api/auth/login/otp', { phone: shared }), 200);
    const r = await c.post('/api/auth/login/verify', { challenge: first.challenge, otp: OTP });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /more than one account/);
  });

  it('a disabled account cannot sign in with a code', async () => {
    const orgAdmin = await new Client().login(org.email, 'Admin-Pass-12345');
    const who = await member(orgAdmin, 'viewer');
    const list = expectStatus(await orgAdmin.get('/api/team/members'), 200);
    const row = (list.members || list).find((m) => m.email === who.user.email);
    expectStatus(await orgAdmin.put(`/api/team/members/${row.id}`, { status: 'disabled' }), 200);
    const c = new Client();
    const first = expectStatus(await c.post('/api/auth/login/otp', { phone: row.phone }), 200);
    const r = await c.post('/api/auth/login/verify', { challenge: first.challenge, otp: OTP });
    assert.ok(r.status >= 400, JSON.stringify(r.body));
    assert.equal(c.cookie, '');
  });

  it('validates the number', async () => {
    const r = await new Client().post('/api/auth/login/otp', { phone: '12' });
    assert.equal(r.status, 400);
    assert.equal(r.body.field, 'phone');
  });

  it('restarts after five wrong codes', async () => {
    const c = new Client();
    const first = expectStatus(await c.post('/api/auth/login/otp', { phone: adminPhone }), 200);
    let last;
    for (let i = 0; i < 5; i += 1) last = await c.post('/api/auth/login/verify', { challenge: first.challenge, otp: '999999' });
    assert.equal(last.status, 429);
    assert.equal(last.body.restart, true);
    const after = await c.post('/api/auth/login/verify', { challenge: first.challenge, otp: OTP });
    assert.ok(after.status >= 400, 'the used-up challenge cannot be finished with the right code');
  });

  it('limits codes per number', async () => {
    const target = phone();
    let last;
    for (let i = 0; i < 6; i += 1) last = await new Client().post('/api/auth/login/otp', { phone: target });
    assert.equal(last.status, 429);
  });

  it('is off by default with a fixed test code, on with random codes, and OTP_LOGIN decides', () => {
    const check = (env) => {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e',
        "const { config } = await import('./src/config.js'); process.stdout.write(String(config.otp.login));"], {
        encoding: 'utf8',
        env: { ...process.env, DATA_DIR: path.join(os.tmpdir(), 'ajp-config-test'), APP_ENCRYPTION_KEY: 'x', OTP_LOGIN: '', OTP_MODE: '', ...env },
      });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    assert.equal(check({ OTP_MODE: 'fixed' }), 'false', 'fixed code: anyone could type 123456');
    assert.equal(check({ OTP_MODE: 'random' }), 'true');
    assert.equal(check({ OTP_MODE: 'fixed', OTP_LOGIN: 'on' }), 'true');
    assert.equal(check({ OTP_MODE: 'random', OTP_LOGIN: 'off' }), 'false');
  });
});

describe('sign-up and "verify later"', () => {
  let p;
  before(async () => { p = await plans(await owner()); });

  const form = (over = {}) => ({
    name: 'New Person', email: `new.${uid()}@test.local`, phone: phone(), password: 'Signup-Pass-123',
    company: `Signup Co ${uid()}`, terms: true, cycle: 'monthly', ...over,
  });

  /** Sign up through the code; returns the signed-in client and what the panel answered. */
  async function signUp(over) {
    const c = new Client();
    const f = form(over);
    const start = expectStatus(await c.post('/api/auth/signup', f), 200, 'signup');
    const done = expectStatus(await c.post('/api/auth/signup/verify', { challenge: start.challenge, otp: OTP }), 201, 'signup verify');
    return { c, f, done };
  }

  it('validates every field', async () => {
    const cases = [
      [{ name: '' }, 'name'], [{ email: 'bad' }, 'email'], [{ phone: '12' }, 'phone'],
      [{ password: 'short' }, 'password'], [{ terms: false }, 'terms'], [{ plan_id: 999999 }, 'plan'],
    ];
    for (const [over, field] of cases) {
      // Sign-ups are limited per network, so each case comes from its own address.
      const r = await new Client().post('/api/auth/signup', form(over));
      assert.equal(r.status, 400, `${field}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.field, field);
    }
  });

  it('refuses an email that already has an account', async () => {
    const r = await new Client().post('/api/auth/signup', form({ email: OWNER.email }));
    assert.equal(r.status, 409);
    assert.equal(r.body.signIn, true);
  });

  it('signs straight in after the mobile code; the email can wait', async () => {
    const { c, f, done } = await signUp({ plan_id: p.free.id });
    assert.equal(done.verifyEmail, true);
    assert.equal(done.user.emailVerified, false);
    assert.ok(c.cookie.startsWith('ad_session='), 'signed in by the sign-up itself');
    const b = expectStatus(await c.get('/api/billing'), 200);
    assert.equal(b.active, true, 'the free plan is on');
    assert.equal(b.subscription.planId, p.free.id);

    // "Verify later": signing in again also works before the email is verified.
    const again = await new Client().login(f.email, f.password);
    assert.equal(again.user.emailVerified, false);
    const state = expectStatus(await again.get('/api/auth/state'), 200);
    assert.equal(state.user.emailVerified, false, 'the panel shows the reminder');
  });

  it('a paid plan picked at sign-up waits for payment, signed in', async () => {
    const { c } = await signUp({ plan_id: p.starter.id });
    const b = expectStatus(await c.get('/api/billing'), 200);
    assert.equal(b.pending?.planId, p.starter.id, 'the paid plan is waiting to be paid for');
    assert.equal(b.canChoose, true, 'and they may pay for it');
  });

  it('clicking the link later verifies the email, once', async () => {
    const { c, f } = await signUp({ plan_id: p.free.id });
    const link = verificationLink(f.email);
    assert.ok(link, 'a verification link was written to the panel log');
    const v = await c.raw('GET', link);
    assert.equal(v.status, 302);
    assert.match(v.headers.get('location'), /verify=verified/);
    const state = expectStatus(await c.get('/api/auth/state'), 200);
    assert.equal(state.user.emailVerified, true, 'the reminder goes away');
    const again = await new Client().raw('GET', link);
    assert.doesNotMatch(again.headers.get('location'), /verify=verified/, 'a link works once');
  });

  it('resends the link on request, without telling who has an account', async () => {
    const { c, f } = await signUp({ plan_id: p.free.id });
    const r = expectStatus(await c.post('/api/auth/verify-email/resend', { email: f.email }), 200);
    const nobody = expectStatus(await new Client().post('/api/auth/verify-email/resend', { email: `nobody.${uid()}@test.local` }), 200);
    assert.equal(r.message.replace(f.email, ''), nobody.message.replace(/nobody\.[^ ]+/, ''));
  });

  it('refuses a bad verification token', async () => {
    const r = await new Client().raw('GET', '/verify-email?token=nonsense');
    assert.equal(r.status, 302);
    assert.match(r.headers.get('location'), /verify=invalid/);
  });

  it('accounts made by an admin count as verified', async () => {
    const boss = await owner();
    const org = await organisation(boss, { plan: p.pro });
    assert.equal(org.admin.user.emailVerified, true);
  });
});

describe('profile and password', () => {
  let admin;
  let email;
  const password = 'Profile-Pass-123';

  before(async () => {
    const boss = await owner();
    email = `profile.${uid()}@test.local`;
    expectStatus(await boss.post('/api/platform/organisations', {
      name: `Profile Org ${uid()}`, admin_email: email, admin_password: password, admin_phone: phone(),
      plan_id: (await plans(boss)).pro.id,
    }), 201);
    admin = await new Client().login(email, password);
  });

  it('changes the name', async () => {
    const r = expectStatus(await admin.put('/api/auth/profile', { name: 'Renamed Admin' }), 200);
    assert.equal(r.user.name, 'Renamed Admin');
  });

  it('refuses a weak new password and a wrong current one', async () => {
    assert.equal((await admin.post('/api/auth/password', { current: password, password: 'weak' })).status, 400);
    const wrong = await admin.post('/api/auth/password', { current: 'Not-The-Pass-1', password: 'Another-Pass-456' });
    assert.equal(wrong.status, 400, JSON.stringify(wrong.body));
  });

  it('changes the password and ends other sessions', async () => {
    const other = await new Client().login(email, password);
    expectStatus(await admin.post('/api/auth/password', { current: password, password: 'Another-Pass-456' }), 200);
    assert.equal((await other.get('/api/servers')).status, 401, 'the other session ended');
    await new Client().login(email, 'Another-Pass-456');
  });
});
