import { createClient } from 'redis';
import { withTunnel } from '../tunnel.js';
import {
  stat, kv, table, num, badge, code, small, link, field, bytes, count, uptime, percent, text,
  checkPassword, checkConfirm, unsupported,
} from './shape.js';

export const label = 'Redis';

const USER_RE = /^[A-Za-z0-9_.@-]{1,64}$/;
const PATTERN_RE = /^[^\s]{1,200}$/;

/** What each access level means as ACL rules. */
const ACCESS = {
  full: { label: 'Full — every command', rules: ['+@all'] },
  readwrite: { label: 'Read and write — no admin or dangerous commands', rules: ['+@all', '-@admin', '-@dangerous'] },
  readonly: { label: 'Read only', rules: ['-@all', '+@read', '+@connection'] },
};

/* ------------------------------------------------------------ connecting */

async function withRedis(cfg, fn, database) {
  return withTunnel(cfg.server, cfg.host, cfg.port, async ({ host, port }) => {
    const client = createClient({
      socket: { host, port, connectTimeout: 12000, reconnectStrategy: false, tls: cfg.tls || undefined, rejectUnauthorized: cfg.tls ? false : undefined },
      username: cfg.user || undefined,
      password: cfg.password || undefined,
      database: Number(database ?? cfg.database ?? 0) || 0,
    });
    client.on('error', () => {});
    try {
      await client.connect();
    } catch (err) {
      throw friendly(err);
    }
    const cmd = (...args) => client.sendCommand(args.map(String));
    try {
      return await fn(cmd);
    } catch (err) {
      throw friendly(err);
    } finally {
      try { client.destroy(); } catch { /* already gone */ }
    }
  });
}

function friendly(err) {
  const msg = String(err?.message || err);
  const map = [
    [/WRONGPASS|invalid username-password|NOAUTH/i, 'Authentication failed — check the username and password (leave the username empty for the "default" user).'],
    [/ECONNREFUSED/i, 'Connection refused — Redis is not listening on that host and port.'],
    [/timeout|ETIMEDOUT/i, 'Timed out reaching Redis. It may listen on localhost only — tie this connection to a server so the panel tunnels over SSH.'],
    [/ENOTFOUND|EAI_AGAIN/i, 'Host not found — the hostname could not be resolved.'],
    [/NOPERM/i, `This Redis user is not allowed to do that: ${msg}`],
  ];
  for (const [re, nice] of map) {
    if (re.test(msg)) {
      const e = new Error(nice);
      e.cause = msg;
      return e;
    }
  }
  return err instanceof Error ? err : new Error(msg);
}

const maybe = async (p) => { try { return await p; } catch { return null; } };

/** INFO text → { section: { key: value } }. */
function parseInfo(raw) {
  const out = {};
  let section = 'misc';
  for (const line of String(raw || '').split(/\r?\n/)) {
    if (line.startsWith('# ')) { section = line.slice(2).trim().toLowerCase(); out[section] = {}; continue; }
    const i = line.indexOf(':');
    if (i > 0) (out[section] ||= {})[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

/** "keys=12,expires=3,avg_ttl=0" → { keys: 12, … } */
const parseKeyspace = (v) => Object.fromEntries(String(v).split(',').map((p) => p.split('=')).map(([k, n]) => [k, Number(n)]));

/** A flat [k, v, k, v] reply as an object. */
function pairs(list) {
  const o = {};
  for (let i = 0; i < (list || []).length; i += 2) o[list[i]] = list[i + 1];
  return o;
}

/** "id=3 addr=… name= age=12 …" per line. */
function parseClients(raw) {
  return String(raw || '').trim().split('\n').filter(Boolean).map((line) => Object.fromEntries(
    line.trim().split(' ').map((p) => { const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)]; })
  ));
}

/** An ACL LIST line without its password hashes. */
function parseAcl(line) {
  const parts = String(line).split(' ');
  const name = parts[1];
  const rules = parts.slice(2).filter((p) => !/^[#>]/.test(p) && p !== 'sanitize-payload');
  return {
    name,
    on: rules.includes('on'),
    nopass: rules.includes('nopass'),
    hasPassword: parts.some((p) => p.startsWith('#')),
    rules: rules.filter((r) => r !== 'on' && r !== 'off' && r !== 'nopass'),
  };
}

/** Save ACL changes wherever this server keeps them, and say whether that worked. */
async function persistAcl(cmd) {
  if (await maybe(cmd('ACL', 'SAVE'))) return '';
  if (await maybe(cmd('CONFIG', 'REWRITE'))) return '';
  return ' — not saved to disk (no aclfile or config file), so it lasts until Redis restarts';
}

/* ------------------------------------------------------------- reading */

export async function test(cfg) {
  const started = Date.now();
  const r = await withRedis(cfg, async (cmd) => ({
    info: parseInfo(await cmd('INFO', 'server')),
    me: await maybe(cmd('ACL', 'WHOAMI')),
  }));
  return { version: `Redis ${r.info.server?.redis_version}`, currentUser: r.me || 'default', latencyMs: Date.now() - started };
}

export async function overview(cfg) {
  const started = Date.now();
  return withRedis(cfg, async (cmd) => {
    const info = parseInfo(await cmd('INFO', 'everything').catch(() => cmd('INFO')));
    const conf = pairs(await maybe(cmd('CONFIG', 'GET', 'maxclients')));
    const users = await maybe(cmd('ACL', 'USERS'));
    const me = await maybe(cmd('ACL', 'WHOAMI'));
    const clients = parseClients(await maybe(cmd('CLIENT', 'LIST')));

    const sv = info.server || {};
    const mem = info.memory || {};
    const st = info.stats || {};
    const cl = info.clients || {};
    const ps = info.persistence || {};
    const rep = info.replication || {};
    const keyspace = Object.entries(info.keyspace || {}).map(([db, v]) => ({ db, ...parseKeyspace(v) }));
    const keys = keyspace.reduce((n, k) => n + k.keys, 0);
    const hits = Number(st.keyspace_hits || 0);
    const misses = Number(st.keyspace_misses || 0);
    const maxmem = Number(mem.maxmemory || 0);
    const maxClients = Number(conf.maxclients || 0);

    return {
      durationMs: Date.now() - started,
      counts: { databases: keyspace.length, users: users ? users.length : null },
      stats: [
        stat('Version', `Redis ${sv.redis_version}`, `${sv.redis_mode || 'standalone'} · ${sv.multiplexing_api || ''}`),
        stat('Uptime', uptime(sv.uptime_in_seconds), `${count(st.total_commands_processed)} commands served`),
        stat('Keys', count(keys), `in ${keyspace.length} database(s) · ${count(keyspace.reduce((n, k) => n + k.expires, 0))} with a TTL`),
        stat('Users', users ? users.length : '—', users ? `ACL users${me ? ` · you are ${me}` : ''}` : 'ACL needs Redis 6+'),
        stat('Clients', `${cl.connected_clients}${maxClients ? ` / ${maxClients}` : ''}`, `${cl.blocked_clients || 0} blocked`, percent(cl.connected_clients, maxClients)),
        stat('Memory', mem.used_memory_human, maxmem ? `of ${bytes(maxmem)} (${mem.maxmemory_policy})` : `no limit · peak ${mem.used_memory_peak_human}`, maxmem ? percent(mem.used_memory, maxmem) : null),
        stat('Ops / sec', count(st.instantaneous_ops_per_sec), `${bytes(Number(st.instantaneous_input_kbps || 0) * 1024)}/s in`),
        stat('Hit rate', hits + misses ? `${percent(hits, hits + misses)}%` : '—', `${count(hits)} hits · ${count(misses)} misses`),
        stat('Evicted / expired', `${count(st.evicted_keys)} / ${count(st.expired_keys)}`, 'keys removed for memory / TTL'),
        stat('Persistence', ps.aof_enabled === '1' ? 'AOF on' : 'RDB only', `last save ${ps.rdb_last_bgsave_status || '—'} · ${count(ps.rdb_changes_since_last_save)} changes since`),
        stat('Role', rep.role || '—', rep.role === 'master' ? `${rep.connected_slaves || 0} replica(s)` : `master ${rep.master_host || ''}:${rep.master_port || ''}`),
      ],
      info: [
        kv('Server', [
          ['Version', text(sv.redis_version)],
          ['OS', small(text(sv.os))],
          ['Port', text(sv.tcp_port)],
          ['Config file', sv.config_file ? code(sv.config_file) : 'none — settings live only in memory'],
          ['Executable', small(text(sv.executable))],
          ['Run ID', small(text(sv.run_id))],
        ]),
        kv('Memory', [
          ['Used', `${mem.used_memory_human} (RSS ${mem.used_memory_rss_human})`],
          ['Peak', text(mem.used_memory_peak_human)],
          ['Fragmentation', text(mem.mem_fragmentation_ratio)],
          ['Limit', maxmem ? bytes(maxmem) : 'none'],
          ['Eviction policy', code(text(mem.maxmemory_policy))],
          ['Allocator', text(mem.mem_allocator)],
        ]),
      ],
      tables: [
        table('Connected clients', ['ID', 'Address', 'Name', 'User', num('DB'), num('Age'), num('Idle'), 'Last command'],
          clients.slice(0, 50).map((c) => [c.id, small(c.addr), text(c.name || '—'), text(c.user), c.db, `${c.age}s`, `${c.idle}s`, code(text(c.cmd))]),
          'This user cannot list clients'),
      ],
    };
  });
}

export async function databases(cfg) {
  return withRedis(cfg, async (cmd) => {
    const info = parseInfo(await cmd('INFO', 'keyspace'));
    const total = Number(pairs(await maybe(cmd('CONFIG', 'GET', 'databases'))).databases || 16);
    const ks = Object.fromEntries(Object.entries(info.keyspace || {}).map(([db, v]) => [db, parseKeyspace(v)]));
    const list = Array.from({ length: total }, (_, i) => ({ name: `db${i}`, index: i, ...(ks[`db${i}`] || { keys: 0, expires: 0, avg_ttl: 0 }) }));

    return {
      stats: [
        stat('Databases', `${Object.keys(ks).length} used`, `of ${total} numbered databases`),
        stat('Keys', count(list.reduce((n, d) => n + d.keys, 0)), ''),
        stat('With a TTL', count(list.reduce((n, d) => n + d.expires, 0)), 'expire on their own'),
      ],
      columns: ['Database', num('Keys'), num('With TTL'), num('Average TTL')],
      rows: list.map((d) => ({
        name: d.name,
        empty: !d.keys,
        cells: [link(d.name, { database: d.name }), count(d.keys), count(d.expires), d.avg_ttl ? `${Math.round(d.avg_ttl / 1000)}s` : '—'],
      })),
      caps: {
        create: false,
        createNote: 'Redis has a fixed set of numbered databases (db0–db15 by default) — nothing to create.',
        drop: true,
        dropLabel: 'Flush',
        dropNote: 'FLUSHDB deletes every key in this database. The database number stays.',
      },
    };
  });
}

const dbIndex = (name) => {
  const m = /^db(\d{1,3})$/.exec(String(name || ''));
  if (!m) throw new Error('Unknown Redis database');
  return Number(m[1]);
};

export async function database(cfg, name) {
  const index = dbIndex(name);
  return withRedis(cfg, async (cmd) => {
    const size = Number(await cmd('DBSIZE'));
    // SCAN, never KEYS: a sample that cannot stall a busy server.
    const keys = [];
    let cursor = '0';
    do {
      const [next, batch] = await cmd('SCAN', cursor, 'COUNT', 500);
      keys.push(...batch);
      cursor = next;
    } while (cursor !== '0' && keys.length < 300);
    const sample = keys.slice(0, 300);
    const details = await Promise.all(sample.map(async (k) => ({
      key: k,
      type: await cmd('TYPE', k),
      ttl: Number(await cmd('TTL', k)),
      mem: await maybe(cmd('MEMORY', 'USAGE', k)),
    })));
    const byType = {};
    for (const d of details) byType[d.type] = (byType[d.type] || 0) + 1;

    return {
      title: name,
      stats: [
        stat('Keys', count(size), sample.length < size ? `showing a sample of ${sample.length}` : ''),
        stat('Sampled memory', bytes(details.reduce((n, d) => n + Number(d.mem || 0), 0)), `across ${details.length} keys`),
        stat('With a TTL', count(details.filter((d) => d.ttl >= 0).length), 'in the sample'),
        stat('Types', Object.keys(byType).length, Object.entries(byType).map(([t, n]) => `${t} ${n}`).join(' · ')),
      ],
      tables: [
        table('Keys', ['Key', 'Type', num('TTL'), num('Memory')],
          details.sort((a, b) => Number(b.mem || 0) - Number(a.mem || 0)).map((d) => [
            link(d.key, { database: name, item: d.key }), code(d.type), d.ttl < 0 ? 'none' : `${d.ttl}s`, bytes(d.mem),
          ]), 'This database is empty'),
      ],
    };
  }, index);
}

export async function item(cfg, database, key) {
  const index = dbIndex(database);
  return withRedis(cfg, async (cmd) => {
    const type = await cmd('TYPE', key);
    if (type === 'none') throw new Error(`Key "${key}" does not exist (it may have expired)`);
    const ttl = Number(await cmd('TTL', key));
    const mem = await maybe(cmd('MEMORY', 'USAGE', key));
    const enc = await maybe(cmd('OBJECT', 'ENCODING', key));
    let value;
    let size;
    if (type === 'string') { value = await cmd('GETRANGE', key, 0, 16383); size = await cmd('STRLEN', key); }
    else if (type === 'hash') { value = pairs((await cmd('HSCAN', key, 0, 'COUNT', 200))[1]); size = await cmd('HLEN', key); }
    else if (type === 'list') { value = await cmd('LRANGE', key, 0, 199); size = await cmd('LLEN', key); }
    else if (type === 'set') { value = (await cmd('SSCAN', key, 0, 'COUNT', 200))[1]; size = await cmd('SCARD', key); }
    else if (type === 'zset') { value = pairs(await cmd('ZRANGE', key, 0, 199, 'WITHSCORES')); size = await cmd('ZCARD', key); }
    else if (type === 'stream') { value = await cmd('XRANGE', key, '-', '+', 'COUNT', 50); size = await cmd('XLEN', key); }
    else value = `(${type} values are not shown here)`;

    return {
      title: `${database} › ${key}`,
      stats: [
        stat('Type', type, enc ? `encoding ${enc}` : ''),
        stat(type === 'string' ? 'Length' : 'Elements', count(size), ''),
        stat('TTL', ttl < 0 ? 'none' : `${ttl}s`, ttl < 0 ? 'never expires' : ''),
        stat('Memory', bytes(mem), ''),
      ],
      tables: [],
      pre: { title: 'Value (first 200 elements / 16 KB)', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
    };
  }, index);
}

/* ------------------------------------------------------------- users */

export async function users(cfg) {
  return withRedis(cfg, async (cmd) => {
    const lines = await maybe(cmd('ACL', 'LIST'));
    if (!lines) throw new Error('This server has no ACL users (Redis 6 or newer), or this user may not run ACL LIST.');
    const me = await maybe(cmd('ACL', 'WHOAMI'));
    const clients = parseClients(await maybe(cmd('CLIENT', 'LIST')));
    const list = lines.map(parseAcl);

    return {
      currentUser: me || 'default',
      note: 'Redis users are ACL rules: which commands and which key patterns each may use. "default" is who clients are when they only send a password.',
      stats: [
        stat('Total users', list.length, 'ACL users'),
        stat('Enabled', list.filter((u) => u.on).length, `${new Set(clients.map((c) => c.user)).size} connected now`),
        stat('Disabled', list.filter((u) => !u.on).length, 'cannot authenticate'),
        stat('Without password', list.filter((u) => u.nopass && u.on).length, 'anyone can be them', null),
      ],
      columns: ['User', 'State', 'Password', num('Clients')],
      users: list.map((u) => ({
        key: { user: u.name },
        label: u.name,
        self: u.name === (me || 'default'),
        locked: !u.on,
        cells: [
          { text: u.name },
          u.on ? badge('on', 'ok') : badge('off', 'err'),
          u.nopass ? badge('none', 'warn') : u.hasPassword ? 'set' : badge('none set', 'warn'),
          count(clients.filter((c) => c.user === u.name).length),
        ],
        grants: u.rules,
      })),
      caps: {
        lock: true,
        lockLabel: ['Disable', 'Enable'],
        grantFields: [
          field('access', 'Access', { type: 'select', options: Object.entries(ACCESS).map(([value, a]) => ({ value, label: a.label })), default: 'readwrite' }),
          field('pattern', 'Key pattern', { default: '*', hint: 'Which keys, e.g. * for all or app:* for one prefix. Replaces the user\'s current rules.' }),
        ],
        revokeFields: [],
        revokeNote: 'Removes every command and key pattern from the user. It can still sign in, but can do nothing.',
        createFields: [
          field('user', 'Username', { required: true, placeholder: 'app' }),
          field('password', 'Password', { type: 'password', required: true }),
          field('access', 'Access', { type: 'select', options: Object.entries(ACCESS).map(([value, a]) => ({ value, label: a.label })), default: 'readwrite' }),
          field('pattern', 'Key pattern', { default: '*' }),
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

function accessRules(access, pattern) {
  const a = ACCESS[access || 'readwrite'];
  if (!a) throw new Error('Pick an access level');
  const p = String(pattern || '*').trim();
  if (!PATTERN_RE.test(p)) throw new Error('The key pattern cannot contain spaces');
  return ['resetkeys', 'resetchannels', `~${p}`, '&*', ...a.rules];
}

export async function createUser(cfg, body) {
  const user = checkUser(body.user);
  const password = checkPassword(body.password);
  return withRedis(cfg, async (cmd) => {
    if ((await cmd('ACL', 'LIST')).some((l) => parseAcl(l).name === user)) throw new Error(`User "${user}" already exists`);
    await cmd('ACL', 'SETUSER', user, 'reset', 'on', `>${password}`, ...accessRules(body.access, body.pattern));
    return { summary: `Created ${user}${await persistAcl(cmd)}` };
  });
}

export async function alterUser(cfg, key, body) {
  const user = checkUser(key?.user);
  return withRedis(cfg, async (cmd) => {
    const me = (await maybe(cmd('ACL', 'WHOAMI'))) || 'default';
    const rules = [];
    if (body.password) rules.push('resetpass', `>${checkPassword(body.password)}`);
    if (body.locked !== undefined) {
      if (body.locked && me === user) throw new Error('The panel is signed in as this user — disabling it would lock the panel out');
      rules.push(body.locked ? 'off' : 'on');
    }
    if (!rules.length) throw new Error('Nothing to change');
    await cmd('ACL', 'SETUSER', user, ...rules);
    return { summary: `Updated ${user}${await persistAcl(cmd)}` };
  });
}

export async function dropUser(cfg, key) {
  const user = checkUser(key?.user);
  if (user === 'default') throw new Error('The "default" user cannot be deleted — disable it instead');
  return withRedis(cfg, async (cmd) => {
    if ((await maybe(cmd('ACL', 'WHOAMI'))) === user) throw new Error('The panel is signed in as this user — it cannot drop itself');
    await cmd('ACL', 'DELUSER', user);
    return { summary: `Deleted ${user}${await persistAcl(cmd)}` };
  });
}

export async function grant(cfg, key, body) {
  const user = checkUser(key?.user);
  return withRedis(cfg, async (cmd) => {
    await cmd('ACL', 'SETUSER', user, '-@all', ...accessRules(body.access, body.pattern));
    return { summary: `${user} now has ${ACCESS[body.access || 'readwrite'].label.toLowerCase()} on ${body.pattern || '*'}${await persistAcl(cmd)}` };
  });
}

export async function revoke(cfg, key) {
  const user = checkUser(key?.user);
  return withRedis(cfg, async (cmd) => {
    if ((await maybe(cmd('ACL', 'WHOAMI'))) === user) throw new Error('The panel is signed in as this user — revoking would lock the panel out');
    await cmd('ACL', 'SETUSER', user, '-@all', 'resetkeys', 'resetchannels');
    return { summary: `${user} can no longer run any command${await persistAcl(cmd)}` };
  });
}

/* --------------------------------------------------------- databases */

export async function createDatabase() {
  throw unsupported('databases to create — db0 to db15 always exist', label);
}

export async function dropDatabase(cfg, body) {
  const index = dbIndex(body.name);
  checkConfirm(body.name, body.confirm);
  return withRedis(cfg, async (cmd) => {
    await cmd('FLUSHDB');
    return { summary: `Flushed ${body.name}` };
  }, index);
}

/* ------------------------------------------------------ configuration */

const EDITABLE = {
  maxmemory: { group: 'Memory', type: 'text', unit: 'bytes', hint: 'Memory limit, e.g. 512mb or 2gb; 0 means no limit' },
  'maxmemory-policy': { group: 'Memory', type: 'enum', options: ['noeviction', 'allkeys-lru', 'allkeys-lfu', 'allkeys-random', 'volatile-lru', 'volatile-lfu', 'volatile-random', 'volatile-ttl'], hint: 'What to evict when the limit is reached' },
  maxclients: { group: 'Clients', type: 'number', hint: 'Most clients at once' },
  timeout: { group: 'Clients', type: 'number', hint: 'Close idle clients after this many seconds (0 = never)' },
  'tcp-keepalive': { group: 'Clients', type: 'number', hint: 'Seconds between TCP keepalives' },
  appendonly: { group: 'Persistence', type: 'enum', options: ['yes', 'no'], hint: 'Append-only file: log every write' },
  appendfsync: { group: 'Persistence', type: 'enum', options: ['always', 'everysec', 'no'], hint: 'How often the AOF is flushed to disk' },
  save: { group: 'Persistence', type: 'text', hint: 'RDB snapshot rules, e.g. "3600 1 300 100 60 10000"; empty turns snapshots off' },
  'slowlog-log-slower-than': { group: 'Logging', type: 'number', hint: 'Microseconds before a command is logged as slow' },
  'slowlog-max-len': { group: 'Logging', type: 'number', hint: 'Slow log entries kept' },
  loglevel: { group: 'Logging', type: 'enum', options: ['debug', 'verbose', 'notice', 'warning'], hint: 'Server log verbosity' },
  'notify-keyspace-events': { group: 'Behaviour', type: 'text', hint: 'Keyspace notifications, e.g. Ex for expired keys' },
  hz: { group: 'Behaviour', type: 'number', hint: 'Background task frequency' },
};

export async function config(cfg) {
  return withRedis(cfg, async (cmd) => {
    const all = pairs(await cmd('CONFIG', 'GET', '*'));
    const configFile = parseInfo(await cmd('INFO', 'server')).server?.config_file;
    return {
      note: `Changes apply at once with CONFIG SET.${configFile
        ? ` Tick "Save to redis.conf" to keep them (CONFIG REWRITE on ${configFile}).`
        : ' This server was started without a config file, so changes are lost when it restarts.'}`,
      persistLabel: configFile ? 'Save to redis.conf (CONFIG REWRITE)' : null,
      editable: Object.entries(EDITABLE).filter(([n]) => all[n] !== undefined).map(([n, meta]) => ({
        name: n, value: all[n], display: meta.unit === 'bytes' && /^\d+$/.test(all[n]) ? (all[n] === '0' ? '0 (no limit)' : bytes(Number(all[n]))) : all[n] || '(empty)', ...meta,
      })),
      all: Object.entries(all).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => ({ name, value: /pass|requirepass/i.test(name) && value ? '••••••' : value })),
    };
  });
}

export async function setConfig(cfg, body) {
  const meta = EDITABLE[body.name];
  if (!meta) throw new Error(`"${body.name}" cannot be changed from the panel`);
  const value = String(body.value ?? '').trim();
  if (meta.type === 'number' && !/^\d+$/.test(value)) throw new Error(`${body.name} must be a whole number`);
  if (meta.type === 'enum' && !meta.options.includes(value)) throw new Error(`${body.name} must be one of ${meta.options.join(', ')}`);
  if (value.length > 200) throw new Error('That value is too long');
  return withRedis(cfg, async (cmd) => {
    await cmd('CONFIG', 'SET', body.name, value);
    let saved = '';
    if (body.persist) {
      try { await cmd('CONFIG', 'REWRITE'); saved = ' and saved to redis.conf'; } catch (err) { saved = ` — not saved: ${err.message}`; }
    }
    const now = pairs(await cmd('CONFIG', 'GET', body.name))[body.name];
    return { summary: `${body.name} = ${now}${saved}` };
  });
}

/* ---------------------------------------------------------------- query */

/** Commands that only read. Anything else is refused before it reaches Redis. */
const READ_COMMANDS = new Set([
  'GET', 'MGET', 'STRLEN', 'GETRANGE', 'EXISTS', 'TYPE', 'TTL', 'PTTL', 'DBSIZE', 'SCAN', 'HGET', 'HMGET', 'HGETALL', 'HKEYS', 'HVALS',
  'HLEN', 'HEXISTS', 'HSCAN', 'LRANGE', 'LLEN', 'LINDEX', 'SMEMBERS', 'SCARD', 'SISMEMBER', 'SSCAN', 'SRANDMEMBER', 'ZRANGE', 'ZREVRANGE',
  'ZRANGEBYSCORE', 'ZCARD', 'ZSCORE', 'ZRANK', 'ZCOUNT', 'ZSCAN', 'XRANGE', 'XREVRANGE', 'XLEN', 'XINFO', 'INFO', 'MEMORY', 'OBJECT',
  'SLOWLOG', 'PING', 'TIME', 'LASTSAVE', 'CLIENT', 'PUBSUB', 'GEOPOS', 'GEODIST', 'GEOSEARCH', 'BITCOUNT', 'GETBIT', 'PFCOUNT', 'ROLE',
  'JSON.GET', 'JSON.TYPE', 'FT.SEARCH', 'FT.INFO', 'FT._LIST',
]);
/** Read-only only in some forms. */
const SUBCOMMANDS = { MEMORY: ['USAGE', 'STATS', 'DOCTOR'], OBJECT: ['ENCODING', 'FREQ', 'IDLETIME', 'REFCOUNT'], SLOWLOG: ['GET', 'LEN'], CLIENT: ['LIST', 'INFO', 'GETNAME'], XINFO: ['STREAM', 'GROUPS', 'CONSUMERS'], PUBSUB: ['CHANNELS', 'NUMSUB', 'NUMPAT'] };

/** Split a command line the way redis-cli does, honouring quotes. */
function tokenize(line) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] !== undefined ? m[2] : m[3]);
  return out;
}

export const queryHelp = {
  placeholder: 'HGETALL user:42',
  hint: 'One read-only command, redis-cli style: GET, HGETALL, LRANGE, ZRANGE, SCAN, TTL, INFO … Anything that writes is refused.',
  databaseLabel: 'Database (db0–db15)',
};

export async function query(cfg, { text: line, database }) {
  const args = tokenize(String(line || '').trim());
  if (!args.length) throw new Error('A command is required');
  const name = args[0].toUpperCase();
  if (!READ_COMMANDS.has(name)) throw new Error(`${name} is not a read-only command`);
  if (SUBCOMMANDS[name] && !SUBCOMMANDS[name].includes(String(args[1] || '').toUpperCase())) {
    throw new Error(`Only ${SUBCOMMANDS[name].map((s) => `${name} ${s}`).join(', ')} are allowed`);
  }
  const index = database ? dbIndex(database) : undefined;

  return withRedis(cfg, async (cmd) => {
    const started = Date.now();
    const reply = await cmd(name, ...args.slice(1));
    const list = Array.isArray(reply) ? reply : [reply];
    return {
      columns: Array.isArray(reply) ? ['#', 'Value'] : ['Value'],
      rows: list.slice(0, 200).map((v, i) => (Array.isArray(reply) ? [String(i + 1), text(v, 1000)] : [text(v, 20000)])),
      rowCount: list.length,
      truncated: list.length > 200,
      durationMs: Date.now() - started,
    };
  }, index);
}
