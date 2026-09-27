/**
 * PostgreSQL, MongoDB and Redis connections — the same pages MySQL has, served
 * by whichever engine module matches the credential's provider.
 *
 * Reads are POSTs listed as read-only in authGuard, so a viewer can look.
 * Creating needs "create", changing needs "edit", dropping and revoking "delete".
 */

import { Router } from 'express';
import { one, run, logActivity } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { asJson } from '../lib/gitAccounts.js';
import { engineFor, DATABASE_PROVIDERS } from '../lib/engines/index.js';

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
    /drop|revoke|flush/.test(action) ? 'warn' : 'info');
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
