/**
 * Leads: people who asked about the platform from the public site.
 *
 * `submitLead` is the public form's endpoint — no sign-in, so it is checked
 * hard, rate-limited per address, and quietly ignores bots that fill the
 * hidden field. Everything in `leadsRouter` is for super admins (it is
 * mounted under /api/platform): the pipeline, notes, turning a lead into a
 * client organisation, and the numbers.
 */

import { Router } from 'express';
import { all, one, run, logActivity } from '../db/index.js';
import { checkEmail } from '../lib/auth.js';
import { createOrganisation, OrgError } from '../lib/organisations.js';
import { cleanDevice, describeDevice, fingerprintOf, cleanVisit } from '../lib/device.js';
import { clientIp, fromCloudflare, lookupIp, isPrivateIp } from '../lib/geoip.js';

export const leadsRouter = Router();

export const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'];
const OPEN = ['new', 'contacted', 'qualified', 'proposal'];
const SERVER_SIZES = ['1', '2-5', '6-20', '20+'];
const FORMS = ['contact', 'pricing', 'demo', 'hero'];
const NOTE_KINDS = ['note', 'call', 'email', 'meeting'];

const money = (v) => Math.round(Number(v || 0) * 100) / 100;
const clip = (v, n) => (v === undefined || v === null ? null : String(v).trim().slice(0, n) || null);
const utcMs = (v) => (v ? Date.parse(`${String(v).replace(' ', 'T')}Z`) : NaN);

/** Where a lead came from, in one word: the campaign source, the referring site, or "direct". */
function sourceOf(utmSource, referrer, siteHost) {
  if (utmSource) return utmSource.toLowerCase().slice(0, 60);
  try {
    const host = new URL(referrer).hostname.replace(/^www\./, '');
    if (host && host !== siteHost) {
      if (/google\./.test(host)) return 'google';
      if (/bing\.com$/.test(host)) return 'bing';
      if (/(facebook|fb)\.com$/.test(host)) return 'facebook';
      if (/linkedin\.com$|lnkd\.in$/.test(host)) return 'linkedin';
      if (/(twitter|x)\.com$|t\.co$/.test(host)) return 'twitter';
      if (/instagram\.com$/.test(host)) return 'instagram';
      if (/youtube\.com$/.test(host)) return 'youtube';
      return host.slice(0, 60);
    }
  } catch { /* no referrer, or not a URL */ }
  return 'direct';
}

/* --------------------------------------------------------- the public form */

// A handful of submissions per address in a quarter of an hour is plenty for a person.
const recent = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const PER_WINDOW = 5;

export async function submitLead(req, res, next) {
  try {
    const b = req.body || {};
    const ip = clientIp(req);
    // The hidden field is only ever filled in by bots: thank them and keep nothing — but say so in the log.
    if (b.hp_check) {
      console.warn(`[lead] dropped a submission from ${ip}: the hidden anti-bot field was filled in (${String(b.email || '').slice(0, 80)})`);
      return res.status(201).json({ ok: true });
    }

    const now = Date.now();
    const hits = (recent.get(ip) || []).filter((t) => now - t < WINDOW_MS);
    if (hits.length >= PER_WINDOW) return res.status(429).json({ error: 'Thanks — we already have your details. Please try again in a few minutes.' });
    hits.push(now);
    recent.set(ip, hits);
    if (recent.size > 5000) for (const [k, v] of recent) if (!v.some((t) => now - t < WINDOW_MS)) recent.delete(k);

    const name = clip(b.name, 190);
    if (!name) return res.status(400).json({ error: 'Please tell us your name' });
    const email = checkEmail(b.email);
    if (email.error) return res.status(400).json({ error: 'Please enter a valid email address' });
    const phone = clip(b.phone, 40);
    if (phone && !/^[+()\d\s.-]{6,40}$/.test(phone)) return res.status(400).json({ error: 'That phone number does not look right' });
    const servers = SERVER_SIZES.includes(b.servers) ? b.servers : null;
    const plan = b.plan_id ? await one("SELECT * FROM plans WHERE id = ? AND status = 'active' AND is_public = 1", [Number(b.plan_id)]) : null;
    const cycle = b.cycle === 'yearly' ? 'yearly' : 'monthly';
    const message = clip(b.message, 5000);
    const form = FORMS.includes(b.form) ? b.form : 'contact';
    const referrer = clip(b.referrer, 500);
    const siteHost = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^www\./, '');
    const utm = {
      source: clip(b.utm_source, 120), medium: clip(b.utm_medium, 120), campaign: clip(b.utm_campaign, 120),
      term: clip(b.utm_term, 120), content: clip(b.utm_content, 120),
    };
    const value = plan ? money(cycle === 'yearly' && Number(plan.price_yearly) > 0 ? plan.price_yearly / 12 : plan.price_monthly) : null;
    const device = cleanDevice(b.device);
    const deviceJson = device ? JSON.stringify(device).slice(0, 8000) : null;
    const userAgent = clip(req.headers['user-agent'], 255);
    const visit = cleanVisit(b.visit);
    const visitorId = visit?.id || null;
    const fingerprint = fingerprintOf(device, userAgent);
    const visitJson = visit ? JSON.stringify(visit) : null;
    // Behind Cloudflare the location is in the headers; otherwise it is looked up after we have answered.
    const cfGeo = fromCloudflare(req);

    // The same person asking again while we are still talking to them adds to that lead.
    const open = await one(
      `SELECT * FROM leads WHERE email = ? AND status IN ('new','contacted','qualified','proposal')
        AND created_at > DATE_SUB(NOW(), INTERVAL 30 DAY) ORDER BY id DESC LIMIT 1`, [email.value]);
    if (open) {
      await run('INSERT INTO lead_notes (lead_id, kind, body) VALUES (?,?,?)', [open.id, 'note',
        `Asked again from the ${form} form${plan ? ` about ${plan.name} (${cycle})` : ''}.${message ? `\n\n${message}` : ''}`]);
      await run(`UPDATE leads SET phone = COALESCE(?, phone), company = COALESCE(?, company), plan_id = COALESCE(?, plan_id),
          device = COALESCE(?, device), visitor_id = COALESCE(visitor_id, ?), fingerprint = COALESCE(?, fingerprint), visit = COALESCE(?, visit),
          ip = ?, updated_at = NOW() WHERE id = ?`,
        [phone, clip(b.company, 190), plan?.id || null, deviceJson, visitorId, fingerprint, visitJson, ip, open.id]);
      res.status(201).json({ ok: true });
      if (ip !== open.ip || !open.geo) locateLead(open.id, ip, cfGeo);
      return;
    }

    const { insertId } = await run(
      `INSERT INTO leads (name, email, phone, company, servers, plan_id, cycle, message, form, source,
         utm_source, utm_medium, utm_campaign, utm_term, utm_content, referrer, landing_path, ip, user_agent, value, device,
         visitor_id, fingerprint, visit)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [name, email.value, phone, clip(b.company, 190), servers, plan?.id || null, plan ? cycle : null, message, form,
        sourceOf(utm.source, referrer, siteHost), utm.source, utm.medium, utm.campaign, utm.term, utm.content,
        referrer, clip(b.landing_path, 500), ip, userAgent, value, deviceJson, visitorId, fingerprint, visitJson]
    );
    await logActivity('lead', insertId, 'received', `New lead: ${name} (${email.value})${plan ? ` — interested in ${plan.name}` : ''}`);
    res.status(201).json({ ok: true });
    locateLead(insertId, ip, cfGeo);
  } catch (err) { next(err); }
}

/**
 * Store where the lead's connection is. Runs after the visitor has had their
 * answer, so a slow lookup never holds the form up; failures just leave it blank.
 */
async function locateLead(id, ip, cfGeo) {
  try {
    const geo = cfGeo || await lookupIp(ip);
    if (!geo) return null;
    if (cfGeo && isPrivateIp(ip)) geo.local = true;
    await run('UPDATE leads SET geo = ?, country = ? WHERE id = ?', [JSON.stringify(geo), geo.countryCode || null, id]);
    return geo;
  } catch (err) {
    console.warn(`[lead] could not locate lead #${id}: ${err.message}`);
    return null;
  }
}

/* ------------------------------------------------------- super admins */

const parseJson = (v) => { if (!v) return null; if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } } return v; };

function leadView(l) {
  const device = parseJson(l.device);
  return {
    id: l.id, name: l.name, email: l.email, phone: l.phone, company: l.company, servers: l.servers,
    planId: l.plan_id, plan: l.plan_name || null, cycle: l.cycle, message: l.message, form: l.form, source: l.source || 'direct',
    utm: { source: l.utm_source, medium: l.utm_medium, campaign: l.utm_campaign, term: l.utm_term, content: l.utm_content },
    referrer: l.referrer, landingPath: l.landing_path, ip: l.ip, userAgent: l.user_agent,
    device, system: describeDevice(device, l.user_agent),
    visitorId: l.visitor_id || null, fingerprint: l.fingerprint || null, visit: parseJson(l.visit), geo: parseJson(l.geo), country: l.country || null,
    status: l.status, value: l.value === null ? null : money(l.value), assignedTo: l.assigned_to, assignee: l.assignee_name || null,
    lostReason: l.lost_reason, orgId: l.org_id, organisation: l.org_name || null,
    contactedAt: l.contacted_at, closedAt: l.closed_at, createdAt: l.created_at, updatedAt: l.updated_at,
    notes: l.notes === undefined ? undefined : Number(l.notes),
  };
}

const LEAD_SELECT = `SELECT l.*, p.name AS plan_name, u.name AS assignee_name, o.name AS org_name,
    (SELECT COUNT(*) FROM lead_notes n WHERE n.lead_id = l.id) AS notes
  FROM leads l LEFT JOIN plans p ON p.id = l.plan_id LEFT JOIN users u ON u.id = l.assigned_to LEFT JOIN organisations o ON o.id = l.org_id`;

/**
 * Leads that are the same person: the same email, the same browser (its id is
 * kept in the visitor's browser), or the same computer (device fingerprint).
 * Returns, per lead id, the id of the first lead of its person and how many
 * leads that person has. An IP address alone is not enough — offices share one.
 */
function people(rows) {
  const parent = new Map(rows.map((r) => [r.id, r.id]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const join = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb)); };
  for (const key of ['email', 'visitor_id', 'fingerprint']) {
    const first = new Map();
    for (const r of rows) {
      const k = r[key] ? String(r[key]).toLowerCase() : null;
      if (!k) continue;
      if (first.has(k)) join(first.get(k), r.id); else first.set(k, r.id);
    }
  }
  const size = new Map();
  for (const r of rows) { const p = find(r.id); size.set(p, (size.get(p) || 0) + 1); }
  return new Map(rows.map((r) => [r.id, { person: find(r.id), leads: size.get(find(r.id)) }]));
}

const superAdmins = () => all("SELECT id, name FROM users WHERE role = 'super_admin' AND status = 'active' ORDER BY name");

leadsRouter.get('/', async (req, res, next) => {
  try {
    const rows = await all(`${LEAD_SELECT} ORDER BY l.created_at DESC, l.id DESC LIMIT 5000`);
    const who = people(rows);
    res.json({
      leads: rows.map((r) => ({ ...leadView(r), person: who.get(r.id).person, personLeads: who.get(r.id).leads })),
      uniquePeople: new Set([...who.values()].map((w) => w.person)).size,
      statuses: LEAD_STATUSES,
      admins: await superAdmins(),
      plans: await all("SELECT id, name FROM plans WHERE status = 'active' ORDER BY sort_order"),
    });
  } catch (err) { next(err); }
});

/** A lead typed in by hand — a phone call, a referral. */
leadsRouter.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    const name = clip(b.name, 190);
    if (!name) return res.status(400).json({ error: 'A name is required' });
    const email = checkEmail(b.email);
    if (email.error) return res.status(400).json({ error: email.error });
    const plan = b.plan_id ? await one('SELECT * FROM plans WHERE id = ?', [Number(b.plan_id)]) : null;
    const cycle = b.cycle === 'yearly' ? 'yearly' : 'monthly';
    const value = b.value !== undefined && b.value !== '' ? money(b.value)
      : plan ? money(cycle === 'yearly' && Number(plan.price_yearly) > 0 ? plan.price_yearly / 12 : plan.price_monthly) : null;
    const { insertId } = await run(
      `INSERT INTO leads (name, email, phone, company, servers, plan_id, cycle, message, form, source, value, assigned_to)
       VALUES (?,?,?,?,?,?,?,?, 'manual', ?, ?, ?)`,
      [name, email.value, clip(b.phone, 40), clip(b.company, 190), SERVER_SIZES.includes(b.servers) ? b.servers : null,
        plan?.id || null, plan ? cycle : null, clip(b.message, 5000), clip(b.source, 60)?.toLowerCase() || 'manual', value, req.user.id]
    );
    await logActivity('lead', insertId, 'created', `Added the lead ${name} (${email.value}) by hand`);
    res.status(201).json({ ok: true, id: insertId });
  } catch (err) { next(err); }
});

leadsRouter.get('/analytics', async (req, res, next) => {
  try {
    res.json(await analytics());
  } catch (err) { next(err); }
});

/** How many leads are waiting — for the badge in the side menu. */
leadsRouter.get('/summary', async (req, res, next) => {
  try {
    res.json(await leadSummary());
  } catch (err) { next(err); }
});

leadsRouter.get('/:id', async (req, res, next) => {
  try {
    const l = await one(`${LEAD_SELECT} WHERE l.id = ?`, [req.params.id]);
    if (!l) return res.status(404).json({ error: 'Lead not found' });
    const notes = await all(`SELECT n.*, u.name AS user_name FROM lead_notes n LEFT JOIN users u ON u.id = n.user_id
      WHERE n.lead_id = ? ORDER BY n.id DESC`, [l.id]);
    // Earlier leads from the same address, for context.
    // Other leads that may be the same person, and why.
    const others = await all(`SELECT id, name, email, status, created_at, ip, visitor_id, fingerprint FROM leads
      WHERE id <> ? AND (email = ? OR (visitor_id IS NOT NULL AND visitor_id = ?) OR (fingerprint IS NOT NULL AND fingerprint = ?) OR (ip IS NOT NULL AND ip <> '' AND ip = ?))
      ORDER BY id DESC LIMIT 25`, [l.id, l.email, l.visitor_id, l.fingerprint, l.ip]);
    res.json({
      lead: leadView(l),
      notes: notes.map((n) => ({ id: n.id, kind: n.kind, body: n.body, by: n.user_name, createdAt: n.created_at })),
      others: others.map((o) => ({
        id: o.id, name: o.name, email: o.email, status: o.status, createdAt: o.created_at,
        why: [
          o.email === l.email && 'same email',
          l.visitor_id && o.visitor_id === l.visitor_id && 'same browser',
          l.fingerprint && o.fingerprint === l.fingerprint && 'same computer',
          l.ip && o.ip === l.ip && 'same IP address',
        ].filter(Boolean),
      })),
      statuses: LEAD_STATUSES,
      admins: await superAdmins(),
      plans: await all("SELECT id, name, price_monthly, price_yearly, currency FROM plans WHERE status = 'active' ORDER BY sort_order"),
    });
  } catch (err) { next(err); }
});

/** Move a lead along, hand it to someone, or correct its details. Each change is written to its timeline. */
leadsRouter.put('/:id', async (req, res, next) => {
  try {
    const l = await one('SELECT * FROM leads WHERE id = ?', [req.params.id]);
    if (!l) return res.status(404).json({ error: 'Lead not found' });
    const b = req.body || {};
    const changes = [];

    const status = b.status !== undefined ? String(b.status) : l.status;
    if (!LEAD_STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status' });
    const lostReason = status === 'lost' ? (clip(b.lost_reason, 190) ?? l.lost_reason) : null;
    if (status !== l.status) changes.push(`Status: ${l.status} → ${status}${status === 'lost' && lostReason ? ` (${lostReason})` : ''}`);

    let assigned = l.assigned_to;
    if (b.assigned_to !== undefined) {
      assigned = b.assigned_to ? Number(b.assigned_to) : null;
      if (assigned && !(await one("SELECT id FROM users WHERE id = ? AND role = 'super_admin'", [assigned]))) {
        return res.status(400).json({ error: 'Leads are handled by super admins' });
      }
      if (assigned !== l.assigned_to) {
        const who = assigned ? (await one('SELECT name FROM users WHERE id = ?', [assigned])).name : 'nobody';
        changes.push(`Assigned to ${who}`);
      }
    }

    let email = l.email;
    if (b.email !== undefined && b.email !== l.email) {
      const e = checkEmail(b.email);
      if (e.error) return res.status(400).json({ error: e.error });
      email = e.value;
    }
    const plan = b.plan_id !== undefined ? (b.plan_id ? await one('SELECT id FROM plans WHERE id = ?', [Number(b.plan_id)]) : null) : undefined;
    const value = b.value !== undefined ? (b.value === '' || b.value === null ? null : money(b.value)) : l.value;
    if (b.value !== undefined && value !== null && (!Number.isFinite(value) || value < 0)) return res.status(400).json({ error: 'The value must be 0 or more' });

    const fields = {
      name: b.name !== undefined ? clip(b.name, 190) || l.name : l.name,
      email,
      phone: b.phone !== undefined ? clip(b.phone, 40) : l.phone,
      company: b.company !== undefined ? clip(b.company, 190) : l.company,
      servers: b.servers !== undefined ? (SERVER_SIZES.includes(b.servers) ? b.servers : null) : l.servers,
      plan_id: plan === undefined ? l.plan_id : plan?.id || null,
      cycle: b.cycle !== undefined ? (b.cycle === 'yearly' ? 'yearly' : 'monthly') : l.cycle,
    };
    if (b.name !== undefined || b.email !== undefined || b.phone !== undefined || b.company !== undefined) {
      if (fields.name !== l.name || fields.email !== l.email || fields.phone !== l.phone || fields.company !== l.company) changes.push('Details updated');
    }

    const leavingNew = l.status === 'new' && status !== 'new';
    const closing = ['won', 'lost'].includes(status) && !['won', 'lost'].includes(l.status);
    const reopening = !['won', 'lost'].includes(status) && ['won', 'lost'].includes(l.status);
    await run(
      `UPDATE leads SET status = ?, lost_reason = ?, assigned_to = ?, value = ?, name = ?, email = ?, phone = ?, company = ?, servers = ?, plan_id = ?, cycle = ?,
         contacted_at = ${leavingNew ? 'COALESCE(contacted_at, NOW())' : 'contacted_at'},
         closed_at = ${closing ? 'NOW()' : reopening ? 'NULL' : 'closed_at'}
       WHERE id = ?`,
      [status, lostReason, assigned, value, fields.name, fields.email, fields.phone, fields.company, fields.servers, fields.plan_id, fields.cycle, l.id]
    );
    if (changes.length) {
      await run('INSERT INTO lead_notes (lead_id, user_id, kind, body) VALUES (?,?,?,?)', [l.id, req.user.id, 'status', changes.join('\n')]);
      await logActivity('lead', l.id, 'updated', `${l.name}: ${changes.join('; ')}`);
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/** Look the lead's IP address up again (or for the first time, for leads from before locations were kept). */
leadsRouter.post('/:id/locate', async (req, res, next) => {
  try {
    const l = await one('SELECT id, ip FROM leads WHERE id = ?', [req.params.id]);
    if (!l) return res.status(404).json({ error: 'Lead not found' });
    if (!l.ip) return res.status(400).json({ error: 'This lead has no IP address to look up' });
    const geo = await locateLead(l.id, l.ip, null);
    if (!geo) return res.status(502).json({ error: 'The location service did not answer (or GEOIP=off in .env). Try again later.' });
    res.json({ ok: true, geo });
  } catch (err) { next(err); }
});

leadsRouter.post('/:id/notes', async (req, res, next) => {
  try {
    const l = await one('SELECT * FROM leads WHERE id = ?', [req.params.id]);
    if (!l) return res.status(404).json({ error: 'Lead not found' });
    const body = clip(req.body.body, 5000);
    if (!body) return res.status(400).json({ error: 'Write something first' });
    const kind = NOTE_KINDS.includes(req.body.kind) ? req.body.kind : 'note';
    await run('INSERT INTO lead_notes (lead_id, user_id, kind, body) VALUES (?,?,?,?)', [l.id, req.user.id, kind, body]);
    // Calling, emailing or meeting a new lead is contacting it.
    if (kind !== 'note' && l.status === 'new') {
      await run("UPDATE leads SET status = 'contacted', contacted_at = COALESCE(contacted_at, NOW()) WHERE id = ?", [l.id]);
      await run('INSERT INTO lead_notes (lead_id, user_id, kind, body) VALUES (?,?,?,?)', [l.id, req.user.id, 'status', 'Status: new → contacted']);
    } else {
      await run('UPDATE leads SET updated_at = NOW() WHERE id = ?', [l.id]);
    }
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

leadsRouter.delete('/:id/notes/:noteId', async (req, res, next) => {
  try {
    const r = await run("DELETE FROM lead_notes WHERE id = ? AND lead_id = ? AND kind <> 'status'", [req.params.noteId, req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Note not found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/** Turn a lead into a client: a new organisation, its first admin, optionally a plan — and the lead is won. */
leadsRouter.post('/:id/convert', async (req, res, next) => {
  try {
    const l = await one('SELECT * FROM leads WHERE id = ?', [req.params.id]);
    if (!l) return res.status(404).json({ error: 'Lead not found' });
    if (l.org_id) return res.status(400).json({ error: 'This lead is already a client' });
    const b = req.body || {};
    const orgId = await createOrganisation({
      name: b.name || l.company || l.name,
      notes: b.notes || `From lead #${l.id} (${l.source || 'direct'})`,
      admin_email: b.admin_email ?? l.email,
      admin_name: b.admin_name ?? l.name,
      admin_password: b.admin_password,
      admin_phone: b.admin_phone ?? l.phone,
      plan_id: b.plan_id,
      cycle: b.cycle,
      sub_status: b.sub_status,
    }, req.user.id);
    await run("UPDATE leads SET status = 'won', org_id = ?, closed_at = NOW(), contacted_at = COALESCE(contacted_at, NOW()), lost_reason = NULL WHERE id = ?", [orgId, l.id]);
    await run('INSERT INTO lead_notes (lead_id, user_id, kind, body) VALUES (?,?,?,?)', [l.id, req.user.id, 'status', `Status: ${l.status} → won\nBecame a client organisation`]);
    await logActivity('lead', l.id, 'converted', `${l.name} became a client`);
    res.status(201).json({ ok: true, orgId });
  } catch (err) {
    if (err instanceof OrgError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

leadsRouter.delete('/:id', async (req, res, next) => {
  try {
    const l = await one('SELECT * FROM leads WHERE id = ?', [req.params.id]);
    if (!l) return res.status(404).json({ error: 'Lead not found' });
    await run('DELETE FROM leads WHERE id = ?', [l.id]);
    await logActivity('lead', null, 'deleted', `Deleted the lead ${l.name} (${l.email})`, 'warn');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------ analysis */

function lastMonths(n) {
  const out = [];
  const d = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    out.push(`${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

const countBy = (rows, key, top = 10) => {
  const m = new Map();
  for (const r of rows) { const k = key(r) || '—'; m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, top);
};

/** Everything the Lead analysis page draws, from one pass over the leads. */
async function analytics() {
  const leads = await all(`SELECT l.*, p.name AS plan_name FROM leads l LEFT JOIN plans p ON p.id = l.plan_id`);
  const months = lastMonths(12);
  const thisMonth = months[11];
  const lastMonth = months[10];
  const monthOf = (v) => String(v).slice(0, 7);

  const won = leads.filter((l) => l.status === 'won');
  const lost = leads.filter((l) => l.status === 'lost');
  const open = leads.filter((l) => OPEN.includes(l.status));
  const closed = won.length + lost.length;

  // How long the first reply took, in hours, for leads that got one.
  const replies = leads.filter((l) => l.contacted_at).map((l) => (utcMs(l.contacted_at) - utcMs(l.created_at)) / 3600000).filter((h) => h >= 0);
  const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const daysToWin = won.filter((l) => l.closed_at).map((l) => (utcMs(l.closed_at) - utcMs(l.created_at)) / 86400000).filter((d) => d >= 0);

  // A lead that reached a stage also passed the ones before it.
  const reached = (stage) => {
    const order = ['new', 'contacted', 'qualified', 'proposal', 'won'];
    const at = order.indexOf(stage);
    return leads.filter((l) => {
      if (l.status === 'lost') return stage === 'new' || (stage === 'contacted' && l.contacted_at);
      return order.indexOf(l.status) >= at;
    }).length;
  };

  const bySourceRows = countBy(leads, (l) => l.source || 'direct', 12).map((s) => {
    const of = leads.filter((l) => (l.source || 'direct') === s.name);
    const w = of.filter((l) => l.status === 'won').length;
    const c = of.filter((l) => ['won', 'lost'].includes(l.status)).length;
    return { ...s, won: w, rate: c ? Math.round((w / c) * 100) : null };
  });

  const campaigns = countBy(leads.filter((l) => l.utm_campaign), (l) => l.utm_campaign, 10).map((c) => ({
    ...c, won: leads.filter((l) => l.utm_campaign === c.name && l.status === 'won').length,
  }));

  const systems = leads.map((l) => describeDevice(parseJson(l.device), l.user_agent));
  const who = people(leads);
  const personSizes = new Map();
  for (const w of who.values()) personSizes.set(w.person, w.leads);
  const geos = leads.map((l) => parseJson(l.geo)).filter(Boolean);
  const visits = leads.map((l) => parseJson(l.visit)).filter(Boolean);
  const tally = (key) => countBy(systems, key, 8);

  const weekday = [0, 0, 0, 0, 0, 0, 0];
  for (const l of leads) { const t = utcMs(l.created_at); if (t) weekday[new Date(t).getUTCDay()] += 1; }

  return {
    totals: {
      all: leads.length,
      open: open.length,
      new: leads.filter((l) => l.status === 'new').length,
      won: won.length,
      lost: lost.length,
      thisMonth: leads.filter((l) => monthOf(l.created_at) === thisMonth).length,
      lastMonth: leads.filter((l) => monthOf(l.created_at) === lastMonth).length,
      wonThisMonth: won.filter((l) => l.closed_at && monthOf(l.closed_at) === thisMonth).length,
      conversionRate: closed ? Math.round((won.length / closed) * 100) : null,
      pipelineValue: money(open.reduce((n, l) => n + Number(l.value || 0), 0)),
      wonValue: money(won.reduce((n, l) => n + Number(l.value || 0), 0)),
      medianReplyHours: median(replies),
      unanswered: leads.filter((l) => l.status === 'new' && Date.now() - utcMs(l.created_at) > 86400000).length,
      medianDaysToWin: median(daysToWin),
    },
    byMonth: months.map((m) => ({
      month: m,
      total: leads.filter((l) => monthOf(l.created_at) === m).length,
      won: won.filter((l) => l.closed_at && monthOf(l.closed_at) === m).length,
    })),
    funnel: ['new', 'contacted', 'qualified', 'proposal', 'won'].map((stage) => ({ stage, count: reached(stage) })),
    byStatus: LEAD_STATUSES.map((s) => ({ name: s, count: leads.filter((l) => l.status === s).length })),
    bySource: bySourceRows,
    byPlan: countBy(leads, (l) => l.plan_name || 'Not sure yet', 10),
    bySize: ['1', '2-5', '6-20', '20+'].map((s) => ({ name: s, count: leads.filter((l) => l.servers === s).length }))
      .concat([{ name: 'Not said', count: leads.filter((l) => !l.servers).length }]),
    byForm: countBy(leads, (l) => l.form, 6),
    lostReasons: countBy(lost, (l) => l.lost_reason || 'No reason given', 8),
    campaigns,
    people: {
      unique: personSizes.size,
      repeat: [...personSizes.values()].filter((n) => n > 1).length,
      medianVisits: median(visits.map((v) => v.visits).filter((n) => n > 0)),
      medianSecondsOnPage: median(visits.map((v) => v.secondsOnPage).filter((n) => n > 0)),
      located: geos.length,
    },
    byCountry: countBy(geos, (g) => (g.country ? `${g.flag ? `${g.flag} ` : ''}${g.country}` : g.countryCode), 10),
    byCity: countBy(geos.filter((g) => g.city), (g) => `${g.city}${g.countryCode ? `, ${g.countryCode}` : ''}`, 10),
    byIsp: countBy(geos.filter((g) => g.isp), (g) => g.isp, 8),
    byOs: tally((s) => s.os),
    byBrowser: tally((s) => s.browser),
    byDeviceType: tally((s) => s.type),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => ({ name: d, count: weekday[i] })),
  };
}

/** For the platform dashboard: how many are waiting. */
export async function leadSummary() {
  const r = await one(`SELECT
      SUM(status = 'new') AS fresh,
      SUM(status = 'new' AND form = 'contact') AS fresh_contact,
      SUM(status IN ('new','contacted','qualified','proposal')) AS open_,
      SUM(DATE_FORMAT(created_at, '%Y-%m') = DATE_FORMAT(NOW(), '%Y-%m')) AS this_month
    FROM leads`);
  return { new: Number(r?.fresh || 0), newContact: Number(r?.fresh_contact || 0), open: Number(r?.open_ || 0), thisMonth: Number(r?.this_month || 0) };
}
