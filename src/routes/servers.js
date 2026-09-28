import { Router } from 'express';
import { all, one, run, logActivity } from '../db/index.js';
import { encrypt } from '../lib/crypto.js';
import { connectionFromRow, withConnection, testConnection, exec, rootExec } from '../lib/ssh.js';
import { collectSystemInfo } from '../lib/systemInfo.js';
import {
  listServices, describeService, controlService, createService, deleteService,
  validateServiceSpec, validateUnit,
} from '../lib/services.js';
import {
  dockerState, createNetwork, removeNetwork, removeVolume, validateName,
  registryLogin, registryLogout, registryLabel, DOCKER_HUB,
  requireDocker, DockerMissingError, containerAction, containerLogs, containerDetails, removeAnyContainer, CONTAINER_ACTIONS,
} from '../lib/docker.js';
import { collectLiveStats } from '../lib/liveStats.js';
import { runnerState } from '../lib/runnerInstall.js';
import { collectSummary } from '../lib/serverSummary.js';
import {
  cronState, installCron, addJob, updateJob, deleteJob,
  validateUser, validateSchedule, validateCommand,
} from '../lib/cron.js';
import { liveStatus } from '../lib/healthMonitor.js';
import {
  usersState, createUser, updateUser, removeKey, deleteUser, NOT_PERMITTED,
  validateUsername, validatePassword, validateShell, validateFullName, validateGroups, validatePublicKeys, validateKeyComment,
} from '../lib/sysUsers.js';
import { can } from '../lib/auth.js';
import { config } from '../config.js';
import {
  nginxState, nginxAction, installNginx, installCertbot, buildSiteConfig,
  writeSite, readSite, removeSite, toggleSite, issueCertificate, renewCertificates,
  validateDomain, validateSiteName, validateUpstream, saveUpstream, deleteUpstream,
} from '../lib/nginx.js';
import { decrypt } from '../lib/crypto.js';
import { requirePermission } from '../lib/authGuard.js';
import {
  listDir, readFile, writeFile, uploadFile, downloadTo, makeFolder, makeFile, move, copy, remove, setPermissions, extract,
} from '../lib/files.js';

export const serversRouter = Router();

/** Strip every secret column before a row leaves the API. */
function publicServer(row) {
  if (!row) return null;
  const { password_enc, private_key_enc, passphrase_enc, sudo_password_enc, ...rest } = row;
  return {
    ...rest,
    tags: row.tags ? row.tags.split(',').filter(Boolean) : [],
    hasPassword: Boolean(password_enc),
    hasPrivateKey: Boolean(private_key_enc),
  };
}

/** "production, web " -> "production,web" */
function normalizeTags(tags) {
  const raw = Array.isArray(tags) ? tags.join(',') : String(tags || '');
  return raw.split(',').map((t) => t.trim()).filter(Boolean).join(',');
}

function validate(body, { partial = false } = {}) {
  const errors = [];
  const v = {
    name: (body.name || '').trim(),
    host: (body.host || '').trim(),
    port: Number(body.port || 22),
    username: (body.username || '').trim(),
    auth_type: body.auth_type === 'key' ? 'key' : 'password',
    password: body.password || '',
    private_key: body.private_key || '',
    passphrase: body.passphrase || '',
    sudo_password: body.sudo_password || '',
    tags: normalizeTags(body.tags),
    notes: (body.notes || '').trim(),
  };

  if (!partial || body.name !== undefined) {
    if (!v.name) errors.push('name is required');
  }
  if (!partial || body.host !== undefined) {
    if (!v.host) errors.push('host (IP or domain) is required');
  }
  if (!partial || body.username !== undefined) {
    if (!v.username) errors.push('username is required');
  }
  if (!Number.isInteger(v.port) || v.port < 1 || v.port > 65535) errors.push('port must be between 1 and 65535');

  if (!partial) {
    if (v.auth_type === 'password' && !v.password) errors.push('password is required for password authentication');
    if (v.auth_type === 'key' && !v.private_key) errors.push('private_key is required for key authentication');
  }
  return { value: v, errors };
}

const getRow = (id, orgId) => one('SELECT * FROM servers WHERE id = ? AND org_id = ?', [id, orgId]);

function markStatus(id, status, error = null) {
  return run('UPDATE servers SET status = ?, last_error = ?, last_checked_at = NOW() WHERE id = ?', [status, error, id]);
}

/** MySQL returns JSON columns already parsed; older drivers hand back a string. */
const asJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

/* ---------------------------------------------------------------- list */

serversRouter.get('/', async (req, res, next) => {
  try {
    const rows = await all('SELECT * FROM servers WHERE org_id = ? ORDER BY created_at DESC', [req.orgId]);
    const latest = rows.length ? await all(`
      SELECT server_id, collected_at, payload FROM server_facts
       WHERE id IN (SELECT MAX(id) FROM server_facts GROUP BY server_id)
         AND server_id IN (${rows.map(() => '?').join(',')})
    `, rows.map((r) => r.id)) : [];
    const byServer = new Map(latest.map((f) => [f.server_id, f]));

    res.json(rows.map((row) => {
      const fact = byServer.get(row.id);
      let summary = null;
      if (fact) {
        const p = asJson(fact.payload);
        summary = {
          collectedAt: fact.collected_at,
          os: p.os?.pretty,
          kernel: p.identity?.kernel,
          cpuCores: p.cpu?.cores,
          memoryTotalBytes: p.memory?.totalBytes,
          memoryUsedPct: p.memory?.usedPct,
          diskUsedPct: p.disks?.[0]?.usedPct ?? null,
          uptime: p.uptime?.human,
        };
      }
      return { ...publicServer(row), summary };
    }));
  } catch (err) { next(err); }
});

/* ------------------------------------------------------ live statuses */

/**
 * Just the statuses, for the list to poll.
 *
 * The monitor keeps its latest answer in memory and only writes to the row when
 * a server changes state, so this reads the stored row and lays the live answer
 * over it. It is deliberately tiny: no system profiles, no joins.
 */
serversRouter.get('/status', async (req, res, next) => {
  try {
    const rows = await all('SELECT id, name, status, last_error, last_checked_at FROM servers WHERE org_id = ?', [req.orgId]);
    const live = liveStatus();

    res.json({
      at: new Date().toISOString(),
      everySeconds: Math.round(config.monitor.intervalMs / 1000),
      servers: rows.map((row) => {
        const now = live.get(row.id);
        return {
          id: row.id,
          name: row.name,
          status: now?.status || row.status,
          latencyMs: now?.latencyMs ?? null,
          lastError: now ? now.error : row.last_error,
          checkedAt: now?.checkedAt || row.last_checked_at,
          // Reachable is not the same as usable; the sign-in check says which.
          signIn: now?.authOk === undefined ? null : now.authOk,
          signInError: now?.authError || null,
          signInCheckedAt: now?.authCheckedAt || null,
        };
      }),
    });
  } catch (err) { next(err); }
});

/* -------------------------------------------------- test before saving */

serversRouter.post('/test', async (req, res, next) => {
  try {
    // Testing an edit: the secret boxes are empty when they are unchanged, so
    // the stored one stands in and the details on screen are still what is tried.
    const saved = req.body.server_id ? await getRow(Number(req.body.server_id), req.orgId) : null;
    const { value, errors } = validate(req.body, { partial: Boolean(saved) });
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    const secret = { privateKey: value.private_key, passphrase: value.passphrase, password: value.password };
    if (saved) {
      if (!secret.privateKey && saved.private_key_enc) secret.privateKey = decrypt(saved.private_key_enc);
      if (!secret.passphrase && saved.passphrase_enc) secret.passphrase = decrypt(saved.passphrase_enc);
      if (!secret.password && saved.password_enc) secret.password = decrypt(saved.password_enc);
    }
    if (value.auth_type === 'key' && !secret.privateKey) return res.status(400).json({ error: 'private_key is required for key authentication' });
    if (value.auth_type === 'password' && !secret.password) return res.status(400).json({ error: 'password is required for password authentication' });

    try {
      const result = await testConnection({
        host: value.host || saved?.host,
        port: value.port,
        username: value.username || saved?.username,
        ...(value.auth_type === 'key'
          ? { privateKey: secret.privateKey, ...(secret.passphrase ? { passphrase: secret.passphrase } : {}) }
          : { password: secret.password }),
        readyTimeout: 15000,
        tryKeyboard: true,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message, detail: err.cause || null });
    }
  } catch (err) { next(err); }
});

/* -------------------------------------------------------------- create */

serversRouter.post('/', async (req, res, next) => {
  const { value, errors } = validate(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });

  try {
    if (await one('SELECT id FROM servers WHERE name = ? AND org_id = ?', [value.name, req.orgId])) {
      return res.status(409).json({ error: `A server named "${value.name}" already exists` });
    }

    const { insertId } = await run(
      `INSERT INTO servers (org_id, name, host, port, username, auth_type, password_enc, private_key_enc,
         passphrase_enc, sudo_password_enc, tags, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [req.orgId, value.name, value.host, value.port, value.username, value.auth_type,
        value.auth_type === 'password' ? encrypt(value.password) : null,
        value.auth_type === 'key' ? encrypt(value.private_key) : null,
        encrypt(value.passphrase), encrypt(value.sudo_password), value.tags, value.notes]
    );

    await logActivity('server', insertId, 'created', `Added server ${value.name} (${value.username}@${value.host}:${value.port})`);
    res.status(201).json(publicServer(await getRow(insertId, req.orgId)));
  } catch (err) { next(err); }
});

/* ---------------------------------------------------------------- read */

serversRouter.get('/:id', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Server not found' });
    const fact = await one('SELECT * FROM server_facts WHERE server_id = ? ORDER BY id DESC LIMIT 1', [row.id]);
    res.json({
      ...publicServer(row),
      facts: fact ? { collectedAt: fact.collected_at, durationMs: fact.duration_ms, ...asJson(fact.payload) } : null,
    });
  } catch (err) { next(err); }
});

/** Every profile ever collected for this server, newest first. */
serversRouter.get('/:id/history', async (req, res, next) => {
  try {
    if (!await getRow(req.params.id, req.orgId)) return res.status(404).json({ error: 'Server not found' });
    const rows = await all(
      'SELECT id, collected_at, duration_ms FROM server_facts WHERE server_id = ? ORDER BY id DESC LIMIT 50',
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

/* -------------------------------------------------------------- update */

serversRouter.put('/:id', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Server not found' });

    const { value, errors } = validate({ ...req.body }, { partial: true });
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    // Server names are unique, so say which one is in the way rather than
    // letting the database raise a duplicate-key error at the browser.
    if (value.name && value.name !== row.name
      && await one('SELECT id FROM servers WHERE name = ? AND id <> ?', [value.name, row.id])) {
      return res.status(409).json({ error: `Another server is already called "${value.name}"` });
    }

    // Switching to key authentication needs a key, unless one is already stored.
    if (req.body.auth_type === 'key' && !value.private_key && !row.private_key_enc) {
      return res.status(400).json({ error: 'Paste the private key to switch this server to key authentication' });
    }
    if (req.body.auth_type === 'password' && !value.password && !row.password_enc) {
      return res.status(400).json({ error: 'Enter the password to switch this server to password authentication' });
    }

    await run(
      `UPDATE servers SET name=?, host=?, port=?, username=?, auth_type=?, password_enc=?,
         private_key_enc=?, passphrase_enc=?, sudo_password_enc=?, tags=?, notes=? WHERE id=?`,
      [
        value.name || row.name,
        value.host || row.host,
        value.port || row.port,
        value.username || row.username,
        req.body.auth_type ? value.auth_type : row.auth_type,
        // Blank secret fields mean "keep what is stored".
        value.password ? encrypt(value.password) : row.password_enc,
        value.private_key ? encrypt(value.private_key) : row.private_key_enc,
        value.passphrase ? encrypt(value.passphrase) : row.passphrase_enc,
        value.sudo_password ? encrypt(value.sudo_password) : row.sudo_password_enc,
        req.body.tags !== undefined ? value.tags : row.tags,
        req.body.notes !== undefined ? value.notes : row.notes,
        row.id,
      ]
    );

    await logActivity('server', row.id, 'updated', `Updated server ${value.name || row.name}`);
    res.json(publicServer(await getRow(row.id, req.orgId)));
  } catch (err) { next(err); }
});

/* -------------------------------------------------------------- delete */

serversRouter.delete('/:id', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Server not found' });
    await run('DELETE FROM servers WHERE id = ?', [row.id]);
    await logActivity('server', null, 'deleted', `Removed server ${row.name}`);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* ------------------------------------------------- connect / test saved */

serversRouter.post('/:id/test', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Server not found' });
    try {
      const result = await testConnection(connectionFromRow(row));
      await markStatus(row.id, 'online');
      await logActivity('server', row.id, 'connected', `Connected to ${row.host} in ${result.latencyMs}ms`);
      res.json({ ok: true, ...result });
    } catch (err) {
      // Same verdict the background monitor writes, so the two never disagree.
      await markStatus(row.id, 'offline', err.message);
      await logActivity('server', row.id, 'connect_failed', err.message, 'error');
      res.status(400).json({ ok: false, error: err.message, detail: err.cause || null });
    }
  } catch (err) { next(err); }
});

/* --------------------------------------------------- collect all facts */

serversRouter.post('/:id/facts', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Server not found' });
    try {
      const facts = await withConnection(connectionFromRow(row), (conn) => collectSystemInfo(conn));
      await run('INSERT INTO server_facts (server_id, duration_ms, payload) VALUES (?,?,?)',
        [row.id, facts.meta.durationMs, JSON.stringify(facts)]);
      await markStatus(row.id, 'online');
      await logActivity('server', row.id, 'facts_collected',
        `Collected system details from ${row.host} in ${facts.meta.durationMs}ms`);
      res.json({ ok: true, collectedAt: facts.meta.collectedAt, ...facts });
    } catch (err) {
      await markStatus(row.id, 'error', err.message);
      await logActivity('server', row.id, 'facts_failed', err.message, 'error');
      res.status(400).json({ ok: false, error: err.message, detail: err.cause || null });
    }
  } catch (err) { next(err); }
});

serversRouter.get('/:id/facts', async (req, res, next) => {
  try {
    if (!await getRow(req.params.id, req.orgId)) return res.status(404).json({ error: 'Server not found' });
    const fact = await one('SELECT * FROM server_facts WHERE server_id = ? ORDER BY id DESC LIMIT 1', [req.params.id]);
    if (!fact) return res.status(404).json({ error: 'No system details collected yet' });
    res.json({ collectedAt: fact.collected_at, durationMs: fact.duration_ms, ...asJson(fact.payload) });
  } catch (err) { next(err); }
});

/* ----------------------------------------------------------- services */

/** Run `fn` against an open connection to this server, or 404/400 cleanly. */
function serverRoute(handler) {
  return async (req, res, next) => {
    try {
      const row = await getRow(req.params.id, req.orgId);
      if (!row) return res.status(404).json({ error: 'Server not found' });
      try {
        res.json({ ok: true, ...(await withConnection(connectionFromRow(row), (conn) => handler(conn, row, req))) });
      } catch (err) {
        res.status(400).json({ ok: false, error: err.message, detail: err.cause || null });
      }
    } catch (err) { next(err); }
  };
}

/** Every systemd service on the host, live. */
serversRouter.get('/:id/services', serverRoute(async (conn, row) => {
  const result = await listServices(conn);
  await markStatus(row.id, 'online');
  // Mark the units this panel created, so they can be deleted from the UI.
  const mine = await all('SELECT unit FROM managed_services WHERE server_id = ?', [row.id]);
  const created = new Set(mine.map((m) => m.unit));
  for (const svc of result.services) svc.createdHere = created.has(svc.unit);
  return result;
}));

/** One unit in full, with its recent journal. */
serversRouter.get('/:id/services/:unit', serverRoute(async (conn, row, req) => ({
  service: await describeService(conn, row, req.params.unit),
})));

/** start / stop / restart / reload / enable / disable a unit. */
serversRouter.post('/:id/services/:unit/action', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Server not found' });
    const action = String(req.body.action || '').trim();
    try {
      const result = await withConnection(connectionFromRow(row), (conn) => controlService(conn, row, req.params.unit, action));
      await logActivity('server', row.id, `service_${action}`, `${action} ${result.unit} on ${row.name} → ${result.active}`);
      res.json({ ok: true, ...result });
    } catch (err) {
      await logActivity('server', row.id, 'service_action_failed', `${action} ${req.params.unit} on ${row.name}: ${err.message}`, 'error');
      res.status(400).json({ ok: false, error: err.message, detail: err.cause || null });
    }
  } catch (err) { next(err); }
});

/** Create a new systemd service from the add-service form. */
serversRouter.post('/:id/services', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Server not found' });

    const { spec, error } = validateServiceSpec(req.body);
    if (error) return res.status(400).json({ error });

    try {
      const result = await withConnection(connectionFromRow(row), (conn) => createService(conn, row, spec));
      await run(
        `INSERT INTO managed_services (org_id, server_id, unit, description, exec_start, unit_file)
         VALUES (?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE description = VALUES(description), exec_start = VALUES(exec_start), unit_file = VALUES(unit_file)`,
        [req.orgId, row.id, result.unit, spec.description || null, spec.execStart, result.unitFile]
      );
      await logActivity('server', row.id, 'service_created', `Created service ${result.unit} on ${row.name} (${result.active})`);
      res.status(201).json({ ok: true, ...result });
    } catch (err) {
      await logActivity('server', row.id, 'service_create_failed', `${spec.unit} on ${row.name}: ${err.message}`, 'error');
      res.status(400).json({ ok: false, error: err.message, detail: err.cause || null });
    }
  } catch (err) { next(err); }
});

/** Remove a unit this panel wrote. */
serversRouter.delete('/:id/services/:unit', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Server not found' });
    const { unit, error } = validateUnit(req.params.unit);
    if (error) return res.status(400).json({ error });
    try {
      const result = await withConnection(connectionFromRow(row), (conn) => deleteService(conn, row, unit));
      await run('DELETE FROM managed_services WHERE server_id = ? AND unit = ?', [row.id, unit]);
      await logActivity('server', row.id, 'service_deleted', `Deleted service ${unit} from ${row.name}`);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message, detail: err.cause || null });
    }
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------- docker */

/** Is Docker there, its networks, and everything running on it. */
serversRouter.get('/:id/docker', serverRoute(async (conn, row) => ({
  docker: await dockerState(conn, row),
})));

/** A user-defined network, so installed services can reach each other by name. */
serversRouter.post('/:id/docker/networks', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Server not found' });

    const named = validateName(req.body.name, 'network name');
    if (named.error) return res.status(400).json({ error: named.error });
    const driver = ['bridge', 'macvlan', 'overlay'].includes(req.body.driver) ? req.body.driver : 'bridge';

    try {
      const result = await withConnection(connectionFromRow(row), (conn) => createNetwork(conn, row, named.value, driver));
      await logActivity('server', row.id, 'docker_network_created', `Created Docker network "${named.value}" on ${row.name}`);
      res.status(201).json({ ok: true, ...result, driver });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message, detail: err.cause || null });
    }
  } catch (err) { next(err); }
});

/**
 * Sign this server in to a container registry, so it can pull private images.
 * The credentials are either typed in or taken from a stored Docker Hub one.
 */
serversRouter.post('/:id/docker/login', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Server not found' });

    let username = String(req.body.username || '').trim();
    let password = String(req.body.secret || '');
    const registry = String(req.body.registry || '').trim() || DOCKER_HUB;

    // A saved Docker Hub credential saves typing the token in again.
    if (req.body.credential_id) {
      const cred = await one('SELECT * FROM credentials WHERE id = ? AND org_id = ?', [Number(req.body.credential_id), req.orgId]);
      if (!cred) return res.status(400).json({ error: 'That credential does not exist' });
      if (cred.provider !== 'dockerhub') return res.status(400).json({ error: 'That credential is not a Docker Hub account' });
      username = cred.username;
      password = decrypt(cred.secret_enc);
    }

    if (!username) return res.status(400).json({ error: 'A registry username is required' });
    if (!password) return res.status(400).json({ error: 'A password or access token is required' });
    if (registry !== DOCKER_HUB && !/^[A-Za-z0-9.:_-]+(\/[A-Za-z0-9._-]+)*$/.test(registry)) {
      return res.status(400).json({ error: `"${registry}" is not a valid registry address` });
    }

    try {
      const result = await withConnection(connectionFromRow(row), (conn) => registryLogin(conn, row, { username, password, registry }));
      await logActivity('server', row.id, 'docker_login',
        `Signed ${row.name} in to ${registryLabel(registry)} as ${username}`);
      res.json({ ok: true, ...result });
    } catch (err) {
      await logActivity('server', row.id, 'docker_login_failed', `${registryLabel(registry)} on ${row.name}: ${err.message}`, 'error');
      res.status(400).json({ ok: false, error: err.message, detail: err.cause || null });
    }
  } catch (err) { next(err); }
});

serversRouter.post('/:id/docker/logout', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Server not found' });
    const registry = String(req.body.registry || '').trim() || DOCKER_HUB;
    try {
      const result = await withConnection(connectionFromRow(row), (conn) => registryLogout(conn, row, registry));
      await logActivity('server', row.id, 'docker_logout', `Signed ${row.name} out of ${registryLabel(registry)}`);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message, detail: err.cause || null });
    }
  } catch (err) { next(err); }
});

/** Remove a named volume — with the data in it. */
serversRouter.delete('/:id/docker/volumes/:name', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Server not found' });
    const named = validateName(req.params.name, 'volume name');
    if (named.error) return res.status(400).json({ error: named.error });

    // A volume this panel installed something onto belongs to that install.
    const install = await one('SELECT name FROM installations WHERE server_id = ? AND volume = ?', [row.id, named.value]);
    if (install && req.query.force !== '1') {
      return res.status(409).json({
        error: `"${named.value}" holds the data for "${install.name}", which this panel installed. `
          + 'Remove that service instead — it will offer to delete the volume with it.',
      });
    }

    try {
      const result = await withConnection(connectionFromRow(row), (conn) => removeVolume(conn, row, named.value));
      await logActivity('server', row.id, 'docker_volume_removed',
        `Removed Docker volume "${named.value}" from ${row.name}`, 'warn');
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message, detail: err.cause || null });
    }
  } catch (err) { next(err); }
});

serversRouter.delete('/:id/docker/networks/:name', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Server not found' });
    const named = validateName(req.params.name, 'network name');
    if (named.error) return res.status(400).json({ error: named.error });
    try {
      const result = await withConnection(connectionFromRow(row), (conn) => removeNetwork(conn, row, named.value));
      await logActivity('server', row.id, 'docker_network_removed', `Removed Docker network "${named.value}" from ${row.name}`);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message, detail: err.cause || null });
    }
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------- summary */

/**
 * What is on this server, counted — one SSH pass for the Overview tab.
 *
 * The machine is asked for what it is running; the panel's own tables are
 * asked for what it was told to run. Both are returned, because the gap
 * between them is usually the interesting part.
 */
serversRouter.get('/:id/summary', serverRoute(async (conn, row, req) => {
  const [live, apps, installs, runners] = await Promise.all([
    collectSummary(conn, row),
    all('SELECT status FROM apps WHERE server_id = ? AND org_id = ?', [row.id, req.orgId]),
    all('SELECT status FROM installations WHERE server_id = ? AND org_id = ?', [row.id, req.orgId]),
    all('SELECT status FROM runners WHERE server_id = ? AND org_id = ?', [row.id, req.orgId]),
  ]);

  const countBy = (rows, matches) => rows.filter((r) => matches.includes(r.status)).length;

  return {
    summary: {
      ...live,
      // What this panel put here, from its own tables.
      apps: {
        total: apps.length,
        running: countBy(apps, ['running']),
        deploying: countBy(apps, ['deploying']),
        broken: countBy(apps, ['error', 'exited', 'missing']),
      },
      installs: {
        total: installs.length,
        running: countBy(installs, ['running']),
        broken: countBy(installs, ['error', 'exited', 'missing']),
      },
      registeredRunners: {
        total: runners.length,
        online: countBy(runners, ['online', 'idle', 'busy']),
      },
    },
  };
}));

/* ---------------------------------------------------------------- cron */

/** Everything scheduled on this server, wherever it is written down. */
serversRouter.get('/:id/cron', serverRoute(async (conn, row) => ({
  cron: await cronState(conn, row),
})));

serversRouter.post('/:id/cron/install', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Server not found' });
    try {
      const result = await withConnection(connectionFromRow(row), (conn) => installCron(conn, row));
      await logActivity('server', row.id, 'cron_installed', `Installed cron on ${row.name}`);
      res.status(201).json({ ok: true, ...result });
    } catch (err) {
      await logActivity('server', row.id, 'cron_install_failed', `${row.name}: ${err.message}`, 'error');
      res.status(400).json({ ok: false, error: err.message, detail: err.cause || null });
    }
  } catch (err) { next(err); }
});

/** The schedule and command from the form, checked before cron ever sees them. */
function cronJobFromBody(body) {
  const user = validateUser(body.user);
  if (user.error) return { error: user.error };

  const schedule = validateSchedule(body.schedule);
  if (schedule.error) return { error: schedule.error };

  const command = validateCommand(body.command);
  if (command.error) return { error: command.error };

  return { value: { user: user.value, schedule: schedule.value, command: command.value } };
}

/** Add a job to a user's crontab. */
serversRouter.post('/:id/cron/jobs', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Server not found' });

    const { value, error } = cronJobFromBody(req.body);
    if (error) return res.status(400).json({ error });

    try {
      const result = await withConnection(connectionFromRow(row), (conn) => addJob(conn, row, value));
      await logActivity('server', row.id, 'cron_job_added',
        `Added a cron job for ${value.user} on ${row.name}: ${value.schedule} ${value.command.slice(0, 120)}`);
      res.status(201).json({ ok: true, ...result, job: value });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message, detail: err.cause || null });
    }
  } catch (err) { next(err); }
});

/**
 * Change one job. `old_line` is the line as it was on screen, so an edit made
 * from a stale page is refused rather than overwriting something else.
 */
serversRouter.put('/:id/cron/jobs', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Server not found' });

    const { value, error } = cronJobFromBody(req.body);
    if (error) return res.status(400).json({ error });

    const oldLine = String(req.body.old_line || '');
    if (!oldLine.trim()) return res.status(400).json({ error: 'Which job to change was not sent — reload the page and try again' });

    try {
      const result = await withConnection(connectionFromRow(row), (conn) => updateJob(conn, row, { ...value, oldLine }));
      await logActivity('server', row.id, 'cron_job_updated',
        `Changed a cron job for ${value.user} on ${row.name}: ${value.schedule} ${value.command.slice(0, 120)}`);
      res.json({ ok: true, ...result, job: value });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message, detail: err.cause || null });
    }
  } catch (err) { next(err); }
});

/* --------------------------------------------------------------- reboot */

/**
 * Restart the machine. The reboot is started detached a couple of seconds
 * later, so this SSH session can answer before the connection drops.
 */
serversRouter.post('/:id/reboot', requirePermission('edit'), serverRoute(async (conn, row, req) => {
  if (String(req.body?.confirm || '') !== row.name) {
    throw Object.assign(new Error('Type the server name to confirm the reboot'), { status: 400 });
  }
  const result = await rootExec(conn, row, `set -u
[ "$(id -u)" = 0 ] || { echo "@@notroot" >&2; exit 97; }
setsid nohup sh -c 'sleep 2; systemctl reboot || shutdown -r now || reboot' >/dev/null 2>&1 < /dev/null &
echo scheduled`, { timeout: 20000 });
  if (result.code === 97 || /(a password is required|no tty present|not in the sudoers file|incorrect password attempt)/i.test(result.stderr)) {
    throw new Error(`You are not permitted to reboot this server — the SSH login "${row.username}" cannot become root. Connect as root, give it sudo, or store its sudo password on the server.`);
  }
  if (!/scheduled/.test(result.stdout)) {
    throw new Error(`The reboot could not be started${result.stderr ? `: ${result.stderr.trim().split('\n').slice(-2).join(' · ').slice(0, 200)}` : ''}`);
  }
  await markStatus(row.id, 'rebooting');
  await logActivity('server', row.id, 'server_rebooted', `${req.user.name} rebooted ${row.name}`);
  return { rebooting: true };
}));

/* --------------------------------------------------------- ubuntu users */

/**
 * Linux accounts can grant root, so the panel role is checked first: looking
 * needs "edit" (an editor or an admin), adding "create", changing "edit",
 * deleting "delete". Then the server itself is asked whether the SSH login
 * can become root — without it nothing is read.
 */
const usersAccess = (action) => (req, res, next) => {
  if (can(req.user, 'edit') && can(req.user, action)) return next();
  res.status(403).json({
    error: `${NOT_PERMITTED}. Your role (${String(req.user?.role || 'viewer').replace('_', ' ')}) cannot ${action === 'delete' ? 'delete' : action === 'create' ? 'add' : 'change'} server users — ask an admin of your organisation.`,
    forbidden: true, notPermitted: true,
  });
};

/** Run fn with the server's current users, answering "not permitted" rather than failing when the login is not root. */
function usersRoute(action, fn) {
  return [usersAccess(action), async (req, res, next) => {
    try {
      const row = await getRow(req.params.id, req.orgId);
      if (!row) return res.status(404).json({ error: 'Server not found' });
      try {
        res.json({ ok: true, ...(await withConnection(connectionFromRow(row), (conn) => fn(conn, row, req))) });
      } catch (err) {
        if (err.notPermitted) return res.status(403).json({ ok: false, error: err.message, notPermitted: true, sshNotRoot: true });
        res.status(err.status || 400).json({ ok: false, error: err.message, detail: err.cause || null });
      }
    } catch (err) { next(err); }
  }];
}

const refuse = (message, status = 400) => Object.assign(new Error(message), { status });

/** The account being changed, and whether the panel may change it in this way. */
async function targetUser(conn, row, name, want) {
  const state = await usersState(conn, row);
  const u = state.users.find((x) => x.name === name);
  if (!u) throw refuse(`There is no user called "${name}" on this server — refresh the page`, 404);
  if (u.kind === 'system') throw refuse(`"${name}" is a system account that belongs to a package; the panel does not change it`);
  if (u.kind === 'root' && want.some((w) => !['password', 'keys'].includes(w))) {
    throw refuse('For root the panel only changes the password and SSH keys — it is never deleted, locked or renamed');
  }
  if (u.isLogin && want.includes('delete')) throw refuse(`"${name}" is the account this panel logs in with — deleting it would cut the panel off from the server`);
  if (u.isLogin && want.includes('lock')) throw refuse(`"${name}" is the account this panel logs in with — locking it would cut the panel off from the server`);
  if (u.isLogin && want.includes('unsudo')) throw refuse(`"${name}" is the account this panel logs in with — it has to keep sudo`);
  if (u.isLogin && want.includes('noshell')) throw refuse(`"${name}" is the account this panel logs in with — it needs a login shell`);
  return u;
}

serversRouter.get('/:id/users', ...usersRoute('edit', async (conn, row) => ({ users: await usersState(conn, row) })));

serversRouter.post('/:id/users', ...usersRoute('create', async (conn, row, req) => {
  const b = req.body || {};
  const checks = {
    username: validateUsername(b.username, { creating: true }),
    fullName: validateFullName(b.full_name),
    shell: validateShell(b.shell),
    password: validatePassword(b.password),
    groups: validateGroups(b.groups),
    keys: validatePublicKeys(b.public_keys),
    keyComment: validateKeyComment(b.key_comment),
  };
  const bad = Object.values(checks).find((c) => c.error);
  if (bad) throw refuse(bad.error);
  const spec = Object.fromEntries(Object.entries(checks).map(([k, c]) => [k, c.value]));
  spec.sudo = Boolean(b.sudo);
  spec.noPasswordSudo = Boolean(b.sudo && b.no_password_sudo);
  spec.generateKey = Boolean(b.generate_key);
  if (!spec.password && !spec.keys.length && !spec.generateKey) {
    throw refuse('Give the user a password, an SSH key, or both — otherwise nobody can log in as them');
  }

  const result = await createUser(conn, row, spec);
  await logActivity('server', row.id, 'os_user_created',
    `Added the user ${spec.username} on ${row.name}${spec.sudo ? ' (sudo)' : ''}${spec.keys.length || spec.generateKey ? ' with an SSH key' : ''}`);
  return { username: spec.username, ...result };
}));

serversRouter.put('/:id/users/:name', ...usersRoute('edit', async (conn, row, req) => {
  const b = req.body || {};
  const name = validateUsername(req.params.name);
  if (name.error) throw refuse(name.error);

  const spec = {};
  const want = [];
  if (b.full_name !== undefined) { const v = validateFullName(b.full_name); if (v.error) throw refuse(v.error); spec.fullName = v.value; want.push('profile'); }
  if (b.shell !== undefined) {
    const v = validateShell(b.shell); if (v.error) throw refuse(v.error);
    spec.shell = v.value; want.push('profile');
    if (/(nologin|false)$/.test(v.value)) want.push('noshell');
  }
  if (b.groups !== undefined) { const v = validateGroups(b.groups); if (v.error) throw refuse(v.error); spec.groups = v.value; want.push('groups'); }
  if (b.password) { const v = validatePassword(b.password); if (v.error) throw refuse(v.error); spec.password = v.value; want.push('password'); }
  if (b.sudo !== undefined) {
    spec.sudo = Boolean(b.sudo); spec.noPasswordSudo = Boolean(b.sudo && b.no_password_sudo);
    want.push(spec.sudo ? 'sudo' : 'unsudo');
  }
  if (b.locked !== undefined) { spec.locked = Boolean(b.locked); want.push(spec.locked ? 'lock' : 'unlock'); }

  const u = await targetUser(conn, row, name.value, want);
  // Nothing actually moving on sudo is not a change worth refusing or logging.
  if (spec.sudo !== undefined && spec.sudo === u.sudo && spec.noPasswordSudo === u.noPasswordSudo) delete spec.sudo;
  if (spec.fullName === u.fullName) delete spec.fullName;
  if (spec.shell === u.shell) delete spec.shell;

  await updateUser(conn, row, name.value, spec);
  const what = [
    spec.password && 'password', spec.fullName !== undefined && 'name', spec.shell && `shell ${spec.shell}`,
    spec.groups && 'groups', spec.sudo !== undefined && (spec.sudo ? 'sudo on' : 'sudo off'),
    spec.locked === true && 'locked', spec.locked === false && 'unlocked',
  ].filter(Boolean);
  if (what.length) await logActivity('server', row.id, 'os_user_updated', `Changed the user ${name.value} on ${row.name}: ${what.join(', ')}`);
  return { changed: what };
}));

/** Add public keys, or have the server make a new pair and hand back the private half once. */
serversRouter.post('/:id/users/:name/keys', ...usersRoute('create', async (conn, row, req) => {
  const b = req.body || {};
  const name = validateUsername(req.params.name);
  if (name.error) throw refuse(name.error);
  const keys = validatePublicKeys(b.public_keys);
  if (keys.error) throw refuse(keys.error);
  const comment = validateKeyComment(b.key_comment);
  if (comment.error) throw refuse(comment.error);
  const generateKey = Boolean(b.generate_key);
  if (!keys.value.length && !generateKey) throw refuse('Paste a public key, or choose to generate a new one');

  await targetUser(conn, row, name.value, ['keys']);
  const result = await updateUser(conn, row, name.value, { keys: keys.value, generateKey, keyComment: comment.value });
  await logActivity('server', row.id, 'os_user_key_added',
    `${generateKey ? 'Generated a new SSH key' : `Added ${keys.value.length} SSH key${keys.value.length > 1 ? 's' : ''}`} for ${name.value} on ${row.name}`);
  return result;
}));

serversRouter.delete('/:id/users/:name/keys', ...usersRoute('delete', async (conn, row, req) => {
  const name = validateUsername(req.params.name);
  if (name.error) throw refuse(name.error);
  const fp = String(req.body?.fingerprint || '').trim();
  if (!/^(SHA256|MD5):[A-Za-z0-9+/=:]+$/.test(fp)) throw refuse('Which key to remove was not sent — refresh the page');
  await targetUser(conn, row, name.value, ['keys']);
  await removeKey(conn, row, name.value, fp);
  await logActivity('server', row.id, 'os_user_key_removed', `Removed the SSH key ${fp} from ${name.value} on ${row.name}`);
  return {};
}));

serversRouter.delete('/:id/users/:name', ...usersRoute('delete', async (conn, row, req) => {
  const name = validateUsername(req.params.name);
  if (name.error) throw refuse(name.error);
  const removeHome = ['1', 'true', 'on'].includes(String(req.query.remove_home || req.body?.remove_home || ''));
  await targetUser(conn, row, name.value, ['delete']);
  await deleteUser(conn, row, name.value, { removeHome });
  await logActivity('server', row.id, 'os_user_deleted', `Deleted the user ${name.value} from ${row.name}${removeHome ? ' with its home folder' : ''}`);
  return { removeHome };
}));

serversRouter.delete('/:id/cron/jobs', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Server not found' });

    const user = validateUser(req.body.user);
    if (user.error) return res.status(400).json({ error: user.error });
    const oldLine = String(req.body.old_line || '');
    if (!oldLine.trim()) return res.status(400).json({ error: 'Which job to remove was not sent — reload the page and try again' });

    try {
      const result = await withConnection(connectionFromRow(row),
        (conn) => deleteJob(conn, row, { user: user.value, oldLine }));
      await logActivity('server', row.id, 'cron_job_removed',
        `Removed a cron job from ${user.value} on ${row.name}: ${oldLine.slice(0, 120)}`);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message, detail: err.cause || null });
    }
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------- runners */

/**
 * The CI runners on this server, as the machine itself reports them.
 *
 * The runners list elsewhere shows what the provider thinks; this asks the
 * server. A runner whose service has died still sits in GitHub's list, and a
 * runner somebody installed by hand is not in the panel's list at all — so
 * both are worth saying out loud on the server's own page.
 */
serversRouter.get('/:id/runners', serverRoute(async (conn, row, req) => {
  const rows = await all('SELECT * FROM runners WHERE server_id = ? AND org_id = ? ORDER BY created_at DESC',
    [row.id, req.orgId]);

  const state = await runnerState(conn, row, rows.map((r) => r.service_name).filter(Boolean));
  const byService = new Map(state.units.map((u) => [u.service, u]));

  const runners = rows.map((r) => {
    const unit = r.service_name ? byService.get(r.service_name) : null;
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      scope: r.scope,
      target: r.target,
      labels: (r.labels || '').split(',').filter(Boolean),
      serviceName: r.service_name,
      // What the provider last said, kept apart from what the machine says.
      providerStatus: r.status,
      lastError: r.last_error,
      live: unit || null,
      running: Boolean(unit?.running),
    };
  });

  // The row's status is what the rest of the panel reads, so bring it in line
  // with what the server just said rather than leaving it stale.
  for (const r of runners) {
    if (!r.live) continue;
    const status = r.running ? 'online' : 'offline';
    if (status !== r.providerStatus && ['online', 'offline', 'error', 'missing', 'pending'].includes(r.providerStatus)) {
      await run('UPDATE runners SET status = ? WHERE id = ?', [status, r.id]);
      r.providerStatus = status;
    }
  }

  // Runner services on the machine that no row of ours accounts for.
  const known = new Set(rows.map((r) => r.service_name).filter(Boolean));
  const unknown = state.found.filter((f) => !known.has(f.service));

  return {
    runners,
    unknown,
    jobsRunning: state.jobsRunning,
    workers: state.workers,
    totals: {
      installed: runners.length,
      running: runners.filter((r) => r.running).length,
      stopped: runners.filter((r) => r.live && !r.running).length,
      missing: runners.filter((r) => r.serviceName && !r.live).length,
    },
  };
}));

/* ------------------------------------------------------ live statistics */

/** One sample, for anything that wants a number rather than a stream. */
serversRouter.get('/:id/stats', serverRoute(async (conn, row, req) => ({
  stats: await collectLiveStats(conn, row, { withDocker: req.query.docker !== '0' }),
})));

/**
 * The live view: one SSH connection held open, a sample pushed every few
 * seconds over server-sent events.
 *
 * Polling would open a connection per sample — an SSH handshake every three
 * seconds per watcher — so the connection is kept and the samples are pushed
 * instead. The stream ends itself after a while; EventSource reconnects on its
 * own, which also means a watcher who walks away does not hold a session open
 * forever.
 */
const MAX_STREAMS = Number(process.env.STATS_MAX_STREAMS || 8);
const STREAM_MINUTES = Number(process.env.STATS_STREAM_MINUTES || 15);
let openStreams = 0;

serversRouter.get('/:id/stats/stream', async (req, res, next) => {
  let row;
  try {
    row = await getRow(req.params.id, req.orgId);
  } catch (err) {
    return next(err);
  }
  if (!row) return res.status(404).json({ error: 'Server not found' });
  if (openStreams >= MAX_STREAMS) {
    return res.status(429).json({ error: 'Too many live views are open at once. Close one and try again.' });
  }

  // From here a slot is taken, so every path below has to give it back.
  openStreams += 1;
  try {
    const intervalMs = Math.max(2000, Math.min(60000, Number(req.query.every) || 5000));

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Tells nginx, if the panel is behind one, not to buffer this.
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 5000\n\n`);
    res.flushHeaders?.();

    let open = true;
    const stop = () => { open = false; };
    req.on('close', stop);
    req.on('aborted', stop);

    const send = (event, payload) => {
      if (!open) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    const endAt = Date.now() + STREAM_MINUTES * 60000;

    try {
      await withConnection(connectionFromRow(row), async (conn) => {
        // The first sample says whether Docker is even there, so the expensive
        // `docker stats` call is skipped from then on when it is not.
        let withDocker = true;
        let failures = 0;

        while (open && Date.now() < endAt) {
          const started = Date.now();
          try {
            const sample = await collectLiveStats(conn, row, { withDocker });
            withDocker = sample.docker.running;
            failures = 0;
            send('sample', sample);
          } catch (err) {
            failures += 1;
            send('problem', { error: err.message });
            if (failures >= 3) break;
          }
          const wait = Math.max(0, intervalMs - (Date.now() - started));
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
      });
    } catch (err) {
      send('problem', { error: err.message, fatal: true });
    }

    send('end', { reason: open ? 'The live view timed out — it will reconnect.' : 'closed' });
    res.end();
  } catch (err) {
    // The stream's headers are long gone by now, so an error can only be said
    // down the stream itself — handing it to express would try to set them again.
    if (res.headersSent) {
      res.write(`event: problem\ndata: ${JSON.stringify({ error: err.message, fatal: true })}\n\n`);
      res.end();
    } else {
      next(err);
    }
  } finally {
    openStreams = Math.max(0, openStreams - 1);
  }
});

/* ------------------------------------------- any container on the host */

/** start / stop / restart a container, whoever put it there. */
serversRouter.post('/:id/containers/:name/action', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Server not found' });
    const named = validateName(req.params.name, 'container name');
    if (named.error) return res.status(400).json({ error: named.error });
    const action = String(req.body.action || '');
    if (!CONTAINER_ACTIONS.includes(action)) {
      return res.status(400).json({ error: `action must be one of ${CONTAINER_ACTIONS.join(', ')}` });
    }

    try {
      const result = await withConnection(connectionFromRow(row), async (conn) => {
        await requireDocker(conn, row);
        return containerAction(conn, row, named.value, action);
      });
      await logActivity('server', row.id, `container_${action}`, `${action} ${named.value} on ${row.name} → ${result.state}`);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message, dockerMissing: err instanceof DockerMissingError });
    }
  } catch (err) { next(err); }
});

/** Everything about one container: state, stats, ports, mounts, networks, processes, logs. */
serversRouter.get('/:id/containers/:name', serverRoute(async (conn, row, req) => {
  const named = validateName(req.params.name, 'container name');
  if (named.error) throw new Error(named.error);
  await requireDocker(conn, row);
  return { container: await containerDetails(conn, row, named.value) };
}));

/** Remove a container that is not one of the panel's own. */
serversRouter.delete('/:id/containers/:name', serverRoute(async (conn, row, req) => {
  const named = validateName(req.params.name, 'container name');
  if (named.error) throw new Error(named.error);
  await requireDocker(conn, row);
  const volumes = req.body?.volumes === true;
  const result = await removeAnyContainer(conn, row, named.value, { volumes });
  await logActivity('server', row.id, 'container_removed', `Removed the container ${named.value} from ${row.name}${volumes ? ' with its anonymous volumes' : ''}`, 'warn');
  return result;
}));

serversRouter.get('/:id/containers/:name/logs', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Server not found' });
    const named = validateName(req.params.name, 'container name');
    if (named.error) return res.status(400).json({ error: named.error });
    try {
      const logs = await withConnection(connectionFromRow(row), async (conn) => {
        await requireDocker(conn, row);
        return containerLogs(conn, row, named.value, Number(req.query.tail) || 200);
      });
      res.json({ ok: true, name: named.value, logs });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  } catch (err) { next(err); }
});

/* -------------------------------------------------------------- nginx */

/** nginx, its sites and its certificates — everything the tab draws. */
serversRouter.get('/:id/nginx', serverRoute(async (conn, row) => ({
  nginx: await nginxState(conn, row),
})));

serversRouter.post('/:id/nginx/install', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Server not found' });
    const what = req.body.what === 'certbot' ? 'certbot' : 'nginx';
    try {
      const result = await withConnection(connectionFromRow(row),
        (conn) => (what === 'certbot' ? installCertbot(conn, row) : installNginx(conn, row)));
      await logActivity('server', row.id, `${what}_installed`,
        `Installed ${what} on ${row.name}${result.version ? ` (${result.version})` : ''}`);
      res.status(201).json({ ok: true, what, ...result });
    } catch (err) {
      await logActivity('server', row.id, `${what}_install_failed`, `${row.name}: ${err.message}`, 'error');
      res.status(400).json({ ok: false, error: err.message, detail: err.cause || null });
    }
  } catch (err) { next(err); }
});

/** reload / restart / start / stop / test. */
serversRouter.post('/:id/nginx/action', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Server not found' });
    const action = String(req.body.action || '');
    try {
      const result = await withConnection(connectionFromRow(row), (conn) => nginxAction(conn, row, action));
      await logActivity('server', row.id, `nginx_${action}`, `nginx ${action} on ${row.name}`);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message, detail: err.cause || null });
    }
  } catch (err) { next(err); }
});

/* ----------------------------------------------------- nginx: upstreams */

const describeUpstream = (spec) => `${spec.name} → ${spec.servers.map((s) => s.address).join(', ')}`;

/** Add an upstream. */
serversRouter.post('/:id/nginx/upstreams', serverRoute(async (conn, row, req) => {
  const { value, error } = validateUpstream(req.body);
  if (error) throw new Error(error);
  const result = await saveUpstream(conn, row, { spec: value });
  await logActivity('server', row.id, 'nginx_upstream_created', `Added nginx upstream ${describeUpstream(value)} on ${row.name}`);
  return result;
}));

/** Change an upstream — its servers, ports, weights and balancing — where it is. */
serversRouter.put('/:id/nginx/upstreams/:name', serverRoute(async (conn, row, req) => {
  const { value, error } = validateUpstream(req.body);
  if (error) throw new Error(error);
  const result = await saveUpstream(conn, row, { spec: value, originalName: req.params.name, file: req.body.file });
  await logActivity('server', row.id, 'nginx_upstream_updated', `Changed nginx upstream ${describeUpstream(value)} on ${row.name}`);
  return result;
}));

serversRouter.delete('/:id/nginx/upstreams/:name', serverRoute(async (conn, row, req) => {
  const result = await deleteUpstream(conn, row, req.params.name);
  await logActivity('server', row.id, 'nginx_upstream_deleted', `Removed nginx upstream ${req.params.name} from ${row.name}`, 'warn');
  return result;
}));

/* --------------------------------------------------------- nginx: sites */

/**
 * Turn the add/edit form into a vhost.
 *
 * `config` sent on its own is the file exactly as typed — that is how a site
 * nginx already had, or one certbot has rewritten, stays editable without the
 * panel insisting on its own shape.
 */
function siteFromBody(body) {
  const domains = [];
  for (const raw of String(body.domains || '').split(/[\s,]+/).filter(Boolean)) {
    const checked = validateDomain(raw);
    if (checked.error) return { error: checked.error };
    if (!domains.includes(checked.value)) domains.push(checked.value);
  }
  if (!domains.length) return { error: 'Give at least one domain for this site' };
  if (domains.length > 20) return { error: 'That is more domains than one site should carry' };

  const named = validateSiteName(body.name || domains[0]);
  if (named.error) return { error: named.error };

  // Raw editing wins: what is in the box is what is written.
  if (typeof body.config === 'string' && body.config.trim()) {
    if (body.config.length > 200000) return { error: 'That configuration is too long' };
    return { value: { name: named.value, domains, content: body.config.replace(/\r\n/g, '\n') } };
  }

  const kind = body.kind === 'static' ? 'static' : 'proxy';
  const spec = {
    name: named.value,
    domains,
    kind,
    spa: body.spa === true || body.spa === 'true',
    websockets: body.websockets === undefined ? true : (body.websockets === true || body.websockets === 'true'),
    maxBodySize: /^\d{1,4}[kmg]$/i.test(String(body.max_body_size || '')) ? String(body.max_body_size).toLowerCase() : '25m',
  };

  if (kind === 'static') {
    const root = String(body.root || '').trim();
    if (!/^\/[A-Za-z0-9._/-]{1,190}$/.test(root)) {
      return { error: 'The folder to serve must be an absolute path such as /var/www/example.com' };
    }
    spec.root = root.replace(/\/+$/, '');
  } else {
    const target = String(body.upstream || '').trim();
    const port = Number(body.port);
    if (target) {
      if (!/^https?:\/\/[A-Za-z0-9._-]+(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/.test(target)) {
        return { error: 'What it proxies to must look like http://127.0.0.1:3000' };
      }
      spec.upstream = target;
    } else {
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return { error: 'Give the port on this server that the site should be proxied to' };
      }
      spec.upstream = `http://127.0.0.1:${port}`;
    }
  }

  return { value: { name: spec.name, domains, content: buildSiteConfig(spec) } };
}

/** Add a domain. */
serversRouter.post('/:id/nginx/sites', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Server not found' });

    const { value, error } = siteFromBody(req.body);
    if (error) return res.status(400).json({ error });

    try {
      const result = await withConnection(connectionFromRow(row), async (conn) => writeSite(conn, row, {
        name: value.name,
        content: value.content,
        enable: req.body.enabled !== false,
        mustBeNew: true,
      }));
      await logActivity('server', row.id, 'nginx_site_created',
        `Added ${value.domains.join(', ')} to nginx on ${row.name}`);
      res.status(201).json({ ok: true, ...result, domains: value.domains });
    } catch (err) {
      await logActivity('server', row.id, 'nginx_site_failed', `${value.name} on ${row.name}: ${err.message}`, 'error');
      res.status(400).json({ ok: false, error: err.message, detail: err.cause || null });
    }
  } catch (err) { next(err); }
});

/** The file as it stands, for the edit box. */
serversRouter.get('/:id/nginx/sites/:name', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Server not found' });
    const named = validateSiteName(req.params.name);
    if (named.error) return res.status(400).json({ error: named.error });
    try {
      res.json({ ok: true, ...(await withConnection(connectionFromRow(row), (conn) => readSite(conn, row, named.value))) });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  } catch (err) { next(err); }
});

/** Edit a domain — the whole file, or the form's fields again. */
serversRouter.put('/:id/nginx/sites/:name', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Server not found' });
    const named = validateSiteName(req.params.name);
    if (named.error) return res.status(400).json({ error: named.error });

    // Switching a site on or off changes nothing inside the file.
    if (req.body.enabled !== undefined && !req.body.config && !req.body.domains) {
      try {
        const result = await withConnection(connectionFromRow(row),
          (conn) => toggleSite(conn, row, named.value, req.body.enabled === true || req.body.enabled === 'true'));
        await logActivity('server', row.id, 'nginx_site_toggled',
          `${result.enabled ? 'Enabled' : 'Disabled'} ${named.value} on ${row.name}`);
        return res.json({ ok: true, ...result });
      } catch (err) {
        return res.status(400).json({ ok: false, error: err.message, detail: err.cause || null });
      }
    }

    const { value, error } = siteFromBody({ ...req.body, name: named.value });
    if (error) return res.status(400).json({ error });

    try {
      const result = await withConnection(connectionFromRow(row), (conn) => writeSite(conn, row, {
        name: named.value,
        content: value.content,
        enable: req.body.enabled !== false,
      }));
      await logActivity('server', row.id, 'nginx_site_updated', `Updated ${named.value} in nginx on ${row.name}`);
      res.json({ ok: true, ...result, domains: value.domains });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message, detail: err.cause || null });
    }
  } catch (err) { next(err); }
});

/** Remove a domain. The certificate, if it has one, is left alone. */
serversRouter.delete('/:id/nginx/sites/:name', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Server not found' });
    const named = validateSiteName(req.params.name);
    if (named.error) return res.status(400).json({ error: named.error });
    try {
      const result = await withConnection(connectionFromRow(row), (conn) => removeSite(conn, row, named.value));
      await logActivity('server', row.id, 'nginx_site_removed', `Removed ${named.value} from nginx on ${row.name}`);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message, detail: err.cause || null });
    }
  } catch (err) { next(err); }
});

/* -------------------------------------------------------- nginx: SSL */

/** Ask Let's Encrypt for a certificate and let certbot put it into the vhost. */
serversRouter.post('/:id/nginx/ssl', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Server not found' });

    const domains = [];
    for (const raw of String(req.body.domains || '').split(/[\s,]+/).filter(Boolean)) {
      const checked = validateDomain(raw);
      if (checked.error) return res.status(400).json({ error: checked.error });
      if (!domains.includes(checked.value)) domains.push(checked.value);
    }
    if (!domains.length) return res.status(400).json({ error: 'Pick the domain to get a certificate for' });

    const email = String(req.body.email || '').trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: `"${email}" is not an email address` });
    }

    try {
      const result = await withConnection(connectionFromRow(row), (conn) => issueCertificate(conn, row, {
        domains,
        email,
        redirect: req.body.redirect !== false,
        staging: req.body.staging === true || req.body.staging === 'true',
      }));
      await logActivity('server', row.id, 'ssl_issued', `Issued a certificate for ${domains.join(', ')} on ${row.name}`);
      res.status(201).json({ ok: true, ...result });
    } catch (err) {
      await logActivity('server', row.id, 'ssl_failed', `${domains.join(', ')} on ${row.name}: ${err.message}`, 'error');
      res.status(400).json({ ok: false, error: err.message, detail: err.cause || null });
    }
  } catch (err) { next(err); }
});

/** Renew everything due, or one certificate. */
serversRouter.post('/:id/nginx/ssl/renew', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Server not found' });
    const certName = req.body.cert_name ? String(req.body.cert_name).trim() : null;
    if (certName && !/^[A-Za-z0-9][A-Za-z0-9._*-]{0,120}$/.test(certName)) {
      return res.status(400).json({ error: 'That is not a certificate on this server' });
    }
    try {
      const result = await withConnection(connectionFromRow(row), (conn) => renewCertificates(conn, row, {
        certName,
        force: req.body.force === true || req.body.force === 'true',
      }));
      await logActivity('server', row.id, 'ssl_renewed',
        `Renewal run on ${row.name}${certName ? ` for ${certName}` : ''} — ${result.upToDate ? 'nothing was due' : 'certificates renewed'}`);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message, detail: err.cause || null });
    }
  } catch (err) { next(err); }
});

/* ------------------------------------------------ ad-hoc command (read) */

serversRouter.post('/:id/exec', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Server not found' });
    const command = (req.body.command || '').trim();
    if (!command) return res.status(400).json({ error: 'command is required' });
    try {
      const result = await withConnection(connectionFromRow(row), (conn) => exec(conn, command));
      await logActivity('server', row.id, 'exec', command);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  } catch (err) { next(err); }
});

/* ---------------------------------------------------------------- files */

/*
 * The Storage tab's file manager. Listing is open to anyone who can see the
 * server; reading a file's contents or downloading needs "edit", because the
 * files worth reading (.env, keys, configs) are the secrets. Changes need
 * create / edit / delete as usual.
 */

serversRouter.get('/:id/files', serverRoute(async (conn, row, req) => listDir(conn, row, req.query.path || '/')));

serversRouter.get('/:id/files/content', requirePermission('edit'), serverRoute(async (conn, row, req) => readFile(conn, row, req.query.path)));

serversRouter.get('/:id/files/download', requirePermission('edit'), async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Server not found' });
    try {
      await withConnection(connectionFromRow(row), (conn) => downloadTo(conn, row, req.query.path, res, {
        onInfo: ({ name, size }) => {
          res.setHeader('Content-Type', 'application/octet-stream');
          res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/["\\r\n]/g, '_')}"`);
          if (size) res.setHeader('Content-Length', String(size));
        },
      }));
      await logActivity('server', row.id, 'file_downloaded', `Downloaded ${req.query.path} from ${row.name}`);
      res.end();
    } catch (err) {
      if (res.headersSent) return res.destroy(err);
      res.status(400).json({ ok: false, error: err.message });
    }
  } catch (err) { next(err); }
});

/** A change to the filesystem, logged as what it did. */
const fileChange = (action, handler) => serverRoute(async (conn, row, req) => {
  const result = await handler(conn, row, req.body || {});
  await logActivity('server', row.id, `file_${action}`, `${result.summary} on ${row.name}`, action === 'deleted' ? 'warn' : 'info');
  return result;
});

serversRouter.put('/:id/files/content', fileChange('edited', async (conn, row, b) => {
  const r = await writeFile(conn, row, b.path, b.content);
  return { ...r, summary: `Saved ${r.path}` };
}));
serversRouter.post('/:id/files/folder', fileChange('folder_created', async (conn, row, b) => {
  const r = await makeFolder(conn, row, b.dir, b.name);
  return { ...r, summary: `Created the folder ${r.path}` };
}));
serversRouter.post('/:id/files/file', fileChange('created', async (conn, row, b) => {
  const r = await makeFile(conn, row, b.dir, b.name);
  return { ...r, summary: `Created ${r.path}` };
}));
serversRouter.post('/:id/files/upload', fileChange('uploaded', async (conn, row, b) => {
  const r = await uploadFile(conn, row, b.dir, b.name, b.data, { overwrite: b.overwrite === true });
  return { ...r, summary: `Uploaded ${r.path} (${r.size} bytes)` };
}));
serversRouter.put('/:id/files/move', fileChange('moved', async (conn, row, b) => {
  const r = await move(conn, row, b.from, b.to);
  return { ...r, summary: `Moved ${r.from} to ${r.to}` };
}));
serversRouter.post('/:id/files/copy', fileChange('copied', async (conn, row, b) => {
  const r = await copy(conn, row, b.from, b.to);
  return { ...r, summary: `Copied ${r.from} to ${r.to}` };
}));
serversRouter.put('/:id/files/permissions', fileChange('permissions', async (conn, row, b) => {
  const r = await setPermissions(conn, row, b.path, { mode: b.mode, owner: b.owner, group: b.group, recursive: b.recursive === true });
  return { ...r, summary: `Changed ${[b.mode && `mode ${b.mode}`, (b.owner || b.group) && `owner ${b.owner || ''}${b.group ? `:${b.group}` : ''}`].filter(Boolean).join(', ')} of ${r.path}${b.recursive ? ' (recursively)' : ''}` };
}));
serversRouter.post('/:id/files/extract', fileChange('extracted', async (conn, row, b) => {
  const r = await extract(conn, row, b.path);
  return { ...r, summary: `Extracted ${r.path} into ${r.into}` };
}));
serversRouter.delete('/:id/files', fileChange('deleted', async (conn, row, b) => {
  const r = await remove(conn, row, b.path);
  return { ...r, summary: `Deleted ${r.path}` };
}));
