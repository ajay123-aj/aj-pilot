/**
 * PostgreSQL, MongoDB and Redis connections — the same pages MySQL has, served
 * by whichever engine module matches the credential's provider.
 *
 * Reads are POSTs listed as read-only in authGuard, so a viewer can look.
 * Creating needs "create", changing needs "edit", dropping and revoking "delete".
 */

import { Router } from 'express';
import { one, all, run, logActivity } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { asJson } from '../lib/gitAccounts.js';
import { engineFor, DATABASE_PROVIDERS } from '../lib/engines/index.js';
import { pulse as mysqlPulse } from '../lib/mysql.js';
import * as redisKeys from '../lib/engines/redisKeys.js';

export const dbEnginesRouter = Router();

const getRow = (id, orgId) => one('SELECT * FROM credentials WHERE id = ? AND org_id = ?', [id, orgId]);

/** A stored credential (or the add-connection form) as a connection config, with its server for tunnelling. */
async function engineConfig(source, orgId, { fromForm = false } = {}) {
  const extra = fromForm ? source : asJson(source.extra);
  const serverId = Number(source.server_id) || null;
  let server = null;
  if (serverId) {
    server = await one('SELECT * FROM servers WHERE id = ? AND org_id = ?', [serverId, orgId]);
    if (!server) throw new Error('The server this connection tunnels through no longer exists');
  }
  return {
    host: String(extra.host || '127.0.0.1').trim(),
    port: Number(extra.port || DATABASE_PROVIDERS[source.provider]?.defaultPort),
    user: String(source.username || '').trim(),
    password: fromForm ? String(source.secret || '') : decrypt(source.secret_enc),
    database: String(extra.database || '').trim() || null,
    authSource: String(extra.authSource || '').trim() || null,
    tls: extra.tls === true || extra.tls === 'on' || extra.tls === 'true',
    server,
  };
}

/**
 * Wrap one engine call. A read that fails marks the connection invalid, as
 * MySQL's do; a change that fails leaves it alone (the connection is fine,
 * the change was refused) and goes into the activity log.
 */
function engineRoute(handler, { manage = false } = {}) {
  return async (req, res) => {
    let row;
    try {
      row = await getRow(req.params.id, req.orgId);
      if (!row) return res.status(404).json({ error: 'Connection not found' });
      const engine = engineFor(row.provider);
      if (!engine) return res.status(400).json({ error: `${row.provider} connections do not use these pages` });
      const result = await handler(engine, await engineConfig(row, req.orgId), req, row);
      if (!manage) await run("UPDATE credentials SET status='valid', last_error=NULL, verified_at=NOW() WHERE id=?", [row.id]);
      res.json({ ok: true, engine: row.provider, ...result });
    } catch (err) {
      if (row) {
        if (manage) await logActivity('credential', row.id, 'db_manage_failed', `${req.method} ${req.path}: ${err.message}`, 'error');
        else await run("UPDATE credentials SET status='invalid', last_error=? WHERE id=?", [err.message, row.id]).catch(() => {});
      }
      res.status(400).json({ ok: false, error: err.message, detail: err.cause || null });
    }
  };
}

const manage = (action, handler) => engineRoute(async (engine, cfg, req, row) => {
  const result = await handler(engine, cfg, req.body || {});
  await logActivity('credential', row.id, `db_${action}`, `${DATABASE_PROVIDERS[row.provider].label} "${row.name}": ${result.summary}`,
    /drop|revoke|flush|deleted/.test(action) ? 'warn' : 'info');
  return result;
}, { manage: true });

/* --------------------------------------------------------------- test */

/** Try the details on the add-connection form before saving them. */
dbEnginesRouter.post('/test-db', async (req, res) => {
  const engine = engineFor(req.body.provider);
  if (!engine) return res.status(400).json({ error: 'Pick PostgreSQL, MongoDB or Redis' });
  try {
    res.json({ ok: true, ...(await engine.test(await engineConfig(req.body, req.orgId, { fromForm: true }))) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message, detail: err.cause || null });
  }
});

/* -------------------------------------------------------------- reads */

dbEnginesRouter.post('/:id/db/overview', engineRoute(async (engine, cfg, req, row) => {
  const o = await engine.overview(cfg);
  await logActivity('credential', row.id, 'db_inspected', `Read ${DATABASE_PROVIDERS[row.provider].label} "${row.name}" in ${o.durationMs}ms`);
  return { ...o, queryHelp: engine.queryHelp };
}));
dbEnginesRouter.post('/:id/db/databases', engineRoute((engine, cfg) => engine.databases(cfg)));
dbEnginesRouter.post('/:id/db/database', engineRoute((engine, cfg, req) => engine.database(cfg, String(req.body.name || ''))));
dbEnginesRouter.post('/:id/db/item', engineRoute((engine, cfg, req) => engine.item(cfg, String(req.body.database || ''), String(req.body.item || ''))));
dbEnginesRouter.post('/:id/db/users/list', engineRoute((engine, cfg) => engine.users(cfg)));
dbEnginesRouter.post('/:id/db/config', engineRoute((engine, cfg) => engine.config(cfg)));
dbEnginesRouter.post('/:id/db/query', engineRoute(async (engine, cfg, req, row) => {
  const result = await engine.query(cfg, { text: req.body.text, database: req.body.database });
  await logActivity('credential', row.id, 'db_query', String(req.body.text || '').slice(0, 200));
  return result;
}));

/* ------------------------------------------------------------ changes */

dbEnginesRouter.post('/:id/db/schemas', manage('database_created', (e, cfg, b) => e.createDatabase(cfg, b)));
dbEnginesRouter.delete('/:id/db/databases', manage('database_dropped', (e, cfg, b) => e.dropDatabase(cfg, b)));
dbEnginesRouter.post('/:id/db/users', manage('user_created', (e, cfg, b) => e.createUser(cfg, b)));
dbEnginesRouter.put('/:id/db/users', manage('user_altered', (e, cfg, b) => e.alterUser(cfg, b.key, b)));
dbEnginesRouter.delete('/:id/db/users', manage('user_dropped', (e, cfg, b) => e.dropUser(cfg, b.key)));
dbEnginesRouter.post('/:id/db/users/grants', manage('grant', (e, cfg, b) => e.grant(cfg, b.key, b)));
dbEnginesRouter.delete('/:id/db/users/grants', manage('revoke', (e, cfg, b) => e.revoke(cfg, b.key, b)));
dbEnginesRouter.put('/:id/db/config', manage('config_set', (e, cfg, b) => e.setConfig(cfg, b)));

/* ------------------------------------------------------- Redis key manager */

/*
 * Finding and reading keys are POSTs listed as read-only in authGuard, so a
 * viewer can browse. Adding a key needs "create", changing one "edit",
 * deleting "delete" — the usual rule for POST, PUT and DELETE.
 */
/** A read: a missing key is the answer, not a sign the connection is broken — so nothing is marked invalid. */
const redisRead = (fn) => async (req, res) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Connection not found' });
    if (row.provider !== 'redis') return res.status(400).json({ error: 'Key management is for Redis connections' });
    res.json({ ok: true, ...(await fn(await engineConfig(row, req.orgId), req.body || {})) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
};
const redisManage = (action, fn) => manage(action, (engine, cfg, b) => fn(cfg, b));
const onlyRedis = (req, res, next) => one('SELECT provider FROM credentials WHERE id = ? AND org_id = ?', [req.params.id, req.orgId])
  .then((r) => (r?.provider === 'redis' ? next() : res.status(400).json({ error: 'Key management is for Redis connections' })))
  .catch(next);

dbEnginesRouter.post('/:id/redis/scan', redisRead(redisKeys.scanKeys));
dbEnginesRouter.post('/:id/redis/key', redisRead(redisKeys.readKey));
dbEnginesRouter.post('/:id/redis/keys', onlyRedis, redisManage('key_created', redisKeys.createKey));
dbEnginesRouter.put('/:id/redis/key', onlyRedis, redisManage('key_changed', redisKeys.editKey));
dbEnginesRouter.delete('/:id/redis/keys', onlyRedis, redisManage('key_deleted', redisKeys.deleteKeys));

/* ------------------------------------------------------------- live card pulse */

/*
 * GET /credentials/pulse — the numbers on every database card, asked for every
 * five seconds while the Databases page is open.
 *
 * Each connection's answer is kept for a few seconds and shared, so two people
 * (or two tabs) watching the page cost the database one set of queries, not two.
 * The size on disk is the one expensive question; it is asked once a minute.
 * Rates — queries or operations per second — come from the difference between
 * two readings of the engine's own counter.
 */
const PULSE_TTL_MS = 4000;
const PULSE_RETRY_MS = 20_000;
const PULSE_TIMEOUT_MS = 8000;
const STORAGE_EVERY_MS = 60_000;
const PULSE_CONCURRENCY = 6;
const pulses = new Map(); // credential id -> { at, data, pending, counter, counterAt, rate, storageBytes, storageAt }

const pulseFor = (provider) => (provider === 'mysql' ? mysqlPulse : engineFor(provider)?.pulse);

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`No answer within ${ms / 1000}s`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

async function readPulse(row) {
  const entry = pulses.get(row.id) || {};
  // A connection that failed is tried again less often: it would only time out again.
  const ttl = entry.data?.ok === false ? PULSE_RETRY_MS : PULSE_TTL_MS;
  if (entry.at && Date.now() - entry.at < ttl) return entry.data;
  if (entry.pending) return entry.pending;

  const wantStorage = !entry.storageAt || Date.now() - entry.storageAt >= STORAGE_EVERY_MS;
  entry.pending = (async () => {
    const started = Date.now();
    try {
      const p = await withTimeout(pulseFor(row.provider)(await engineConfig(row, row.org_id), { storage: wantStorage }), PULSE_TIMEOUT_MS);
      const now = Date.now();
      // A counter that went backwards means the database restarted: no rate until the next reading.
      entry.rate = entry.counterAt && p.counter >= entry.counter
        ? Math.round(((p.counter - entry.counter) / ((now - entry.counterAt) / 1000)) * 10) / 10
        : (entry.counter && p.counter < entry.counter ? null : entry.rate ?? null);
      entry.counter = p.counter;
      entry.counterAt = now;
      if (wantStorage) { entry.storageBytes = p.storageBytes; entry.storageAt = now; }
      const { counter, storageBytes, ...rest } = p;
      return { ok: true, latencyMs: now - started, ...rest, rate: entry.rate, storageBytes: entry.storageBytes ?? null };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, error: friendlyDbError(err) };
    }
  })();
  pulses.set(row.id, entry);
  try {
    entry.data = await entry.pending;
    entry.at = Date.now();
    return entry.data;
  } finally {
    entry.pending = null;
  }
}

/** Driver errors can be long and technical; the card has room for one line. */
const friendlyDbError = (err) => String(err?.message || err || 'Unreachable').split('\n')[0].slice(0, 200);

/** Run `fn` over `items`, at most `limit` at a time. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

dbEnginesRouter.get('/pulse', async (req, res, next) => {
  try {
    const providers = Object.keys(DATABASE_PROVIDERS);
    const rows = await all(
      `SELECT * FROM credentials WHERE org_id = ? AND provider IN (${providers.map(() => '?').join(',')})`,
      [req.orgId, ...providers]
    );

    // The disk of the server a database is tunnelled through, from that server's last "Fetch details".
    const serverIds = [...new Set(rows.map((r) => r.server_id).filter(Boolean))];
    const disks = new Map();
    if (serverIds.length) {
      const facts = await all(`
        SELECT f.server_id, f.collected_at, f.payload FROM server_facts f
         WHERE f.id IN (SELECT MAX(id) FROM server_facts WHERE server_id IN (${serverIds.map(() => '?').join(',')}) GROUP BY server_id)`,
      serverIds);
      for (const f of facts) {
        const p = asJson(f.payload);
        const disk = p.disks?.find((d) => d.mount === '/') || p.disks?.[0];
        if (disk) disks.set(f.server_id, { usedPct: disk.usedPct, usedBytes: disk.usedBytes, sizeBytes: disk.sizeBytes, availableBytes: disk.availableBytes, mount: disk.mount, collectedAt: f.collected_at });
      }
    }

    const results = await mapLimit(rows, PULSE_CONCURRENCY, async (row) => ({
      id: row.id,
      ...(await readPulse(row)),
      hostDisk: row.server_id ? disks.get(row.server_id) || null : null,
    }));
    res.json({ at: new Date().toISOString(), everySeconds: 5, connections: results });
  } catch (err) { next(err); }
});
