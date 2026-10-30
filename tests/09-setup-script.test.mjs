// The one-file machine setup: its options, the script it builds, the download,
// and — when Docker is available — the script itself, run inside fresh Ubuntu
// and Debian containers for the cases that need no network.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupOptionsFrom, buildSetupScript, SETUP_FLAGS } from '../src/lib/setupScript.js';
import { Client, owner, plans, organisation, member, expectStatus } from './helpers.mjs';

const has = (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
const BASH = has('bash', ['-c', 'true']);
const DOCKER = has('docker', ['info']);

const build = (query = {}) => {
  const o = setupOptionsFrom(query);
  assert.ok(o.value, o.error);
  return buildSetupScript(o.value, { generatedAt: new Date('2026-01-01T00:00:00Z') });
};

describe('setup file options', () => {
  it('defaults everything on but Docker', () => {
    const { value } = setupOptionsFrom({});
    assert.equal(value.sshPort, 22);
    assert.equal(value.screenMinutes, 1);
    for (const [key, [, def]] of Object.entries(SETUP_FLAGS)) assert.equal(value.flags[key], def, key);
    assert.equal(value.flags.docker, false);
  });

  it('reads on/off flags in every usual spelling', () => {
    const { value } = setupOptionsFrom({ docker: 'on', sleep: 'false', lid: '0', wifi: 'yes' });
    assert.deepEqual([value.flags.docker, value.flags.sleep, value.flags.lid, value.flags.wifi], [true, false, false, true]);
  });

  for (const [what, query, message] of [
    ['a port out of range', { ssh_port: '70000' }, /between 1 and 65535/],
    ['a port that is not a number', { ssh_port: '22; reboot' }, /between 1 and 65535/],
    ['a time zone with shell in it', { timezone: 'Asia/Kolkata; rm -rf /' }, /not a time zone/],
    ['a bad machine name', { hostname: 'my_server!' }, /machine name/],
    ['a bad user name', { user: 'Root User' }, /not a Linux user name/],
    ['a private key', { ssh_key: '-----BEGIN OPENSSH PRIVATE KEY----- b3Bl' }, /private key/],
    ['a key with a quote', { ssh_key: "ssh-ed25519 AAAAC3Nz' ; reboot" }, /does not look like an SSH public key/],
    ['an unknown flag value', { firewall: 'perhaps' }, /must be on or off/],
    ['a screen timeout of zero', { screen_minutes: '0' }, /1 to 60 minutes/],
  ]) {
    it(`refuses ${what}`, () => {
      const r = setupOptionsFrom(query);
      assert.ok(r.error, 'expected an error');
      assert.match(r.error, message);
    });
  }

  it('puts the options into the script, single-quoted', () => {
    const s = build({ ssh_port: 2222, timezone: 'Europe/London', hostname: 'home-1', user: 'ajay', docker: 1, ssh_key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAbc me@pc' });
    assert.match(s, /^SSH_PORT='2222'$/m);
    assert.match(s, /^TIMEZONE='Europe\/London'$/m);
    assert.match(s, /^NEW_HOSTNAME='home-1'$/m);
    assert.match(s, /^PANEL_USER='ajay'/m);
    assert.match(s, /^SSH_PUBKEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAbc me@pc'$/m);
    assert.match(s, /^DO_DOCKER=1$/m);
    assert.ok(!s.includes('@@OPTIONS@@'));
    assert.ok(!s.includes('\r'), 'no Windows line endings');
    assert.ok(s.startsWith('#!/usr/bin/env bash\n'));
  });

  it('is valid Bash for every combination tried', { skip: !BASH && 'bash not available' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ajp-setup-'));
    const variants = [{}, { docker: 1, ssh_port: 2200 }, Object.fromEntries(Object.keys(SETUP_FLAGS).map((k) => [k, 0]))];
    variants.forEach((q, i) => {
      const file = path.join(dir, `s${i}.sh`);
      fs.writeFileSync(file, build(q));
      const r = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('setup file download', () => {
  let org;
  let viewer;
  before(async () => {
    const boss = await owner();
    org = await organisation(boss, { plan: (await plans(boss)).pro });
    viewer = await member(org.admin, 'viewer');
  });

  it('downloads as an attachment, for anyone who can see servers', async () => {
    const res = await viewer.raw('GET', '/api/servers/setup-script?ssh_port=2222&timezone=Asia/Kolkata&docker=1');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /shellscript/);
    assert.match(res.headers.get('content-disposition'), /attachment; filename="aj-pilot-setup.sh"/);
    const text = await res.text();
    assert.match(text, /^SSH_PORT='2222'$/m);
    assert.match(text, /^DO_DOCKER=1$/m);
  });

  it('says what is wrong with an option', async () => {
    const r = await org.admin.get('/api/servers/setup-script?ssh_port=0');
    expectStatus(r, 400, 'bad port');
    assert.match(r.body.error, /SSH port/);
  });

  it('needs a signed-in user', async () => {
    const r = await new Client().get('/api/servers/setup-script');
    assert.equal(r.status, 401);
  });

  it('has a public copy for the home page, the docs and curl', async () => {
    const res = await new Client().raw('GET', '/setup/aj-pilot-setup.sh');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /filename="aj-pilot-setup.sh"/);
    const text = await res.text();
    assert.ok(text.startsWith('#!/usr/bin/env bash\n'));
    assert.match(text, /^SSH_PORT='22'$/m);
    assert.match(text, /^DO_DOCKER=0$/m);
  });

  it('checks the public copy\'s options too', async () => {
    const res = await new Client().raw('GET', '/setup/aj-pilot-setup.sh?ssh_port=0');
    assert.equal(res.status, 400);
    assert.match(await res.text(), /SSH port/);
  });

  it('links the setup from the home page menu and the docs', async () => {
    const home = await (await new Client().raw('GET', '/')).text();
    assert.match(home, /href="#server-setup"/);
    assert.match(home, /id="server-setup"/);
    assert.match(home, /\/setup\/aj-pilot-setup\.sh/);
    assert.ok(!home.includes('%%SITE_URL%%'));
    const nav = home.match(/<nav class="landing-nav"[\s\S]*?<\/nav>/)[0];
    assert.ok(!/#faq|\/terms/.test(nav), 'FAQ and Terms live in the footer only');
    assert.ok(!home.includes('id="btn-open-signup"'), 'the header has Sign in only');
    const doc = await (await new Client().raw('GET', '/docs/ubuntu-server-setup')).text();
    assert.match(doc, /curl -fsSL https?:\/\/[^/]+\/setup\/aj-pilot-setup\.sh/);
  });
});

// Real runs. Only the cases that need no network, so the suite stays fast and offline.
describe('setup file in a container', { skip: !DOCKER && 'Docker not available' }, () => {
  let dir;
  const run = (body, image = 'ubuntu:24.04') => {
    const r = spawnSync('docker', ['run', '--rm', '--network', 'none', '-v', `${dir}:/s:ro`, image, 'bash', '-c', body],
      { encoding: 'utf8', timeout: 180000, env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ajp-setup-ct-'));
    fs.writeFileSync(path.join(dir, 'setup.sh'), build({ ssh_port: 2222, user: 'tester', timezone: 'Asia/Kolkata' }));
  });

  it('prints help', () => {
    const r = run('bash /s/setup.sh --help');
    assert.equal(r.code, 0);
    assert.match(r.out, /--dry-run/);
  });

  it('refuses an unknown option and a bad port', () => {
    assert.equal(run('bash /s/setup.sh --nope').code, 2);
    const r = run('bash /s/setup.sh --ssh-port 99999');
    assert.equal(r.code, 2);
    assert.match(r.out, /not a port number/);
  });

  it('refuses a system that is not Ubuntu or Debian', () => {
    const r = run("sed -i 's/^ID=.*/ID=arch/; s/^ID_LIKE=.*/ID_LIKE=arch/' /etc/os-release; bash /s/setup.sh");
    assert.equal(r.code, 3);
    assert.match(r.out, /--force/);
  });

  it('asks for root when it is not run with sudo', () => {
    const r = run("useradd -m tester; su tester -c 'bash /s/setup.sh'");
    assert.equal(r.code, 1);
    assert.match(r.out, /Run it as root/);
  });

  it('changes nothing on a dry run', () => {
    const r = run("useradd -m tester; su tester -c 'bash /s/setup.sh --dry-run'; test ! -e /etc/sudoers.d/90-aj-pilot && test ! -e /etc/ssh && echo UNCHANGED");
    assert.match(r.out, /Dry run finished/);
    assert.match(r.out, /UNCHANGED/);
  });

  it('without internet: says so, finishes every step, reports what failed', () => {
    const r = run('useradd -m tester; timeout 150 bash /s/setup.sh');
    assert.equal(r.code, 1);
    assert.match(r.out, /No internet connection/);
    assert.match(r.out, /Summary/);
    assert.match(r.out, /Connect it in AJ Pilot/);
  });
});
