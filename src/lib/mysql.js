import mysql from 'mysql2/promise';
import { connectionFromRow, withConnection } from './ssh.js';

const SYSTEM_SCHEMAS = ['information_schema', 'performance_schema', 'mysql', 'sys'];

/** MySQL on a server is usually bound to 127.0.0.1, so we tunnel through that server's SSH. */
function forwardOut(sshConn, host, port) {
  return new Promise((resolve, reject) => {
    sshConn.forwardOut('127.0.0.1', 0, host, port, (err, stream) => (err ? reject(wrapTunnelError(err)) : resolve(stream)));
  });
}

function wrapTunnelError(err) {
  const e = new Error(
    `SSH tunnel to MySQL failed: ${err.message}. Check that MySQL is running on the server and that AllowTcpForwarding is enabled in sshd_config.`
  );
  e.cause = err.message;
  return e;
}

/**
 * Open a MySQL connection — directly, or tunnelled through `server` when the
 * credential is tied to one — hand it to `fn`, and always close it afterwards.
 */
export async function withMysql({ host, port, user, password, database, server }, fn) {
  const base = {
    user,
    password,
    database: database || undefined,
    connectTimeout: 15000,
    // Plain values back: big numbers and dates as strings, not JS objects.
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
  };

  const run = async (conn) => {
    try {
      return await fn(conn);
    } finally {
      await conn.end().catch(() => {});
    }
  };

  if (server) {
    return withConnection(connectionFromRow(server), async (sshConn) => {
      const stream = await forwardOut(sshConn, host, port);
      const conn = await mysql.createConnection({ ...base, stream }).catch((err) => { throw normalizeMysqlError(err); });
      return run(conn);
    });
  }

  const conn = await mysql.createConnection({ ...base, host, port }).catch((err) => { throw normalizeMysqlError(err); });
  return run(conn);
}

/** Cheap identity probe used by "Verify". */
export async function testMysql(cfg) {
  const started = Date.now();
  const result = await withMysql(cfg, async (conn) => {
    const [[row]] = await conn.query('SELECT VERSION() AS version, CURRENT_USER() AS currentUser, @@hostname AS hostname, @@port AS port');
    return row;
  });
  return { ...result, latencyMs: Date.now() - started };
}

/** Full inspection: engine state, every schema with its size, users and biggest tables. */
export async function inspectMysql(cfg) {
  const started = Date.now();
  const facts = await withMysql(cfg, async (conn) => {
    const q = async (sql, params) => {
      try {
        const [rows] = await conn.query(sql, params);
        return rows;
      } catch (err) {
        // A restricted account may not see mysql.user or the process list.
        return { __error: err.message };
      }
    };

    const [[identity]] = await conn.query(
      'SELECT VERSION() AS version, CURRENT_USER() AS currentUser, USER() AS loginUser, @@hostname AS hostname, @@port AS port, @@version_comment AS flavor'
    );

    const statusRows = await q("SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime','Threads_connected','Threads_running','Questions','Slow_queries','Aborted_connects','Connections','Bytes_sent','Bytes_received','Max_used_connections')");
    const varRows = await q("SHOW GLOBAL VARIABLES WHERE Variable_name IN ('max_connections','datadir','character_set_server','collation_server','innodb_buffer_pool_size','max_allowed_packet','wait_timeout','sql_mode','log_bin','default_storage_engine','read_only')");

    const status = pairsToObject(statusRows);
    const vars = pairsToObject(varRows);

    // Aliases avoid reserved words (ROWS and TABLES are reserved in MySQL 8).
    const schemas = await q(`
      SELECT s.SCHEMA_NAME AS name,
             s.DEFAULT_CHARACTER_SET_NAME AS charset,
             s.DEFAULT_COLLATION_NAME AS collation,
             COALESCE(t.tableCount, 0) AS tableCount,
             COALESCE(t.dataBytes, 0) AS dataBytes,
             COALESCE(t.indexBytes, 0) AS indexBytes,
             COALESCE(t.approxRows, 0) AS approxRows
        FROM information_schema.SCHEMATA s
        LEFT JOIN (
          SELECT TABLE_SCHEMA AS schemaName,
                 COUNT(*) AS tableCount,
                 SUM(DATA_LENGTH) AS dataBytes,
                 SUM(INDEX_LENGTH) AS indexBytes,
                 SUM(TABLE_ROWS) AS approxRows
            FROM information_schema.TABLES
           GROUP BY TABLE_SCHEMA
        ) t ON t.schemaName = s.SCHEMA_NAME
       ORDER BY (COALESCE(t.dataBytes,0) + COALESCE(t.indexBytes,0)) DESC
    `);

    const topTables = await q(`
      SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS name, ENGINE AS engine,
             TABLE_ROWS AS approxRows, DATA_LENGTH AS dataBytes, INDEX_LENGTH AS indexBytes,
             TABLE_COLLATION AS collation, CREATE_TIME AS createdAt
        FROM information_schema.TABLES
       WHERE TABLE_SCHEMA NOT IN (?, ?, ?, ?) AND TABLE_TYPE = 'BASE TABLE'
       ORDER BY (COALESCE(DATA_LENGTH,0) + COALESCE(INDEX_LENGTH,0)) DESC
       LIMIT 20
    `, SYSTEM_SCHEMAS);

    const users = await q("SELECT user AS user, host AS host, account_locked AS locked, password_expired AS passwordExpired FROM mysql.user ORDER BY user");
    const processes = await q('SELECT ID AS id, USER AS user, HOST AS host, DB AS db, COMMAND AS command, TIME AS seconds, STATE AS state FROM information_schema.PROCESSLIST ORDER BY TIME DESC LIMIT 20');

    return { identity, status, vars, schemas, topTables, users, processes };
  });

  return shapeFacts(facts, Date.now() - started);
}

/** Tables, columns and indexes for one database, plus who can reach it and who is in it. */
export async function inspectDatabase(cfg, database) {
  return withMysql(cfg, async (conn) => {
    const q = async (sql, params) => {
      try {
        const [rows] = await conn.query(sql, params);
        return rows;
      } catch (err) {
        return { __error: err.message };
      }
    };

    const [[schema]] = await conn.query(
      'SELECT DEFAULT_CHARACTER_SET_NAME AS charset, DEFAULT_COLLATION_NAME AS collation FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
      [database]
    );
    if (!schema) throw new Error(`Database "${database}" does not exist`);

    const [tables] = await conn.query(`
      SELECT TABLE_NAME AS name, ENGINE AS engine, TABLE_ROWS AS approxRows,
             DATA_LENGTH AS dataBytes, INDEX_LENGTH AS indexBytes, AUTO_INCREMENT AS autoIncrement,
             TABLE_COLLATION AS collation, CREATE_TIME AS createdAt, UPDATE_TIME AS updatedAt, TABLE_COMMENT AS comment
        FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
       ORDER BY (COALESCE(DATA_LENGTH,0) + COALESCE(INDEX_LENGTH,0)) DESC
    `, [database]);

    const [views] = await conn.query(
      'SELECT TABLE_NAME AS name FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
      [database]
    );

    const [routines] = await conn.query(
      'SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME',
      [database]
    );

    const triggers = await q(
      'SELECT TRIGGER_NAME AS name, EVENT_MANIPULATION AS event, EVENT_OBJECT_TABLE AS tableName, ACTION_TIMING AS timing FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME',
      [database]
    );
    const events = await q(
      'SELECT EVENT_NAME AS name, STATUS AS status, INTERVAL_VALUE AS intervalValue, INTERVAL_FIELD AS intervalField FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME',
      [database]
    );
    const [[{ columnCount }]] = await conn.query(
      'SELECT COUNT(*) AS columnCount FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?',
      [database]
    );
    const sessions = await q(
      'SELECT ID AS id, USER AS user, HOST AS host, COMMAND AS command, TIME AS seconds, STATE AS state FROM information_schema.PROCESSLIST WHERE DB = ? ORDER BY TIME DESC',
      [database]
    );

    // Accounts granted something on this database specifically (mysql.db keeps
    // LIKE patterns, so `shop\_%` counts for `shop_eu`), and accounts whose
    // global privileges reach every database anyway.
    const dbGrants = await q('SELECT * FROM mysql.db WHERE ? LIKE Db', [database]);
    const globalGrants = await q("SELECT * FROM mysql.user WHERE Select_priv = 'Y' OR Insert_priv = 'Y' OR Update_priv = 'Y'");

    const list = (v) => (Array.isArray(v) ? v : []);
    const shapedTables = tables.map((t) => ({ ...t, totalBytes: Number(t.dataBytes || 0) + Number(t.indexBytes || 0) }));
    const engines = {};
    for (const t of shapedTables) engines[t.engine || 'unknown'] = (engines[t.engine || 'unknown'] || 0) + 1;

    return {
      database,
      charset: schema.charset,
      collation: schema.collation,
      tables: shapedTables,
      views: views.map((v) => v.name),
      routines,
      triggers: list(triggers),
      events: list(events),
      eventsError: events?.__error || null,
      engines,
      sessions: list(sessions),
      access: [
        ...list(dbGrants).map((g) => ({ user: g.User, host: g.Host, scope: g.Db, privileges: privilegesOf(g) })),
        ...list(globalGrants).map((g) => ({ user: g.User, host: g.Host, scope: '*', privileges: privilegesOf(g) })),
      ],
      accessError: dbGrants?.__error || null,
      totals: {
        tables: tables.length,
        views: views.length,
        routines: routines.length,
        triggers: list(triggers).length,
        events: list(events).length,
        columns: Number(columnCount || 0),
        dataBytes: tables.reduce((n, t) => n + Number(t.dataBytes || 0), 0),
        indexBytes: tables.reduce((n, t) => n + Number(t.indexBytes || 0), 0),
        approxRows: tables.reduce((n, t) => n + Number(t.approxRows || 0), 0),
        sessions: list(sessions).length,
        users: new Set([...list(dbGrants), ...list(globalGrants)].map((g) => `${g.User}@${g.Host}`)).size,
      },
    };
  });
}

/** `Select_priv: 'Y'` → `SELECT`, for a row of mysql.user or mysql.db. */
function privilegesOf(row) {
  return Object.entries(row)
    .filter(([k, v]) => /_priv$/.test(k) && v === 'Y')
    .map(([k]) => k.replace(/_priv$/, '').replace(/_/g, ' ').toUpperCase());
}

/** Columns and indexes of a single table. */
export async function inspectTable(cfg, database, tableName) {
  return withMysql(cfg, async (conn) => {
    const [columns] = await conn.query(`
      SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_KEY AS keyType,
             COLUMN_DEFAULT AS defaultValue, EXTRA AS extra, COLUMN_COMMENT AS comment
        FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION
    `, [database, tableName]);

    const [indexes] = await conn.query(`
      SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns, INDEX_TYPE AS type
        FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       GROUP BY INDEX_NAME, NON_UNIQUE, INDEX_TYPE
    `, [database, tableName]);

    const [foreignKeys] = await conn.query(`
      SELECT CONSTRAINT_NAME AS name, COLUMN_NAME AS column_name,
             REFERENCED_TABLE_NAME AS refTable, REFERENCED_COLUMN_NAME AS refColumn
        FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
    `, [database, tableName]);

    return { database, table: tableName, columns, indexes, foreignKeys };
  });
}

/** Read-only query runner — anything that could change data or schema is refused. */
const READ_ONLY = /^\s*(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN)\b/i;
const FORBIDDEN = /\b(INTO\s+OUTFILE|INTO\s+DUMPFILE|LOAD_FILE|SLEEP|BENCHMARK)\s*\(?/i;

export async function runReadOnlyQuery(cfg, sql, limit = 200) {
  const trimmed = String(sql || '').trim().replace(/;\s*$/, '');
  if (!trimmed) throw new Error('A query is required');
  if (trimmed.includes(';')) throw new Error('Only one statement at a time is allowed');
  if (!READ_ONLY.test(trimmed)) throw new Error('Only SELECT, SHOW, DESCRIBE and EXPLAIN queries are allowed here');
  if (FORBIDDEN.test(trimmed)) throw new Error('That query uses a construct this panel does not allow');

  return withMysql(cfg, async (conn) => {
    const started = Date.now();
    const [rows, fields] = await conn.query({ sql: trimmed, timeout: 20000 });
    const list = Array.isArray(rows) ? rows : [rows];
    return {
      columns: (fields || []).map((f) => f.name),
      rows: list.slice(0, limit),
      rowCount: list.length,
      truncated: list.length > limit,
      durationMs: Date.now() - started,
    };
  });
}

/* ------------------------------------------------------------ management */

/*
 * Everything below changes the MySQL server. Values always travel as query
 * parameters; names that cannot (databases, privileges, variables) are either
 * checked against a pattern, quoted with escapeId, or taken from a fixed list.
 */

const USER_RE = /^[A-Za-z0-9_.\-]{1,32}$/;
const HOST_RE = /^[A-Za-z0-9.%_:\-]{1,255}$/;
const NEW_DB_RE = /^[A-Za-z0-9_$\-]{1,64}$/;
const CHARSET_RE = /^[A-Za-z0-9_]{1,64}$/;

/** Privileges the panel will grant at database level (or globally, with `*`). */
export const GRANTABLE_PRIVILEGES = [
  'ALL PRIVILEGES', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'INDEX',
  'REFERENCES', 'CREATE VIEW', 'SHOW VIEW', 'CREATE ROUTINE', 'ALTER ROUTINE', 'EXECUTE',
  'TRIGGER', 'EVENT', 'CREATE TEMPORARY TABLES', 'LOCK TABLES',
];

function checkAccount(user, host) {
  if (!USER_RE.test(String(user || ''))) throw new Error('Username may only use letters, digits, "_", "." and "-" (up to 32 characters)');
  if (!HOST_RE.test(String(host || ''))) throw new Error('Host must be a hostname, an IP address, or a pattern like "%" or "10.0.%"');
}

function checkExistingDatabase(name) {
  const db = String(name || '');
  if (!db) throw new Error('A database name is required');
  if (SYSTEM_SCHEMAS.includes(db.toLowerCase())) throw new Error(`"${db}" is a MySQL system schema and cannot be changed here`);
  return db;
}

/** `*.*` for every database, `` `shop`.* `` for one. */
function scopeSql(database) {
  if (!database || database === '*') return '*.*';
  return `${mysql.escapeId(String(database))}.*`;
}

function cleanPrivileges(list) {
  const wanted = (Array.isArray(list) ? list : [list]).map((p) => String(p || '').trim().toUpperCase()).filter(Boolean);
  if (!wanted.length) throw new Error('Pick at least one privilege');
  const unknown = wanted.filter((p) => !GRANTABLE_PRIVILEGES.includes(p));
  if (unknown.length) throw new Error(`Unknown privilege: ${unknown.join(', ')}`);
  return wanted.includes('ALL PRIVILEGES') ? ['ALL PRIVILEGES'] : [...new Set(wanted)];
}

/** The account the panel is connected as, as `user@host`. */
async function currentAccount(conn) {
  const [[row]] = await conn.query('SELECT CURRENT_USER() AS me');
  return String(row.me || '');
}

/* users */

/** Every account with its state and grants. */
export async function listUsers(cfg) {
  return withMysql(cfg, async (conn) => {
    let rows;
    try {
      [rows] = await conn.query(`
        SELECT User AS user, Host AS host, plugin, account_locked AS locked, password_expired AS passwordExpired,
               password_last_changed AS passwordChangedAt, max_user_connections AS maxConnections
          FROM mysql.user ORDER BY User, Host`);
    } catch {
      // Older servers and MariaDB lack some of those columns.
      [rows] = await conn.query('SELECT User AS user, Host AS host FROM mysql.user ORDER BY User, Host');
    }

    const [procs] = await conn.query('SELECT USER AS user, COUNT(*) AS n FROM information_schema.PROCESSLIST GROUP BY USER')
      .catch(() => [[]]);
    const sessionsByUser = Object.fromEntries(procs.map((p) => [p.user, Number(p.n)]));

    const users = [];
    for (const r of rows) {
      let grants = [];
      try {
        const [g] = await conn.query('SHOW GRANTS FOR ?@?', [r.user, r.host]);
        grants = g.map((row) => Object.values(row)[0]);
      } catch (err) {
        grants = [`(cannot read grants: ${err.message})`];
      }
      users.push({
        user: r.user,
        host: r.host,
        plugin: r.plugin || null,
        locked: r.locked === 'Y',
        passwordExpired: r.passwordExpired === 'Y',
        passwordChangedAt: r.passwordChangedAt || null,
        maxConnections: r.maxConnections !== undefined ? Number(r.maxConnections) : null,
        sessions: sessionsByUser[r.user] || 0,
        grants,
        system: /^mysql\.(sys|session|infoschema)$/.test(r.user),
      });
    }

    const me = await currentAccount(conn);
    return {
      users,
      currentUser: me,
      privileges: GRANTABLE_PRIVILEGES,
      totals: {
        users: users.length,
        locked: users.filter((u) => u.locked).length,
        expired: users.filter((u) => u.passwordExpired).length,
        withSessions: users.filter((u) => u.sessions > 0).length,
      },
    };
  });
}

/** Create an account, optionally granting it privileges on one database straight away. */
export async function createUser(cfg, { user, host = '%', password, database, privileges }) {
  checkAccount(user, host);
  if (!password || String(password).length < 8) throw new Error('The password must be at least 8 characters');
  return withMysql(cfg, async (conn) => {
    await conn.query('CREATE USER ?@? IDENTIFIED BY ?', [user, host, String(password)]);
    if (database) {
      const privs = cleanPrivileges(privileges?.length ? privileges : ['ALL PRIVILEGES']);
      await conn.query(`GRANT ${privs.join(', ')} ON ${scopeSql(database)} TO ?@?`, [user, host]);
    }
    return { user, host, database: database || null };
  });
}

/** Change the password, lock / unlock, or cap the connections of an account. */
export async function alterUser(cfg, { user, host, password, locked, maxConnections }) {
  checkAccount(user, host);
  return withMysql(cfg, async (conn) => {
    const me = await currentAccount(conn);
    const changed = [];
    if (password !== undefined && password !== '') {
      if (String(password).length < 8) throw new Error('The password must be at least 8 characters');
      await conn.query('ALTER USER ?@? IDENTIFIED BY ?', [user, host, String(password)]);
      changed.push('password');
    }
    if (locked !== undefined) {
      if (locked && me === `${user}@${host}`) throw new Error('The panel is signed in as this account — locking it would lock the panel out');
      await conn.query(`ALTER USER ?@? ACCOUNT ${locked ? 'LOCK' : 'UNLOCK'}`, [user, host]);
      changed.push(locked ? 'locked' : 'unlocked');
    }
    if (maxConnections !== undefined && maxConnections !== '') {
      const n = Number(maxConnections);
      if (!Number.isInteger(n) || n < 0) throw new Error('Max connections must be 0 (unlimited) or more');
      await conn.query(`ALTER USER ?@? WITH MAX_USER_CONNECTIONS ${n}`, [user, host]);
      changed.push(`max connections ${n}`);
    }
    if (!changed.length) throw new Error('Nothing to change');
    return { user, host, changed };
  });
}

export async function dropUser(cfg, { user, host }) {
  checkAccount(user, host);
  return withMysql(cfg, async (conn) => {
    if (await currentAccount(conn) === `${user}@${host}`) {
      throw new Error('The panel is signed in as this account — it cannot drop itself');
    }
    await conn.query('DROP USER ?@?', [user, host]);
    return { user, host };
  });
}

export async function grantPrivileges(cfg, { user, host, database, privileges, grantOption }) {
  checkAccount(user, host);
  const privs = cleanPrivileges(privileges);
  return withMysql(cfg, async (conn) => {
    await conn.query(
      `GRANT ${privs.join(', ')} ON ${scopeSql(database)} TO ?@?${grantOption ? ' WITH GRANT OPTION' : ''}`,
      [user, host]
    );
    return { user, host, database: database || '*', privileges: privs };
  });
}

/** Take back everything an account was granted on one database (or globally, with `*`). */
export async function revokePrivileges(cfg, { user, host, database }) {
  checkAccount(user, host);
  return withMysql(cfg, async (conn) => {
    // "ALL PRIVILEGES, GRANT OPTION" only parses without an ON clause, so it is two
    // statements; the second fails harmlessly when there was no grant option to take.
    await conn.query(`REVOKE ALL PRIVILEGES ON ${scopeSql(database)} FROM ?@?`, [user, host]);
    await conn.query(`REVOKE GRANT OPTION ON ${scopeSql(database)} FROM ?@?`, [user, host]).catch((err) => {
      if (err.code !== 'ER_NONEXISTING_GRANT') throw err;
    });
    return { user, host, database: database || '*' };
  });
}

/* databases */

/** Character sets and their collations, for the create / alter pickers. */
export async function listCharsets(cfg) {
  return withMysql(cfg, async (conn) => {
    const [charsets] = await conn.query(
      'SELECT CHARACTER_SET_NAME AS name, DEFAULT_COLLATE_NAME AS defaultCollation, DESCRIPTION AS description FROM information_schema.CHARACTER_SETS ORDER BY CHARACTER_SET_NAME'
    );
    const [collations] = await conn.query(
      'SELECT COLLATION_NAME AS name, CHARACTER_SET_NAME AS charset FROM information_schema.COLLATIONS ORDER BY COLLATION_NAME'
    );
    const [[defaults]] = await conn.query('SELECT @@character_set_server AS charset, @@collation_server AS collation');
    return { charsets, collations, defaults };
  });
}

function charsetSql(charset, collation) {
  let sql = '';
  if (charset) {
    if (!CHARSET_RE.test(charset)) throw new Error('Unknown character set');
    sql += ` CHARACTER SET ${charset}`;
  }
  if (collation) {
    if (!CHARSET_RE.test(collation)) throw new Error('Unknown collation');
    sql += ` COLLATE ${collation}`;
  }
  return sql;
}

export async function createDatabase(cfg, { name, charset = 'utf8mb4', collation }) {
  if (!NEW_DB_RE.test(String(name || ''))) {
    throw new Error('Database names may use letters, digits, "_", "$" and "-" (up to 64 characters)');
  }
  if (SYSTEM_SCHEMAS.includes(name.toLowerCase())) throw new Error(`"${name}" is reserved for MySQL itself`);
  return withMysql(cfg, async (conn) => {
    await conn.query(`CREATE DATABASE ${mysql.escapeId(name)}${charsetSql(charset, collation)}`);
    return { name };
  });
}

export async function alterDatabase(cfg, { name, charset, collation }) {
  const db = checkExistingDatabase(name);
  const clause = charsetSql(charset, collation);
  if (!clause) throw new Error('Pick a character set or a collation');
  return withMysql(cfg, async (conn) => {
    await conn.query(`ALTER DATABASE ${mysql.escapeId(db)}${clause}`);
    return { name: db };
  });
}

/** Drop a database — only when the caller typed its exact name back. */
export async function dropDatabase(cfg, { name, confirm }) {
  const db = checkExistingDatabase(name);
  if (confirm !== db) throw new Error('Type the database name exactly to confirm');
  return withMysql(cfg, async (conn) => {
    await conn.query(`DROP DATABASE ${mysql.escapeId(db)}`);
    return { name: db };
  });
}

/* configuration */

/**
 * Server variables the panel lets you change at runtime. Anything else is
 * shown, but read-only: a typo in an arbitrary SET GLOBAL can take a server down.
 */
export const EDITABLE_VARIABLES = {
  max_connections:                { group: 'Connections', type: 'number', hint: 'Most client connections at once' },
  max_connect_errors:             { group: 'Connections', type: 'number', hint: 'Failed handshakes before a host is blocked' },
  max_user_connections:           { group: 'Connections', type: 'number', hint: 'Per-account cap; 0 means no cap' },
  wait_timeout:                   { group: 'Timeouts', type: 'number', hint: 'Seconds an idle connection is kept' },
  interactive_timeout:            { group: 'Timeouts', type: 'number', hint: 'Same, for interactive clients' },
  net_read_timeout:               { group: 'Timeouts', type: 'number', hint: 'Seconds to wait for more data from a client' },
  net_write_timeout:              { group: 'Timeouts', type: 'number', hint: 'Seconds to wait when writing to a client' },
  innodb_lock_wait_timeout:       { group: 'Timeouts', type: 'number', hint: 'Seconds a transaction waits for a row lock' },
  innodb_buffer_pool_size:        { group: 'Memory', type: 'number', unit: 'bytes', hint: 'InnoDB data and index cache — the main memory knob' },
  max_allowed_packet:             { group: 'Memory', type: 'number', unit: 'bytes', hint: 'Largest single packet or row' },
  tmp_table_size:                 { group: 'Memory', type: 'number', unit: 'bytes', hint: 'In-memory temp table limit' },
  max_heap_table_size:            { group: 'Memory', type: 'number', unit: 'bytes', hint: 'MEMORY table limit (keep equal to tmp_table_size)' },
  sort_buffer_size:               { group: 'Memory', type: 'number', unit: 'bytes', hint: 'Per-connection sort buffer' },
  join_buffer_size:               { group: 'Memory', type: 'number', unit: 'bytes', hint: 'Per-join buffer for joins without indexes' },
  table_open_cache:               { group: 'Memory', type: 'number', hint: 'Open tables kept cached' },
  thread_cache_size:              { group: 'Memory', type: 'number', hint: 'Threads kept for reuse' },
  slow_query_log:                 { group: 'Logging', type: 'bool', hint: 'Record queries slower than long_query_time' },
  long_query_time:                { group: 'Logging', type: 'number', hint: 'Seconds before a query counts as slow' },
  log_queries_not_using_indexes:  { group: 'Logging', type: 'bool', hint: 'Also log queries that scan without an index' },
  general_log:                    { group: 'Logging', type: 'bool', hint: 'Log every statement — heavy, for debugging only' },
  sql_mode:                       { group: 'Behaviour', type: 'text', hint: 'Comma separated SQL modes' },
  time_zone:                      { group: 'Behaviour', type: 'text', hint: 'SYSTEM, +00:00, or a named zone' },
  event_scheduler:                { group: 'Behaviour', type: 'enum', options: ['ON', 'OFF'], hint: 'Run scheduled events' },
  read_only:                      { group: 'Behaviour', type: 'bool', hint: 'Refuse writes from non-admin accounts' },
  character_set_server:           { group: 'Character set', type: 'text', hint: 'Default for new databases' },
  collation_server:               { group: 'Character set', type: 'text', hint: 'Default collation for new databases' },
};

export async function listVariables(cfg) {
  return withMysql(cfg, async (conn) => {
    const [rows] = await conn.query('SHOW GLOBAL VARIABLES');
    const [[identity]] = await conn.query('SELECT VERSION() AS version, @@version_comment AS flavor');
    const values = pairsToObject(rows);
    return {
      persistSupported: supportsPersist(identity),
      editable: Object.entries(EDITABLE_VARIABLES)
        .filter(([name]) => name in values)
        .map(([name, meta]) => ({ name, value: values[name], ...meta })),
      variables: rows.map((r) => ({ name: r.Variable_name, value: r.Value, editable: r.Variable_name in EDITABLE_VARIABLES })),
    };
  });
}

/** SET GLOBAL — or SET PERSIST, which also survives a restart (MySQL 8+). */
export async function setVariable(cfg, { name, value, persist }) {
  const meta = EDITABLE_VARIABLES[name];
  if (!meta) throw new Error(`"${name}" cannot be changed from the panel`);

  let v = String(value ?? '').trim();
  if (meta.type === 'number') {
    if (!/^\d+(\.\d+)?$/.test(v)) throw new Error(`${name} must be a number`);
    v = Number(v);
  } else if (meta.type === 'bool') {
    v = /^(1|on|true|yes)$/i.test(v) ? 'ON' : 'OFF';
  } else if (meta.type === 'enum') {
    v = v.toUpperCase();
    if (!meta.options.includes(v)) throw new Error(`${name} must be one of ${meta.options.join(', ')}`);
  } else if (v.length > 1024) {
    throw new Error('That value is too long');
  }

  return withMysql(cfg, async (conn) => {
    if (persist) {
      const [[identity]] = await conn.query('SELECT VERSION() AS version, @@version_comment AS flavor');
      if (!supportsPersist(identity)) throw new Error('This server does not support SET PERSIST (MySQL 8 or newer only)');
    }
    await conn.query(`SET ${persist ? 'PERSIST' : 'GLOBAL'} ${name} = ?`, [v]);
    const [[row]] = await conn.query(`SELECT @@GLOBAL.${name} AS value`);
    return { name, value: row.value, persisted: Boolean(persist) };
  });
}

function supportsPersist({ version, flavor }) {
  if (/mariadb/i.test(`${version} ${flavor}`)) return false;
  return Number(String(version).split('.')[0]) >= 8;
}

/* ---------------------------------------------------------------- shaping */

function pairsToObject(rows) {
  if (!Array.isArray(rows)) return {};
  const o = {};
  for (const r of rows) o[r.Variable_name] = r.Value;
  return o;
}

function shapeFacts({ identity, status, vars, schemas, topTables, users, processes }, durationMs) {
  const list = (v) => (Array.isArray(v) ? v : []);
  const uptime = Number(status.Uptime || 0);

  const userSchemas = list(schemas).filter((s) => !SYSTEM_SCHEMAS.includes(s.name));

  return {
    collectedAt: new Date().toISOString(),
    durationMs,
    server: {
      version: identity.version,
      flavor: identity.flavor,
      hostname: identity.hostname,
      port: identity.port,
      currentUser: identity.currentUser,
      loginUser: identity.loginUser,
      readOnly: vars.read_only === 'ON',
      binlog: vars.log_bin === 'ON',
      defaultEngine: vars.default_storage_engine,
      charset: vars.character_set_server,
      collation: vars.collation_server,
      datadir: vars.datadir,
      sqlMode: vars.sql_mode,
    },
    runtime: {
      uptimeSeconds: uptime,
      uptimeHuman: humanUptime(uptime),
      threadsConnected: Number(status.Threads_connected || 0),
      threadsRunning: Number(status.Threads_running || 0),
      maxConnections: Number(vars.max_connections || 0),
      maxUsedConnections: Number(status.Max_used_connections || 0),
      connections: Number(status.Connections || 0),
      questions: Number(status.Questions || 0),
      slowQueries: Number(status.Slow_queries || 0),
      abortedConnects: Number(status.Aborted_connects || 0),
      bytesSent: Number(status.Bytes_sent || 0),
      bytesReceived: Number(status.Bytes_received || 0),
      bufferPoolBytes: Number(vars.innodb_buffer_pool_size || 0),
      maxAllowedPacket: Number(vars.max_allowed_packet || 0),
      waitTimeout: Number(vars.wait_timeout || 0),
    },
    databases: userSchemas.map(shapeSchema),
    systemDatabases: list(schemas).filter((s) => SYSTEM_SCHEMAS.includes(s.name)).map(shapeSchema),
    databasesError: schemas?.__error || null,
    totals: {
      databases: userSchemas.length,
      tables: userSchemas.reduce((n, s) => n + Number(s.tableCount || 0), 0),
      sizeBytes: userSchemas.reduce((n, s) => n + Number(s.dataBytes || 0) + Number(s.indexBytes || 0), 0),
      approxRows: userSchemas.reduce((n, s) => n + Number(s.approxRows || 0), 0),
    },
    topTables: list(topTables).map((t) => ({
      ...t,
      approxRows: Number(t.approxRows || 0),
      dataBytes: Number(t.dataBytes || 0),
      indexBytes: Number(t.indexBytes || 0),
      totalBytes: Number(t.dataBytes || 0) + Number(t.indexBytes || 0),
    })),
    users: Array.isArray(users)
      ? users.map((u) => ({ ...u, locked: u.locked === 'Y', passwordExpired: u.passwordExpired === 'Y' }))
      : [],
    usersError: users?.__error || null,
    processes: list(processes),
    processesError: processes?.__error || null,
  };
}

function shapeSchema(s) {
  const dataBytes = Number(s.dataBytes || 0);
  const indexBytes = Number(s.indexBytes || 0);
  return {
    name: s.name,
    charset: s.charset,
    collation: s.collation,
    tableCount: Number(s.tableCount || 0),
    approxRows: Number(s.approxRows || 0),
    dataBytes,
    indexBytes,
    totalBytes: dataBytes + indexBytes,
  };
}

function humanUptime(seconds) {
  if (!seconds) return null;
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return [d ? `${d}d` : null, d || h ? `${h}h` : null, `${m}m`].filter(Boolean).join(' ');
}

function normalizeMysqlError(err) {
  const msg = String(err?.message || err);
  const map = [
    [/ER_ACCESS_DENIED_ERROR|Access denied/i, 'Access denied — check the MySQL username and password.'],
    [/ER_DBACCESS_DENIED_ERROR/i, 'That MySQL user cannot access the requested database.'],
    [/ECONNREFUSED/i, 'Connection refused — MySQL is not listening on that host and port.'],
    [/ETIMEDOUT|timeout/i, 'Connection timed out — MySQL may be bound to localhost only. Tie this credential to a server so the panel can tunnel over SSH.'],
    [/ENOTFOUND|EAI_AGAIN/i, 'Host not found — the MySQL hostname could not be resolved.'],
    [/ER_HOST_NOT_PRIVILEGED|not allowed to connect/i, 'This host is not allowed to connect to that MySQL server. Grant access for the connecting host, or tunnel through the server over SSH.'],
    [/ER_BAD_DB_ERROR|Unknown database/i, 'That database does not exist on the server.'],
  ];
  for (const [re, friendly] of map) {
    if (re.test(msg)) {
      const e = new Error(friendly);
      e.cause = msg;
      return e;
    }
  }
  return err instanceof Error ? err : new Error(msg);
}
