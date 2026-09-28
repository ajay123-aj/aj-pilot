/**
 * The public documentation pages: /docs (every guide, by category) and
 * /docs/<slug> (one guide). Rendered on the server, with their own titles,
 * descriptions and structured data, so each guide can be found by search.
 */

import { DOC_CATEGORIES, docsFor, findDoc } from './docs.js';
import { siteUrl } from './landing.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
const LOGO = '<svg class="logo-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 19.5 20.5 12 16.6 4.5 20.5Z" fill="currentColor"/></svg>';

// The same first-paint theme as the main page, so a light page never flashes dark.
const THEME = `<script>(function(){var p='dark';try{p=localStorage.getItem('ad-theme')||'dark'}catch(e){}
var d=p==='dark'||(p==='system'&&!(window.matchMedia&&matchMedia('(prefers-color-scheme: light)').matches));
document.documentElement.setAttribute('data-theme',d?'dark':'light');})();</script>`;

/** The categories with their guides, as the left-hand menu. */
function sideNav(current) {
  const docs = docsFor();
  return DOC_CATEGORIES.map((cat) => {
    const items = docs.filter((d) => d.category === cat);
    if (!items.length) return '';
    return `<div class="docs-group"><div class="docs-group-title">${esc(cat)}</div>
      ${items.map((d) => `<a href="/docs/${d.slug}" class="docs-link ${d.slug === current ? 'active' : ''}" data-search="${esc(`${d.title} ${d.summary} ${d.category}`.toLowerCase())}">${esc(d.title)}</a>`).join('')}
    </div>`;
  }).join('');
}

function page({ req, title, description, path, body, current, ld }) {
  const url = siteUrl(req);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<meta name="robots" content="index, follow" />
<link rel="canonical" href="${esc(url + path)}" />
<meta property="og:type" content="article" />
<meta property="og:site_name" content="AJ Pilot" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:url" content="${esc(url + path)}" />
<meta property="og:image" content="${esc(url)}/og-image.png" />
<meta name="twitter:card" content="summary_large_image" />
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
${THEME}
<meta name="theme-color" content="#f6f8fc" media="(prefers-color-scheme: light)" />
<meta name="theme-color" content="#07080c" media="(prefers-color-scheme: dark)" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" />
<link rel="stylesheet" href="/styles.css" />
<link rel="stylesheet" href="/landing.css" />
<script type="application/ld+json">${json(ld)}</script>
</head>
<body class="docs-public signed-out">
<div class="landing">
<header class="landing-head" id="landing-head">
  <div class="landing-head-inner">
    <a class="landing-brand" href="/" aria-label="AJ Pilot home"><span class="logo" aria-hidden="true">${LOGO}</span><span><strong>AJ Pilot</strong><small>autopilot for your servers</small></span></a>
    <nav class="landing-nav" id="landing-nav" aria-label="Main">
      <a href="/#features">Features</a><a href="/#how">How it works</a><a href="/#pricing">Pricing</a><a href="/#faq">FAQ</a><a href="/docs" class="active">Docs</a><a href="/#contact">Contact</a>
    </nav>
    <div class="landing-actions">
      <button type="button" class="icon-btn landing-theme-btn" id="btn-landing-theme" aria-label="Switch theme" title="Switch theme"><span class="lt-sun" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"/></svg></span><span class="lt-moon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.2A8.5 8.5 0 1 1 9.8 3.5a6.8 6.8 0 0 0 10.7 10.7z"/></svg></span></button>
      <a class="btn" href="/#signin">Sign in</a>
      <button type="button" class="landing-burger" aria-controls="landing-nav" aria-expanded="false" aria-label="Menu"><span></span><span></span><span></span></button>
    </div>
  </div>
</header>
<div class="docs-shell">
  <aside class="docs-side" aria-label="Documentation">
    <input type="search" class="docs-search" id="docs-search" placeholder="Search the docs…" aria-label="Search the docs" />
    <nav id="docs-nav">${sideNav(current)}</nav>
  </aside>
  <main class="docs-main">${body}</main>
</div>
<footer class="landing-foot">
  <div class="foot-glow" aria-hidden="true"></div>
  <div class="foot-main">
    <div class="foot-about">
      <a class="foot-brand" href="/" aria-label="AJ Pilot home"><span class="logo" aria-hidden="true">${LOGO}</span><span>AJ Pilot<small>autopilot for your servers</small></span></a>
      <p class="foot-tagline">Deploy apps, run databases and connect domains on your own Ubuntu servers — with auto deploy on every merge, one self-hosted panel, and nothing to install on the servers.</p>
      <ul class="foot-badges" aria-label="Highlights">
        <li>🔒 AES-256 encrypted</li><li>⚡ Auto deploy on merge</li><li>🖥️ Self-hosted</li><li>🚫 No agent</li>
      </ul>
      <div class="foot-actions">
        <a class="btn primary" href="/#contact">Get started free</a>
        <a class="btn" href="/docs">Read the docs</a>
      </div>
    </div>
    <nav class="foot-col" aria-label="Product">
      <span class="foot-title">Product</span>
      <a href="/#features">Features</a>
      <a href="/#auto-deploy">Auto deploy <span class="foot-new">New</span></a>
      <a href="/#environments">Environments <span class="foot-new">New</span></a>
      <a href="/#how">How it works</a>
      <a href="/#pricing">Pricing</a>
    </nav>
    <nav class="foot-col" aria-label="Platform">
      <span class="foot-title">Platform</span>
      <a href="/#features">Servers &amp; monitoring</a>
      <a href="/#deploy">App deployment</a>
      <a href="/docs/databases">Databases</a>
      <a href="/docs/one-click-installs">One-click installs</a>
      <a href="/docs/app-domains">Domains &amp; SSL</a>
    </nav>
    <nav class="foot-col" aria-label="Resources">
      <span class="foot-title">Resources</span>
      <a href="/docs">Documentation</a>
      <a href="/docs/getting-started">Getting started</a>
      <a href="/docs/deploy-an-app">Deploy an app</a>
      <a href="/docs/security">Security</a>
      <a href="/docs/troubleshooting">Troubleshooting</a>
    </nav>
    <nav class="foot-col" aria-label="Company">
      <span class="foot-title">Company</span>
      <a href="/#about">About</a>
      <a href="/#contact">Contact</a>
      <a href="/#faq">FAQ</a>
      <a href="/#signin">Sign in</a>
    </nav>
  </div>
  <div class="foot-wordmark" aria-hidden="true">AJ Pilot</div>
  <div class="foot-base">
    <span>© ${new Date().getFullYear()} AJ Pilot. All rights reserved.</span>
    <span class="foot-base-mid">Runs on your hardware — your keys never leave it.</span>
    <a class="foot-top" href="#">Back to top <span aria-hidden="true">↑</span></a>
  </div>
</footer>
</div>
<script>
// The header: a menu button on narrow screens, and a firmer bar once the page scrolls.
(function () {
  var head = document.getElementById('landing-head');
  var burger = head.querySelector('.landing-burger');
  function setOpen(open) { head.classList.toggle('nav-open', open); burger.setAttribute('aria-expanded', String(open)); }
  burger.addEventListener('click', function () { setOpen(!head.classList.contains('nav-open')); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setOpen(false); });
  window.addEventListener('scroll', function () { head.classList.toggle('scrolled', window.scrollY > 12); }, { passive: true });

  // Light / dark: one click flips it, stored under the same key as the panel.
  var tbtn = document.getElementById('btn-landing-theme');
  function label() {
    var text = 'Switch to ' + (document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark') + ' theme';
    tbtn.title = text;
    tbtn.setAttribute('aria-label', text);
  }
  tbtn.addEventListener('click', function () {
    var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('ad-theme', next); } catch (e) {}
    document.documentElement.setAttribute('data-theme', next);
    label();
  });
  label();
})();
</script>
<script>
// Filter the guides as you type: the menu here, and the cards on the docs home.
(function () {
  var box = document.getElementById('docs-search');
  box.addEventListener('input', function () {
    var q = box.value.trim().toLowerCase();
    document.querySelectorAll('[data-search]').forEach(function (el) { el.hidden = !!q && el.dataset.search.indexOf(q) === -1; });
    document.querySelectorAll('.docs-group, .docs-cat').forEach(function (g) {
      g.hidden = !!q && !g.querySelector('[data-search]:not([hidden])');
    });
  });
})();
</script>
</body>
</html>`;
}

export function renderDocsHome(req) {
  const url = siteUrl(req);
  const docs = docsFor();
  const body = `
    <nav class="docs-crumbs"><a href="/">Home</a> › Docs</nav>
    <h1>AJ Pilot documentation</h1>
    <p class="docs-lead">Step-by-step guides for everything AJ Pilot does — servers, apps, domains, databases, accounts and your team.
      New here? Start with <a href="/docs/getting-started">Getting started</a>.</p>
    ${DOC_CATEGORIES.map((cat) => {
      const items = docs.filter((d) => d.category === cat);
      if (!items.length) return '';
      return `<section class="docs-cat"><h2>${esc(cat)}</h2><div class="docs-cards">
        ${items.map((d) => `<a class="docs-card" href="/docs/${d.slug}" data-search="${esc(`${d.title} ${d.summary} ${d.category}`.toLowerCase())}"><b>${esc(d.title)}</b><span>${esc(d.summary)}</span></a>`).join('')}
      </div></section>`;
    }).join('')}`;
  return page({
    req, path: '/docs', current: null, body,
    title: 'AJ Pilot Docs — guides for servers, app deployment, domains and databases',
    description: 'How to use AJ Pilot: add servers, create services, deploy apps from GitHub or GitLab, connect domains with Cloudflare and SSL, manage databases, and more.',
    ld: {
      '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'AJ Pilot documentation', url: `${url}/docs`,
      hasPart: docs.map((d) => ({ '@type': 'TechArticle', headline: d.title, url: `${url}/docs/${d.slug}` })),
    },
  });
}

export function renderDoc(req, slug) {
  const d = findDoc(slug);
  if (!d) return null;
  const url = siteUrl(req);
  const docs = docsFor();
  const i = docs.indexOf(d);
  const prev = docs[i - 1];
  const next = docs[i + 1];
  const body = `
    <nav class="docs-crumbs"><a href="/">Home</a> › <a href="/docs">Docs</a> › ${esc(d.category)}</nav>
    <article class="doc">
      <h1>${esc(d.title)}</h1>
      <p class="docs-lead">${esc(d.summary)}</p>
      ${d.body}
    </article>
    <nav class="docs-pager">
      ${prev ? `<a href="/docs/${prev.slug}"><small>← Previous</small><b>${esc(prev.title)}</b></a>` : '<span></span>'}
      ${next ? `<a href="/docs/${next.slug}" class="next"><small>Next →</small><b>${esc(next.title)}</b></a>` : '<span></span>'}
    </nav>
    <div class="docs-help">Still need help? <a href="/#contact">Contact us</a> — tell us what you were doing and the message you saw.</div>`;
  return page({
    req, path: `/docs/${d.slug}`, current: d.slug, body,
    title: `${d.title} — AJ Pilot Docs`,
    description: d.summary,
    ld: {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'TechArticle', headline: d.title, description: d.summary, url: `${url}/docs/${d.slug}`, articleSection: d.category,
          publisher: { '@type': 'Organization', name: 'AJ Pilot', url: `${url}/` }, image: `${url}/og-image.png` },
        { '@type': 'BreadcrumbList', itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: `${url}/` },
          { '@type': 'ListItem', position: 2, name: 'Docs', item: `${url}/docs` },
          { '@type': 'ListItem', position: 3, name: d.title, item: `${url}/docs/${d.slug}` },
        ] },
      ],
    },
  });
}
