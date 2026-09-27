/**
 * Git account connections.
 *
 * A git credential is a personal access token plus the host it belongs to.
 * Authenticating fetches the account behind the token so the panel can show
 * who is connected, what the token may do, and which repositories the
 * deployment phase can clone.
 */

const DEFAULTS = {
  github: { apiUrl: 'https://api.github.com', webUrl: 'https://github.com', label: 'GitHub' },
  gitlab: { apiUrl: 'https://gitlab.com/api/v4', webUrl: 'https://gitlab.com', label: 'GitLab' },
  bitbucket: { apiUrl: 'https://api.bitbucket.org/2.0', webUrl: 'https://bitbucket.org', label: 'Bitbucket' },
};

export const GIT_KINDS = Object.keys(DEFAULTS);
export const gitKind = (kind) => (GIT_KINDS.includes(kind) ? kind : 'github');

export function gitDefaults(kind) {
  return DEFAULTS[kind] || DEFAULTS.github;
}

/** Normalise the `extra` blob stored on a git credential. */
export function gitSettings(extra = {}) {
  const kind = gitKind(extra.kind);
  const d = DEFAULTS[kind];
  return {
    kind,
    label: d.label,
    apiUrl: (extra.apiUrl || d.apiUrl).replace(/\/+$/, ''),
    webUrl: (extra.webUrl || d.webUrl).replace(/\/+$/, ''),
    // Bitbucket API tokens and app passwords sign in as "email or username : token";
    // OAuth and workspace/repository access tokens have none and go as a bearer token.
    ...(kind === 'bitbucket' && extra.authUser ? { authUser: String(extra.authUser).trim() } : {}),
  };
}

function authHeaders(token, s) {
  if (s.kind === 'gitlab') return { 'PRIVATE-TOKEN': token, Accept: 'application/json' };
  if (s.kind === 'bitbucket') {
    return {
      Authorization: s.authUser ? `Basic ${Buffer.from(`${s.authUser}:${token}`).toString('base64')}` : `Bearer ${token}`,
      Accept: 'application/json',
    };
  }
  return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
}

async function request(url, token, s, { method = 'GET', body = null, raw = false, allow404 = false } = {}) {
  const headers = authHeaders(token, s);

  if (body) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { ...headers, 'User-Agent': 'aj-pilot' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    throw new Error(`Could not reach ${url.split('/')[2]}: ${err.message}`);
  }

  // A missing file is an answer, not a failure, when the caller says so.
  if (res.status === 404 && allow404) return { body: null, headers: res.headers, missing: true };
  if (!res.ok) throw await describeFailure(res, s.kind);

  return {
    body: raw ? await res.text().catch(() => null) : await res.json().catch(() => null),
    headers: res.headers,
  };
}

async function describeFailure(res, kind) {
  const label = gitDefaults(kind).label;
  const body = await res.json().catch(() => ({}));
  // Bitbucket wraps its message as { error: { message } }.
  const detail = body.message || body.error?.message || (typeof body.error === 'string' ? body.error : null) || body.error_description;

  if (res.status === 401) return new Error(`${label} rejected the token — it is wrong, revoked or expired.`);
  if (res.status === 403) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset') || 0) * 1000;
      return new Error(`${label} rate limit reached. It resets at ${new Date(reset).toLocaleTimeString()}.`);
    }
    return new Error(`${label} refused the request — the token is missing a required scope.${detail ? ` (${detail})` : ''}`);
  }
  if (res.status === 404) return new Error(`${label} returned "not found" — check the host URL, and that the token can see this resource.`);

  return new Error(`${label} returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
}

/* ------------------------------------------------------------- account */

/** Authenticate a token and return the account behind it. */
export async function authenticate(token, extra = {}) {
  const s = gitSettings(extra);
  const started = Date.now();

  if (s.kind === 'bitbucket') {
    const { body: u, headers } = await request(`${s.apiUrl}/user`, token, s);
    const scopes = (headers.get('x-oauth-scopes') || '').split(',').map((x) => x.trim()).filter(Boolean);
    return {
      kind: s.kind,
      host: s.apiUrl,
      login: u.username || u.nickname || u.account_id,
      name: u.display_name,
      id: u.uuid || u.account_id,
      email: null,
      avatarUrl: u.links?.avatar?.href || null,
      profileUrl: u.links?.html?.href || null,
      accountType: u.type === 'team' ? 'Workspace' : 'User',
      scopes,
      tokenStyle: s.authUser ? 'API token / app password' : scopes.length ? 'oauth' : 'access token',
      latencyMs: Date.now() - started,
    };
  }

  if (s.kind === 'gitlab') {
    const { body: u } = await request(`${s.apiUrl}/user`, token, s);
    return {
      kind: s.kind,
      host: s.apiUrl,
      login: u.username,
      name: u.name,
      id: u.id,
      email: u.email || null,
      avatarUrl: u.avatar_url || null,
      profileUrl: u.web_url || null,
      accountType: u.bot ? 'Bot' : 'User',
      twoFactor: u.two_factor_enabled ?? null,
      scopes: [],
      latencyMs: Date.now() - started,
    };
  }

  const { body: u, headers } = await request(`${s.apiUrl}/user`, token, s);
  const scopes = (headers.get('x-oauth-scopes') || '').split(',').map((x) => x.trim()).filter(Boolean);

  return {
    kind: s.kind,
    host: s.apiUrl,
    login: u.login,
    name: u.name,
    id: u.id,
    email: u.email || null,
    avatarUrl: u.avatar_url || null,
    profileUrl: u.html_url || null,
    accountType: u.type,
    company: u.company || null,
    publicRepos: u.public_repos,
    privateRepos: u.total_private_repos ?? null,
    // Fine-grained tokens report no scopes at all; that is not an error.
    scopes,
    tokenStyle: scopes.length ? 'classic' : 'fine-grained or app token',
    rateLimit: {
      limit: Number(headers.get('x-ratelimit-limit') || 0),
      remaining: Number(headers.get('x-ratelimit-remaining') || 0),
    },
    latencyMs: Date.now() - started,
  };
}

/* -------------------------------------------------------- repositories */

/** Repositories the token can reach, newest activity first. */
export async function listRepositories(token, extra = {}, { perPage = 100 } = {}) {
  const s = gitSettings(extra);

  if (s.kind === 'bitbucket') {
    const repos = await bitbucketPages(`${s.apiUrl}/repositories?role=member&sort=-updated_on&pagelen=${Math.min(perPage, 100)}`, token, s, 5);
    return repos.map((r) => {
      const clone = (name) => (r.links?.clone || []).find((c) => c.name === name)?.href || null;
      return {
        id: r.uuid,
        name: r.slug,
        fullName: r.full_name,
        description: r.description || null,
        private: r.is_private,
        defaultBranch: r.mainbranch?.name || 'main',
        url: r.links?.html?.href,
        cloneUrl: clone('https'),
        sshUrl: clone('ssh'),
        updatedAt: r.updated_on,
        language: r.language || null,
        stars: null,
        archived: false,
      };
    });
  }

  if (s.kind === 'gitlab') {
    const { body } = await request(
      `${s.apiUrl}/projects?membership=true&order_by=last_activity_at&per_page=${perPage}&simple=false`,
      token, s.kind
    );
    return (body || []).map((p) => ({
      id: p.id,
      name: p.path,
      fullName: p.path_with_namespace,
      description: p.description,
      private: p.visibility !== 'public',
      defaultBranch: p.default_branch,
      url: p.web_url,
      cloneUrl: p.http_url_to_repo,
      sshUrl: p.ssh_url_to_repo,
      updatedAt: p.last_activity_at,
      language: null,
      stars: p.star_count,
      archived: p.archived,
    }));
  }

  const { body } = await request(
    `${s.apiUrl}/user/repos?per_page=${perPage}&sort=updated&affiliation=owner,collaborator,organization_member`,
    token, s.kind
  );
  return (body || []).map((r) => ({
    id: r.id,
    name: r.name,
    fullName: r.full_name,
    description: r.description,
    private: r.private,
    defaultBranch: r.default_branch,
    url: r.html_url,
    cloneUrl: r.clone_url,
    sshUrl: r.ssh_url,
    updatedAt: r.pushed_at || r.updated_at,
    language: r.language,
    stars: r.stargazers_count,
    archived: r.archived,
    permissions: r.permissions || null,
  }));
}

/** Branches of one repository. `fullName` is "owner/repo". */
export async function listBranches(token, extra, fullName) {
  const s = gitSettings(extra);

  if (s.kind === 'bitbucket') {
    const branches = await bitbucketPages(`${s.apiUrl}/repositories/${fullName}/refs/branches?pagelen=100`, token, s, 3);
    return branches.map((b) => ({
      name: b.name,
      protected: false,
      lastCommit: b.target ? { sha: (b.target.hash || '').slice(0, 7), message: firstLine(b.target.message), author: bitbucketAuthor(b.target.author), date: b.target.date } : null,
    }));
  }

  if (s.kind === 'gitlab') {
    const { body } = await request(
      `${s.apiUrl}/projects/${encodeURIComponent(fullName)}/repository/branches?per_page=100`,
      token, s.kind
    );
    return (body || []).map((b) => ({
      name: b.name,
      protected: b.protected,
      lastCommit: b.commit ? { sha: b.commit.short_id, message: firstLine(b.commit.title), author: b.commit.author_name, date: b.commit.committed_date } : null,
    }));
  }

  const { body } = await request(`${s.apiUrl}/repos/${fullName}/branches?per_page=100`, token, s);
  return (body || []).map((b) => ({
    name: b.name,
    protected: b.protected,
    lastCommit: b.commit ? { sha: (b.commit.sha || '').slice(0, 7) } : null,
  }));
}

/** The most recent commits on a branch — used to show what would deploy. */
export async function listCommits(token, extra, fullName, branch, limit = 10) {
  const s = gitSettings(extra);

  if (s.kind === 'bitbucket') {
    const { body } = await request(`${s.apiUrl}/repositories/${fullName}/commits/${encodeURIComponent(branch)}?pagelen=${limit}`, token, s);
    return (body?.values || []).slice(0, limit).map((c) => ({
      sha: (c.hash || '').slice(0, 7),
      message: firstLine(c.message),
      author: bitbucketAuthor(c.author),
      date: c.date,
      url: c.links?.html?.href,
    }));
  }

  if (s.kind === 'gitlab') {
    const { body } = await request(
      `${s.apiUrl}/projects/${encodeURIComponent(fullName)}/repository/commits?ref_name=${encodeURIComponent(branch)}&per_page=${limit}`,
      token, s.kind
    );
    return (body || []).map((c) => ({
      sha: c.short_id,
      message: firstLine(c.title),
      author: c.author_name,
      date: c.committed_date,
      url: c.web_url,
    }));
  }

  const { body } = await request(
    `${s.apiUrl}/repos/${fullName}/commits?sha=${encodeURIComponent(branch)}&per_page=${limit}`,
    token, s.kind
  );
  return (body || []).map((c) => ({
    sha: (c.sha || '').slice(0, 7),
    message: firstLine(c.commit?.message),
    author: c.commit?.author?.name,
    date: c.commit?.author?.date,
    url: c.html_url,
  }));
}

/* ----------------------------------------------------------- contents */

/**
 * One file out of a repository, or null when it is not there.
 * Used to look at a project before anything is cloned onto a server.
 */
export async function readRepoFile(token, extra, fullName, path, ref) {
  const s = gitSettings(extra);

  if (s.kind === 'bitbucket') {
    const url = `${s.apiUrl}/repositories/${fullName}/src/${encodeURIComponent(ref)}/${encodePath(path)}`;
    const { body } = await request(url, token, s, { raw: true, allow404: true });
    return body || null;
  }

  if (s.kind === 'gitlab') {
    const url = `${s.apiUrl}/projects/${encodeURIComponent(fullName)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`;
    const { body } = await request(url, token, s, { raw: true, allow404: true });
    return body || null;
  }

  // GitHub wants the path's slashes as they are ("apps/api/package.json"), each part encoded.
  const url = `${s.apiUrl}/repos/${fullName}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`;
  const { body } = await request(url, token, s, { allow404: true });
  if (!body || body.type !== 'file' || !body.content) return null;
  return Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
}

const encodePath = (p) => String(p || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');

/** The files and folders at the top of a repository — or of one folder in it. */
export async function listRepoRoot(token, extra, fullName, ref, dir = '') {
  const s = gitSettings(extra);

  if (s.kind === 'bitbucket') {
    const url = `${s.apiUrl}/repositories/${fullName}/src/${encodeURIComponent(ref)}/${dir ? `${encodePath(dir)}/` : ''}?pagelen=100`;
    const { body } = await request(url, token, s, { allow404: true });
    return (body?.values || []).map((e) => e.path.split('/').pop());
  }

  if (s.kind === 'gitlab') {
    const url = `${s.apiUrl}/projects/${encodeURIComponent(fullName)}/repository/tree?ref=${encodeURIComponent(ref)}&per_page=100${dir ? `&path=${encodeURIComponent(dir)}` : ''}`;
    const { body } = await request(url, token, s, { allow404: true });
    return (body || []).map((e) => e.name);
  }

  const url = `${s.apiUrl}/repos/${fullName}/contents${dir ? `/${encodePath(dir)}` : ''}?ref=${encodeURIComponent(ref)}`;
  const { body } = await request(url, token, s, { allow404: true });
  return Array.isArray(body) ? body.map((e) => e.name) : [];
}

/**
 * Every folder in a branch that holds a project of its own — a package.json —
 * so one repository with several apps in it (apps/api, apps/web, …) can
 * deploy each of them. "" is the repository root. node_modules and anything
 * deeper than five levels are skipped.
 */
export async function findProjectFolders(token, extra, fullName, ref) {
  const s = gitSettings(extra);
  const paths = [];

  if (s.kind === 'gitlab') {
    // GitLab pages the recursive tree; a few pages cover any sensible repository.
    for (let page = 1; page <= 20; page++) {
      const url = `${s.apiUrl}/projects/${encodeURIComponent(fullName)}/repository/tree?ref=${encodeURIComponent(ref)}&recursive=true&per_page=100&page=${page}`;
      const { body, headers } = await request(url, token, s, { allow404: true });
      for (const e of body || []) if (e.type === 'blob') paths.push(e.path);
      if (!headers?.get?.('x-next-page')) break;
    }
  } else if (s.kind === 'bitbucket') {
    // Bitbucket lists a whole tree to a given depth, a page at a time.
    const entries = await bitbucketPages(`${s.apiUrl}/repositories/${fullName}/src/${encodeURIComponent(ref)}/?max_depth=6&pagelen=100`, token, s, 20, { allow404: true });
    for (const e of entries) if (e.type === 'commit_file') paths.push(e.path);
  } else {
    const { body } = await request(`${s.apiUrl}/repos/${fullName}/git/trees/${encodeURIComponent(ref)}?recursive=1`, token, s, { allow404: true });
    for (const e of body?.tree || []) if (e.type === 'blob') paths.push(e.path);
  }

  const has = (dir, file) => paths.includes(dir ? `${dir}/${file}` : file);
  return paths
    // Test fixtures carry package.json files too; they are not projects anyone deploys.
    .filter((p) => /(^|\/)package\.json$/.test(p) && p.split('/').length <= 6
      && !/(^|\/)(node_modules|fixtures?|__fixtures__|__tests__|test|tests|__mocks__)\//.test(p))
    .map((p) => p.split('/').slice(0, -1).join('/'))
    .sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
    .map((dir) => ({
      path: dir,
      dockerfile: has(dir, 'Dockerfile'),
      next: has(dir, 'next.config.js') || has(dir, 'next.config.mjs') || has(dir, 'next.config.ts'),
      angular: has(dir, 'angular.json'),
      vite: has(dir, 'vite.config.js') || has(dir, 'vite.config.ts'),
    }));
}

/* --------------------------------------------------------- namespaces */

/**
 * Organisations (GitHub) or groups (GitLab) this token can act in.
 * A runner can be registered against one of these instead of a single
 * repository, so every project underneath it can use the same machine.
 */
export async function listOrganizations(token, extra = {}) {
  const s = gitSettings(extra);

  if (s.kind === 'bitbucket') {
    const rows = await bitbucketPages(`${s.apiUrl}/user/permissions/workspaces?pagelen=100`, token, s, 3);
    return rows.map((r) => r.workspace).filter(Boolean).map((w) => ({
      login: w.slug,
      name: w.name || w.slug,
      id: w.uuid,
      url: `${s.webUrl}/${w.slug}`,
      avatarUrl: w.links?.avatar?.href || null,
    }));
  }

  if (s.kind === 'gitlab') {
    const { body } = await request(`${s.apiUrl}/groups?min_access_level=40&per_page=100`, token, s);
    return (body || []).map((g) => ({
      login: g.full_path,
      name: g.name,
      id: g.id,
      url: g.web_url,
      avatarUrl: g.avatar_url || null,
    }));
  }

  const { body } = await request(`${s.apiUrl}/user/orgs?per_page=100`, token, s);
  return (body || []).map((o) => ({
    login: o.login,
    name: o.description || o.login,
    id: o.id,
    url: `${s.webUrl}/${o.login}`,
    avatarUrl: o.avatar_url || null,
  }));
}

/* ------------------------------------------------------------ runners */

/** Bitbucket Pipelines runners are not something the panel installs. */
function noBitbucketRunners(s) {
  if (s.kind === 'bitbucket') throw Object.assign(new Error('Runners are available for GitHub and GitLab accounts. Bitbucket accounts can deploy apps, but not install runners.'), { status: 400 });
}

/** The API root for a runner scope — one repository/project, or a whole org/group. */
function scopeUrl(s, scope, target) {
  noBitbucketRunners(s);
  if (s.kind === 'gitlab') {
    const collection = scope === 'org' ? 'groups' : 'projects';
    return `${s.apiUrl}/${collection}/${encodeURIComponent(target)}`;
  }
  return scope === 'org' ? `${s.apiUrl}/orgs/${target}` : `${s.apiUrl}/repos/${target}`;
}

/** The page a human would open to see these runners. */
export function runnersWebUrl(extra, scope, target) {
  const s = gitSettings(extra);
  if (s.kind === 'bitbucket') return scope === 'org' ? `${s.webUrl}/${target}/workspace/settings` : `${s.webUrl}/${target}/admin`;
  if (s.kind === 'gitlab') {
    return scope === 'org'
      ? `${s.webUrl}/groups/${target}/-/runners`
      : `${s.webUrl}/${target}/-/runners`;
  }
  return scope === 'org'
    ? `${s.webUrl}/organizations/${target}/settings/actions/runners`
    : `${s.webUrl}/${target}/settings/actions/runners`;
}

/** Self-hosted runners registered against one repository, organisation or group. */
export async function listRunners(token, extra, scope, target) {
  const s = gitSettings(extra);

  if (s.kind === 'gitlab') {
    const { body } = await request(`${scopeUrl(s, scope, target)}/runners?per_page=100`, token, s);
    return (body || []).map((r) => ({
      id: String(r.id),
      name: r.description || r.name || `runner ${r.id}`,
      os: null,
      status: r.online === false ? 'offline' : 'online',
      busy: r.status === 'running',
      paused: r.paused ?? (r.active === false),
      labels: r.tag_list || [],
      ip: r.ip_address || null,
      shared: r.is_shared || false,
    }));
  }

  const { body } = await request(`${scopeUrl(s, scope, target)}/actions/runners?per_page=100`, token, s);
  return (body?.runners || []).map((r) => ({
    id: String(r.id),
    name: r.name,
    os: r.os,
    status: r.status,
    busy: Boolean(r.busy),
    paused: false,
    labels: (r.labels || []).map((l) => l.name),
    ip: null,
    shared: false,
  }));
}

/**
 * A short-lived token the machine uses to enrol itself.
 *
 * GitHub mints a registration token per scope. GitLab 16+ creates the runner
 * up front and hands back an authentication token, so the runner already
 * exists — that is why this also returns `remoteId` there.
 */
export async function createRegistrationToken(token, extra, scope, target, { description, labels = [] } = {}) {
  const s = gitSettings(extra);

  if (s.kind === 'gitlab') {
    const { body: owner } = await request(scopeUrl(s, scope, target), token, s);
    if (!owner?.id) throw new Error(`GitLab could not find ${scope === 'org' ? 'group' : 'project'} "${target}"`);

    const { body } = await request(`${s.apiUrl}/user/runners`, token, s, {
      method: 'POST',
      body: {
        runner_type: scope === 'org' ? 'group_type' : 'project_type',
        ...(scope === 'org' ? { group_id: owner.id } : { project_id: owner.id }),
        description: description || 'aj-pilot runner',
        tag_list: labels,
        run_untagged: true,
      },
    });
    if (!body?.token) throw new Error('GitLab did not return a runner token — the account needs Maintainer or Owner rights here.');
    return { token: body.token, remoteId: body.id ? String(body.id) : null, expiresAt: null };
  }

  const { body } = await request(`${scopeUrl(s, scope, target)}/actions/runners/registration-token`, token, s, { method: 'POST' });
  if (!body?.token) throw new Error('GitHub did not return a registration token — the token needs admin rights on this repository or organisation.');
  return { token: body.token, remoteId: null, expiresAt: body.expires_at || null };
}

/** GitHub only: the token a machine needs to take itself back out again. */
export async function createRemoveToken(token, extra, scope, target) {
  const s = gitSettings(extra);
  if (s.kind !== 'github') return null;
  const { body } = await request(`${scopeUrl(s, scope, target)}/actions/runners/remove-token`, token, s, { method: 'POST' });
  return body?.token || null;
}

/** Forget a runner on the provider's side. */
export async function deleteRunner(token, extra, scope, target, remoteId) {
  const s = gitSettings(extra);
  noBitbucketRunners(s);
  const url = s.kind === 'gitlab'
    ? `${s.apiUrl}/runners/${encodeURIComponent(remoteId)}`
    : `${scopeUrl(s, scope, target)}/actions/runners/${encodeURIComponent(remoteId)}`;
  await request(url, token, s, { method: 'DELETE' });
  return true;
}

/** The newest actions/runner release, so a fresh install is never stale. */
export async function latestRunnerVersion(extra = {}) {
  const s = gitSettings(extra);
  const api = s.kind === 'github' ? s.apiUrl : 'https://api.github.com';
  try {
    const res = await fetch(`${api}/repos/actions/runner/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'aj-pilot' },
    });
    const body = await res.json().catch(() => null);
    const tag = String(body?.tag_name || '').replace(/^v/, '');
    if (/^\d+\.\d+\.\d+$/.test(tag)) return tag;
  } catch { /* fall through to the pinned version */ }
  return FALLBACK_RUNNER_VERSION;
}

/** Used when the releases API is unreachable or rate limited. */
export const FALLBACK_RUNNER_VERSION = '2.328.0';

/**
 * The clone URL with the token embedded, for the deployment phase.
 * Never returned by the API — it is a secret.
 */
export function authenticatedCloneUrl(token, extra, cloneUrl, login) {
  const s = gitSettings(extra);
  const url = new URL(cloneUrl);
  url.username = s.kind === 'gitlab' ? 'oauth2'
    : s.kind === 'bitbucket' ? bitbucketGitUser(s, login)
    : (login || 'x-access-token');
  url.password = token;
  return url.toString();
}

/**
 * Who git signs in as on Bitbucket: OAuth and access tokens use "x-token-auth",
 * an Atlassian API token (signed in by email) uses its own fixed name, and an
 * app password uses the Bitbucket username it belongs to.
 */
function bitbucketGitUser(s, login) {
  if (!s.authUser) return 'x-token-auth';
  if (s.authUser.includes('@')) return 'x-bitbucket-api-token-auth';
  return s.authUser || login;
}

/** Bitbucket pages every list as { values, next }; follow `next` up to `maxPages`. */
async function bitbucketPages(url, token, s, maxPages = 5, opts = {}) {
  const out = [];
  let next = url;
  for (let page = 0; next && page < maxPages; page++) {
    const { body } = await request(next, token, s, opts);
    out.push(...(body?.values || []));
    next = body?.next || null;
  }
  return out;
}

/** "Jane Doe <jane@example.com>" → "Jane Doe". */
const bitbucketAuthor = (a) => a?.user?.display_name || String(a?.raw || '').replace(/\s*<[^>]*>\s*$/, '') || null;

const firstLine = (text) => String(text || '').split('\n')[0].trim();
