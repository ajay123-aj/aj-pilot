/**
 * `npm test` — the whole product, end to end, against a panel of its own.
 *
 *   1. A throwaway MySQL database (TEST_DB_NAME, default aj_pilot_test) on the
 *      server .env points at. It must end in "_test"; it is dropped and made
 *      fresh each run, so the real database is never touched.
 *   2. A disposable Ubuntu SSH server in Docker (tests/fixtures/ssh), so the
 *      server features run for real. Without Docker those tests are skipped.
 *   3. The panel itself on TEST_PORT (default 4917), with its own data folder,
 *      encryption key and super admin, health monitor off, OTP fixed.
 *   4. node --test over tests/*.test.mjs, one file at a time.
 *
 * KEEP=1 leaves the database, container and panel log behind for a look.
 */

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, 'tests', '.tmp');
dotenv.config({ path: path.join(ROOT, '.env') });

const DB_NAME = process.env.TEST_DB_NAME || 'aj_pilot_test';
const PORT = Number(process.env.TEST_PORT || 4917);
const SSH_PORT = Number(process.env.TEST_SSH_PORT || 2222);
const SSH_CONTAINER = 'aj-pilot-test-ssh';
const KEEP = process.env.KEEP === '1';

if (!/_test$/.test(DB_NAME)) {
  console.error(`Refusing to run: TEST_DB_NAME "${DB_NAME}" must end in _test, because it is dropped.`);
  process.exit(2);
}
if (DB_NAME === process.env.DB_NAME) {
  console.error('Refusing to run: the test database is the same as the panel database in .env.');
  process.exit(2);
}

const log = (...a) => console.log('[test]', ...a);
const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8' });

/** The machine's LAN address: the panel's SSRF guard allows LAN SSH targets but not loopback. */
function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) return a.address;
    }
  }
  return null;
}

/** Drop the test database; the panel creates it again, empty, on boot. */
async function dropDatabase() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '',
  });
  await conn.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\``);
  await conn.end();
}

function startSsh() {
  if (process.env.TEST_SSH === '0') return null;
  if (docker('version').status !== 0) { log('Docker not available — SSH tests will be skipped'); return null; }
  const built = docker('image', 'inspect', SSH_CONTAINER);
  if (built.status !== 0) {
    log('Building the SSH test image (first run only)…');
    const b = spawnSync('docker', ['build', '-t', SSH_CONTAINER, path.join(ROOT, 'tests', 'fixtures', 'ssh')], { stdio: 'inherit' });
    if (b.status !== 0) { log('SSH image build failed — SSH tests will be skipped'); return null; }
  }
  docker('rm', '-f', SSH_CONTAINER);
  const run = docker('run', '-d', '--name', SSH_CONTAINER, '-p', `${SSH_PORT}:22`, SSH_CONTAINER);
  if (run.status !== 0) { log('Could not start the SSH container:', run.stderr.trim()); return null; }
  const host = lanAddress();
  if (!host) { log('No LAN address found — SSH tests will be skipped'); return null; }
  return { host, port: SSH_PORT };
}

async function waitFor(url, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if ((await fetch(url)).ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, 'data'), { recursive: true });
  const panelLog = path.join(TMP, 'panel.log');

  log(`database ${DB_NAME} (fresh)`);
  await dropDatabase();
  const ssh = startSsh();
  if (ssh) log(`SSH test server at ${ssh.host}:${ssh.port}`);

  const env = {
    ...process.env,
    PORT: String(PORT), HOST: '127.0.0.1', DB_NAME,
    DATA_DIR: path.join(TMP, 'data'),
    APP_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    HEALTH_CHECK_ENABLED: 'false',
    TRUST_PROXY: 'true',
    SITE_URL: '', SMTP_HOST: '',
    OTP_MODE: 'fixed', OTP_FIXED_CODE: '123456', OTP_LOGIN: 'on', // mobile sign-in on, with the fixed test code
    ALLOW_SIGNUP: 'true', PRIVATE_TARGETS: '', FREE_TRIAL_DAYS: '30',
    SUPER_ADMIN_EMAIL: 'owner@test.local', SUPER_ADMIN_PASSWORD: 'Owner-Pass-12345',
    SUPER_ADMIN_NAME: 'Test Owner', SUPER_ADMIN_PHONE: '+919000000001',
    RAZORPAY_WEBHOOK_SECRET: 'whsec_test_suite',
    SQLITE_FILE: path.join(TMP, 'none.db'),
  };
  // Something already answering there (a panel left over from an interrupted run) would be
  // tested instead of this code — refuse rather than report results for the wrong panel.
  if (await fetch(`http://127.0.0.1:${PORT}/api/health`).then(() => true, () => false)) {
    throw new Error(`Port ${PORT} is already in use — stop whatever is running there (a panel from an earlier test run?) or set TEST_PORT.`);
  }
  const out = fs.openSync(panelLog, 'w');
  const panel = spawn(process.execPath, ['src/index.js'], { cwd: ROOT, env, stdio: ['ignore', out, out] });
  const base = `http://127.0.0.1:${PORT}`;
  if (!await waitFor(`${base}/api/health`, 60000)) {
    console.error(fs.readFileSync(panelLog, 'utf8').slice(-4000));
    panel.kill();
    throw new Error('The panel did not start');
  }
  log(`panel up at ${base}`);

  const files = fs.readdirSync(path.join(ROOT, 'tests')).filter((f) => f.endsWith('.test.mjs')).sort()
    .map((f) => path.join('tests', f));
  const only = process.argv.slice(2);
  const t = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec', ...(only.length ? only : files)], {
    cwd: ROOT, stdio: 'inherit',
    env: {
      ...process.env, TEST_BASE: base, TEST_LOG: panelLog,
      TEST_OWNER_EMAIL: env.SUPER_ADMIN_EMAIL, TEST_OWNER_PASSWORD: env.SUPER_ADMIN_PASSWORD,
      TEST_WEBHOOK_SECRET: env.RAZORPAY_WEBHOOK_SECRET,
      TEST_SSH_HOST: ssh?.host || '', TEST_SSH_PORT: ssh ? String(ssh.port) : '',
      TEST_RAZORPAY: process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET ? '1' : '',
      // The panel's own MySQL, reached by LAN address (loopback is refused by design) — read-only tests only.
      TEST_MYSQL_HOST: /^(127\.0\.0\.1|localhost)$/.test(process.env.DB_HOST || '127.0.0.1') ? (lanAddress() || '') : (process.env.DB_HOST || ''),
      TEST_MYSQL_PORT: process.env.DB_PORT || '3306',
      TEST_MYSQL_USER: process.env.DB_USER || 'root',
      TEST_MYSQL_PASSWORD: process.env.DB_PASSWORD || '',
    },
  });

  panel.kill();
  if (!KEEP) {
    if (ssh) docker('rm', '-f', SSH_CONTAINER);
    await dropDatabase().catch(() => {});
  } else {
    log(`KEEP=1: database ${DB_NAME}, container ${SSH_CONTAINER} and ${panelLog} left in place`);
  }
  process.exit(t.status ?? 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
