// Plans, the free trial, Razorpay checkout and webhook, payment history, plan limits.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Client, expectStatus, owner, plans, organisation, member, uid, phone } from './helpers.mjs';

const RAZORPAY = process.env.TEST_RAZORPAY === '1';
const SECRET = process.env.TEST_WEBHOOK_SECRET;

/** Send a Razorpay-style webhook, signed (or not) like Razorpay does. */
async function webhook(event, { sign = true } = {}) {
  const raw = JSON.stringify(event);
  const sig = sign ? crypto.createHmac('sha256', SECRET).update(raw).digest('hex') : 'bad';
  const res = await fetch(`${process.env.TEST_BASE}/api/hooks/razorpay`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': sig }, body: raw,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const captured = (orderId, amount, id = `pay_${uid()}`) => ({
  event: 'payment.captured',
  payload: { payment: { entity: { id, order_id: orderId, status: 'captured', amount, currency: 'INR', method: 'upi' } } },
});

describe('billing', () => {
  let boss;
  let p;
  before(async () => { boss = await owner(); p = await plans(boss); });

  describe('an organisation with no plan', () => {
    let org;
    before(async () => { org = await organisation(boss, {}); });

    it('is locked out of everything but billing', async () => {
      const r = await org.admin.get('/api/servers');
      assert.equal(r.status, 402);
      assert.equal(r.body.needsPlan, true);
      const b = expectStatus(await org.admin.get('/api/billing'), 200);
      assert.equal(b.active, false);
      assert.equal(b.canChoose, true);
      assert.ok(b.plans.some((x) => x.id === p.pro.id));
      assert.deepEqual(b.payments, []);
    });

    it('starts the free trial once, and only once', async () => {
      const r = expectStatus(await org.admin.post('/api/billing/choose', { plan_id: p.free.id }), 200);
      assert.equal(r.activated, true);
      const b = expectStatus(await org.admin.get('/api/billing'), 200);
      assert.equal(b.active, true);
      assert.equal(b.freeTrialUsed, true);
      assert.equal(b.trial.totalDays, 30);
      assert.equal((await org.admin.get('/api/servers')).status, 200);
      const again = await org.admin.post('/api/billing/choose', { plan_id: p.free.id });
      assert.equal(again.status, 400);
    });

    it('refuses an unknown plan', async () => {
      assert.equal((await org.admin.post('/api/billing/choose', { plan_id: 999999 })).status, 400);
    });
  });

  describe('paying with Razorpay', { skip: !RAZORPAY && 'Razorpay keys not set in .env' }, () => {
    let org;
    let order;
    before(async () => { org = await organisation(boss, { plan: p.free }); });

    it('a paid plan must be paid for first', async () => {
      const r = await org.admin.post('/api/billing/choose', { plan_id: p.starter.id, cycle: 'monthly' });
      assert.equal(r.status, 402);
      assert.equal(r.body.payFirst, true);
    });

    it('only an admin may pay', async () => {
      const ed = await member(org.admin, 'editor');
      assert.equal((await ed.post('/api/billing/checkout', { plan_id: p.starter.id })).status, 403);
    });

    it('opens a Razorpay order for the exact price', async () => {
      const r = expectStatus(await org.admin.post('/api/billing/checkout', { plan_id: p.starter.id, cycle: 'monthly' }), 200);
      order = r.checkout;
      assert.match(order.orderId, /^order_/);
      assert.equal(order.amount, 49900, '₹499 in paise');
      assert.equal(order.currency, 'INR');
      assert.match(order.keyId, /^rzp_test_/);
      const yearly = expectStatus(await org.admin.post('/api/billing/checkout', { plan_id: p.starter.id, cycle: 'yearly' }), 200);
      assert.equal(yearly.checkout.amount, 499000);
    });

    it('refuses a checkout answer that is incomplete or forged', async () => {
      assert.equal((await org.admin.post('/api/billing/checkout/verify', {})).status, 400);
      const forged = await org.admin.post('/api/billing/checkout/verify', {
        razorpay_order_id: order.orderId, razorpay_payment_id: `pay_${uid()}`, razorpay_signature: 'f'.repeat(64),
      });
      assert.equal(forged.status, 400);
      assert.match(forged.body.error, /could not be verified/);
      const b = expectStatus(await org.admin.get('/api/billing'), 200);
      assert.equal(b.subscription.planId, p.free.id, 'the plan did not change');
    });

    it('another organisation cannot verify this order', async () => {
      const other = await organisation(boss, { plan: p.free });
      const r = await other.admin.post('/api/billing/checkout/verify', {
        razorpay_order_id: order.orderId, razorpay_payment_id: `pay_${uid()}`, razorpay_signature: 'x',
      });
      assert.equal(r.status, 404);
    });

    it('records a failed attempt in the payment history', async () => {
      const r = expectStatus(await org.admin.post('/api/billing/checkout', { plan_id: p.starter.id, cycle: 'monthly' }), 200);
      expectStatus(await org.admin.post('/api/billing/checkout/failed', { razorpay_order_id: r.checkout.orderId, reason: 'Card declined' }), 200);
      const hist = expectStatus(await org.admin.get('/api/billing'), 200).payments;
      const row = hist.find((x) => x.reference === r.checkout.orderId);
      assert.equal(row?.status, 'failed');
      assert.equal(row?.error, 'Card declined');
    });

    it('rejects a webhook with a bad signature', async () => {
      const r = await webhook(captured(order.orderId, 49900), { sign: false });
      assert.equal(r.status, 401);
    });

    it('ignores a webhook whose amount does not match', async () => {
      const r = await webhook(captured(order.orderId, 100));
      assert.equal(r.status, 200);
      assert.equal(r.body.mismatch, true);
      const b = expectStatus(await org.admin.get('/api/billing'), 200);
      assert.equal(b.subscription.planId, p.free.id);
    });

    it('a captured payment switches the plan on, exactly once', async () => {
      const payId = `pay_${uid()}`;
      const first = await webhook(captured(order.orderId, 49900, payId));
      assert.equal(first.status, 200, JSON.stringify(first.body));
      const second = await webhook(captured(order.orderId, 49900, payId));
      assert.equal(second.status, 200);
      assert.equal(second.body.alreadyDone, true, 'the second delivery changes nothing');

      const b = expectStatus(await org.admin.get('/api/billing'), 200);
      assert.equal(b.subscription.planId, p.starter.id);
      assert.equal(b.subscription.status, 'active');
      assert.equal(b.subscription.amount, 499);
      const paid = b.payments.filter((x) => x.status === 'paid');
      assert.equal(paid.length, 1, 'one payment, not two');
      assert.equal(paid[0].method, 'razorpay/upi');
      assert.equal(paid[0].reference, payId);
      assert.equal(paid[0].plan, 'Test Starter');
    });

    it('the payment shows in the organisation\'s own activity log', async () => {
      const log = JSON.stringify(expectStatus(await org.admin.get('/api/activity'), 200));
      assert.match(log, /paid INR 499 with Razorpay/);
    });

    it('the super admin sees the online payment too', async () => {
      const all = expectStatus(await boss.get('/api/platform/payments'), 200);
      assert.ok(all.payments.some((x) => x.orgId === org.id && x.amount === 499));
    });

    it('a webhook for an unknown order is ignored', async () => {
      const r = await webhook(captured('order_doesnotexist', 49900));
      assert.equal(r.status, 200);
      assert.equal(r.body.ignored, true);
    });
  });

  describe('paid plans without online payment', () => {
    it('the recheck endpoint answers even with nothing to find', async () => {
      const org = await organisation(boss, { plan: p.free });
      const r = expectStatus(await org.admin.post('/api/billing/checkout/recheck'), 200);
      assert.ok(Array.isArray(r.recovered));
    });
  });

  describe('plan limits', () => {
    it('refuses one more team member than the plan allows', async () => {
      const org = await organisation(boss, { plan: p.starter }); // users: 3 (the admin is one)
      await member(org.admin, 'viewer');
      await member(org.admin, 'viewer');
      const r = await org.admin.post('/api/team/members', { email: `over.${uid()}@test.local`, name: 'Over', role: 'viewer', password: 'Member-Pass-12345', phone: phone() });
      // 403 with limitReached (not 402): the browser shows the message rather than jumping to billing.
      assert.equal(r.status, 403, JSON.stringify(r.body));
      assert.equal(r.body.limitReached, true);
      assert.equal(r.body.limit, 'users');
    });

    it('the usage shows on the billing page', async () => {
      const org = await organisation(boss, { plan: p.starter });
      const b = expectStatus(await org.admin.get('/api/billing'), 200);
      assert.equal(b.usage.users, 1);
      assert.equal(b.limits.users, 3);
    });
  });

  describe('withdrawing a request', () => {
    it('has nothing to withdraw when nothing was asked for', async () => {
      const org = await organisation(boss, { plan: p.free });
      expectStatus(await org.admin.del('/api/billing/request'), 400, 'withdraw with no request');
    });
  });
});
