/**
 * Accounts, passwords and sessions.
 *
 * Passwords are hashed with scrypt (built into Node, no dependency) and
 * sessions are opaque random tokens kept in a cookie — only their SHA-256 is
 * stored, so a leaked database cannot be used to log in.
 */

import crypto from 'node:crypto';

export const SESSION_COOKIE = 'ad_session';

/* ----------------------------------------------------------- passwords */

const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 64;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, KEY_LENGTH, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [algo, saltB64, keyB64] = String(stored || '').split('$');
    if (algo !== 'scrypt' || !saltB64 || !keyB64) return false;
    const expected = Buffer.from(keyB64, 'base64');
    const actual = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/** What a password must be before it is allowed anywhere near an account. */
export function checkPassword(password) {
  const value = String(password || '');
  if (value.length < 10) return 'The password must be at least 10 characters';
  if (!/[a-zA-Z]/.test(value) || !/[0-9]/.test(value)) return 'The password must contain both letters and numbers';
  return null;
}

/** Roles that must have a mobile number on their account: the people others need to reach. */
export const PHONE_ROLES = ['super_admin', 'admin'];
export const phoneRequired = (role) => PHONE_ROLES.includes(role);

/**
 * A mobile number, with its country code: "+91 98765 43210". Spaces, dashes,
 * dots and brackets are allowed; 8 to 15 digits. `required` makes empty an error.
 */
export function checkPhone(phone, { required = false } = {}) {
  const value = String(phone ?? '').trim().replace(/\s+/g, ' ');
  if (!value) return required ? { error: 'A mobile number is required for admins and super admins' } : { value: null };
  const digits = value.replace(/\D/g, '');
  if (!/^\+?[\d\s().-]+$/.test(value) || digits.length < 8 || digits.length > 15) {
    return { error: `"${value}" does not look like a mobile number — use digits with the country code, e.g. +91 98765 43210` };
  }
  return { value: value.slice(0, 32) };
}

export function checkEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  if (!value) return { error: 'An email address is required' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) || value.length > 190) {
    return { error: `"${email}" does not look like an email address` };
  }
  return { value };
}

/* ------------------------------------------------------------ sessions */

export const newSessionToken = () => crypto.randomBytes(32).toString('base64url');
export const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/** Read one cookie out of a request without pulling in a cookie parser. */
export function readCookie(req, name) {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function sessionCookie(token, { maxAge, secure }) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearedCookie({ secure }) {
  return sessionCookie('', { maxAge: 0, secure });
}

/* --------------------------------------------------------------- roles */

/**
 * Four roles, from the one that can do everything to the one that can only
 * look. `members` is the right to manage an organisation's people; `orgs` is
 * the right to create organisations at all, which only the super admin has.
 */
export const ROLES = {
  super_admin: {
    label: 'Super admin',
    detail: 'Everything, in every organisation, including creating organisations and other admins.',
    can: { view: true, create: true, edit: true, delete: true, members: true, orgs: true },
  },
  admin: {
    label: 'Admin',
    detail: 'Add, edit and delete everything in this organisation, and manage its people.',
    can: { view: true, create: true, edit: true, delete: true, members: true, orgs: false },
  },
  editor: {
    label: 'Editor',
    detail: 'Add and edit, but never delete. Cannot manage people.',
    can: { view: true, create: true, edit: true, delete: false, members: false, orgs: false },
  },
  viewer: {
    label: 'View only',
    detail: 'Can look at everything and run nothing. No changes of any kind.',
    can: { view: true, create: false, edit: false, delete: false, members: false, orgs: false },
  },
};

/** The roles one user is allowed to hand out. Only a super admin makes another. */
export const assignableRoles = (user) =>
  Object.keys(ROLES).filter((r) => r !== 'super_admin' || user?.role === 'super_admin');

export const can = (user, action) => Boolean(user && ROLES[user.role]?.can[action]);

export const publicRoles = () => Object.entries(ROLES).map(([key, r]) => ({
  key, label: r.label, detail: r.detail, can: r.can,
}));
