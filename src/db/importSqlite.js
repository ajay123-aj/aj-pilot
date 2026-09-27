import fs from 'node:fs';
import { config } from '../config.js';
import { all, one, run, scalar } from './index.js';

/**
 * One-time import of the old SQLite store into MySQL.
 *
 * Runs only when the SQLite file still exists AND the MySQL tables are empty,
 * so it can never overwrite live data or run twice. Secrets move across as
 * ciphertext — the master key is unchanged, so they keep working.
 *
 * The SQLite file is renamed to .imported afterwards rather than deleted.
 */
export async function importSqliteIfPresent() {
  if (!fs.existsSync(config.sqliteFile)) return null;

  const existing = Number(await scalar('SELECT COUNT(*) FROM servers')) + Number(await scalar('SELECT COUNT(*) FROM credentials'));
  if (existing > 0) return null;

  let Database;
  try {
    ({ default: Database } = await import('better-sqlite3'));
  } catch {
    console.warn('[import] better-sqlite3 is not installed, skipping the SQLite import.');
    return null;
  }

  // Not read-only: the file may be in WAL mode, and we checkpoint below so the
  // archived .db is complete on its own rather than depending on its -wal file.
  const sqlite = new Database(config.sqliteFile);
  const tables = new Set(
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name)
  );
  const read = (table) => (tables.has(table) ? sqlite.prepare(`SELECT * FROM ${table}`).all() : []);

  const servers = read('servers');
  const facts = read('server_facts');
  const credentials = read('credentials');
  const activity = read('activity_log');

  if (!servers.length && !credentials.length) {
    sqlite.close();
    return null;
  }

  const serverIdMap = new Map();

  for (const s of servers) {
    const { insertId } = await run(
      `INSERT INTO servers (name, host, port, username, auth_type, password_enc, private_key_enc,
         passphrase_enc, sudo_password_enc, tags, notes, status, last_error, last_checked_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [s.name, s.host, s.port, s.username, s.auth_type, s.password_enc, s.private_key_enc,
        s.passphrase_enc, s.sudo_password_enc, s.tags, s.notes, s.status, s.last_error,
        s.last_checked_at || null, s.created_at || new Date()]
    );
    serverIdMap.set(s.id, insertId);
  }

  let factCount = 0;
  for (const f of facts) {
    const serverId = serverIdMap.get(f.server_id);
    if (!serverId) continue;
    await run(
      'INSERT INTO server_facts (server_id, collected_at, duration_ms, payload) VALUES (?,?,?,?)',
      [serverId, f.collected_at, f.duration_ms, f.payload]
    );
    factCount += 1;
  }

  for (const c of credentials) {
    await run(
      `INSERT INTO credentials (provider, name, username, secret_enc, extra, server_id, status, last_error, verified_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [c.provider, c.name, c.username, c.secret_enc, c.extra || '{}',
        c.server_id ? serverIdMap.get(c.server_id) ?? null : null,
        c.status, c.last_error, c.verified_at || null, c.created_at || new Date()]
    );
  }

  for (const a of activity) {
    await run(
      'INSERT INTO activity_log (entity, entity_id, action, level, message, created_at) VALUES (?,?,?,?,?,?)',
      [a.entity, a.entity === 'server' ? serverIdMap.get(a.entity_id) ?? null : a.entity_id,
        a.action, a.level, a.message, a.created_at || new Date()]
    );
  }

  // Fold the write-ahead log back into the main file, otherwise the archive we
  // keep would be an empty shell and the real rows would be thrown away.
  try {
    sqlite.pragma('wal_checkpoint(TRUNCATE)');
    sqlite.pragma('journal_mode = DELETE');
  } catch (err) {
    console.warn(`[import] Could not checkpoint the SQLite WAL: ${err.message}`);
  }
  sqlite.close();

  const archived = `${config.sqliteFile}.imported`;
  try {
    fs.renameSync(config.sqliteFile, archived);
    // Any leftover -wal/-shm are now empty; move them aside rather than delete.
    for (const suffix of ['-wal', '-shm']) {
      const extra = `${config.sqliteFile}${suffix}`;
      if (fs.existsSync(extra)) fs.renameSync(extra, `${archived}${suffix}`);
    }
  } catch (err) {
    console.warn(`[import] Could not archive the SQLite file: ${err.message}`);
  }

  const summary = { servers: servers.length, facts: factCount, credentials: credentials.length, activity: activity.length, archived };
  console.log(`[import] Moved ${summary.servers} server(s), ${summary.facts} system profile(s), ${summary.credentials} credential(s) from SQLite into MySQL.`);
  return summary;
}
