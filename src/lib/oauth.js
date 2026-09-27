import crypto from 'node:crypto';
import { config } from '../config.js';

/**
 * Browser OAuth for git hosting.
 *
 * The panel sends the browser to the provider, the user approves there, and the
 * provider redirects back with a short-lived code that we swap for an access
 * token server-side. The token never travels through the URL bar.
 */

const PROVIDERS = {
  github: {
    label: 'GitHub',
    scopes: ['repo', 'read:org', 'read:user'],
    usesPkce: false,
    authorizePath: '/login/oauth/authorize',
    tokenPath: '/login/oauth/access_token',
  },
  gitlab: {
    label: 'GitLab',
    scopes: ['read_api', 'read_repository', 'read_user'],
    usesPkce: true,
    authorizePath: '/oauth/authorize',
    tokenPath: '/oauth/token',
  },
  // Bitbucket's permissions are ticked on the OAuth consumer itself, not asked for in the URL.
  bitbucket: {
    label: 'Bitbucket',
    scopes: ['account', 'repository', 'workspace membership'],
    usesPkce: false,
    authorizePath: '/site/oauth2/authorize',
    tokenPath: '/site/oauth2/access_token',
    scopesOnApp: true,
    basicAuth: true,
  },
};

/** GitLab and Bitbucket follow the OAuth spec to the letter; GitHub needs none of this. */
const strict = (kind) => kind !== 'github';

/** Bitbucket wants the app's ID and secret as HTTP basic auth on the token endpoint. */
function clientAuthHeader(p, clientId, clientSecret) {
  return p.basicAuth ? { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}` } : {};
}

/** Which providers have credentials configured in .env. */
export function configuredProviders() {
  return Object.entries(PROVIDERS)
    .map(([kind, p]) => {
      const c = config.oauth[kind];
      return {
        kind,
        label: p.label,
        configured: Boolean(c.clientId && c.clientSecret),
        webUrl: c.webUrl,
        scopes: p.scopes,
        registerUrl: registrationUrl(kind),
        secretOptional: Boolean(p.secretOptional),
      };
    });
}

/**
 * A link straight to the provider's "new application" form, pre-filled where
 * the provider supports it, so setting this up is a couple of clicks.
 */
export function registrationUrl(kind) {
  const base = config.oauth[kind]?.webUrl?.replace(/\/+$/, '') || '';
  const home = config.oauth.callbackBase.replace(/\/+$/, '');

  if (kind === 'github') {
    const q = new URLSearchParams({
      'oauth_application[name]': 'AJ Pilot',
      'oauth_application[url]': home,
      'oauth_application[callback_url]': callbackUrl(),
    });
    return `${base}/settings/applications/new?${q}`;
  }
  // OAuth consumers live under a workspace's settings; this lists the workspaces to pick from.
  if (kind === 'bitbucket') return `${base}/account/workspaces/`;
  return `${base}/-/user_settings/applications`;
}

/**
 * Reject values that clearly are not an OAuth app's credentials, so the mistake
 * surfaces here rather than as a bare 404 on the provider's sign-in page.
 */
function validateCredentials(label, clientId, clientSecret) {
  const id = String(clientId || '').trim();
  const secret = String(clientSecret || '').trim();

  if (!id) throw new Error('A client ID is required');
  if (!secret) throw new Error('A client secret is required');

  if (id.includes('@')) {
    throw new Error(
      `That looks like an email address, not a ${label} Client ID. ` +
      `The Client ID comes from the OAuth app you register on ${label} — create the app first, then copy the Client ID it shows you.`
    );
  }
  if (/\s/.test(id)) throw new Error('The client ID should not contain spaces — copy it exactly as shown.');
  if (id.length < 10) {
    throw new Error(`That client ID looks too short for ${label}. Copy the whole value from the OAuth app page.`);
  }
  if (id === secret) throw new Error('The client ID and client secret are the same value — they are two different things.');
  if (/^(your|client|paste|xxx)/i.test(id)) throw new Error('That looks like placeholder text rather than a real client ID.');

  return { id, secret };
}

/**
 * Check a client ID and secret against the provider before we save them.
 *
 * The authorize page cannot be used for this — signed out, it just redirects to
 * a login page whatever the client ID is, and the 404 only appears after login.
 * The token endpoint does answer honestly: sent a deliberately invalid code, it
 * rejects an unknown app outright, complains about the secret if that is wrong,
 * and only complains about the code when both are right.
 */
export async function verifyClientCredentials(kind, clientId, clientSecret) {
  const c = config.oauth[kind];
  const p = PROVIDERS[kind];
  const label = p.label;

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code: 'auto-deploy-credential-check',
    redirect_uri: callbackUrl(),
  });
  if (strict(kind)) body.set('grant_type', 'authorization_code');

  let res;
  let data = {};
  try {
    res = await fetch(`${c.webUrl.replace(/\/+$/, '')}${p.tokenPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': 'aj-pilot', ...clientAuthHeader(p, clientId, clientSecret) },
      body,
    });
    data = await res.json().catch(() => ({}));
  } catch (err) {
    // Offline or blocked: save anyway and let the real sign-in surface it.
    return { ok: true, unchecked: err.message };
  }

  const error = String(data.error || '');

  // The app itself is unknown to the provider.
  if (res.status === 404 || /invalid_client|unauthorized_client/i.test(error)) {
    return {
      ok: false,
      reason: `${label} does not recognise that Client ID — no OAuth app with it exists.`,
    };
  }
  if (/incorrect_client_credentials/i.test(error)) {
    return {
      ok: false,
      reason: `${label} knows that Client ID, but the Client Secret does not match it.`,
    };
  }

  // "bad code" is the expected answer when the app and secret are both right.
  if (/bad_verification_code|invalid_grant/i.test(error)) return { ok: true, verified: true };

  return { ok: true, verified: false, status: res.status, providerError: error || null };
}

/** Store an OAuth app's credentials and start using them without a restart. */
export function setProviderCredentials(kind, clientId, clientSecret) {
  const p = PROVIDERS[kind];
  if (!p) throw new Error(`Unknown git provider "${kind}"`);
  const { id, secret } = validateCredentials(p.label, clientId, clientSecret);

  config.oauth[kind].clientId = id;
  config.oauth[kind].clientSecret = secret;
  return { kind, label: p.label };
}

function providerOrThrow(kind) {
  const p = PROVIDERS[kind];
  const c = config.oauth[kind];
  if (!p) throw new Error(`Unknown git provider "${kind}"`);
  if (!c.clientId || !c.clientSecret) {
    throw new Error(
      `${p.label} browser sign-in is not configured. Register an OAuth app on ${p.label}, then set ` +
      `${kind.toUpperCase()}_CLIENT_ID and ${kind.toUpperCase()}_CLIENT_SECRET in your .env and restart.`
    );
  }
  return { p, c };
}

export const callbackUrl = () => `${config.oauth.callbackBase.replace(/\/+$/, '')}/api/git/oauth/callback`;

/* --------------------------------------------------------- state store */

/**
 * Pending authorisations, keyed by the `state` we send to the provider.
 * In memory on purpose: these live for minutes and must not outlive a restart.
 */
const pending = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

function sweep() {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [key, v] of pending) if (v.createdAt < cutoff) pending.delete(key);
}

export function beginAuthorization(kind, { name } = {}) {
  const { p, c } = providerOrThrow(kind);
  sweep();

  const state = crypto.randomBytes(24).toString('base64url');
  const verifier = p.usesPkce ? crypto.randomBytes(48).toString('base64url') : null;
  pending.set(state, { kind, name: (name || '').trim(), verifier, createdAt: Date.now() });

  const url = new URL(`${c.webUrl.replace(/\/+$/, '')}${p.authorizePath}`);
  url.searchParams.set('client_id', c.clientId);
  url.searchParams.set('redirect_uri', callbackUrl());
  url.searchParams.set('state', state);
  if (!p.scopesOnApp) url.searchParams.set('scope', p.scopes.join(' '));
  if (strict(kind)) url.searchParams.set('response_type', 'code');
  if (verifier) {
    url.searchParams.set('code_challenge', crypto.createHash('sha256').update(verifier).digest('base64url'));
    url.searchParams.set('code_challenge_method', 'S256');
  }

  return { url: url.toString(), state };
}

/** Consume a state value exactly once. */
export function takeState(state) {
  sweep();
  const entry = pending.get(state);
  if (!entry) return null;
  pending.delete(state);
  return entry;
}

/* ------------------------------------------------------ code exchange */

export async function exchangeCode(kind, code, verifier) {
  const { p, c } = providerOrThrow(kind);

  const body = new URLSearchParams({
    client_id: c.clientId,
    client_secret: c.clientSecret,
    code,
    redirect_uri: callbackUrl(),
  });
  if (strict(kind)) body.set('grant_type', 'authorization_code');
  if (verifier) body.set('code_verifier', verifier);

  return postForToken(`${c.webUrl.replace(/\/+$/, '')}${p.tokenPath}`, body, p.label, clientAuthHeader(p, c.clientId, c.clientSecret));
}

/** GitLab and Bitbucket access tokens expire; swap the refresh token for a new pair. */
export async function refreshAccessToken(kind, refreshToken) {
  const { p, c } = providerOrThrow(kind);
  const body = new URLSearchParams({
    client_id: c.clientId,
    client_secret: c.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    redirect_uri: callbackUrl(),
  });
  return postForToken(`${c.webUrl.replace(/\/+$/, '')}${p.tokenPath}`, body, p.label, clientAuthHeader(p, c.clientId, c.clientSecret));
}

async function postForToken(url, body, label, extraHeaders = {}) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', ...extraHeaders },
      body,
    });
  } catch (err) {
    throw new Error(`Could not reach ${label} to exchange the code: ${err.message}`);
  }

  const data = await res.json().catch(() => ({}));

  // GitHub answers 200 with an error body rather than an error status.
  if (!res.ok || data.error) {
    const detail = data.error_description || data.error || `HTTP ${res.status}`;
    if (/bad_verification_code|invalid_grant/i.test(String(data.error))) {
      throw new Error(`${label} rejected the sign-in code — it expired or was already used. Try connecting again.`);
    }
    throw new Error(`${label} refused the token exchange: ${detail}`);
  }
  if (!data.access_token) throw new Error(`${label} did not return an access token.`);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    scopes: (data.scope || data.scopes || '').split(/[,\s]+/).filter(Boolean),
    expiresAt: data.expires_in ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString() : null,
  };
}
