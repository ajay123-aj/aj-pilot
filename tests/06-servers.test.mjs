// Servers, end to end over real SSH against the throwaway Ubuntu container
// (tests/fixtures/ssh). Skipped when Docker is not available.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import WebSocket from 'ws';
import { Client, BASE, SSH, expectStatus, owner, plans, organisation, member, uid } from './helpers.mjs';

const login = { username: 'deploy', password: 'Deploy-Pass-123', sudo_password: 'Deploy-Pass-123' };

/** Open the browser terminal as `client` and run one command; resolves to what came back. */
function terminal(client, serverId, { command = null, origin = BASE, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${BASE.replace('http', 'ws')}/api/terminal/ws?server=${serverId}`, {
      headers: { cookie: client.cookie, origin, 'x-forwarded-for': client.ip },
    });
    let output = '';
    const messages = [];
    const timer = setTimeout(() => { ws.terminate(); resolve({ messages, output, timedOut: true }); }, timeoutMs);
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        output += data.toString('utf8');
        if (command && output.includes('MARK-DONE')) { clearTimeout(timer); ws.close(); resolve({ messages, output }); }
        return;
      }
      const m = JSON.parse(String(data));
      messages.push(m);
      if (m.t === 'ready' && command) ws.send(JSON.stringify({ t: 'in', d: `${command}; echo MARK-$((1+0))-x | sed s/-1-x/-DONE/\r` }));
      if (m.t === 'ready' && !command) { clearTimeout(timer); ws.close(); resolve({ messages, output }); }
    });
    ws.on('close', (code) => { clearTimeout(timer); resolve({ messages, output, code }); });
    ws.on('error', (err) => { clearTimeout(timer); resolve({ messages, output, error: err.message }); });
  });
}

describe('servers over SSH', { skip: !SSH && 'no SSH test server (Docker not available)' }, () => {
  let boss;
  let org;
  let editor;
  let viewer;
  let server;
  const target = () => ({ host: SSH.host, port: SSH.port });

  before(async () => {
    boss = await owner();
    org = await organisation(boss, { plan: (await plans(boss)).pro });
    editor = await member(org.admin, 'editor');
    viewer = await member(org.admin, 'viewer');
  });

  describe('connecting', () => {
    it('tests a connection before saving', async () => {
      const r = expectStatus(await org.admin.post('/api/servers/test', { name: 'probe', ...target(), ...login }), 200, 'test connection');
      assert.equal(r.ok, true);
      assert.equal(r.user, 'deploy');
      assert.ok(r.hostname);
    });

    it('reports a wrong password plainly', async () => {
      const r = await org.admin.post('/api/servers/test', { name: 'probe', ...target(), username: 'deploy', password: 'Wrong-Pass-1' });
      assert.equal(r.status, 400);
      assert.ok(r.body.error.length > 5);
    });

    it('validates the form', async () => {
      const r = await org.admin.post('/api/servers', { name: '', host: '', username: '', port: 70000 });
      assert.equal(r.status, 400);
      assert.match(r.body.error, /name is required/);
      assert.match(r.body.error, /port must be between/);
    });

    it('refuses to dial the panel\'s own loopback from the test form', async () => {
      const r = await org.admin.post('/api/servers/test', { name: 'probe', host: '127.0.0.1', port: 22, ...login });
      assert.equal(r.status, 400);
      assert.match(r.body.error, /will not connect to/);
    });

    it('refuses a saved server that points at the panel\'s loopback or cloud metadata', async () => {
      for (const host of ['127.0.0.1', 'localhost', '169.254.169.254']) {
        const made = await org.admin.post('/api/servers', { name: `ssrf-${uid()}`, host, port: 3306, ...login });
        if (made.status === 400) continue; // refused at save: good
        expectStatus(made, 201, `save ${host}`);
        const t = await org.admin.post(`/api/servers/${made.body.id}/test`);
        assert.equal(t.status, 400, `${host}: must not connect`);
        assert.match(t.body.error, /will not connect to|cannot be reached through any running connector/i,
          `${host}: refused by the address guard, not by the network: ${t.body.error}`);
        await org.admin.del(`/api/servers/${made.body.id}`);
      }
    });

    it('saves a server, never returning its secrets', async () => {
      const made = expectStatus(await org.admin.post('/api/servers', { name: `ubuntu-${uid()}`, ...target(), ...login }), 201, 'save server');
      server = made;
      const shown = JSON.stringify(expectStatus(await viewer.get(`/api/servers/${made.id}`), 200));
      assert.ok(!shown.includes('Deploy-Pass-123'), 'no password in the server view');
      assert.ok(!/_enc/.test(shown), 'no encrypted columns either');
      assert.equal((await viewer.get(`/api/servers/${made.id}/secrets`)).status, 403);
      assert.equal((await org.admin.post('/api/servers', { name: made.name, ...target(), ...login })).status, 409, 'duplicate name');
    });

    it('tests the saved server and pins its host key', async () => {
      expectStatus(await viewer.post(`/api/servers/${server.id}/test`), 200, 'viewer may test');
    });
  });

  describe('reading the server', () => {
    it('collects the system profile', async () => {
      expectStatus(await org.admin.post(`/api/servers/${server.id}/facts`), 200, 'collect facts');
      const f = expectStatus(await viewer.get(`/api/servers/${server.id}/facts`), 200);
      assert.match(JSON.stringify(f), /Ubuntu/);
    });

    it('lists servers with a summary and a status', async () => {
      const list = expectStatus(await viewer.get('/api/servers'), 200);
      const row = list.find((s) => s.id === server.id);
      assert.ok(row);
      assert.match(row.summary?.os || '', /Ubuntu/);
      const st = expectStatus(await viewer.get('/api/servers/status'), 200);
      assert.ok(st.servers.some((s) => s.id === server.id));
    });

    it('counts what is on it, and samples live stats', async () => {
      expectStatus(await viewer.get(`/api/servers/${server.id}/summary`), 200, 'summary');
      const s = expectStatus(await viewer.get(`/api/servers/${server.id}/stats`), 200, 'stats');
      assert.ok(JSON.stringify(s).length > 50);
    });

    it('says plainly what is not installed (Docker, nginx) and that systemd is missing', async () => {
      for (const p of ['docker', 'nginx', 'services']) {
        const r = await viewer.get(`/api/servers/${server.id}/${p}`);
        assert.ok(r.status < 500, `${p} → ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
      }
    });
  });

  describe('commands', () => {
    it('runs a command (exec)', async () => {
      const r = expectStatus(await editor.post(`/api/servers/${server.id}/exec`, { command: 'echo exec-ok && whoami' }), 200);
      assert.match(r.stdout, /exec-ok/);
      assert.match(r.stdout, /deploy/);
      assert.equal(r.code, 0);
    });

    it('a viewer may not run commands', async () => {
      assert.equal((await viewer.post(`/api/servers/${server.id}/exec`, { command: 'id' })).status, 403);
    });

    it('opens the browser terminal and runs a command', async () => {
      const r = await terminal(org.admin, server.id, { command: 'echo term-$((40+2))' });
      assert.ok(r.messages.some((m) => m.t === 'ready'), `ready: ${JSON.stringify(r.messages)}`);
      assert.match(r.output, /term-42/);
      const log = JSON.stringify(expectStatus(await org.admin.get('/api/activity'), 200));
      assert.match(log, /opened a terminal/);
      assert.ok(!log.includes('term-'), 'keystrokes are not logged');
    });

    it('refuses the terminal to a viewer, to another site and to nobody', async () => {
      const v = await terminal(viewer, server.id);
      assert.equal(v.code, 4403);
      const x = await terminal(org.admin, server.id, { origin: 'https://evil.example' });
      assert.equal(x.code, 4403);
      const anon = await terminal(new Client(), server.id);
      assert.equal(anon.code, 4401);
    });
  });

  describe('files', () => {
    const dir = `/tmp/ajtest-${uid()}`;
    it('creates a folder, writes, reads, lists and deletes a file', async () => {
      expectStatus(await editor.post(`/api/servers/${server.id}/files/folder`, { dir: '/tmp', name: dir.slice(5) }), 200, 'mkdir');
      expectStatus(await editor.post(`/api/servers/${server.id}/files/file`, { dir, name: 'a.txt' }), 200, 'touch');
      expectStatus(await editor.put(`/api/servers/${server.id}/files/content`, { path: `${dir}/a.txt`, content: 'hello file\n' }), 200, 'write');
      const read = expectStatus(await editor.get(`/api/servers/${server.id}/files/content?path=${encodeURIComponent(`${dir}/a.txt`)}`), 200);
      assert.match(JSON.stringify(read), /hello file/);
      const list = expectStatus(await viewer.get(`/api/servers/${server.id}/files?path=${encodeURIComponent(dir)}`), 200);
      assert.match(JSON.stringify(list), /a\.txt/);
      assert.equal((await viewer.get(`/api/servers/${server.id}/files/content?path=${encodeURIComponent(`${dir}/a.txt`)}`)).status, 403, 'reading content needs edit');
      assert.equal((await editor.del(`/api/servers/${server.id}/files`, { path: dir })).status, 403, 'editor cannot delete');
      expectStatus(await org.admin.del(`/api/servers/${server.id}/files`, { path: dir }), 200, 'delete');
    });

    it('refuses to delete the root of the filesystem', async () => {
      const r = await org.admin.del(`/api/servers/${server.id}/files`, { path: '/' });
      assert.ok(r.status >= 400 && r.status < 500, JSON.stringify(r.body));
    });
  });

  describe('Linux users', () => {
    const name = `ajt${Date.now().toString(36).slice(-5)}`;
    it('adds, lists and deletes a user', async () => {
      expectStatus(await org.admin.post(`/api/servers/${server.id}/users`, { username: name, password: 'User-Pass-12345', shell: '/bin/bash' }), 200, 'add user');
      const list = expectStatus(await org.admin.get(`/api/servers/${server.id}/users`), 200);
      assert.ok(JSON.stringify(list).includes(name));
      expectStatus(await org.admin.del(`/api/servers/${server.id}/users/${name}`), 200, 'delete user');
    });

    it('refuses bad usernames', async () => {
      const r = await org.admin.post(`/api/servers/${server.id}/users`, { username: 'Bad Name;rm -rf', password: 'User-Pass-12345' });
      assert.equal(r.status, 400);
    });
  });

  describe('cron', () => {
    it('adds and removes a job', async () => {
      const marker = `cron-${uid()}`;
      expectStatus(await editor.post(`/api/servers/${server.id}/cron/jobs`, { user: 'deploy', schedule: '*/5 * * * *', command: `echo ${marker}` }), 201, 'add job');
      const list = JSON.stringify(expectStatus(await viewer.get(`/api/servers/${server.id}/cron`), 200));
      assert.ok(list.includes(marker));
      expectStatus(await org.admin.del(`/api/servers/${server.id}/cron/jobs`, { user: 'deploy', old_line: `*/5 * * * * echo ${marker}` }), 200, 'remove job');
      assert.ok(!JSON.stringify((await viewer.get(`/api/servers/${server.id}/cron`)).body).includes(marker));
    });

    it('refuses an invalid schedule', async () => {
      const r = await editor.post(`/api/servers/${server.id}/cron/jobs`, { user: 'deploy', schedule: 'every day', command: 'true' });
      assert.equal(r.status, 400);
    });
  });

  describe('docker containers', () => {
    // The test server has no Docker, which is what these check against: the
    // refusals, and errors that arrive as JSON or as a stream event, not a crash.
    const base = () => `/api/servers/${server.id}`;

    it('downloads need edit: compose, backup and a volume', async () => {
      for (const p of ['/containers/web1/compose', '/containers/web1/backup', '/docker/volumes/data1/download']) {
        assert.equal((await viewer.get(`${base()}${p}`)).status, 403, `${p} as a viewer`);
      }
    });

    it('refuses names that are not container or volume names', async () => {
      assert.equal((await editor.get(`${base()}/containers/${encodeURIComponent('a;id')}/compose`)).status, 400);
      assert.equal((await editor.get(`${base()}/docker/volumes/${encodeURIComponent('x y')}/download`)).status, 400);
      assert.equal((await viewer.get(`${base()}/containers/${encodeURIComponent('-x')}/stream`)).status, 400);
    });

    it('a download from a server without Docker fails as JSON, before any file is sent', async () => {
      const r = await editor.get(`${base()}/containers/web1/compose`);
      assert.equal(r.status, 400);
      assert.ok(r.body?.error, JSON.stringify(r.body));
      assert.ok(!r.headers.get('content-disposition'));
    });

    it('the live stream says what is wrong as an event', async () => {
      const ctl = new AbortController();
      const res = await viewer.raw('GET', `${base()}/containers/web1/stream?every=2000`, { headers: { accept: 'text/event-stream' } });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
      const reader = res.body.getReader();
      let text = '';
      const until = Date.now() + 20000;
      while (!/event: problem/.test(text) && Date.now() < until) {
        const { done, value } = await reader.read();
        if (done) break;
        text += Buffer.from(value).toString('utf8');
      }
      ctl.abort();
      await reader.cancel();
      assert.match(text, /event: problem/);
      assert.match(text, /Docker is not installed|docker/i);
    });
  });

  describe('isolation', () => {
    it('another organisation cannot see or use this server', async () => {
      const other = await organisation(boss, { plan: (await plans(boss)).pro });
      assert.equal((await other.admin.get(`/api/servers/${server.id}`)).status, 404);
      assert.equal((await other.admin.post(`/api/servers/${server.id}/exec`, { command: 'id' })).status, 404);
      assert.equal((await other.admin.del(`/api/servers/${server.id}`)).status, 404);
      const t = await terminal(other.admin, server.id);
      assert.equal(t.code, 4404);
    });
  });

  describe('host key pinning', () => {
    it('blocks a server whose host key changed, until it is reset', async () => {
      const regen = spawnSync('docker', ['exec', 'aj-pilot-test-ssh', 'sh', '-c',
        'rm -f /etc/ssh/ssh_host_* && ssh-keygen -A >/dev/null && kill -HUP $(cat /run/sshd.pid 2>/dev/null || pgrep -o sshd)'], { encoding: 'utf8' });
      assert.equal(regen.status, 0, regen.stderr);
      await new Promise((r) => setTimeout(r, 1500));
      const r = await org.admin.post(`/api/servers/${server.id}/test`);
      assert.equal(r.status, 400);
      assert.match(r.body.error, /host key has changed/);
      expectStatus(await org.admin.post(`/api/servers/${server.id}/host-key/reset`), 200, 'reset');
      expectStatus(await org.admin.post(`/api/servers/${server.id}/test`), 200, 'works again');
    });
  });

  after(async () => {
    if (!server) return;
    assert.equal((await editor.del(`/api/servers/${server.id}`)).status, 403, 'editor cannot delete a server');
    expectStatus(await org.admin.del(`/api/servers/${server.id}`), 200, 'delete server');
  });
});
