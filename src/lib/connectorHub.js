/**
 * Connectors: reaching servers through someone's PC.
 *
 * Office machines behind a VPN are reachable from a laptop that has the VPN up,
 * and from nowhere else. A connector is a small program on that laptop
 * (public/connector/aj-pilot-connector.mjs). It dials *out* to the panel over a
 * WebSocket — no open ports, works behind any router — and from then on the
 * panel can ask it to open TCP connections as if they came from the laptop.
 * SSH to a server set to "connect via connector" runs inside one of those.
 *
 * Wire format, one WebSocket per connector:
 *   text   {"t":"hello","token":…,"hostname":…}      connector → panel, first message
 *   text   {"t":"welcome","name":…} / {"t":"denied"}  panel → connector
 *   text   {"t":"open","id":n,"host":…,"port":…}      panel → connector
 *   text   {"t":"opened","id":n} / {"t":"error","id":n,"message":…}
 *   text   {"t":"close","id":n}                       either way
 *   binary [uint32 id][bytes]                         data for channel n, either way
 */

import crypto from 'node:crypto';
import { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { one, run, logActivity } from '../db/index.js';
import { runWithContext } from './context.js';

export const CONNECTOR_PATH = '/api/connectors/ws';
const HELLO_TIMEOUT_MS = 10000;
// Every 5s each side says it is there; 15s of silence means the link is gone.
const HEARTBEAT_MS = 5000;
const DEAD_AFTER_MS = 15000;

/** connector id → the live session, while its program is running. */
const sessions = new Map();

export const newToken = () => `ajc_${crypto.randomBytes(24).toString('base64url')}`;
export const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/** What the panel knows about a running connector, or null when it is not running. */
export function connectorLive(id) {
  const s = sessions.get(Number(id));
  if (!s) return null;
  return { since: s.since, hostname: s.info.hostname || null, platform: s.info.platform || null, version: s.info.version || null, address: s.address, channels: s.channels.size };
}

/** Ids of this organisation's connectors that are running right now. */
export function liveConnectorIds(orgId) {
  if (orgId == null) return [];
  return [...sessions.values()].filter((s) => s.orgId === Number(orgId)).map((s) => s.id);
}

/** Stop a connector's session now (its token was revoked or it was deleted). */
export function dropConnector(id, reason = 'revoked') {
  const s = sessions.get(Number(id));
  if (!s) return;
  try { s.ws.send(JSON.stringify({ t: 'denied', reason })); } catch { /* going anyway */ }
  s.ws.close(4001, reason);
}

/** Take WebSocket upgrades on CONNECTOR_PATH off the HTTP server. */
export function attachConnectorHub(httpServer) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  httpServer.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try { pathname = new URL(req.url, 'http://panel').pathname; } catch { /* bad url */ }
    if (pathname !== CONNECTOR_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => accept(ws, req));
  });

  // Notice within seconds when a PC sleeps, loses its network or is closed,
  // and keep idle links alive through proxies.
  setInterval(() => {
    const now = Date.now();
    for (const s of sessions.values()) {
      if (now - s.lastHeard > DEAD_AFTER_MS) { s.ws.terminate(); continue; }
      try { s.ws.ping(); } catch { /* closing */ }
    }
  }, HEARTBEAT_MS).unref();
}

function clientAddress(req) {
  return String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    .split(',')[0].trim().slice(0, 64);
}

function accept(ws, req) {
  const address = clientAddress(req);
  const helloTimer = setTimeout(() => ws.close(4000, 'no hello'), HELLO_TIMEOUT_MS);

  ws.once('message', async (data, isBinary) => {
    clearTimeout(helloTimer);
    let hello = null;
    try { hello = isBinary ? null : JSON.parse(String(data)); } catch { /* not json */ }
    if (!hello || hello.t !== 'hello' || !hello.token) {
      ws.close(4000, 'bad hello');
      return;
    }

    const row = await one('SELECT * FROM connectors WHERE token_hash = ?', [hashToken(hello.token)]).catch(() => null);
    if (!row) {
      ws.send(JSON.stringify({ t: 'denied', reason: 'This connector token is not valid any more. Create a new one in the panel.' }));
      ws.close(4001, 'denied');
      return;
    }

    // One program per connector: a second copy replaces the first.
    const previous = sessions.get(row.id);
    if (previous) {
      try { previous.ws.send(JSON.stringify({ t: 'denied', reason: 'Another copy of this connector started somewhere else.' })); } catch { /* ok */ }
      previous.ws.close(4002, 'replaced');
    }

    const info = {
      hostname: String(hello.hostname || '').slice(0, 255),
      platform: String(hello.platform || '').slice(0, 100),
      version: String(hello.version || '').slice(0, 40),
    };
    const session = { id: row.id, orgId: row.org_id, name: row.name, ws, info, address, since: new Date().toISOString(), channels: new Map(), nextId: 1, lastHeard: Date.now() };
    sessions.set(row.id, session);

    ws.on('pong', () => { session.lastHeard = Date.now(); });
    ws.on('message', (msg, binary) => onMessage(session, msg, binary));
    ws.on('close', () => onClose(session));
    ws.on('error', () => { /* close follows */ });

    ws.send(JSON.stringify({ t: 'welcome', name: row.name }));
    await run('UPDATE connectors SET hostname = ?, platform = ?, version = ?, last_ip = ?, last_seen_at = NOW() WHERE id = ?',
      [info.hostname, info.platform, info.version, address, row.id]).catch(() => {});
    await runWithContext({ orgId: row.org_id }, () => logActivity(
      'connector', row.id, 'connector_online', `Connector ${row.name} is running on ${info.hostname || 'a PC'} (${address})`
    )).catch(() => {});
  });

  ws.on('error', () => { /* handled by close */ });
}

function onMessage(session, data, isBinary) {
  session.lastHeard = Date.now();
  if (isBinary) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 4) return;
    const ch = session.channels.get(buf.readUInt32BE(0));
    if (ch?.stream) ch.stream.push(buf.subarray(4));
    return;
  }

  let msg;
  try { msg = JSON.parse(String(data)); } catch { return; }
  // The connector's heartbeat: answer, so it knows the panel is still there.
  if (msg.t === 'ping') {
    try { session.ws.send(JSON.stringify({ t: 'pong' })); } catch { /* closing */ }
    return;
  }
  const ch = session.channels.get(Number(msg.id));
  if (!ch) return;

  if (msg.t === 'opened' && ch.pending) {
    const { resolve, timer } = ch.pending;
    clearTimeout(timer);
    ch.pending = null;
    resolve(ch.stream);
  } else if (msg.t === 'error') {
    fail(session, ch, Number(msg.id), new Error(String(msg.message || 'the connector could not connect')));
  } else if (msg.t === 'close') {
    session.channels.delete(Number(msg.id));
    if (ch.pending) {
      fail(session, ch, Number(msg.id), new Error('the connection was closed'));
    } else {
      ch.stream.push(null);
      ch.stream.end();
    }
  }
}

function fail(session, ch, id, err) {
  session.channels.delete(id);
  if (ch.pending) {
    clearTimeout(ch.pending.timer);
    ch.pending.reject(err);
    ch.pending = null;
  } else {
    ch.stream.destroy(err);
  }
}

function onClose(session) {
  if (sessions.get(session.id) === session) sessions.delete(session.id);
  for (const [id, ch] of session.channels) fail(session, ch, id, new Error(`Connector ${session.name} disconnected`));
  run('UPDATE connectors SET last_seen_at = NOW() WHERE id = ?', [session.id]).catch(() => {});
  runWithContext({ orgId: session.orgId }, () => logActivity(
    'connector', session.id, 'connector_offline', `Connector ${session.name} stopped (${session.info.hostname || 'PC'})`
  )).catch(() => {});
}

/**
 * A TCP connection to host:port made by the connector's PC, as a Duplex stream
 * ssh2 can use as its socket. Rejects when the connector is not running, the PC
 * cannot reach the address, or nothing answers within `timeoutMs`.
 */
export async function openViaConnector(connectorId, host, port, { timeoutMs = 15000 } = {}) {
  const session = sessions.get(Number(connectorId));
  if (!session) {
    const row = await one('SELECT name FROM connectors WHERE id = ?', [connectorId]).catch(() => null);
    const err = new Error(row
      ? `Connector ${row.name} is not running. Start it on your PC (with the VPN connected), then try again.`
      : 'The connector for this server no longer exists — edit the server and choose another way to connect.');
    err.passThrough = true;
    throw err;
  }

  const id = session.nextId++;
  const send = (obj) => { if (session.ws.readyState === 1) session.ws.send(JSON.stringify(obj)); };
  const header = Buffer.alloc(4);
  header.writeUInt32BE(id);

  const stream = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      if (session.ws.readyState !== 1) return cb(new Error(`Connector ${session.name} disconnected`));
      session.ws.send(Buffer.concat([header, chunk]), cb);
      return undefined;
    },
    final(cb) {
      if (session.channels.delete(id)) send({ t: 'close', id });
      cb();
    },
    destroy(err, cb) {
      if (session.channels.delete(id)) send({ t: 'close', id });
      cb(err);
    },
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!session.channels.has(id)) return;
      session.channels.delete(id);
      send({ t: 'close', id });
      const err = new Error(`${session.info.hostname || 'The PC'} running connector ${session.name} could not reach ${host}:${port} within ${Math.round(timeoutMs / 1000)}s — is its VPN connected?`);
      err.passThrough = true;
      reject(err);
    }, timeoutMs);

    session.channels.set(id, {
      stream,
      pending: {
        timer,
        resolve,
        reject: (err) => {
          const e = new Error(`${session.info.hostname || 'The PC'} running connector ${session.name} could not reach ${host}:${port}: ${err.message}`);
          e.passThrough = true;
          reject(e);
        },
      },
    });
    send({ t: 'open', id, host, port: Number(port) });
  });
}
