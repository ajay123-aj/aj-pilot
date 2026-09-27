/**
 * The shapes every database engine answers in, so one page in the browser can
 * draw PostgreSQL, MongoDB and Redis alike.
 *
 *   stat   { label, value, sub?, pct? }                  a tile
 *   kv     { title, pairs: [[key, value], …] }           a key/value card
 *   table  { title, columns: [{ label, num? }], rows: [[cell, …]], empty? }
 *   cell   a string or number, or { text, badge?, code?, link?, small? }
 *          where `link` is { database } or { database, item } to drill into
 *   field  { name, label, type, options?, required?, placeholder?, hint?, default? }
 *
 * Values are formatted here, not in the browser, because only the engine knows
 * whether 131072 is kilobytes, pages or a key count.
 */

export const stat = (label, value, sub = '', pct = null) => ({
  label, value: value === null || value === undefined || value === '' ? '—' : String(value), sub: sub || '', pct,
});

export const kv = (title, pairs) => ({
  title,
  pairs: pairs.filter(([, v]) => v !== undefined).map(([k, v]) => [k, v === null || v === '' ? '—' : v]),
});

export const table = (title, columns, rows, empty = 'Nothing here') => ({
  title,
  columns: columns.map((c) => (typeof c === 'string' ? { label: c } : c)),
  rows,
  empty,
});

export const num = (label) => ({ label, num: true });
export const badge = (text, tone = '') => ({ text, badge: tone });
export const code = (text) => ({ text, code: true });
export const small = (text) => ({ text, small: true });
export const link = (text, target) => ({ text, link: target });

export const field = (name, label, opts = {}) => ({
  name,
  label,
  type: opts.type || 'text',
  options: opts.options || null,
  required: Boolean(opts.required),
  placeholder: opts.placeholder || '',
  hint: opts.hint || '',
  default: opts.default ?? '',
});

export function bytes(n) {
  if (n === null || n === undefined || n === '' || Number.isNaN(Number(n))) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

export const count = (n) => (n === null || n === undefined || Number.isNaN(Number(n)) ? '—' : Number(n).toLocaleString('en-US'));

export function uptime(seconds) {
  const s = Number(seconds || 0);
  if (!s) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return [d ? `${d}d` : null, d || h ? `${h}h` : null, `${m}m`].filter(Boolean).join(' ');
}

export const percent = (part, whole) => (Number(whole) ? Math.round((Number(part) / Number(whole)) * 100) : null);

/** Anything a driver returns, as text for a table cell. */
export function text(v, max = 300) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v.length > max ? `${v.slice(0, max)}…` : v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return `<${v.length} bytes>`;
  let s;
  try { s = JSON.stringify(v); } catch { s = String(v); }
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** A change was asked for that does not make sense for this engine. */
export function unsupported(what, engine) {
  return new Error(`${engine} has no ${what}`);
}

/** A password good enough to hand to a database. */
export function checkPassword(password) {
  if (!password || String(password).length < 8) throw new Error('The password must be at least 8 characters');
  return String(password);
}

/** Type the name back to confirm a destructive change. */
export function checkConfirm(name, confirm) {
  if (String(confirm ?? '') !== String(name)) throw new Error('Type the name exactly to confirm');
}
