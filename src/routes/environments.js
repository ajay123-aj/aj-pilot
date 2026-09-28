/**
 * /api/environments — the organisation's named sets of variables.
 *
 * Everyone in the organisation can list them and see which variables each one
 * has; only a role that can edit sees the values. Creating, changing and
 * deleting follow the usual role checks (guardMutations in index.js).
 */

import { Router } from 'express';
import { all, run, logActivity } from '../db/index.js';
import { encrypt } from '../lib/crypto.js';
import { can } from '../lib/auth.js';
import { RESERVED, MAX_VARS } from '../lib/envVars.js';
import {
  getEnvironment, environmentPairs, publicEnvironment, createEnvironment, validateEnvironmentName, parseEnvironmentVars,
} from '../lib/environments.js';

export const environmentsRouter = Router();

const summary = (pairs) => `${pairs.length} variable${pairs.length === 1 ? '' : 's'}`;

environmentsRouter.get('/', async (req, res, next) => {
  try {
    const rows = await all('SELECT * FROM environments WHERE org_id = ? ORDER BY name', [req.orgId]);
    res.json({
      environments: await Promise.all(rows.map((r) => publicEnvironment(r))),
      canSeeValues: can(req.user, 'edit'),
      max: MAX_VARS,
    });
  } catch (err) { next(err); }
});

environmentsRouter.get('/:id', async (req, res, next) => {
  try {
    const row = await getEnvironment(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Environment not found' });
    const withValues = can(req.user, 'edit');
    res.json({ ...(await publicEnvironment(row, { withValues })), canSeeValues: withValues });
  } catch (err) { next(err); }
});

environmentsRouter.post('/', async (req, res, next) => {
  try {
    const parsed = parseEnvironmentVars(req.body.env);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const made = await createEnvironment({
      orgId: req.orgId, userId: req.user.id, name: req.body.name, description: req.body.description, pairs: parsed.pairs,
    });
    if (made.error) return res.status(made.status || 400).json({ error: made.error });
    res.status(201).json({ ok: true, ...(await publicEnvironment(made.row, { withValues: true })) });
  } catch (err) { next(err); }
});

/** A copy under a new name — a staging set made from production, say. */
environmentsRouter.post('/:id/duplicate', async (req, res, next) => {
  try {
    const row = await getEnvironment(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Environment not found' });
    const made = await createEnvironment({
      orgId: req.orgId, userId: req.user.id, name: req.body.name || `${row.name} copy`,
      description: row.description, pairs: environmentPairs(row),
    });
    if (made.error) return res.status(made.status || 400).json({ error: made.error });
    res.status(201).json({ ok: true, ...(await publicEnvironment(made.row, { withValues: true })) });
  } catch (err) { next(err); }
});

/**
 * Change the name, description or variables. With `sync_apps` every app made
 * from this environment gets the new variables too — they apply at its next
 * deploy or restart, as any change to an app's environment does.
 */
environmentsRouter.put('/:id', async (req, res, next) => {
  try {
    const row = await getEnvironment(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Environment not found' });

    const named = validateEnvironmentName(req.body.name ?? row.name);
    if (named.error) return res.status(400).json({ error: named.error });
    if (named.value !== row.name && (await all('SELECT id FROM environments WHERE org_id = ? AND name = ? AND id <> ?', [req.orgId, named.value, row.id])).length) {
      return res.status(409).json({ error: `There is already an environment called "${named.value}"` });
    }

    const parsed = req.body.env === undefined ? { pairs: environmentPairs(row) } : parseEnvironmentVars(req.body.env);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const description = req.body.description === undefined ? row.description : String(req.body.description || '').trim().slice(0, 255) || null;
    await run('UPDATE environments SET name = ?, description = ?, env_enc = ?, var_count = ? WHERE id = ?',
      [named.value, description, encrypt(JSON.stringify(parsed.pairs)), parsed.pairs.length, row.id]);

    let synced = 0;
    if (req.body.sync_apps === true || req.body.sync_apps === 'true') {
      const forApps = parsed.pairs.filter(([k]) => !RESERVED.has(k));
      const apps = await all('SELECT id, name, env_enc FROM apps WHERE environment_id = ? AND org_id = ?', [row.id, req.orgId]);
      for (const app of apps) {
        // The environment's values win; a variable only this app has is kept, never dropped.
        const merged = new Map(environmentPairs(app));
        for (const [k, v] of forApps) merged.set(k, v);
        await run('UPDATE apps SET env_enc = ? WHERE id = ?', [encrypt(JSON.stringify([...merged])), app.id]);
        await logActivity('app', app.id, 'app_env', `${app.name}: environment updated from "${named.value}" — applies at the next deploy`);
      }
      synced = apps.length;
    }

    await logActivity('environment', row.id, 'environment_update',
      `Environment "${named.value}" saved with ${summary(parsed.pairs)}${synced ? `, copied to ${synced} app(s)` : ''}`);
    const saved = await getEnvironment(row.id, req.orgId);
    res.json({ ok: true, synced, ...(await publicEnvironment(saved, { withValues: true })) });
  } catch (err) { next(err); }
});

/** Apps and services made from it keep their own copy of the variables; only the link goes. */
environmentsRouter.delete('/:id', async (req, res, next) => {
  try {
    const row = await getEnvironment(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Environment not found' });
    await run('UPDATE apps SET environment_id = NULL WHERE environment_id = ? AND org_id = ?', [row.id, req.orgId]);
    await run('UPDATE installations SET environment_id = NULL WHERE environment_id = ? AND org_id = ?', [row.id, req.orgId]);
    await run('DELETE FROM environments WHERE id = ?', [row.id]);
    await logActivity('environment', row.id, 'environment_delete', `Environment "${row.name}" deleted`);
    res.json({ ok: true });
  } catch (err) { next(err); }
});
