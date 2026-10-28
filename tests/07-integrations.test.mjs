// Credentials, databases, the install catalog, apps, runners and connectors.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { BASE, SSH, expectStatus, owner, plans, organisation, member, uid } from './helpers.mjs';

const MYSQL = process.env.TEST_MYSQL_HOST ? {
  host: process.env.TEST_MYSQL_HOST, port: Number(process.env.TEST_MYSQL_PORT),
  username: process.env.TEST_MYSQL_USER, secret: process.env.TEST_MYSQL_PASSWORD,
} : null;

describe('integrations', () => {
  let boss;
  let org;
  let viewer;
  before(async () => {
    boss = await owner();
    org = await organisation(boss, { plan: (await plans(boss)).pro });
    viewer = await member(org.admin, 'viewer');
  });

  describe('credentials', () => {
    it('validates a new credential', async () => {
      const bad = [
        [{ provider: 'nope', name: 'x', secret: 'y' }, /provider must be one of/],
        [{ provider: 'git', name: '', secret: 'y' }, /name is required/],
        [{ provider: 'cloudflare', name: 'x' }, /secret/],
        [{ provider: 'dockerhub', name: 'x', secret: 'y' }, /username is required/],
        [{ provider: 'mysql', name: 'x', secret: 'y' }, /username is required/],
      ];
      for (const [body, msg] of bad) {
        const r = await org.admin.post('/api/credentials', body);
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.match(r.body.error, msg);
      }
    });

    it('stores a credential without ever returning the secret', async () => {
      const name = `hub-${uid()}`;
      const made = expectStatus(await org.admin.post('/api/credentials', { provider: 'dockerhub', name, username: 'someone', secret: 'dckr_pat_SECRET123' }), 201);
      const list = JSON.stringify(expectStatus(await viewer.get('/api/credentials'), 200));
      assert.ok(list.includes(name));
      assert.ok(!list.includes('dckr_pat_SECRET123'), 'secret not in the list');
      const one = JSON.stringify(expectStatus(await viewer.get(`/api/credentials/${made.id}`), 200));
      assert.ok(!one.includes('dckr_pat_SECRET123'), 'secret not in the detail');
      assert.equal((await org.admin.post('/api/credentials', { provider: 'dockerhub', name, username: 'someone', secret: 'x' })).status, 409);
      assert.equal((await viewer.del(`/api/credentials/${made.id}`)).status, 403);
      expectStatus(await org.admin.del(`/api/credentials/${made.id}`), 200);
    });

    it('another organisation cannot reach the credential', async () => {
      const made = expectStatus(await org.admin.post('/api/credentials', { provider: 'dockerhub', name: `iso-${uid()}`, username: 'u', secret: 's' }), 201);
      const other = await organisation(boss, { plan: (await plans(boss)).pro });
      assert.equal((await other.admin.get(`/api/credentials/${made.id}`)).status, 404);
      assert.equal((await other.admin.del(`/api/credentials/${made.id}`)).status, 404);
    });

    it('refuses to test a database on the panel\'s own loopback', async () => {
      const r = await org.admin.post('/api/credentials/test-mysql', { host: '127.0.0.1', port: 3306, username: 'root', password: 'x' });
      assert.equal(r.status, 400);
      assert.match(r.body.error, /private or reserved address/);
      const es = await org.admin.post('/api/credentials/test-db', { provider: 'elasticsearch', host: '127.0.0.1', port: 9200 });
      assert.equal(es.status, 400);
      assert.match(es.body.error, /private or reserved address/);
    });

    it('keeps an Elasticsearch connection without a password', async () => {
      const made = expectStatus(await org.admin.post('/api/credentials', { provider: 'elasticsearch', name: `es-${uid()}`, host: 'search.example.com', port: 9200 }), 201);
      assert.equal(made.provider, 'elasticsearch');
      assert.equal(made.extra.port, 9200);
      expectStatus(await org.admin.del(`/api/credentials/${made.id}`), 200);
    });

    it('keeps an invalid git token, marked invalid with the reason', async () => {
      const r = expectStatus(await org.admin.post('/api/credentials', { provider: 'git', name: `gh-${uid()}`, secret: 'ghp_definitelynotvalid0000000000000000' }), 201);
      assert.equal(r.status, 'invalid');
      assert.match(r.last_error, /rejected the token/);
      assert.ok(!JSON.stringify(r).includes('definitelynotvalid'), 'only a masked hint of the token');
    });
  });

  // A database on a private address is only reached through a server's SSH tunnel (or a connector),
  // so this goes the way a user would: tunnelled through the Ubuntu test server.
  describe('MySQL browsing through an SSH tunnel', { skip: !(MYSQL && SSH) && 'needs the SSH test server and a MySQL reachable from it' }, () => {
    let cred;
    before(async () => {
      const server = expectStatus(await org.admin.post('/api/servers', {
        name: `tunnel-${uid()}`, host: SSH.host, port: SSH.port, username: 'deploy', password: 'Deploy-Pass-123',
      }), 201, 'tunnel server');
      cred = expectStatus(await org.admin.post('/api/credentials', { provider: 'mysql', name: `db-${uid()}`, ...MYSQL, server_id: server.id }), 201, 'mysql credential');
    });

    it('refuses a direct connection to a private address', async () => {
      const direct = expectStatus(await org.admin.post('/api/credentials', { provider: 'mysql', name: `direct-${uid()}`, ...MYSQL }), 201);
      const r = await org.admin.post(`/api/credentials/${direct.id}/mysql/overview`);
      assert.equal(r.status, 400);
      assert.match(r.body.error, /private or reserved address/);
    });

    it('reads an overview of the server', async () => {
      const o = expectStatus(await viewer.post(`/api/credentials/${cred.id}/mysql/overview`), 200, 'overview');
      assert.ok(o.totals.databases >= 1);
    });

    it('runs a read-only query', async () => {
      const q = expectStatus(await viewer.post(`/api/credentials/${cred.id}/mysql/query`, { sql: 'SELECT 1 + 1 AS two' }), 200);
      assert.deepEqual(q.columns, ['two']);
      assert.equal(Number(q.rows[0].two), 2);
    });

    it('refuses anything that is not a plain read', async () => {
      const refused = [
        'DROP DATABASE mysql', 'SELECT 1; DROP DATABASE x', 'SELECT 1 INTO OUTFILE \'/tmp/x\'',
        'SELECT SLEEP(5)', 'SELECT * FROM mysql.user FOR UPDATE', 'SELECT 1 -- hi', 'EXPLAIN ANALYZE SELECT 1',
        'UPDATE mysql.user SET host = host',
      ];
      for (const sql of refused) {
        const r = await org.admin.post(`/api/credentials/${cred.id}/mysql/query`, { sql });
        assert.equal(r.status, 400, sql);
      }
    });

    it('a viewer cannot create a database', async () => {
      const r = await viewer.post(`/api/credentials/${cred.id}/mysql/schemas`, { name: `x_${uid()}` });
      assert.equal(r.status, 403);
    });

    it('counts against the database limit of the plan', async () => {
      const small = await organisation(boss, { plan: (await plans(boss)).starter }); // databases: 1
      expectStatus(await small.admin.post('/api/credentials', { provider: 'mysql', name: `one-${uid()}`, ...MYSQL }), 201);
      const r = await small.admin.post('/api/credentials', { provider: 'mysql', name: `two-${uid()}`, ...MYSQL });
      assert.equal(r.status, 403);
      assert.equal(r.body.limit, 'databases');
    });
  });

  describe('install catalog', () => {
    it('lists what can be installed', async () => {
      const c = expectStatus(await viewer.get('/api/installs/catalog'), 200);
      const keys = c.catalog.map((x) => x.key);
      for (const k of ['docker', 'compose', 'mysql', 'postgres', 'mongo', 'redis']) assert.ok(keys.includes(k), k);
      expectStatus(await viewer.get('/api/installs'), 200);
    });

    it('validates an installation', async () => {
      const r = await org.admin.post('/api/installs', { kind: 'nope', server_id: 999999 });
      assert.equal(r.status, 400, JSON.stringify(r.body));
    });
  });

  describe('apps', () => {
    it('lists apps (none yet)', async () => {
      const r = expectStatus(await viewer.get('/api/apps'), 200);
      assert.ok(Array.isArray(r.apps || r));
    });

    it('validates repository inspection', async () => {
      assert.equal((await org.admin.post('/api/apps/inspect', {})).status, 400);
      const r = await org.admin.post('/api/apps/inspect', { repo: 'owner/repo', branch: 'main', credential_id: 999999 });
      assert.ok([400, 404].includes(r.status), JSON.stringify(r.body));
      const bad = await org.admin.post('/api/apps/inspect', { repo: 'owner/repo', root_dir: '../../etc' });
      assert.equal(bad.status, 400, 'a root folder outside the repository is refused');
    });

    it('refuses to create an app without the basics', async () => {
      const r = await org.admin.post('/api/apps', { name: '' });
      assert.equal(r.status, 400, JSON.stringify(r.body));
    });

    it('a webhook with an unknown token is refused', async () => {
      const res = await fetch(`${BASE}/api/hooks/apps/not-a-real-token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.ok([401, 403, 404].includes(res.status), String(res.status));
    });

    it('unknown app ids are 404', async () => {
      assert.equal((await viewer.get('/api/apps/999999')).status, 404);
      assert.equal((await org.admin.del('/api/apps/999999')).status, 404);
    });
  });

  describe('runners', () => {
    it('lists runners and validates a new one', async () => {
      expectStatus(await viewer.get('/api/runners'), 200);
      const r = await org.admin.post('/api/runners', {});
      assert.equal(r.status, 400, JSON.stringify(r.body));
    });
  });

  describe('connectors', () => {
    it('a connector with a bad token is turned away', async () => {
      const result = await new Promise((resolve) => {
        const ws = new WebSocket(`${BASE.replace('http', 'ws')}/api/connectors/ws`);
        const got = [];
        ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', token: 'not-a-token', hostname: 'test' })));
        ws.on('message', (d) => got.push(JSON.parse(String(d))));
        ws.on('close', (code) => resolve({ code, got }));
        ws.on('error', (e) => resolve({ error: e.message, got }));
      });
      assert.equal(result.code, 4001);
      assert.equal(result.got[0]?.t, 'denied');
    });

    it('a real token connects, a new token disconnects it', async () => {
      const made = expectStatus(await org.admin.post('/api/connectors', { name: `pc-${uid()}` }), 201);
      const ws = new WebSocket(`${BASE.replace('http', 'ws')}/api/connectors/ws`);
      const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
      await new Promise((resolve) => ws.on('open', resolve));
      ws.send(JSON.stringify({ t: 'hello', token: made.token, hostname: 'test-pc', platform: 'linux', version: 'test' }));
      await new Promise((r) => setTimeout(r, 500));
      const list = expectStatus(await viewer.get('/api/connectors'), 200);
      assert.ok(list.find((c) => c.id === made.id)?.live, 'shows as running');
      expectStatus(await org.admin.post(`/api/connectors/${made.id}/token`), 200);
      assert.equal(await closed, 4001, 'the running copy is disconnected');
      expectStatus(await org.admin.del(`/api/connectors/${made.id}`), 200);
    });
  });
});
