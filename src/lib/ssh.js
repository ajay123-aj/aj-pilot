import { Client } from 'ssh2';
import { config } from '../config.js';
import { decrypt } from './crypto.js';
import { one } from '../db/index.js';

/** How many jump hosts deep a chain may go before it is treated as a loop. */
const MAX_JUMPS = 3;

/** Build the ssh2 connect config from a stored server row. */
export function connectionFromRow(row) {
  const base = {
    host: row.host,
    port: row.port || 22,
    username: row.username,
    readyTimeout: config.ssh.connectTimeout,
    keepaliveInterval: 10000,
    tryKeyboard: true,
  };
  if (row.auth_type === 'key') {
    base.privateKey = decrypt(row.private_key_enc);
    const pass = decrypt(row.passphrase_enc);
    if (pass) base.passphrase = pass;
  } else {
    base.password = decrypt(row.password_enc);
  }
  // Behind a VPN or private network: reach it through another saved server.
  if (row.jump_server_id) base.jumpServerId = row.jump_server_id;
  return base;
}

/**
 * Open a connection, hand it to `fn`, and always close it afterwards.
 *
 * A config with `jumpServerId` is reached through that server first: the panel
 * signs in to the jump host, asks it for a TCP channel to the target's SSH port,
 * and runs the real SSH session inside that channel. That is how a panel
 * running in the cloud reaches office machines that are only on the VPN.
 */
export function withConnection(connectCfg, fn, depth = 0) {
  if (connectCfg.jumpServerId) return viaJumpHost(connectCfg, fn, depth);
  return directConnection(connectCfg, fn);
}

async function viaJumpHost(connectCfg, fn, depth) {
  const { jumpServerId, ...target } = connectCfg;
  if (depth >= MAX_JUMPS) {
    throw new Error('Too many jump hosts in a row — check the jump host settings of these servers for a loop.');
  }
  const jump = await one('SELECT * FROM servers WHERE id = ?', [jumpServerId]);
  if (!jump) throw new Error('The jump host for this server no longer exists — edit the server and pick another one.');

  try {
    return await withConnection({ ...connectionFromRow(jump), readyTimeout: target.readyTimeout }, (jumpConn) => new Promise((resolve, reject) => {
      jumpConn.forwardOut('127.0.0.1', 0, target.host, target.port || 22, (err, stream) => {
        if (err) {
          const e = new Error(`Jump host ${jump.name} could not reach ${target.host}:${target.port || 22} — `
            + 'check the private IP from the jump host, and that AllowTcpForwarding is enabled in its sshd_config.');
          e.cause = err.message;
          e.passThrough = true;
          return reject(e);
        }
        directConnection({ ...target, sock: stream }, fn).then(resolve, (e) => {
          // The target (or `fn`) failed, not the jump host: leave the message alone.
          if (e && typeof e === 'object') e.passThrough = true;
          reject(e);
        });
      });
    }), depth + 1);
  } catch (err) {
    if (err?.passThrough) throw err;
    // With two logins involved, say which one failed.
    const e = new Error(`Jump host ${jump.name}: ${err.message}`);
    e.cause = err.cause;
    e.passThrough = true;
    throw e;
  }
}

function directConnection(connectCfg, fn) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch { /* already closed */ }
      err ? reject(err) : resolve(value);
    };

    conn.on('ready', async () => {
      try {
        finish(null, await fn(conn));
      } catch (err) {
        finish(err);
      }
    });

    // Some hosts answer password auth as keyboard-interactive.
    conn.on('keyboard-interactive', (_n, _i, _l, prompts, cb) => {
      cb(prompts.map(() => connectCfg.password || ''));
    });

    conn.on('error', (err) => finish(normalizeSshError(err)));
    conn.on('close', () => finish(new Error('SSH connection closed before completing')));

    try {
      conn.connect(connectCfg);
    } catch (err) {
      finish(normalizeSshError(err));
    }
  });
}

/**
 * Run one command and collect stdout/stderr/exit code. Never throws on a non-zero exit.
 * `onOutput(text)` sees stdout and stderr as they arrive, for anything that shows live progress.
 */
export function exec(conn, command, { timeout = config.ssh.execTimeout, stdin = null, onOutput = null } = {}) {
  return new Promise((resolve, reject) => {
    conn.exec(command, { pty: false }, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      let code = null;

      const timer = setTimeout(() => {
        stream.close();
        resolve({ stdout, stderr: `${stderr}\n[timed out after ${timeout}ms]`, code: 124, timedOut: true });
      }, timeout);

      stream.on('close', (exitCode) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code: exitCode ?? code ?? 0, timedOut: false });
      });
      stream.on('data', (d) => { const t = d.toString('utf8'); stdout += t; onOutput?.(t); });
      stream.stderr.on('data', (d) => { const t = d.toString('utf8'); stderr += t; onOutput?.(t); });

      if (stdin !== null) {
        stream.write(stdin);
        stream.end();
      }
    });
  });
}

/**
 * Run a script with root privileges.
 *
 * The script is base64-encoded into the command line so quoting, newlines and
 * heredocs survive the trip, and only the sudo password ever travels on stdin.
 * Order of preference: already root → passwordless sudo → sudo with the stored
 * sudo password (falling back to the login password, which is what most people
 * set up on a fresh Ubuntu box).
 */
export function rootExec(conn, row, script, options = {}) {
  const payload = Buffer.from(script, 'utf8').toString('base64');
  const inner = `echo ${payload} | base64 -d | bash -s`;

  if (row.username === 'root') return exec(conn, `bash -c '${inner}'`, options);

  const password = sudoPassword(row);
  if (!password) return exec(conn, `sudo -n bash -c '${inner}'`, options);
  return exec(conn, `sudo -S -p '' bash -c '${inner}'`, { ...options, stdin: `${password}\n` });
}

/** Whatever this server can answer a sudo prompt with, if anything. */
function sudoPassword(row) {
  const stored = row.sudo_password_enc ? decrypt(row.sudo_password_enc) : null;
  if (stored) return stored;
  return row.auth_type === 'password' && row.password_enc ? decrypt(row.password_enc) : null;
}

/** Turn a privileged command's non-zero exit into a readable error. */
export function assertOk(result, what) {
  if (result.code === 0) return result;
  const detail = (result.stderr || result.stdout || '').trim().split('\n').slice(-6).join('\n');
  if (/sudo:.*(password is required|no tty|incorrect password)/i.test(detail)) {
    throw new Error(`${what} needs root on this server, but sudo asked for a password the panel does not have. `
      + 'Connect as root, give the SSH user passwordless sudo, or store its sudo password on the server.');
  }
  const err = new Error(`${what} failed${detail ? `: ${detail.slice(0, 400)}` : ` (exit code ${result.code})`}`);
  err.cause = detail;
  throw err;
}

/** Cheap reachability + identity probe used by "Test connection". */
export async function testConnection(connectCfg) {
  const started = Date.now();
  const result = await withConnection(connectCfg, async (conn) => {
    const who = await exec(conn, 'id -un; hostname; . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || echo unknown', { timeout: 10000 });
    const [user, hostname, ...os] = who.stdout.trim().split('\n');
    return { user, hostname, os: os.join(' ').trim() || 'unknown' };
  });
  return { ...result, latencyMs: Date.now() - started };
}

function normalizeSshError(err) {
  const msg = String(err?.message || err);
  const map = [
    [/All configured authentication methods failed/i, 'Authentication failed — check the username, password or private key.'],
    [/ECONNREFUSED/i, 'Connection refused — the SSH port is closed or sshd is not running.'],
    [/ETIMEDOUT|Timed out while waiting/i, 'Connection timed out — check the host/IP, firewall and security group rules.'],
    [/ENOTFOUND|EAI_AGAIN/i, 'Host not found — the hostname could not be resolved.'],
    [/EHOSTUNREACH|ENETUNREACH/i, 'Host unreachable from this machine.'],
    [/Cannot parse privateKey|Unsupported key format/i, 'Private key could not be parsed — paste the full PEM/OpenSSH key including header and footer lines.'],
    [/Encrypted private key detected|no passphrase given/i, 'The private key is encrypted — supply its passphrase.'],
  ];
  for (const [re, friendly] of map) {
    if (re.test(msg)) {
      const e = new Error(friendly);
      e.cause = msg;
      return e;
    }
  }
  return err instanceof Error ? err : new Error(msg);
}
