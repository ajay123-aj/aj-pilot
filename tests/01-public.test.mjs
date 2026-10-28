// The public site: landing page, docs, SEO files, security headers, the lead form, CSRF.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client, BASE, expectStatus, uid } from './helpers.mjs';

describe('public site', () => {
  const visitor = new Client();

  it('serves the landing page with security headers', async () => {
    const res = await visitor.raw('GET', '/');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /AJ Pilot/);
    const csp = res.headers.get('content-security-policy');
    assert.ok(csp, 'CSP header');
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-powered-by'), null, 'no x-powered-by');
  });

  for (const path of ['/docs', '/terms', '/robots.txt', '/sitemap.xml', '/app.js', '/styles.css', '/favicon.svg']) {
    it(`serves ${path}`, async () => {
      const res = await visitor.raw('GET', path);
      assert.equal(res.status, 200, path);
    });
  }

  it('serves the terminal library from the panel itself', async () => {
    for (const p of ['/vendor/xterm/lib/xterm.js', '/vendor/xterm/css/xterm.css', '/vendor/addon-fit/lib/addon-fit.js']) {
      assert.equal((await visitor.raw('GET', p)).status, 200, p);
    }
  });

  it('redirects an unknown guide back to /docs', async () => {
    const res = await visitor.raw('GET', '/docs/no-such-guide');
    assert.equal(res.status, 302);
  });

  it('answers /api/health without a session', async () => {
    const r = await visitor.get('/api/health');
    assert.deepEqual(expectStatus(r, 200), { ok: true, signedIn: false });
  });

  it('lists public plans and docs', async () => {
    const p = expectStatus(await visitor.get('/api/public/plans'), 200);
    assert.ok(Array.isArray(p.plans));
    assert.equal(typeof p.trialDays, 'number');
    const d = expectStatus(await visitor.get('/api/public/docs'), 200);
    assert.ok(Array.isArray(d.docs) && d.docs.length > 0);
  });

  it('refuses signed-in API routes without a session', async () => {
    for (const p of ['/api/servers', '/api/apps', '/api/billing', '/api/team/members', '/api/platform/organisations', '/api/activity']) {
      const r = await visitor.get(p);
      assert.equal(r.status, 401, p);
      assert.equal(r.body.needsAuth, true, p);
    }
  });

  it('refuses a cross-site POST (CSRF)', async () => {
    const evil = new Client({ origin: 'https://evil.example' });
    const r = await evil.post('/api/auth/login', { login: 'x@y.z', password: 'whatever' });
    assert.equal(r.status, 403);
    const fetchSite = await new Client().raw('POST', '/api/auth/login', { body: { login: 'a@b.c', password: 'x' }, headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(fetchSite.status, 403);
  });
});

describe('lead form', () => {
  it('accepts a valid lead', async () => {
    const r = await new Client().post('/api/public/leads', {
      name: 'Lead Person', email: `lead.${uid()}@test.local`, phone: '+919876500001', company: 'Lead Co', message: 'Hello',
      utm_source: 'test-suite',
    });
    assert.ok([200, 201].includes(r.status), JSON.stringify(r.body));
  });

  it('rejects a lead with no contact details', async () => {
    const r = await new Client().post('/api/public/leads', { name: 'No Contact' });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });

  it('quietly drops bots that fill the hidden field', async () => {
    const email = `bot.${uid()}@test.local`;
    const r = await new Client().post('/api/public/leads', { name: 'Bot', email, hp_check: 'http://spam.example' });
    assert.equal(r.status, 201, 'bots get a normal-looking answer');
    const { owner } = await import('./helpers.mjs');
    const leads = expectStatus(await (await owner()).get('/api/platform/leads'), 200);
    assert.ok(!(leads.leads || []).some((l) => l.email === email), 'the bot submission is not stored');
  });

  it('rate-limits one address to 5 leads per 15 minutes', async () => {
    const c = new Client();
    const codes = [];
    for (let i = 0; i < 6; i += 1) {
      codes.push((await c.post('/api/public/leads', { name: 'Repeat', email: `rep.${uid()}@test.local`, phone: '+919876500002' })).status);
    }
    assert.equal(codes[5], 429, `statuses: ${codes}`);
  });

  it('serves the base url the suite was started with', () => {
    assert.match(BASE, /^http:\/\/127\.0\.0\.1:\d+$/);
  });
});
