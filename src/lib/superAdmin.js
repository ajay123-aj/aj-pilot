/**
 * The super admin from .env (SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD).
 *
 * On every boot, when both are set, that account is made to exist, be a super
 * admin, be active, and sign in with exactly that password — so the platform
 * owner can always get in, and changing the password is an edit to .env and a
 * restart. Nothing here ever prints the password.
 */

import { config } from '../config.js';
import { one, run, logActivity } from '../db/index.js';
import { hashPassword, verifyPassword, checkPassword, checkEmail, checkPhone } from './auth.js';

export async function ensureSuperAdmin() {
  const { email: rawEmail, password, name, phone: rawPhone } = config.superAdmin;
  if (!rawEmail && !password) return;
  if (!rawEmail || !password) {
    console.warn('[super admin] Set both SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD in .env — nothing was changed.');
    return;
  }
  const email = checkEmail(rawEmail);
  if (email.error) {
    console.warn(`[super admin] SUPER_ADMIN_EMAIL: ${email.error} — nothing was changed.`);
    return;
  }
  const weak = checkPassword(password);
  if (weak) {
    console.warn(`[super admin] SUPER_ADMIN_PASSWORD is not used: ${weak}.`);
    return;
  }

  // SUPER_ADMIN_PHONE is optional: without it the super admin is asked for a number at sign-in.
  const phoneCheck = checkPhone(rawPhone);
  if (phoneCheck.error) console.warn(`[super admin] SUPER_ADMIN_PHONE: ${phoneCheck.error} — it was not used.`);
  const phone = phoneCheck.error ? null : phoneCheck.value;

  const user = await one('SELECT * FROM users WHERE email = ?', [email.value]);

  if (user) {
    const changes = [];
    if (user.role !== 'super_admin') changes.push('made super admin');
    if (user.org_id) changes.push('taken out of its organisation');
    if (user.status !== 'active') changes.push('re-activated');
    const passwordChanged = !verifyPassword(password, user.password_hash);
    if (passwordChanged) changes.push('password set from .env');
    if (name && name !== user.name) changes.push('name updated');
    if (phone && phone !== user.phone) changes.push('mobile number set');
    if (!changes.length) return;

    await run("UPDATE users SET role = 'super_admin', status = 'active', org_id = NULL, active_org_id = NULL, password_hash = ?, name = ?, phone = ? WHERE id = ?",
      [passwordChanged ? hashPassword(password) : user.password_hash, name || user.name, phone || user.phone, user.id]);
    // A new password signs out every session that used the old one.
    if (passwordChanged) await run('DELETE FROM sessions WHERE user_id = ?', [user.id]);
    await logActivity('user', user.id, 'super_admin_env', `${email.value}: ${changes.join(', ')} (from .env)`, 'warn');
    console.log(`[super admin] ${email.value}: ${changes.join(', ')}.`);
    return;
  }

  // A super admin runs the platform and belongs to no organisation.
  const { insertId } = await run(
    `INSERT INTO users (org_id, active_org_id, email, name, phone, password_hash, role, status) VALUES (NULL, NULL, ?,?,?,?, 'super_admin', 'active')`,
    [email.value, name || email.value.split('@')[0], phone, hashPassword(password)]
  );
  await logActivity('user', insertId, 'super_admin_env', `Created the super admin ${email.value} from .env`, 'warn');
  console.log(`[super admin] Created ${email.value} as super admin.`);
}
