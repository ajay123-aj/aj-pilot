// The super admin's platform console: plans, organisations, subscriptions, payments, leads, users.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { Client, expectStatus, owner, plans, organisation, uid, phone } from './helpers.mjs';

describe('platform console', () => {
  let boss;
  let p;
  before(async () => { boss = await owner(); p = await plans(boss); });

  describe('plans', () => {
    it('validates a plan', async () => {
      const bad = [
        [{ name: '' }, /name/],
        [{ name: 'X', price_monthly: -1, price_yearly: 0 }, /monthly/],
        [{ name: 'X', price_monthly: 1, price_yearly: 'abc' }, /yearly/],
        [{ name: 'X', price_monthly: 1, price_yearly: 1, currency: 'RUPEES' }, /currency/],
        [{ name: 'X', price_monthly: 1, price_yearly: 1, limits: { servers: 1.5 } }, /servers limit/],
      ];
      for (const [body, msg] of bad) {
        const r = await boss.post('/api/platform/plans', body);
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.match(r.body.error, msg);
      }
    });

    it('refuses a duplicate plan name', async () => {
      const r = await boss.post('/api/platform/plans', { name: 'Test Pro', price_monthly: 1, price_yearly: 1 });
      assert.equal(r.status, 409);
    });

    it('creates, edits and archives a plan; archived plans leave the public list', async () => {
      const name = `Temp ${uid()}`;
      const made = expectStatus(await boss.post('/api/platform/plans', { name, price_monthly: 10, price_yearly: 100, is_public: true, features: 'One\nTwo' }), 201);
      assert.deepEqual(made.features, ['One', 'Two']);
      const edited = expectStatus(await boss.put(`/api/platform/plans/${made.id}`, { name, price_monthly: 20, price_yearly: 200, is_public: true }), 200);
      assert.equal(edited.priceMonthly, 20);
      expectStatus(await boss.put(`/api/platform/plans/${made.id}`, { name, price_monthly: 20, price_yearly: 200, is_public: true, status: 'archived' }), 200);
      const pub = expectStatus(await new Client().get('/api/public/plans'), 200);
      assert.ok(!pub.plans.some((x) => x.id === made.id), 'archived plan is not public');
    });

    it('lists the plans with subscriber counts', async () => {
      const list = expectStatus(await boss.get('/api/platform/plans'), 200);
      assert.ok(list.plans.find((x) => x.id === p.pro.id));
      assert.ok(Array.isArray(list.limitKeys));
    });
  });

  describe('organisations', () => {
    let org;
    before(async () => { org = await organisation(boss, { plan: p.pro }); });

    it('validates a new organisation', async () => {
      assert.equal((await boss.post('/api/platform/organisations', {})).status, 400);
      assert.equal((await boss.post('/api/platform/organisations', { name: org.name })).status, 409, 'duplicate name');
      assert.equal((await boss.post('/api/platform/organisations', { name: `X ${uid()}`, admin_email: org.email, admin_password: 'Admin-Pass-12345', admin_phone: phone() })).status, 409, 'email taken');
      assert.equal((await boss.post('/api/platform/organisations', { name: `X ${uid()}`, admin_email: `a.${uid()}@test.local`, admin_password: 'weak', admin_phone: phone() })).status, 400, 'weak password');
      assert.equal((await boss.post('/api/platform/organisations', { name: `X ${uid()}`, plan_id: 999999 })).status, 400, 'unknown plan');
    });

    it('shows an organisation with its subscription', async () => {
      const d = expectStatus(await boss.get(`/api/platform/organisations/${org.id}`), 200);
      assert.equal(JSON.stringify(d).includes(org.name), true);
      assert.equal((await boss.get('/api/platform/organisations/999999')).status, 404);
    });

    it('changes the plan, expires it, extends it and clears it', async () => {
      expectStatus(await boss.put(`/api/platform/organisations/${org.id}/subscription`, { plan_id: p.starter.id, cycle: 'monthly', status: 'active' }), 200);
      let b = expectStatus(await org.admin.get('/api/billing'), 200);
      assert.equal(b.subscription.planId, p.starter.id);

      expectStatus(await boss.put(`/api/platform/organisations/${org.id}/subscription/expiry`, { action: 'now' }), 200);
      b = expectStatus(await org.admin.get('/api/billing'), 200);
      assert.equal(b.trial?.expired, true, 'expired plan');
      const locked = await org.admin.get('/api/servers');
      assert.equal(locked.status, 402, 'an expired plan locks the panel');
      assert.equal(locked.body.needsPlan, true);

      expectStatus(await boss.put(`/api/platform/organisations/${org.id}/subscription/expiry`, { action: 'extend', days: 10 }), 200);
      assert.equal((await org.admin.get('/api/servers')).status, 200, 'extended plan unlocks');
      assert.equal((await boss.put(`/api/platform/organisations/${org.id}/subscription/expiry`, { action: 'extend', days: 0 })).status, 400);
      assert.equal((await boss.put(`/api/platform/organisations/${org.id}/subscription/expiry`, { action: 'bogus' })).status, 400);
      expectStatus(await boss.put(`/api/platform/organisations/${org.id}/subscription/expiry`, { action: 'clear' }), 200);
      expectStatus(await boss.put(`/api/platform/organisations/${org.id}/subscription`, { plan_id: p.pro.id, cycle: 'monthly', status: 'active' }), 200);
    });

    it('suspends and reactivates an organisation', async () => {
      expectStatus(await boss.put(`/api/platform/organisations/${org.id}`, { status: 'suspended' }), 200);
      const r = await org.admin.get('/api/servers');
      assert.equal(r.status, 403);
      assert.equal(r.body.suspended, true);
      expectStatus(await boss.put(`/api/platform/organisations/${org.id}`, { status: 'active' }), 200);
      assert.equal((await org.admin.get('/api/servers')).status, 200);
    });

    it('records and deletes a payment; the client sees it in its history', async () => {
      assert.equal((await boss.post(`/api/platform/organisations/${org.id}/payments`, { amount: 0 })).status, 400);
      assert.equal((await boss.post(`/api/platform/organisations/${org.id}/payments`, { amount: 10, paid_at: 'not a date' })).status, 400);
      const ref = `REF-${uid()}`;
      expectStatus(await boss.post(`/api/platform/organisations/${org.id}/payments`, { amount: 1999, method: 'Bank transfer', reference: ref }), 201);
      const all = expectStatus(await boss.get('/api/platform/payments'), 200);
      const pay = all.payments.find((x) => x.reference === ref);
      assert.ok(pay);
      const hist = expectStatus(await org.admin.get('/api/billing'), 200).payments;
      assert.ok(hist.some((x) => x.reference === ref && x.status === 'paid' && x.amount === 1999), 'client payment history');
      expectStatus(await boss.del(`/api/platform/payments/${pay.id}`), 200);
      assert.equal((await boss.del(`/api/platform/payments/${pay.id}`)).status, 404);
    });

    it('opens an organisation and goes back to the platform', async () => {
      const inside = expectStatus(await boss.post('/api/auth/organisation', { org_id: org.id }), 200);
      assert.equal(inside.user.orgId, org.id);
      expectStatus(await boss.get('/api/servers'), 200);
      const out = expectStatus(await boss.post('/api/auth/organisation', { org_id: null }), 200);
      assert.equal(out.user.orgId, null);
    });

    it('shows a dashboard, users and admins', async () => {
      expectStatus(await boss.get('/api/platform/dashboard'), 200);
      expectStatus(await boss.get('/api/platform/users'), 200);
      expectStatus(await boss.get('/api/platform/admins'), 200);
      expectStatus(await boss.get('/api/platform/organisations'), 200);
    });

    it('is closed to everyone but the super admin', async () => {
      for (const path of ['/api/platform/organisations', '/api/platform/plans', '/api/platform/payments', '/api/platform/leads', '/api/platform/dashboard']) {
        assert.equal((await org.admin.get(path)).status, 403, path);
      }
      assert.equal((await org.admin.post('/api/platform/plans', { name: 'Hack', price_monthly: 0, price_yearly: 0 })).status, 403);
    });
  });

  describe('leads', () => {
    it('lists, updates, notes and converts a lead into a client', async () => {
      const email = `lead.${uid()}@test.local`;
      expectStatus(await new Client().post('/api/public/leads', { name: 'Converting Lead', email, phone: phone(), company: `Lead Co ${uid()}` }), 201);
      const list = expectStatus(await boss.get('/api/platform/leads'), 200);
      const lead = list.leads.find((l) => l.email === email);
      assert.ok(lead, 'lead listed');
      expectStatus(await boss.put(`/api/platform/leads/${lead.id}`, { status: 'qualified' }), 200);
      expectStatus(await boss.post(`/api/platform/leads/${lead.id}/notes`, { body: 'Called them' }), 201);
      const d = expectStatus(await boss.get(`/api/platform/leads/${lead.id}`), 200);
      assert.ok(JSON.stringify(d).includes('Called them'));
      const conv = expectStatus(await boss.post(`/api/platform/leads/${lead.id}/convert`, { admin_password: 'Lead-Admin-12345', plan_id: p.pro.id }), 201);
      assert.ok(conv.orgId);
      assert.equal((await boss.post(`/api/platform/leads/${lead.id}/convert`, {})).status, 400, 'already a client');
      await new Client().login(email, 'Lead-Admin-12345');
      expectStatus(await boss.get('/api/platform/leads/analytics'), 200);
      expectStatus(await boss.get('/api/platform/leads/summary'), 200);
    });
  });
});
