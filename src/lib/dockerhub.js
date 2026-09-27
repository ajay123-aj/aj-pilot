/**
 * Docker Hub accounts.
 *
 * Docker Hub has no OAuth for third-party panels, so the browser flow sends
 * the user to their own Docker Hub settings to create a personal access token.
 * They sign in there, press "Generate" and copy it; the panel picks the token
 * up, signs in with it and reads the account behind it.
 */

const HUB = 'https://hub.docker.com';

/** Docker Hub's "New access token" page. */
export const TOKEN_CREATE_URL = 'https://app.docker.com/settings/personal-access-tokens/create';

async function hub(path, { method = 'GET', token, payload } = {}) {
  let res;
  try {
    res = await fetch(`${HUB}${path}`, {
      method,
      redirect: 'follow',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
  } catch (err) {
    throw new Error(`Could not reach Docker Hub: ${err.message}`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(body.message || body.detail || `Docker Hub answered HTTP ${res.status}`), { status: res.status });
  }
  return body;
}

/** The claims inside a Docker Hub JWT; it is only read, never trusted for access. */
function jwtClaims(jwt) {
  try {
    return JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

/**
 * Sign in with a Docker ID and a personal access token (or password). The
 * newer token endpoint is tried first; the older login endpoint is the fallback.
 */
async function signIn(username, secret) {
  try {
    const b = await hub('/v2/auth/token', { method: 'POST', payload: { identifier: username, secret } });
    return b.access_token || b.token;
  } catch (err) {
    if (err.status !== 404 && err.status !== 405) {
      if (err.status === 401 || err.status === 403) {
        throw new Error('Docker Hub did not accept that Docker ID and token. Check the Docker ID, and copy the whole token (it starts with dckr_pat_ and is only shown once).');
      }
      throw err;
    }
  }
  const b = await hub('/v2/users/login', { method: 'POST', payload: { username, password: secret } });
  return b.token;
}

/**
 * What a token may do with the account's repositories, asked of the registry
 * itself: it answers with the actions it actually grants.
 */
async function registryAccess(username, secret) {
  const scope = `repository:${username}/auto-deploy-access-check:pull,push,delete`;
  try {
    const res = await fetch(`https://auth.docker.io/token?service=registry.docker.io&scope=${encodeURIComponent(scope)}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${username}:${secret}`).toString('base64')}` },
    });
    if (!res.ok) return null;
    const { token } = await res.json();
    const actions = jwtClaims(token).access?.[0]?.actions || [];
    return { pull: true, push: actions.includes('push'), delete: actions.includes('delete') };
  } catch {
    return null;
  }
}

const optional = (p) => p.then((v) => ({ ok: true, v }), (err) => ({ ok: false, err }));

/* -------------------------------------------------- repositories and tags */

/**
 * Hub JWTs last a few minutes; browsing a repository makes several calls, so
 * one sign-in is reused for a short while instead of signing in every time.
 */
const sessions = new Map();
const SESSION_MS = 4 * 60 * 1000;

async function session(username, secret) {
  const key = `${username}\n${secret}`;
  const hit = sessions.get(key);
  if (hit && hit.expires > Date.now()) return hit.jwt;
  const jwt = await signIn(String(username).toLowerCase(), String(secret).trim());
  sessions.set(key, { jwt, expires: Date.now() + SESSION_MS });
  return jwt;
}

const NAME = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
function checkRepo(namespace, repo) {
  if (!NAME.test(String(namespace)) || (repo !== undefined && !NAME.test(String(repo)))) {
    throw new Error('That is not a Docker Hub repository name');
  }
}

/** Every page of a Hub list, up to a cap. */
async function hubList(path, jwt, max = 1000) {
  const out = [];
  let count = null;
  for (let page = 1; out.length < max; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const b = await hub(`${path}${sep}page_size=100&page=${page}`, { token: jwt });
    count = b.count ?? count;
    out.push(...(b.results || []));
    if (!b.next) break;
  }
  return { results: out, count };
}

function repoSummary(r) {
  return {
    namespace: r.namespace || r.user,
    name: r.name,
    description: r.description || '',
    private: Boolean(r.is_private),
    status: r.status_description || null,
    type: r.repository_type || null,
    stars: r.star_count ?? null,
    pulls: r.pull_count ?? null,
    lastUpdated: r.last_updated || null,
    registered: r.date_registered || null,
    storageSize: r.storage_size ?? null,
  };
}

/** Repositories in one namespace — the account itself or one of its organisations. */
export async function listRepositories(username, secret, namespace) {
  const ns = String(namespace || username).toLowerCase();
  checkRepo(ns);
  const jwt = await session(username, secret);
  const { results, count } = await hubList(`/v2/repositories/${ns}/?ordering=last_updated`, jwt, 500);
  return { namespace: ns, count: count ?? results.length, repositories: results.map(repoSummary) };
}

function tagSummary(t) {
  const images = (t.images || []).map((i) => ({
    platform: [i.os, i.architecture, i.variant].filter(Boolean).join('/'),
    digest: i.digest || null,
    size: i.size ?? null,
    status: i.status || null,
    lastPulled: i.last_pulled || null,
    lastPushed: i.last_pushed || null,
  }));
  return {
    name: t.name,
    digest: t.digest || null,
    mediaType: t.media_type || null,
    size: t.full_size ?? null,
    status: t.tag_status || null,
    lastUpdated: t.last_updated || null,
    lastPushed: t.tag_last_pushed || null,
    lastPulled: t.tag_last_pulled || null,
    pushedBy: t.last_updater_username || null,
    images,
  };
}

/** One repository in full: its details, README and every tag with its platforms. */
export async function getRepository(username, secret, namespace, repo) {
  checkRepo(namespace, repo);
  const jwt = await session(username, secret);
  const path = `/v2/repositories/${namespace}/${repo}`;
  const [info, tags] = await Promise.all([
    hub(`${path}/`, { token: jwt }),
    hubList(`${path}/tags/?ordering=last_updated`, jwt, 1000),
  ]);
  return {
    repository: {
      ...repoSummary(info),
      fullDescription: info.full_description || '',
      categories: (info.categories || []).map((c) => c.name),
      permissions: info.permissions || null,
      collaborators: info.collaborator_count ?? null,
      lastModified: info.last_modified || null,
      mediaTypes: info.media_types || [],
      immutableTags: Boolean(info.immutable_tags_settings?.enabled),
    },
    tagCount: tags.count ?? tags.results.length,
    tags: tags.results.map(tagSummary),
  };
}

/** Delete one tag. Images other tags still point at are kept by Docker Hub. */
export async function deleteTag(username, secret, namespace, repo, tag) {
  checkRepo(namespace, repo);
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(String(tag))) throw new Error('That is not a Docker tag');
  const jwt = await session(username, secret);
  let res;
  try {
    res = await fetch(`${HUB}/v2/repositories/${namespace}/${repo}/tags/${encodeURIComponent(tag)}/`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${jwt}` },
    });
  } catch (err) {
    throw new Error(`Could not reach Docker Hub: ${err.message}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error('This token is not allowed to delete tags — create one with Read, Write, Delete access and reconnect.');
  }
  if (!res.ok && res.status !== 204) {
    const b = await res.json().catch(() => ({}));
    throw new Error(b.message || b.detail || `Docker Hub answered HTTP ${res.status}`);
  }
  return { tag };
}

/** Verify a Docker ID + token and collect the account: profile, organisations and repositories. */
export async function authenticateDockerHub(username, secret) {
  const user = String(username || '').trim().toLowerCase();
  const token = String(secret || '').trim();
  if (!user) throw new Error('Your Docker ID (username) is required');
  if (!/^[a-z0-9][a-z0-9_.-]{1,}$/.test(user)) throw new Error('A Docker ID is lowercase letters, digits, "-", "_" or "." — not your email address');
  if (!token) throw new Error('A Docker Hub access token is required');
  if (/\s/.test(token)) throw new Error('The token should not contain spaces — copy it exactly as Docker Hub shows it.');

  const started = Date.now();
  const jwt = await signIn(user, token);
  const claims = jwtClaims(jwt);
  const hubClaims = claims['https://hub.docker.com'] || {};

  const [profile, orgs, repos, access] = await Promise.all([
    optional(hub(`/v2/users/${user}/`)),
    optional(hub('/v2/user/orgs/?page_size=100', { token: jwt })),
    optional(hub(`/v2/repositories/${user}/?page_size=100&ordering=last_updated`, { token: jwt })),
    registryAccess(user, token),
  ]);

  const p = profile.ok ? profile.v : {};
  return {
    username: hubClaims.username || user,
    email: hubClaims.email || null,
    fullName: p.full_name || null,
    company: p.company || null,
    location: p.location || null,
    type: p.type || null,
    dateJoined: p.date_joined || null,
    avatar: p.gravatar_url || null,
    tokenKind: token.startsWith('dckr_pat_') ? 'personal access token' : token.startsWith('dckr_oat_') ? 'organisation access token' : 'password',
    access,
    organizations: orgs.ok ? (orgs.v.results || []).map((o) => ({ name: o.orgname, fullName: o.full_name || null })) : [],
    repositories: repos.ok ? (repos.v.results || []).map((r) => ({
      name: r.name,
      private: Boolean(r.is_private),
      pulls: r.pull_count ?? null,
      stars: r.star_count ?? null,
      lastUpdated: r.last_updated || null,
      description: r.description || '',
    })) : [],
    repositoryCount: repos.ok ? repos.v.count ?? null : null,
    latencyMs: Date.now() - started,
    checkedAt: new Date().toISOString(),
  };
}
