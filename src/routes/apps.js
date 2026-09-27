/**
 * Custom services: a Node.js repository, deployed as a container.
 *
 * Adding one is two steps. First the panel inspects the repository through the
 * git API — no package.json, no deployment — and suggests the Node version,
 * the commands and the port. Then it clones, builds an image and runs it on
 * the server you picked, pushing to Docker Hub first if you chose an account.
 */

import { Router } from 'express';
import { all, one, run, logActivity } from '../db/index.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { loadGitCredential } from '../lib/gitAccounts.js';
import { readRepoFile, listRepoRoot, listBranches, authenticatedCloneUrl, listRepositories, findProjectFolders } from '../lib/git.js';
import { connectionFromRow, withConnection } from '../lib/ssh.js';
import { requireDocker, DockerMissingError, containerLogs } from '../lib/docker.js';
import {
  inspectProject, validateAppSpec, NODE_VERSIONS, safeName, publicAppTypes, appType,
  validatePorts, MAX_CONTAINERS, MAX_VOLUMES, DEFAULT_VOLUME_PATH, cleanRootDir,
} from '../lib/nodeApp.js';
import { deployApp, removeApp, appAction, applyContainers, plannedContainers } from '../lib/deploy.js';
import { parseEnvInput, formatEnvText, RESERVED, MAX_VARS } from '../lib/envVars.js';
import { requirePermission } from '../lib/authGuard.js';
import {
  domainConfigFrom, publicDomainConfig, setupAppDomains, setupDomain, removeAppDomain, domainView,
} from '../lib/appDomain.js';

export const appsRouter = Router();

const getRow = (id, orgId) => one('SELECT * FROM apps WHERE id = ? AND org_id = ?', [id, orgId]);
const getServer = (id, orgId) => one('SELECT * FROM servers WHERE id = ? AND org_id = ?', [id, orgId]);

const asJson = (v) => {
  if (!v) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
  return v;
};

/**
 * What this app's containers should be, from the row.
 * `container_ports` is the list chosen on the form; rows written before that
 * existed fall back to a first port and a count.
 */
function containerSpecOf(row) {
  return {
    name: row.name,
    port: row.port,
    instances: row.instances,
    ports: asJson(row.container_ports) || null,
    volumes: storedVolumes(row),
  };
}

/** The named volumes this service mounts, or none for a row written before them. */
function storedVolumes(row) {
  const list = asJson(row.volumes);
  return Array.isArray(list) ? list : [];
}

/**
 * The environment saved against an app, or an empty list if it cannot be read.
 * PORT and INSTANCE are dropped: the deploy sets both, and an older row that
 * still carries one would otherwise fight with the port mapping.
 */
function storedEnv(row) {
  try {
    const pairs = row.env_enc ? JSON.parse(decrypt(row.env_enc)) : [];
    return pairs.filter(([k]) => !RESERVED.has(k));
  } catch {
    return [];
  }
}

/** An app row as the browser may see it — environment values never leave. */
async function publicApp(row) {
  if (!row) return null;
  const { env_enc, deploy_log, domain_log, domain_config, domain, domain_status, domain_error, ...rest } = row;
  const domains = (await all('SELECT id, domain, port, config, status, error, log IS NOT NULL AS has_log, created_at FROM app_domains WHERE app_id = ? ORDER BY id', [row.id]))
    .map((d) => ({ id: d.id, domain: d.domain, port: d.port || row.port, status: d.status, error: d.error, hasLog: Boolean(d.has_log), config: publicDomainConfig(d.config), createdAt: d.created_at }));
  const live = domains.find((d) => d.status === 'active');
  const server = await one('SELECT id, name, host FROM servers WHERE id = ?', [row.server_id]);
  const account = await one('SELECT id, name FROM credentials WHERE id = ?', [row.credential_id]);
  const registry = row.registry_cred_id
    ? await one('SELECT id, name, username FROM credentials WHERE id = ?', [row.registry_cred_id])
    : null;

  const envKeys = storedEnv(row).map(([k]) => k);

  return {
    ...rest,
    detected: asJson(row.detected),
    typeLabel: appType(row.app_type)?.label || row.app_type || 'Node.js',
    runtime: appType(row.app_type)?.runtime || 'server',
    containers: asJson(row.containers) || plannedContainers(containerSpecOf(row)),
    ports: plannedContainers(containerSpecOf(row)).map((c) => c.port),
    volumes: storedVolumes(row),
    envKeys,
    server: server || null,
    account: account || null,
    registry,
    url: live ? `https://${live.domain}` : server ? `http://${server.host}:${row.port}` : null,
    domains,
    // Kept for older screens: the first domain, and whether any is being set up.
    domain: domains[0]?.domain || null,
    domain_status: domains.some((d) => d.status === 'configuring') ? 'configuring' : domains[0]?.status || null,
    // The last "::step::key::label" in the log: what a running deploy is doing right now.
    currentStep: row.status === 'deploying' ? ([...String(deploy_log || '').matchAll(/^::step::[a-z]+::(.*?)(?:::\d+)?$/gm)].pop()?.[1] || null) : null,
    hasLog: Boolean(deploy_log),
  };
}

/* -------------------------------------------------------------- inspect */

/** The git account behind a request, checked to belong to this organisation. */
async function orgGitAccount(req, res) {
  let account;
  try {
    account = await loadGitCredential(Number(req.body.credential_id));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
    return null;
  }
  if (!await one('SELECT id FROM credentials WHERE id = ? AND org_id = ?', [account.row.id, req.orgId])) {
    res.status(400).json({ error: 'That git account is not in this organisation' });
    return null;
  }
  return account;
}

/**
 * The folders in a branch that hold a project of their own, for a repository
 * with several apps in it. The root is always offered, project or not.
 */
appsRouter.post('/folders', async (req, res, next) => {
  try {
    const repo = String(req.body.repo || '').trim();
    const branch = String(req.body.branch || '').trim();
    if (!repo || !branch) return res.status(400).json({ error: 'Pick the repository and branch first' });
    const account = await orgGitAccount(req, res);
    if (!account) return;
    try {
      const folders = await findProjectFolders(account.token, account.extra, repo, branch);
      if (!folders.some((f) => f.path === '')) folders.unshift({ path: '', missing: true });
      res.json({ ok: true, folders });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  } catch (err) { next(err); }
});

/** Is this repository (or this folder of it) something the panel can deploy, and with what settings? */
appsRouter.post('/inspect', async (req, res, next) => {
  try {
    const repo = String(req.body.repo || '').trim();
    const branch = String(req.body.branch || '').trim();
    if (!repo) return res.status(400).json({ error: 'Pick a repository' });
    const folder = cleanRootDir(req.body.root_dir);
    if (folder.error) return res.status(400).json({ error: folder.error });
    const dir = folder.value;
    const inDir = (file) => (dir ? `${dir}/${file}` : file);

    let account;
    try {
      account = await loadGitCredential(Number(req.body.credential_id));
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }
    if (!await one('SELECT id FROM credentials WHERE id = ? AND org_id = ?', [account.row.id, req.orgId])) {
      return res.status(400).json({ error: 'That git account is not in this organisation' });
    }

    try {
      // Without a branch, use the repository's default one.
      let ref = branch;
      if (!ref) {
        const repos = await listRepositories(account.token, account.extra);
        ref = repos.find((r) => r.fullName === repo)?.defaultBranch || 'main';
      }

      const [packageJson, files] = await Promise.all([
        readRepoFile(account.token, account.extra, repo, inDir('package.json'), ref),
        listRepoRoot(account.token, account.extra, repo, ref, dir).catch(() => []),
      ]);

      // Angular states its build output in angular.json, not package.json.
      const angularJson = files.includes('angular.json')
        ? await readRepoFile(account.token, account.extra, repo, inDir('angular.json'), ref).catch(() => null)
        : null;

      const result = inspectProject({ packageJson, files, angularJson });
      if (!result.ok && dir && !packageJson) result.reason = `There is no package.json in ${dir} on ${ref} — pick another folder.`;
      const branches = await listBranches(account.token, account.extra, repo).catch(() => []);

      // Several projects from one repository each need their own name: the
      // package's own ("@shop/api" → "api"), or "repo-folder".
      if (result.suggested && dir) {
        let pkgName = '';
        try { pkgName = String(JSON.parse(packageJson || '{}').name || '').replace(/^@[^/]+\//, ''); } catch { /* inspectProject reports it */ }
        result.suggested.name = pkgName || `${repo.split('/')[1]}-${dir.split('/').pop()}`;
      }

      res.json({
        ok: result.ok,
        repo,
        branch: ref,
        rootDir: dir,
        branches: branches.map((b) => b.name),
        nodeVersions: NODE_VERSIONS,
        maxContainers: MAX_CONTAINERS,
        maxVolumes: MAX_VOLUMES,
        defaultVolumePath: DEFAULT_VOLUME_PATH,
        types: publicAppTypes(),
        ...result,
        suggested: result.suggested ? { ...result.suggested, name: safeName(result.suggested.name || repo.split('/')[1]) } : null,
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  } catch (err) { next(err); }
});

/* ----------------------------------------------------------------- list */

/** A deploy whose process died leaves a row saying `deploying`; time it out. */
const STALE_MINUTES = 40;
const releaseStaleDeploys = () => Promise.all([
  run(
    `UPDATE apps SET status = 'error',
       last_error = 'The panel stopped before this deployment finished — deploy it again.'
     WHERE status = 'deploying' AND deploy_started_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
    [STALE_MINUTES]
  ),
  // Every step of a domain setup writes its log, so twenty quiet minutes means it died.
  run(`UPDATE app_domains SET status = 'error',
         error = 'The panel stopped before the domain was set up — retry it.'
       WHERE status = 'configuring' AND updated_at < DATE_SUB(NOW(), INTERVAL 20 MINUTE)`),
]).catch(() => {});

appsRouter.get('/', async (req, res, next) => {
  try {
    await releaseStaleDeploys();
    const rows = req.query.server_id
      ? await all('SELECT * FROM apps WHERE org_id = ? AND server_id = ? ORDER BY created_at DESC', [req.orgId, Number(req.query.server_id)])
      : await all('SELECT * FROM apps WHERE org_id = ? ORDER BY created_at DESC', [req.orgId]);
    res.json(await Promise.all(rows.map(publicApp)));
  } catch (err) { next(err); }
});

appsRouter.get('/:id', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'App not found' });
    const domainLogs = await all('SELECT id, domain, log FROM app_domains WHERE app_id = ? ORDER BY id', [row.id]);
    const activity = await all(`SELECT a.created_at, a.action, a.level, a.message, u.name AS user_name FROM activity_log a
      LEFT JOIN users u ON u.id = a.user_id WHERE a.entity = 'app' AND a.entity_id = ? ORDER BY a.id DESC LIMIT 40`, [row.id]);
    res.json({
      ...(await publicApp(row)),
      deployLog: row.deploy_log || null,
      domainLogs: domainLogs.map((d) => ({ id: d.id, domain: d.domain, log: d.log || null })),
      // One log for the progress window: every domain's, one after another.
      domainLog: domainLogs.filter((d) => d.log).map((d) => (domainLogs.length > 1 ? `── ${d.domain} ──\n${d.log}` : d.log)).join('\n\n') || null,
      activity,
      // What the Edit window needs to draw its pickers.
      editOptions: { types: publicAppTypes(), nodeVersions: NODE_VERSIONS },
      settings: {
        install: row.install_cmd, build: row.build_cmd, start: row.start_cmd, output_dir: row.output_dir,
        container_port: row.container_port, restart: row.restart, network: row.network,
        use_repo_dockerfile: Boolean(row.use_repo_dockerfile), registry_cred_id: row.registry_cred_id, credential_id: row.credential_id,
        root_dir: row.root_dir || '',
      },
    });
  } catch (err) { next(err); }
});

/* --------------------------------------------------------------- create */

appsRouter.post('/', async (req, res, next) => {
  try {
    const { spec, error } = validateAppSpec(req.body);
    if (error) return res.status(400).json({ error });

    const server = await getServer(Number(req.body.server_id), req.orgId);
    if (!server) return res.status(400).json({ error: 'Pick the server to deploy onto' });

    const credential = await one('SELECT id FROM credentials WHERE id = ? AND org_id = ? AND provider = "git"',
      [Number(req.body.credential_id), req.orgId]);
    if (!credential) return res.status(400).json({ error: 'Pick the git account that can reach this repository' });

    if (await one('SELECT id FROM apps WHERE server_id = ? AND name = ?', [server.id, spec.name])) {
      return res.status(409).json({ error: `${server.name} already has an app called "${spec.name}"` });
    }

    // A Docker Hub account is optional: with one the image is pushed, without
    // one it simply stays on the server it was built on.
    let registryCred = null;
    if (spec.push) {
      registryCred = await one('SELECT * FROM credentials WHERE id = ? AND org_id = ?',
        [Number(req.body.registry_cred_id), req.orgId]);
      if (!registryCred) return res.status(400).json({ error: 'Pick the Docker Hub account to push to, or turn pushing off' });
      if (registryCred.provider !== 'dockerhub') return res.status(400).json({ error: 'That credential is not a Docker Hub account' });
      if (!registryCred.username) return res.status(400).json({ error: 'That Docker Hub credential has no username' });
    }

    // Docker image names are lowercase only, but a Docker Hub username may be
    // typed with capitals — left as-is, the build fails before the push ever
    // happens with nothing but "invalid reference format" to go on.
    const namespace = registryCred ? registryCred.username.trim().toLowerCase() : null;
    if (namespace && !/^[a-z0-9][a-z0-9._-]{1,254}$/.test(namespace)) {
      return res.status(400).json({ error: `"${registryCred.username}" cannot be used as a Docker Hub namespace` });
    }
    const image = namespace ? `${namespace}/${spec.name}` : `auto-deploy/${spec.name}`;

    // "Add a domain" is optional; when ticked it is checked now, and set up once the container runs.
    let domain = null;
    if (req.body.domain_enabled === true || req.body.domain_enabled === 'true' || req.body.domain_enabled === 'on') {
      const d = await domainConfigFrom(req.body, req.orgId, { userEmail: req.user?.email });
      if (d.error) return res.status(400).json({ error: d.error });
      domain = d.value;
    }

    const { insertId } = await run(
      `INSERT INTO apps (org_id, server_id, credential_id, registry_cred_id, name, repo, branch, node_version,
         install_cmd, build_cmd, start_cmd, port, container_port, instances, container_ports, volumes, app_type, output_dir,
         image, tag, pushed, network, restart, use_repo_dockerfile, env_enc, detected, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'deploying')`,
      [req.orgId, server.id, credential.id, registryCred?.id || null, spec.name, spec.repo, spec.branch, spec.nodeVersion,
        spec.install, spec.build || null, spec.start || null, spec.port, spec.containerPort, spec.instances,
        JSON.stringify(spec.ports), JSON.stringify(spec.volumes), spec.type, spec.outputDir || null, image, spec.tag,
        spec.push ? 1 : 0, spec.network || null, spec.restart, spec.useRepoDockerfile ? 1 : 0,
        encrypt(JSON.stringify(spec.env)), JSON.stringify(req.body.detected || null)]
    );

    if (spec.rootDir) await run('UPDATE apps SET root_dir = ? WHERE id = ?', [spec.rootDir, insertId]);

    if (domain) {
      await run("INSERT INTO app_domains (org_id, app_id, domain, port, config, status) VALUES (?,?,?,?,?, 'pending')",
        [req.orgId, insertId, domain.domain, domain.port, JSON.stringify(domain.config)]);
    }

    // The build takes minutes, so the row comes back immediately as
    // `deploying` and the work carries on behind the response.
    await run('UPDATE apps SET deploy_started_at = NOW() WHERE id = ?', [insertId]);
    res.status(202).json({ ok: true, started: true, ...(await publicApp(await one('SELECT * FROM apps WHERE id = ?', [insertId]))) });
    startDeployment(insertId, { first: true });
  } catch (err) { next(err); }
});

/* ----------------------------------------------------------------- edit */

/**
 * Change how an app is built and run. The name, server and repository stay —
 * changing those means a different app. Everything else goes through the same
 * checks as creating one, and takes effect on the next deploy (straight away
 * when `redeploy` is set).
 */
const EDITABLE = ['branch', 'root_dir', 'type', 'node_version', 'install', 'build', 'start', 'output_dir', 'container_port',
  'restart', 'network', 'use_repo_dockerfile', 'push', 'registry_cred_id', 'tag'];

appsRouter.put('/:id/settings', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'App not found' });
    if (row.status === 'deploying') return res.status(409).json({ error: `${row.name} is being deployed — wait for that to finish.` });

    // What the app is now, in the create form's shape, with the edited fields on top.
    const current = {
      name: row.name, repo: row.repo, branch: row.branch, root_dir: row.root_dir || '', type: row.app_type, node_version: row.node_version,
      install: row.install_cmd, build: row.build_cmd, start: row.start_cmd, output_dir: row.output_dir,
      container_port: row.container_port, restart: row.restart, network: row.network,
      use_repo_dockerfile: Boolean(row.use_repo_dockerfile), push: Boolean(row.pushed), registry_cred_id: row.registry_cred_id, tag: row.tag,
      ports: plannedContainers(containerSpecOf(row)).map((c) => c.port), volumes: storedVolumes(row), env: storedEnv(row),
    };
    const edits = Object.fromEntries(EDITABLE.filter((k) => req.body[k] !== undefined).map((k) => [k, req.body[k]]));
    const { spec, error } = validateAppSpec({ ...current, ...edits });
    if (error) return res.status(400).json({ error });

    // Pushing needs an account, and the account decides the image's namespace.
    let registryCred = null;
    if (spec.push) {
      registryCred = await one("SELECT * FROM credentials WHERE id = ? AND org_id = ? AND provider = 'dockerhub'",
        [Number(edits.registry_cred_id ?? row.registry_cred_id), req.orgId]);
      if (!registryCred?.username) return res.status(400).json({ error: 'Pick the Docker Hub account to push to, or turn pushing off' });
    }
    const namespace = registryCred ? registryCred.username.trim().toLowerCase() : null;
    if (namespace && !/^[a-z0-9][a-z0-9._-]{1,254}$/.test(namespace)) {
      return res.status(400).json({ error: `"${registryCred.username}" cannot be used as a Docker Hub namespace` });
    }
    const image = namespace ? `${namespace}/${row.name}` : `auto-deploy/${row.name}`;

    const before = { branch: row.branch, node: row.node_version, type: row.app_type, port: row.container_port, dir: row.root_dir || '' };
    await run(
      `UPDATE apps SET branch = ?, app_type = ?, node_version = ?, install_cmd = ?, build_cmd = ?, start_cmd = ?, output_dir = ?,
         container_port = ?, restart = ?, network = ?, use_repo_dockerfile = ?, pushed = ?, registry_cred_id = ?, tag = ?, image = ?,
         root_dir = ?
       WHERE id = ?`,
      [spec.branch, spec.type, spec.nodeVersion, spec.install, spec.build || null, spec.start || null, spec.outputDir || null,
        spec.containerPort, spec.restart, spec.network || null, spec.useRepoDockerfile ? 1 : 0, spec.push ? 1 : 0,
        registryCred?.id || null, spec.tag, image, spec.rootDir || null, row.id]
    );

    const changed = [
      before.branch !== spec.branch && `branch ${before.branch} → ${spec.branch}`,
      before.dir !== spec.rootDir && `folder ${before.dir || '(root)'} → ${spec.rootDir || '(root)'}`,
      before.type !== spec.type && `type ${before.type} → ${spec.type}`,
      before.node !== spec.nodeVersion && `Node ${before.node} → ${spec.nodeVersion}`,
      Number(before.port) !== spec.containerPort && `container port ${before.port} → ${spec.containerPort}`,
    ].filter(Boolean);
    await logActivity('app', row.id, 'settings_changed', `Changed the settings of ${row.name}${changed.length ? `: ${changed.join(', ')}` : ''}`);

    const redeploy = req.body.redeploy === true || req.body.redeploy === 'true';
    if (redeploy) {
      await run("UPDATE apps SET status = 'deploying', deploy_started_at = NOW(), last_error = NULL WHERE id = ?", [row.id]);
      startDeployment(row.id, { first: false });
    }
    res.json({ ok: true, redeploying: redeploy, ...(await publicApp(await getRow(row.id, req.orgId))) });
  } catch (err) { next(err); }
});

/* --------------------------------------------------------------- deploy */

/** Build and run the current branch again — the same path as the first deploy. */
appsRouter.post('/:id/deploy', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'App not found' });
    if (row.status === 'deploying') {
      return res.status(409).json({ error: `${row.name} is already being deployed — wait for that to finish.` });
    }

    await run("UPDATE apps SET status = 'deploying', deploy_started_at = NOW(), last_error = NULL WHERE id = ?", [row.id]);
    res.status(202).json({ ok: true, started: true, ...(await publicApp(await one('SELECT * FROM apps WHERE id = ?', [row.id]))) });
    startDeployment(row.id, { first: false });
  } catch (err) { next(err); }
});

/**
 * Everything both deploys share: gather the pieces, run the script, record
 * what came back. The row already exists and is marked `deploying`.
 *
 * Nobody is waiting on this — the response went out when it started — so it
 * reports only by updating the row, which the browser polls.
 */
function startDeployment(id, options) {
  runDeployment(id, options).catch(async (err) => {
    console.error('[apps] deployment crashed:', err);
    await run("UPDATE apps SET status = 'error', last_error = ? WHERE id = ?",
      [`The deployment stopped unexpectedly: ${err.message}`, id]).catch(() => {});
  });
}

async function runDeployment(id, { first }) {
  const row = await one('SELECT * FROM apps WHERE id = ?', [id]);
  const server = await one('SELECT * FROM servers WHERE id = ?', [row.server_id]);

  // The progress view reads deploy_log while this runs, so output is saved as
  // it arrives — every 1.5s at most, never more than the last 120k characters.
  let live = '';
  let flushTimer = null;
  const flush = async () => {
    clearTimeout(flushTimer);
    flushTimer = null;
    await run('UPDATE apps SET deploy_log = ? WHERE id = ?', [live.slice(-120000), id]).catch(() => {});
  };
  const progress = (text) => {
    live += text;
    if (!flushTimer) flushTimer = setTimeout(flush, 1500);
  };
  const now = () => Math.floor(Date.now() / 1000);
  const note = (key, label, detail = '') => progress(`::step::${key}::${label}::${now()}\n${detail ? `${detail}\n` : ''}`);
  await run('UPDATE apps SET deploy_log = NULL WHERE id = ?', [id]);

  const fail = async (message, detail = null) => {
    await flush();
    // What streamed in, then whatever the failure adds that was not already shown.
    const extra = detail && !live.includes(String(detail).slice(0, 200)) ? `\n${detail}` : '';
    const text = `${live}${extra}\n::failed::${message}::${now()}\n`;
    await run("UPDATE apps SET status = 'error', last_error = ?, deploy_log = ? WHERE id = ?",
      [message, text.slice(-120000), id]);
    await logActivity('app', id, 'deploy_failed', `${row.name}: ${message}`, 'error');
  };

  note('account', 'Preparing the git account', `Repository ${row.repo}, branch ${row.branch}`);
  let account;
  try {
    account = await loadGitCredential(row.credential_id);
  } catch (err) {
    return fail(`The git account is unusable: ${err.message}`);
  }

  // The clone URL carries the token; it is never stored or logged.
  let cloneUrl;
  try {
    const repos = await listRepositories(account.token, account.extra);
    const match = repos.find((r) => r.fullName === row.repo);
    const base = match?.cloneUrl || `${account.settings.webUrl}/${row.repo}.git`;
    cloneUrl = authenticatedCloneUrl(account.token, account.extra, base, account.extra.account?.login);
  } catch (err) {
    return fail(`Could not work out the clone URL: ${err.message}`);
  }

  let registry = {};
  if (row.registry_cred_id) {
    const cred = await one('SELECT * FROM credentials WHERE id = ?', [row.registry_cred_id]);
    if (!cred) return fail('The Docker Hub account this app pushes to no longer exists');
    registry = { registryUsername: cred.username, registryPassword: decrypt(cred.secret_enc), registryHost: null };
  }

  const env = storedEnv(row);

  // An image built before namespaces were lowercased cannot be rebuilt as it
  // stands; fix the row so this deploy and every later one work.
  const image = normalizeImage(row.image);
  if (image !== row.image) await run('UPDATE apps SET image = ? WHERE id = ?', [image, id]);

  const spec = {
    name: row.name,
    repo: row.repo,
    branch: row.branch,
    cloneUrl,
    type: row.app_type,
    runtime: ['angular', 'react', 'static'].includes(row.app_type) ? 'static' : 'server',
    outputDir: row.output_dir,
    instances: row.instances || 1,
    nodeVersion: row.node_version,
    install: row.install_cmd,
    build: row.build_cmd,
    start: row.start_cmd,
    port: row.port,
    ports: containerSpecOf(row).ports,
    volumes: storedVolumes(row),
    containerPort: row.container_port,
    image,
    tag: row.tag,
    env,
    network: row.network,
    restart: row.restart,
    useRepoDockerfile: Boolean(row.use_repo_dockerfile),
    push: Boolean(row.pushed),
    rootDir: row.root_dir || '',
    ...registry,
    onProgress: progress,
  };

  try {
    note('connect', `Connecting to ${server.name}`, `SSH ${server.username}@${server.host}:${server.port}`);
    const result = await withConnection(connectionFromRow(server), async (conn) => {
      progress(`Connected to ${server.name}.\n`);
      await requireDocker(conn, server);
      return deployApp(conn, server, spec);
    });

    progress(`\n${(result.containers || []).map((c) => `${c.name} on port ${c.port}: ${c.status}`).join('\n')}\n`);
    if (result.logs?.length) progress(`\nFirst lines from the app:\n${result.logs.join('\n')}\n`);
    progress(`::done::Deployed::${now()}\n`);
    clearTimeout(flushTimer);

    await run(
      `UPDATE apps SET status = 'running', container_id = ?, image_bytes = ?, deploy_log = ?,
         containers = ?, last_error = NULL, last_deployed_at = NOW() WHERE id = ?`,
      [result.containerId, result.imageBytes, live.slice(-120000), JSON.stringify(result.containers || []), id]
    );
    await logActivity('app', id, first ? 'created' : 'deployed',
      `${first ? 'Deployed' : 'Redeployed'} ${row.name} from ${row.repo}@${row.branch} on ${server.name} (port ${row.port})`);

  } catch (err) {
    // An SSH failure says nothing about which machine; say it here.
    const where = /timed out|refused|unreachable|not found|Authentication failed/i.test(err.message) && !live.includes('Connected to')
      ? `${server.name} (${server.host}:${server.port}): ${err.message}` : err.message;
    await fail(where, err.cause || null);
    return;
  }

  // The container answers now, so its domains can be pointed at it. Domains
  // already live are left alone on a redeploy — same port, same site.
  await setupAppDomains(id);
}

/* -------------------------------------------------------------- domains */

const getDomain = (appId, domainId) => one('SELECT * FROM app_domains WHERE id = ? AND app_id = ?', [domainId, appId]);

/** Set a domain up in the background — or leave it for the running deploy, which sets it up when it finishes. */
async function startDomain(app, domainId) {
  if (app.status === 'deploying') return false;
  await run("UPDATE app_domains SET status = 'configuring' WHERE id = ?", [domainId]);
  setupDomain(domainId).catch((err) => console.error('[apps] domain setup crashed:', err));
  return true;
}

/** Add another domain to an app. Each one is set up, retried and removed on its own. */
appsRouter.post('/:id/domains', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'App not found' });

    const d = await domainConfigFrom(req.body, req.orgId, { userEmail: req.user?.email });
    if (d.error) return res.status(400).json({ error: d.error });

    // A domain can go to any of the app's containers; by default its first.
    const ports = plannedContainers(containerSpecOf(row)).map((c) => c.port);
    if (d.value.port && !ports.includes(d.value.port)) {
      return res.status(400).json({ error: `${row.name} publishes ${ports.join(', ')} — pick one of those for the domain` });
    }

    // A second Zero Trust domain rides the tunnel the panel already made for this app.
    let config = d.value.config;
    if (config.mode === 'zerotrust' && config.tunnelId === 'new') {
      const made = (await all('SELECT config FROM app_domains WHERE app_id = ?', [row.id])).map((x) => asJson(x.config) || {})
        .find((c) => c.mode === 'zerotrust' && c.tunnelOnServer && c.tunnelId && c.tunnelId !== 'new');
      if (made) config = { ...config, tunnelId: made.tunnelId, tunnelName: made.tunnelName, tunnelOnServer: true };
    }

    const { insertId } = await run("INSERT INTO app_domains (org_id, app_id, domain, port, config, status) VALUES (?,?,?,?,?, 'pending')",
      [req.orgId, row.id, d.value.domain, d.value.port, JSON.stringify(config)]);
    const started = await startDomain(row, insertId);
    await logActivity('app', row.id, 'domain_added', `Added ${d.value.domain} to ${row.name}${started ? '' : ' (set up after the running deploy)'}`);
    res.status(202).json({ ok: true, domainId: insertId, domain: d.value.domain, ...(await publicApp(await getRow(row.id, req.orgId))) });
  } catch (err) { next(err); }
});

/** Run one domain's setup again. */
appsRouter.post('/:id/domains/:domainId/retry', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'App not found' });
    const dom = await getDomain(row.id, req.params.domainId);
    if (!dom) return res.status(404).json({ error: 'Domain not found' });
    if (dom.status === 'configuring') return res.status(409).json({ error: `${dom.domain} is being set up right now — wait for that to finish.` });
    await run("UPDATE app_domains SET status = 'pending', error = NULL WHERE id = ?", [dom.id]);
    await startDomain(row, dom.id);
    await logActivity('app', row.id, 'domain_requested', `Setting up ${dom.domain} for ${row.name} again`);
    res.status(202).json({ ok: true, ...(await publicApp(await getRow(row.id, req.orgId))) });
  } catch (err) { next(err); }
});

/** Take one domain off an app: its DNS record or tunnel hostname, nginx site and certificate. */
appsRouter.delete('/:id/domains/:domainId', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'App not found' });
    const dom = await getDomain(row.id, req.params.domainId);
    if (!dom) return res.status(404).json({ error: 'Domain not found' });
    if (dom.status === 'configuring') return res.status(409).json({ error: `${dom.domain} is being set up right now — wait for that to finish.` });

    const server = await getServer(row.server_id, req.orgId);
    const r = await removeAppDomain(domainView(row, dom), server);
    await run('DELETE FROM app_domains WHERE id = ?', [dom.id]);
    await logActivity('app', row.id, 'domain_removed',
      `Removed ${dom.domain} from ${row.name}${r.done.length ? `: ${r.done.join(', ')}` : ''}`, 'warn');
    res.json({ ok: true, done: r.done, warnings: r.warnings, ...(await publicApp(await getRow(row.id, req.orgId))) });
  } catch (err) { next(err); }
});

/** A repository name must be lowercase; the tag after it may not be. */
function normalizeImage(image) {
  const text = String(image || '');
  const cut = text.lastIndexOf(':');
  const repo = cut > 0 ? text.slice(0, cut) : text;
  const tag = cut > 0 ? text.slice(cut) : '';
  return `${repo.toLowerCase()}${tag}`;
}

/* --------------------------------------------------------- environment */

/**
 * Everything both live changes share: rebuild the containers from the image
 * that is already on the server, then write back what came of it.
 *
 * `changes` is what the request wants to become true — new ports, a new
 * environment — and it is only saved once the containers are actually running
 * that way. A change the server refuses leaves the row describing what is
 * really there rather than what was asked for.
 */
async function recreate(row, req, res, { changes = {}, persist, activity }) {
  const server = await getServer(row.server_id, req.orgId);
  if (!server) return res.status(400).json({ error: 'The server this runs on no longer exists' });
  if (row.status === 'deploying') {
    return res.status(409).json({ error: `${row.name} is being deployed — wait for that to finish.` });
  }

  try {
    const result = await withConnection(connectionFromRow(server), async (conn) => {
      await requireDocker(conn, server);
      return applyContainers(conn, server, {
        name: row.name,
        image: normalizeImage(row.image),
        tag: row.tag,
        containerPort: row.container_port,
        network: row.network,
        restart: row.restart,
        env: storedEnv(row),
        stopped: ['exited', 'stopped', 'paused', 'created'].includes(row.status),
        ...containerSpecOf(row),
        ...changes,
      });
    });

    if (persist) await persist();
    await run('UPDATE apps SET status = ?, container_id = ?, containers = ?, last_error = NULL WHERE id = ?',
      [result.state || 'running', result.containerId, JSON.stringify(result.containers || []), row.id]);
    await logActivity('app', row.id, activity.action, activity.message(server, result));

    res.json({ ok: true, ...(await publicApp(await getRow(row.id, req.orgId))), applied: true, containers: result.containers });
  } catch (err) {
    await run('UPDATE apps SET last_error = ? WHERE id = ?', [err.message, row.id]);
    res.status(400).json({ ok: false, error: err.message, dockerMissing: err instanceof DockerMissingError, detail: err.cause || null });
  }
}

/**
 * The variables as they are, so they can be edited rather than retyped.
 *
 * These are the only place the panel hands back a stored secret in the clear,
 * so it asks for the same permission changing them does — a viewer sees the
 * key names on the card and nothing more.
 */
appsRouter.get('/:id/env', requirePermission('edit'), async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'App not found' });
    const env = storedEnv(row);
    res.json({ ok: true, name: row.name, env, text: formatEnvText(env), max: MAX_VARS });
  } catch (err) { next(err); }
});

/**
 * Replace the environment of a service that is already running.
 *
 * Docker fixes a container's environment when it is created, so nothing short
 * of recreating the container can change it. `apply` does exactly that from the
 * image already on the server — seconds, not a rebuild. Without it the new
 * values are stored and take effect at the next deploy.
 */
appsRouter.put('/:id/env', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'App not found' });

    const parsed = parseEnvInput(req.body.env);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const before = storedEnv(row).map(([k]) => k);
    const after = parsed.pairs.map(([k]) => k);
    const added = after.filter((k) => !before.includes(k));
    const removed = before.filter((k) => !after.includes(k));
    // PORT / INSTANCE in the pasted file are the panel's to set, so they are left out rather than refused.
    const skippedNote = parsed.skipped?.length ? ` (${parsed.skipped.join(', ')} left out — set by the panel)` : '';
    const summary = ([added.length ? `added ${added.join(', ')}` : '', removed.length ? `removed ${removed.join(', ')}` : '']
      .filter(Boolean).join('; ') || 'no keys added or removed') + skippedNote;

    const save = () => run('UPDATE apps SET env_enc = ? WHERE id = ?', [encrypt(JSON.stringify(parsed.pairs)), row.id]);

    // Saved without applying, the values simply wait for the next deploy.
    if (req.body.apply === false) {
      await save();
      await logActivity('app', row.id, 'app_env', `${row.name}: ${summary} — applies at the next deploy`);
      return res.json({ ok: true, ...(await publicApp(await getRow(row.id, req.orgId))), applied: false, summary });
    }

    return recreate(row, req, res, {
      changes: { env: parsed.pairs },
      persist: save,
      activity: {
        action: 'app_env',
        message: (server) => `${row.name} on ${server.name}: ${summary} — containers recreated`,
      },
    });
  } catch (err) { next(err); }
});

/* ---------------------------------------------------------- containers */

/**
 * Add or remove containers, and give each one the port it publishes on.
 * The containers are recreated from the image on the server, so this is a
 * change of shape rather than a redeployment.
 */
appsRouter.put('/:id/containers', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'App not found' });

    const ports = validatePorts({ ports: req.body.ports, port: req.body.port, instances: req.body.instances });
    if (ports.error) return res.status(400).json({ error: ports.error });

    const network = req.body.network !== undefined ? String(req.body.network || '').trim() : row.network;
    const was = plannedContainers(containerSpecOf(row)).map((c) => c.port);

    return recreate(row, req, res, {
      changes: { ports: ports.value, network: network || null },
      persist: () => run('UPDATE apps SET port = ?, instances = ?, container_ports = ?, network = ? WHERE id = ?',
        [ports.value[0], ports.value.length, JSON.stringify(ports.value), network || null, row.id]),
      activity: {
        action: 'app_containers',
        message: (server) => `${row.name} on ${server.name}: ${was.length} → ${ports.value.length} container(s) `
          + `on port${ports.value.length > 1 ? 's' : ''} ${ports.value.join(', ')}`,
      },
    });
  } catch (err) { next(err); }
});

/* -------------------------------------------------------------- control */

appsRouter.post('/:id/action', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'App not found' });
    const action = String(req.body.action || '');
    if (!['start', 'stop', 'restart'].includes(action)) {
      return res.status(400).json({ error: 'action must be start, stop or restart' });
    }
    const server = await getServer(row.server_id, req.orgId);
    if (!server) return res.status(400).json({ error: 'The server this runs on no longer exists' });

    try {
      const result = await withConnection(connectionFromRow(server), async (conn) => {
        await requireDocker(conn, server);
        return appAction(conn, server, containerSpecOf(row), action);
      });
      await run('UPDATE apps SET status = ?, containers = ? WHERE id = ?',
        [result.state || 'unknown', JSON.stringify(result.containers || []), row.id]);
      await logActivity('app', row.id, `app_${action}`, `${action} ${row.name} on ${server.name} → ${result.state}`);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message, dockerMissing: err instanceof DockerMissingError });
    }
  } catch (err) { next(err); }
});

appsRouter.get('/:id/logs', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'App not found' });
    const server = await getServer(row.server_id, req.orgId);
    if (!server) return res.status(400).json({ error: 'The server this runs on no longer exists' });
    try {
      const logs = await withConnection(connectionFromRow(server), async (conn) => {
        await requireDocker(conn, server);
        const list = plannedContainers(containerSpecOf(row));
        const wanted = list.find((c) => c.name === req.query.container) || list[0];
        return containerLogs(conn, server, wanted.name, Number(req.query.tail) || 200);
      });
      res.json({
        ok: true,
        name: row.name,
        containers: plannedContainers(containerSpecOf(row)),
        logs,
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  } catch (err) { next(err); }
});

/* -------------------------------------------------------------- delete */

appsRouter.delete('/:id', async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'App not found' });
    const server = await getServer(row.server_id, req.orgId);

    const warnings = [];

    // Its domains go with it: each one's tunnel hostname (and a tunnel made for
    // it), or its DNS record, nginx site and certificate.
    const domainDone = [];
    const doms = await all('SELECT * FROM app_domains WHERE app_id = ? ORDER BY id', [row.id]);
    for (const dom of doms) {
      const d = await removeAppDomain(domainView(row, dom), server);
      domainDone.push(...d.done);
      warnings.push(...d.warnings);
    }

    if (server) {
      try {
        await withConnection(connectionFromRow(server), (conn) => removeApp(conn, server, {
          ...containerSpecOf(row), image: row.image, tag: row.tag,
        }, {
          keepImage: req.query.keep_image === '1',
          // Volumes outlive the service unless the person said otherwise.
          keepVolumes: req.query.delete_volumes !== '1',
        }));
      } catch (err) {
        warnings.push(`Could not clean up ${server.name}: ${err.message}`);
      }
    }

    await run('DELETE FROM apps WHERE id = ?', [row.id]);
    await logActivity('app', null, 'app_removed',
      `Removed the app "${row.name}"${doms.length ? ` and its domain${doms.length > 1 ? 's' : ''} ${doms.map((d) => d.domain).join(', ')}` : ''}${domainDone.length ? `: ${domainDone.join(', ')}` : ''}`);
    res.json({ ok: true, warnings, domainRemoved: domainDone });
  } catch (err) { next(err); }
});
