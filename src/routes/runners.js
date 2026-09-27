/**
 * CI runners.
 *
 * A runner ties three things the panel already knows about together: a git
 * account (who it registers with), a repository or organisation (what it
 * builds) and one of your servers (where it actually runs). Creating one
 * mints a registration token from the provider, installs the runner over the
 * server's SSH connection and remembers the pairing.
 */

import { Router } from 'express';
import { all, one, run, logActivity } from '../db/index.js';
import { loadGitCredential } from '../lib/gitAccounts.js';
import {
  listRunners, createRegistrationToken, createRemoveToken, deleteRunner,
  latestRunnerVersion, runnersWebUrl,
} from '../lib/git.js';
import { connectionFromRow, withConnection, rootExec } from '../lib/ssh.js';
import { installRunner, removeRunner, validateRunnerName, RUNNER_ROOT } from '../lib/runnerInstall.js';

export const runnersRouter = Router();

const getRow = (id, orgId) => one('SELECT * FROM runners WHERE id = ? AND org_id = ?', [id, orgId]);

/** A runner row plus the names of the account and server behind it. */
async function publicRunner(row) {
  if (!row) return null;
  const { install_log, ...rest } = row;
  const server = await one('SELECT id, name, host, username, status FROM servers WHERE id = ?', [row.server_id]);
  const cred = await one('SELECT id, name, username FROM credentials WHERE id = ?', [row.credential_id]);
  return {
    ...rest,
    labels: (row.labels || '').split(',').filter(Boolean),
    server: server || null,
    account: cred || null,
    hasLog: Boolean(install_log),
  };
}

/* ---------------------------------------------------------------- list */

/** Every runner, or only those for one git account (`credential_id`) or server (`server_id`). */
runnersRouter.get('/', async (req, res, next) => {
  try {
    const where = ['org_id = ?'];
    const params = [req.orgId];
    if (req.query.credential_id) { where.push('credential_id = ?'); params.push(Number(req.query.credential_id)); }
    if (req.query.server_id) { where.push('server_id = ?'); params.push(Number(req.query.server_id)); }
    const rows = await all(
      `SELECT * FROM runners WHERE ${where.join(' AND ')} ORDER BY created_at DESC`,
      params
    );
    res.json(await Promise.all(rows.map(publicRunner)));
  } catch (err) { next(err); }
});

runnersRouter.get('/:id', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Runner not found' });
    res.json({ ...(await publicRunner(row)), installLog: row.install_log || null });
  } catch (err) { next(err); }
});

/* -------------------------------------------------------------- create */

runnersRouter.post('/', async (req, res, next) => {
  try {
    const credentialId = Number(req.body.credential_id);
    const serverId = Number(req.body.server_id);
    const scope = req.body.scope === 'org' ? 'org' : 'repo';
    const target = String(req.body.target || '').trim();
    const name = String(req.body.name || '').trim();
    const labels = String(req.body.labels || '').split(',').map((l) => l.trim()).filter(Boolean);
    const executor = ['shell', 'docker'].includes(req.body.executor) ? req.body.executor : 'shell';

    const nameError = validateRunnerName(name);
    if (nameError) return res.status(400).json({ error: nameError });
    if (!credentialId) return res.status(400).json({ error: 'Pick the git account the runner registers with' });
    if (!serverId) return res.status(400).json({ error: 'Pick the server the runner runs on' });
    if (!target) return res.status(400).json({ error: `Pick the ${scope === 'org' ? 'organisation' : 'repository'} this runner belongs to` });

    const server = await one('SELECT * FROM servers WHERE id = ? AND org_id = ?', [serverId, req.orgId]);
    if (!server) return res.status(400).json({ error: 'The selected server does not exist' });

    if (await one('SELECT id FROM runners WHERE credential_id = ? AND target = ? AND name = ? AND org_id = ?', [credentialId, target, name, req.orgId])) {
      return res.status(409).json({ error: `A runner named "${name}" is already registered for ${target}` });
    }

    if (!await one('SELECT id FROM credentials WHERE id = ? AND org_id = ?', [credentialId, req.orgId])) {
      return res.status(400).json({ error: 'That git account is not in this organisation' });
    }

    let account;
    try {
      account = await loadGitCredential(credentialId);
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }

    const kind = account.settings.kind;
    if (kind === 'bitbucket') return res.status(400).json({ error: 'Runners are available for GitHub and GitLab accounts, not Bitbucket.' });
    const serviceUser = String(req.body.service_user || '').trim() || server.username;
    const dir = `${RUNNER_ROOT}/${name}`;

    // The row is written first so a failed install is still visible and retryable.
    const { insertId } = await run(
      `INSERT INTO runners (org_id, name, credential_id, server_id, kind, scope, target, labels, runner_dir, service_user, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,'installing')`,
      [req.orgId, name, credentialId, serverId, kind, scope, target, labels.join(','), kind === 'gitlab' ? null : dir, serviceUser]
    );

    try {
      const registration = await createRegistrationToken(account.token, account.extra, scope, target, {
        description: name,
        labels,
      });

      const spec = kind === 'gitlab'
        ? {
          kind,
          url: account.settings.webUrl,
          token: registration.token,
          name,
          executor,
          dockerImage: String(req.body.docker_image || '').trim() || 'alpine:latest',
        }
        : {
          kind,
          dir,
          url: `${account.settings.webUrl}/${target}`,
          token: registration.token,
          name,
          labels: labels.join(','),
          version: await latestRunnerVersion(account.extra),
          serviceUser,
        };

      const { log, serviceName } = await withConnection(connectionFromRow(server), (conn) => installRunner(conn, server, spec));

      // GitHub only tells us the runner's id once it has enrolled itself.
      let remoteId = registration.remoteId;
      if (!remoteId) {
        const remote = await listRunners(account.token, account.extra, scope, target).catch(() => []);
        remoteId = remote.find((r) => r.name === name)?.id || null;
      }

      await run(
        `UPDATE runners SET status = 'online', service_name = ?, remote_id = ?, install_log = ?, last_error = NULL WHERE id = ?`,
        [serviceName || null, remoteId, log.slice(-60000), insertId]
      );
      await logActivity('runner', insertId, 'created',
        `Installed ${kind} runner "${name}" for ${target} on ${server.name}`);

      res.status(201).json({ ok: true, ...(await publicRunner(await getRow(insertId, req.orgId))), installLog: log });
    } catch (err) {
      await run("UPDATE runners SET status = 'error', last_error = ?, install_log = ? WHERE id = ?",
        [err.message, String(err.cause || '').slice(-60000) || null, insertId]);
      await logActivity('runner', insertId, 'install_failed', `${name} on ${server.name}: ${err.message}`, 'error');
      res.status(400).json({ ok: false, error: err.message, detail: err.cause || null, runner_id: insertId });
    }
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------- refresh */

/** Ask the provider what it thinks of this runner right now. */
runnersRouter.post('/:id/refresh', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Runner not found' });
    try {
      const account = await loadGitCredential(row.credential_id);
      const remote = await listRunners(account.token, account.extra, row.scope, row.target);
      const mine = remote.find((r) => (row.remote_id && r.id === row.remote_id) || r.name === row.name) || null;

      const status = mine ? (mine.busy ? 'busy' : mine.status) : 'missing';
      await run('UPDATE runners SET status = ?, remote_id = COALESCE(?, remote_id), last_error = ? WHERE id = ?',
        [status, mine?.id || null, mine ? null : 'The provider no longer lists this runner', row.id]);

      res.json({ ok: true, runner: mine, status, settingsUrl: runnersWebUrl(account.extra, row.scope, row.target) });
    } catch (err) {
      await run("UPDATE runners SET status = 'error', last_error = ? WHERE id = ?", [err.message, row.id]);
      res.status(400).json({ ok: false, error: err.message });
    }
  } catch (err) { next(err); }
});

/* -------------------------------------------------------------- control */

const SERVICE_ACTIONS = { start: 'start', stop: 'stop', restart: 'restart' };

/** Start, stop or restart the runner's systemd service on its server. */
runnersRouter.post('/:id/action', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Runner not found' });

    const action = SERVICE_ACTIONS[String(req.body.action || '')];
    if (!action) return res.status(400).json({ error: 'action must be start, stop or restart' });
    if (!row.service_name) return res.status(400).json({ error: 'This runner has no systemd service recorded — reinstall it.' });

    const server = await one('SELECT * FROM servers WHERE id = ? AND org_id = ?', [row.server_id, req.orgId]);
    if (!server) return res.status(400).json({ error: 'The server this runner runs on no longer exists' });

    try {
      const result = await withConnection(connectionFromRow(server), (conn) => rootExec(
        conn, server,
        `systemctl ${action} '${row.service_name}' 2>&1; systemctl is-active '${row.service_name}' || true`,
        { timeout: 60000 }
      ));
      const active = result.stdout.trim().split('\n').pop();
      await run('UPDATE runners SET status = ? WHERE id = ?', [active === 'active' ? 'online' : 'offline', row.id]);
      await logActivity('runner', row.id, `service_${action}`, `${action} ${row.service_name} on ${server.name} → ${active}`);
      res.json({ ok: true, action, active, output: result.stdout.trim() });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message, detail: err.cause || null });
    }
  } catch (err) { next(err); }
});

/* -------------------------------------------------------------- delete */

/**
 * Unregister the runner with the provider, take it off the server, and forget
 * it here. `?keep_machine=1` leaves the files in place.
 */
runnersRouter.delete('/:id', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Runner not found' });

    const server = await one('SELECT * FROM servers WHERE id = ? AND org_id = ?', [row.server_id, req.orgId]);
    const problems = [];
    let account = null;

    try {
      account = await loadGitCredential(row.credential_id);
    } catch (err) {
      problems.push(`Could not reach the git account: ${err.message}`);
    }

    if (server && req.query.keep_machine !== '1') {
      let removeToken = null;
      if (account && row.kind !== 'gitlab') {
        removeToken = await createRemoveToken(account.token, account.extra, row.scope, row.target).catch(() => null);
      }
      try {
        await withConnection(connectionFromRow(server), (conn) => removeRunner(conn, server, {
          kind: row.kind,
          dir: row.runner_dir,
          name: row.name,
          token: removeToken,
        }));
      } catch (err) {
        problems.push(`Could not clean up ${server.name}: ${err.message}`);
      }
    }

    if (account && row.remote_id) {
      await deleteRunner(account.token, account.extra, row.scope, row.target, row.remote_id)
        .catch((err) => problems.push(`The provider still lists the runner: ${err.message}`));
    }

    await run('DELETE FROM runners WHERE id = ?', [row.id]);
    await logActivity('runner', null, 'deleted', `Removed runner "${row.name}" (${row.target})`);
    res.json({ ok: true, warnings: problems });
  } catch (err) { next(err); }
});
