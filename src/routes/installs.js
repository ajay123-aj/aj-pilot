/**
 * Installing things on a server.
 *
 * Docker and its compose plugin go onto the host, because nothing can be
 * containerised without them. Everything else in the catalog runs as a Docker
 * container — the panel never installs a database onto the machine itself.
 * A server without a working Docker is told so, and nothing is attempted.
 */

import { Router } from 'express';
import { all, one, run, logActivity } from '../db/index.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { connectionFromRow, withConnection } from '../lib/ssh.js';
import { byKey, publicCatalog, containerPlan, publicSettings, extraPortPlan } from '../lib/catalog.js';
import { resolveEnvironmentChoice } from '../lib/environments.js';
import {
  dockerState, requireDocker, DockerMissingError, runContainer, recreateContainer,
  containerAction, containerLogs, removeContainer, installEngine, installCompose,
  validateName, validatePort,
} from '../lib/docker.js';

export const installsRouter = Router();

const getRow = (id, orgId) => one('SELECT * FROM installations WHERE id = ? AND org_id = ?', [id, orgId]);
const getServer = (id, orgId) => one('SELECT * FROM servers WHERE id = ? AND org_id = ?', [id, orgId]);

const asJson = (v) => {
  if (!v) return {};
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return {}; } }
  return v;
};

/** The other ports this container publishes, as they were chosen at install. */
function storedExtraPorts(row) {
  const list = asJson(row.extra_ports);
  return Array.isArray(list) ? list : [];
}

/** An installation row as the browser may see it — never its secrets. */
async function publicInstall(row) {
  if (!row) return null;
  const { secrets_enc, install_log, ...rest } = row;
  const server = await getServer(row.server_id, row.org_id);
  const entry = byKey(row.kind);
  return {
    ...rest,
    settings: asJson(row.settings),
    extraPorts: storedExtraPorts(row),
    label: entry?.label || row.kind,
    icon: entry?.icon || '📦',
    server: server ? { id: server.id, name: server.name, host: server.host, username: server.username } : null,
    hasLog: Boolean(install_log),
  };
}

/* -------------------------------------------------------------- catalog */

/** What can be installed, and the form each one needs. */
installsRouter.get('/catalog', (req, res) => {
  res.json({ catalog: publicCatalog() });
});

/* ---------------------------------------------------------------- list */

installsRouter.get('/', async (req, res, next) => {
  try {
    const rows = req.query.server_id
      ? await all('SELECT * FROM installations WHERE org_id = ? AND server_id = ? ORDER BY created_at DESC', [req.orgId, Number(req.query.server_id)])
      : await all('SELECT * FROM installations WHERE org_id = ? ORDER BY created_at DESC', [req.orgId]);
    res.json(await Promise.all(rows.map(publicInstall)));
  } catch (err) { next(err); }
});

installsRouter.get('/:id', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Installation not found' });
    res.json({ ...(await publicInstall(row)), installLog: row.install_log || null });
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------- install */

installsRouter.post('/', async (req, res, next) => {
  try {
    const entry = byKey(String(req.body.kind || ''));
    if (!entry) return res.status(400).json({ error: 'Pick something from the catalog to install' });

    const server = await getServer(Number(req.body.server_id), req.orgId);
    if (!server) return res.status(400).json({ error: 'Pick the server to install on' });

    return entry.kind === 'host'
      ? installOnHost(entry, server, req, res)
      : installAsContainer(entry, server, req, res);
  } catch (err) { next(err); }
});

/** Docker Engine and the compose plugin. */
async function installOnHost(entry, server, req, res) {
  try {
    const result = await withConnection(connectionFromRow(server), async (conn) => {
      if (entry.key === 'compose') await requireDocker(conn, server);
      return entry.key === 'docker' ? installEngine(conn, server) : installCompose(conn, server);
    });

    await logActivity('server', server.id, 'install', `Installed ${entry.label} on ${server.name}${result.version ? ` (${result.version})` : ''}`);
    res.status(201).json({ ok: true, kind: entry.key, host: true, version: result.version, log: result.log });
  } catch (err) {
    await logActivity('server', server.id, 'install_failed', `${entry.label} on ${server.name}: ${err.message}`, 'error');
    res.status(400).json({
      ok: false,
      error: err.message,
      dockerMissing: err instanceof DockerMissingError,
      detail: err.cause || null,
    });
  }
}

/** Everything else: pull an image and run it. */
async function installAsContainer(entry, server, req, res) {
  const named = validateName(req.body.name || `${entry.key}`, 'container name');
  if (named.error) return res.status(400).json({ error: named.error });

  const ported = validatePort(req.body.port ?? entry.defaultPort, 'port');
  if (ported.error) return res.status(400).json({ error: ported.error });

  const tag = String(req.body.tag || entry.defaultTag).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(tag)) {
    return res.status(400).json({ error: `"${tag}" is not a valid image version` });
  }

  const network = String(req.body.network || '').trim();
  if (network) {
    const checked = validateName(network, 'network name');
    if (checked.error) return res.status(400).json({ error: checked.error });
  }

  const values = asJson(req.body.settings) || {};
  let plan;
  let extraPorts;
  try {
    plan = containerPlan(entry, values);
    extraPorts = extraPortPlan(entry, values);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (extraPorts.some((p) => p.port === ported.value)) {
    return res.status(400).json({ error: `Port ${ported.value} is published twice — give each one its own` });
  }

  if (await one('SELECT id FROM installations WHERE server_id = ? AND name = ? AND org_id = ?', [server.id, named.value, server.org_id])) {
    return res.status(409).json({ error: `This server already has an installation named "${named.value}"` });
  }

  // The variables this container gets, as an environment: link to one, or keep them as a new one.
  const envPairs = Object.entries(plan.env || {}).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)).map(([k, v]) => [k, String(v)]);
  const envChoice = { orgId: server.org_id, userId: req.user?.id, pairs: envPairs, fallbackName: named.value };
  const envCheck = await resolveEnvironmentChoice(req.body, { ...envChoice, check: true });
  if (envCheck.error) return res.status(envCheck.status || 400).json({ error: envCheck.error });

  const volume = `${named.value}-data`;
  const spec = {
    kind: entry.key,
    name: named.value,
    image: entry.image,
    tag,
    port: ported.value,
    containerPort: entry.containerPort,
    extraPorts,
    prepare: entry.prepare || null,
    runArgs: entry.runArgs || [],
    volume,
    volumePath: entry.volumePath,
    network: network || null,
    env: plan.env,
    command: plan.command,
    bind: req.body.bind === 'localhost' ? '127.0.0.1' : '0.0.0.0',
  };

  // Written first so a failed install is visible and can be cleaned up.
  const { insertId } = await run(
    `INSERT INTO installations (org_id, server_id, kind, name, image, tag, port, container_port, extra_ports, network, volume, settings, secrets_enc, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'installing')`,
    [server.org_id, server.id, entry.key, spec.name, spec.image, spec.tag, spec.port, spec.containerPort,
      JSON.stringify(extraPorts), spec.network, volume, JSON.stringify(publicSettings(entry, values)), encrypt(JSON.stringify(values))]
  );

  const envLink = await resolveEnvironmentChoice(req.body, envChoice);
  if (envLink.id) await run('UPDATE installations SET environment_id = ? WHERE id = ?', [envLink.id, insertId]);

  try {
    const result = await withConnection(connectionFromRow(server), async (conn) => {
      await requireDocker(conn, server);
      return runContainer(conn, server, spec);
    });

    await run("UPDATE installations SET status = 'running', container_id = ?, install_log = ?, last_error = NULL WHERE id = ?",
      [result.containerId, result.logs.join('\n').slice(-60000), insertId]);
    await logActivity('server', server.id, 'install',
      `Installed ${entry.label} as "${spec.name}" on ${server.name} (port ${spec.port})`);

    // A database is also added under Databases, so it can be browsed straight away.
    const connection = await addDatabaseConnection(entry, server, spec, values).catch((err) => {
      console.error('[installs] could not add the database connection:', err.message);
      return null;
    });

    res.status(201).json({ ok: true, ...(await publicInstall(await getRow(insertId, req.orgId))), logs: result.logs, connection });
  } catch (err) {
    await run("UPDATE installations SET status = 'error', last_error = ?, install_log = ? WHERE id = ?",
      [err.message, String(err.cause || '').slice(-60000) || null, insertId]);
    await logActivity('server', server.id, 'install_failed', `${entry.label} on ${server.name}: ${err.message}`, 'error');
    res.status(400).json({
      ok: false,
      error: err.message,
      dockerMissing: err instanceof DockerMissingError,
      detail: err.cause || null,
      install_id: insertId,
    });
  }
}

/**
 * The connection a freshly installed database gets under Databases: the
 * superuser the container was created with, reached over the server's SSH.
 */
const CONNECTION_FOR = {
  mysql: (v) => ({ provider: 'mysql', username: 'root', secret: v.root_password, database: v.database }),
  postgres: (v) => ({ provider: 'postgres', username: v.user || 'postgres', secret: v.password, database: v.database || v.user || 'postgres' }),
  mongo: (v) => ({ provider: 'mongodb', username: v.user || '', secret: v.password || '', authSource: 'admin' }),
  redis: (v) => ({ provider: 'redis', username: '', secret: v.password || '' }),
};

async function addDatabaseConnection(entry, server, spec, values) {
  const make = CONNECTION_FOR[entry.key];
  if (!make) return null;
  const c = make(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v ?? '').trim()])));

  // "mysql on prod-1", then "mysql on prod-1 (2)" if that is taken.
  const base = `${spec.name} on ${server.name}`;
  let name = base;
  for (let n = 2; await one('SELECT id FROM credentials WHERE org_id = ? AND provider = ? AND name = ?', [server.org_id, c.provider, name]); n += 1) {
    name = `${base} (${n})`;
  }

  const extra = { host: '127.0.0.1', port: spec.port, database: c.database || null };
  if (c.provider !== 'mysql') extra.tls = false;
  if (c.authSource) extra.authSource = c.authSource;

  const { insertId } = await run(
    'INSERT INTO credentials (org_id, provider, name, username, secret_enc, extra, server_id) VALUES (?,?,?,?,?,?,?)',
    [server.org_id, c.provider, name, c.username || null, encrypt(c.secret) || '', JSON.stringify(extra), server.id]
  );
  await logActivity('credential', insertId, 'created', `Added ${entry.label} connection "${name}" for the new container`);
  return { id: insertId, name, provider: c.provider };
}

/* -------------------------------------------------------------- status */

/** What Docker says about this container right now. */
installsRouter.post('/:id/refresh', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Installation not found' });
    const server = await getServer(row.server_id, req.orgId);
    if (!server) return res.status(400).json({ error: 'The server this runs on no longer exists' });

    try {
      const state = await withConnection(connectionFromRow(server), (conn) => dockerState(conn, server));
      if (!state.installed || !state.running) throw new DockerMissingError(state);

      const container = state.containers.find((c) => c.name === row.name) || null;
      const status = container ? container.state : 'missing';
      await run('UPDATE installations SET status = ?, last_error = ? WHERE id = ?',
        [status, container ? null : 'This container is no longer on the server', row.id]);

      res.json({ ok: true, status, container });
    } catch (err) {
      await run("UPDATE installations SET status = 'error', last_error = ? WHERE id = ?", [err.message, row.id]);
      res.status(400).json({ ok: false, error: err.message, dockerMissing: err instanceof DockerMissingError });
    }
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------- control */

installsRouter.post('/:id/action', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Installation not found' });
    const action = String(req.body.action || '');
    if (!['start', 'stop', 'restart'].includes(action)) {
      return res.status(400).json({ error: 'action must be start, stop or restart' });
    }
    const server = await getServer(row.server_id, req.orgId);
    if (!server) return res.status(400).json({ error: 'The server this runs on no longer exists' });

    try {
      const result = await withConnection(connectionFromRow(server), async (conn) => {
        await requireDocker(conn, server);
        return containerAction(conn, server, row.name, action);
      });
      await run('UPDATE installations SET status = ?, last_error = NULL WHERE id = ?', [result.state || 'unknown', row.id]);
      await logActivity('server', server.id, `install_${action}`, `${action} ${row.name} on ${server.name} → ${result.state}`);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message, dockerMissing: err instanceof DockerMissingError, detail: err.cause || null });
    }
  } catch (err) { next(err); }
});

installsRouter.get('/:id/logs', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Installation not found' });
    const server = await getServer(row.server_id, req.orgId);
    if (!server) return res.status(400).json({ error: 'The server this runs on no longer exists' });
    try {
      const logs = await withConnection(connectionFromRow(server), async (conn) => {
        await requireDocker(conn, server);
        return containerLogs(conn, server, row.name, Number(req.query.tail) || 200);
      });
      res.json({ ok: true, name: row.name, logs });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message, dockerMissing: err instanceof DockerMissingError });
    }
  } catch (err) { next(err); }
});

/* ---------------------------------------------------------------- port */

/**
 * Change the published port.
 *
 * Docker cannot re-publish a port on a running container, so the container is
 * rebuilt from the stored settings. The named volume stays, so the data does.
 */
installsRouter.put('/:id/port', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Installation not found' });

    const entry = byKey(row.kind);
    if (!entry || entry.kind !== 'container') {
      return res.status(400).json({ error: `${row.kind} does not listen on a port that can be changed` });
    }

    const ported = validatePort(req.body.port, 'port');
    if (ported.error) return res.status(400).json({ error: ported.error });

    const network = req.body.network !== undefined ? String(req.body.network || '').trim() : row.network;
    if (network) {
      const checked = validateName(network, 'network name');
      if (checked.error) return res.status(400).json({ error: checked.error });
    }
    if (ported.value === row.port && network === row.network) {
      return res.json({ ok: true, unchanged: true, port: row.port, network: row.network });
    }
    const clash = storedExtraPorts(row).find((p) => p.port === ported.value);
    if (clash) return res.status(400).json({ error: `Port ${ported.value} is already this service's ${clash.label.toLowerCase()}` });

    const server = await getServer(row.server_id, req.orgId);
    if (!server) return res.status(400).json({ error: 'The server this runs on no longer exists' });

    const values = asJson(decryptSettings(row));
    const plan = containerPlan(entry, values);
    const spec = {
      kind: entry.key,
      name: row.name,
      image: row.image,
      tag: row.tag,
      port: ported.value,
      containerPort: row.container_port || entry.containerPort,
      // The service's other ports are kept as they were installed.
      extraPorts: storedExtraPorts(row),
      prepare: entry.prepare || null,
      runArgs: entry.runArgs || [],
      volume: row.volume,
      volumePath: entry.volumePath,
      network: network || null,
      env: plan.env,
      command: plan.command,
    };

    try {
      const result = await withConnection(connectionFromRow(server), async (conn) => {
        await requireDocker(conn, server);
        return recreateContainer(conn, server, spec);
      });
      await run('UPDATE installations SET port = ?, network = ?, container_id = ?, status = ?, last_error = NULL WHERE id = ?',
        [ported.value, network || null, result.containerId, result.state || 'running', row.id]);
      await logActivity('server', server.id, 'install_port',
        `${row.name} on ${server.name} moved from port ${row.port} to ${ported.value}`);
      res.json({ ok: true, ...(await publicInstall(await getRow(row.id, req.orgId))), logs: result.logs });
    } catch (err) {
      await run('UPDATE installations SET last_error = ? WHERE id = ?', [err.message, row.id]);
      res.status(400).json({ ok: false, error: err.message, dockerMissing: err instanceof DockerMissingError, detail: err.cause || null });
    }
  } catch (err) { next(err); }
});

/** The settings a container was created with, needed to rebuild it identically. */
function decryptSettings(row) {
  if (!row.secrets_enc) return asJson(row.settings);
  try {
    return JSON.parse(decrypt(row.secrets_enc));
  } catch {
    return asJson(row.settings);
  }
}

/* -------------------------------------------------------------- delete */

/** Remove the container. `?delete_data=1` also removes its volume. */
installsRouter.delete('/:id', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Installation not found' });
    const server = await getServer(row.server_id, req.orgId);

    const warnings = [];
    if (server) {
      try {
        await withConnection(connectionFromRow(server), (conn) => removeContainer(conn, server, row.name, {
          volume: row.volume,
          keepData: req.query.delete_data !== '1',
        }));
      } catch (err) {
        warnings.push(`Could not clean up ${server.name}: ${err.message}`);
      }
    }

    await run('DELETE FROM installations WHERE id = ?', [row.id]);
    await logActivity('server', row.server_id, 'install_removed',
      `Removed ${row.name}${req.query.delete_data === '1' ? ' and its data volume' : ' (data volume kept)'}`);
    res.json({ ok: true, warnings });
  } catch (err) { next(err); }
});
