import { Router } from 'express';
import { all, one, run, logActivity } from '../db/index.js';
import { encrypt, decrypt, mask } from '../lib/crypto.js';
import {
  testMysql, inspectMysql, inspectDatabase, inspectTable, runReadOnlyQuery,
  listUsers, createUser, alterUser, dropUser, grantPrivileges, revokePrivileges,
  listCharsets, createDatabase, alterDatabase, dropDatabase, listVariables, setVariable,
} from '../lib/mysql.js';
import {
  authenticate, listRepositories, listBranches, listCommits, listOrganizations,
  listRunners, gitSettings, gitDefaults, gitKind, runnersWebUrl,
} from '../lib/git.js';
import { asJson, usableGitToken } from '../lib/gitAccounts.js';
import { engineFor, DATABASE_PROVIDERS } from '../lib/engines/index.js';
import {
  authenticateCloudflare, cloudflareLabel, listDnsRecords, getZoneDetail, deleteZone, tokenCreateUrl, TOKEN_PERMISSIONS,
  buildDnsRecord, createDnsRecord, updateDnsRecord, deleteDnsRecord, getDnsRecord,
  getZeroTrust, createTunnel, getTunnelToken, deleteTunnel, buildHostnameRule, addPublicHostname,
  updatePublicHostname, deletePublicHostname, createPrivateRoute, updatePrivateRoute, deletePrivateRoute, revokeDevice,
  createTeamDomain,
} from '../lib/cloudflare.js';
import {
  authenticateDockerHub, TOKEN_CREATE_URL as DOCKERHUB_TOKEN_URL,
  listRepositories as listHubRepositories, getRepository as getHubRepository, deleteTag as deleteHubTag,
} from '../lib/dockerhub.js';

export const credentialsRouter = Router();

const PROVIDERS = new Set(['git', 'dockerhub', 'cloudflare', 'mysql', 'postgres', 'mongodb', 'redis']);

async function publicCredential(row) {
  if (!row) return null;
  const { secret_enc, ...rest } = row;
  let secretHint = null;
  try {
    secretHint = mask(decrypt(secret_enc));
  } catch {
    secretHint = 'unreadable (master key changed?)';
  }
  const server = row.server_id
    ? await one('SELECT id, name, host FROM servers WHERE id = ?', [row.server_id])
    : null;
  return { ...rest, extra: publicExtra(asJson(row.extra)), server: server || null, secretHint };
}

/** `extra` is returned to the browser, so drop anything secret from it. */
function publicExtra(extra) {
  const out = {};
  for (const [k, v] of Object.entries(extra || {})) {
    if (/Enc$/.test(k)) continue;
    out[k] = v;
  }
  if (extra?.refreshTokenEnc) out.hasRefreshToken = true;
  return out;
}

const getRow = (id, orgId) => one('SELECT * FROM credentials WHERE id = ? AND org_id = ?', [id, orgId]);

/** Turn a stored mysql credential into a connection config, resolving its server for tunnelling. */
async function mysqlConfigFrom(row) {
  if (row.provider !== 'mysql') throw new Error(`Credential "${row.name}" is not a MySQL credential`);
  const extra = asJson(row.extra);
  let server = null;
  if (row.server_id) {
    server = await one('SELECT * FROM servers WHERE id = ?', [row.server_id]);
    if (!server) throw new Error('The server this credential tunnels through no longer exists');
  }
  return {
    host: extra.host || '127.0.0.1',
    port: Number(extra.port || 3306),
    user: row.username,
    password: decrypt(row.secret_enc),
    database: extra.database || null,
    server,
  };
}

/* ------------------------------------------------------------------ CRUD */

credentialsRouter.get('/', async (req, res, next) => {
  try {
    // ?provider=mysql,postgres lists several at once — the Databases page does.
    const providers = String(req.query.provider || '').split(',').map((p) => p.trim()).filter(Boolean);
    const rows = providers.length
      ? await all('SELECT * FROM credentials WHERE org_id = ? AND provider IN (?) ORDER BY created_at DESC', [req.orgId, providers])
      : await all('SELECT * FROM credentials WHERE org_id = ? ORDER BY provider, created_at DESC', [req.orgId]);
    res.json(await Promise.all(rows.map(publicCredential)));
  } catch (err) { next(err); }
});

credentialsRouter.get('/:id', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Credential not found' });
    res.json(await publicCredential(row));
  } catch (err) { next(err); }
});

credentialsRouter.post('/', async (req, res, next) => {
  try {
    const provider = (req.body.provider || '').trim();
    const name = (req.body.name || '').trim();
    const username = (req.body.username || '').trim();
    const secret = req.body.secret || '';
    const serverId = req.body.server_id ? Number(req.body.server_id) : null;

    if (!PROVIDERS.has(provider)) return res.status(400).json({ error: `provider must be one of ${[...PROVIDERS].join(', ')}` });
    if (!name) return res.status(400).json({ error: 'name is required' });
    // MongoDB and Redis can run without authentication, so an empty password is allowed there.
    const optionalSecret = provider === 'mongodb' || provider === 'redis';
    if (!secret && !optionalSecret) return res.status(400).json({ error: 'secret (token / password) is required' });
    if (provider === 'dockerhub' && !username) return res.status(400).json({ error: 'username is required for Docker Hub' });
    if (DATABASE_PROVIDERS[provider]?.userRequired && !username) {
      return res.status(400).json({ error: `username is required for ${DATABASE_PROVIDERS[provider].label}` });
    }

    const extra = buildExtra(provider, req.body);
    if (extra.error) return res.status(400).json({ error: extra.error });

    if (serverId && !await one('SELECT id FROM servers WHERE id = ? AND org_id = ?', [serverId, req.orgId])) {
      return res.status(400).json({ error: 'The selected server does not exist' });
    }
    if (await one('SELECT id FROM credentials WHERE provider = ? AND name = ? AND org_id = ?', [provider, name, req.orgId])) {
      return res.status(409).json({ error: `A ${provider} credential named "${name}" already exists` });
    }

    const { insertId } = await run(
      'INSERT INTO credentials (org_id, provider, name, username, secret_enc, extra, server_id) VALUES (?,?,?,?,?,?,?)',
      // An unauthenticated MongoDB / Redis has no secret; '' decrypts back to "none".
      [req.orgId, provider, name, username || null, encrypt(secret) || '', JSON.stringify(extra.value), serverId]
    );

    await logActivity('credential', insertId, 'created', `Added ${provider} credential "${name}"`);

    // A git account is authenticated as soon as it is added, so the row carries
    // the real account details instead of just a token.
    if (provider === 'git') {
      try {
        await storeGitAccount(insertId, await authenticate(secret, extra.value), extra.value);
      } catch (err) {
        await run("UPDATE credentials SET status='invalid', last_error=? WHERE id=?", [err.message, insertId]);
      }
    }
    if (provider === 'cloudflare') {
      try {
        await storeCloudflareAccount(insertId, await authenticateCloudflare(secret));
      } catch (err) {
        await run("UPDATE credentials SET status='invalid', last_error=? WHERE id=?", [err.message, insertId]);
      }
    }

    res.status(201).json(await publicCredential(await getRow(insertId, req.orgId)));
  } catch (err) { next(err); }
});

credentialsRouter.put('/:id', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Credential not found' });

    const extra = buildExtra(row.provider, { ...asJson(row.extra), ...req.body });
    if (extra.error) return res.status(400).json({ error: extra.error });

    const serverId = Number(req.body.server_id) || null;
    if (serverId && !await one('SELECT id FROM servers WHERE id = ? AND org_id = ?', [serverId, req.orgId])) {
      return res.status(400).json({ error: 'The selected server does not exist' });
    }

    await run(
      'UPDATE credentials SET name = ?, username = ?, secret_enc = ?, extra = ?, server_id = ? WHERE id = ?',
      [
        (req.body.name || row.name).trim(),
        req.body.username !== undefined ? (req.body.username || '').trim() || null : row.username,
        req.body.secret ? encrypt(req.body.secret) : row.secret_enc,
        JSON.stringify(extra.value),
        req.body.server_id !== undefined ? (Number(req.body.server_id) || null) : row.server_id,
        row.id,
      ]
    );

    await logActivity('credential', row.id, 'updated', `Updated ${row.provider} credential "${row.name}"`);
    res.json(await publicCredential(await getRow(row.id, req.orgId)));
  } catch (err) { next(err); }
});

credentialsRouter.delete('/:id', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Credential not found' });
    await run('DELETE FROM credentials WHERE id = ?', [row.id]);
    await logActivity('credential', null, 'deleted', `Removed ${row.provider} credential "${row.name}"`);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

function buildExtra(provider, body) {
  const db = DATABASE_PROVIDERS[provider];
  if (db) {
    const port = Number(body.port || db.defaultPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: `${db.label} port must be between 1 and 65535` };
    const value = {
      host: String(body.host || '127.0.0.1').trim(),
      port,
      database: String(body.database ?? '').trim() || null,
    };
    if (provider !== 'mysql') value.tls = body.tls === true || body.tls === 'on' || body.tls === 'true';
    if (provider === 'mongodb') value.authSource = String(body.authSource || '').trim() || 'admin';
    if (provider === 'redis' && value.database && !/^\d{1,3}$/.test(value.database)) return { error: 'The Redis database is a number, 0 to 15' };
    return { value };
  }

  if (provider === 'git') {
    const kind = gitKind(body.kind);
    const d = gitDefaults(kind);
    const authUser = kind === 'bitbucket' ? String(body.authUser || '').trim() : '';
    return {
      value: {
        kind,
        apiUrl: (body.apiUrl || d.apiUrl).trim().replace(/\/+$/, ''),
        webUrl: (body.webUrl || d.webUrl).trim().replace(/\/+$/, ''),
        ...(authUser ? { authUser } : {}),
        // Preserve an account captured by an earlier authentication.
        ...(body.account ? { account: body.account } : {}),
      },
    };
  }

  return { value: body.extra && typeof body.extra === 'object' ? body.extra : {} };
}

/**
 * Persist the authenticated git identity onto the credential row.
 * `existingExtra` is merged, not replaced, so an OAuth connection keeps its
 * refresh token and expiry when the account is re-checked.
 */
async function storeGitAccount(id, account, existingExtra = {}) {
  const merged = { ...existingExtra, ...gitSettings(existingExtra), account };
  await run(
    "UPDATE credentials SET username = ?, extra = ?, status = 'valid', last_error = NULL, verified_at = NOW() WHERE id = ?",
    [account.login, JSON.stringify(merged), id]
  );
  await logActivity('credential', id, 'git_authenticated', `Authenticated ${account.kind} account ${account.login}`);
  return account;
}

/** Persist what a Cloudflare token can see onto its credential row. */
async function storeCloudflareAccount(id, account) {
  await run(
    "UPDATE credentials SET username = ?, extra = ?, status = 'valid', last_error = NULL, verified_at = NOW() WHERE id = ?",
    [account.email || account.accounts[0]?.name || null, JSON.stringify({ account }), id]
  );
  await logActivity('credential', id, 'cloudflare_authenticated',
    `Read Cloudflare account ${cloudflareLabel(account)}: ${account.accounts.length} accounts, ${account.zones.length} zones`);
  return account;
}

/* ---------------------------------------------------------------- verify */

credentialsRouter.post('/:id/verify', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Credential not found' });
    try {
      const detail = await verifiers[row.provider](row);
      await run("UPDATE credentials SET status='valid', last_error=NULL, verified_at=NOW() WHERE id=?", [row.id]);
      await logActivity('credential', row.id, 'verified', `${row.provider} credential "${row.name}" verified`);
      res.json({ ok: true, detail });
    } catch (err) {
      await run("UPDATE credentials SET status='invalid', last_error=? WHERE id=?", [err.message, row.id]);
      await logActivity('credential', row.id, 'verify_failed', err.message, 'error');
      res.status(400).json({ ok: false, error: err.message, detail: err.cause || null });
    }
  } catch (err) { next(err); }
});

/** Test MySQL details before saving them. */
credentialsRouter.post('/test-mysql', async (req, res, next) => {
  try {
    const serverId = req.body.server_id ? Number(req.body.server_id) : null;
    let server = null;
    if (serverId) {
      server = await one('SELECT * FROM servers WHERE id = ? AND org_id = ?', [serverId, req.orgId]);
      if (!server) return res.status(400).json({ error: 'The selected server does not exist' });
    }
    if (!req.body.username) return res.status(400).json({ error: 'username is required' });

    try {
      const result = await testMysql({
        host: (req.body.host || '127.0.0.1').trim(),
        port: Number(req.body.port || 3306),
        user: req.body.username,
        password: req.body.secret || '',
        database: (req.body.database || '').trim() || null,
        server,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message, detail: err.cause || null });
    }
  } catch (err) { next(err); }
});

/** Authenticate a git token before saving it. */
credentialsRouter.post('/test-git', async (req, res) => {
  const token = req.body.secret || '';
  if (!token) return res.status(400).json({ error: 'A token is required' });
  try {
    const settings = buildExtra('git', req.body).value;
    res.json({ ok: true, account: await authenticate(token, settings) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

const verifiers = {
  async git(row) {
    const extra = asJson(row.extra);
    const account = await authenticate(await usableGitToken(row), extra);
    await storeGitAccount(row.id, account, extra);
    return account;
  },

  async dockerhub(row) {
    const account = await authenticateDockerHub(row.username, decrypt(row.secret_enc));
    await storeDockerHubAccount(row.id, account);
    return { username: account.username, repositories: account.repositoryCount, push: account.access?.push ?? null };
  },

  async cloudflare(row) {
    const account = await authenticateCloudflare(decrypt(row.secret_enc));
    await storeCloudflareAccount(row.id, account);
    return { tokenStatus: account.tokenStatus, accounts: account.accounts.length, zones: account.zones.length };
  },

  async mysql(row) {
    return testMysql(await mysqlConfigFrom(row));
  },

  postgres: (row) => testEngine(row),
  mongodb: (row) => testEngine(row),
  redis: (row) => testEngine(row),
};

async function testEngine(row) {
  const extra = asJson(row.extra);
  const server = row.server_id ? await one('SELECT * FROM servers WHERE id = ?', [row.server_id]) : null;
  return engineFor(row.provider).test({
    host: extra.host || '127.0.0.1',
    port: Number(extra.port || DATABASE_PROVIDERS[row.provider].defaultPort),
    user: row.username || '',
    password: decrypt(row.secret_enc),
    database: extra.database || null,
    authSource: extra.authSource || null,
    tls: Boolean(extra.tls),
    server,
  });
}

/* ------------------------------------------------------------ git views */

function gitRoute(handler) {
  return async (req, res) => {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Credential not found' });
    if (row.provider !== 'git') return res.status(400).json({ error: 'That credential is not a git account' });
    try {
      const settings = gitSettings(asJson(row.extra));
      res.json({ ok: true, ...(await handler(await usableGitToken(row), settings, req, row)) });
    } catch (err) {
      await run("UPDATE credentials SET status='invalid', last_error=? WHERE id=?", [err.message, row.id]);
      res.status(400).json({ ok: false, error: err.message });
    }
  };
}

/** Re-authenticate and refresh the stored account details. */
credentialsRouter.post('/:id/git/account', gitRoute(async (token, settings, req, row) => {
  const account = await authenticate(token, settings);
  await storeGitAccount(row.id, account, asJson(row.extra));
  return { account };
}));

/** Repositories this account can reach. */
credentialsRouter.post('/:id/git/repositories', gitRoute(async (token, settings) => ({
  repositories: await listRepositories(token, settings),
})));

/** Branches of one repository — `full` is "owner/repo". */
credentialsRouter.post('/:id/git/branches', gitRoute(async (token, settings, req) => {
  const full = (req.body.repo || '').trim();
  if (!full) throw new Error('A repository is required');
  return { repo: full, branches: await listBranches(token, settings, full) };
}));

/** Recent commits on a branch. */
credentialsRouter.post('/:id/git/commits', gitRoute(async (token, settings, req) => {
  const full = (req.body.repo || '').trim();
  const branch = (req.body.branch || '').trim();
  if (!full || !branch) throw new Error('A repository and branch are required');
  return { repo: full, branch, commits: await listCommits(token, settings, full, branch) };
}));

/** Organisations (GitHub) or groups (GitLab) a runner can be registered in. */
credentialsRouter.post('/:id/git/organizations', gitRoute(async (token, settings) => ({
  organizations: await listOrganizations(token, settings),
})));

/**
 * Runners the provider itself knows about for one repository, organisation or
 * group — including ones this panel never installed.
 */
credentialsRouter.post('/:id/git/runners', gitRoute(async (token, settings, req) => {
  const target = (req.body.target || '').trim();
  const scope = req.body.scope === 'org' ? 'org' : 'repo';
  if (!target) throw new Error('A repository or organisation is required');
  return {
    scope,
    target,
    settingsUrl: runnersWebUrl(settings, scope, target),
    runners: await listRunners(token, settings, scope, target),
  };
}));

/* ------------------------------------------------------ Docker Hub views */

/** Persist what a Docker Hub sign-in saw onto its credential row. */
async function storeDockerHubAccount(id, account) {
  await run(
    "UPDATE credentials SET username = ?, extra = ?, status = 'valid', last_error = NULL, verified_at = NOW() WHERE id = ?",
    [account.username, JSON.stringify({ account }), id]
  );
  await logActivity('credential', id, 'dockerhub_authenticated',
    `Signed in to Docker Hub as ${account.username}: ${account.repositoryCount ?? 0} repositories`);
  return account;
}

/** Where the browser flow sends the person to create a token. */
credentialsRouter.get('/dockerhub/token-link', (req, res) => {
  const org = req.organisation?.name ? ` (${req.organisation.name})` : '';
  res.json({ url: DOCKERHUB_TOKEN_URL, description: `AJ Pilot${org}`, permissions: 'Read, Write, Delete' });
});

/**
 * Finish the browser flow: sign in with the Docker ID and token, read the
 * account and store it. The same Docker ID again updates it in place.
 */
credentialsRouter.post('/dockerhub/connect', async (req, res, next) => {
  try {
    let account;
    try {
      account = await authenticateDockerHub(req.body.username, req.body.secret);
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }

    const name = (req.body.name || '').trim() || account.username;
    const secret = encrypt(String(req.body.secret).trim());
    const existing = await one(
      "SELECT id FROM credentials WHERE provider = 'dockerhub' AND org_id = ? AND (username = ? OR name = ?) ORDER BY username = ? DESC LIMIT 1",
      [req.orgId, account.username, name, account.username]
    );

    let id;
    if (existing) {
      id = existing.id;
      await run('UPDATE credentials SET name = ?, secret_enc = ? WHERE id = ?', [name, secret, id]);
      await logActivity('credential', id, 'dockerhub_reconnected', `Re-connected Docker Hub account ${account.username}`);
    } else {
      ({ insertId: id } = await run(
        "INSERT INTO credentials (org_id, provider, name, username, secret_enc, extra) VALUES (?, 'dockerhub', ?, ?, ?, '{}')",
        [req.orgId, name, account.username, secret]
      ));
      await logActivity('credential', id, 'dockerhub_connected', `Connected Docker Hub account ${account.username}`);
    }
    await storeDockerHubAccount(id, account);

    res.json({ ok: true, credential: await publicCredential(await getRow(id, req.orgId)) });
  } catch (err) { next(err); }
});

function dockerhubRoute(handler) {
  return async (req, res) => {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Credential not found' });
    if (row.provider !== 'dockerhub') return res.status(400).json({ error: 'That credential is not a Docker Hub account' });
    try {
      res.json({ ok: true, ...(await handler(row.username, decrypt(row.secret_enc), req, row)) });
    } catch (err) {
      if (err.status === 401) await run("UPDATE credentials SET status='invalid', last_error=? WHERE id=?", [err.message, row.id]);
      res.status(400).json({ ok: false, error: err.message });
    }
  };
}

/** Repositories in the account's own namespace, or one of its organisations. */
credentialsRouter.post('/:id/dockerhub/repositories', dockerhubRoute((user, secret, req) =>
  listHubRepositories(user, secret, req.body.namespace)));

/** One repository with every tag. */
credentialsRouter.post('/:id/dockerhub/repositories/:ns/:repo', dockerhubRoute((user, secret, req) =>
  getHubRepository(user, secret, req.params.ns, req.params.repo)));

credentialsRouter.delete('/:id/dockerhub/repositories/:ns/:repo/tags/:tag', dockerhubRoute(async (user, secret, req, row) => {
  const { ns, repo, tag } = req.params;
  await deleteHubTag(user, secret, ns, repo, tag);
  await logActivity('credential', row.id, 'dockerhub_tag_deleted', `Deleted tag ${ns}/${repo}:${tag} on Docker Hub`, 'warn');
  return { deleted: tag };
}));

/* ------------------------------------------------------ Cloudflare views */

/** The dashboard link that opens a pre-filled "Create API token" form. */
credentialsRouter.get('/cloudflare/token-link', (req, res) => {
  const org = req.organisation?.name ? ` (${req.organisation.name})` : '';
  res.json({ url: tokenCreateUrl(`AJ Pilot${org}`), permissions: TOKEN_PERMISSIONS.map((p) => p.label) });
});

/** Verify a token and show what it can see, without saving it. */
credentialsRouter.post('/test-cloudflare', async (req, res) => {
  try {
    res.json({ ok: true, account: await authenticateCloudflare(req.body.secret) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

/**
 * Finish the browser flow: verify the token, read the account and store it.
 * Connecting the same token (or the same login) again updates it in place.
 */
credentialsRouter.post('/cloudflare/connect', async (req, res, next) => {
  try {
    let account;
    try {
      account = await authenticateCloudflare(req.body.secret);
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }

    const name = (req.body.name || '').trim() || cloudflareLabel(account);
    const rows = await all("SELECT id, name, extra FROM credentials WHERE provider = 'cloudflare' AND org_id = ?", [req.orgId]);
    const existing = rows.find((r) => account.tokenId && asJson(r.extra).account?.tokenId === account.tokenId)
      || rows.find((r) => r.name === name);

    let id;
    if (existing) {
      id = existing.id;
      await run('UPDATE credentials SET name = ?, secret_enc = ? WHERE id = ?', [name, encrypt(String(req.body.secret).trim()), id]);
      await logActivity('credential', id, 'cloudflare_reconnected', `Re-connected Cloudflare account ${name}`);
    } else {
      ({ insertId: id } = await run(
        "INSERT INTO credentials (org_id, provider, name, secret_enc, extra) VALUES (?, 'cloudflare', ?, ?, '{}')",
        [req.orgId, name, encrypt(String(req.body.secret).trim())]
      ));
      await logActivity('credential', id, 'cloudflare_connected', `Connected Cloudflare account ${name}`);
    }
    await storeCloudflareAccount(id, account);

    res.json({ ok: true, credential: await publicCredential(await getRow(id, req.orgId)) });
  } catch (err) { next(err); }
});

function cloudflareRoute(handler) {
  return async (req, res) => {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Credential not found' });
    if (row.provider !== 'cloudflare') return res.status(400).json({ error: 'That credential is not a Cloudflare account' });
    try {
      res.json({ ok: true, ...(await handler(decrypt(row.secret_enc), req, row)) });
    } catch (err) {
      if (err.status === 401) await run("UPDATE credentials SET status='invalid', last_error=? WHERE id=?", [err.message, row.id]);
      res.status(400).json({ ok: false, error: err.message });
    }
  };
}

/** Re-read the account, its accounts and zones. */
credentialsRouter.post('/:id/cloudflare/account', cloudflareRoute(async (token, req, row) => ({
  account: await storeCloudflareAccount(row.id, await authenticateCloudflare(token)),
})));

/** One zone in full: details, main settings and DNS records. */
credentialsRouter.post('/:id/cloudflare/zones/:zoneId', cloudflareRoute(async (token, req) =>
  getZoneDetail(token, req.params.zoneId)));

/**
 * Remove a domain from Cloudflare. The zone name must be sent back as a
 * confirmation, so a stale page or a mis-click cannot delete the wrong one.
 */
credentialsRouter.delete('/:id/cloudflare/zones/:zoneId', cloudflareRoute(async (token, req, row) => {
  const account = asJson(row.extra).account || {};
  const zone = (account.zones || []).find((z) => z.id === req.params.zoneId);
  const confirmName = String(req.body?.confirm || '').trim().toLowerCase();
  if (!zone) throw new Error('That domain is not on this Cloudflare account (refresh the details and try again).');
  if (confirmName !== zone.name.toLowerCase()) throw new Error(`Type the domain name "${zone.name}" to confirm removing it.`);

  await deleteZone(token, zone.id);
  await logActivity('credential', row.id, 'cloudflare_zone_removed', `Removed domain ${zone.name} from Cloudflare account ${row.name}`, 'warn');

  // Re-read so the stored zone list no longer has it.
  const fresh = await authenticateCloudflare(token).catch(() => null);
  if (fresh) await storeCloudflareAccount(row.id, fresh);
  else await run('UPDATE credentials SET extra = ? WHERE id = ?',
    [JSON.stringify({ account: { ...account, zones: account.zones.filter((z) => z.id !== zone.id) } }), row.id]);

  return { removed: zone.name };
}));

/* ------------------------------------------------ Cloudflare DNS records */

/** The zone's name, from the stored details or — if it is newer — from Cloudflare. */
async function zoneNameOf(token, row, zoneId) {
  const stored = (asJson(row.extra).account?.zones || []).find((z) => z.id === zoneId);
  if (stored) return stored.name;
  return (await getZoneDetail(token, zoneId)).zone.name;
}

/** Add a DNS record. */
credentialsRouter.post('/:id/cloudflare/zones/:zoneId/dns/records', cloudflareRoute(async (token, req, row) => {
  const zoneName = await zoneNameOf(token, row, req.params.zoneId);
  const record = await createDnsRecord(token, req.params.zoneId, buildDnsRecord(req.body, zoneName));
  await logActivity('credential', row.id, 'cloudflare_dns_created',
    `Added ${record.type} ${record.name} → ${record.content} on ${zoneName}`);
  return { record };
}));

/** Change a DNS record. */
credentialsRouter.put('/:id/cloudflare/zones/:zoneId/dns/records/:recordId', cloudflareRoute(async (token, req, row) => {
  const { zoneId, recordId } = req.params;
  const zoneName = await zoneNameOf(token, row, zoneId);
  const before = await getDnsRecord(token, zoneId, recordId);
  if (!before.editable) throw new Error(`${before.type} records cannot be edited here — change it in the Cloudflare dashboard.`);
  const record = await updateDnsRecord(token, zoneId, recordId, buildDnsRecord(req.body, zoneName));
  await logActivity('credential', row.id, 'cloudflare_dns_updated',
    `Changed ${before.type} ${before.name} → ${before.content} to ${record.type} ${record.name} → ${record.content} on ${zoneName}`);
  return { record };
}));

/** Delete a DNS record. */
credentialsRouter.delete('/:id/cloudflare/zones/:zoneId/dns/records/:recordId', cloudflareRoute(async (token, req, row) => {
  const { zoneId, recordId } = req.params;
  const before = await getDnsRecord(token, zoneId, recordId);
  await deleteDnsRecord(token, zoneId, recordId);
  await logActivity('credential', row.id, 'cloudflare_dns_deleted',
    `Deleted ${before.type} ${before.name} → ${before.content}`, 'warn');
  return { deleted: before };
}));

/** DNS records of one zone this token can see. */
credentialsRouter.post('/:id/cloudflare/zones/:zoneId/dns', cloudflareRoute(async (token, req) => ({
  zoneId: req.params.zoneId,
  records: await listDnsRecords(token, req.params.zoneId),
})));

/* ------------------------------------------------- Cloudflare Zero Trust */

/**
 * The account a Zero Trust request is for, which must be one this credential
 * has seen, and the domains on it — public hostnames get their DNS there.
 */
function ztAccount(row, accountId) {
  const account = asJson(row.extra).account || {};
  const acc = (account.accounts || []).find((a) => a.id === accountId);
  if (!acc) throw new Error('That account is not on this Cloudflare login (refresh the details and try again).');
  return { acc, zones: (account.zones || []).filter((z) => z.accountId === accountId) };
}

const ZT = '/:id/cloudflare/accounts/:accountId';

/** Tunnels with their public hostnames, private networks and enrolled devices. */
credentialsRouter.post(`${ZT}/zero-trust`, cloudflareRoute(async (token, req, row) => {
  const { acc } = ztAccount(row, req.params.accountId);
  return { account: { id: acc.id, name: acc.name }, ...(await getZeroTrust(token, acc.id)) };
}));

/** Set up Zero Trust with a team domain, <team>.cloudflareaccess.com. */
credentialsRouter.post(`${ZT}/team`, cloudflareRoute(async (token, req, row) => {
  const { acc } = ztAccount(row, req.params.accountId);
  const team = await createTeamDomain(token, acc.id, req.body.teamName, req.body.name);
  await logActivity('credential', row.id, 'cloudflare_team_created', `Set up Zero Trust team domain ${team.authDomain} on ${acc.name}`);
  return { team };
}));

credentialsRouter.post(`${ZT}/tunnels`, cloudflareRoute(async (token, req, row) => {
  const { acc } = ztAccount(row, req.params.accountId);
  const tunnel = await createTunnel(token, acc.id, req.body.name);
  await logActivity('credential', row.id, 'cloudflare_tunnel_created', `Created tunnel ${tunnel.name} on ${acc.name}`);
  return { tunnel, token: await getTunnelToken(token, acc.id, tunnel.id) };
}));

/** The tunnel's run token, for the install command. It is a secret, so this needs "create". */
credentialsRouter.post(`${ZT}/tunnels/:tunnelId/token`, cloudflareRoute(async (token, req, row) => {
  const { acc } = ztAccount(row, req.params.accountId);
  return { token: await getTunnelToken(token, acc.id, req.params.tunnelId) };
}));

credentialsRouter.delete(`${ZT}/tunnels/:tunnelId`, cloudflareRoute(async (token, req, row) => {
  const { acc, zones } = ztAccount(row, req.params.accountId);
  await deleteTunnel(token, acc.id, req.params.tunnelId, zones);
  await logActivity('credential', row.id, 'cloudflare_tunnel_deleted',
    `Deleted tunnel ${String(req.body?.name || req.params.tunnelId)} on ${acc.name}`, 'warn');
  return { deleted: req.params.tunnelId };
}));

credentialsRouter.post(`${ZT}/tunnels/:tunnelId/hostnames`, cloudflareRoute(async (token, req, row) => {
  const { acc, zones } = ztAccount(row, req.params.accountId);
  const rule = buildHostnameRule(req.body);
  const hostnames = await addPublicHostname(token, acc.id, req.params.tunnelId, rule, zones);
  await logActivity('credential', row.id, 'cloudflare_hostname_added', `Added public hostname ${rule.hostname}${rule.path ? `/${rule.path}` : ''} → ${rule.service}`);
  return { hostnames };
}));

credentialsRouter.put(`${ZT}/tunnels/:tunnelId/hostnames`, cloudflareRoute(async (token, req, row) => {
  const { acc, zones } = ztAccount(row, req.params.accountId);
  const rule = buildHostnameRule(req.body);
  const original = req.body.original || {};
  const hostnames = await updatePublicHostname(token, acc.id, req.params.tunnelId, original, rule, zones);
  await logActivity('credential', row.id, 'cloudflare_hostname_updated',
    `Changed public hostname ${original.hostname} to ${rule.hostname}${rule.path ? `/${rule.path}` : ''} → ${rule.service}`);
  return { hostnames };
}));

credentialsRouter.delete(`${ZT}/tunnels/:tunnelId/hostnames`, cloudflareRoute(async (token, req, row) => {
  const { acc, zones } = ztAccount(row, req.params.accountId);
  const { hostname, path } = req.body || {};
  const hostnames = await deletePublicHostname(token, acc.id, req.params.tunnelId, hostname, path || '', zones);
  await logActivity('credential', row.id, 'cloudflare_hostname_deleted', `Removed public hostname ${hostname}`, 'warn');
  return { hostnames };
}));

credentialsRouter.post(`${ZT}/routes`, cloudflareRoute(async (token, req, row) => {
  const { acc } = ztAccount(row, req.params.accountId);
  const route = await createPrivateRoute(token, acc.id, req.body);
  await logActivity('credential', row.id, 'cloudflare_route_added', `Routed private network ${route.network} through a tunnel on ${acc.name}`);
  return { route };
}));

credentialsRouter.put(`${ZT}/routes/:routeId`, cloudflareRoute(async (token, req, row) => {
  const { acc } = ztAccount(row, req.params.accountId);
  const route = await updatePrivateRoute(token, acc.id, req.params.routeId, req.body);
  await logActivity('credential', row.id, 'cloudflare_route_updated', `Changed private network route to ${route.network} on ${acc.name}`);
  return { route };
}));

credentialsRouter.delete(`${ZT}/routes/:routeId`, cloudflareRoute(async (token, req, row) => {
  const { acc } = ztAccount(row, req.params.accountId);
  await deletePrivateRoute(token, acc.id, req.params.routeId);
  await logActivity('credential', row.id, 'cloudflare_route_deleted',
    `Removed private network route ${String(req.body?.network || req.params.routeId)} on ${acc.name}`, 'warn');
  return { deleted: req.params.routeId };
}));

/** Revoke a PC enrolled with WARP. */
credentialsRouter.delete(`${ZT}/devices/:deviceId`, cloudflareRoute(async (token, req, row) => {
  const { acc } = ztAccount(row, req.params.accountId);
  await revokeDevice(token, acc.id, req.params.deviceId);
  await logActivity('credential', row.id, 'cloudflare_device_revoked',
    `Revoked device ${String(req.body?.name || req.params.deviceId)} on ${acc.name}`, 'warn');
  return { revoked: req.params.deviceId };
}));

/* ----------------------------------------------------------- MySQL views */

/**
 * `manage` routes change the MySQL server. When one fails — a duplicate user, a
 * missing privilege — the connection itself is fine, so the credential is not
 * marked invalid; the failure goes into the activity log instead.
 */
function mysqlRoute(handler, { manage = false } = {}) {
  return async (req, res) => {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Credential not found' });
    if (row.provider !== 'mysql') return res.status(400).json({ error: 'That credential is not a MySQL connection' });
    try {
      res.json({ ok: true, ...(await handler(await mysqlConfigFrom(row), req, row)) });
    } catch (err) {
      if (manage) {
        await logActivity('credential', row.id, 'mysql_manage_failed', `${req.method} ${req.path}: ${err.message}`, 'error');
      } else {
        await run("UPDATE credentials SET status='invalid', last_error=? WHERE id=?", [err.message, row.id]);
      }
      res.status(400).json({ ok: false, error: err.message, detail: err.cause || null });
    }
  };
}

const manage = (handler) => mysqlRoute(handler, { manage: true });

credentialsRouter.post('/:id/mysql/overview', mysqlRoute(async (cfg, req, row) => {
  const facts = await inspectMysql(cfg);
  await run("UPDATE credentials SET status='valid', last_error=NULL, verified_at=NOW() WHERE id=?", [row.id]);
  await logActivity('credential', row.id, 'mysql_inspected',
    `Read ${facts.totals.databases} databases from "${row.name}" in ${facts.durationMs}ms`);
  return facts;
}));

credentialsRouter.post('/:id/mysql/databases/:database', mysqlRoute(async (cfg, req) => inspectDatabase(cfg, req.params.database)));

credentialsRouter.post('/:id/mysql/databases/:database/tables/:table', mysqlRoute(async (cfg, req) => inspectTable(cfg, req.params.database, req.params.table)));

credentialsRouter.post('/:id/mysql/query', mysqlRoute(async (cfg, req, row) => {
  const result = await runReadOnlyQuery(cfg, req.body.sql, Number(req.body.limit) || 200);
  await logActivity('credential', row.id, 'mysql_query', String(req.body.sql).slice(0, 200));
  return result;
}));

/* ------------------------------------------------ MySQL: databases */

credentialsRouter.post('/:id/mysql/charsets', mysqlRoute(async (cfg) => listCharsets(cfg)));

// Creating goes to /schemas so it never matches the read-only /databases/:db pattern.
credentialsRouter.post('/:id/mysql/schemas', manage(async (cfg, req, row) => {
  const r = await createDatabase(cfg, req.body || {});
  await logActivity('credential', row.id, 'mysql_database_created', `Created database "${r.name}" on "${row.name}"`);
  return r;
}));

credentialsRouter.put('/:id/mysql/databases/:database', manage(async (cfg, req, row) => {
  const r = await alterDatabase(cfg, { ...req.body, name: req.params.database });
  await logActivity('credential', row.id, 'mysql_database_altered',
    `Changed "${r.name}" on "${row.name}" to ${[req.body.charset, req.body.collation].filter(Boolean).join(' / ')}`);
  return r;
}));

credentialsRouter.delete('/:id/mysql/databases/:database', manage(async (cfg, req, row) => {
  const r = await dropDatabase(cfg, { name: req.params.database, confirm: req.body?.confirm });
  await logActivity('credential', row.id, 'mysql_database_dropped', `Dropped database "${r.name}" on "${row.name}"`, 'warn');
  return r;
}));

/* ---------------------------------------------------- MySQL: users */

const account = (b) => `'${b.user}'@'${b.host}'`;

credentialsRouter.post('/:id/mysql/users/list', mysqlRoute(async (cfg) => listUsers(cfg)));

credentialsRouter.post('/:id/mysql/users', manage(async (cfg, req, row) => {
  const r = await createUser(cfg, req.body || {});
  await logActivity('credential', row.id, 'mysql_user_created',
    `Created MySQL user ${account(r)} on "${row.name}"${r.database ? ` with access to ${r.database}` : ''}`);
  return r;
}));

credentialsRouter.put('/:id/mysql/users', manage(async (cfg, req, row) => {
  const r = await alterUser(cfg, req.body || {});
  await logActivity('credential', row.id, 'mysql_user_altered', `Changed MySQL user ${account(r)} on "${row.name}": ${r.changed.join(', ')}`);
  return r;
}));

credentialsRouter.delete('/:id/mysql/users', manage(async (cfg, req, row) => {
  const r = await dropUser(cfg, req.body || {});
  await logActivity('credential', row.id, 'mysql_user_dropped', `Dropped MySQL user ${account(r)} on "${row.name}"`, 'warn');
  return r;
}));

credentialsRouter.post('/:id/mysql/users/grants', manage(async (cfg, req, row) => {
  const r = await grantPrivileges(cfg, req.body || {});
  await logActivity('credential', row.id, 'mysql_grant',
    `Granted ${r.privileges.join(', ')} on ${r.database === '*' ? 'all databases' : r.database} to ${account(r)} on "${row.name}"`);
  return r;
}));

credentialsRouter.delete('/:id/mysql/users/grants', manage(async (cfg, req, row) => {
  const r = await revokePrivileges(cfg, req.body || {});
  await logActivity('credential', row.id, 'mysql_revoke',
    `Revoked ${account(r)}'s privileges on ${r.database === '*' ? 'all databases' : r.database} on "${row.name}"`, 'warn');
  return r;
}));

/* --------------------------------------------- MySQL: configuration */

credentialsRouter.post('/:id/mysql/variables', mysqlRoute(async (cfg) => listVariables(cfg)));

credentialsRouter.put('/:id/mysql/variables', manage(async (cfg, req, row) => {
  const r = await setVariable(cfg, req.body || {});
  await logActivity('credential', row.id, 'mysql_variable_set',
    `Set ${r.name} = ${r.value} on "${row.name}"${r.persisted ? ' (persisted)' : ''}`, 'warn');
  return r;
}));
