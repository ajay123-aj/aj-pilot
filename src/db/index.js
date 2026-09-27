import mysql from 'mysql2/promise';
import { config } from '../config.js';
import { currentOrgId, currentUserId } from '../lib/context.js';

let pool;

/**
 * Connect to MySQL, creating the database and tables if they are not there yet.
 * Called once at boot so the app fails fast with a readable message.
 */
export async function initDb() {
  const { database, ...serverOnly } = config.db;

  // Connect without a database first so we can create it.
  let bootstrap;
  try {
    bootstrap = await mysql.createConnection({ ...serverOnly, multipleStatements: true });
  } catch (err) {
    throw new Error(explainConnectionFailure(err));
  }

  await bootstrap.query(
    `CREATE DATABASE IF NOT EXISTS \`${database.replace(/`/g, '')}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await bootstrap.end();

  pool = mysql.createPool({
    ...config.db,
    waitForConnections: true,
    queueLimit: 0,
    charset: 'utf8mb4',
    dateStrings: true,
    // Every time is kept in UTC — NOW(), column defaults, and JS Dates written by the panel —
    // so the browser can read "2026-09-27 04:05:42" as UTC whatever timezone either side is in.
    timezone: 'Z',
  });
  pool.on('connection', (conn) => conn.query("SET time_zone = '+00:00'"));

  await createSchema();
  return pool;
}

export function getPool() {
  if (!pool) throw new Error('Database not initialised — call initDb() first');
  return pool;
}

/* ------------------------------------------------------------- helpers */

/** Every row of a query. */
export async function all(sql, params = []) {
  const [rows] = await getPool().query(sql, params);
  return rows;
}

/** The first row, or undefined. */
export async function one(sql, params = []) {
  const rows = await all(sql, params);
  return rows[0];
}

/** An INSERT/UPDATE/DELETE. Returns { insertId, affectedRows }. */
export async function run(sql, params = []) {
  const [result] = await getPool().query(sql, params);
  return { insertId: result.insertId, affectedRows: result.affectedRows };
}

/** A single scalar, e.g. count(*). */
export async function scalar(sql, params = []) {
  const row = await one(sql, params);
  return row ? Object.values(row)[0] : null;
}

/**
 * Record what just happened. The organisation and the person come from the
 * request context, so no caller has to pass them.
 */
export async function logActivity(entity, entityId, action, message, level = 'info') {
  try {
    await run(
      'INSERT INTO activity_log (entity, entity_id, action, level, message, org_id, user_id) VALUES (?,?,?,?,?,?,?)',
      [entity, entityId ?? null, action, level, message ?? null, currentOrgId(), currentUserId()]
    );
  } catch (err) {
    // Never let an audit-log write break the request it is describing.
    console.error('[db] activity log write failed:', err.message);
  }
}

/* -------------------------------------------------------------- schema */

/** Every kind of credential. Adding one here also widens the column on existing databases. */
const PROVIDERS = ['git', 'dockerhub', 'cloudflare', 'mysql', 'postgres', 'mongodb', 'redis'];
const PROVIDER_ENUM = PROVIDERS.map((p) => `'${p}'`).join(',');

async function createSchema() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS organisations (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      name       VARCHAR(190) NOT NULL UNIQUE,
      slug       VARCHAR(190) NOT NULL UNIQUE,
      notes      TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS users (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      org_id        INT NULL,
      active_org_id INT NULL,
      email         VARCHAR(190) NOT NULL UNIQUE,
      name          VARCHAR(190) NOT NULL,
      password_hash TEXT NOT NULL,
      role          ENUM('super_admin','admin','editor','viewer') NOT NULL DEFAULT 'viewer',
      status        ENUM('active','disabled') NOT NULL DEFAULT 'active',
      last_login_at DATETIME NULL,
      created_by    INT NULL,
      created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_user_org (org_id),
      CONSTRAINT fk_user_org FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS sessions (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      token_hash CHAR(64) NOT NULL UNIQUE,
      user_id    INT NOT NULL,
      expires_at DATETIME NOT NULL,
      ip         VARCHAR(64),
      user_agent VARCHAR(255),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_session_user (user_id),
      CONSTRAINT fk_session_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS servers (
      id                INT AUTO_INCREMENT PRIMARY KEY,
      name              VARCHAR(190) NOT NULL UNIQUE,
      host              VARCHAR(255) NOT NULL,
      port              INT NOT NULL DEFAULT 22,
      username          VARCHAR(190) NOT NULL,
      auth_type         ENUM('password','key') NOT NULL DEFAULT 'password',
      password_enc      TEXT,
      private_key_enc   TEXT,
      passphrase_enc    TEXT,
      sudo_password_enc TEXT,
      tags              VARCHAR(500),
      notes             TEXT,
      status            VARCHAR(30) NOT NULL DEFAULT 'unknown',
      last_error        TEXT,
      last_checked_at   DATETIME NULL,
      created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS server_facts (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      server_id    INT NOT NULL,
      collected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      duration_ms  INT,
      payload      JSON NOT NULL,
      KEY idx_server_collected (server_id, collected_at DESC),
      CONSTRAINT fk_facts_server FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS credentials (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      provider    ENUM(${PROVIDER_ENUM}) NOT NULL,
      name        VARCHAR(190) NOT NULL,
      username    VARCHAR(190),
      secret_enc  TEXT NOT NULL,
      extra       JSON,
      server_id   INT NULL,
      status      VARCHAR(30) NOT NULL DEFAULT 'unverified',
      last_error  TEXT,
      verified_at DATETIME NULL,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_provider_name (provider, name),
      CONSTRAINT fk_cred_server FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS projects (
      id             INT AUTO_INCREMENT PRIMARY KEY,
      name           VARCHAR(190) NOT NULL UNIQUE,
      server_id      INT NULL,
      git_cred_id    INT NULL,
      docker_cred_id INT NULL,
      cf_cred_id     INT NULL,
      repo_url       VARCHAR(500),
      branch         VARCHAR(190) DEFAULT 'main',
      domain         VARCHAR(255),
      config         JSON,
      created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_proj_server FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE SET NULL,
      CONSTRAINT fk_proj_git    FOREIGN KEY (git_cred_id) REFERENCES credentials(id) ON DELETE SET NULL,
      CONSTRAINT fk_proj_docker FOREIGN KEY (docker_cred_id) REFERENCES credentials(id) ON DELETE SET NULL,
      CONSTRAINT fk_proj_cf     FOREIGN KEY (cf_cred_id) REFERENCES credentials(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS runners (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      name          VARCHAR(190) NOT NULL,
      credential_id INT NOT NULL,
      server_id     INT NOT NULL,
      kind          ENUM('github','gitlab') NOT NULL DEFAULT 'github',
      scope         ENUM('repo','org') NOT NULL DEFAULT 'repo',
      target        VARCHAR(255) NOT NULL,
      labels        VARCHAR(500),
      runner_dir    VARCHAR(255),
      service_name  VARCHAR(190),
      service_user  VARCHAR(190),
      remote_id     VARCHAR(60),
      status        VARCHAR(30) NOT NULL DEFAULT 'pending',
      last_error    TEXT,
      install_log   MEDIUMTEXT,
      created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_runner_target_name (credential_id, target, name),
      KEY idx_runner_server (server_id),
      CONSTRAINT fk_runner_cred   FOREIGN KEY (credential_id) REFERENCES credentials(id) ON DELETE CASCADE,
      CONSTRAINT fk_runner_server FOREIGN KEY (server_id)     REFERENCES servers(id)     ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS installations (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      server_id     INT NOT NULL,
      kind          VARCHAR(40) NOT NULL,
      name          VARCHAR(190) NOT NULL,
      image         VARCHAR(190),
      tag           VARCHAR(90),
      port          INT NULL,
      container_port INT NULL,
      extra_ports   JSON,
      network       VARCHAR(190),
      volume        VARCHAR(190),
      container_id  VARCHAR(90),
      settings      JSON,
      secrets_enc   TEXT,
      status        VARCHAR(30) NOT NULL DEFAULT 'pending',
      last_error    TEXT,
      install_log   MEDIUMTEXT,
      created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_install_name (server_id, name),
      CONSTRAINT fk_install_server FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS apps (
      id             INT AUTO_INCREMENT PRIMARY KEY,
      org_id         INT NULL,
      server_id      INT NOT NULL,
      credential_id  INT NOT NULL,
      registry_cred_id INT NULL,
      name           VARCHAR(190) NOT NULL,
      repo           VARCHAR(255) NOT NULL,
      branch         VARCHAR(190) NOT NULL,
      node_version   VARCHAR(20),
      install_cmd    VARCHAR(500),
      build_cmd      VARCHAR(500),
      start_cmd      VARCHAR(500),
      port           INT NOT NULL,
      container_port INT NOT NULL,
      instances      INT NOT NULL DEFAULT 1,
      container_ports JSON,
      volumes        JSON,
      app_type       VARCHAR(30) NOT NULL DEFAULT 'node',
      output_dir     VARCHAR(190),
      containers     JSON,
      deploy_started_at DATETIME NULL,
      image          VARCHAR(255),
      tag            VARCHAR(90),
      pushed         TINYINT(1) NOT NULL DEFAULT 0,
      network        VARCHAR(190),
      restart        VARCHAR(30) NOT NULL DEFAULT 'unless-stopped',
      use_repo_dockerfile TINYINT(1) NOT NULL DEFAULT 0,
      env_enc        TEXT,
      detected       JSON,
      container_id   VARCHAR(90),
      image_bytes    BIGINT NULL,
      status         VARCHAR(30) NOT NULL DEFAULT 'pending',
      last_error     TEXT,
      deploy_log     MEDIUMTEXT,
      last_deployed_at DATETIME NULL,
      created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_app_name (server_id, name),
      KEY idx_app_org (org_id),
      CONSTRAINT fk_app_server FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      CONSTRAINT fk_app_cred   FOREIGN KEY (credential_id) REFERENCES credentials(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // A custom app can answer on several domains, each set up (and removed) on its own.
    `CREATE TABLE IF NOT EXISTS app_domains (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      org_id     INT NULL,
      app_id     INT NOT NULL,
      domain     VARCHAR(255) NOT NULL,
      port       INT NULL,
      config     JSON,
      status     VARCHAR(30) NOT NULL DEFAULT 'pending',
      error      TEXT,
      log        MEDIUMTEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_app_domain (org_id, domain),
      KEY idx_domain_app (app_id),
      CONSTRAINT fk_domain_app FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // The plans a super admin sells, which organisation is on which, and what was paid.
    `CREATE TABLE IF NOT EXISTS plans (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      name          VARCHAR(120) NOT NULL,
      slug          VARCHAR(120) NOT NULL UNIQUE,
      tagline       VARCHAR(255),
      price_monthly DECIMAL(12,2) NOT NULL DEFAULT 0,
      price_yearly  DECIMAL(12,2) NOT NULL DEFAULT 0,
      currency      VARCHAR(8) NOT NULL DEFAULT 'INR',
      limits        JSON,
      features      JSON,
      highlighted   TINYINT(1) NOT NULL DEFAULT 0,
      is_public     TINYINT(1) NOT NULL DEFAULT 1,
      sort_order    INT NOT NULL DEFAULT 0,
      status        VARCHAR(20) NOT NULL DEFAULT 'active',
      created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS subscriptions (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      org_id       INT NOT NULL,
      plan_id      INT NOT NULL,
      cycle        VARCHAR(10) NOT NULL DEFAULT 'monthly',
      amount       DECIMAL(12,2) NOT NULL DEFAULT 0,
      currency     VARCHAR(8) NOT NULL DEFAULT 'INR',
      status       VARCHAR(20) NOT NULL DEFAULT 'active',
      started_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      renews_at    DATETIME NULL,
      ended_at     DATETIME NULL,
      notes        TEXT,
      created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_sub_org (org_id),
      KEY idx_sub_plan (plan_id),
      CONSTRAINT fk_sub_org  FOREIGN KEY (org_id)  REFERENCES organisations(id) ON DELETE CASCADE,
      CONSTRAINT fk_sub_plan FOREIGN KEY (plan_id) REFERENCES plans(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS payments (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      org_id          INT NOT NULL,
      subscription_id INT NULL,
      amount          DECIMAL(12,2) NOT NULL,
      currency        VARCHAR(8) NOT NULL DEFAULT 'INR',
      paid_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      method          VARCHAR(40),
      reference       VARCHAR(190),
      notes           TEXT,
      created_by      INT NULL,
      created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_pay_org (org_id),
      KEY idx_pay_paid (paid_at),
      CONSTRAINT fk_pay_org FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // People who asked about the platform from the public site, and what was done about it.
    `CREATE TABLE IF NOT EXISTS leads (
      id             INT AUTO_INCREMENT PRIMARY KEY,
      name           VARCHAR(190) NOT NULL,
      email          VARCHAR(190) NOT NULL,
      phone          VARCHAR(40),
      company        VARCHAR(190),
      servers        VARCHAR(20),
      plan_id        INT NULL,
      cycle          VARCHAR(10),
      message        TEXT,
      form           VARCHAR(30) NOT NULL DEFAULT 'contact',
      source         VARCHAR(60),
      utm_source     VARCHAR(120),
      utm_medium     VARCHAR(120),
      utm_campaign   VARCHAR(120),
      utm_term       VARCHAR(120),
      utm_content    VARCHAR(120),
      referrer       VARCHAR(500),
      landing_path   VARCHAR(500),
      ip             VARCHAR(64),
      user_agent     VARCHAR(255),
      status         VARCHAR(20) NOT NULL DEFAULT 'new',
      value          DECIMAL(12,2) NULL,
      assigned_to    INT NULL,
      lost_reason    VARCHAR(190),
      org_id         INT NULL,
      contacted_at   DATETIME NULL,
      closed_at      DATETIME NULL,
      created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_lead_status (status),
      KEY idx_lead_created (created_at),
      KEY idx_lead_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS lead_notes (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      lead_id    INT NOT NULL,
      user_id    INT NULL,
      kind       VARCHAR(20) NOT NULL DEFAULT 'note',
      body       TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_note_lead (lead_id),
      CONSTRAINT fk_note_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS managed_services (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      server_id   INT NOT NULL,
      unit        VARCHAR(190) NOT NULL,
      description VARCHAR(255),
      exec_start  TEXT,
      unit_file   MEDIUMTEXT,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_service_unit (server_id, unit),
      CONSTRAINT fk_service_server FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS activity_log (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      entity     VARCHAR(50) NOT NULL,
      entity_id  INT NULL,
      action     VARCHAR(60) NOT NULL,
      level      VARCHAR(20) NOT NULL DEFAULT 'info',
      message    TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_created (created_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  ];

  for (const sql of statements) await getPool().query(sql);
  await addOrgScoping();
}

/* ---------------------------------------------------------- migration */

/** Tables whose rows belong to exactly one organisation. */
const SCOPED_TABLES = ['servers', 'credentials', 'projects', 'runners', 'installations', 'apps', 'managed_services', 'activity_log'];

const columnExists = async (table, column) => Boolean(await scalar(
  `SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
  [table, column]
));

/**
 * Bring a database from before organisations existed up to date: give every
 * scoped table an org_id, then put everything already in there into one
 * "Default organisation" so nothing becomes invisible.
 */
async function addOrgScoping() {
  const added = [];
  for (const table of SCOPED_TABLES) {
    if (await columnExists(table, 'org_id')) continue;
    await getPool().query(`ALTER TABLE \`${table}\` ADD COLUMN org_id INT NULL`);
    await getPool().query(`ALTER TABLE \`${table}\` ADD INDEX idx_${table}_org (org_id)`);
    added.push(table);
  }

  // The activity log also remembers who did it, once there is a "who".
  if (!await columnExists('activity_log', 'user_id')) {
    await getPool().query('ALTER TABLE activity_log ADD COLUMN user_id INT NULL');
  }

  // Columns added to tables that already exist in older installations.
  const LATER_COLUMNS = [
    ['apps', 'instances', 'INT NOT NULL DEFAULT 1'],
    ['apps', 'app_type', "VARCHAR(30) NOT NULL DEFAULT 'node'"],
    ['apps', 'output_dir', 'VARCHAR(190)'],
    ['apps', 'containers', 'JSON'],
    ['apps', 'deploy_started_at', 'DATETIME NULL'],
    ['apps', 'container_ports', 'JSON'],
    ['apps', 'volumes', 'JSON'],
    ['installations', 'extra_ports', 'JSON'],
    // A domain in front of a custom app: Cloudflare DNS + nginx + SSL, or a Cloudflare Tunnel.
    ['apps', 'domain', 'VARCHAR(255) NULL'],
    ['apps', 'domain_config', 'JSON'],
    ['apps', 'domain_status', 'VARCHAR(30) NULL'],
    ['apps', 'domain_error', 'TEXT'],
    ['apps', 'domain_log', 'MEDIUMTEXT'],
    // The project's folder inside its repository, for repositories holding several apps.
    ['apps', 'root_dir', 'VARCHAR(255) NULL'],
    // A super admin can suspend an organisation: its people cannot sign in to it.
    ['organisations', 'status', "VARCHAR(20) NOT NULL DEFAULT 'active'"],
    // What the visitor's browser reported about their computer when they sent the form.
    // A mobile number — required for admins and super admins.
    ['users', 'phone', 'VARCHAR(32) NULL'],
    ['leads', 'device', 'JSON'],
    // Telling one person apart from another, and where their connection is.
    ['leads', 'visitor_id', 'VARCHAR(64) NULL'],
    ['leads', 'fingerprint', 'CHAR(64) NULL'],
    ['leads', 'visit', 'JSON'],
    ['leads', 'geo', 'JSON'],
    ['leads', 'country', 'VARCHAR(2) NULL'],
  ];
  for (const [table, column, definition] of LATER_COLUMNS) {
    if (await columnExists(table, column)) continue;
    await getPool().query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    console.log(`[db] Added ${table}.${column}.`);
  }

  // Apps used to carry one domain in their own columns; each becomes a row of app_domains.
  const moved = await run(`INSERT INTO app_domains (org_id, app_id, domain, config, status, error, log)
    SELECT a.org_id, a.id, a.domain, a.domain_config, COALESCE(a.domain_status, 'pending'), a.domain_error, a.domain_log
      FROM apps a
     WHERE a.domain IS NOT NULL AND a.domain <> ''
       AND NOT EXISTS (SELECT 1 FROM app_domains d WHERE d.app_id = a.id AND d.domain = a.domain)`);
  if (moved.affectedRows) {
    await getPool().query('UPDATE apps SET domain = NULL, domain_config = NULL, domain_status = NULL, domain_error = NULL, domain_log = NULL WHERE domain IS NOT NULL');
    console.log(`[db] Moved ${moved.affectedRows} app domain(s) into app_domains.`);
  }

  // Credential kinds added later (PostgreSQL, MongoDB, Redis) widen the ENUM.
  const providerType = String(await scalar(
    `SELECT COLUMN_TYPE FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'credentials' AND column_name = 'provider'`
  ) || '');
  if (PROVIDERS.some((p) => !providerType.includes(`'${p}'`))) {
    await getPool().query(`ALTER TABLE credentials MODIFY provider ENUM(${PROVIDER_ENUM}) NOT NULL`);
    console.log('[db] Credentials can now be PostgreSQL, MongoDB and Redis connections.');
  }

  // Super admins run the platform and belong to no organisation; they only open one to work in it.
  const lifted = await run("UPDATE users SET org_id = NULL, active_org_id = NULL WHERE role = 'super_admin' AND org_id IS NOT NULL");
  if (lifted.affectedRows) console.log(`[db] ${lifted.affectedRows} super admin(s) now run the platform instead of sitting in an organisation.`);

  const orphans = Number(await scalar('SELECT COUNT(*) FROM servers WHERE org_id IS NULL'))
    + Number(await scalar('SELECT COUNT(*) FROM credentials WHERE org_id IS NULL'));
  if (!orphans) return;

  // Everything that predates organisations lands in one, so it stays reachable.
  let org = await one('SELECT * FROM organisations ORDER BY id LIMIT 1');
  if (!org) {
    const { insertId } = await run(
      'INSERT INTO organisations (name, slug, notes) VALUES (?,?,?)',
      ['Default organisation', 'default', 'Created automatically for the servers and credentials that were here before organisations existed.']
    );
    org = { id: insertId, name: 'Default organisation' };
  }

  for (const table of SCOPED_TABLES) {
    await getPool().query(`UPDATE \`${table}\` SET org_id = ? WHERE org_id IS NULL`, [org.id]);
  }
  console.log(`[db] Moved existing servers and credentials into "${org.name}"${added.length ? ` (added org_id to ${added.join(', ')})` : ''}.`);
}

function explainConnectionFailure(err) {
  const { host, port, user, database } = config.db;
  const where = `${user}@${host}:${port} (database "${database}")`;
  const msg = String(err?.message || err);

  if (/ER_ACCESS_DENIED_ERROR|Access denied/i.test(msg)) {
    return `MySQL refused the panel's credentials for ${where}. Check DB_USER and DB_PASSWORD in your .env.`;
  }
  if (/ECONNREFUSED/i.test(msg)) {
    return `Could not reach MySQL at ${host}:${port}. Is the server running, and are DB_HOST and DB_PORT right in your .env?`;
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) {
    return `The MySQL host "${host}" could not be resolved. Check DB_HOST in your .env.`;
  }
  if (/ETIMEDOUT|timeout/i.test(msg)) {
    return `Timed out connecting to MySQL at ${host}:${port}. Check the network and any firewall between this machine and MySQL.`;
  }
  return `Could not connect to MySQL at ${where}: ${msg}`;
}
