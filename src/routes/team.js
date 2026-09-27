/**
 * The people in an organisation, and the organisations themselves.
 *
 * An admin manages the members of their own organisation and nobody else's.
 * A super admin can do that in any organisation, and is the only one who can
 * create organisations or make another super admin.
 */

import { Router } from 'express';
import { all, one, run, scalar, logActivity } from '../db/index.js';
import { hashPassword, checkPassword, checkEmail, checkPhone, phoneRequired, ROLES } from '../lib/auth.js';
import { requireAuth, requirePermission, endAllSessions, publicUser } from '../lib/authGuard.js';

export const teamRouter = Router();

teamRouter.use(requireAuth);

const publicMember = (row) => ({
  id: row.id,
  name: row.name,
  email: row.email,
  phone: row.phone || null,
  role: row.role,
  roleLabel: ROLES[row.role]?.label || row.role,
  status: row.status,
  orgId: row.org_id,
  organisation: row.org_name || null,
  lastLoginAt: row.last_login_at,
  createdAt: row.created_at,
});

/**
 * The roles a person in an organisation can have. Super admins run the
 * platform, belong to no organisation, and are managed on their own page.
 */
const MEMBER_ROLES = ['admin', 'editor', 'viewer'];
const assignableRoles = () => MEMBER_ROLES;
const SUPER_ELSEWHERE = 'Super admins are managed on the Super admins page, not in an organisation';

const slugify = (name) => String(name).toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'org';

/* -------------------------------------------------------------- members */

/** Everyone in the organisation you are working in. */
teamRouter.get('/members', async (req, res, next) => {
  try {
    const rows = await all(
      `SELECT u.*, o.name AS org_name FROM users u
         LEFT JOIN organisations o ON o.id = u.org_id
        WHERE u.org_id = ? ORDER BY FIELD(u.role,'super_admin','admin','editor','viewer'), u.name`,
      [req.orgId]
    );
    res.json({
      members: rows.map(publicMember),
      roles: assignableRoles().map((key) => ({ key, ...ROLES[key] })),
      canManage: ROLES[req.user.role]?.can.members === true,
      you: publicUser(req.user, req.organisation),
    });
  } catch (err) { next(err); }
});

/** Add someone to this organisation with a role. */
teamRouter.post('/members', requirePermission('members'), async (req, res, next) => {
  try {
    const email = checkEmail(req.body.email);
    if (email.error) return res.status(400).json({ error: email.error });

    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'A name is required' });

    const role = String(req.body.role || 'viewer');
    if (!assignableRoles().includes(role)) {
      return res.status(403).json({ error: role === 'super_admin' ? SUPER_ELSEWHERE : `You cannot give out the "${role}" role` });
    }

    const passwordError = checkPassword(req.body.password);
    if (passwordError) return res.status(400).json({ error: passwordError });

    const phone = checkPhone(req.body.phone, { required: phoneRequired(role) });
    if (phone.error) return res.status(400).json({ error: phone.error });

    if (await one('SELECT id FROM users WHERE email = ?', [email.value])) {
      return res.status(409).json({ error: `Somebody with the email ${email.value} already has an account` });
    }

    // A super admin may place people into any organisation; an admin only their own.
    let orgId = req.orgId;
    if (req.body.org_id && req.user.role === 'super_admin') {
      const target = await one('SELECT id FROM organisations WHERE id = ?', [Number(req.body.org_id)]);
      if (!target) return res.status(400).json({ error: 'That organisation does not exist' });
      orgId = target.id;
    }
    if (!orgId) return res.status(400).json({ error: 'Pick the organisation this person belongs to' });

    const { insertId } = await run(
      `INSERT INTO users (org_id, active_org_id, email, name, phone, password_hash, role, status, created_by)
       VALUES (?,?,?,?,?,?,?,'active',?)`,
      [orgId, orgId, email.value, name, phone.value, hashPassword(req.body.password), role, req.user.id]
    );

    await logActivity('user', insertId, 'member_added', `${req.user.name} added ${name} (${ROLES[role].label})`);
    res.status(201).json(publicMember(await one('SELECT * FROM users WHERE id = ?', [insertId])));
  } catch (err) { next(err); }
});

/** Change someone's name, role, status or password. */
teamRouter.put('/members/:id', requirePermission('members'), async (req, res, next) => {
  try {
    const member = await one('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!member) return res.status(404).json({ error: 'That person does not have an account here' });
    if (member.org_id !== req.orgId && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'That person is not in your organisation' });
    }
    if (member.role === 'super_admin') return res.status(400).json({ error: SUPER_ELSEWHERE });

    const role = req.body.role !== undefined ? String(req.body.role) : member.role;
    if (role !== member.role) {
      if (!assignableRoles().includes(role)) {
        return res.status(403).json({ error: `You cannot give out the "${role}" role` });
      }
      if (member.id === req.user.id) {
        return res.status(400).json({ error: 'You cannot change your own role' });
      }
    }

    const status = ['active', 'disabled'].includes(req.body.status) ? req.body.status : member.status;
    if (status === 'disabled' && member.id === req.user.id) {
      return res.status(400).json({ error: 'You cannot disable your own account' });
    }

    // An admin needs a mobile number, whether they are one already or are being made one.
    const phone = checkPhone(req.body.phone !== undefined ? req.body.phone : member.phone, { required: phoneRequired(role) });
    if (phone.error) return res.status(400).json({ error: phone.error });

    let passwordHash = member.password_hash;
    if (req.body.password) {
      const passwordError = checkPassword(req.body.password);
      if (passwordError) return res.status(400).json({ error: passwordError });
      passwordHash = hashPassword(req.body.password);
    }

    await run(
      'UPDATE users SET name = ?, phone = ?, role = ?, status = ?, password_hash = ? WHERE id = ?',
      [String(req.body.name || member.name).trim(), phone.value, role, status, passwordHash, member.id]
    );

    // A changed role, a disabled account or a new password all end their sessions.
    if (role !== member.role || status !== member.status || req.body.password) await endAllSessions(member.id);

    await logActivity('user', member.id, 'member_updated',
      `${req.user.name} updated ${member.name}${role !== member.role ? ` → ${ROLES[role].label}` : ''}${status !== member.status ? ` (${status})` : ''}`);
    res.json(publicMember(await one('SELECT * FROM users WHERE id = ?', [member.id])));
  } catch (err) { next(err); }
});

teamRouter.delete('/members/:id', requirePermission('members'), async (req, res, next) => {
  try {
    const member = await one('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!member) return res.status(404).json({ error: 'That person does not have an account here' });
    if (member.org_id !== req.orgId && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'That person is not in your organisation' });
    }
    if (member.id === req.user.id) return res.status(400).json({ error: 'You cannot remove your own account' });
    if (member.role === 'super_admin') return res.status(400).json({ error: SUPER_ELSEWHERE });

    await run('DELETE FROM users WHERE id = ?', [member.id]);
    await logActivity('user', null, 'member_removed', `${req.user.name} removed ${member.name} (${member.email})`);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* -------------------------------------------------------- organisations */

/** A super admin sees every organisation; everyone else sees only their own. */
teamRouter.get('/organisations', async (req, res, next) => {
  try {
    const rows = req.user.role === 'super_admin'
      ? await all('SELECT * FROM organisations ORDER BY name')
      : await all('SELECT * FROM organisations WHERE id = ?', [req.orgId]);

    const counts = await all(`
      SELECT o.id,
             (SELECT COUNT(*) FROM users u WHERE u.org_id = o.id)        AS members,
             (SELECT COUNT(*) FROM servers s WHERE s.org_id = o.id)      AS servers,
             (SELECT COUNT(*) FROM credentials c WHERE c.org_id = o.id)  AS credentials
        FROM organisations o`);
    const byId = new Map(counts.map((c) => [c.id, c]));

    res.json({
      organisations: rows.map((o) => ({
        id: o.id,
        name: o.name,
        slug: o.slug,
        notes: o.notes,
        createdAt: o.created_at,
        current: o.id === req.orgId,
        counts: {
          members: Number(byId.get(o.id)?.members || 0),
          servers: Number(byId.get(o.id)?.servers || 0),
          credentials: Number(byId.get(o.id)?.credentials || 0),
        },
      })),
      canManage: req.user.role === 'super_admin',
    });
  } catch (err) { next(err); }
});

teamRouter.post('/organisations', requirePermission('orgs'), async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'A name is required' });
    if (await one('SELECT id FROM organisations WHERE name = ?', [name])) {
      return res.status(409).json({ error: `An organisation called "${name}" already exists` });
    }
    const { insertId } = await run('INSERT INTO organisations (name, slug, notes) VALUES (?,?,?)',
      [name, slugify(name), String(req.body.notes || '').trim() || null]);
    await logActivity('organisation', insertId, 'created', `${req.user.name} created the organisation "${name}"`);
    res.status(201).json(await one('SELECT * FROM organisations WHERE id = ?', [insertId]));
  } catch (err) { next(err); }
});

teamRouter.put('/organisations/:id', requirePermission('orgs'), async (req, res, next) => {
  try {
    const org = await one('SELECT * FROM organisations WHERE id = ?', [req.params.id]);
    if (!org) return res.status(404).json({ error: 'That organisation does not exist' });
    const name = String(req.body.name || org.name).trim();
    await run('UPDATE organisations SET name = ?, slug = ?, notes = ? WHERE id = ?',
      [name, slugify(name), String(req.body.notes ?? org.notes ?? '').trim() || null, org.id]);
    await logActivity('organisation', org.id, 'updated', `${req.user.name} renamed "${org.name}" to "${name}"`);
    res.json(await one('SELECT * FROM organisations WHERE id = ?', [org.id]));
  } catch (err) { next(err); }
});

/**
 * Deleting an organisation takes its servers, credentials and people with it,
 * so it is refused while anything is still in there.
 */
teamRouter.delete('/organisations/:id', requirePermission('orgs'), async (req, res, next) => {
  try {
    const org = await one('SELECT * FROM organisations WHERE id = ?', [req.params.id]);
    if (!org) return res.status(404).json({ error: 'That organisation does not exist' });
    if (org.id === req.orgId) return res.status(400).json({ error: 'Switch to another organisation before deleting this one' });

    const servers = Number(await scalar('SELECT COUNT(*) FROM servers WHERE org_id = ?', [org.id]));
    const creds = Number(await scalar('SELECT COUNT(*) FROM credentials WHERE org_id = ?', [org.id]));
    const members = Number(await scalar('SELECT COUNT(*) FROM users WHERE org_id = ?', [org.id]));
    if (servers || creds || members) {
      return res.status(400).json({
        error: `"${org.name}" still holds ${[servers && `${servers} server(s)`, creds && `${creds} credential(s)`, members && `${members} member(s)`]
          .filter(Boolean).join(', ')}. Move or remove them first.`,
      });
    }

    await run('DELETE FROM organisations WHERE id = ?', [org.id]);
    await logActivity('organisation', null, 'deleted', `${req.user.name} deleted the organisation "${org.name}"`);
    res.json({ ok: true });
  } catch (err) { next(err); }
});
