/**
 * A live shell on a server, in the browser.
 *
 * The server page opens a WebSocket to TERMINAL_PATH?server=<id>; the panel
 * checks it the way every API call is checked — the session cookie, the same
 * site, an organisation with a plan, a role allowed to change things, and a
 * server that belongs to that organisation — then opens an SSH shell with a
 * pseudo-terminal and pipes it both ways.
 *
 *   browser → panel  {"t":"in","d":"ls\r"}  keystrokes
 *                    {"t":"resize","cols":120,"rows":32}
 *   panel → browser  binary frames          what the shell prints
 *                    {"t":"ready"} / {"t":"error","message"} / {"t":"exit","code"}
 *
 * Only that the shell was opened and closed is logged — never what was typed.
 */

import { WebSocketServer } from 'ws';
import { one, logActivity } from '../db/index.js';
import { loadSession, orgOf } from './authGuard.js';
import { runWithContext } from './context.js';
import { can } from './auth.js';
import { ownHosts } from './security.js';
import { currentSubscription, trialState } from './plans.js';
import { connectionFromRow, withConnection } from './ssh.js';

export const TERMINAL_PATH = '/api/terminal/ws';

// A shell nobody has typed into for this long is closed.
const IDLE_MS = 30 * 60000;
// Open shells per user, across every tab.
const MAX_PER_USER = 5;
const open = new Map(); // user id → count

const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

/** Why this upgrade may not have a shell, or null when it may. */
async function refuse(req, serverId) {
  // A WebSocket is not covered by the CSRF check on /api, so the origin is checked here.
  let origin = null;
  try { origin = new URL(req.headers.origin).host.toLowerCase(); } catch { /* none */ }
  if (!origin || !ownHosts(req).has(origin)) return { code: 403, message: 'Cross-site request refused' };

  const found = await loadSession(req);
  if (!found) return { code: 401, message: 'Sign in to continue' };
  const { user } = found;
  const orgId = orgOf(user);
  if (!orgId) return { code: 403, message: 'Open an organisation first' };
  if (!can(user, 'edit')) return { code: 403, message: 'Your role cannot run commands on servers' };

  const org = await one('SELECT * FROM organisations WHERE id = ?', [orgId]);
  if (org?.status === 'suspended' && user.role !== 'super_admin') return { code: 403, message: 'This organisation is suspended' };
  if (user.role !== 'super_admin') {
    const sub = await currentSubscription(orgId);
    if (!sub || trialState(sub)?.expired) return { code: 402, message: 'Your organisation has no active plan' };
  }

  const server = await one('SELECT * FROM servers WHERE id = ? AND org_id = ?', [serverId, orgId]);
  if (!server) return { code: 404, message: 'Server not found' };
  if ((open.get(user.id) || 0) >= MAX_PER_USER) return { code: 429, message: `You already have ${MAX_PER_USER} terminals open — close one first` };
  return { user, orgId, server };
}

/** Handle an upgrade on TERMINAL_PATH (the connector hub hands these over). */
export async function handleTerminalUpgrade(req, socket, head) {
  let serverId = 0;
  try { serverId = Number(new URL(req.url, 'http://panel').searchParams.get('server')) || 0; } catch { /* bad url */ }
  let check;
  try {
    check = await refuse(req, serverId);
  } catch {
    check = { code: 500, message: 'Could not check your session' };
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (check.code) {
      ws.send(JSON.stringify({ t: 'error', message: check.message }));
      ws.close(4000 + check.code, check.message.slice(0, 100));
      return;
    }
    // Run in the user's context so the activity log records who and which organisation.
    runWithContext({ user: check.user, orgId: check.orgId }, () => runShell(ws, check));
  });
}

async function runShell(ws, { user, server }) {
  open.set(user.id, (open.get(user.id) || 0) + 1);
  const send = (msg) => { if (ws.readyState === ws.OPEN) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); };
  const startedAt = Date.now();
  await logActivity('server', server.id, 'terminal_opened', `${user.name} opened a terminal on "${server.name}"`).catch(() => {});

  try {
    await withConnection(connectionFromRow(server), (conn) => new Promise((resolve, reject) => {
      conn.shell({ term: 'xterm-256color', cols: 120, rows: 32 }, (err, stream) => {
        if (err) return reject(err);
        send({ t: 'ready' });

        let idle;
        const touch = () => {
          clearTimeout(idle);
          idle = setTimeout(() => {
            send({ t: 'error', message: 'Closed after 30 minutes without input' });
            stream.close();
          }, IDLE_MS);
        };
        touch();

        stream.on('data', (d) => { if (ws.readyState === ws.OPEN) ws.send(d, { binary: true }); });
        stream.stderr.on('data', (d) => { if (ws.readyState === ws.OPEN) ws.send(d, { binary: true }); });
        stream.on('exit', (code) => send({ t: 'exit', code }));
        stream.on('close', () => { clearTimeout(idle); resolve(); });

        ws.on('message', (data) => {
          let msg;
          try { msg = JSON.parse(String(data)); } catch { return; }
          if (msg.t === 'in' && typeof msg.d === 'string') {
            touch();
            stream.write(msg.d);
          } else if (msg.t === 'resize') {
            const cols = Math.max(20, Math.min(500, Number(msg.cols) || 0));
            const rows = Math.max(5, Math.min(200, Number(msg.rows) || 0));
            stream.setWindow(rows, cols, 0, 0);
          }
        });
        // The tab closed or the page moved on: end the shell with it.
        ws.on('close', () => stream.close());
      });
    }));
  } catch (err) {
    send({ t: 'error', message: err.message || 'Could not open a shell' });
  } finally {
    const left = (open.get(user.id) || 1) - 1;
    if (left) open.set(user.id, left); else open.delete(user.id);
    const minutes = Math.max(1, Math.round((Date.now() - startedAt) / 60000));
    await logActivity('server', server.id, 'terminal_closed', `${user.name} closed the terminal on "${server.name}" after ${minutes} min`).catch(() => {});
    if (ws.readyState === ws.OPEN) ws.close(1000, 'closed');
  }
}
