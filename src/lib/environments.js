/**
 * Environments: named sets of variables an organisation keeps in one place
 * and hands to its apps and installed services.
 *
 * The values are encrypted like every other secret here. An app or an
 * installation made from an environment keeps its own copy (Docker fixes a
 * container's environment when it is created) plus a link back, so the page
 * can show where each environment is used and push a change out to its apps.
 */

import { all, one, run, logActivity } from '../db/index.js';
import { encrypt, decrypt } from './crypto.js';
import { parseEnvInput } from './envVars.js';

const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,119}$/;

/** The stored pairs, or none if they cannot be read. */
export function environmentPairs(row) {
  try {
    return row?.env_enc ? JSON.parse(decrypt(row.env_enc)) : [];
  } catch {
    return [];
  }
}

export const getEnvironment = (id, orgId) => one('SELECT * FROM environments WHERE id = ? AND org_id = ?', [Number(id), orgId]);

export function validateEnvironmentName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) return { error: 'Give the environment a name' };
  if (!NAME.test(name)) return { error: 'An environment name is up to 120 letters, numbers, spaces, dots, dashes or underscores, starting with a letter or number' };
  return { value: name };
}

/**
 * The variables from a request, kept exactly — PORT included, since a systemd
 * service or a script may well want it. Apps drop it themselves when they apply.
 */
export const parseEnvironmentVars = (input) => parseEnvInput(input, { keepReserved: true });

/** Save a new environment. Returns `{ row }` or `{ error, status }`. */
export async function createEnvironment({ orgId, userId = null, name, description = '', pairs = [] }) {
  const named = validateEnvironmentName(name);
  if (named.error) return { error: named.error, status: 400 };
  if (await one('SELECT id FROM environments WHERE org_id = ? AND name = ?', [orgId, named.value])) {
    return { error: `There is already an environment called "${named.value}"`, status: 409 };
  }
  const { insertId } = await run(
    'INSERT INTO environments (org_id, name, description, env_enc, var_count, created_by) VALUES (?,?,?,?,?,?)',
    [orgId, named.value, String(description || '').trim().slice(0, 255) || null, encrypt(JSON.stringify(pairs)), pairs.length, userId]
  );
  await logActivity('environment', insertId, 'environment_create', `Environment "${named.value}" created with ${pairs.length} variable(s)`);
  return { row: await one('SELECT * FROM environments WHERE id = ?', [insertId]) };
}

/** Where an environment is in use, for its row on the page and before it is deleted. */
export async function environmentUsage(id) {
  const [apps, installs] = await Promise.all([
    all('SELECT a.id, a.name, s.name AS server FROM apps a LEFT JOIN servers s ON s.id = a.server_id WHERE a.environment_id = ? ORDER BY a.name', [id]),
    all('SELECT i.id, i.name, i.kind, s.name AS server FROM installations i LEFT JOIN servers s ON s.id = i.server_id WHERE i.environment_id = ? ORDER BY i.name', [id]),
  ]);
  return { apps, installs };
}

/**
 * An environment as the browser may see it. Values are only included for a
 * role that can edit — a view-only person sees which variables exist, not what they hold.
 */
export async function publicEnvironment(row, { withValues = false, withUsage = true } = {}) {
  const pairs = environmentPairs(row);
  const creator = row.created_by ? await one('SELECT name FROM users WHERE id = ?', [row.created_by]) : null;
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    count: pairs.length,
    keys: pairs.map(([k]) => k),
    env: withValues ? pairs : undefined,
    createdBy: creator?.name || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    usage: withUsage ? await environmentUsage(row.id) : undefined,
  };
}

/**
 * The environment a create form asked for: an existing one to link to, or a
 * new one to make from the variables being used. Returns `{ id }`, `{ id: null }`
 * for none, or `{ error, status }`. With `check` nothing is written — used
 * before the app or service itself is created, so a bad name stops everything.
 */
export async function resolveEnvironmentChoice(body, { orgId, userId, pairs, fallbackName, check = false }) {
  const mode = String(body.environment_mode || (body.environment_id ? 'existing' : body.environment_name ? 'new' : 'none'));
  if (mode === 'existing') {
    const row = await getEnvironment(body.environment_id, orgId);
    if (!row) return { error: 'Pick the environment to use, or choose "None"', status: 400 };
    return { id: row.id };
  }
  if (mode === 'new' && check) {
    const named = validateEnvironmentName(body.environment_name || fallbackName);
    if (named.error) return { error: named.error, status: 400 };
    if (await one('SELECT id FROM environments WHERE org_id = ? AND name = ?', [orgId, named.value])) {
      return { error: `There is already an environment called "${named.value}" — pick it under "Use an existing one", or choose another name`, status: 409 };
    }
    return { id: null };
  }
  if (mode === 'new') {
    const made = await createEnvironment({ orgId, userId, name: body.environment_name || fallbackName, pairs });
    if (made.error) return made;
    return { id: made.row.id, created: true };
  }
  return { id: null };
}
