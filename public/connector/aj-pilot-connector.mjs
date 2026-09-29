#!/usr/bin/env node
/*
 * AJ Pilot Connector
 *
 * Lets your AJ Pilot panel reach servers that only this PC can reach — for
 * example office servers behind the VPN you have connected here. It makes one
 * outgoing, encrypted connection to the panel; nothing is opened on this PC.
 *
 *   node aj-pilot-connector.mjs                      (panel address and token built in when downloaded)
 *   node aj-pilot-connector.mjs --url https://your-panel --token ajc_…
 *   node aj-pilot-connector.mjs --allow 192.168.0.0/24,192.168.1.0/24   (only these networks)
 *
 * Needs Node.js 22 or newer (https://nodejs.org). Stop it with Ctrl+C.
 */

import net from 'node:net';
import os from 'node:os';

const BAKED = { url: '', token: '' }; // filled in when downloaded from the panel
const VERSION = '1.0.0';

/* ------------------------------------------------------------ options */

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const panelUrl = arg('url') || process.env.AJ_PILOT_URL || BAKED.url;
const token = arg('token') || process.env.AJ_PILOT_TOKEN || BAKED.token;
const allowList = String(arg('allow') || process.env.AJ_PILOT_ALLOW || '').split(',').map((s) => s.trim()).filter(Boolean);

const stamp = () => new Date().toLocaleTimeString();
const say = (text) => console.log(`[${stamp()}] ${text}`);

if (typeof WebSocket === 'undefined') {
  const how = process.platform === 'win32' ? 'winget upgrade OpenJS.NodeJS.LTS'
    : process.platform === 'darwin' ? 'brew upgrade node'
    : 'curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs';
  console.error(`This connector needs Node.js 22 or newer (you have ${process.version}).\n`
    + `Update it with:  ${how}\nor download it from https://nodejs.org — then start the connector again.`);
  process.exit(1);
}
if (!panelUrl || !token) {
  console.error('Missing the panel address or token. Download the connector from the panel (Servers → Connectors), or run:\n'
    + '  node aj-pilot-connector.mjs --url https://your-panel --token ajc_…');
  process.exit(1);
}

const wsUrl = `${panelUrl.replace(/\/+$/, '').replace(/^http/i, 'ws')}/api/connectors/ws`;

/* ---------------------------------------------------- allowed targets */

const ipNum = (ip) => ip.split('.').reduce((a, o) => ((a << 8) | Number(o)) >>> 0, 0);
const isIpv4 = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);

function allowed(host) {
  if (!allowList.length) return true;
  return allowList.some((rule) => {
    if (rule === host) return true;
    const [net4, bits] = rule.split('/');
    if (!isIpv4(host) || !isIpv4(net4)) return false;
    const b = Number(bits ?? 32);
    const mask = b === 0 ? 0 : (0xffffffff << (32 - b)) >>> 0;
    return ((ipNum(host) & mask) >>> 0) === ((ipNum(net4) & mask) >>> 0);
  });
}

/* ------------------------------------------------------------ tunnel */

// Every 5s: say we are here, and check the panel still answers.
const HEARTBEAT_MS = 5000;
const DEAD_AFTER_MS = 15000;
const MAX_RETRY_MS = 5000;

let backoff = 1000;
let stopped = false;

function connect() {
  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';
  const sockets = new Map();
  let welcomed = false;
  let keepalive = null;
  let lastHeard = Date.now();

  const sendJson = (obj) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };

  ws.onopen = () => {
    sendJson({ t: 'hello', token, hostname: os.hostname(), platform: `${os.type()} ${os.release()}`, version: VERSION });
    lastHeard = Date.now();
    keepalive = setInterval(() => {
      if (Date.now() - lastHeard > DEAD_AFTER_MS) {
        say('The panel stopped answering.');
        ws.close();
        return;
      }
      sendJson({ t: 'ping' });
    }, HEARTBEAT_MS);
  };

  ws.onmessage = (ev) => {
    lastHeard = Date.now();
    if (typeof ev.data !== 'string') {
      const buf = Buffer.from(ev.data);
      const sock = sockets.get(buf.readUInt32BE(0));
      if (sock && !sock.destroyed) sock.write(buf.subarray(4));
      return;
    }
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.t === 'welcome') {
      welcomed = true;
      backoff = 1000;
      say(`Connected to ${panelUrl} as "${msg.name}". Leave this window open.`);
      if (allowList.length) say(`Only allowing: ${allowList.join(', ')}`);
    } else if (msg.t === 'denied') {
      stopped = true;
      say(`The panel refused this connector: ${msg.reason || 'invalid token'}`);
      ws.close();
    } else if (msg.t === 'open') {
      openChannel(msg.id, String(msg.host), Number(msg.port));
    } else if (msg.t === 'close') {
      sockets.get(msg.id)?.destroy();
      sockets.delete(msg.id);
    }
  };

  function openChannel(id, host, port) {
    if (!allowed(host)) {
      sendJson({ t: 'error', id, message: `${host} is not in this connector's --allow list` });
      say(`Refused ${host}:${port} (not in --allow list)`);
      return;
    }
    let opened = false;
    const sock = net.connect({ host, port });
    sockets.set(id, sock);
    sock.setNoDelay(true);
    sock.setTimeout(15000, () => { if (!opened) sock.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })); });

    sock.on('connect', () => {
      opened = true;
      sock.setTimeout(0);
      sendJson({ t: 'opened', id });
      say(`→ ${host}:${port}`);
    });
    sock.on('data', (chunk) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const frame = Buffer.allocUnsafe(4 + chunk.length);
      frame.writeUInt32BE(id, 0);
      chunk.copy(frame, 4);
      ws.send(frame);
      // Do not let a fast server outrun a slow link.
      if (ws.bufferedAmount > 8 * 1024 * 1024) {
        sock.pause();
        const wait = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount < 1024 * 1024) { clearInterval(wait); sock.resume(); }
        }, 50);
      }
    });
    sock.on('error', (err) => {
      if (!opened) {
        const why = { ECONNREFUSED: 'connection refused', ETIMEDOUT: 'no answer (timed out)', EHOSTUNREACH: 'host unreachable', ENETUNREACH: 'network unreachable', ENOTFOUND: 'host name not found' }[err.code] || err.message;
        sendJson({ t: 'error', id, message: why });
        say(`✗ ${host}:${port} — ${why}${/timed out|unreachable/.test(why) ? ' (is the VPN connected on this PC?)' : ''}`);
      }
    });
    sock.on('close', () => {
      if (sockets.get(id) === sock) {
        sockets.delete(id);
        if (opened) sendJson({ t: 'close', id });
      }
    });
  }

  ws.onclose = (ev) => {
    clearInterval(keepalive);
    for (const s of sockets.values()) s.destroy();
    sockets.clear();
    if (stopped || ev.code === 4001 || ev.code === 4002) {
      if (!stopped) say(`Disconnected: ${ev.reason || 'refused by the panel'}`);
      process.exit(1);
    }
    say(`${welcomed ? 'Lost the connection to the panel' : `Could not connect to ${panelUrl}`} — retrying in ${Math.round(backoff / 1000)}s…`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, MAX_RETRY_MS);
  };

  ws.onerror = () => { /* onclose follows */ };
}

say(`AJ Pilot Connector ${VERSION} on ${os.hostname()}`);
connect();

process.on('SIGINT', () => { say('Stopped.'); process.exit(0); });
