/**
 * Connectors — programs on people's PCs that let the panel reach what those
 * PCs can reach (see lib/connectorHub.js). A connector is a name and a token;
 * the token is shown once, when it is made, and only its hash is kept.
 */

import { Router } from 'express';
import { all, one, run, logActivity } from '../db/index.js';
import { requirePermission } from '../lib/authGuard.js';
import { newToken, hashToken, connectorLive, dropConnector } from '../lib/connectorHub.js';

export const connectorsRouter = Router();

const getRow = (id, orgId) => one('SELECT * FROM connectors WHERE id = ? AND org_id = ?', [id, orgId]);

function publicConnector(row) {
  const { token_hash, ...rest } = row;
  const live = connectorLive(row.id);
  return { ...rest, online: Boolean(live), live };
}

function validName(body) {
  const name = String(body.name || '').trim();
  if (!name) return { error: 'Give the connector a name, for example "My laptop"' };
  if (name.length > 100) return { error: 'The name is too long' };
  return { value: name };
}

connectorsRouter.get('/', async (req, res, next) => {
  try {
    const rows = await all('SELECT * FROM connectors WHERE org_id = ? ORDER BY created_at', [req.orgId]);
    res.json(rows.map((r) => publicConnector(r)));
  } catch (err) { next(err); }
});

/** A new connector. The answer carries its token — the only time it is shown. */
connectorsRouter.post('/', requirePermission('create'), async (req, res, next) => {
  try {
    const named = validName(req.body);
    if (named.error) return res.status(400).json({ error: named.error });
    const token = newToken();
    const { insertId } = await run('INSERT INTO connectors (org_id, name, token_hash) VALUES (?,?,?)', [req.orgId, named.value, hashToken(token)]);
    await logActivity('connector', insertId, 'created', `Created connector ${named.value}`);
    res.status(201).json({ ...publicConnector(await getRow(insertId, req.orgId)), token });
  } catch (err) { next(err); }
});

/** A new token: the old one stops working and any running copy is disconnected. */
connectorsRouter.post('/:id/token', requirePermission('edit'), async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Connector not found' });
    const token = newToken();
    await run('UPDATE connectors SET token_hash = ? WHERE id = ?', [hashToken(token), row.id]);
    dropConnector(row.id, 'Its token was replaced in the panel. Download the connector again.');
    await logActivity('connector', row.id, 'token_replaced', `Replaced the token of connector ${row.name}`);
    res.json({ ...publicConnector(await getRow(row.id, req.orgId)), token });
  } catch (err) { next(err); }
});

connectorsRouter.put('/:id', requirePermission('edit'), async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Connector not found' });
    const named = validName(req.body);
    if (named.error) return res.status(400).json({ error: named.error });
    await run('UPDATE connectors SET name = ? WHERE id = ?', [named.value, row.id]);
    res.json(publicConnector(await getRow(row.id, req.orgId)));
  } catch (err) { next(err); }
});

connectorsRouter.delete('/:id', requirePermission('delete'), async (req, res, next) => {
  try {
    const row = await getRow(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Connector not found' });
    await run('DELETE FROM connectors WHERE id = ?', [row.id]);
    dropConnector(row.id, 'This connector was deleted in the panel.');
    await logActivity('connector', null, 'deleted', `Deleted connector ${row.name}`);
    res.json({ ok: true });
  } catch (err) { next(err); }
});
