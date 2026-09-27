import path from 'node:path';
import express from 'express';
import { config, ROOT } from './config.js';
import { initDb, scalar, all } from './db/index.js';
import { importSqliteIfPresent } from './db/importSqlite.js';
import { serversRouter } from './routes/servers.js';
import { credentialsRouter } from './routes/credentials.js';
import { dbEnginesRouter } from './routes/dbEngines.js';
import { gitOauthRouter } from './routes/gitOauth.js';
import { runnersRouter } from './routes/runners.js';
import { installsRouter } from './routes/installs.js';
import { appsRouter } from './routes/apps.js';
import { authRouter } from './routes/auth.js';
import { teamRouter } from './routes/team.js';
import { platformRouter, publicPlan } from './routes/platform.js';
import { billingRouter } from './routes/billing.js';
import { requirePlan, enforceLimits, DB_PROVIDERS } from './lib/plans.js';
import { submitLead } from './routes/leads.js';
import { renderLanding, robotsTxt, sitemapXml } from './lib/landing.js';
import { renderDocsHome, renderDoc } from './lib/docsPage.js';
import { docsFor } from './lib/docs.js';
import { ensureSuperAdmin } from './lib/superAdmin.js';
import { attachUser, requireAuth, requireOrg, guardMutations } from './lib/authGuard.js';
import { startHealthMonitor } from './lib/healthMonitor.js';

const app = express();

// File uploads to a server arrive base64-encoded (a 50 MB file is ~67 MB of JSON);
// everything else keeps the small limit.
const smallJson = express.json({ limit: '2mb' });
const uploadJson = express.json({ limit: '70mb' });
app.use((req, res, next) => (/^\/api\/servers\/\d+\/files\/upload$/.test(req.path) ? uploadJson : smallJson)(req, res, next));
// The public page is rendered on the server so search engines see prices, answers and structured data.
app.get(['/', '/index.html'], async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(await renderLanding(req));
  } catch (err) { next(err); }
});
// The documentation, public and server-rendered like the home page.
app.get(['/docs', '/docs/'], (req, res) => res.set('Cache-Control', 'no-cache').type('html').send(renderDocsHome(req)));
app.get('/docs/:slug', (req, res) => {
  const html = renderDoc(req, req.params.slug);
  if (!html) return res.redirect(302, '/docs');
  res.set('Cache-Control', 'no-cache').type('html').send(html);
});
app.get('/robots.txt', (req, res) => res.type('text/plain').send(robotsTxt(req)));
app.get('/sitemap.xml', (req, res) => res.type('application/xml').send(sitemapXml(req)));

// no-cache: the browser keeps its copy but asks every time whether it changed
// (a cheap 304 when not). Without it, an updated app.js can go unseen for hours.
app.use(express.static(path.join(ROOT, 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

// Everything under /api knows who is asking; most of it then insists on it.
app.use('/api', attachUser);
app.use('/api/auth', authRouter);

/** The plans shown on the pricing section of the landing page — public, no sign-in. */
app.get('/api/public/plans', async (req, res, next) => {
  try {
    const rows = await all("SELECT * FROM plans WHERE status = 'active' AND is_public = 1 ORDER BY sort_order, price_monthly");
    res.json({ plans: rows.map(publicPlan) });
  } catch (err) { next(err); }
});

/** The landing page's "Get started" form — public, rate-limited. */
app.post('/api/public/leads', submitLead);

/** The guides for the Docs page inside the app; super-admin guides come from /api/platform/docs. */
app.get('/api/public/docs', (req, res) => res.json({ docs: docsFor() }));

app.get('/api/health', async (req, res, next) => {
  try {
    if (!req.user) return res.json({ ok: true, signedIn: false });
    res.json({
      ok: true,
      signedIn: true,
      servers: Number(await scalar('SELECT COUNT(*) FROM servers WHERE org_id = ?', [req.orgId])),
      credentials: Number(await scalar('SELECT COUNT(*) FROM credentials WHERE org_id = ?', [req.orgId])),
      runners: Number(await scalar('SELECT COUNT(*) FROM runners WHERE org_id = ?', [req.orgId])),
      organisation: req.organisation?.name || null,
      database: `${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}`,
      uptimeSeconds: Math.round(process.uptime()),
    });
  } catch (err) { next(err); }
});

// From here on a session is required, and a role decides what may be changed.
app.use('/api', requireAuth, guardMutations);

app.get('/api/activity', async (req, res, next) => {
  try {
    // On the platform a super admin sees what happened everywhere.
    if (!req.orgId && req.user.role === 'super_admin') {
      return res.json(await all(
        `SELECT a.*, u.name AS user_name, o.name AS org_name FROM activity_log a
           LEFT JOIN users u ON u.id = a.user_id LEFT JOIN organisations o ON o.id = a.org_id
          ORDER BY a.id DESC LIMIT 100`
      ));
    }
    res.json(await all(
      `SELECT a.*, u.name AS user_name FROM activity_log a
         LEFT JOIN users u ON u.id = a.user_id
        WHERE a.org_id = ? OR a.org_id IS NULL
        ORDER BY a.id DESC LIMIT 50`,
      [req.orgId]
    ));
  } catch (err) { next(err); }
});

// One more of any of these counts against the plan's limits.
app.use('/api', enforceLimits([
  ['POST', /^\/servers$/, 'servers'],
  ['POST', /^\/apps$/, 'apps'],
  ['POST', /^\/apps$/, 'domains', (req) => ['true', 'on', true].includes(req.body?.domain_enabled)],
  ['POST', /^\/apps\/\d+\/domains$/, 'domains'],
  ['POST', /^\/credentials$/, 'databases', (req) => DB_PROVIDERS.includes(String(req.body?.provider || '').trim())],
  ['POST', /^\/team\/members$/, 'users'],
]));
app.use('/api/team', teamRouter);
app.use('/api/platform', platformRouter);
app.use('/api/billing', billingRouter);

// Everything below belongs to a client organisation: it has to be open, and on a plan.
const inOrg = [requireOrg, requirePlan];
app.use('/api/servers', inOrg, serversRouter);
app.use('/api/credentials', inOrg, dbEnginesRouter);
app.use('/api/credentials', inOrg, credentialsRouter);
app.use('/api/runners', inOrg, runnersRouter);
app.use('/api/installs', inOrg, installsRouter);
app.use('/api/apps', inOrg, appsRouter);
app.use('/api/git/oauth', inOrg, gitOauthRouter);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

async function start() {
  try {
    await initDb();
  } catch (err) {
    console.error(`\n  Cannot start: ${err.message}\n`);
    console.error('  Set DB_HOST, DB_PORT, DB_USER, DB_PASSWORD and DB_NAME in your .env file.');
    console.error('  A throwaway MySQL for testing:');
    console.error('    docker run -d --name aj-pilot-db -e MYSQL_ROOT_PASSWORD=secret -p 3306:3306 mysql:8\n');
    process.exit(1);
  }

  await importSqliteIfPresent();
  await ensureSuperAdmin().catch((err) => console.error('[super admin] could not apply SUPER_ADMIN_* from .env:', err.message));

  app.listen(config.port, config.host, () => {
    console.log(`\n  AJ Pilot — autopilot for your servers`);
    console.log(`  → http://localhost:${config.port}`);
    console.log(`  DB: ${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}`);
    startHealthMonitor();
    console.log('');
  });
}

start();
