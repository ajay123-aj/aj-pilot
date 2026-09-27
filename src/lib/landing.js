/**
 * The public page, rendered on the server so search engines and link
 * previews see everything a person does: the site's own address in the
 * canonical and Open Graph tags, the plans as real HTML, the FAQ, and
 * structured data (JSON-LD) describing the product, its prices and answers.
 * The browser script then takes over exactly as before.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from '../config.js';
import { all } from '../db/index.js';
import { docsFor } from './docs.js';

const INDEX = path.join(ROOT, 'public', 'index.html');
let cached = { mtime: 0, html: '' };

function template() {
  const { mtimeMs } = fs.statSync(INDEX);
  if (mtimeMs !== cached.mtime) cached = { mtime: mtimeMs, html: fs.readFileSync(INDEX, 'utf8') };
  return cached.html;
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

/** https://example.com — from SITE_URL, or from how this request reached us. */
export function siteUrl(req) {
  if (config.siteUrl) return config.siteUrl.replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
  return `${proto}://${host}`;
}

export const FAQ = [
  ['What is AJ Pilot?',
    'AJ Pilot is autopilot for your servers: a self-hosted control panel for Ubuntu servers. It connects over SSH to manage servers, deploy apps from GitHub or GitLab, run Docker and databases, and put every app on your own domain with Nginx and free SSL or a Cloudflare Zero Trust tunnel.'],
  ['Do I need to install an agent on my servers?',
    'No. Everything happens over the SSH connection you already use. There is nothing to install or keep updated on your servers.'],
  ['Which frameworks can I deploy?',
    'Next.js, NestJS, Nuxt, Angular, React, Vue and Vite apps, plain Node.js services and static sites. The framework is detected from your repository, built and run in Docker, and monorepos with several projects are supported.'],
  ['How do domains and SSL work?',
    'Connect your Cloudflare account, choose a domain and type a subdomain. The DNS record, the Nginx site and a free Let\'s Encrypt certificate are created for you. For servers without open ports, apps can be published through a Cloudflare Zero Trust tunnel instead. An app can have several domains.'],
  ['Which databases are supported?',
    'MySQL, PostgreSQL, MongoDB and Redis — install them on your server with one click, then manage databases, users, privileges and settings, see statistics and run queries from the panel.'],
  ['Which servers can I use?',
    'Any Ubuntu server you can reach over SSH — from DigitalOcean, AWS, Hetzner, Linode, Hostinger, any other VPS provider, or your own hardware.'],
  ['Is my data secure?',
    'Every password, SSH key and provider token is encrypted with AES-256-GCM before it is stored, sign-in passwords are hashed with scrypt, and permissions are checked on the server for every change.'],
  ['Can my team use it?',
    'Yes. Add people to your organisation as admin, editor or view-only. Every change is recorded in the activity log, and nothing is shared between organisations.'],
  ['Is there a free plan?',
    'Yes — the free plan covers one server so you can try everything. Paid plans add more servers, apps, team members, databases and domains.'],
];

async function publicPlans() {
  try {
    return await all("SELECT * FROM plans WHERE status = 'active' AND is_public = 1 ORDER BY sort_order, price_monthly");
  } catch {
    return [];
  }
}

const LIMIT_WORDS = {
  servers: ['server', 'servers'], apps: ['app', 'apps'], users: ['team member', 'team members'],
  databases: ['database connection', 'database connections'], domains: ['domain', 'domains'],
};

function limitLine(key, n) {
  const [one, many] = LIMIT_WORDS[key];
  if (n === undefined || n === null) return `Unlimited ${many}`;
  return n === 1 ? `1 ${one}` : `Up to ${n} ${many}`;
}

function price(n, currency) {
  const v = Number(n) || 0;
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency, maximumFractionDigits: v % 1 ? 2 : 0 }).format(v);
  } catch {
    return `${currency} ${v}`;
  }
}

const parse = (v, fallback) => { if (v === null || v === undefined) return fallback; if (typeof v === 'string') { try { return JSON.parse(v); } catch { return fallback; } } return v; };

/** The same cards the browser draws, so the prices are in the page before any script runs. */
function pricingCards(plans) {
  return plans.map((p) => {
    const monthly = Number(p.price_monthly);
    const yearly = Number(p.price_yearly);
    const free = monthly === 0 && yearly === 0;
    const limits = parse(p.limits, {});
    const features = parse(p.features, []);
    return `<article class="price-card ${p.highlighted ? 'featured' : ''}">
      ${p.highlighted ? '<span class="price-ribbon">Most popular</span>' : ''}
      <h3>${esc(p.name)}</h3>
      <p class="price-tagline">${esc(p.tagline || '')}</p>
      <div class="price-amount">${free ? '<b>Free</b>' : `<b>${esc(price(monthly, p.currency))}</b><span>/month</span>`}</div>
      <p class="price-note">${!free && yearly > 0 ? `or ${esc(price(yearly, p.currency))} a year` : '&nbsp;'}</p>
      <a class="btn ${p.highlighted ? 'primary' : ''} big price-cta" href="#contact" data-plan="${p.id}">${free ? 'Start free' : 'Get started'}</a>
      <ul class="price-list">${Object.keys(LIMIT_WORDS).map((k) => `<li>${esc(limitLine(k, limits[k]))}</li>`).join('')}${features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
    </article>`;
  }).join('');
}

function faqHtml() {
  return FAQ.map(([q, a], i) => `<details class="faq" ${i === 0 ? 'open' : ''}><summary><h3>${esc(q)}</h3></summary><p>${esc(a)}</p></details>`).join('');
}

function jsonLd(url, plans) {
  const graph = [
    { '@type': 'Organization', '@id': `${url}/#org`, name: 'AJ Pilot', url: `${url}/`, logo: `${url}/apple-touch-icon.png` },
    { '@type': 'WebSite', '@id': `${url}/#site`, url: `${url}/`, name: 'AJ Pilot', alternateName: 'AJ Pilot — autopilot for your servers', publisher: { '@id': `${url}/#org` }, inLanguage: 'en' },
    {
      '@type': 'SoftwareApplication',
      name: 'AJ Pilot',
      alternateName: 'Autopilot for your servers',
      url: `${url}/`,
      image: `${url}/og-image.png`,
      applicationCategory: 'DeveloperApplication',
      applicationSubCategory: 'Server management and app deployment',
      operatingSystem: 'Web browser; manages Ubuntu Linux servers',
      description: 'Self-hosted control panel to manage Ubuntu servers over SSH, deploy Next.js, NestJS, Node.js, React and static apps from GitHub or GitLab, run Docker, MySQL, PostgreSQL, MongoDB and Redis, and connect domains with Cloudflare, Nginx and free SSL.',
      featureList: [
        'Server inventory and live monitoring over SSH', 'systemd service, cron and file management',
        'Git-based app deployment for Next.js, NestJS, Nuxt, Angular, React, Vue and Node.js', 'Monorepo folder deploys',
        'Nginx sites with free Let\'s Encrypt SSL', 'Cloudflare DNS and Zero Trust tunnels', 'Docker container management',
        'One-click MySQL, PostgreSQL, MongoDB, Redis, EMQX and Elasticsearch', 'Database users, grants and queries',
        'GitHub Actions and GitLab runners', 'Teams, organisations and roles', 'Encrypted credentials and activity log',
      ],
      publisher: { '@id': `${url}/#org` },
      ...(plans.length ? {
        offers: plans.map((p) => ({
          '@type': 'Offer', name: p.name, price: String(Number(p.price_monthly)), priceCurrency: p.currency,
          url: `${url}/#pricing`, availability: 'https://schema.org/InStock', category: Number(p.price_monthly) ? 'subscription' : 'free',
        })),
      } : {}),
    },
    {
      '@type': 'FAQPage',
      mainEntity: FAQ.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
    },
  ];
  return `<script type="application/ld+json">${json({ '@context': 'https://schema.org', '@graph': graph })}</script>`;
}

export async function renderLanding(req) {
  const url = siteUrl(req);
  const plans = await publicPlans();
  return template()
    .replaceAll('%%SITE_URL%%', esc(url))
    .replaceAll('%%PRICING_HIDDEN%%', plans.length ? '' : 'hidden')
    .replace('<!--PRICING_CARDS-->', pricingCards(plans))
    .replace('<!--FAQ-->', faqHtml())
    .replace('<!--JSONLD-->', jsonLd(url, plans));
}

export function robotsTxt(req) {
  const url = siteUrl(req);
  return `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${url}/sitemap.xml\n`;
}

export function sitemapXml(req) {
  const url = siteUrl(req);
  const lastmod = new Date(fs.statSync(INDEX).mtimeMs).toISOString().slice(0, 10);
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${esc(url)}/</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq><priority>1.0</priority></url>
  <url><loc>${esc(url)}/docs</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>
${docsFor().map((d) => `  <url><loc>${esc(url)}/docs/${d.slug}</loc><lastmod>${lastmod}</lastmod><changefreq>monthly</changefreq><priority>0.6</priority></url>`).join('\n')}
</urlset>
`;
}
