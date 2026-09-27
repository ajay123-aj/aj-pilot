/**
 * Environment variables for a custom service.
 *
 * The panel accepts a whole `.env` file exactly as it comes out of a project —
 * comments, blank lines, `export` prefixes and quoted values and all — and
 * turns it into the plain pairs Docker is given with `-e`. Quoting is the only
 * thing interpreted: a value wrapped in matching quotes keeps its spaces, and
 * everything else is taken literally.
 */

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Set by the deploy itself for every container. A pasted .env almost always has
 * PORT in it, so these are left out quietly (and reported) rather than refused.
 */
export const RESERVED = new Set(['PORT', 'INSTANCE']);

export const MAX_VARS = 200;

/** `"a b"` / `'a b'` → `a b`. Anything else is kept exactly as written. */
function unquote(raw) {
  const value = String(raw ?? '').trim();
  const first = value[0];
  if ((first === '"' || first === "'") && value.length > 1 && value.endsWith(first)) {
    const inner = value.slice(1, -1);
    // One pass, so an escaped backslash is not then read as an escape itself.
    return first === '"' ? inner.replace(/\\(n|"|\\)/g, (_, c) => (c === 'n' ? '\n' : c)) : inner;
  }
  return value;
}

/**
 * Parse `.env` text into `[[key, value], …]`.
 * Returns `{ pairs, skipped, error }` — the first bad line wins, so the person is
 * told about one problem at a time rather than a wall of them. `skipped` lists
 * the reserved keys (PORT, INSTANCE) that were left out.
 */
export function parseEnvText(text) {
  const pairs = [];
  const skipped = new Set();
  const index = new Map();
  const lines = String(text ?? '').split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;

    const body = line.replace(/^export\s+/, '');
    const eq = body.indexOf('=');
    if (eq <= 0) {
      return { pairs: [], error: `Line ${i + 1} is not KEY=value: "${body.slice(0, 40)}"` };
    }

    const key = body.slice(0, eq).trim();
    if (!KEY.test(key)) {
      return { pairs: [], error: `"${key.slice(0, 40)}" on line ${i + 1} is not a valid environment variable name` };
    }
    if (RESERVED.has(key)) {
      skipped.add(key);
      continue;
    }

    // A file that repeats a key keeps the last one, exactly as a shell would.
    const pair = [key, unquote(body.slice(eq + 1))];
    if (index.has(key)) pairs[index.get(key)] = pair;
    else {
      index.set(key, pairs.length);
      pairs.push(pair);
    }
  }

  if (pairs.length > MAX_VARS) {
    return { pairs: [], skipped: [...skipped], error: `That is ${pairs.length} variables — ${MAX_VARS} is the most one service can take` };
  }
  return { pairs, skipped: [...skipped], error: null };
}

/**
 * Accept either `.env` text or the `[[key, value], …]` the editor sends.
 * Pairs are validated the same way, so neither route can smuggle a bad name in.
 */
export function parseEnvInput(input) {
  if (typeof input === 'string' || input === null || input === undefined) return parseEnvText(input);
  if (!Array.isArray(input)) return { pairs: [], skipped: [], error: 'The environment must be a list of KEY=value pairs' };

  const asText = input.map((entry) => {
    const [k, v] = Array.isArray(entry) ? entry : [entry?.key, entry?.value];
    return `${String(k ?? '').trim()}=${JSON.stringify(String(v ?? ''))}`;
  }).join('\n');
  return parseEnvText(asText);
}

/** The pairs back as `.env` text, for the editor to show. */
export const formatEnvText = (pairs = []) =>
  pairs.map(([k, v]) => `${k}=${/[\s"']/.test(String(v)) ? JSON.stringify(String(v)) : v}`).join('\n');
