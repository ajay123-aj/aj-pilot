import pg from 'pg';
import { withTunnel } from '../tunnel.js';
import {
  stat, kv, table, num, badge, code, small, link, field, bytes, count, uptime, percent, text,
  checkPassword, checkConfirm,
} from './shape.js';

export const label = 'PostgreSQL';

const SYSTEM_DATABASES = ['postgres', 'template0', 'template1'];
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/;

/* ------------------------------------------------------------ connecting */

/**
 * Open as many clients as the job needs — one per database, since PostgreSQL
 * cannot look inside a database it is not connected to — over one tunnel, and
 * close them all afterwards.
 */
async function withPg(cfg, fn) {
  return withTunnel(cfg.server, cfg.host, cfg.port, async ({ host, port }) => {
    const clients = new Map();
    const open = async (database) => {
      const db = database || cfg.database || 'postgres';
      if (clients.has(db)) return clients.get(db);
      const client = new pg.Client({
        host, port, user: cfg.user, password: cfg.password, database: db,
        connectionTimeoutMillis: 15000,
        ssl: cfg.tls ? { rejectUnauthorized: false } : undefined,
        application_name: 'aj-pilot-panel',
      });
      client.on('error', () => {});
      try {
        await client.connect();
      } catch (err) {
        throw friendly(err);
      }
      clients.set(db, client);
      return client;
    };
    try {
      return await fn(open);
    } finally {
      await Promise.all([...clients.values()].map((c) => c.end().catch(() => {})));
    }
  });
}

function friendly(err) {
  const msg = String(err?.message || err);
  const map = [
    [/password authentication failed|28P01/i, 'Password authentication failed — check the username and password.'],
    [/ECONNREFUSED/i, 'Connection refused — PostgreSQL is not listening on that host and port.'],
    [/timeout|ETIMEDOUT/i, 'Connection timed out — PostgreSQL may listen on localhost only. Tie this connection to a server so the panel tunnels over SSH.'],
    [/ENOTFOUND|EAI_AGAIN/i, 'Host not found — the hostname could not be resolved.'],
    [/no pg_hba\.conf entry/i, 'pg_hba.conf does not allow this connection. Add a rule for this user and host, or tunnel through the server over SSH.'],
    [/does not exist/i, msg],
    [/server does not support SSL/i, 'This server does not support TLS — turn TLS off for this connection.'],
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

const rows = async (client, sql, params = []) => (await client.query(sql, params)).rows;
const first = async (client, sql, params = []) => (await rows(client, sql, params))[0] || {};
/** A query a restricted role may not be allowed to run: an empty answer, not a failure. */
const maybe = async (client, sql, params = []) => {
  try { return await rows(client, sql, params); } catch { return null; }
};

const ident = (client, name) => client.escapeIdentifier(String(name));
const literal = (client, value) => client.escapeLiteral(String(value));

function checkName(name, what = 'Name') {
  if (!NAME_RE.test(String(name || ''))) {
    throw new Error(`${what} must start with a letter or "_" and use only letters, digits, "_", "$" and "-" (up to 63 characters)`);
  }
  return String(name);
}

/** "8kB" pages, "kB", "ms" … turned into something a person reads. */
function settingText(row) {
  if (!row) return '—';
  const { setting, unit } = row;
  const n = Number(setting);
  const unitBytes = { B: 1, kB: 1024, '8kB': 8192, '16kB': 16384, '32kB': 32768, MB: 1024 ** 2, GB: 1024 ** 3 };
  if (unit in unitBytes && !Number.isNaN(n)) return n < 0 ? String(setting) : bytes(n * unitBytes[unit]);
  if (unit && unit !== '') return `${setting} ${unit}`;
  return String(setting);
}

/* ------------------------------------------------------------- reading */

export async function test(cfg) {
  const started = Date.now();
  const r = await withPg(cfg, async (open) => first(await open(), "SELECT current_setting('server_version') AS version, current_user AS user, current_database() AS db"));
  return { version: `PostgreSQL ${r.version}`, currentUser: r.user, latencyMs: Date.now() - started };
}

export async function overview(cfg) {
  const started = Date.now();
  return withPg(cfg, async (open) => {
    const c = await open();
    const id = await first(c, `SELECT current_setting('server_version') AS version, version() AS full, current_user AS "user",
      current_database() AS db, pg_postmaster_start_time() AS started,
      extract(epoch FROM now() - pg_postmaster_start_time())::bigint AS uptime, pg_is_in_recovery() AS replica`);
    const settings = Object.fromEntries((await rows(c, `SELECT name, setting, unit FROM pg_settings WHERE name IN
      ('max_connections','shared_buffers','work_mem','maintenance_work_mem','effective_cache_size','data_directory','server_encoding',
       'TimeZone','wal_level','listen_addresses','ssl','max_wal_size','port','config_file','default_transaction_read_only')`)).map((r) => [r.name, r]));
    const conns = await first(c, `SELECT count(*)::int AS total, count(*) FILTER (WHERE state = 'active')::int AS active,
      count(*) FILTER (WHERE state LIKE 'idle in transaction%')::int AS idle_tx FROM pg_stat_activity WHERE backend_type = 'client backend'`);
    const s = await first(c, `SELECT sum(xact_commit)::bigint AS commits, sum(xact_rollback)::bigint AS rollbacks,
      sum(blks_hit)::bigint AS hit, sum(blks_read)::bigint AS read, sum(deadlocks)::bigint AS deadlocks,
      sum(temp_bytes)::bigint AS temp, sum(tup_inserted)::bigint AS ins, sum(tup_updated)::bigint AS upd,
      sum(tup_deleted)::bigint AS del, sum(tup_returned)::bigint AS ret FROM pg_stat_database`);
    const dbs = await rows(c, `SELECT d.datname AS name,
      CASE WHEN has_database_privilege(d.datname, 'CONNECT') THEN pg_database_size(d.datname) END AS size
      FROM pg_database d WHERE NOT d.datistemplate`);
    const roles = await first(c, `SELECT count(*)::int AS total, count(*) FILTER (WHERE rolcanlogin)::int AS logins,
      count(*) FILTER (WHERE rolsuper)::int AS supers FROM pg_roles WHERE rolname !~ '^pg_'`);
    const sessions = await rows(c, `SELECT pid, usename, datname, client_addr::text AS client, state,
      extract(epoch FROM now() - coalesce(query_start, backend_start))::int AS secs, left(query, 120) AS query
      FROM pg_stat_activity WHERE backend_type = 'client backend' ORDER BY query_start NULLS LAST LIMIT 25`);

    const maxConn = Number(settings.max_connections?.setting || 0);
    const hitRate = percent(s.hit, Number(s.hit || 0) + Number(s.read || 0));
    const totalSize = dbs.reduce((n, d) => n + Number(d.size || 0), 0);
    const userDbs = dbs.filter((d) => !SYSTEM_DATABASES.includes(d.name));

    return {
      durationMs: Date.now() - started,
      counts: { databases: userDbs.length, users: roles.total },
      stats: [
        // "18.6 (Debian 18.6-1.pgdg13+2)" — the number on the tile, the build under it.
        stat('Version', `PostgreSQL ${String(id.version).split(' ')[0]}`, `${id.replica ? 'read replica (in recovery)' : 'primary'}${String(id.version).includes(' ') ? ` · ${String(id.version).replace(/^\S+\s*/, '')}` : ''}`),
        stat('Uptime', uptime(id.uptime), `since ${text(id.started).slice(0, 19).replace('T', ' ')}`),
        stat('Databases', userDbs.length, `${bytes(totalSize)} on disk`),
        stat('Users', roles.total, `${roles.logins} can log in · ${roles.supers} superuser`),
        stat('Connections', `${conns.total} / ${maxConn || '—'}`, `${conns.active} active · ${conns.idle_tx} idle in transaction`, percent(conns.total, maxConn)),
        stat('Cache hit rate', hitRate === null ? '—' : `${hitRate}%`, 'shared buffers vs disk reads — higher is better'),
        stat('Transactions', count(s.commits), `${count(s.rollbacks)} rolled back`),
        stat('Rows written', count(Number(s.ins || 0) + Number(s.upd || 0) + Number(s.del || 0)), `${count(s.ret)} read`),
        stat('Deadlocks', count(s.deadlocks), `${bytes(s.temp)} temp files`),
        stat('Shared buffers', settingText(settings.shared_buffers), `work_mem ${settingText(settings.work_mem)}`),
      ],
      info: [
        kv('Server', [
          ['Version', small(id.full)],
          ['Port', settingText(settings.port)],
          ['Listen addresses', code(settingText(settings.listen_addresses))],
          ['Data directory', settings.data_directory ? code(settings.data_directory.setting) : 'hidden (needs superuser)'],
          ['Config file', settings.config_file ? code(settings.config_file.setting) : '—'],
          ['WAL level', settingText(settings.wal_level)],
          ['TLS', settingText(settings.ssl)],
        ]),
        kv('Session', [
          ['Connected as', code(id.user)],
          ['Database', code(id.db)],
          ['Encoding', settingText(settings.server_encoding)],
          ['Time zone', settingText(settings.TimeZone)],
          ['Effective cache size', settingText(settings.effective_cache_size)],
          ['Read-only by default', settingText(settings.default_transaction_read_only)],
        ]),
      ],
      tables: [
        table('Current sessions', ['PID', 'User', 'Database', 'Client', 'State', num('Time'), 'Query'],
          sessions.map((p) => [p.pid, text(p.usename), text(p.datname), small(text(p.client)), text(p.state), `${p.secs ?? 0}s`, small(text(p.query))]),
          'No client sessions (or this role cannot see them)'),
      ],
    };
  });
}

export async function databases(cfg) {
  return withPg(cfg, async (open) => {
    const c = await open();
    const list = await rows(c, `SELECT d.datname AS name, pg_get_userbyid(d.datdba) AS owner,
      pg_encoding_to_char(d.encoding) AS encoding, d.datcollate AS collate, d.datconnlimit AS connlimit,
      CASE WHEN has_database_privilege(d.datname, 'CONNECT') THEN pg_database_size(d.datname) END AS size,
      s.numbackends AS sessions, s.xact_commit AS commits, s.blks_hit AS hit, s.blks_read AS read
      FROM pg_database d LEFT JOIN pg_stat_database s ON s.datid = d.oid
      WHERE NOT d.datistemplate ORDER BY size DESC NULLS LAST`);
    const roles = (await rows(c, "SELECT rolname FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY 1")).map((r) => r.rolname);
    const user = list.filter((d) => !SYSTEM_DATABASES.includes(d.name));

    return {
      stats: [
        stat('Databases', user.length, `${list.length - user.length} system`),
        stat('Size', bytes(list.reduce((n, d) => n + Number(d.size || 0), 0)), 'all databases'),
        stat('Sessions', count(list.reduce((n, d) => n + Number(d.sessions || 0), 0)), 'connected now'),
        stat('Transactions', count(list.reduce((n, d) => n + Number(d.commits || 0), 0)), 'committed since stats reset'),
      ],
      columns: ['Database', 'Owner', num('Size'), num('Sessions'), num('Commits'), num('Cache hit'), 'Encoding / collation'],
      rows: list.map((d) => ({
        name: d.name,
        system: SYSTEM_DATABASES.includes(d.name),
        cells: [
          link(d.name, { database: d.name }), text(d.owner), bytes(d.size), count(d.sessions), count(d.commits),
          (() => { const p = percent(d.hit, Number(d.hit || 0) + Number(d.read || 0)); return p === null ? '—' : `${p}%`; })(),
          small(`${d.encoding} / ${d.collate}`),
        ],
      })),
      caps: {
        create: true,
        drop: true,
        dropLabel: 'Drop',
        createFields: [
          field('name', 'Name', { required: true, placeholder: 'shop_production' }),
          field('owner', 'Owner', { type: 'select', options: [{ value: '', label: `${cfg.user} (you)` }, ...roles.map((r) => ({ value: r, label: r }))], hint: 'The role that owns it can create tables in it — usually the app\'s own user.' }),
          field('encoding', 'Encoding', { default: 'UTF8' }),
        ],
        dropFields: [field('force', 'Disconnect everyone using it first (PostgreSQL 13+)', { type: 'checkbox' })],
      },
    };
  });
}

export async function database(cfg, name) {
  return withPg(cfg, async (open) => {
    const root = await open();
    const d = await first(root, `SELECT d.datname AS name, pg_get_userbyid(d.datdba) AS owner, pg_encoding_to_char(d.encoding) AS encoding,
      d.datcollate AS collate, d.datconnlimit AS connlimit, pg_database_size(d.datname) AS size,
      s.numbackends AS sessions, s.xact_commit AS commits, s.xact_rollback AS rollbacks, s.blks_hit AS hit, s.blks_read AS read,
      s.deadlocks, s.tup_inserted AS ins, s.tup_updated AS upd, s.tup_deleted AS del
      FROM pg_database d LEFT JOIN pg_stat_database s ON s.datid = d.oid WHERE d.datname = $1`, [name]);
    if (!d.name) throw new Error(`Database "${name}" does not exist`);

    const access = await rows(root, `SELECT r.rolname AS role, r.rolsuper AS super,
      has_database_privilege(r.oid, $1, 'CONNECT') AS connect, has_database_privilege(r.oid, $1, 'CREATE') AS "create",
      has_database_privilege(r.oid, $1, 'TEMP') AS temp FROM pg_roles r WHERE r.rolcanlogin ORDER BY 1`, [name]);
    const sessions = await rows(root, `SELECT pid, usename, client_addr::text AS client, state,
      extract(epoch FROM now() - coalesce(query_start, backend_start))::int AS secs, left(query, 120) AS query
      FROM pg_stat_activity WHERE datname = $1 AND backend_type = 'client backend'`, [name]);

    const c = await open(name);
    const tables = await rows(c, `SELECT n.nspname AS schema, c.relname AS name, greatest(c.reltuples, 0)::bigint AS est,
      pg_total_relation_size(c.oid) AS total, pg_relation_size(c.oid) AS data, pg_indexes_size(c.oid) AS idx,
      s.n_live_tup AS live, s.n_dead_tup AS dead, s.seq_scan, s.idx_scan, greatest(s.last_vacuum, s.last_autovacuum) AS vacuumed
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
      WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast'
      ORDER BY total DESC LIMIT 300`);
    const objects = await first(c, `SELECT
      count(*) FILTER (WHERE c.relkind IN ('r','p'))::int AS tables, count(*) FILTER (WHERE c.relkind = 'v')::int AS views,
      count(*) FILTER (WHERE c.relkind = 'm')::int AS matviews, count(*) FILTER (WHERE c.relkind = 'i')::int AS indexes,
      count(*) FILTER (WHERE c.relkind = 'S')::int AS sequences
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast'`);
    const fns = await first(c, `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema')`);
    const schemas = await rows(c, `SELECT nspname AS name, pg_get_userbyid(nspowner) AS owner FROM pg_namespace
      WHERE nspname NOT IN ('pg_catalog','information_schema') AND nspname !~ '^pg_(toast|temp)' ORDER BY 1`);
    const extensions = await rows(c, 'SELECT extname AS name, extversion AS version FROM pg_extension ORDER BY 1');

    const hit = percent(d.hit, Number(d.hit || 0) + Number(d.read || 0));
    const rowsTotal = tables.reduce((n, t) => n + Number(t.live ?? t.est ?? 0), 0);
    const dead = tables.reduce((n, t) => n + Number(t.dead || 0), 0);

    return {
      title: d.name,
      charset: `${d.encoding} / ${d.collate}`,
      stats: [
        stat('Size', bytes(d.size), `${d.encoding} / ${d.collate}`),
        stat('Tables', objects.tables, `${objects.views} views · ${objects.matviews} materialized`),
        stat('Rows (live)', count(rowsTotal), `${count(dead)} dead — vacuum reclaims them`),
        stat('Indexes', objects.indexes, `${objects.sequences} sequences · ${fns.n} functions`),
        stat('Users with access', access.filter((a) => a.connect).length, `owner ${d.owner}`),
        stat('Open sessions', count(d.sessions), d.connlimit >= 0 ? `limit ${d.connlimit}` : 'no connection limit'),
        stat('Cache hit rate', hit === null ? '—' : `${hit}%`, `${count(d.commits)} commits · ${count(d.rollbacks)} rollbacks`),
        stat('Deadlocks', count(d.deadlocks), `${count(Number(d.ins || 0) + Number(d.upd || 0) + Number(d.del || 0))} rows written`),
      ],
      tables: [
        table('Tables', ['Table', num('Rows'), num('Data'), num('Indexes'), num('Total'), num('Dead rows'), num('Seq / index scans'), 'Last vacuum'],
          tables.map((t) => [
            link(`${t.schema === 'public' ? '' : `${t.schema}.`}${t.name}`, { database: name, item: `${t.schema}.${t.name}` }),
            count(t.live ?? t.est), bytes(t.data), bytes(t.idx), bytes(t.total), count(t.dead),
            `${count(t.seq_scan)} / ${count(t.idx_scan)}`, small(t.vacuumed ? text(t.vacuumed).slice(0, 16).replace('T', ' ') : 'never'),
          ]), 'This database has no tables'),
        table('Users with access', ['Role', 'Privileges'],
          access.filter((a) => a.connect || a.create).map((a) => [
            a.role === d.owner ? `${a.role} (owner)` : a.role,
            a.super ? badge('superuser — everything', 'warn') : small(['CONNECT', a.create && 'CREATE', a.temp && 'TEMP'].filter(Boolean).join(', ')),
          ]), 'No login role can connect'),
        table('Schemas', ['Schema', 'Owner'], schemas.map((s) => [code(s.name), text(s.owner)])),
        ...(extensions.length ? [table('Extensions', ['Extension', 'Version'], extensions.map((e) => [e.name, e.version]))] : []),
        ...(sessions.length ? [table('Open sessions', ['PID', 'User', 'Client', 'State', num('Time'), 'Query'],
          sessions.map((p) => [p.pid, text(p.usename), small(text(p.client)), text(p.state), `${p.secs ?? 0}s`, small(text(p.query))]))] : []),
      ],
    };
  });
}

/** One table: its columns, indexes and a few rows. `item` is "schema.table". */
export async function item(cfg, database, item) {
  const [schema, ...rest] = String(item).split('.');
  const tableName = rest.join('.');
  return withPg(cfg, async (open) => {
    const c = await open(database);
    const columns = await rows(c, `SELECT column_name AS name, data_type AS type, character_maximum_length AS len,
      is_nullable AS nullable, column_default AS def FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`, [schema, tableName]);
    if (!columns.length) throw new Error(`Table ${item} does not exist`);
    const indexes = await rows(c, 'SELECT indexname AS name, indexdef AS def FROM pg_indexes WHERE schemaname = $1 AND tablename = $2', [schema, tableName]);
    const sample = await maybe(c, `SELECT * FROM ${ident(c, schema)}.${ident(c, tableName)} LIMIT 20`);

    return {
      title: `${database} › ${item}`,
      tables: [
        table('Columns', ['Column', 'Type', 'Null', 'Default'], columns.map((col) => [
          { text: col.name }, code(col.len ? `${col.type}(${col.len})` : col.type), col.nullable, small(text(col.def)),
        ])),
        table('Indexes', ['Index', 'Definition'], indexes.map((i) => [i.name, small(i.def)]), 'No indexes'),
        ...(sample ? [table('First 20 rows', columns.map((col) => col.name), sample.map((r) => columns.map((col) => small(text(r[col.name], 80)))), 'The table is empty')] : []),
      ],
    };
  });
}

/* ------------------------------------------------------------- users */

const ACCESS = {
  readonly: 'Read only — SELECT on every table',
  readwrite: 'Read and write — SELECT, INSERT, UPDATE, DELETE',
  all: 'Full access — every privilege on the database and its tables',
  owner: 'Owner — hand the database over to this user',
};

export async function users(cfg) {
  return withPg(cfg, async (open) => {
    const c = await open();
    const me = (await first(c, 'SELECT current_user AS me')).me;
    const list = await rows(c, `SELECT r.rolname AS name, r.rolsuper AS super, r.rolcreatedb AS createdb, r.rolcreaterole AS createrole,
      r.rolcanlogin AS login, r.rolreplication AS replication, r.rolconnlimit AS connlimit, r.rolvaliduntil AS valid_until,
      ARRAY(SELECT b.rolname::text FROM pg_auth_members m JOIN pg_roles b ON m.roleid = b.oid WHERE m.member = r.oid ORDER BY 1) AS member_of
      FROM pg_roles r WHERE r.rolname !~ '^pg_' ORDER BY r.rolcanlogin DESC, 1`);
    const owned = await rows(c, `SELECT pg_get_userbyid(datdba) AS role, datname AS db FROM pg_database WHERE NOT datistemplate`);
    // Explicit grants only: every role can CONNECT through PUBLIC by default, which says nothing.
    const explicit = await rows(c, `SELECT pg_get_userbyid(a.grantee) AS role, d.datname AS db,
      string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type) AS privs
      FROM pg_database d CROSS JOIN LATERAL aclexplode(d.datacl) a
      WHERE NOT d.datistemplate AND a.grantee <> 0 AND a.grantee <> d.datdba GROUP BY 1, 2`);
    const sessions = Object.fromEntries((await rows(c, `SELECT usename, count(*)::int AS n FROM pg_stat_activity
      WHERE backend_type = 'client backend' GROUP BY usename`)).map((r) => [r.usename, r.n]));
    const dbs = (await rows(c, 'SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY 1')).map((r) => r.datname);

    const users = list.map((u) => {
      const grants = [
        u.super ? 'SUPERUSER — every privilege everywhere' : null,
        u.createdb ? 'CREATEDB' : null,
        u.createrole ? 'CREATEROLE' : null,
        u.replication ? 'REPLICATION' : null,
        u.member_of?.length ? `member of ${u.member_of.join(', ')}` : null,
        ...owned.filter((p) => p.role === u.name).map((p) => `owner of ${p.db}`),
        ...explicit.filter((p) => p.role === u.name).map((p) => `${p.privs} on ${p.db}`),
      ].filter(Boolean);
      return {
        key: { name: u.name },
        label: u.name,
        self: u.name === me,
        locked: !u.login,
        cells: [
          { text: u.name, code: false },
          u.super ? badge('superuser', 'warn') : u.login ? badge('can log in', 'ok') : badge('no login', 'err'),
          u.connlimit >= 0 ? String(u.connlimit) : 'no limit',
          u.valid_until ? small(text(u.valid_until).slice(0, 10)) : 'never',
          count(sessions[u.name] || 0),
        ],
        grants,
      };
    });

    return {
      currentUser: me,
      note: `Connected as ${me}. Managing roles needs superuser or CREATEROLE. "No login" roles are groups, or users that were locked.`,
      stats: [
        stat('Total users', users.length, 'roles, excluding built-in pg_* roles'),
        stat('Can log in', list.filter((u) => u.login).length, `${Object.keys(sessions).length} connected now`),
        stat('Superusers', list.filter((u) => u.super).length, 'bypass every permission check'),
        stat('Locked / groups', list.filter((u) => !u.login).length, 'NOLOGIN'),
      ],
      columns: ['Role', 'State', 'Connection limit', 'Password expires', num('Sessions')],
      users,
      caps: {
        lock: true,
        lockLabel: ['Lock (NOLOGIN)', 'Unlock (LOGIN)'],
        grantFields: [
          field('database', 'On database', { type: 'select', options: dbs.map((d) => ({ value: d, label: d })), required: true }),
          field('access', 'Access', { type: 'select', options: Object.entries(ACCESS).map(([value, labelText]) => ({ value, label: labelText })), default: 'readwrite' }),
        ],
        revokeFields: [field('database', 'On database', { type: 'select', options: dbs.map((d) => ({ value: d, label: d })), required: true })],
        createFields: [
          field('name', 'Username', { required: true, placeholder: 'shop_app' }),
          field('password', 'Password', { type: 'password', required: true }),
          field('database', 'Access to database', { type: 'select', options: [{ value: '', label: '— none yet —' }, ...dbs.map((d) => ({ value: d, label: d }))] }),
          field('access', 'Access', { type: 'select', options: Object.entries(ACCESS).map(([value, labelText]) => ({ value, label: labelText })), default: 'readwrite' }),
          field('createdb', 'May create databases (CREATEDB)', { type: 'checkbox' }),
          field('connlimit', 'Connection limit', { type: 'number', placeholder: 'no limit' }),
        ],
        passwordFields: [field('connlimit', 'Connection limit (optional, -1 for none)', { type: 'number' })],
      },
    };
  });
}

/** Give `role` one of the ACCESS levels on `database`. Needs a connection into that database. */
async function applyAccess(open, role, database, access) {
  if (!ACCESS[access]) throw new Error('Pick an access level');
  const root = await open();
  const r = ident(root, role);
  const d = ident(root, database);

  if (access === 'owner') {
    await root.query(`ALTER DATABASE ${d} OWNER TO ${r}`);
    const c = await open(database);
    await c.query(`ALTER SCHEMA public OWNER TO ${r}`).catch(() => {});
    return;
  }

  await root.query(`GRANT ${access === 'all' ? 'ALL PRIVILEGES' : 'CONNECT, TEMPORARY'} ON DATABASE ${d} TO ${r}`);
  const c = await open(database);
  const tablePrivs = { readonly: 'SELECT', readwrite: 'SELECT, INSERT, UPDATE, DELETE', all: 'ALL PRIVILEGES' }[access];
  const seqPrivs = access === 'readonly' ? 'SELECT' : access === 'readwrite' ? 'USAGE, SELECT' : 'ALL PRIVILEGES';
  const schemaPrivs = access === 'all' ? 'USAGE, CREATE' : 'USAGE';
  const statements = [
    `GRANT ${schemaPrivs} ON SCHEMA public TO ${r}`,
    `GRANT ${tablePrivs} ON ALL TABLES IN SCHEMA public TO ${r}`,
    `GRANT ${seqPrivs} ON ALL SEQUENCES IN SCHEMA public TO ${r}`,
    // Tables created later by the account the panel uses get the same grants.
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ${tablePrivs} ON TABLES TO ${r}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ${seqPrivs} ON SEQUENCES TO ${r}`,
  ];
  for (const sql of statements) await c.query(sql);
}

export async function createUser(cfg, body) {
  const name = checkName(body.name, 'Username');
  const password = checkPassword(body.password);
  return withPg(cfg, async (open) => {
    const c = await open();
    const limit = body.connlimit === '' || body.connlimit === undefined ? -1 : Number(body.connlimit);
    if (!Number.isInteger(limit) || limit < -1) throw new Error('Connection limit must be -1 (none) or more');
    await c.query(`CREATE ROLE ${ident(c, name)} LOGIN PASSWORD ${literal(c, password)}${body.createdb ? ' CREATEDB' : ''} CONNECTION LIMIT ${limit}`);
    if (body.database) await applyAccess(open, name, body.database, body.access || 'readwrite');
    return { summary: `Created role ${name}${body.database ? ` with ${body.access || 'readwrite'} access to ${body.database}` : ''}` };
  });
}

export async function alterUser(cfg, key, body) {
  const name = checkName(key?.name, 'Username');
  return withPg(cfg, async (open) => {
    const c = await open();
    const me = (await first(c, 'SELECT current_user AS me')).me;
    const changed = [];
    if (body.password) {
      await c.query(`ALTER ROLE ${ident(c, name)} PASSWORD ${literal(c, checkPassword(body.password))}`);
      changed.push('password');
    }
    if (body.locked !== undefined) {
      if (body.locked && me === name) throw new Error('The panel is signed in as this role — locking it would lock the panel out');
      await c.query(`ALTER ROLE ${ident(c, name)} ${body.locked ? 'NOLOGIN' : 'LOGIN'}`);
      changed.push(body.locked ? 'locked' : 'unlocked');
    }
    if (body.connlimit !== undefined && body.connlimit !== '') {
      const n = Number(body.connlimit);
      if (!Number.isInteger(n) || n < -1) throw new Error('Connection limit must be -1 (none) or more');
      await c.query(`ALTER ROLE ${ident(c, name)} CONNECTION LIMIT ${n}`);
      changed.push(`connection limit ${n}`);
    }
    if (!changed.length) throw new Error('Nothing to change');
    return { summary: `${name}: ${changed.join(', ')}` };
  });
}

export async function dropUser(cfg, key) {
  const name = checkName(key?.name, 'Username');
  return withPg(cfg, async (open) => {
    const c = await open();
    if ((await first(c, 'SELECT current_user AS me')).me === name) throw new Error('The panel is signed in as this role — it cannot drop itself');
    try {
      await c.query(`DROP ROLE ${ident(c, name)}`);
      return { summary: `Dropped role ${name}` };
    } catch (err) {
      if (!/depend/i.test(err.message)) throw err;
    }

    // Grants and owned objects live in each database, so visit every one:
    // hand what it owns to the panel's role first, so DROP OWNED only has
    // privileges left to remove and no table is ever deleted.
    const me = (await first(c, 'SELECT current_user AS me')).me;
    const dbs = (await rows(c, 'SELECT datname FROM pg_database WHERE datallowconn ORDER BY 1')).map((r) => r.datname);
    for (const db of dbs) {
      const dc = await open(db);
      await dc.query(`REASSIGN OWNED BY ${ident(dc, name)} TO ${ident(dc, me)}`);
      await dc.query(`DROP OWNED BY ${ident(dc, name)}`);
    }
    await c.query(`DROP ROLE ${ident(c, name)}`);
    return { summary: `Dropped role ${name}. Anything it owned now belongs to ${me}.` };
  });
}

export async function grant(cfg, key, body) {
  const name = checkName(key?.name, 'Username');
  if (!body.database) throw new Error('Pick a database');
  return withPg(cfg, async (open) => {
    await applyAccess(open, name, body.database, body.access || 'readwrite');
    return { summary: `${name} now has ${body.access || 'readwrite'} access to ${body.database}` };
  });
}

export async function revoke(cfg, key, body) {
  const name = checkName(key?.name, 'Username');
  if (!body.database) throw new Error('Pick a database');
  return withPg(cfg, async (open) => {
    const root = await open();
    const r = ident(root, name);
    await root.query(`REVOKE ALL PRIVILEGES ON DATABASE ${ident(root, body.database)} FROM ${r}`);
    const c = await open(body.database);
    for (const sql of [
      `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${r}`,
      `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${r}`,
      `REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${r}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM ${r}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM ${r}`,
    ]) await c.query(sql);
    return { summary: `Revoked ${name}'s privileges on ${body.database}. Every role can still CONNECT unless PUBLIC's CONNECT is revoked.` };
  });
}

/* --------------------------------------------------------- databases */

export async function createDatabase(cfg, body) {
  const name = checkName(body.name, 'Database name');
  const encoding = String(body.encoding || 'UTF8').trim();
  if (!/^[A-Za-z0-9_]{1,20}$/.test(encoding)) throw new Error('Unknown encoding');
  return withPg(cfg, async (open) => {
    const c = await open();
    const owner = body.owner ? ` OWNER ${ident(c, checkName(body.owner, 'Owner'))}` : '';
    await c.query(`CREATE DATABASE ${ident(c, name)}${owner} ENCODING ${literal(c, encoding)} TEMPLATE template0`);
    return { summary: `Created database ${name}` };
  });
}

export async function dropDatabase(cfg, body) {
  const name = String(body.name || '');
  if (SYSTEM_DATABASES.includes(name)) throw new Error(`"${name}" is a PostgreSQL system database`);
  checkConfirm(name, body.confirm);
  // Cannot drop the database you are standing in, so stand somewhere else.
  const standIn = { ...cfg, database: cfg.database && cfg.database !== name ? cfg.database : 'postgres' };
  return withPg(standIn, async (open) => {
    const c = await open();
    const major = Number((await first(c, "SELECT current_setting('server_version_num')::int / 10000 AS v")).v);
    await c.query(`DROP DATABASE ${ident(c, name)}${body.force && major >= 13 ? ' WITH (FORCE)' : ''}`);
    return { summary: `Dropped database ${name}` };
  });
}

/* ------------------------------------------------------ configuration */

/** Settings the panel lets you change with ALTER SYSTEM. */
const EDITABLE = {
  max_connections: { group: 'Connections', hint: 'Most client connections at once' },
  superuser_reserved_connections: { group: 'Connections', hint: 'Slots kept free for superusers' },
  idle_in_transaction_session_timeout: { group: 'Timeouts', hint: 'Kill sessions idling inside a transaction (0 = never)' },
  statement_timeout: { group: 'Timeouts', hint: 'Cancel any statement running longer (0 = never)' },
  lock_timeout: { group: 'Timeouts', hint: 'Give up waiting for a lock after this long (0 = never)' },
  shared_buffers: { group: 'Memory', hint: 'PostgreSQL\'s own cache — about 25% of RAM' },
  effective_cache_size: { group: 'Memory', hint: 'How much the OS caches too; guides the planner (~50–75% of RAM)' },
  work_mem: { group: 'Memory', hint: 'Per sort / hash before spilling to disk' },
  maintenance_work_mem: { group: 'Memory', hint: 'For VACUUM, CREATE INDEX and friends' },
  max_wal_size: { group: 'Write-ahead log', hint: 'WAL kept between checkpoints' },
  checkpoint_timeout: { group: 'Write-ahead log', hint: 'Longest time between checkpoints' },
  random_page_cost: { group: 'Planner', hint: '1.1 for SSDs, 4 for spinning disks' },
  default_statistics_target: { group: 'Planner', hint: 'How detailed ANALYZE statistics are' },
  autovacuum: { group: 'Maintenance', hint: 'Background vacuum and analyze — leave on' },
  log_min_duration_statement: { group: 'Logging', hint: 'Log statements slower than this (-1 = off)' },
  log_statement: { group: 'Logging', hint: 'Which statements to log' },
  log_connections: { group: 'Logging', hint: 'Log every connection' },
  log_disconnections: { group: 'Logging', hint: 'Log every disconnection with its duration' },
  TimeZone: { group: 'Behaviour', hint: 'Default time zone for sessions' },
  default_transaction_isolation: { group: 'Behaviour', hint: 'Isolation level of new transactions' },
};

export async function config(cfg) {
  return withPg(cfg, async (open) => {
    const c = await open();
    const all = await rows(c, `SELECT name, setting, unit, vartype, enumvals, context, short_desc, pending_restart, source
      FROM pg_settings ORDER BY name`);
    const byName = Object.fromEntries(all.map((r) => [r.name, r]));
    const superuser = (await first(c, 'SELECT rolsuper FROM pg_roles WHERE rolname = current_user')).rolsuper;

    return {
      note: `Changes are written with ALTER SYSTEM to postgresql.auto.conf and the configuration is reloaded, so they persist.
        Settings marked "restart" only take effect after PostgreSQL restarts.${superuser ? '' : ' This role is not a superuser, so ALTER SYSTEM will be refused.'}`,
      persistLabel: null,
      editable: Object.entries(EDITABLE).filter(([n]) => byName[n]).map(([n, meta]) => {
        const r = byName[n];
        return {
          name: n,
          value: r.setting,
          display: settingText(r) + (r.pending_restart ? ' — restart pending' : ''),
          hint: meta.hint,
          group: meta.group,
          type: r.vartype === 'bool' ? 'bool' : r.vartype === 'enum' ? 'enum' : r.vartype === 'string' ? 'text' : 'number',
          options: r.vartype === 'enum' ? r.enumvals : null,
          unit: r.unit || null,
          restart: r.context === 'postmaster',
        };
      }),
      all: all.map((r) => ({ name: r.name, value: settingText(r), hint: r.short_desc })),
    };
  });
}

export async function setConfig(cfg, body) {
  const name = String(body.name || '');
  if (!EDITABLE[name]) throw new Error(`"${name}" cannot be changed from the panel`);
  const value = String(body.value ?? '').trim();
  if (!value || value.length > 200) throw new Error('A value is required');
  return withPg(cfg, async (open) => {
    const c = await open();
    const r = await first(c, 'SELECT vartype, enumvals, unit, context FROM pg_settings WHERE name = $1', [name]);
    if (r.vartype === 'integer' && !/^-?\d+\s*(B|kB|MB|GB|TB|ms|s|min|h|d)?$/.test(value)) throw new Error(`${name} must be a whole number${r.unit ? ` (in ${r.unit}, or with a unit like 256MB / 30s)` : ''}`);
    if (r.vartype === 'real' && !/^-?\d+(\.\d+)?$/.test(value)) throw new Error(`${name} must be a number`);
    if (r.vartype === 'bool' && !/^(on|off|true|false)$/i.test(value)) throw new Error(`${name} must be on or off`);
    if (r.vartype === 'enum' && !r.enumvals.includes(value)) throw new Error(`${name} must be one of ${r.enumvals.join(', ')}`);

    await c.query(`ALTER SYSTEM SET ${ident(c, name)} = ${literal(c, value)}`);
    await c.query('SELECT pg_reload_conf()');
    const after = await first(c, 'SELECT setting, unit, pending_restart FROM pg_settings WHERE name = $1', [name]);
    return {
      summary: after.pending_restart || r.context === 'postmaster'
        ? `${name} saved — takes effect after PostgreSQL restarts`
        : `${name} = ${settingText(after)}`,
    };
  });
}

/* ---------------------------------------------------------------- query */

export const queryHelp = {
  placeholder: 'SELECT * FROM customers ORDER BY id DESC LIMIT 20',
  hint: 'Runs inside a READ ONLY transaction that is rolled back afterwards, so nothing can be changed. One statement, 20 second limit, first 200 rows.',
  databaseLabel: 'Database',
};

export async function query(cfg, { text: sql, database }) {
  const trimmed = String(sql || '').trim().replace(/;\s*$/, '');
  if (!trimmed) throw new Error('A query is required');
  if (!/^(SELECT|WITH|SHOW|EXPLAIN|TABLE|VALUES)\b/i.test(trimmed)) throw new Error('Only SELECT, WITH, SHOW, EXPLAIN, TABLE and VALUES run here');

  return withPg(cfg, async (open) => {
    const c = await open(database || undefined);
    const started = Date.now();
    await c.query('BEGIN READ ONLY');
    try {
      await c.query("SET LOCAL statement_timeout = '20s'");
      // A named (prepared) statement cannot carry a second statement behind a ";".
      const r = await c.query({ name: `panel_ro_${Date.now()}`, text: trimmed, rowMode: 'array' });
      const list = r.rows || [];
      return {
        columns: (r.fields || []).map((f) => f.name),
        rows: list.slice(0, 200).map((row) => row.map((v) => text(v, 500))),
        rowCount: list.length,
        truncated: list.length > 200,
        durationMs: Date.now() - started,
      };
    } finally {
      await c.query('ROLLBACK').catch(() => {});
    }
  });
}
