// Who may do what (roles), and that organisations never see each other's things.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { Client, expectStatus, owner, plans, organisation, member, uid, phone } from './helpers.mjs';

describe('roles and tenancy', () => {
  let boss;
  let a; // organisation A with admin, editor, viewer
  let b; // organisation B
  let editor;
  let viewer;
  let envA;

  before(async () => {
    boss = await owner();
    const p = await plans(boss);
    a = await organisation(boss, { plan: p.pro });
    b = await organisation(boss, { plan: p.pro });
    editor = await member(a.admin, 'editor');
    viewer = await member(a.admin, 'viewer');
    envA = expectStatus(await a.admin.post('/api/environments', { name: `shop-${uid()}`, env: 'DB_URL=mysql://a\nAPI_KEY=secret-a' }), 201);
  });

  describe('team', () => {
    it('lists the members of the own organisation only', async () => {
      const list = expectStatus(await a.admin.get('/api/team/members'), 200);
      const emails = JSON.stringify(list);
      assert.ok(emails.includes(a.email));
      assert.ok(!emails.includes(b.email), 'no member of B');
    });

    it('validates a new member', async () => {
      assert.equal((await a.admin.post('/api/team/members', { email: 'bad', name: 'X', role: 'viewer', password: 'Member-Pass-12345' })).status, 400);
      assert.equal((await a.admin.post('/api/team/members', { email: `x.${uid()}@test.local`, name: '', role: 'viewer', password: 'Member-Pass-12345' })).status, 400);
      assert.equal((await a.admin.post('/api/team/members', { email: `x.${uid()}@test.local`, name: 'X', role: 'viewer', password: 'weak' })).status, 400);
      assert.equal((await a.admin.post('/api/team/members', { email: b.email, name: 'X', role: 'viewer', password: 'Member-Pass-12345', phone: phone() })).status, 409);
    });

    it('an admin cannot create a super admin', async () => {
      const r = await a.admin.post('/api/team/members', { email: `sa.${uid()}@test.local`, name: 'Sneaky', role: 'super_admin', password: 'Member-Pass-12345', phone: phone() });
      assert.equal(r.status, 403);
    });

    it('editors and viewers cannot manage people', async () => {
      for (const who of [editor, viewer]) {
        const r = await who.post('/api/team/members', { email: `n.${uid()}@test.local`, name: 'N', role: 'viewer', password: 'Member-Pass-12345', phone: phone() });
        assert.equal(r.status, 403);
      }
    });

    it('a role change ends that person\'s sessions', async () => {
      const temp = await member(a.admin, 'viewer');
      const list = expectStatus(await a.admin.get('/api/team/members'), 200);
      const row = (list.members || list).find((m) => m.email === temp.user.email);
      expectStatus(await a.admin.put(`/api/team/members/${row.id}`, { role: 'editor' }), 200);
      assert.equal((await temp.get('/api/servers')).status, 401);
    });

    it('an admin cannot change someone in another organisation', async () => {
      const listB = expectStatus(await b.admin.get('/api/team/members'), 200);
      const someoneB = (listB.members || listB)[0];
      const r = await a.admin.put(`/api/team/members/${someoneB.id}`, { role: 'viewer' });
      assert.equal(r.status, 404);
      assert.equal((await a.admin.del(`/api/team/members/${someoneB.id}`)).status, 404);
    });
  });

  describe('permissions by method', () => {
    it('a viewer can read but not add, change or delete', async () => {
      expectStatus(await viewer.get('/api/environments'), 200);
      expectStatus(await viewer.get('/api/servers'), 200);
      assert.equal((await viewer.post('/api/environments', { name: `v-${uid()}`, env: 'A=1' })).status, 403);
      assert.equal((await viewer.put(`/api/environments/${envA.id}`, { name: envA.name, env: 'A=2' })).status, 403);
      assert.equal((await viewer.del(`/api/environments/${envA.id}`)).status, 403);
      assert.equal((await viewer.post('/api/connectors', { name: 'nope' })).status, 403);
    });

    it('a viewer sees variable names but never values', async () => {
      const list = expectStatus(await viewer.get('/api/environments'), 200);
      assert.equal(list.canSeeValues, false);
      const one = expectStatus(await viewer.get(`/api/environments/${envA.id}`), 200);
      assert.deepEqual(one.keys.sort(), ['API_KEY', 'DB_URL']);
      assert.equal(one.env, undefined);
      assert.ok(!JSON.stringify(one).includes('secret-a'));
    });

    it('an editor can add and change but not delete', async () => {
      const made = expectStatus(await editor.post('/api/environments', { name: `ed-${uid()}`, env: 'A=1' }), 201);
      expectStatus(await editor.put(`/api/environments/${made.id}`, { name: made.name, env: 'A=2\nB=3' }), 200);
      const seen = expectStatus(await editor.get(`/api/environments/${made.id}`), 200);
      assert.deepEqual(seen.env, [['A', '2'], ['B', '3']]);
      assert.equal((await editor.del(`/api/environments/${made.id}`)).status, 403);
      expectStatus(await a.admin.del(`/api/environments/${made.id}`), 200);
    });
  });

  describe('isolation between organisations', () => {
    it('B cannot read, change or delete A\'s environment', async () => {
      assert.equal((await b.admin.get(`/api/environments/${envA.id}`)).status, 404);
      assert.equal((await b.admin.put(`/api/environments/${envA.id}`, { name: 'stolen', env: 'X=1' })).status, 404);
      assert.equal((await b.admin.del(`/api/environments/${envA.id}`)).status, 404);
      const listB = expectStatus(await b.admin.get('/api/environments'), 200);
      assert.ok(!listB.environments.some((e) => e.id === envA.id));
    });

    it('B cannot see or touch A\'s connector', async () => {
      const c = expectStatus(await a.admin.post('/api/connectors', { name: `pc-${uid()}` }), 201);
      assert.ok(c.token, 'token shown once on creation');
      const listA = expectStatus(await a.admin.get('/api/connectors'), 200);
      assert.ok(!JSON.stringify(listA).includes(c.token), 'token never listed');
      const listB = expectStatus(await b.admin.get('/api/connectors'), 200);
      assert.ok(!listB.some((x) => x.id === c.id));
      assert.equal((await b.admin.put(`/api/connectors/${c.id}`, { name: 'mine' })).status, 404);
      assert.equal((await b.admin.del(`/api/connectors/${c.id}`)).status, 404);
      expectStatus(await a.admin.del(`/api/connectors/${c.id}`), 200);
    });

    it('activity logs are per organisation', async () => {
      const logA = JSON.stringify(expectStatus(await a.admin.get('/api/activity'), 200));
      const logB = JSON.stringify(expectStatus(await b.admin.get('/api/activity'), 200));
      assert.ok(logA.includes(envA.name), 'A sees its own change');
      assert.ok(!logB.includes(envA.name), 'B does not see A\'s change');
    });

    it('the super admin outside any organisation is asked to open one', async () => {
      const r = await boss.get('/api/servers');
      assert.equal(r.status, 409);
      assert.equal(r.body.needsOrg, true);
    });
  });

  describe('environments', () => {
    it('parses a .env file the way a shell would', async () => {
      const env = '# comment\n\nexport A=1\nB="two words"\nC=\'single\'\nA=override\n';
      const made = expectStatus(await a.admin.post('/api/environments', { name: `parse-${uid()}`, env }), 201);
      assert.deepEqual(Object.fromEntries(made.env), { A: 'override', B: 'two words', C: 'single' });
    });

    it('refuses duplicate names and duplicates on request', async () => {
      assert.equal((await a.admin.post('/api/environments', { name: envA.name, env: 'A=1' })).status, 409);
      const copy = expectStatus(await a.admin.post(`/api/environments/${envA.id}/duplicate`, {}), 201);
      assert.notEqual(copy.name, envA.name);
      assert.deepEqual(copy.keys.sort(), ['API_KEY', 'DB_URL']);
    });
  });
});
