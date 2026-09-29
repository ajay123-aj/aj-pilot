/**
 * Is each server up?
 *
 * Two tiers, because "reachable" and "usable" are different questions and cost
 * very different amounts to answer:
 *
 *   every few seconds — a TCP connection to the SSH port. A handshake-free
 *     probe that takes milliseconds, so the server list can say online or
 *     offline within seconds of it changing.
 *
 *   every few minutes — a real SSH login. That is the only thing that proves
 *     the stored credentials still work, and it is far too expensive to run on
 *     the fast cadence: a full key exchange and authentication per server.
 *
 * The fast tier keeps its answers in memory and only writes to the database
 * when a server actually changes state, so watching a fleet every five seconds
 * does not mean a write per server per five seconds.
 */

import net from 'node:net';
import { all, run, logActivity } from '../db/index.js';
import { runWithContext } from './context.js';
import { config } from '../config.js';
import { connectionFromRow, withConnection, exec } from './ssh.js';

let timer = null;
let sweeping = false;

/** id → what the last probe found. The API overlays this on the stored rows. */
const live = new Map();

/** id → when this server was last logged into, so the deep check can stagger. */
const lastDeepCheck = new Map();

export const liveStatus = () => live;

/** Open a TCP connection to the SSH port and close it again. */
function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(error ? { ok: false, error } : { ok: true, latencyMs: Date.now() - started });
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(null));
    socket.once('timeout', () => finish(`No answer from ${host}:${port} within ${timeoutMs}ms — the host is down, or a firewall is dropping the connection.`));
    socket.once('error', (err) => finish(explainTcp(err, host, port)));

    try {
      socket.connect({ host, port });
    } catch (err) {
      finish(explainTcp(err, host, port));
    }
  });
}

/**
 * Servers behind a jump host cannot be dialled from here, so the fast tier asks
 * the jump host to open a channel to their SSH port instead. That costs an SSH
 * login to the jump host, so the answer is reused for a minute.
 */
const JUMP_PROBE_MS = 60000;
const jumpProbes = new Map();

async function jumpProbe(row, jumpRow) {
  const cached = jumpProbes.get(row.id);
  if (cached && Date.now() - cached.at < Math.max(JUMP_PROBE_MS, config.monitor.intervalMs)) return cached.result;

  const started = Date.now();
  const port = row.port || 22;
  let result;
  if (!jumpRow) {
    result = { ok: false, error: 'Its jump host no longer exists — edit the server and pick another one.' };
  } else {
    try {
      await withConnection({ ...connectionFromRow(jumpRow), readyTimeout: config.monitor.sshTimeoutMs }, (conn) => new Promise((resolve, reject) => {
        // The jump host waits on its own TCP timeout (minutes) for an address it
        // has no route to; that must not hold up the whole sweep.
        const timer = setTimeout(() => reject(new Error(`Jump host ${jumpRow.name} cannot reach ${row.host}:${port} `
          + `(no answer within ${config.monitor.sshTimeoutMs / 1000}s — is its VPN connected?).`)), config.monitor.sshTimeoutMs);
        conn.forwardOut('127.0.0.1', 0, row.host, port, (err, stream) => {
          clearTimeout(timer);
          if (err) return reject(new Error(`Jump host ${jumpRow.name} cannot reach ${row.host}:${port} (${err.message}).`));
          stream.close();
          resolve();
        });
      }));
      result = { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
      result = { ok: false, error: /^Jump host /.test(err.message) ? err.message : `Jump host ${jumpRow.name}: ${err.message}` };
    }
  }
  jumpProbes.set(row.id, { at: Date.now(), result });
  return result;
}

function explainTcp(err, host, port) {
  const code = err?.code || '';
  if (code === 'ECONNREFUSED') return `Nothing is listening on ${host}:${port} — the host is up but sshd is not.`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `${host} could not be resolved.`;
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return `${host} is unreachable from this machine.`;
  if (code === 'ETIMEDOUT') return `${host}:${port} did not answer in time.`;
  return err?.message || String(err);
}

/** The deeper check: log in and run the smallest possible command. */
async function sshProbe(row) {
  const started = Date.now();
  await withConnection(
    { ...connectionFromRow(row), readyTimeout: config.monitor.sshTimeoutMs },
    (conn) => exec(conn, 'true', { timeout: config.monitor.sshTimeoutMs })
  );
  return Date.now() - started;
}

/**
 * Probe one server and remember the answer. The row is only written when the
 * status changes — that is what keeps a five-second cadence cheap.
 */
async function checkServer(row, byId) {
  const probe = row.jump_server_id
    ? await jumpProbe(row, byId.get(row.jump_server_id))
    : await tcpProbe(row.host, row.port || 22, config.monitor.timeoutMs);
  const status = probe.ok ? 'online' : 'offline';
  const previous = live.get(row.id)?.status ?? row.status;

  const state = {
    status,
    latencyMs: probe.ok ? probe.latencyMs : null,
    error: probe.ok ? null : probe.error,
    checkedAt: new Date().toISOString(),
    // Carried over from the deep tier, which runs far less often.
    authOk: live.get(row.id)?.authOk ?? null,
    authError: live.get(row.id)?.authError ?? null,
    authCheckedAt: live.get(row.id)?.authCheckedAt ?? null,
  };
  live.set(row.id, state);

  if (previous !== status) {
    await run('UPDATE servers SET status = ?, last_error = ?, last_checked_at = NOW() WHERE id = ?',
      [status, state.error, row.id]);
    await runWithContext({ orgId: row.org_id }, () => logActivity(
      'server',
      row.id,
      status === 'online' ? 'went_online' : 'went_offline',
      status === 'online'
        ? `${row.name} (${row.host}) is reachable again — ${state.latencyMs}ms`
        : `${row.name} (${row.host}) is unreachable: ${state.error}`,
      status === 'online' ? 'info' : 'error'
    ));
  }

  // Only somewhere reachable is worth trying to log into, and only now and then.
  if (status === 'online' && dueForDeepCheck(row.id)) await deepCheck(row, state);

  return status;
}

function dueForDeepCheck(id) {
  const last = lastDeepCheck.get(id) || 0;
  return Date.now() - last >= config.monitor.sshMinutes * 60000;
}

/**
 * Prove the stored credentials still work. A port that answers says the machine
 * is up; it says nothing about whether the panel can still get into it.
 */
async function deepCheck(row, state) {
  lastDeepCheck.set(row.id, Date.now());
  const was = state.authOk;

  try {
    const latencyMs = await sshProbe(row);
    Object.assign(state, { authOk: true, authError: null, authCheckedAt: new Date().toISOString(), sshLatencyMs: latencyMs });
    if (was === false) {
      await run('UPDATE servers SET last_error = NULL WHERE id = ?', [row.id]);
      await runWithContext({ orgId: row.org_id }, () => logActivity(
        'server', row.id, 'sign_in_ok', `The panel can sign in to ${row.name} again`
      ));
    }
  } catch (err) {
    Object.assign(state, { authOk: false, authError: err.message, authCheckedAt: new Date().toISOString() });
    if (was !== false) {
      await run('UPDATE servers SET last_error = ? WHERE id = ?', [err.message, row.id]);
      await runWithContext({ orgId: row.org_id }, () => logActivity(
        'server', row.id, 'sign_in_failed',
        `${row.name} answers on its SSH port but the panel cannot sign in: ${err.message}`, 'error'
      ));
    }
  }
}

/**
 * Check every server once, `concurrency` at a time.
 * Returns a tally, or null if a sweep was already running.
 */
export async function runHealthSweep() {
  if (sweeping) return null;
  sweeping = true;
  const started = Date.now();

  try {
    const rows = await all('SELECT id, org_id, name, host, port, username, status, auth_type, password_enc, private_key_enc, passphrase_enc, sudo_password_enc, jump_server_id FROM servers');
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of live.keys()) if (!byId.has(id)) live.delete(id);
    for (const id of jumpProbes.keys()) if (!byId.get(id)?.jump_server_id) jumpProbes.delete(id);

    const tally = { checked: 0, online: 0, offline: 0 };
    let next = 0;

    const worker = async () => {
      while (next < rows.length) {
        const row = rows[next++];
        try {
          const status = await checkServer(row, byId);
          tally.checked += 1;
          tally[status] += 1;
        } catch (err) {
          // A failed write must not stop the rest of the sweep.
          console.error(`[monitor] ${row.name}: ${err.message}`);
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(config.monitor.concurrency, rows.length) }, worker));
    return { ...tally, durationMs: Date.now() - started };
  } finally {
    sweeping = false;
  }
}

/**
 * Start the repeating sweep. The next run is scheduled only once the previous
 * one has finished, so a slow fleet can never stack sweeps on top of each other.
 */
export function startHealthMonitor() {
  if (timer) return;
  if (!config.monitor.enabled) {
    console.log('  Connection monitor: disabled (HEALTH_CHECK_ENABLED=false)');
    return;
  }

  const seconds = Math.round(config.monitor.intervalMs / 1000);
  console.log(`  Connection monitor: TCP every ${seconds}s, sign-in every ${config.monitor.sshMinutes}m, `
    + `${config.monitor.concurrency} at a time`);

  const schedule = (delay) => {
    timer = setTimeout(tick, delay);
    timer.unref?.();
  };

  const tick = async () => {
    try {
      await runHealthSweep();
    } catch (err) {
      console.error('[monitor] sweep failed:', err.message);
    }
    schedule(config.monitor.intervalMs);
  };

  schedule(2000); // let the server finish booting before the first sweep
}

export function stopHealthMonitor() {
  if (timer) clearTimeout(timer);
  timer = null;
}
