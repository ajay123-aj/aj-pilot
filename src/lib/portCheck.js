/**
 * Is a host port free on a server? Asked before a service is created or its
 * containers move, so the deploy never starts on a port Docker will refuse.
 *
 * Two places to look: the panel's own apps on that server (known without SSH),
 * and whatever is listening on the machine right now — another container, a
 * database, something started by hand.
 */

import { all } from '../db/index.js';
import { connectionFromRow, withConnection, exec } from './ssh.js';
import { plannedContainers } from './deploy.js';

const asJson = (v) => {
  if (!v) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
  return v;
};

/** Ports listening on the server, from `ss` (or `netstat` on an older box). */
async function listeningPorts(server) {
  return withConnection(connectionFromRow(server), async (conn) => {
    const r = await exec(conn, "ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null | tail -n +3", { timeout: 15000 });
    const ports = new Set();
    for (const line of r.stdout.split('\n')) {
      const cols = line.trim().split(/\s+/);
      const local = cols[0] === 'LISTEN' ? cols[3] : /^tcp/.test(cols[0] || '') ? cols[3] : null;
      const port = local ? Number(local.slice(local.lastIndexOf(':') + 1)) : 0;
      if (port) ports.add(port);
    }
    return ports;
  });
}

/**
 * Which of `ports` are already taken on `server`, each with what holds it.
 * `exceptAppId` leaves one app out — the one whose ports are being changed.
 * `checked` is false when the server could not be asked, so only the panel's
 * own apps were compared.
 */
export async function portsInUse(server, ports, { exceptAppId = null, live = true } = {}) {
  const wanted = [...new Set(ports.map(Number).filter((p) => Number.isInteger(p) && p > 0))];
  const busy = new Map();

  const apps = await all("SELECT id, name, port, instances, container_ports FROM apps WHERE server_id = ? AND status <> 'removing'", [server.id]);
  const own = new Set();
  for (const a of apps) {
    const held = plannedContainers({ name: a.name, port: a.port, instances: a.instances, ports: asJson(a.container_ports) }).map((c) => c.port);
    if (exceptAppId && String(a.id) === String(exceptAppId)) { held.forEach((p) => own.add(p)); continue; }
    for (const p of held) if (wanted.includes(p) && !busy.has(p)) busy.set(p, a.name);
  }

  let checked = false;
  if (live) {
    try {
      const listening = await listeningPorts(server);
      checked = true;
      for (const p of wanted) {
        // The app being changed is listening on its own ports; that is not a clash.
        if (listening.has(p) && !busy.has(p) && !own.has(p)) busy.set(p, 'another program');
      }
    } catch { /* unreachable: the panel's own apps were still compared */ }
  }

  return { busy: [...busy].map(([port, by]) => ({ port, by })), checked };
}

/** "Port 3000 is already used on web-1 by shop-api." for an error reply. */
export function portClashMessage(server, busy) {
  return busy.map((b) => `Port ${b.port} is already used on ${server.name} by ${b.by}.`).join(' ')
    + ' Pick a different port.';
}
