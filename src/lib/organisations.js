/**
 * Creating a client organisation — from the Organisations page, or by turning
 * a lead into a client. Optionally with its first admin and a plan.
 */

import { one, run, logActivity } from '../db/index.js';
import { hashPassword, checkPassword, checkEmail, checkPhone } from './auth.js';
import { setSubscription } from './plans.js';

export const slugify = (name) => String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x';

/** A refusal the caller turns into an HTTP answer. */
export class OrgError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/**
 * `b`: { name, notes, admin_email, admin_password, admin_name, admin_phone, plan_id, cycle, sub_status }.
 * Everything is checked before anything is written. Returns the new organisation's id.
 */
export async function createOrganisation(b, byUserId) {
  const name = String(b.name || '').trim();
  if (!name) throw new OrgError(400, 'An organisation needs a name');
  if (await one('SELECT id FROM organisations WHERE name = ?', [name])) throw new OrgError(409, `An organisation called "${name}" already exists`);

  let admin = null;
  if (b.admin_email) {
    const email = checkEmail(b.admin_email);
    if (email.error) throw new OrgError(400, email.error);
    if (await one('SELECT id FROM users WHERE email = ?', [email.value])) throw new OrgError(409, `${email.value} already has an account`);
    const pwError = checkPassword(b.admin_password);
    if (pwError) throw new OrgError(400, pwError);
    const phone = checkPhone(b.admin_phone, { required: true });
    if (phone.error) throw new OrgError(400, `First admin: ${phone.error}`);
    admin = { email: email.value, name: String(b.admin_name || '').trim() || email.value.split('@')[0], phone: phone.value };
  }
  const plan = b.plan_id ? await one("SELECT * FROM plans WHERE id = ? AND status = 'active'", [Number(b.plan_id)]) : null;
  if (b.plan_id && !plan) throw new OrgError(400, 'That plan does not exist');

  const { insertId: orgId } = await run('INSERT INTO organisations (name, slug, notes) VALUES (?,?,?)',
    [name, slugify(name), String(b.notes || '').trim() || null]);
  if (admin) {
    await run(`INSERT INTO users (org_id, active_org_id, email, name, phone, password_hash, role, status, created_by) VALUES (?,?,?,?,?,?, 'admin', 'active', ?)`,
      [orgId, orgId, admin.email, admin.name, admin.phone, hashPassword(b.admin_password), byUserId || null]);
  }
  if (plan) await setSubscription(orgId, plan, { cycle: b.cycle, status: b.sub_status || 'active' });
  await logActivity('organisation', orgId, 'created',
    `Created the organisation "${name}"${admin ? ` with admin ${admin.email}` : ''}${plan ? ` on ${plan.name}` : ''}`);
  return orgId;
}
