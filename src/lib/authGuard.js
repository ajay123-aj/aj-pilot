/**
 * Who may do what.
 *
 * `attachUser` turns the session cookie into a user on every request and puts
 * the organisation into the async context. `requireAuth` then refuses anyone
 * without a session, and `requirePermission` refuses anyone whose role does
 * not stretch that far. Nothing below these is allowed to assume an org.
 */

import { one, run } from '../db/index.js';
import { runWithContext } from './context.js';
import { SESSION_COOKIE, readCookie, hashToken, can } from './auth.js';

/** Look up the session behind the cookie, if there is one and it is still alive. */
export async function loadSession(req) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;

  const session = await one(
    'SELECT * FROM sessions WHERE token_hash = ? AND expires_at > NOW()',
    [hashToken(token)]
  );
  if (!session) return null;

  const user = await one('SELECT * FROM users WHERE id = ? AND status = "active"', [session.user_id]);
  if (!user) return null;

  return { session, user };
}

/**
 * The organisation a user is working in.
 * Everyone works in their own. A super admin belongs to none — they run the
 * platform — and is inside one only while they have opened it.
 */
export const orgOf = (user) => (user.role === 'super_admin' ? (user.active_org_id || null) : user.org_id);

export const publicUser = (user, org = null) => (user ? {
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role,
  status: user.status,
  orgId: orgOf(user),
  homeOrgId: user.org_id,
  lastLoginAt: user.last_login_at,
  phone: user.phone || null,
  // Admins and super admins must have a mobile number; the browser asks for it until they do.
  needsPhone: ['super_admin', 'admin'].includes(user.role) && !user.phone,
  organisation: org ? { id: org.id, name: org.name, slug: org.slug } : null,
} : null);

/** Attach the signed-in user to every API request, and run it in their context. */
export async function attachUser(req, res, next) {
  try {
    const found = await loadSession(req);
    req.user = found?.user || null;
    req.session = found?.session || null;
    if (!req.user) return next();

    const orgId = orgOf(req.user);
    req.orgId = orgId;
    req.organisation = orgId ? await one('SELECT * FROM organisations WHERE id = ?', [orgId]) : null;

    runWithContext({ user: req.user, orgId }, () => next());
  } catch (err) {
    next(err);
  }
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue', needsAuth: true });
  if (!req.orgId && req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Your account is not in an organisation yet. Ask a super admin to add you to one.' });
  }
  // A suspended organisation is closed to its people; a super admin still gets in to sort it out.
  if (req.organisation?.status === 'suspended' && req.user.role !== 'super_admin') {
    return res.status(403).json({ error: `The organisation "${req.organisation.name}" is suspended. Contact the platform administrator.`, suspended: true });
  }
  next();
}

/** Servers, apps and credentials live inside an organisation; a super admin opens one first. */
export function requireOrg(req, res, next) {
  if (!req.orgId) {
    return res.status(409).json({ error: 'Open an organisation first — this belongs to a client organisation.', needsOrg: true });
  }
  next();
}

/** `create`, `edit`, `delete`, `members` or `orgs`. */
export const requirePermission = (action) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue', needsAuth: true });
  if (!can(req.user, action)) {
    return res.status(403).json({
      error: `Your role (${req.user.role.replace('_', ' ')}) cannot ${VERB[action] || action} here.`,
      forbidden: true,
    });
  }
  next();
};

const VERB = {
  create: 'add anything',
  edit: 'change anything',
  delete: 'delete anything',
  members: 'manage people',
  orgs: 'manage organisations',
};

/**
 * Mutating requests need the matching permission, without every route having
 * to say so: POST/PUT/PATCH create-or-edit, DELETE deletes.
 *
 * Read-only POSTs — the ones that only ask a server or a provider a question —
 * are listed here so a viewer can still look at things.
 */
const READ_ONLY_POSTS = [
  /^\/servers\/\d+\/test$/,
  /^\/servers\/\d+\/facts$/,
  /^\/credentials\/\d+\/(verify|git\/.*)$/,
  // MySQL reads only — creating a database, a user or a grant still needs "create".
  /^\/credentials\/\d+\/mysql\/(overview|databases\/[^/]+(\/tables\/[^/]+)?|query|charsets|variables|users\/list)$/,
  // Reads only — adding a DNS record (…/dns/records) still needs "create".
  /^\/credentials\/\d+\/cloudflare\/(account|zones\/[a-f0-9]+(\/dns)?)$/i,
  /^\/credentials\/\d+\/cloudflare\/accounts\/[a-f0-9]+\/zero-trust$/i,
  /^\/credentials\/\d+\/dockerhub\/repositories(\/[^/]+\/[^/]+)?$/,
  // PostgreSQL / MongoDB / Redis reads. POST …/db/schemas and …/db/users still need "create".
  /^\/credentials\/\d+\/db\/(overview|databases|database|item|users\/list|config|query)$/,
  /^\/credentials\/test-(mysql|git|cloudflare|db)$/,
  /^\/installs\/\d+\/refresh$/,
  /^\/runners\/\d+\/refresh$/,
];

export function guardMutations(req, res, next) {
  const path = req.path.replace(/\/+$/, '') || '/';

  if (req.method === 'DELETE') return requirePermission('delete')(req, res, next);
  if (req.method === 'PUT' || req.method === 'PATCH') return requirePermission('edit')(req, res, next);
  if (req.method === 'POST') {
    if (READ_ONLY_POSTS.some((re) => re.test(path))) return requirePermission('view')(req, res, next);
    return requirePermission('create')(req, res, next);
  }
  next();
}

/** End one session (sign out) or every session a user has (disable / password change). */
export const endSession = (id) => run('DELETE FROM sessions WHERE id = ?', [id]);
export const endAllSessions = (userId) => run('DELETE FROM sessions WHERE user_id = ?', [userId]);
