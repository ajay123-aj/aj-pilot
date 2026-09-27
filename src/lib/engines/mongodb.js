import { MongoClient } from 'mongodb';
import { withTunnel } from '../tunnel.js';
import {
  stat, kv, table, num, badge, code, small, link, field, bytes, count, uptime, percent, text,
  checkPassword, checkConfirm, unsupported,
} from './shape.js';

export const label = 'MongoDB';

const SYSTEM_DATABASES = ['admin', 'local', 'config'];
const NAME_RE = /^[A-Za-z0-9_-]{1,63}$/;
const USER_RE = /^[A-Za-z0-9_.@-]{1,64}$/;

/** Roles scoped to one database, and the ones that only exist on "admin" and reach every database. */
const DB_ROLES = ['read', 'readWrite', 'dbAdmin', 'dbOwner', 'userAdmin'];
const GLOBAL_ROLES = ['readAnyDatabase', 'readWriteAnyDatabase', 'dbAdminAnyDatabase', 'userAdminAnyDatabase', 'clusterMonitor', 'backup', 'restore', 'root'];
const ROLE_TEXT = {
  read: 'read — find only',
  readWrite: 'readWrite — read and change documents',
  dbAdmin: 'dbAdmin — indexes, stats, schema; not data',
  dbOwner: 'dbOwner — everything on this database',
  userAdmin: 'userAdmin — manage users of this database',
  readAnyDatabase: 'readAnyDatabase — read every database',
  readWriteAnyDatabase: 'readWriteAnyDatabase — read and write every database',
  dbAdminAnyDatabase: 'dbAdminAnyDatabase',
  userAdminAnyDatabase: 'userAdminAnyDatabase — manage every user',
  clusterMonitor: 'clusterMonitor — read server stats',
  backup: 'backup', restore: 'restore',
  root: 'root — everything',
};

/* ------------------------------------------------------------ connecting */

async function withMongo(cfg, fn) {
  // A full connection string (mongodb+srv://… for Atlas) is used as it is.
  if (/^mongodb(\+srv)?:\/\//.test(cfg.host)) return connect(cfg, cfg.host, fn);
  return withTunnel(cfg.server, cfg.host, cfg.port, ({ host, port }) => connect(cfg, `mongodb://${host.includes(':') ? `[${host}]` : host}:${port}/`, fn));
}

async function connect(cfg, uri, fn) {
  const client = new MongoClient(uri, {
    ...(cfg.user ? { auth: { username: cfg.user, password: cfg.password }, authSource: cfg.authSource || 'admin' } : {}),
    ...(/^mongodb\+srv/.test(uri) ? {} : { directConnection: true }),
    tls: cfg.tls || undefined,
    tlsAllowInvalidCertificates: cfg.tls || undefined,
    serverSelectionTimeoutMS: 12000,
    connectTimeoutMS: 12000,
    appName: 'aj-pilot-panel',
  });
  try {
    await client.connect();
  } catch (err) {
    throw friendly(err);
  }
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

function friendly(err) {
  const msg = String(err?.message || err);
  const map = [
    [/Authentication failed|auth.*fail/i, 'Authentication failed — check the username, password and auth database.'],
    [/ECONNREFUSED/i, 'Connection refused — MongoDB is not listening on that host and port.'],
    [/Server selection timed out|ETIMEDOUT|timed out/i, 'Timed out reaching MongoDB. It may listen on localhost only — tie this connection to a server so the panel tunnels over SSH.'],
    [/ENOTFOUND|EAI_AGAIN/i, 'Host not found — the hostname could not be resolved.'],
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

const admin = (client) => client.db('admin');
const maybe = async (p) => { try { return await p; } catch { return null; } };

function checkDbName(name) {
  if (!NAME_RE.test(String(name || ''))) throw new Error('Database names may use letters, digits, "_" and "-" (up to 63 characters)');
  return String(name);
}

/** Users across every database, when this account may see them. */
async function allUsers(client) {
  const r = await maybe(admin(client).command({ usersInfo: { forAllDBs: true } }));
  return r?.users || null;
}

/* ------------------------------------------------------------- reading */

export async function test(cfg) {
  const started = Date.now();
  const r = await withMongo(cfg, async (client) => {
    const info = await admin(client).command({ buildInfo: 1 });
    const status = await admin(client).command({ connectionStatus: 1 });
    return { version: info.version, user: status.authInfo?.authenticatedUsers?.[0]?.user || '(no auth)' };
  });
  return { version: `MongoDB ${r.version}`, currentUser: r.user, latencyMs: Date.now() - started };
}

export async function overview(cfg) {
  const started = Date.now();
  return withMongo(cfg, async (client) => {
    const build = await admin(client).command({ buildInfo: 1 });
    const s = await maybe(admin(client).command({ serverStatus: 1 }));
    const dbs = await admin(client).command({ listDatabases: 1 });
    const users = await allUsers(client);
    const hello = await maybe(admin(client).command({ hello: 1 }));
    // Client operations only — MongoDB's own background threads have no client.
    const ops = await maybe(admin(client).aggregate([
      { $currentOp: { allUsers: true, idleConnections: false } }, { $match: { client: { $exists: true } } }, { $limit: 25 },
    ]).toArray());
    const status = await admin(client).command({ connectionStatus: 1 });

    const user = dbs.databases.filter((d) => !SYSTEM_DATABASES.includes(d.name));
    const c = s?.connections || {};
    const maxConn = Number(c.current || 0) + Number(c.available || 0);
    const op = s?.opcounters || {};
    const cache = s?.wiredTiger?.cache || {};
    const cacheUsed = cache['bytes currently in the cache'];
    const cacheMax = cache['maximum bytes configured'];

    return {
      durationMs: Date.now() - started,
      counts: { databases: user.length, users: users?.length ?? null },
      stats: [
        stat('Version', `MongoDB ${build.version}`, s?.storageEngine?.name ? `engine ${s.storageEngine.name}` : ''),
        stat('Uptime', s ? uptime(s.uptime) : '—', s ? '' : 'serverStatus needs clusterMonitor'),
        stat('Databases', user.length, `${bytes(dbs.totalSize)} on disk`),
        stat('Users', users ? users.length : '—', users ? `across ${new Set(users.map((u) => u.db)).size} auth databases` : 'this account cannot list users'),
        stat('Connections', s ? `${c.current} / ${maxConn}` : '—', s ? `${count(c.totalCreated)} opened since start` : '', s ? percent(c.current, maxConn) : null),
        stat('Queries', count(op.query), `${count(op.insert)} inserts · ${count(op.update)} updates · ${count(op.delete)} deletes`),
        stat('Commands', count(op.command), `${count(op.getmore)} getMore`),
        stat('Memory', s?.mem?.resident ? bytes(s.mem.resident * 1024 * 1024) : '—', s?.mem?.virtual ? `${bytes(s.mem.virtual * 1024 * 1024)} virtual` : ''),
        stat('Cache', cacheUsed ? bytes(cacheUsed) : '—', cacheMax ? `of ${bytes(cacheMax)} WiredTiger cache` : '', cacheMax ? percent(cacheUsed, cacheMax) : null),
        stat('Traffic', s ? bytes(s.network?.bytesOut) : '—', s ? `${bytes(s.network?.bytesIn)} received` : ''),
        stat('Role', hello?.setName ? (hello.isWritablePrimary ? 'primary' : 'secondary') : 'standalone', hello?.setName ? `replica set ${hello.setName}` : ''),
      ],
      info: [
        kv('Server', [
          ['Version', text(build.version)],
          ['Git version', small(text(build.gitVersion))],
          ['Host', s ? code(s.host) : '—'],
          ['Process', s ? text(s.process) : '—'],
          ['Storage engine', text(s?.storageEngine?.name)],
          ['Replica set', text(hello?.setName || 'none')],
        ]),
        kv('Session', [
          ['Connected as', code(status.authInfo?.authenticatedUsers?.map((u) => `${u.user}@${u.db}`).join(', ') || '(no authentication)')],
          ['Roles', small(status.authInfo?.authenticatedUserRoles?.map((r) => `${r.role}@${r.db}`).join(', ') || '—')],
          ['Auth database', code(cfg.authSource || 'admin')],
        ]),
      ],
      tables: [
        table('Current operations', ['Op ID', 'Client', 'User', 'Namespace', 'Operation', num('Running')],
          (ops || []).map((o) => [text(o.opid), small(text(o.client)), text(o.effectiveUsers?.[0]?.user), code(text(o.ns)), text(o.op), `${o.secs_running ?? 0}s`]),
          ops ? 'Nothing running right now' : 'This account cannot read currentOp'),
      ],
    };
  });
}

export async function databases(cfg) {
  return withMongo(cfg, async (client) => {
    const dbs = (await admin(client).command({ listDatabases: 1 })).databases;
    const detail = await Promise.all(dbs.map(async (d) => ({ ...d, stats: await maybe(client.db(d.name).command({ dbStats: 1 })) })));
    const total = (k) => detail.reduce((n, d) => n + Number(d.stats?.[k] || 0), 0);

    return {
      stats: [
        stat('Databases', dbs.filter((d) => !SYSTEM_DATABASES.includes(d.name)).length, `${SYSTEM_DATABASES.length} system databases`),
        stat('Collections', count(total('collections')), `${count(total('views'))} views`),
        stat('Documents', count(total('objects')), ''),
        stat('On disk', bytes(dbs.reduce((n, d) => n + Number(d.sizeOnDisk || 0), 0)), `${bytes(total('indexSize'))} of it indexes`),
      ],
      columns: ['Database', num('Collections'), num('Documents'), num('Data'), num('Indexes'), num('On disk')],
      rows: detail.map((d) => ({
        name: d.name,
        system: SYSTEM_DATABASES.includes(d.name),
        cells: [
          link(d.name, { database: d.name }), count(d.stats?.collections), count(d.stats?.objects),
          bytes(d.stats?.dataSize), bytes(d.stats?.indexSize), bytes(d.sizeOnDisk),
        ],
      })),
      caps: {
        create: true,
        drop: true,
        dropLabel: 'Drop',
        createNote: 'MongoDB only keeps a database once something is in it, so it is created with a first collection.',
        createFields: [
          field('name', 'Name', { required: true, placeholder: 'shop' }),
          field('collection', 'First collection', { required: true, default: 'items' }),
        ],
      },
    };
  });
}

export async function database(cfg, name) {
  return withMongo(cfg, async (client) => {
    const db = client.db(name);
    const st = await db.command({ dbStats: 1 });
    const colls = await db.listCollections({}, { nameOnly: false }).toArray();
    const detail = await Promise.all(colls.slice(0, 300).map(async (c) => {
      if (c.type === 'view') return { ...c };
      const agg = await maybe(db.collection(c.name).aggregate([{ $collStats: { storageStats: {} } }]).toArray());
      const ss = agg?.[0]?.storageStats;
      return { ...c, count: ss?.count ?? await maybe(db.collection(c.name).estimatedDocumentCount()), size: ss?.size, storage: ss?.storageSize, indexSize: ss?.totalIndexSize, indexes: ss?.nindexes };
    }));
    const users = await allUsers(client);
    const withAccess = (users || []).filter((u) => u.roles.some((r) => r.db === name || (r.db === 'admin' && GLOBAL_ROLES.includes(r.role))));

    return {
      title: name,
      stats: [
        stat('Collections', count(st.collections), `${count(st.views)} views`),
        stat('Documents', count(st.objects), st.avgObjSize ? `avg ${bytes(st.avgObjSize)}` : ''),
        stat('Data', bytes(st.dataSize), `${bytes(st.storageSize)} allocated`),
        stat('Indexes', count(st.indexes), bytes(st.indexSize)),
        stat('On disk', bytes(Number(st.storageSize || 0) + Number(st.indexSize || 0)), ''),
        stat('Users with access', users ? withAccess.length : '—', users ? `${withAccess.filter((u) => u.roles.some((r) => r.db === name)).length} granted here · rest global` : 'cannot list users'),
      ],
      tables: [
        table('Collections', ['Collection', 'Type', num('Documents'), num('Data'), num('Indexes'), num('Index size'), num('Allocated')],
          detail.map((c) => [
            c.type === 'view' ? c.name : link(c.name, { database: name, item: c.name }), text(c.type),
            count(c.count), bytes(c.size), count(c.indexes), bytes(c.indexSize), bytes(c.storage),
          ]), 'No collections yet'),
        table('Users with access', ['User', 'Roles'],
          withAccess.map((u) => [`${u.user}@${u.db}`, small(u.roles.map((r) => `${r.role}@${r.db}`).join(', '))]),
          users ? 'No user has a role on this database' : 'This account cannot list users'),
      ],
    };
  });
}

export async function item(cfg, database, collection) {
  return withMongo(cfg, async (client) => {
    const coll = client.db(database).collection(collection);
    const indexes = await coll.listIndexes().toArray();
    const docs = await coll.find({}).limit(20).toArray();
    const count2 = await coll.estimatedDocumentCount();
    return {
      title: `${database} › ${collection}`,
      stats: [stat('Documents', count(count2), 'estimated'), stat('Indexes', indexes.length, '')],
      tables: [
        table('Indexes', ['Name', 'Keys', 'Options'], indexes.map((i) => [
          i.name, code(JSON.stringify(i.key)),
          small([i.unique && 'unique', i.sparse && 'sparse', i.expireAfterSeconds !== undefined && `TTL ${i.expireAfterSeconds}s`].filter(Boolean).join(', ') || '—'),
        ])),
      ],
      pre: { title: 'First 20 documents', text: JSON.stringify(docs, null, 2) || '[]' },
    };
  });
}

/* ------------------------------------------------------------- users */

const roleOptions = () => [...DB_ROLES, ...GLOBAL_ROLES].map((r) => ({ value: r, label: ROLE_TEXT[r] }));

export async function users(cfg) {
  return withMongo(cfg, async (client) => {
    const list = await allUsers(client);
    if (!list) throw new Error('This account cannot list users — it needs the userAdmin or userAdminAnyDatabase role.');
    const status = await admin(client).command({ connectionStatus: 1 });
    const me = status.authInfo?.authenticatedUsers?.[0];
    const dbs = (await admin(client).command({ listDatabases: 1, nameOnly: true })).databases.map((d) => d.name);
    const dbOptions = [{ value: '', label: '— none —' }, ...dbs.map((d) => ({ value: d, label: d }))];

    const users = list.map((u) => ({
      key: { user: u.user, db: u.db },
      label: `${u.user}@${u.db}`,
      self: Boolean(me && me.user === u.user && me.db === u.db),
      locked: false,
      cells: [
        { text: u.user },
        code(u.db),
        u.roles.some((r) => r.role === 'root') ? badge('root', 'warn') : badge(`${u.roles.length} role(s)`, u.roles.length ? 'ok' : ''),
        small((u.mechanisms || []).join(', ')),
      ],
      grants: u.roles.map((r) => `${r.role} on ${r.db === 'admin' && GLOBAL_ROLES.includes(r.role) ? 'all databases' : r.db}`),
    }));

    return {
      currentUser: me ? `${me.user}@${me.db}` : '(none)',
      note: 'Users live in an authentication database (usually admin) and hold roles on other databases. MongoDB has no account lock — revoke the roles or drop the user instead.',
      stats: [
        stat('Total users', users.length, `in ${new Set(list.map((u) => u.db)).size} auth database(s)`),
        stat('Root users', list.filter((u) => u.roles.some((r) => r.role === 'root')).length, 'can do everything'),
        stat('Without roles', list.filter((u) => !u.roles.length).length, 'can sign in but do nothing'),
        stat('Databases', dbs.length, 'roles can be granted on'),
      ],
      columns: ['User', 'Auth database', 'Roles', 'Mechanisms'],
      users,
      caps: {
        lock: false,
        grantFields: [
          field('database', 'On database', { type: 'select', options: dbs.map((d) => ({ value: d, label: d })), hint: 'Roles ending in AnyDatabase, clusterMonitor and root always go on admin.' }),
          field('role', 'Role', { type: 'select', options: roleOptions(), default: 'readWrite' }),
        ],
        revokeFields: [field('database', 'Every role on database', { type: 'select', options: dbs.map((d) => ({ value: d, label: d })), required: true })],
        createFields: [
          field('user', 'Username', { required: true, placeholder: 'shop_app' }),
          field('password', 'Password', { type: 'password', required: true }),
          field('authDb', 'Auth database', { default: 'admin', hint: 'Where the user is stored; apps put it in authSource. Keep admin unless you have a reason.' }),
          field('database', 'Role on database', { type: 'select', options: dbOptions }),
          field('role', 'Role', { type: 'select', options: roleOptions(), default: 'readWrite' }),
        ],
        passwordFields: [],
      },
    };
  });
}

function roleFor(role, database) {
  if (GLOBAL_ROLES.includes(role)) return { role, db: 'admin' };
  if (!DB_ROLES.includes(role)) throw new Error('Pick a role');
  if (!database) throw new Error('Pick the database for that role');
  return { role, db: database };
}

function checkKey(key) {
  if (!USER_RE.test(String(key?.user || '')) || !NAME_RE.test(String(key?.db || ''))) throw new Error('Unknown user');
  return key;
}

export async function createUser(cfg, body) {
  const user = String(body.user || '').trim();
  if (!USER_RE.test(user)) throw new Error('Usernames may use letters, digits, "_", ".", "@" and "-"');
  const pwd = checkPassword(body.password);
  const authDb = checkDbName(String(body.authDb || 'admin').trim());
  const roles = body.database || GLOBAL_ROLES.includes(body.role) ? [roleFor(body.role || 'readWrite', body.database)] : [];
  return withMongo(cfg, async (client) => {
    await client.db(authDb).command({ createUser: user, pwd, roles });
    return { summary: `Created ${user}@${authDb}${roles.length ? ` with ${roles[0].role} on ${roles[0].db}` : ''}` };
  });
}

export async function alterUser(cfg, key, body) {
  checkKey(key);
  if (body.locked !== undefined) throw unsupported('account lock', label);
  if (!body.password) throw new Error('Nothing to change');
  const pwd = checkPassword(body.password);
  return withMongo(cfg, async (client) => {
    await client.db(key.db).command({ updateUser: key.user, pwd });
    return { summary: `Changed the password of ${key.user}@${key.db}` };
  });
}

export async function dropUser(cfg, key) {
  checkKey(key);
  return withMongo(cfg, async (client) => {
    const me = (await admin(client).command({ connectionStatus: 1 })).authInfo?.authenticatedUsers?.[0];
    if (me && me.user === key.user && me.db === key.db) throw new Error('The panel is signed in as this user — it cannot drop itself');
    await client.db(key.db).command({ dropUser: key.user });
    return { summary: `Dropped ${key.user}@${key.db}` };
  });
}

export async function grant(cfg, key, body) {
  checkKey(key);
  const role = roleFor(body.role, body.database);
  return withMongo(cfg, async (client) => {
    await client.db(key.db).command({ grantRolesToUser: key.user, roles: [role] });
    return { summary: `Granted ${role.role} on ${role.db} to ${key.user}` };
  });
}

export async function revoke(cfg, key, body) {
  checkKey(key);
  if (!body.database) throw new Error('Pick a database');
  return withMongo(cfg, async (client) => {
    const info = await client.db(key.db).command({ usersInfo: key.user });
    const roles = (info.users?.[0]?.roles || []).filter((r) => r.db === body.database);
    if (!roles.length) throw new Error(`${key.user} has no role on ${body.database}`);
    await client.db(key.db).command({ revokeRolesFromUser: key.user, roles });
    return { summary: `Revoked ${roles.map((r) => r.role).join(', ')} on ${body.database} from ${key.user}` };
  });
}

/* --------------------------------------------------------- databases */

export async function createDatabase(cfg, body) {
  const name = checkDbName(body.name);
  if (SYSTEM_DATABASES.includes(name)) throw new Error(`"${name}" is reserved for MongoDB itself`);
  const collection = String(body.collection || 'items').trim();
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(collection) || collection.startsWith('system.')) throw new Error('That is not a usable collection name');
  return withMongo(cfg, async (client) => {
    await client.db(name).createCollection(collection);
    return { summary: `Created database ${name} with collection ${collection}` };
  });
}

export async function dropDatabase(cfg, body) {
  const name = String(body.name || '');
  if (SYSTEM_DATABASES.includes(name)) throw new Error(`"${name}" is a MongoDB system database`);
  checkConfirm(name, body.confirm);
  return withMongo(cfg, async (client) => {
    await client.db(name).dropDatabase();
    return { summary: `Dropped database ${name}` };
  });
}

/* ------------------------------------------------------ configuration */

/** Parameters setParameter changes at runtime, plus the profiler's slow-operation threshold. */
const EDITABLE = {
  slowms: { group: 'Profiling', type: 'number', hint: 'Operations slower than this many ms are logged as slow' },
  logLevel: { group: 'Logging', type: 'number', hint: 'Log verbosity, 0 (quiet) to 5' },
  cursorTimeoutMillis: { group: 'Cursors', type: 'number', hint: 'Idle cursors are closed after this many ms' },
  transactionLifetimeLimitSeconds: { group: 'Transactions', type: 'number', hint: 'Transactions running longer are aborted' },
  maxTransactionLockRequestTimeoutMillis: { group: 'Transactions', type: 'number', hint: 'How long a transaction waits for a lock' },
  notablescan: { group: 'Queries', type: 'bool', hint: 'Refuse queries that would scan a whole collection' },
  ttlMonitorEnabled: { group: 'Maintenance', type: 'bool', hint: 'Delete expired documents from TTL indexes' },
};

export async function config(cfg) {
  return withMongo(cfg, async (client) => {
    const params = await admin(client).command({ getParameter: '*' });
    delete params.ok;
    const profile = await maybe(admin(client).command({ profile: -1 }));
    const cmdLine = await maybe(admin(client).command({ getCmdLineOpts: 1 }));
    const values = { ...params, slowms: profile?.slowms };

    return {
      note: 'Changes apply to the running server only — MongoDB forgets them on restart. To keep one, also put it in mongod.conf'
        + ` (setParameter:${cmdLine?.parsed?.config ? `, in ${cmdLine.parsed.config}` : ''}).`,
      persistLabel: null,
      editable: Object.entries(EDITABLE).filter(([n]) => values[n] !== undefined).map(([n, meta]) => ({
        name: n, value: String(values[n]), display: String(values[n]), ...meta,
      })),
      all: [
        ...(cmdLine?.parsed ? [{ name: '(startup options)', value: JSON.stringify(cmdLine.parsed), hint: 'from the command line and mongod.conf' }] : []),
        ...Object.entries(params).map(([name, v]) => ({ name, value: typeof v === 'object' ? JSON.stringify(v) : String(v) })),
      ],
    };
  });
}

export async function setConfig(cfg, body) {
  const meta = EDITABLE[body.name];
  if (!meta) throw new Error(`"${body.name}" cannot be changed from the panel`);
  let value = String(body.value ?? '').trim();
  if (meta.type === 'number') {
    if (!/^\d+$/.test(value)) throw new Error(`${body.name} must be a whole number`);
    value = Number(value);
  } else {
    value = /^(1|on|true|yes)$/i.test(value);
  }
  return withMongo(cfg, async (client) => {
    if (body.name === 'slowms') await admin(client).command({ profile: -1, slowms: value });
    else await admin(client).command({ setParameter: 1, [body.name]: value });
    return { summary: `${body.name} = ${value} (until the next restart)` };
  });
}

/* ---------------------------------------------------------------- query */

export const queryHelp = {
  placeholder: '{ "collection": "orders", "filter": { "status": "paid" }, "sort": { "_id": -1 }, "limit": 20 }',
  hint: 'A JSON find: collection, filter, projection, sort, limit — or "aggregate": [ …pipeline ]. Stages that write ($out, $merge) are refused. First 200 documents.',
  databaseLabel: 'Database',
};

export async function query(cfg, { text: input, database }) {
  let q;
  try {
    q = JSON.parse(String(input || ''));
  } catch {
    throw new Error('The query must be JSON, e.g. { "collection": "orders", "filter": {} }');
  }
  const dbName = q.db || database || cfg.database;
  if (!dbName) throw new Error('Pick a database');
  if (!q.collection) throw new Error('"collection" is required');
  if (q.aggregate && JSON.stringify(q.aggregate).match(/"\$(out|merge)"/)) throw new Error('$out and $merge write data and are not allowed here');
  const limit = Math.min(Number(q.limit) || 50, 200);

  return withMongo(cfg, async (client) => {
    const coll = client.db(dbName).collection(String(q.collection));
    const started = Date.now();
    const docs = Array.isArray(q.aggregate)
      ? await coll.aggregate([...q.aggregate, { $limit: limit + 1 }], { maxTimeMS: 20000 }).toArray()
      : await coll.find(q.filter || {}, { projection: q.projection, sort: q.sort, limit: limit + 1, maxTimeMS: 20000 }).toArray();
    const columns = [...new Set(docs.slice(0, limit).flatMap((d) => Object.keys(d)))].slice(0, 30);
    return {
      columns,
      rows: docs.slice(0, limit).map((d) => columns.map((c) => text(d[c], 300))),
      rowCount: Math.min(docs.length, limit),
      truncated: docs.length > limit,
      durationMs: Date.now() - started,
    };
  });
}
