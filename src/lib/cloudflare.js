/**
 * Cloudflare accounts.
 *
 * Cloudflare does not let third-party panels register an OAuth app, so the
 * browser flow sends the user to their own dashboard with a token form already
 * filled in (name, permissions, all zones). They press "Create token" there and
 * the panel picks the token up, verifies it, and reads the account behind it.
 */

const API = 'https://api.cloudflare.com/client/v4';

/** Permissions the pre-filled token asks for, as the dashboard's deep link expects them. */
export const TOKEN_PERMISSIONS = [
  { key: 'zone', type: 'edit', label: 'Zone: Edit' },
  { key: 'zone_settings', type: 'read', label: 'Zone Settings: Read' },
  { key: 'dns', type: 'edit', label: 'DNS: Edit' },
  { key: 'account_settings', type: 'read', label: 'Account Settings: Read' },
  { key: 'user_details', type: 'read', label: 'User Details: Read' },
  { key: 'argotunnel', type: 'edit', label: 'Cloudflare Tunnel: Edit' },
  { key: 'teams', type: 'edit', label: 'Zero Trust: Edit' },
];

/** A link to the dashboard's "Create API token" form with everything filled in. */
export function tokenCreateUrl(name = 'AJ Pilot') {
  const keys = JSON.stringify(TOKEN_PERMISSIONS.map(({ key, type }) => ({ key, type })));
  const q = `permissionGroupKeys=${encodeURIComponent(keys)}&name=${encodeURIComponent(name)}&accountId=*&zoneId=all`;
  return `https://dash.cloudflare.com/profile/api-tokens?${q}`;
}

async function cf(token, path, { method = 'GET', payload } = {}) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
  } catch (err) {
    throw new Error(`Could not reach Cloudflare: ${err.message}`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    const e = body.errors?.[0];
    throw Object.assign(new Error(e?.message || `Cloudflare answered HTTP ${res.status}`), { status: res.status, code: e?.code });
  }
  return body;
}

/** Every page of a list endpoint, up to a sane cap. */
async function cfList(token, path, max = 500) {
  const out = [];
  for (let page = 1; out.length < max; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const body = await cf(token, `${path}${sep}per_page=50&page=${page}`);
    out.push(...(body.result || []));
    const info = body.result_info;
    if (!info || page >= (info.total_pages || 1)) break;
  }
  return out;
}

/** A read that the token may simply not be allowed to make. */
const optional = (p) => p.then((v) => ({ ok: true, v }), (err) => ({ ok: false, err }));

/**
 * Verify a token and collect what it can see: the person, their accounts and
 * zones. Only the verify call has to succeed — a narrow token still connects.
 */
export async function authenticateCloudflare(token) {
  const t = String(token || '').trim();
  if (!t) throw new Error('A Cloudflare API token is required');
  if (/\s/.test(t)) throw new Error('The token should not contain spaces — copy it exactly as Cloudflare shows it.');

  const started = Date.now();
  let verify;
  try {
    verify = (await cf(t, '/user/tokens/verify')).result || {};
  } catch (err) {
    if (err.status === 401 || err.status === 400) {
      throw new Error('Cloudflare does not recognise that token. Copy the whole value shown after "Create Token" (it is only shown once).');
    }
    throw err;
  }
  if (verify.status && verify.status !== 'active') {
    throw new Error(`That token is ${verify.status} on Cloudflare. Create a new one, or re-activate it in the dashboard.`);
  }

  const [user, accounts, zones] = await Promise.all([
    optional(cf(t, '/user').then((b) => b.result)),
    optional(cfList(t, '/accounts')),
    optional(cfList(t, '/zones')),
  ]);

  const zoneList = zones.ok ? zones.v.map(zoneSummary) : [];

  const accountList = accounts.ok ? accounts.v.map((a) => ({
    id: a.id,
    name: a.name,
    type: a.type || null,
    createdOn: a.created_on || null,
    enforceTwoFactor: a.settings ? Boolean(a.settings.enforce_twofactor) : null,
    zones: zoneList.filter((z) => z.accountId === a.id).length,
  })) : [];

  // The zone list names the account even when the accounts endpoint is off-limits.
  if (!accounts.ok) {
    for (const z of zoneList) {
      if (z.accountId && !accountList.some((a) => a.id === z.accountId)) {
        accountList.push({ id: z.accountId, name: z.accountName, type: null, zones: 0 });
      }
      const a = accountList.find((x) => x.id === z.accountId);
      if (a) a.zones++;
    }
  }

  const u = user.ok ? user.v : null;
  return {
    tokenId: verify.id || null,
    tokenStatus: verify.status || null,
    expiresOn: verify.expires_on || null,
    notBefore: verify.not_before || null,
    userId: u?.id || null,
    email: u?.email || null,
    name: u ? [u.first_name, u.last_name].filter(Boolean).join(' ') || null : null,
    twoFactor: u ? Boolean(u.two_factor_authentication_enabled) : null,
    user: u ? {
      username: u.username || null,
      country: u.country || null,
      zipcode: u.zipcode || null,
      telephone: u.telephone || null,
      createdOn: u.created_on || null,
      modifiedOn: u.modified_on || null,
      suspended: Boolean(u.suspended),
      hasProZones: Boolean(u.has_pro_zones),
      hasBusinessZones: Boolean(u.has_business_zones),
      hasEnterpriseZones: Boolean(u.has_enterprise_zones),
    } : null,
    accounts: accountList,
    zones: zoneList,
    access: {
      user: user.ok,
      accounts: accounts.ok,
      zones: zones.ok,
    },
    latencyMs: Date.now() - started,
    checkedAt: new Date().toISOString(),
  };
}

/** Everything the zone list says about one zone, in the shape the UI uses. */
function zoneSummary(z) {
  return {
    id: z.id,
    name: z.name,
    status: z.status,
    paused: Boolean(z.paused),
    type: z.type,
    plan: z.plan?.name || null,
    nameServers: z.name_servers || [],
    originalNameServers: z.original_name_servers || [],
    originalRegistrar: z.original_registrar || null,
    originalDnsHost: z.original_dnshost || null,
    vanityNameServers: z.vanity_name_servers || [],
    developmentMode: Number(z.development_mode || 0),
    createdOn: z.created_on || null,
    modifiedOn: z.modified_on || null,
    activatedOn: z.activated_on || null,
    permissions: z.permissions || [],
    accountId: z.account?.id || null,
    accountName: z.account?.name || null,
  };
}

/** Zone settings worth showing, when the token may read them. */
const SETTING_KEYS = [
  'ssl', 'always_use_https', 'min_tls_version', 'tls_1_3', 'automatic_https_rewrites',
  'http3', 'brotli', 'ipv6', 'websockets', 'security_level', 'cache_level',
  'browser_cache_ttl', 'development_mode', 'email_obfuscation', 'hotlink_protection',
];

/** One zone in full: its record, its main settings and its DNS records. */
export async function getZoneDetail(token, zoneId) {
  if (!/^[a-f0-9]{32}$/i.test(String(zoneId))) throw new Error('That is not a Cloudflare zone id');
  const [zone, settings, dns] = await Promise.all([
    cf(token, `/zones/${zoneId}`).then((b) => zoneSummary(b.result)),
    optional(cf(token, `/zones/${zoneId}/settings`).then((b) => b.result || [])),
    optional(listDnsRecords(token, zoneId)),
  ]);
  return {
    zone,
    settings: settings.ok
      ? settings.v.filter((s) => SETTING_KEYS.includes(s.id)).map((s) => ({ id: s.id, value: s.value, editable: Boolean(s.editable) }))
      : null,
    settingsError: settings.ok ? null : settings.err.message,
    records: dns.ok ? dns.v : null,
    recordsError: dns.ok ? null : dns.err.message,
  };
}

/**
 * Remove a domain (zone) from Cloudflare. This deletes the zone and every DNS
 * record in it on Cloudflare's side; it cannot be undone from the panel.
 */
export async function deleteZone(token, zoneId) {
  if (!/^[a-f0-9]{32}$/i.test(String(zoneId))) throw new Error('That is not a Cloudflare zone id');
  let res;
  try {
    res = await fetch(`${API}/zones/${zoneId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  } catch (err) {
    throw new Error(`Could not reach Cloudflare: ${err.message}`);
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 403 || res.status === 401 || body.errors?.some((e) => e.code === 9109 || e.code === 10000)) {
    throw new Error('This token is not allowed to remove domains — it needs Zone: Edit. Connect the account again with a new token (the sign-in link now asks for it).');
  }
  if (!res.ok || body.success === false) {
    throw new Error(body.errors?.[0]?.message || `Cloudflare answered HTTP ${res.status}`);
  }
  return { id: body.result?.id || zoneId };
}

/** The label a freshly connected account is stored under. */
export const cloudflareLabel = (account) =>
  account.email || account.accounts[0]?.name || account.zones[0]?.name || `token ${String(account.tokenId || '').slice(0, 8)}`;

const isCfId = (v) => /^[a-f0-9]{32}$/i.test(String(v));

/** DNS records of one zone. */
export async function listDnsRecords(token, zoneId) {
  if (!isCfId(zoneId)) throw new Error('That is not a Cloudflare zone id');
  const records = await cfList(token, `/zones/${zoneId}/dns_records`, 1000);
  return records.map(dnsRecord);
}

/** Record types the panel can add and edit; others are shown read-only. */
export const EDITABLE_DNS_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'PTR'];
const PROXIABLE = new Set(['A', 'AAAA', 'CNAME']);

/**
 * Check and shape a record from the form into what Cloudflare expects.
 * `name` may be "@", "www" or a full name; it is always sent fully qualified.
 */
export function buildDnsRecord(input, zoneName) {
  const type = String(input.type || '').toUpperCase();
  if (!EDITABLE_DNS_TYPES.includes(type)) throw new Error(`Record type must be one of ${EDITABLE_DNS_TYPES.join(', ')}`);

  const zone = String(zoneName).toLowerCase();
  let name = String(input.name || '').trim().toLowerCase().replace(/\.+$/, '');
  if (!name || name === '@') name = zone;
  else if (name !== zone && !name.endsWith(`.${zone}`)) name = `${name}.${zone}`;
  if (!/^[a-z0-9*_.-]+$/.test(name)) throw new Error('The name may only contain letters, digits, "-", "_", "." and a leading "*".');

  const content = String(input.content || '').trim();
  if (!content) throw new Error('Content is required');
  if (type === 'A' && !/^(\d{1,3}\.){3}\d{1,3}$/.test(content)) throw new Error('An A record needs an IPv4 address, like 203.0.113.10');
  if (type === 'AAAA' && !/^[0-9a-f:]+$/i.test(content)) throw new Error('An AAAA record needs an IPv6 address, like 2001:db8::1');
  if (['CNAME', 'MX', 'NS', 'PTR'].includes(type) && /\s/.test(content)) throw new Error(`A ${type} record points at a host name, without spaces`);

  const ttl = Number(input.ttl || 1);
  if (!(ttl === 1 || (ttl >= 60 && ttl <= 86400))) throw new Error('TTL must be Auto, or between 60 and 86400 seconds');

  const out = { type, name, content, ttl };
  if (PROXIABLE.has(type)) out.proxied = input.proxied === true || input.proxied === 'true' || input.proxied === 'on';
  if (type === 'MX') {
    const priority = Number(input.priority ?? 10);
    if (!Number.isInteger(priority) || priority < 0 || priority > 65535) throw new Error('MX priority must be 0–65535');
    out.priority = priority;
  }
  // Proxied records always use automatic TTL on Cloudflare.
  if (out.proxied) out.ttl = 1;
  out.comment = String(input.comment || '').trim().slice(0, 100);
  return out;
}

export async function createDnsRecord(token, zoneId, record) {
  if (!isCfId(zoneId)) throw new Error('That is not a Cloudflare zone id');
  return dnsRecord((await cf(token, `/zones/${zoneId}/dns_records`, { method: 'POST', payload: record }).catch(dnsWriteError)).result);
}

export async function updateDnsRecord(token, zoneId, recordId, record) {
  if (!isCfId(zoneId) || !isCfId(recordId)) throw new Error('That is not a Cloudflare record id');
  return dnsRecord((await cf(token, `/zones/${zoneId}/dns_records/${recordId}`, { method: 'PUT', payload: record }).catch(dnsWriteError)).result);
}

export async function deleteDnsRecord(token, zoneId, recordId) {
  if (!isCfId(zoneId) || !isCfId(recordId)) throw new Error('That is not a Cloudflare record id');
  await cf(token, `/zones/${zoneId}/dns_records/${recordId}`, { method: 'DELETE' }).catch(dnsWriteError);
  return { id: recordId };
}

/** One record, looked up to confirm it exists before it is changed. */
export async function getDnsRecord(token, zoneId, recordId) {
  if (!isCfId(zoneId) || !isCfId(recordId)) throw new Error('That is not a Cloudflare record id');
  return dnsRecord((await cf(token, `/zones/${zoneId}/dns_records/${recordId}`)).result);
}

function dnsWriteError(err) {
  if (err.status === 403 || err.code === 9109 || err.code === 10000) {
    throw new Error('This token is not allowed to change DNS — it needs DNS: Edit. Connect the account again with a new token.');
  }
  throw err;
}

function dnsRecord(r) {
  return {
    id: r.id,
    type: r.type,
    name: r.name,
    content: r.content,
    proxied: Boolean(r.proxied),
    ttl: r.ttl,
    priority: r.priority ?? null,
    comment: r.comment || null,
    proxiable: Boolean(r.proxiable),
    modifiedOn: r.modified_on || null,
    editable: EDITABLE_DNS_TYPES.includes(r.type),
  };
}

/* ------------------------------------------------------------ Zero Trust */

/**
 * Cloudflare Tunnels, their public hostnames and private networks, and the
 * PCs enrolled with the WARP client. All of it lives on the account, not the
 * zone. A public hostname is two things on Cloudflare: an ingress rule in the
 * tunnel's remote configuration, and a proxied CNAME to <tunnel>.cfargotunnel.com.
 */

const TUNNEL_PERMISSION_MESSAGE = 'This token is not allowed to manage Zero Trust — it needs Cloudflare Tunnel: Edit and Zero Trust: Edit. Connect the account again with a new token.';

function zeroTrustError(err) {
  if (err.status === 403 || err.code === 9109 || err.code === 10000) throw Object.assign(new Error(TUNNEL_PERMISSION_MESSAGE), { permission: true });
  throw err;
}

const zt = (token, path, opts) => cf(token, path, opts).catch(zeroTrustError);

function checkIds(...ids) {
  for (const id of ids) if (!isCfId(id)) throw new Error('That is not a Cloudflare id');
}
const isUuid = (v) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(String(v));
function checkUuid(v, what = 'id') {
  if (!isUuid(v)) throw new Error(`That is not a Cloudflare ${what}`);
}

function tunnelSummary(t) {
  return {
    id: t.id,
    name: t.name,
    status: t.status || 'inactive',
    remoteConfig: Boolean(t.remote_config),
    createdAt: t.created_at || null,
    connsActiveAt: t.conns_active_at || null,
    connections: (t.connections || []).map((c) => ({
      colo: c.colo_name || null,
      originIp: c.origin_ip || null,
      openedAt: c.opened_at || null,
      version: c.client_version || null,
      pending: Boolean(c.is_pending_reconnect),
    })),
  };
}

/** A tunnel's ingress rules without the catch-all, in the shape the UI uses. */
function hostnameRules(config) {
  return (config?.ingress || [])
    .filter((r) => r.hostname)
    .map((r) => ({
      hostname: r.hostname,
      path: r.path || '',
      service: r.service,
      noTLSVerify: Boolean(r.originRequest?.noTLSVerify),
      httpHostHeader: r.originRequest?.httpHostHeader || '',
    }));
}

async function tunnelConfig(token, accountId, tunnelId) {
  const body = await zt(token, `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`);
  return body.result?.config || null;
}

function routeSummary(r) {
  return {
    id: r.id,
    network: r.network,
    tunnelId: r.tunnel_id,
    tunnelName: r.tunnel_name || null,
    comment: r.comment || '',
    virtualNetworkId: r.virtual_network_id || null,
    createdAt: r.created_at || null,
  };
}

function deviceSummary(d) {
  return {
    id: d.id,
    name: d.name || d.device_name || null,
    type: d.device_type || null,
    model: d.model || null,
    osVersion: d.os_version || null,
    version: d.version || null,
    ip: d.ip || null,
    serial: d.serial_number || null,
    user: d.user ? { email: d.user.email || null, name: d.user.name || null } : null,
    lastSeen: d.last_seen || null,
    created: d.created || null,
    revoked: Boolean(d.revoked_at || d.deleted),
  };
}

/**
 * Everything Zero Trust on one account: tunnels with their public hostnames,
 * private network routes and enrolled devices. Each part may fail on its own
 * (a narrow token, or Zero Trust not set up yet) without hiding the others.
 */
export async function getZeroTrust(token, accountId) {
  checkIds(accountId);
  const [tunnelList0, routes0, devices, team, vnets] = await Promise.all([
    optional(cfList(token, `/accounts/${accountId}/cfd_tunnel?is_deleted=false`).catch(zeroTrustError)),
    optional(cfList(token, `/accounts/${accountId}/teamnet/routes?is_deleted=false`).catch(zeroTrustError)),
    optional(cfList(token, `/accounts/${accountId}/devices`, 1000).catch(zeroTrustError)),
    optional(getTeamDomain(token, accountId)),
    optional(cf(token, `/accounts/${accountId}/teamnet/virtual_networks`)),
  ]);

  // Without Cloudflare Tunnel permission the tunnel and route lists answer
  // 200 with nothing in them rather than refusing, which reads as "no tunnels".
  // Virtual networks do refuse, so they tell the two apart.
  const noTunnelAccess = !vnets.ok && (vnets.err.status === 403 || vnets.err.code === 10000 || vnets.err.code === 9109);
  const denied = { ok: false, err: new Error(TUNNEL_PERMISSION_MESSAGE) };
  const tunnels = noTunnelAccess && tunnelList0.ok && !tunnelList0.v.length ? denied : tunnelList0;
  const routes = noTunnelAccess && routes0.ok && !routes0.v.length ? denied : routes0;

  let tunnelList = null;
  if (tunnels.ok) {
    tunnelList = await Promise.all(tunnels.v.map(async (t) => {
      const s = tunnelSummary(t);
      if (!s.remoteConfig) return { ...s, hostnames: [], warpRouting: false };
      const config = await tunnelConfig(token, accountId, t.id).catch(() => null);
      return { ...s, hostnames: hostnameRules(config), warpRouting: Boolean(config?.['warp-routing']?.enabled) };
    }));
  }

  return {
    tunnels: tunnelList,
    tunnelsError: tunnels.ok ? null : tunnels.err.message,
    routes: routes.ok ? routes.v.map(routeSummary) : null,
    routesError: routes.ok ? null : routes.err.message,
    devices: devices.ok ? devices.v.map(deviceSummary).filter((d) => !d.revoked) : null,
    devicesError: devices.ok ? null : devices.err.message,
    // null with no error means Zero Trust has not been set up on this account yet.
    team: team.ok ? team.v : null,
    teamError: team.ok ? null : team.err.message,
    // The token was made without the Zero Trust permissions; reconnecting fixes it.
    needsReconnect: noTunnelAccess || (!devices.ok && Boolean(devices.err.permission)),
  };
}

/* --- team domain (<team>.cloudflareaccess.com) */

function teamSummary(o) {
  return {
    name: o.name || null,
    authDomain: o.auth_domain || null,
    teamName: String(o.auth_domain || '').replace(/\.cloudflareaccess\.com$/, '') || null,
    createdAt: o.created_at || null,
  };
}

function teamError(err) {
  if (err.status === 403 || err.code === 9109 || err.code === 10000) {
    throw new Error('This token cannot read the Zero Trust team domain — it needs Access: Organizations, Identity Providers, and Groups (add it to the token in the Cloudflare dashboard).');
  }
  throw err;
}

/** The account's Zero Trust organisation, or null when none is set up yet. */
export async function getTeamDomain(token, accountId) {
  checkIds(accountId);
  try {
    const o = (await cf(token, `/accounts/${accountId}/access/organizations`)).result;
    return o && o.auth_domain ? teamSummary(o) : null;
  } catch (err) {
    if (err.status === 404) return null;
    return teamError(err);
  }
}

/** Set up Zero Trust on the account with a team domain, <teamName>.cloudflareaccess.com. */
export async function createTeamDomain(token, accountId, teamName, displayName) {
  checkIds(accountId);
  const team = String(teamName || '').trim().toLowerCase().replace(/\.cloudflareaccess\.com$/, '');
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(team)) {
    throw new Error('A team name is letters, digits and "-", like my-company');
  }
  if (await getTeamDomain(token, accountId)) throw new Error('This account already has a Zero Trust team domain.');
  const payload = { name: String(displayName || '').trim() || team, auth_domain: `${team}.cloudflareaccess.com` };
  const body = await cf(token, `/accounts/${accountId}/access/organizations`, { method: 'POST', payload }).catch((err) => {
    if (err.code === 12130 || /taken|exists|in use/i.test(err.message)) throw new Error(`${team}.cloudflareaccess.com is already taken — pick another team name.`);
    return teamError(err);
  });
  return teamSummary(body.result);
}

/* --- tunnels */

export async function createTunnel(token, accountId, name) {
  checkIds(accountId);
  const n = String(name || '').trim();
  if (!/^[A-Za-z0-9 _.-]{1,64}$/.test(n)) throw new Error('A tunnel name is 1–64 letters, digits, spaces, "-", "_" or "."');
  const body = await zt(token, `/accounts/${accountId}/cfd_tunnel`, { method: 'POST', payload: { name: n, config_src: 'cloudflare' } });
  const t = body.result;
  // Start with an empty remote configuration so hostnames can be added straight away.
  await zt(token, `/accounts/${accountId}/cfd_tunnel/${t.id}/configurations`, {
    method: 'PUT', payload: { config: { ingress: [{ service: 'http_status:404' }] } },
  });
  return { ...tunnelSummary(t), hostnames: [], warpRouting: false };
}

/** The token cloudflared runs the tunnel with — a secret. */
export async function getTunnelToken(token, accountId, tunnelId) {
  checkIds(accountId);
  checkUuid(tunnelId, 'tunnel id');
  return (await zt(token, `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`)).result;
}

/** Delete a tunnel, its public hostnames' DNS records and its private network routes. */
export async function deleteTunnel(token, accountId, tunnelId, zones) {
  checkIds(accountId);
  checkUuid(tunnelId, 'tunnel id');
  const config = await tunnelConfig(token, accountId, tunnelId).catch(() => null);
  for (const host of new Set(hostnameRules(config).map((r) => r.hostname))) {
    await removeTunnelCname(token, zones, host, tunnelId).catch(() => {});
  }
  const routes = await cfList(token, `/accounts/${accountId}/teamnet/routes?is_deleted=false&tunnel_id=${tunnelId}`).catch(() => []);
  for (const r of routes) await zt(token, `/accounts/${accountId}/teamnet/routes/${r.id}`, { method: 'DELETE' }).catch(() => {});
  // A tunnel with live connections cannot be deleted; drop them first.
  await zt(token, `/accounts/${accountId}/cfd_tunnel/${tunnelId}/connections`, { method: 'DELETE' }).catch(() => {});
  await zt(token, `/accounts/${accountId}/cfd_tunnel/${tunnelId}`, { method: 'DELETE' });
  return { id: tunnelId };
}

/* --- public hostnames */

export const SERVICE_TYPES = ['http', 'https', 'ssh', 'rdp', 'tcp', 'smb', 'unix', 'http_status'];

/**
 * Check a public hostname from the form. `service` is either whole
 * ("http://localhost:8080") or built from `serviceType` + `serviceUrl`.
 */
export function buildHostnameRule(input) {
  const hostname = String(input.hostname || '').trim().toLowerCase().replace(/\.+$/, '');
  if (!/^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(hostname)) {
    throw new Error('The hostname must be a full name, like app.example.com');
  }
  const path = String(input.path || '').trim();
  if (/\s/.test(path)) throw new Error('The path may not contain spaces');

  let service = String(input.service || '').trim();
  if (!service) {
    const type = String(input.serviceType || '').toLowerCase();
    const url = String(input.serviceUrl || '').trim().replace(/^[a-z_+]+:\/\//i, '');
    if (!SERVICE_TYPES.includes(type)) throw new Error(`Service type must be one of ${SERVICE_TYPES.join(', ')}`);
    if (!url) throw new Error('The service URL is required, like localhost:8080');
    service = type === 'http_status' ? `http_status:${url}` : type === 'unix' ? `unix:${url}` : `${type}://${url}`;
  }
  if (!/^((https?|ssh|rdp|tcp|smb):\/\/\S+|unix(\+tls)?:\S+|http_status:\d{3}|hello_world)$/.test(service)) {
    throw new Error('The service must look like http://localhost:8080, ssh://localhost:22 or rdp://localhost:3389');
  }

  const originRequest = {};
  if (input.noTLSVerify === true || input.noTLSVerify === 'true' || input.noTLSVerify === 'on') originRequest.noTLSVerify = true;
  const hostHeader = String(input.httpHostHeader || '').trim();
  if (hostHeader) originRequest.httpHostHeader = hostHeader;

  return { hostname, ...(path ? { path } : {}), service, ...(Object.keys(originRequest).length ? { originRequest } : {}) };
}

/** The zone a hostname belongs to: the longest zone name it ends with. */
export function zoneFor(zones, hostname) {
  const bare = hostname.replace(/^\*\./, '');
  return (zones || [])
    .filter((z) => bare === z.name || bare.endsWith(`.${z.name}`))
    .sort((a, b) => b.name.length - a.name.length)[0] || null;
}

/** The A, AAAA and CNAME records with exactly this name. */
export async function recordsNamed(token, zoneId, name) {
  const body = await cf(token, `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`);
  return (body.result || []).filter((r) => ['A', 'AAAA', 'CNAME'].includes(r.type));
}

/**
 * The zone's SSL mode: off, flexible, full or strict. Flexible matters to
 * anything that redirects to HTTPS at the origin — proxied, it loops.
 */
export async function getZoneSslMode(token, zoneId) {
  if (!isCfId(zoneId)) throw new Error('That is not a Cloudflare zone id');
  return (await cf(token, `/zones/${zoneId}/settings/ssl`)).result?.value || null;
}

/** Point a hostname at a tunnel, unless something else already answers for it. */
export async function ensureTunnelCname(token, zones, hostname, tunnelId) {
  const zone = zoneFor(zones, hostname);
  if (!zone) throw new Error(`${hostname} is not under any domain on this Cloudflare account`);
  const target = `${tunnelId}.cfargotunnel.com`;
  const existing = await recordsNamed(token, zone.id, hostname).catch(dnsWriteError);
  if (existing.some((r) => r.type === 'CNAME' && r.content === target)) return;
  if (existing.length) {
    const r = existing[0];
    throw new Error(`${hostname} already has a ${r.type} record (→ ${r.content}). Delete or rename it under DNS first.`);
  }
  await createDnsRecord(token, zone.id, { type: 'CNAME', name: hostname, content: target, proxied: true, ttl: 1, comment: 'Cloudflare Tunnel (AJ Pilot)' });
}

/** Remove the CNAME for a hostname, but only if it points at this tunnel. */
async function removeTunnelCname(token, zones, hostname, tunnelId) {
  const zone = zoneFor(zones, hostname);
  if (!zone) return;
  const target = `${tunnelId}.cfargotunnel.com`;
  for (const r of await recordsNamed(token, zone.id, hostname)) {
    if (r.type === 'CNAME' && r.content === target) await deleteDnsRecord(token, zone.id, r.id);
  }
}

const sameRule = (r, hostname, path) => r.hostname === hostname && (r.path || '') === (path || '');

async function writeIngress(token, accountId, tunnelId, change) {
  const config = (await tunnelConfig(token, accountId, tunnelId)) || {};
  const rules = (config.ingress || []).filter((r) => r.hostname);
  const catchAll = (config.ingress || []).find((r) => !r.hostname) || { service: 'http_status:404' };
  const next = change(rules);
  await zt(token, `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
    method: 'PUT', payload: { config: { ...config, ingress: [...next, catchAll] } },
  });
  return hostnameRules({ ingress: next });
}

/** Add a public hostname: an ingress rule plus its DNS record. */
export async function addPublicHostname(token, accountId, tunnelId, rule, zones) {
  checkIds(accountId);
  checkUuid(tunnelId, 'tunnel id');
  await ensureTunnelCname(token, zones, rule.hostname, tunnelId);
  return writeIngress(token, accountId, tunnelId, (rules) => {
    if (rules.some((r) => sameRule(r, rule.hostname, rule.path))) {
      throw new Error(`${rule.hostname}${rule.path ? ` (path ${rule.path})` : ''} is already on this tunnel`);
    }
    return [...rules, rule];
  });
}

/** Change a public hostname, moving its DNS record when the name changes. */
export async function updatePublicHostname(token, accountId, tunnelId, original, rule, zones) {
  checkIds(accountId);
  checkUuid(tunnelId, 'tunnel id');
  const oldHost = String(original?.hostname || '').toLowerCase();
  const oldPath = String(original?.path || '');
  if (rule.hostname !== oldHost) await ensureTunnelCname(token, zones, rule.hostname, tunnelId);

  const result = await writeIngress(token, accountId, tunnelId, (rules) => {
    const i = rules.findIndex((r) => sameRule(r, oldHost, oldPath));
    if (i < 0) throw new Error(`${oldHost} is no longer on this tunnel — refresh and try again.`);
    if (rules.some((r, j) => j !== i && sameRule(r, rule.hostname, rule.path))) {
      throw new Error(`${rule.hostname}${rule.path ? ` (path ${rule.path})` : ''} is already on this tunnel`);
    }
    // Keep origin options the form does not show.
    const { noTLSVerify, httpHostHeader, ...kept } = rules[i].originRequest || {};
    const originRequest = { ...kept, ...(rule.originRequest || {}) };
    const next = [...rules];
    next[i] = { ...rule, ...(Object.keys(originRequest).length ? { originRequest } : {}) };
    return next;
  });

  if (rule.hostname !== oldHost && !result.some((r) => r.hostname === oldHost)) {
    await removeTunnelCname(token, zones, oldHost, tunnelId).catch(() => {});
  }
  return result;
}

/** Remove a public hostname, and its DNS record once no rule uses the name. */
export async function deletePublicHostname(token, accountId, tunnelId, hostname, path, zones) {
  checkIds(accountId);
  checkUuid(tunnelId, 'tunnel id');
  const host = String(hostname || '').toLowerCase();
  const result = await writeIngress(token, accountId, tunnelId, (rules) => {
    if (!rules.some((r) => sameRule(r, host, path))) throw new Error(`${host} is no longer on this tunnel — refresh and try again.`);
    return rules.filter((r) => !sameRule(r, host, path));
  });
  if (!result.some((r) => r.hostname === host)) await removeTunnelCname(token, zones, host, tunnelId).catch(() => {});
  return result;
}

/* --- private networks (reached from PCs running WARP) */

function checkCidr(network) {
  const n = String(network || '').trim();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(n);
  if (v4) {
    if (v4.slice(1, 5).some((o) => Number(o) > 255) || Number(v4[5]) > 32) throw new Error('That is not a valid IPv4 range');
    return n;
  }
  if (/^[0-9a-f:]+\/\d{1,3}$/i.test(n) && Number(n.split('/')[1]) <= 128) return n;
  // A single address is a /32 (or /128).
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(n)) return `${n}/32`;
  if (/^[0-9a-f:]+$/i.test(n) && n.includes(':')) return `${n}/128`;
  throw new Error('The network must be a CIDR range, like 10.0.0.0/24, or a single IP');
}

/** Routing private networks through a tunnel needs WARP routing on in its configuration. */
async function enableWarpRouting(token, accountId, tunnelId) {
  const config = (await tunnelConfig(token, accountId, tunnelId).catch(() => null));
  if (!config || config['warp-routing']?.enabled) return;
  await zt(token, `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
    method: 'PUT', payload: { config: { ...config, 'warp-routing': { enabled: true } } },
  });
}

export async function createPrivateRoute(token, accountId, input) {
  checkIds(accountId);
  checkUuid(input.tunnelId, 'tunnel id');
  const payload = { network: checkCidr(input.network), tunnel_id: input.tunnelId, comment: String(input.comment || '').trim().slice(0, 100) };
  const route = routeSummary((await zt(token, `/accounts/${accountId}/teamnet/routes`, { method: 'POST', payload })).result);
  await enableWarpRouting(token, accountId, input.tunnelId);
  return route;
}

export async function updatePrivateRoute(token, accountId, routeId, input) {
  checkIds(accountId);
  checkUuid(routeId, 'route id');
  checkUuid(input.tunnelId, 'tunnel id');
  const payload = { network: checkCidr(input.network), tunnel_id: input.tunnelId, comment: String(input.comment || '').trim().slice(0, 100) };
  const route = routeSummary((await zt(token, `/accounts/${accountId}/teamnet/routes/${routeId}`, { method: 'PATCH', payload })).result);
  await enableWarpRouting(token, accountId, input.tunnelId);
  return route;
}

export async function deletePrivateRoute(token, accountId, routeId) {
  checkIds(accountId);
  checkUuid(routeId, 'route id');
  await zt(token, `/accounts/${accountId}/teamnet/routes/${routeId}`, { method: 'DELETE' });
  return { id: routeId };
}

/* --- devices (PCs enrolled with WARP) */

/** Revoke a device: it is signed out of Zero Trust and must enrol again. */
export async function revokeDevice(token, accountId, deviceId) {
  checkIds(accountId);
  checkUuid(deviceId, 'device id');
  await zt(token, `/accounts/${accountId}/devices/revoke`, { method: 'POST', payload: [deviceId] });
  return { id: deviceId };
}
