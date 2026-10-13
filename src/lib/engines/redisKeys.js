/**
 * Redis key management: find keys, read them a page at a time, and change them.
 *
 * Finding always uses SCAN (never KEYS, which blocks a busy server while it
 * walks every key). Reading pages through big hashes, sets and lists with the
 * matching *SCAN / LRANGE, so a key with a million members costs no more than
 * one with ten. Every change is one small, specific command — there is no
 * "run anything" here; that stays read-only on the query page.
 */

import { withRedis, dbIndex } from './redis.js';

const PAGE = 200;
const STRING_LIMIT = 512 * 1024;
const GLOB = /[*?[\]]/;

const maybe = async (p) => { try { return await p; } catch { return null; } };

function keyName(key, what = 'Key') {
  const k = String(key ?? '');
  if (!k) throw new Error(`${what} name is required`);
  if (k.length > 4096) throw new Error(`${what} name is too long`);
  return k;
}

/** The details shown on each row of the key list. */
async function describe(cmd, key) {
  const [type, ttl, mem] = await Promise.all([cmd('TYPE', key), cmd('TTL', key), maybe(cmd('MEMORY', 'USAGE', key))]);
  return { key, type, ttl: Number(ttl), mem: mem === null ? null : Number(mem) };
}

/* ----------------------------------------------------------------- find */

/**
 * One page of keys matching `pattern` (Redis glob: * ? [abc]) and, optionally,
 * one type. A plain word with no glob characters finds keys containing it.
 * Pass the returned cursor back to continue; "0" means the scan is complete.
 */
export async function scanKeys(cfg, { database = 'db0', pattern = '', type = '', cursor = '0' } = {}) {
  const index = dbIndex(database);
  const raw = String(pattern || '').trim();
  const match = !raw ? '*' : GLOB.test(raw) ? raw : `*${raw}*`;
  const wantType = ['string', 'hash', 'list', 'set', 'zset', 'stream'].includes(type) ? type : '';

  return withRedis(cfg, async (cmd) => {
    const found = [];
    // An exact key name is shown first, without waiting for the scan to reach it.
    if (raw && !GLOB.test(raw) && String(cursor) === '0' && Number(await cmd('EXISTS', raw))) found.push(raw);

    let next = String(cursor || '0');
    let rounds = 0;
    do {
      const args = ['SCAN', next, 'MATCH', match, 'COUNT', 1000];
      const [c, batch] = await cmd(...args);
      next = c;
      for (const k of batch) if (!found.includes(k)) found.push(k);
      rounds += 1;
    } while (next !== '0' && found.length < PAGE && rounds < 40);

    const described = await Promise.all(found.slice(0, PAGE * 2).map((k) => describe(cmd, k)));
    // A key can expire between SCAN and TYPE; those come back as "none".
    const keys = described.filter((d) => d.type !== 'none' && (!wantType || d.type === wantType));
    return {
      database,
      pattern: match,
      keys,
      cursor: next,
      done: next === '0',
      dbSize: Number(await cmd('DBSIZE')),
    };
  }, index);
}

/* ----------------------------------------------------------------- read */

/**
 * One key and one page of its value. `cursor` continues a hash / set / zset
 * scan, `offset` a list or sorted-set range, `after` a stream; `match`
 * filters fields or members (hash, set, zset) with a glob.
 */
export async function readKey(cfg, { database = 'db0', key, cursor = '0', offset = 0, match = '', after = '' } = {}) {
  const index = dbIndex(database);
  const k = keyName(key);
  return withRedis(cfg, async (cmd) => {
    const type = await cmd('TYPE', k);
    if (type === 'none') throw new Error(`Key "${k}" does not exist — it may have expired or been deleted`);
    const [ttl, mem, encoding] = await Promise.all([cmd('TTL', k), maybe(cmd('MEMORY', 'USAGE', k)), maybe(cmd('OBJECT', 'ENCODING', k))]);
    const out = { database, key: k, type, ttl: Number(ttl), mem: mem === null ? null : Number(mem), encoding };
    const m = String(match || '').trim();
    const filter = !m ? null : GLOB.test(m) ? m : `*${m}*`;

    if (type === 'string') {
      out.size = Number(await cmd('STRLEN', k));
      out.value = await cmd('GETRANGE', k, 0, STRING_LIMIT - 1);
      out.truncated = out.size > STRING_LIMIT;
    } else if (type === 'hash') {
      out.size = Number(await cmd('HLEN', k));
      const [c, flat] = await cmd('HSCAN', k, String(cursor || '0'), ...(filter ? ['MATCH', filter] : []), 'COUNT', PAGE);
      out.fields = [];
      for (let i = 0; i < flat.length; i += 2) out.fields.push({ field: flat[i], value: flat[i + 1] });
      out.cursor = c;
    } else if (type === 'list') {
      out.size = Number(await cmd('LLEN', k));
      const from = Math.max(0, Number(offset) || 0);
      out.offset = from;
      out.items = (await cmd('LRANGE', k, from, from + PAGE - 1)).map((value, i) => ({ index: from + i, value }));
      out.cursor = from + PAGE < out.size ? String(from + PAGE) : '0';
    } else if (type === 'set') {
      out.size = Number(await cmd('SCARD', k));
      const [c, members] = await cmd('SSCAN', k, String(cursor || '0'), ...(filter ? ['MATCH', filter] : []), 'COUNT', PAGE);
      out.members = members;
      out.cursor = c;
    } else if (type === 'zset') {
      out.size = Number(await cmd('ZCARD', k));
      const pairs = [];
      if (filter) {
        const [c, flat] = await cmd('ZSCAN', k, String(cursor || '0'), 'MATCH', filter, 'COUNT', PAGE);
        for (let i = 0; i < flat.length; i += 2) pairs.push({ member: flat[i], score: Number(flat[i + 1]) });
        out.cursor = c;
      } else {
        const from = Math.max(0, Number(offset) || 0);
        const flat = await cmd('ZRANGE', k, from, from + PAGE - 1, 'WITHSCORES');
        for (let i = 0; i < flat.length; i += 2) pairs.push({ rank: from + i / 2, member: flat[i], score: Number(flat[i + 1]) });
        out.offset = from;
        out.cursor = from + PAGE < out.size ? String(from + PAGE) : '0';
      }
      out.members = pairs;
    } else if (type === 'stream') {
      out.size = Number(await cmd('XLEN', k));
      const end = after ? `(${after}` : '+';
      const entries = await cmd('XREVRANGE', k, end, '-', 'COUNT', 50);
      out.entries = entries.map(([id, flat]) => {
        const fields = {};
        for (let i = 0; i < flat.length; i += 2) fields[flat[i]] = flat[i + 1];
        return { id, fields };
      });
      out.cursor = entries.length === 50 ? entries[entries.length - 1][0] : '0';
    } else {
      out.unsupported = true;
    }
    return out;
  }, index);
}

/* --------------------------------------------------------------- change */

const ttlSeconds = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 0) throw new Error('TTL must be a number of seconds, 0 or more');
  return n;
};

const scoreOf = (v) => {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isFinite(n)) throw new Error('A score must be a number');
  return n;
};

/** A new key with its first value. Refuses to overwrite one that exists. */
export async function createKey(cfg, b) {
  const index = dbIndex(b.database || 'db0');
  const k = keyName(b.key);
  const ttl = ttlSeconds(b.ttl);
  return withRedis(cfg, async (cmd) => {
    if (Number(await cmd('EXISTS', k))) throw new Error(`Key "${k}" already exists — open it to change it`);
    const v = String(b.value ?? '');
    switch (b.type) {
      case 'string': await cmd('SET', k, v); break;
      case 'hash': await cmd('HSET', k, keyName(b.field, 'Field'), v); break;
      case 'list': await cmd('RPUSH', k, v); break;
      case 'set': await cmd('SADD', k, v); break;
      case 'zset': await cmd('ZADD', k, scoreOf(b.score), v); break;
      case 'stream': await cmd('XADD', k, '*', keyName(b.field, 'Field'), v); break;
      default: throw new Error('Pick a type: string, hash, list, set, sorted set or stream');
    }
    if (ttl) await cmd('EXPIRE', k, ttl);
    return { summary: `created ${b.type} key "${k}" in ${b.database || 'db0'}`, key: k };
  }, index);
}

/**
 * One change to one key. `op` says which:
 *   set (string value) · hset / hdel / hrename (hash fields) ·
 *   lset / lpush / rpush / lremove (list items, by index) ·
 *   sadd / srem / sreplace (set members) · zadd / zrem (sorted set) ·
 *   xadd / xdel (stream entries) · ttl · rename
 */
export async function editKey(cfg, b) {
  const database = b.database || 'db0';
  const index = dbIndex(database);
  const k = keyName(b.key);
  const v = b.value === undefined || b.value === null ? '' : String(b.value);

  return withRedis(cfg, async (cmd) => {
    const type = await cmd('TYPE', k);
    if (type === 'none') throw new Error(`Key "${k}" does not exist — it may have expired or been deleted`);
    const needs = (t) => { if (type !== t) throw new Error(`"${k}" is a ${type}, not a ${t}`); };
    const where = `"${k}" in ${database}`;

    switch (b.op) {
      case 'set': {
        needs('string');
        // Keep the key's expiry: SET would otherwise clear it.
        const ttl = Number(await cmd('PTTL', k));
        await cmd('SET', k, v);
        if (ttl > 0) await cmd('PEXPIRE', k, ttl);
        return { summary: `changed the value of ${where}` };
      }
      case 'hset': needs('hash'); await cmd('HSET', k, keyName(b.field, 'Field'), v); return { summary: `set field "${b.field}" of ${where}` };
      case 'hdel': needs('hash'); await cmd('HDEL', k, keyName(b.field, 'Field')); return { summary: `deleted field "${b.field}" of ${where}` };
      case 'hrename': {
        needs('hash');
        const from = keyName(b.field, 'Field');
        const to = keyName(b.newField, 'New field');
        if (Number(await cmd('HEXISTS', k, to))) throw new Error(`Field "${to}" already exists`);
        const value = await cmd('HGET', k, from);
        if (value === null) throw new Error(`Field "${from}" no longer exists`);
        await cmd('HSET', k, to, value);
        await cmd('HDEL', k, from);
        return { summary: `renamed field "${from}" to "${to}" in ${where}` };
      }
      case 'lset': needs('list'); await cmd('LSET', k, Number(b.index), v); return { summary: `changed item ${b.index} of ${where}` };
      case 'lpush': needs('list'); await cmd('LPUSH', k, v); return { summary: `added an item to the start of ${where}` };
      case 'rpush': needs('list'); await cmd('RPUSH', k, v); return { summary: `added an item to the end of ${where}` };
      case 'lremove': {
        needs('list');
        // Lists have no "remove at index": mark the item, then remove the mark.
        const mark = `__aj_pilot_removed_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
        await cmd('LSET', k, Number(b.index), mark);
        await cmd('LREM', k, 1, mark);
        return { summary: `removed item ${b.index} of ${where}` };
      }
      case 'sadd': needs('set'); await cmd('SADD', k, v); return { summary: `added a member to ${where}` };
      case 'srem': needs('set'); await cmd('SREM', k, String(b.member ?? '')); return { summary: `removed a member of ${where}` };
      case 'sreplace': {
        needs('set');
        await cmd('SREM', k, String(b.member ?? ''));
        await cmd('SADD', k, v);
        return { summary: `changed a member of ${where}` };
      }
      case 'zadd': {
        needs('zset');
        // Editing a member's text is "remove the old one, add the new one".
        if (b.member !== undefined && String(b.member) !== v) await cmd('ZREM', k, String(b.member));
        await cmd('ZADD', k, scoreOf(b.score), v);
        return { summary: `set a member of ${where}` };
      }
      case 'zrem': needs('zset'); await cmd('ZREM', k, String(b.member ?? '')); return { summary: `removed a member of ${where}` };
      case 'xadd': {
        needs('stream');
        const fields = Object.entries(b.fields || {}).filter(([f]) => f);
        if (!fields.length) throw new Error('An entry needs at least one field');
        await cmd('XADD', k, '*', ...fields.flat().map(String));
        return { summary: `added an entry to ${where}` };
      }
      case 'xdel': needs('stream'); await cmd('XDEL', k, String(b.id || '')); return { summary: `deleted entry ${b.id} of ${where}` };
      case 'ttl': {
        const ttl = ttlSeconds(b.ttl);
        if (ttl === null || ttl === 0) { await cmd('PERSIST', k); return { summary: `made ${where} permanent` }; }
        await cmd('EXPIRE', k, ttl);
        return { summary: `set ${where} to expire in ${ttl}s` };
      }
      case 'rename': {
        const to = keyName(b.newKey, 'New key');
        // RENAMENX: never silently overwrite another key.
        if (!Number(await cmd('RENAMENX', k, to))) throw new Error(`Key "${to}" already exists`);
        return { summary: `renamed ${where} to "${to}"`, key: to };
      }
      default:
        throw new Error('Unknown change');
    }
  }, index);
}

/** Delete keys by name (up to 1000 at a time). UNLINK frees memory in the background. */
export async function deleteKeys(cfg, { database = 'db0', keys = [] } = {}) {
  const index = dbIndex(database);
  const list = [...new Set((Array.isArray(keys) ? keys : [keys]).map((k) => keyName(k)))];
  if (!list.length) throw new Error('Pick at least one key');
  if (list.length > 1000) throw new Error('Delete at most 1000 keys at a time');
  return withRedis(cfg, async (cmd) => {
    const removed = Number(await cmd('UNLINK', ...list).catch(() => cmd('DEL', ...list)));
    return {
      removed,
      summary: list.length === 1 ? `deleted key "${list[0]}" in ${database}` : `deleted ${removed} keys in ${database}`,
    };
  }, index);
}
