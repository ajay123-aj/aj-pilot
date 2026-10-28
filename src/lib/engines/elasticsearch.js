import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { withTunnel } from '../tunnel.js';
import {
  stat, kv, table, num, badge, code, small, link, field, bytes, count, percent, text,
  checkPassword, checkConfirm,
} from './shape.js';

export const label = 'Elasticsearch';

/*
 * Elasticsearch speaks HTTP, so there is no driver: each call is one REST
 * request, sent through the same SSH tunnel the other engines use. "Databases"
 * on the shared page are indices, an "item" is a field of an index, users are
 * security users and grants are roles.
 */

const MAX_RESPONSE = 20 * 1024 * 1024;
const TIMEOUT_MS = 20000;

/** Index names as Elasticsearch allows them; a leading "." is a system or hidden index. */
const INDEX_RE = /^[a-z0-9._+-][a-z0-9_.+-]{0,254}$/;
const NEW_INDEX_RE = /^[a-z0-9][a-z0-9_.+-]{0,254}$/;
/** An index pattern for a role: names, wildcards and commas. */
const PATTERN_RE = /^[a-z0-9.*_+-][a-z0-9_.*+,-]{0,199}$/;
const USER_RE = /^[A-Za-z0-9_.@-]{1,64}$/;
const ROLE_RE = /^[A-Za-z0-9_.@-]{1,100}$/;

/** Index access the panel can grant by making a role for it. */
const ACCESS = {
  read: { label: 'Read on an index pattern', privileges: ['read', 'view_index_metadata'] },
  write: { label: 'Read and write on an index pattern', privileges: ['read', 'write', 'view_index_metadata', 'create_index'] },
  all: { label: 'Full control of an index pattern', privileges: ['all'] },
};

const NUMERIC_TYPES = new Set(['long', 'integer', 'short', 'byte', 'double', 'float', 'half_float', 'scaled_float', 'unsigned_long', 'date', 'date_nanos']);
const HEALTH_TONE = { green: 'ok', yellow: 'warn', red: 'err' };

/* ------------------------------------------------------------ connecting */

/** Where to connect. The host may be a full URL (https://…:9243), which sets TLS and the port. */
function target(cfg) {
  let host = String(cfg.host || '127.0.0.1').trim();
  let port = Number(cfg.port) || 9200;
  let tls = Boolean(cfg.tls);
  if (/^https?:\/\//i.test(host)) {
    const u = new URL(host);
    tls = u.protocol === 'https:';
    host = u.hostname.replace(/^\[|\]$/g, '');
    if (u.port) port = Number(u.port);
  }
  return {
    host,
    port,
    tls,
    hostHeader: `${host.includes(':') ? `[${host}]` : host}:${port}`,
    // A password on its own means the built-in superuser.
    user: cfg.user || (cfg.password ? 'elastic' : ''),
    password: cfg.password || '',
  };
}

function esError(status, data) {
  const reason = data?.error?.root_cause?.[0]?.reason || data?.error?.reason
    || (typeof data?.error === 'string' ? data.error : '') || (typeof data === 'string' ? data.slice(0, 300) : '');
  let message = reason || `Elasticsearch answered HTTP ${status}`;
  if (status === 401) message = 'Authentication failed — check the username and password (usually "elastic", or both empty if security is off).';
  else if (status === 403) message = `This user is not allowed to do that: ${reason}`;
  const e = new Error(message);
  e.status = status;
  e.esType = data?.error?.type || null;
  return e;
}

/** One REST call over an address withTunnel handed out. */
function send(addr, t, method, path, body, contentType = 'application/json') {
  const payload = body === undefined || body === null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const headers = { Accept: 'application/json', Host: t.hostHeader };
  if (payload) Object.assign(headers, { 'Content-Type': contentType, 'Content-Length': payload.length });
  if (t.user) headers.Authorization = `Basic ${Buffer.from(`${t.user}:${t.password}`).toString('base64')}`;
  const servername = addr.servername || (net.isIP(t.host) ? undefined : t.host);

  return new Promise((resolve, reject) => {
    const req = (t.tls ? https : http).request({
      host: addr.host,
      port: addr.port,
      method,
      path,
      headers,
      // No pooling: the tunnel's port is gone once this call's withTunnel ends.
      agent: false,
      ...(t.tls ? { rejectUnauthorized: false, servername } : {}),
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_RESPONSE) {
          req.destroy(new Error('The answer was larger than 20 MB — ask for less (a smaller size or fewer fields)'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = raw;
        try { data = raw ? JSON.parse(raw) : null; } catch { /* a plain-text answer */ }
        if (res.statusCode >= 400) reject(esError(res.statusCode, data));
        else resolve(data);
      });
      res.on('error', reject);
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error(`Elasticsearch did not answer within ${TIMEOUT_MS / 1000}s`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function friendly(err) {
  if (err?.status) return err;
  const msg = String(err?.message || err);
  const map = [
    // Refused and timed out read the same, so the test form is no use for probing which ports are open.
    [/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT/i, 'Could not reach Elasticsearch on that host and port. It may listen on localhost only — tie this connection to a server so the panel tunnels over SSH.', true],
    [/ENOTFOUND|EAI_AGAIN/i, 'Host not found — the hostname could not be resolved.'],
    [/EPROTO|wrong version number|packet length too long/i, 'TLS is ticked but this port answers plain HTTP — untick TLS.'],
    [/ECONNRESET|socket hang up|Parse Error|HPE_/i, 'The connection was dropped. If the cluster uses HTTPS (Elasticsearch 8 does unless told otherwise), tick TLS.'],
  ];
  for (const [re, nice, hideCause] of map) {
    if (re.test(msg) && !/^SSH tunnel failed/.test(msg)) {
      const e = new Error(nice);
      if (!hideCause) e.cause = msg;
      return e;
    }
  }
  return err instanceof Error ? err : new Error(msg);
}

/** Run `fn(es)` where `es(method, path, body?, contentType?)` is one REST call. */
async function withEs(cfg, fn) {
  const t = target(cfg);
  try {
    return await withTunnel(cfg.server, t.host, t.port, (addr) => fn((method, path, body, type) => send(addr, t, method, path, body, type)));
  } catch (err) {
    throw friendly(err);
  }
}

const maybe = async (p) => { try { return await p; } catch { return null; } };
const enc = encodeURIComponent;

function checkIndex(name) {
  const n = String(name || '');
  if (!INDEX_RE.test(n) || n === '.' || n === '..') throw new Error('Unknown index');
  return n;
}

const isSystem = (name) => String(name).startsWith('.');
const healthBadge = (h) => badge(h || '—', HEALTH_TONE[h] || '');

/** A mapping's properties as flat dotted paths, multi-fields included. */
function flattenFields(props, prefix = '', out = []) {
  for (const [name, def] of Object.entries(props || {})) {
    const path = prefix ? `${prefix}.${name}` : name;
    const type = def.type || (def.properties ? 'object' : 'object');
    out.push({ path, type, def });
    if (def.properties) flattenFields(def.properties, path, out);
    for (const [sub, subDef] of Object.entries(def.fields || {})) out.push({ path: `${path}.${sub}`, type: subDef.type, def: subDef, multi: true });
  }
  return out;
}

function fieldDetails(f) {
  const d = f.def || {};
  return [
    f.multi && 'multi-field',
    d.analyzer && `analyzer ${d.analyzer}`,
    d.format && `format ${d.format}`,
    d.index === false && 'not indexed',
    d.enabled === false && 'not parsed',
    d.ignore_above && `ignore above ${d.ignore_above}`,
    d.dims && `${d.dims} dims`,
  ].filter(Boolean).join(', ') || '—';
}

/* ------------------------------------------------------------- reading */

export async function test(cfg) {
  const started = Date.now();
  return withEs(cfg, async (es) => {
    // A user with only index privileges may not read "/" (cluster:monitor/main);
    // it signed in fine, so that is a working connection, just without a version.
    const root = await es('GET', '/').catch((err) => { if (err.status === 403) return null; throw err; });
    const me = await maybe(es('GET', '/_security/_authenticate'));
    return {
      version: root ? `Elasticsearch ${root.version?.number || '?'}` : 'Elasticsearch (this user cannot read the version)',
      cluster: root?.cluster_name || null,
      currentUser: me?.username || (target(cfg).user || 'anonymous — security is off'),
      latencyMs: Date.now() - started,
    };
  });
}

export async function overview(cfg) {
  const started = Date.now();
  return withEs(cfg, async (es) => {
    const [root, health, cs, nodes, me, users] = await Promise.all([
      es('GET', '/'),
      es('GET', '/_cluster/health'),
      maybe(es('GET', '/_cluster/stats')),
      maybe(es('GET', '/_cat/nodes?format=json&bytes=b&h=name,ip,node.role,master,heap.percent,ram.percent,cpu,load_1m,disk.used_percent,disk.total,version,uptime')),
      maybe(es('GET', '/_security/_authenticate')),
      maybe(es('GET', '/_security/user')),
    ]);
    const v = root.version || {};
    const ix = cs?.indices || {};
    const jvm = cs?.nodes?.jvm?.mem || {};
    const fs = cs?.nodes?.fs || {};
    const diskUsed = Number(fs.total_in_bytes || 0) - Number(fs.available_in_bytes || 0);
    const userCount = users ? Object.keys(users).length : null;

    return {
      durationMs: Date.now() - started,
      counts: { databases: ix.count ?? null, users: userCount },
      stats: [
        stat('Version', `Elasticsearch ${v.number}`, `Lucene ${v.lucene_version || '—'}${v.build_flavor ? ` · ${v.build_flavor}` : ''}`),
        stat('Health', health.status, `${health.number_of_nodes} node(s) · ${health.number_of_data_nodes} data`),
        stat('Indices', count(ix.count), `${count(ix.docs?.count)} documents`),
        stat('Size', bytes(ix.store?.size_in_bytes), `${count(ix.shards?.total)} shards incl. replicas`),
        stat('Shards', count(health.active_shards), `${health.unassigned_shards} unassigned · ${health.relocating_shards} relocating`),
        stat('JVM heap', bytes(jvm.heap_used_in_bytes), jvm.heap_max_in_bytes ? `of ${bytes(jvm.heap_max_in_bytes)}` : '', percent(jvm.heap_used_in_bytes, jvm.heap_max_in_bytes)),
        stat('Disk', bytes(diskUsed), fs.total_in_bytes ? `of ${bytes(fs.total_in_bytes)} on data paths` : '', percent(diskUsed, fs.total_in_bytes)),
        stat('Users', userCount ?? '—', userCount !== null ? `security users${me?.username ? ` · you are ${me.username}` : ''}` : 'security is off, or this user cannot list users'),
        stat('Pending tasks', count(health.number_of_pending_tasks), `${count(health.number_of_in_flight_fetch)} shard fetches in flight`),
      ],
      info: [
        kv('Cluster', [
          ['Name', text(root.cluster_name)],
          ['UUID', small(text(root.cluster_uuid))],
          ['Version', text(v.number)],
          ['Lucene', text(v.lucene_version)],
          ['Build', small(`${v.build_flavor || '—'} · ${v.build_type || '—'} · ${v.build_date || '—'}`)],
        ]),
        kv('Health', [
          ['Status', healthBadge(health.status)],
          ['Active primary shards', count(health.active_primary_shards)],
          ['Active shards', count(health.active_shards)],
          ['Initializing', count(health.initializing_shards)],
          ['Unassigned', count(health.unassigned_shards)],
          ['Delayed unassigned', count(health.delayed_unassigned_shards)],
        ]),
      ],
      tables: [
        table('Nodes', ['Name', 'IP', 'Roles', 'Master', num('Heap'), num('RAM'), num('CPU'), num('Load 1m'), num('Disk'), 'Version', 'Uptime'],
          (nodes || []).map((n) => [
            text(n.name), small(text(n.ip)), code(text(n['node.role'])), n.master === '*' ? badge('elected', 'ok') : '—',
            `${n['heap.percent']}%`, `${n['ram.percent']}%`, `${n.cpu}%`, text(n.load_1m), n['disk.used_percent'] ? `${n['disk.used_percent']}% of ${bytes(n['disk.total'])}` : '—',
            text(n.version), text(n.uptime),
          ]), 'This user cannot list nodes'),
      ],
    };
  });
}

export async function databases(cfg) {
  return withEs(cfg, async (es) => {
    const list = await es('GET', '/_cat/indices?format=json&bytes=b&expand_wildcards=all&s=index'
      + '&h=health,status,index,pri,rep,docs.count,docs.deleted,store.size,pri.store.size');
    const user = list.filter((i) => !isSystem(i.index));
    const sum = (k) => list.reduce((n, i) => n + Number(i[k] || 0), 0);
    const byHealth = (h) => user.filter((i) => i.health === h).length;

    return {
      stats: [
        stat('Indices', user.length, `${list.length - user.length} system or hidden`),
        stat('Documents', count(sum('docs.count')), `${count(sum('docs.deleted'))} deleted, not yet merged away`),
        stat('Size', bytes(sum('store.size')), `${bytes(sum('pri.store.size'))} primaries`),
        stat('Health', `${byHealth('green')} green`, `${byHealth('yellow')} yellow · ${byHealth('red')} red`),
      ],
      columns: ['Index', 'Health', 'Status', num('Documents'), num('Deleted'), num('Size'), num('Primaries'), num('Replicas')],
      rows: list.map((i) => ({
        name: i.index,
        system: isSystem(i.index),
        cells: [
          link(i.index, { database: i.index }), healthBadge(i.health), text(i.status), count(i['docs.count']),
          count(i['docs.deleted']), bytes(i['store.size']), count(i.pri), count(i.rep),
        ],
      })),
      caps: {
        create: true,
        drop: true,
        dropLabel: 'Delete',
        dropNote: 'Deleting an index removes every document in it, on every node. There is no undo — take a snapshot first if you might need it.',
        createNote: 'Field mappings are made the first time a document is written. On a single node keep replicas at 0, or the index stays yellow.',
        createFields: [
          field('name', 'Name', { required: true, placeholder: 'orders', hint: 'Lowercase letters, digits, "-", "_", "." and "+"; cannot start with "-", "_" or "+".' }),
          field('shards', 'Primary shards', { type: 'number', default: 1, hint: 'Fixed once the index exists. One is right for anything under ~30 GB.' }),
          field('replicas', 'Replicas', { type: 'number', default: 0, hint: 'Copies of each shard on other nodes. Can be changed later.' }),
        ],
      },
    };
  });
}

export async function database(cfg, name) {
  const index = checkIndex(name);
  return withEs(cfg, async (es) => {
    const [st, settingsRes, mappingRes, aliasRes, health, sample] = await Promise.all([
      es('GET', `/${enc(index)}/_stats/docs,store`),
      es('GET', `/${enc(index)}/_settings?flat_settings=true`),
      es('GET', `/${enc(index)}/_mapping`),
      maybe(es('GET', `/${enc(index)}/_alias`)),
      maybe(es('GET', `/_cluster/health/${enc(index)}`)),
      maybe(es('POST', `/${enc(index)}/_search`, { size: 20, sort: ['_doc'] })),
    ]);
    // Keyed by the concrete index, which differs from `name` when name is an alias.
    const settings = Object.values(settingsRes)[0]?.settings || {};
    const mappings = Object.values(mappingRes)[0]?.mappings || {};
    const aliases = Object.values(aliasRes || {})[0]?.aliases || {};
    const fields = flattenFields(mappings.properties);
    const pri = st._all?.primaries || {};
    const tot = st._all?.total || {};
    const created = Number(settings['index.creation_date']);

    const hits = sample?.hits?.hits || [];
    const docCols = [...new Set(hits.flatMap((h) => Object.keys(h._source || {})))].slice(0, 8);

    return {
      title: index,
      stats: [
        stat('Documents', count(pri.docs?.count), `${count(pri.docs?.deleted)} deleted`),
        stat('Size', bytes(tot.store?.size_in_bytes), `${bytes(pri.store?.size_in_bytes)} primaries`),
        stat('Shards', `${settings['index.number_of_shards'] || '—'} primary`, `${settings['index.number_of_replicas'] ?? '—'} replica(s) each`),
        stat('Health', health?.status || '—', health ? `${health.active_shards} active · ${health.unassigned_shards} unassigned` : ''),
        stat('Fields', fields.length, `${fields.filter((f) => f.type === 'text').length} text · ${fields.filter((f) => f.type === 'keyword').length} keyword`),
        stat('Created', created ? new Date(created).toISOString().slice(0, 10) : '—', settings['index.version.created'] ? `index version ${settings['index.version.created']}` : ''),
      ],
      tables: [
        table('Fields', ['Field', 'Type', 'Details'],
          fields.slice(0, 500).map((f) => [
            f.type === 'object' || f.type === 'nested' ? f.path : link(f.path, { database: index, item: f.path }), code(f.type), small(fieldDetails(f)),
          ]), 'No fields yet — they are mapped when the first document is written'),
        table(`First ${hits.length} documents`, ['_id', ...docCols],
          hits.map((h) => [code(h._id), ...docCols.map((c) => text(h._source?.[c], 120))]), 'This index is empty'),
        table('Aliases', ['Alias', 'Write index', 'Filter'],
          Object.entries(aliases).map(([a, d]) => [a, d.is_write_index ? badge('yes', 'ok') : '—', d.filter ? code(text(d.filter, 200)) : '—']), 'No aliases'),
        table('Settings', ['Setting', 'Value'],
          Object.entries(settings).sort(([a], [b]) => a.localeCompare(b)).map(([k, val]) => [code(k), text(val)])),
      ],
    };
  });
}

/** One field of an index: how many documents have it and its most common values. */
export async function item(cfg, database, fieldName) {
  const index = checkIndex(database);
  const name = String(fieldName || '');
  if (!name || name.length > 255 || /[\u0000-\u001f]/.test(name)) throw new Error('Unknown field');
  return withEs(cfg, async (es) => {
    const caps = await es('GET', `/${enc(index)}/_field_caps?fields=${enc(name)}`);
    const fc = caps.fields?.[name];
    if (!fc) throw new Error(`"${name}" is not a field of ${index}`);
    const [type, info] = Object.entries(fc)[0];
    const numeric = NUMERIC_TYPES.has(type);

    const [total, withField, aggs, mapping] = await Promise.all([
      es('POST', `/${enc(index)}/_count`, {}),
      maybe(es('POST', `/${enc(index)}/_count`, { query: { exists: { field: name } } })),
      info.aggregatable ? maybe(es('POST', `/${enc(index)}/_search`, {
        size: 0,
        aggs: {
          top: { terms: { field: name, size: 20 } },
          distinct: { cardinality: { field: name } },
          ...(numeric ? { range: { stats: { field: name } } } : {}),
        },
      })) : null,
      maybe(es('GET', `/${enc(index)}/_mapping/field/${enc(name)}`)),
    ]);
    const a = aggs?.aggregations || {};
    const buckets = a.top?.buckets || [];
    const have = withField?.count ?? null;

    return {
      title: `${index} › ${name}`,
      stats: [
        stat('Type', type, [info.searchable && 'searchable', info.aggregatable && 'aggregatable'].filter(Boolean).join(' · ') || 'stored only'),
        stat('Documents with it', count(have), `of ${count(total.count)}`, have !== null ? percent(have, total.count) : null),
        stat('Distinct values', a.distinct ? `≈ ${count(a.distinct.value)}` : '—', a.distinct ? 'approximate' : 'not aggregatable'),
        ...(a.range ? [stat('Range', `${a.range.min_as_string ?? text(a.range.min)} → ${a.range.max_as_string ?? text(a.range.max)}`, !type.startsWith('date') && a.range.avg != null ? `average ${text(Math.round(a.range.avg * 100) / 100)}` : '')] : []),
      ],
      tables: [
        table('Most common values', ['Value', num('Documents'), num('Share')],
          buckets.map((b) => [code(text(b.key_as_string ?? b.key, 200)), count(b.doc_count), have ? `${percent(b.doc_count, have)}%` : '—']),
          info.aggregatable ? 'No values' : 'Text fields are analysed, so they have no top values — open its .keyword sub-field if it has one'),
      ],
      pre: { title: 'Mapping', text: JSON.stringify(Object.values(mapping || {})[0]?.mappings || fc, null, 2) },
    };
  });
}

/* ------------------------------------------------------------- users */

function securityOff(err) {
  const msg = String(err?.message || '');
  // With security off the /_security endpoints are not registered at all, so a GET reads as a wrong method.
  if (/security.*(disabled|not enabled|explicitly enabled)|xpack\.security|(Incorrect HTTP method|no handler found) for uri \[\/_security/i.test(msg)) {
    return new Error('Security is turned off on this cluster (xpack.security.enabled: false), so it has no users — anyone who can reach the port can do anything.');
  }
  return err;
}

const accessOptions = () => Object.entries(ACCESS).map(([k, a]) => ({ value: `@${k}`, label: a.label }));

export async function users(cfg) {
  return withEs(cfg, async (es) => {
    const list = await es('GET', '/_security/user').catch((err) => { throw securityOff(err); });
    const roles = Object.keys((await maybe(es('GET', '/_security/role'))) || {}).sort();
    const me = (await maybe(es('GET', '/_security/_authenticate')))?.username || null;
    const entries = Object.entries(list);
    const roleOptions = [...accessOptions(), ...roles.map((r) => ({ value: r, label: r }))];

    return {
      currentUser: me || '(unknown)',
      note: 'Users hold roles; a role says which indices and cluster actions are allowed. Built-in users such as elastic cannot be deleted. '
        + 'Choosing read / write / full access on an index pattern makes a role named ajp_<access>_<pattern> and gives it to the user.',
      stats: [
        stat('Total users', entries.length, `${entries.filter(([, u]) => u.metadata?._reserved).length} built-in`),
        stat('Enabled', entries.filter(([, u]) => u.enabled).length, 'can sign in'),
        stat('Disabled', entries.filter(([, u]) => !u.enabled).length, 'cannot sign in'),
        stat('Superusers', entries.filter(([, u]) => (u.roles || []).includes('superuser')).length, 'can do everything'),
        stat('Roles', roles.length, 'built-in and custom'),
      ],
      columns: ['User', 'State', 'Roles', 'Kind'],
      users: entries.map(([name, u]) => ({
        key: { user: name },
        label: name,
        self: name === me,
        locked: !u.enabled,
        cells: [
          { text: name },
          u.enabled ? badge('enabled', 'ok') : badge('disabled', 'err'),
          small((u.roles || []).join(', ') || 'none'),
          u.metadata?._reserved ? badge('built-in', '') : 'custom',
        ],
        grants: u.roles || [],
      })),
      caps: {
        lock: true,
        lockLabel: ['Disable', 'Enable'],
        grantFields: [
          field('role', 'Role', { type: 'select', options: roleOptions, default: '@read' }),
          field('database', 'Index pattern', { default: '*', hint: 'Only for the read / write / full choices, e.g. logs-* or orders,customers.' }),
        ],
        revokeFields: [field('role', 'Role to take away', { type: 'select', options: roles.map((r) => ({ value: r, label: r })), required: true })],
        revokeNote: 'Takes one role away from the user. A role the panel made for it stays, in case another user has it.',
        createFields: [
          field('user', 'Username', { required: true, placeholder: 'shop_app' }),
          field('password', 'Password', { type: 'password', required: true }),
          field('role', 'Role', { type: 'select', options: roleOptions, default: '@read' }),
          field('database', 'Index pattern', { default: '*', hint: 'Only for the read / write / full choices.' }),
        ],
        passwordFields: [],
      },
    };
  });
}

function checkUser(name) {
  if (!USER_RE.test(String(name || ''))) throw new Error('Usernames may use letters, digits, "_", ".", "@" and "-"');
  return String(name);
}

/** The role a grant means: an existing one, or one made for an access level on an index pattern. */
async function roleFor(es, role, pattern) {
  const r = String(role || '');
  if (r.startsWith('@')) {
    const access = ACCESS[r.slice(1)];
    if (!access) throw new Error('Pick an access level');
    const p = String(pattern || '*').trim();
    if (!PATTERN_RE.test(p)) throw new Error('Index patterns use lowercase names, "*" and commas, with no spaces');
    const roleName = `ajp_${r.slice(1)}_${p.replace(/\*/g, 'all').replace(/[^a-z0-9]+/g, '_')}`.slice(0, 100);
    await es('PUT', `/_security/role/${enc(roleName)}`, { indices: [{ names: p.split(','), privileges: access.privileges }] });
    return roleName;
  }
  if (!ROLE_RE.test(r)) throw new Error('Pick a role');
  return r;
}

async function getUser(es, user) {
  const res = await es('GET', `/_security/user/${enc(user)}`).catch((err) => {
    if (err.status === 404) throw new Error(`User "${user}" does not exist`);
    throw securityOff(err);
  });
  return res[user];
}

const whoAmI = async (es) => (await maybe(es('GET', '/_security/_authenticate')))?.username || null;

/** Replace a user's roles, keeping everything else (and the password, which PUT without one leaves alone). */
const putRoles = (es, user, u, roles) => es('PUT', `/_security/user/${enc(user)}`, {
  roles, full_name: u.full_name || undefined, email: u.email || undefined, metadata: u.metadata || {}, enabled: u.enabled,
});

export async function createUser(cfg, body) {
  const user = checkUser(body.user);
  const password = checkPassword(body.password);
  return withEs(cfg, async (es) => {
    if (await maybe(getUser(es, user))) throw new Error(`User "${user}" already exists`);
    const roles = body.role ? [await roleFor(es, body.role, body.database)] : [];
    await es('PUT', `/_security/user/${enc(user)}`, { password, roles, enabled: true }).catch((err) => { throw securityOff(err); });
    return { summary: `Created ${user}${roles.length ? ` with role ${roles[0]}` : ''}` };
  });
}

export async function alterUser(cfg, key, body) {
  const user = checkUser(key?.user);
  return withEs(cfg, async (es) => {
    const done = [];
    if (body.password) {
      await es('POST', `/_security/user/${enc(user)}/_password`, { password: checkPassword(body.password) });
      done.push('changed the password');
    }
    if (body.locked !== undefined) {
      if (body.locked && (await whoAmI(es)) === user) throw new Error('The panel is signed in as this user — disabling it would lock the panel out');
      await es('PUT', `/_security/user/${enc(user)}/${body.locked ? '_disable' : '_enable'}`);
      done.push(body.locked ? 'disabled' : 'enabled');
    }
    if (!done.length) throw new Error('Nothing to change');
    return { summary: `${user}: ${done.join(', ')}` };
  });
}

export async function dropUser(cfg, key) {
  const user = checkUser(key?.user);
  return withEs(cfg, async (es) => {
    const u = await getUser(es, user);
    if (u?.metadata?._reserved) throw new Error(`"${user}" is a built-in user — disable it instead`);
    if ((await whoAmI(es)) === user) throw new Error('The panel is signed in as this user — it cannot delete itself');
    await es('DELETE', `/_security/user/${enc(user)}`);
    return { summary: `Deleted ${user}` };
  });
}

export async function grant(cfg, key, body) {
  const user = checkUser(key?.user);
  return withEs(cfg, async (es) => {
    const u = await getUser(es, user);
    const role = await roleFor(es, body.role, body.database);
    if ((u.roles || []).includes(role)) throw new Error(`${user} already has ${role}`);
    await putRoles(es, user, u, [...(u.roles || []), role]);
    return { summary: `Gave ${role} to ${user}` };
  });
}

export async function revoke(cfg, key, body) {
  const user = checkUser(key?.user);
  const role = String(body.role || '');
  if (!ROLE_RE.test(role)) throw new Error('Pick a role');
  return withEs(cfg, async (es) => {
    const u = await getUser(es, user);
    if (!(u.roles || []).includes(role)) throw new Error(`${user} does not have ${role}`);
    if (role === 'superuser' && (await whoAmI(es)) === user) throw new Error('The panel is signed in as this user — taking superuser away would lock the panel out');
    await putRoles(es, user, u, u.roles.filter((r) => r !== role));
    return { summary: `Took ${role} away from ${user}` };
  });
}

/* --------------------------------------------------------- indices */

function wholeNumber(value, name, min, max, fallback) {
  const s = String(value ?? '').trim();
  if (s === '') return fallback;
  if (!/^\d+$/.test(s) || Number(s) < min || Number(s) > max) throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  return Number(s);
}

export async function createDatabase(cfg, body) {
  const name = String(body.name || '').trim();
  if (!NEW_INDEX_RE.test(name) || name === '.' || name === '..') {
    throw new Error('Index names are lowercase letters, digits, "-", "_", "." and "+", and cannot start with "-", "_", "+" or "."');
  }
  const shards = wholeNumber(body.shards, 'Primary shards', 1, 1024, 1);
  const replicas = wholeNumber(body.replicas, 'Replicas', 0, 10, 0);
  return withEs(cfg, async (es) => {
    await es('PUT', `/${enc(name)}`, { settings: { number_of_shards: shards, number_of_replicas: replicas } });
    return { summary: `Created index ${name} (${shards} shard(s), ${replicas} replica(s))` };
  });
}

export async function dropDatabase(cfg, body) {
  const name = checkIndex(body.name);
  if (isSystem(name)) throw new Error(`"${name}" belongs to Elasticsearch itself and cannot be deleted here`);
  checkConfirm(name, body.confirm);
  return withEs(cfg, async (es) => {
    await es('DELETE', `/${enc(name)}`);
    return { summary: `Deleted index ${name}` };
  });
}

/* ------------------------------------------------------ configuration */

const EDITABLE = {
  'cluster.routing.allocation.enable': { group: 'Shard allocation', type: 'enum', options: ['all', 'primaries', 'new_primaries', 'none'], hint: 'Which shards may be placed on nodes; "primaries" during a rolling restart' },
  'cluster.routing.rebalance.enable': { group: 'Shard allocation', type: 'enum', options: ['all', 'primaries', 'replicas', 'none'], hint: 'Which shards may be moved to even out nodes' },
  'cluster.routing.allocation.disk.threshold_enabled': { group: 'Disk', type: 'enum', options: ['true', 'false'], hint: 'Stop placing shards on nodes whose disk is filling up' },
  'cluster.routing.allocation.disk.watermark.low': { group: 'Disk', type: 'text', hint: 'No new shards on a node past this, e.g. 85%' },
  'cluster.routing.allocation.disk.watermark.high': { group: 'Disk', type: 'text', hint: 'Shards are moved off a node past this, e.g. 90%' },
  'cluster.routing.allocation.disk.watermark.flood_stage': { group: 'Disk', type: 'text', hint: 'Indices on a node past this become read-only, e.g. 95%' },
  'indices.recovery.max_bytes_per_sec': { group: 'Recovery', type: 'text', hint: 'Speed limit for copying shards between nodes, e.g. 40mb' },
  'cluster.max_shards_per_node': { group: 'Limits', type: 'number', hint: 'Most shards per data node' },
  'search.default_search_timeout': { group: 'Search', type: 'text', hint: 'Time limit for searches that set none, e.g. 30s; -1 means none' },
  'action.auto_create_index': { group: 'Indices', type: 'text', hint: 'Whether writing to a missing index creates it: true, false, or patterns like +logs-*,-*' },
  'action.destructive_requires_name': { group: 'Indices', type: 'enum', options: ['true', 'false'], hint: 'Refuse deletes by wildcard or _all' },
};

export async function config(cfg) {
  return withEs(cfg, async (es) => {
    const s = await es('GET', '/_cluster/settings?include_defaults=true&flat_settings=true');
    const values = { ...(s.defaults || {}), ...(s.persistent || {}), ...(s.transient || {}) };
    const source = (n) => (s.transient?.[n] !== undefined ? 'transient' : s.persistent?.[n] !== undefined ? 'persistent' : 'default');
    const show = (v) => (Array.isArray(v) ? v.join(',') : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? ''));

    return {
      note: 'Changes are saved as persistent cluster settings: they apply to every node at once and survive restarts. '
        + 'An empty value puts a setting back to its default.',
      persistLabel: null,
      editable: Object.entries(EDITABLE).map(([n, meta]) => ({
        name: n, value: show(values[n]), display: `${show(values[n]) || '(unset)'}${source(n) === 'default' ? ' · default' : ''}`, ...meta,
      })),
      all: Object.keys(values).sort().map((name) => ({ name, value: show(values[name]), hint: source(name) })),
    };
  });
}

export async function setConfig(cfg, body) {
  const meta = EDITABLE[body.name];
  if (!meta) throw new Error(`"${body.name}" cannot be changed from the panel`);
  const raw = String(body.value ?? '').trim();
  let value = raw === '' ? null : raw;
  if (value !== null) {
    if (meta.type === 'number') {
      if (!/^\d+$/.test(raw)) throw new Error(`${body.name} must be a whole number`);
      value = Number(raw);
    } else if (meta.type === 'enum' && !meta.options.includes(raw)) {
      throw new Error(`${body.name} must be one of ${meta.options.join(', ')}`);
    } else if (raw.length > 100 || !/^[A-Za-z0-9_.%:,*+ -]+$/.test(raw)) {
      throw new Error('That value has characters a setting cannot use');
    }
  }
  return withEs(cfg, async (es) => {
    await es('PUT', '/_cluster/settings', { persistent: { [body.name]: value } });
    return { summary: value === null ? `${body.name} reset to its default` : `${body.name} = ${value}` };
  });
}

/* ---------------------------------------------------------------- query */

/** POSTs that only read. Every GET reads; anything else is refused before it is sent. */
const SEARCH_PATH = /^(\/[^/_][^/]*)?\/(_search|_count|_msearch|_field_caps|_validate\/query)$|^\/_sql$/;

export const queryHelp = {
  placeholder: 'POST /orders/_search\n{ "query": { "match": { "status": "paid" } }, "size": 20 }',
  hint: 'Kibana Dev Tools style: a first line like GET /_cat/indices or POST /index/_search, then an optional JSON body. '
    + 'A JSON body alone searches the index below. Only GET and searches (_search, _count, _msearch, _field_caps, _validate/query, _sql) are allowed. First 200 rows.',
  databaseLabel: 'Index (for a body without a first line)',
};

/** Dev Tools text → { method, path, body }. */
function parseRequest(input, index) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('A request is required');
  const nl = raw.indexOf('\n');
  const first = (nl < 0 ? raw : raw.slice(0, nl)).trim();
  const m = /^([A-Za-z]+)\s+(\S+)$/.exec(first);
  if (m) return { method: m[1].toUpperCase(), path: m[2].startsWith('/') ? m[2] : `/${m[2]}`, body: nl < 0 ? '' : raw.slice(nl + 1).trim() };
  if (raw.startsWith('{')) {
    if (!index) throw new Error('Pick the index to search, or start with a line like POST /orders/_search');
    return { method: 'POST', path: `/${enc(checkIndex(index))}/_search`, body: raw };
  }
  throw new Error('Start with a line like GET /_cat/indices, or give a JSON search body');
}

function checkReadRequest({ method, path }) {
  if (path.length > 500 || /\.\.|\\|#|\s/.test(path)) throw new Error('That path is not allowed');
  const pathname = path.split('?')[0];
  if (method === 'GET') return;
  if (method === 'POST' && SEARCH_PATH.test(pathname)) return;
  throw new Error(`${method} ${pathname} could change data — only GET and searches (_search, _count, _msearch, _field_caps, _validate/query, _sql) are allowed here`);
}

/** Whatever Elasticsearch answered, as rows for the result table. */
function asRows(res) {
  const hits = res?.hits?.hits;
  if (Array.isArray(hits) && hits.length) {
    const indices = new Set(hits.map((h) => h._index));
    const cols = [...new Set(hits.slice(0, 200).flatMap((h) => Object.keys(h._source || h.fields || {})))].slice(0, 30);
    return {
      columns: [...(indices.size > 1 ? ['_index'] : []), '_id', '_score', ...cols],
      rows: hits.slice(0, 200).map((h) => [
        ...(indices.size > 1 ? [h._index] : []), h._id, h._score === null || h._score === undefined ? '—' : String(h._score),
        ...cols.map((c) => text((h._source || h.fields || {})[c], 300)),
      ]),
      rowCount: hits.length,
      truncated: hits.length > 200,
    };
  }
  if (Array.isArray(res) && res.length && typeof res[0] === 'object') {
    const cols = Object.keys(res[0]).slice(0, 30);
    return { columns: cols, rows: res.slice(0, 200).map((r) => cols.map((c) => text(r[c], 300))), rowCount: res.length, truncated: res.length > 200 };
  }
  if (Array.isArray(res?.columns) && Array.isArray(res?.rows)) {
    return { columns: res.columns.map((c) => c.name), rows: res.rows.slice(0, 200).map((r) => r.map((v) => text(v, 300))), rowCount: res.rows.length, truncated: res.rows.length > 200 };
  }
  return { columns: ['Response'], rows: [[text(typeof res === 'string' ? res : JSON.stringify(res, null, 2), 20000)]], rowCount: 1, truncated: false };
}

export async function query(cfg, { text: input, database }) {
  const req = parseRequest(input, database || cfg.database);
  checkReadRequest(req);
  const pathname = req.path.split('?')[0];
  // _cat answers in columns of text unless asked for JSON.
  if (pathname.startsWith('/_cat') && !/[?&]format=/.test(req.path)) req.path += `${req.path.includes('?') ? '&' : '?'}format=json`;

  let body;
  let type;
  if (req.body) {
    if (pathname.endsWith('/_msearch')) {
      body = `${req.body}\n`;
      type = 'application/x-ndjson';
    } else {
      try { body = JSON.parse(req.body); } catch { throw new Error('The body must be JSON'); }
    }
  }

  return withEs(cfg, async (es) => {
    const started = Date.now();
    const res = await es(req.method, req.path, body, type);
    return { ...asRows(res), durationMs: Date.now() - started };
  });
}

/** A few cheap numbers for the connection's card, read every few seconds. */
export async function pulse(cfg) {
  return withEs(cfg, async (es) => {
    const [root, health, ns] = await Promise.all([
      es('GET', '/?filter_path=version.number'),
      es('GET', '/_cluster/health'),
      es('GET', '/_nodes/stats/indices,jvm,http?filter_path=nodes.*.indices.search.query_total,nodes.*.indices.indexing.index_total,'
        + 'nodes.*.indices.docs.count,nodes.*.indices.store.size_in_bytes,nodes.*.jvm.mem.heap_used_in_bytes,nodes.*.jvm.mem.heap_max_in_bytes,'
        + 'nodes.*.jvm.uptime_in_millis,nodes.*.http.current_open'),
    ]);
    const nodes = Object.values(ns?.nodes || {});
    const sum = (fn) => nodes.reduce((n, x) => n + Number(fn(x) || 0), 0);
    const heapUsed = sum((x) => x.jvm?.mem?.heap_used_in_bytes);
    const heapMax = sum((x) => x.jvm?.mem?.heap_max_in_bytes);
    return {
      version: `Elasticsearch ${root?.version?.number || '?'}`,
      uptimeSec: Math.round(Math.max(0, ...nodes.map((x) => Number(x.jvm?.uptime_in_millis || 0))) / 1000),
      role: `${health.status} · ${health.number_of_nodes} node(s)`,
      counter: sum((x) => x.indices?.search?.query_total) + sum((x) => x.indices?.indexing?.index_total),
      counterUnit: 'ops/s',
      connections: { used: sum((x) => x.http?.current_open), max: 0 },
      memory: heapMax ? { label: 'JVM heap', used: heapUsed, max: heapMax, usedBytes: heapUsed, maxBytes: heapMax } : null,
      hitRate: null,
      storageBytes: sum((x) => x.indices?.store?.size_in_bytes),
      facts: [
        ['Documents', sum((x) => x.indices?.docs?.count)],
        ['Shards', Number(health.active_shards || 0)],
        ['Unassigned', Number(health.unassigned_shards || 0)],
      ],
    };
  });
}
