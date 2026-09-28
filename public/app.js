/* AJ Pilot — control panel UI (autopilot for your servers) */

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const bytes = (n) => {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
};

const pct = (n) => (n === null || n === undefined ? '—' : `${n}%`);
const val = (v) => (v === null || v === undefined || v === '' ? '—' : esc(v));

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // A session that has gone away sends you back to the front door.
    if (res.status === 401 && data.needsAuth) signedOut();
    // No plan: a client is shown the plan page instead of a dead end.
    if (res.status === 402 && data.needsPlan) planRequired();
    const err = new Error(data.error || `Request failed (${res.status})`);
    // Long output — an install log, a journal — travels alongside the message.
    err.detail = data.detail || null;
    err.body = data;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(message, kind = 'ok') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 5000);
}

function busy(btn, on, label) {
  // A form submitted by anything other than a click has no submitter.
  if (!btn) return;
  if (on) {
    btn.dataset.label = btn.innerHTML;
    btn.innerHTML = `<span class="spinner"></span>${label || 'Working…'}`;
    btn.disabled = true;
  } else {
    btn.innerHTML = btn.dataset.label || btn.innerHTML;
    btn.disabled = false;
  }
}

/* -------------------------------------------------------------- theme */

/**
 * Light, dark, or whatever the operating system says. The choice is kept in
 * this browser; the <head> script has already applied it before first paint,
 * so this only keeps the switches in step and follows the system live.
 */
const THEME_KEY = 'ad-theme';
const systemLight = window.matchMedia ? matchMedia('(prefers-color-scheme: light)') : null;

const THEME_ICON = { light: '☀️', dark: '🌙', system: '🖥️' };

function applyTheme(pref) {
  const choice = ['light', 'dark', 'system'].includes(pref) ? pref : 'system';
  const resolved = choice === 'system' ? (systemLight?.matches ? 'light' : 'dark') : choice;
  document.documentElement.setAttribute('data-theme', resolved);
  document.documentElement.setAttribute('data-theme-pref', choice);
  // One icon in the header says which is chosen; the menu ticks it.
  $$('.theme-current').forEach((el) => { el.textContent = THEME_ICON[choice]; });
  $$('[data-theme-toggle]').forEach((b) => { b.title = `Theme: ${choice === 'system' ? `system (${resolved} now)` : choice}`; });
  $$('[data-theme-set]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.themeSet === choice)));
}

function currentThemePref() {
  try { return localStorage.getItem(THEME_KEY) || 'system'; } catch { return 'system'; }
}

const closeThemeMenus = () => $$('.theme-menu').forEach((m) => {
  m.querySelector('.menu-pop').classList.add('hidden');
  m.querySelector('[data-theme-toggle]').setAttribute('aria-expanded', 'false');
});

$$('[data-theme-toggle]').forEach((btn) => btn.addEventListener('click', (e) => {
  e.stopPropagation();
  const pop = btn.parentElement.querySelector('.menu-pop');
  const opening = pop.classList.contains('hidden');
  closeThemeMenus();
  if (typeof closeUserMenu === 'function') closeUserMenu();
  pop.classList.toggle('hidden', !opening);
  btn.setAttribute('aria-expanded', String(opening));
}));
$$('.theme-menu .menu-pop').forEach((pop) => pop.addEventListener('click', (e) => e.stopPropagation()));
document.addEventListener('click', closeThemeMenus);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeThemeMenus(); });

$$('[data-theme-set]').forEach((btn) => btn.addEventListener('click', () => {
  try { localStorage.setItem(THEME_KEY, btn.dataset.themeSet); } catch { /* private mode: this page only */ }
  applyTheme(btn.dataset.themeSet);
  closeThemeMenus();
}));

// "System" follows the OS as it changes — dark at night, light by day.
systemLight?.addEventListener?.('change', () => { if (currentThemePref() === 'system') applyTheme('system'); });

applyTheme(currentThemePref());
// Colours animate between themes from now on, but not on the first paint.
requestAnimationFrame(() => document.body.classList.add('theme-ready'));

/* ------------------------------------------------------------ routing */

function show(view) {
  // Leaving the server page drops the live view's connection with it.
  if (view !== 'server-detail') stopLiveStats();
  $$('.view').forEach((v) => v.classList.add('hidden'));
  $(`#view-${view}`).classList.remove('hidden');
  // A connection's own page still belongs under Databases in the menu.
  const navView = view === 'mysql-detail' || view === 'db-detail' ? 'databases' : view === 'app-detail' ? 'apps' : view;
  $$('.nav-item').forEach((b) => b.classList.toggle('active',
    b.dataset.view === navView && (!b.dataset.pftab || pfNavIs(b, pf.tab))));
}

$$('.nav-item').forEach((btn) => btn.addEventListener('click', () => {
  const view = btn.dataset.view;
  // Leads arrive at any moment, so their pages are read afresh every time they are opened.
  if (['leads', 'leadstats'].includes(btn.dataset.pftab)) pf.loaded.delete(btn.dataset.pftab);
  // Leads and Contact leads are one page: the menu item picks which form's leads it shows.
  if (btn.dataset.pftab === 'leads') leadFilter.form = btn.dataset.leadform || '';
  if (btn.dataset.pftab) return openPlatform(btn.dataset.pftab);
  if (view === 'platform-back') return leaveOrganisation();
  if (view === 'billing') return openBilling();
  if (view === 'docs') return openDocs();
  show(view);
  setHeading(btn.querySelector('.nav-label')?.textContent || btn.dataset.view);
  if (view === 'servers') loadServers();
  if (view === 'apps') loadApps();
  if (view === 'installs') loadInstallsView();
  if (view === 'environments') loadEnvironments();
  if (view === 'accounts') loadAccounts();
  if (view === 'databases') loadMysqlList();
  if (view === 'settings') loadSettings();
  if (view === 'activity') loadActivity();
}));

/* ------------------------------------------------- who is signed in */

const session = { user: null, roles: [] };

/** Can the signed-in person do this? The server checks again regardless. */
function canDo(action) {
  return Boolean(session.roles.find((r) => r.key === session.user?.role)?.can?.[action]);
}

const roleLabel = (key) => session.roles.find((r) => r.key === key)?.label || key;

/** Render a control only when the signed-in role is allowed to use it. */
const ifCan = (action, html) => (canDo(action) ? html : '');

/* ------------------------------------------ row actions: one "Actions" menu */

/**
 * A table row with two or more buttons gets one "Actions" menu instead of a
 * row of buttons. The buttons themselves are moved (not copied) into the
 * menu, so every delegated data-* handler keeps working exactly as before.
 * Dangerous ones (delete, remove, sign out) go last, below a divider.
 */
function enhanceRowActions(root = document) {
  root.querySelectorAll('td .row-actions:not([data-act-menu])').forEach((box) => {
    const items = [...box.children].filter((el) => el.matches('button, a'));
    if (items.length < 2) return;
    box.dataset.actMenu = '1';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'act-toggle';
    toggle.setAttribute('aria-haspopup', 'menu');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.innerHTML = '<span>Actions</span><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
    const menu = document.createElement('div');
    menu.className = 'act-menu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    const safe = items.filter((el) => !el.classList.contains('danger'));
    const danger = items.filter((el) => el.classList.contains('danger'));
    [...safe, ...(safe.length && danger.length ? [Object.assign(document.createElement('hr'), { className: 'act-sep' })] : []), ...danger]
      .forEach((el) => {
        if (el.matches('button, a')) {
          // Drop the button look; "primary" and "danger" stay to colour the item.
          el.classList.remove('btn', 'tiny', 'big', 'ghost');
          el.classList.add('act-item');
          el.setAttribute('role', 'menuitem');
        }
        menu.append(el);
      });
    box.replaceChildren(toggle, menu);
  });
}

let openActMenu = null;

function closeActMenu() {
  if (!openActMenu) return;
  openActMenu.hidden = true;
  openActMenu.previousElementSibling?.setAttribute('aria-expanded', 'false');
  openActMenu.closest('tr')?.classList.remove('act-open');
  openActMenu = null;
}

function showActMenu(toggle) {
  const menu = toggle.nextElementSibling;
  closeActMenu();
  menu.hidden = false;
  toggle.setAttribute('aria-expanded', 'true');
  toggle.closest('tr')?.classList.add('act-open');
  openActMenu = menu;
  // Fixed, so a scrolling table card never clips it; below the button, or above when there is no room.
  const r = toggle.getBoundingClientRect();
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
  const top = r.bottom + 6 + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 6) : r.bottom + 6;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  // Inside a modal (a new containing block) "fixed" is relative to it: correct for that.
  const got = menu.getBoundingClientRect();
  menu.style.left = `${left + (left - got.left)}px`;
  menu.style.top = `${top + (top - got.top)}px`;
  menu.querySelector('.act-item:not([disabled]):not(.hidden)')?.focus({ preventScroll: true });
}

document.addEventListener('click', (ev) => {
  const toggle = ev.target.closest('.act-toggle');
  if (toggle) {
    if (toggle.nextElementSibling === openActMenu) closeActMenu();
    else showActMenu(toggle);
    return;
  }
  // A chosen item has already run its own handler on the way up: now close.
  closeActMenu();
});
document.addEventListener('keydown', (ev) => {
  if (!openActMenu) return;
  if (ev.key === 'Escape') { const t = openActMenu.previousElementSibling; closeActMenu(); t?.focus(); return; }
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    const items = [...openActMenu.querySelectorAll('.act-item:not([disabled]):not(.hidden)')];
    const at = items.indexOf(document.activeElement);
    items[(at + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  }
});
window.addEventListener('scroll', closeActMenu, true);
window.addEventListener('resize', closeActMenu);

// Every table is drawn from HTML strings at many places: convert whatever appears.
let actPending = false;
new MutationObserver(() => {
  if (actPending) return;
  actPending = true;
  requestAnimationFrame(() => { actPending = false; enhanceRowActions(); });
}).observe(document.body, { childList: true, subtree: true });
enhanceRowActions();

const PERMISSIONS = ['view', 'create', 'edit', 'delete', 'members', 'orgs'];

/**
 * Put the identity on screen and on the <body>, where the stylesheet uses it
 * to hide whatever this role may not do. The API enforces the same rules, so
 * this is about not offering dead ends rather than about security.
 */
function applyIdentity() {
  const user = session.user;
  document.body.classList.remove('booting');
  document.body.classList.toggle('signed-in', Boolean(user));
  document.body.classList.toggle('signed-out', !user);

  if (!user) {
    document.body.classList.remove('platform-mode', 'sa-in-org', 'needs-plan');
    delete document.body.dataset.role;
    delete document.body.dataset.can;
    return;
  }

  document.body.dataset.role = user.role;
  document.body.dataset.can = PERMISSIONS.filter(canDo).join(' ');
  // A super admin is on the platform, or inside a client organisation they opened.
  const superAdmin = user.role === 'super_admin';
  document.body.classList.toggle('platform-mode', superAdmin && !user.orgId);
  document.body.classList.toggle('sa-in-org', superAdmin && Boolean(user.orgId));
  if (superAdmin) document.body.classList.remove('needs-plan');
  $('#sa-banner-org').textContent = user.organisation?.name || '—';
  $('#who-name').textContent = user.name;
  $('#who-org').textContent = roleLabel(user.role);
  $('#topbar-org').textContent = superAdmin && !user.orgId
    ? 'Platform administration'
    : `${user.organisation?.name || 'no organisation'}${superAdmin ? ' · opened as super admin' : ''}`;
  $('#menu-name').innerHTML = `${esc(user.name)} <span class="badge role-pill">${esc(roleLabel(user.role))}</span>`;
  $('#menu-email').textContent = user.email;

  // Initials stand in for the whole block once the rail is collapsed.
  const initials = user.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('');
  $('#who-avatar').textContent = initials || user.email[0];
  $('#who-avatar').title = `${user.name} · ${roleLabel(user.role)} · ${user.organisation?.name || ''}`;
}

/* -------------------------------------------- the sidebar's rail state */

const NAV_KEY = 'auto-deploy.nav-collapsed';

function applyNavState(collapsed) {
  document.body.classList.toggle('nav-collapsed', collapsed);
  const btn = $('#btn-nav-toggle');
  btn.textContent = collapsed ? '»' : '«';
  btn.title = collapsed ? 'Expand the sidebar' : 'Collapse the sidebar';
  btn.setAttribute('aria-label', btn.title);
}

$('#btn-nav-toggle').addEventListener('click', () => {
  const collapsed = !document.body.classList.contains('nav-collapsed');
  applyNavState(collapsed);
  try { localStorage.setItem(NAV_KEY, collapsed ? '1' : '0'); } catch { /* private mode */ }
});

// Restore the choice before anything is painted.
try { applyNavState(localStorage.getItem(NAV_KEY) === '1'); } catch { applyNavState(false); }

/* --------------------------------------------- the landing page's gate */

let needsSetup = false;

/** Show the sign-in card over the landing page. */
function openAuth(mode = 'login') {
  const setup = mode === 'setup';
  $('#auth-gate').classList.remove('hidden');
  $('#form-setup').classList.toggle('hidden', !setup);
  $('#form-login').classList.toggle('hidden', setup);
  $('#setup-msg').classList.add('hidden');
  $('#login-msg').classList.add('hidden');
  $(`${setup ? '#form-setup' : '#form-login'} input`)?.focus();
}

const closeAuth = () => $('#auth-gate').classList.add('hidden');

$('#btn-close-gate').addEventListener('click', closeAuth);
$('#auth-gate').addEventListener('click', (e) => { if (e.target.id === 'auth-gate') closeAuth(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAuth(); });

$('#btn-open-signin').addEventListener('click', () => openAuth('login'));
$('#btn-open-setup').addEventListener('click', () => openAuth('setup'));
// "Get started" leads to the contact form — or, on a panel nobody has set up yet, to the setup card.
const getStarted = () => (needsSetup ? openAuth('setup') : goToLeadForm());
$('#btn-hero-primary').addEventListener('click', getStarted);
$('#btn-cta').addEventListener('click', getStarted);
$('#link-contact-signin').addEventListener('click', (e) => { e.preventDefault(); openAuth('login'); });

/**
 * Nobody is signed in: the landing page is what a visitor gets, with the
 * sign-in card one click away. A panel with no accounts yet says so instead.
 */
function showLanding(setupNeeded) {
  needsSetup = Boolean(setupNeeded);
  session.user = null;
  applyIdentity();
  closeAuth();

  $('#btn-open-setup').classList.toggle('hidden', !needsSetup);
  $('#btn-open-signin').classList.toggle('hidden', needsSetup);
  $('#btn-hero-primary').textContent = needsSetup ? 'Set up your panel' : 'Get started free';
  $('#btn-cta').textContent = needsSetup ? 'Set up your panel' : 'Get started free';
  $('#hero-note').textContent = needsSetup
    ? 'This panel has no accounts yet — the first one you create is the super admin.'
    : 'Nothing leaves your network. Every secret is encrypted before it touches disk.';
  loadPricing();
  if (location.hash === '#signin') openAuth(needsSetup ? 'setup' : 'login');
}

/* ------------------------------------------- the landing page's prices */

let publicPlans = [];
let pricingCycle = 'monthly';

const LIMIT_WORDS = {
  servers: ['server', 'servers'],
  apps: ['app', 'apps'],
  users: ['team member', 'team members'],
  databases: ['database connection', 'database connections'],
  domains: ['domain', 'domains'],
};

/** "Up to 3 servers", "1 server", or "Unlimited servers". */
function limitLine(key, n) {
  const [one, many] = LIMIT_WORDS[key] || [key, key];
  if (n === undefined || n === null) return `Unlimited ${many}`;
  return n === 1 ? `1 ${one}` : `Up to ${n} ${many}`;
}

/** Money the way people in that currency write it. */
function fmtMoney(n, currency = 'INR', { compact = false } = {}) {
  const v = Number(n) || 0;
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : undefined, {
      style: 'currency', currency, notation: compact ? 'compact' : 'standard',
      maximumFractionDigits: compact ? 1 : (v % 1 ? 2 : 0), minimumFractionDigits: 0,
    }).format(v);
  } catch {
    return `${currency} ${v}`;
  }
}

async function loadPricing() {
  // The first cards come with the page; this refreshes them and fills the form's plan choices.
  try {
    publicPlans = (await api('/public/plans')).plans || [];
  } catch {
    publicPlans = [];
  }
  renderPricing();
}

function renderPricing() {
  const has = publicPlans.length > 0;
  fillLeadPlans();
  $('#pricing').classList.toggle('hidden', !has);
  $('#nav-pricing').classList.toggle('hidden', !has);
  if (!has) return;

  // Yearly is only worth a switch when some plan is actually sold that way.
  const yearlyOffered = publicPlans.some((p) => p.priceYearly > 0);
  $('#pricing .cycle-toggle').classList.toggle('hidden', !yearlyOffered);
  if (!yearlyOffered) pricingCycle = 'monthly';
  const saving = Math.max(0, ...publicPlans.filter((p) => p.priceMonthly > 0 && p.priceYearly > 0)
    .map((p) => Math.round((1 - p.priceYearly / (p.priceMonthly * 12)) * 100)));
  $('#pricing-save').textContent = saving > 0 ? `save ${saving}%` : '';
  $$('#pricing .cycle-toggle button').forEach((b) => b.classList.toggle('active', b.dataset.cycle === pricingCycle));

  $('#price-grid').innerHTML = publicPlans.map((p) => {
    const free = p.priceMonthly === 0 && p.priceYearly === 0;
    const yearly = pricingCycle === 'yearly' && p.priceYearly > 0;
    const price = yearly ? p.priceYearly : p.priceMonthly;
    const per = yearly ? '/year' : '/month';
    let note = '';
    if (yearly) note = `≈ ${fmtMoney(p.priceYearly / 12, p.currency)} a month, billed yearly`;
    else if (pricingCycle === 'yearly' && !free) note = 'Billed monthly only';
    else if (!free && p.priceYearly > 0) note = `or ${fmtMoney(p.priceYearly, p.currency)} a year`;
    const limits = Object.keys(LIMIT_WORDS).map((k) => `<li>${esc(limitLine(k, p.limits[k]))}</li>`).join('');
    const features = p.features.map((f) => `<li>${esc(f)}</li>`).join('');
    return `<article class="price-card ${p.highlighted ? 'featured' : ''}">
      ${p.highlighted ? '<span class="price-ribbon">Most popular</span>' : ''}
      <h3>${esc(p.name)}</h3>
      <p class="price-tagline">${esc(p.tagline || '')}</p>
      <div class="price-amount">${free ? '<b>Free</b>' : `<b>${esc(fmtMoney(price, p.currency))}</b><span>${per}</span>`}</div>
      <p class="price-note">${esc(note) || '&nbsp;'}</p>
      <a class="btn ${p.highlighted ? 'primary' : ''} big price-cta" href="#contact" data-plan="${p.id}">${free ? 'Start free' : 'Get started'}</a>
      <ul class="price-list">${limits}${features}</ul>
    </article>`;
  }).join('');
}

$('#pricing .cycle-toggle').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-cycle]');
  if (!b) return;
  pricingCycle = b.dataset.cycle;
  renderPricing();
});

$('#price-grid').addEventListener('click', (e) => {
  const cta = e.target.closest('.price-cta');
  if (!cta) return;
  e.preventDefault();
  if (needsSetup) return openAuth('setup');
  goToLeadForm({ planId: cta.dataset.plan, cycle: pricingCycle, form: 'pricing' });
});

/* ---------------------------------------------- the "Get started" form */

/**
 * Where a visitor came from — the campaign in the address, the site that sent
 * them and the page they landed on — is noted on their first page view and
 * sent with the form, so each lead says which marketing brought it.
 */
const ATTRIB_KEY = 'ad-attrib';
(function noteAttribution() {
  try {
    if (sessionStorage.getItem(ATTRIB_KEY)) return;
    const q = new URLSearchParams(location.search);
    const a = { referrer: document.referrer || '', landing_path: location.pathname + location.search };
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach((k) => { if (q.get(k)) a[k] = q.get(k); });
    sessionStorage.setItem(ATTRIB_KEY, JSON.stringify(a));
  } catch { /* storage blocked: the lead just arrives without it */ }
})();

const attribution = () => { try { return JSON.parse(sessionStorage.getItem(ATTRIB_KEY) || '{}'); } catch { return {}; } };

/**
 * One random id per browser, kept in that browser, with when it first came
 * and how many times — so two enquiries from the same browser are recognised
 * as one person even under different emails.
 */
const VISITOR_KEY = 'ad-visitor';
const pageOpenedAt = Date.now();
const visitor = (() => {
  let v = null;
  try { v = JSON.parse(localStorage.getItem(VISITOR_KEY) || 'null'); } catch { /* storage blocked */ }
  if (!v || !/^[A-Za-z0-9-]{8,64}$/.test(v.id || '')) {
    const id = window.crypto?.randomUUID ? crypto.randomUUID() : `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    v = { id, firstSeen: new Date().toISOString(), visits: 0, firstReferrer: document.referrer || '' };
  }
  try {
    // A visit is a browser session, not every reload.
    if (!sessionStorage.getItem('ad-visit-counted')) {
      v.visits = (v.visits || 0) + 1;
      sessionStorage.setItem('ad-visit-counted', '1');
    }
    localStorage.setItem(VISITOR_KEY, JSON.stringify(v));
  } catch { /* storage blocked: the id lives for this page only */ }
  return v;
})();

/**
 * The visitor's computer as their browser reports it — operating system and
 * version, browser, screen, processor cores, memory, graphics, language and
 * timezone — sent with the form so the lead shows what they are using.
 * Every part is optional: a browser that will not say simply leaves it out.
 */
async function collectDevice() {
  const nav = navigator;
  const mq = (q) => { try { return matchMedia(q).matches; } catch { return undefined; } };
  const d = {
    platform: nav.platform,
    language: nav.language,
    languages: nav.languages ? [...nav.languages] : undefined,
    timezone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } })(),
    tzOffset: -new Date().getTimezoneOffset(),
    screen: {
      width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight,
      colorDepth: screen.colorDepth, pixelRatio: window.devicePixelRatio, orientation: screen.orientation?.type,
    },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    cpuCores: nav.hardwareConcurrency,
    memoryGb: nav.deviceMemory,
    touchPoints: nav.maxTouchPoints,
    cookies: nav.cookieEnabled,
    doNotTrack: nav.doNotTrack,
    colorScheme: mq('(prefers-color-scheme: dark)') ? 'dark' : 'light',
    reducedMotion: mq('(prefers-reduced-motion: reduce)'),
  };
  const c = nav.connection;
  if (c) d.connection = { type: c.effectiveType, downlink: c.downlink, rtt: c.rtt, saveData: c.saveData };
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const info = gl && gl.getExtension('WEBGL_debug_renderer_info');
    if (info) {
      d.gpu = gl.getParameter(info.UNMASKED_RENDERER_WEBGL);
      d.gpuVendor = gl.getParameter(info.UNMASKED_VENDOR_WEBGL);
    }
  } catch { /* no WebGL */ }
  // Chromium browsers can say which Windows (10 or 11), the processor type and the exact version.
  if (nav.userAgentData) {
    d.uaData = { platform: nav.userAgentData.platform, mobile: nav.userAgentData.mobile, brands: nav.userAgentData.brands };
    try {
      Object.assign(d.uaData, await nav.userAgentData.getHighEntropyValues(['platformVersion', 'architecture', 'bitness', 'model', 'fullVersionList']));
    } catch { /* the browser declined */ }
  }
  return d;
}

/** The plans on offer, as choices in the form. */
function fillLeadPlans() {
  const sel = $('#lead-plan');
  const keep = sel.value;
  sel.innerHTML = '<option value="">Not sure yet</option>' + publicPlans.map((p) =>
    `<option value="${p.id}">${esc(p.name)}${p.priceMonthly ? ` — ${esc(fmtMoney(p.priceMonthly, p.currency))}/month` : ' — free'}</option>`).join('');
  if (keep) sel.value = keep;
}

/** Scroll to the form, with a plan already picked when one was clicked. */
function goToLeadForm({ planId, cycle, form = 'hero' } = {}) {
  const f = $('#form-lead');
  if (planId) f.plan_id.value = planId;
  if (cycle) f.cycle.value = cycle;
  f.form.value = form;
  $('#contact').scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(() => f.name.focus({ preventScroll: true }), 450);
}

$('#form-lead').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const msg = $('#lead-msg');
  if (!f.name.value.trim()) return formMsg(msg, 'Please tell us your name.', 'err');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.value.trim())) return formMsg(msg, 'Please enter a valid email address.', 'err');
  const btn = e.submitter || $('button[type=submit]', f);
  busy(btn, true, 'Sending…');
  try {
    const device = await collectDevice().catch(() => null);
    const visit = { ...visitor, secondsOnPage: Math.round((Date.now() - pageOpenedAt) / 1000) };
    await api('/public/leads', { method: 'POST', body: { ...attribution(), ...Object.fromEntries(new FormData(f).entries()), device, visit } });
    f.innerHTML = `<div class="lead-thanks"><div class="lead-thanks-icon">✓</div><h3>Thank you — we have your details.</h3>
      <p class="muted">We will be in touch within one working day. In the meantime, have a look at <a href="#features">everything AJ Pilot does</a>.</p></div>`;
  } catch (err) {
    formMsg(msg, err.message, 'err');
    busy(btn, false);
  }
});

$('#year').textContent = String(new Date().getFullYear());

/** The session ended somewhere else — stop showing data that is no longer ours. */
function signedOut() {
  if (!session.user) return;
  $$('.view').forEach((v) => v.classList.add('hidden'));
  showLanding(false);
  openAuth('login');
  formMsg($('#login-msg'), 'Your session ended — sign in again to carry on.', 'info');
}

$('#form-setup').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter || $('button[type=submit]', e.target);
  const msg = $('#setup-msg');
  busy(btn, true, 'Creating…');
  try {
    const r = await api('/auth/setup', { method: 'POST', body: Object.fromEntries(new FormData(e.target).entries()) });
    session.user = r.user;
    await enterApp();
    toast(`Welcome, ${r.user.name} — you are the super admin of ${r.user.organisation?.name}`);
  } catch (err) {
    formMsg(msg, err.message, 'err');
  }
  busy(btn, false);
});

$('#form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter || $('button[type=submit]', e.target);
  const msg = $('#login-msg');
  busy(btn, true, 'Signing in…');
  try {
    const r = await api('/auth/login', { method: 'POST', body: Object.fromEntries(new FormData(e.target).entries()) });
    session.user = r.user;
    e.target.reset();
    msg.classList.add('hidden');
    await enterApp();
  } catch (err) {
    formMsg(msg, err.message, 'err');
  }
  busy(btn, false);
});

$('#btn-signout').addEventListener('click', async () => {
  try { await api('/auth/logout', { method: 'POST' }); } catch { /* the cookie is going either way */ }
  $$('.view').forEach((v) => v.classList.add('hidden'));
  showLanding(false);
  toast('Signed out');
});

/* the user menu in the header */

const closeUserMenu = () => {
  $('#user-dropdown').classList.add('hidden');
  $('#btn-user-menu').setAttribute('aria-expanded', 'false');
};

$('#btn-user-menu').addEventListener('click', (e) => {
  e.stopPropagation();
  closeThemeMenus();
  const open = $('#user-dropdown').classList.toggle('hidden');
  $('#btn-user-menu').setAttribute('aria-expanded', String(!open));
});

// Anywhere else, or Escape, puts it away.
document.addEventListener('click', closeUserMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeUserMenu(); });
$('#user-dropdown').addEventListener('click', (e) => e.stopPropagation());

$('#btn-open-settings').addEventListener('click', () => {
  closeUserMenu();
  openSettings('profile');
});

$('#btn-open-docs').addEventListener('click', () => { closeUserMenu(); openDocs(); });

// Activity lives in this menu too, not in the side menu.
$('#btn-open-activity').addEventListener('click', () => {
  closeUserMenu();
  show('activity');
  setHeading('Activity');
  loadActivity();
});

/** The header says which page you are on. */
const setHeading = (text) => { $('#topbar-heading').textContent = text; };

/**
 * The header's organisation picker is retired: a super admin opens a client
 * organisation from Organisations → Open, and comes back with the banner.
 */
async function loadOrgSwitcher() {
  $('#org-pick').classList.add('hidden');
}

/* your own profile */

/** Admins and super admins must have a mobile number; everyone else may leave it empty. */
const PHONE_ROLES = ['super_admin', 'admin'];
const PHONE_FIELD = (name, value = '', required = false) => `<label>Mobile number <span class="muted small">${required ? '(required — with country code)' : '(optional)'}</span>
  <input name="${name}" type="tel" inputmode="tel" autocomplete="tel" maxlength="32" placeholder="+91 98765 43210" value="${esc(value || '')}" ${required ? 'required' : ''} /></label>`;

/**
 * Open your profile. With `mustAddPhone`, it is the one thing between an
 * admin without a mobile number and the rest of the panel: no Cancel.
 */
function openProfile({ mustAddPhone = false } = {}) {
  closeUserMenu();
  const form = $('#form-profile');
  form.reset();
  $('#profile-msg').classList.add('hidden');
  $('#profile-org').textContent = session.user?.organisation?.name || 'this organisation';
  form.name.value = session.user?.name || '';
  form.email.value = session.user?.email || '';
  form.phone.value = session.user?.phone || '';
  const required = PHONE_ROLES.includes(session.user?.role);
  form.phone.required = required;
  $('#profile-phone-hint').textContent = required ? '(required — with country code)' : '(optional)';
  $('#profile-title').textContent = mustAddPhone ? 'Add your mobile number' : 'Edit profile';
  $('#profile-phone-needed').classList.toggle('hidden', !mustAddPhone);
  // The line about "this organisation" means nothing to a super admin on the platform.
  $('#profile-intro').classList.toggle('hidden', mustAddPhone || !session.user?.organisation);
  $('#btn-profile-cancel').classList.toggle('hidden', mustAddPhone);
  $('#modal-profile').dataset.locked = mustAddPhone ? '1' : '';
  $('#modal-profile').classList.remove('hidden');
  (mustAddPhone ? form.phone : form.name).focus();
}

$('#btn-edit-profile').addEventListener('click', () => openProfile());

$('#form-profile').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter || $('button[type=submit]', e.target);
  busy(btn, true, 'Saving…');
  try {
    const r = await api('/auth/profile', { method: 'PUT', body: Object.fromEntries(new FormData(e.target).entries()) });
    const wasLocked = $('#modal-profile').dataset.locked === '1';
    session.user = r.user;
    applyIdentity();
    $('#modal-profile').dataset.locked = '';
    $('#modal-profile').classList.add('hidden');
    toast(wasLocked ? 'Thank you — your mobile number is saved' : 'Profile updated');
    if (!$('#view-settings').classList.contains('hidden')) loadSettings();
  } catch (err) {
    formMsg($('#profile-msg'), err.message, 'err');
  }
  busy(btn, false);
});

/* changing your own password */

$('#btn-password').addEventListener('click', () => {
  closeUserMenu();
  $('#form-password').reset();
  $('#password-msg').classList.add('hidden');
  $('#modal-password').classList.remove('hidden');
});

$('#form-password').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  busy(btn, true, 'Saving…');
  try {
    await api('/auth/password', { method: 'POST', body: Object.fromEntries(new FormData(e.target).entries()) });
    $('#modal-password').classList.add('hidden');
    toast('Password changed — your other sessions were signed out');
  } catch (err) {
    formMsg($('#password-msg'), err.message, 'err');
  }
  busy(btn, false);
});

/* ------------------------------------------------------ servers list */

async function loadServers() {
  const box = $('#server-list');
  box.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const servers = await api('/servers');
    if (!servers.length) {
      box.innerHTML = '<div class="empty">No servers yet. Click <b>+ Add server</b> to connect your first Ubuntu box.</div>';
      return;
    }
    box.innerHTML = servers.map(serverCard).join('');
    // The cards are drawn from the stored rows; this fills in what the monitor
    // knows right now rather than leaving them blank until the next tick.
    pollServerStatuses();
  } catch (err) {
    box.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

/** Green when the last check reached the host, red when it did not. */
const statusTone = (status) => (status === 'online' ? 'ok' : (status === 'offline' || status === 'error') ? 'err' : '');

/**
 * The list keeps itself honest.
 *
 * The panel probes every server's SSH port every few seconds; this asks for
 * those answers on the same cadence and patches each card's dot, badge and
 * reason in place — so a card you are in the middle of using is never redrawn
 * under your cursor, and a server that goes down says so within seconds.
 *
 * The endpoint it polls is a deliberately small one: statuses only, no system
 * profiles and no joins.
 */
const STATUS_POLL_MS = 5000;

setInterval(pollServerStatuses, STATUS_POLL_MS);

async function pollServerStatuses() {
  const onList = !$('#view-servers').classList.contains('hidden') && $('#server-list .card');
  const onDetail = !$('#view-server-detail').classList.contains('hidden');
  if (!onList && !onDetail) return;

  let r;
  try {
    r = await api('/servers/status');
  } catch {
    const head = $('#server-list-updated');
    if (head) head.innerHTML = '<span class="badge warn">not updating</span> the panel could not be reached';
    return;
  }

  // The server's own page carries the same line as its card does.
  if (onDetail) {
    const mine = r.servers.find((s) => String(s.id) === String(currentServerId));
    const el = $('#detail-status');
    if (el) {
      el.innerHTML = mine
        ? `<span class="badge ${statusTone(mine.status)}">${esc(mine.status)}</span> ${statusNote(mine)}`
        : '&nbsp;';
    }
  }
  if (!onList) return;

  // When the whole list was last refreshed, and how often it is being checked.
  const head = $('#server-list-updated');
  if (head) {
    head.innerHTML = `Last updated <b>${esc(clockTime(r.at))}</b>`
      + ` · checking every ${r.everySeconds}s`;
  }

  for (const s of r.servers) {
    const card = $(`#server-list .card[data-server="${s.id}"]`);
    if (!card) continue;

    const dot = $('.dot', card);
    if (dot) dot.className = `dot ${s.status}`;

    const badge = $('.card-head .badge', card);
    if (badge && badge.textContent !== s.status) {
      badge.className = `badge ${statusTone(s.status)}`;
      badge.textContent = s.status;
    }

    const note = $('[data-status-note]', card);
    if (note) note.innerHTML = statusNote(s);

    // The reason a server is unreachable belongs on the card, and goes away
    // again the moment it answers.
    const problem = $('[data-status-error]', card);
    if (problem) {
      const text = s.status === 'offline' ? s.lastError : (s.signIn === false ? s.signInError : '');
      problem.innerHTML = text ? `<div class="msg err" style="margin-top:12px">${esc(text)}</div>` : '';
    }
  }
}

/**
 * "12ms to its SSH port · updated 3s ago", with the exact time on hover and a
 * word when the port answers but the panel cannot sign in.
 */
function statusNote(s) {
  const bits = [];
  if (s.status === 'online' && s.latencyMs !== null) bits.push(`${s.latencyMs}ms to its SSH port`);
  if (s.checkedAt) bits.push(`updated ${agoWords(s.checkedAt)}`);

  const line = bits.length
    ? `<span class="muted small" title="Last checked at ${esc(clockTime(s.checkedAt))}">${esc(bits.join(' · '))}</span>`
    : '';

  if (s.signIn === false) {
    return `${line} <span class="badge warn" title="${esc(s.signInError || '')}">cannot sign in</span>`;
  }
  // The sign-in check runs every few minutes, so say when it last passed.
  if (s.signIn === true && s.signInCheckedAt) {
    return `${line} <span class="muted small" title="Last signed in at ${esc(clockTime(s.signInCheckedAt))}">`
      + `· signed in ${esc(agoWords(s.signInCheckedAt))}</span>`;
  }
  return line;
}

/** How long ago, in the units a person would say it in. */
function agoWords(when) {
  const at = parseWhen(when);
  if (!at) return 'just now';
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

/** The clock time, for when "3s ago" is not the answer somebody wants. */
function clockTime(when) {
  const at = parseWhen(when);
  return at ? new Date(at).toLocaleTimeString() : '—';
}

/** MySQL hands back "2026-09-23 10:11:12"; the API hands back ISO. */
/** The database keeps UTC and says so nowhere: "2026-09-27 04:05:42" means 04:05 UTC. */
function parseWhen(when) {
  if (!when) return null;
  let text = String(when).replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text)) text += 'Z';
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : at;
}

function serverCard(s) {
  const sum = s.summary;
  return `
  <div class="card" data-server="${s.id}">
    <div class="card-head">
      <div>
        <h3><span class="dot ${esc(s.status)}"></span> ${esc(s.name)}</h3>
        <div class="muted small">${esc(s.username)}@${esc(s.host)}:${s.port} · ${s.auth_type === 'key' ? 'SSH key' : 'password'}</div>
        <div class="muted small" data-status-note></div>
      </div>
      <span class="badge ${statusTone(s.status)}">${esc(s.status)}</span>
    </div>
    ${s.tags.length ? `<div class="chips" style="margin-top:10px">${s.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>` : ''}
    ${sum ? `
      <dl class="kv">
        <dt>OS</dt><dd>${val(sum.os)}</dd>
        <dt>CPU / RAM</dt><dd>${val(sum.cpuCores)} vCPU · ${bytes(sum.memoryTotalBytes)}</dd>
        <dt>Memory used</dt><dd>${pct(sum.memoryUsedPct)}</dd>
        <dt>Uptime</dt><dd>${val(sum.uptime)}</dd>
      </dl>` : `<p class="muted small" style="margin:12px 0 0">No system details collected yet.</p>`}
    <div data-status-error>${s.last_error ? `<div class="msg err" style="margin-top:12px">${esc(s.last_error)}</div>` : ''}</div>
    <div class="card-actions">
      <button class="btn tiny" data-action="open" data-id="${s.id}">View details</button>
      <button class="btn tiny" data-action="test" data-id="${s.id}">Test</button>
      ${ifCan('edit', `<button class="btn tiny" data-action="edit" data-id="${s.id}">Edit</button>`)}
      <button class="btn tiny" data-action="refresh" data-id="${s.id}">Fetch details</button>
      ${ifCan('delete', `<button class="btn tiny danger" data-action="delete" data-id="${s.id}">Delete</button>`)}
    </div>
  </div>`;
}

$('#server-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const { action, id } = btn.dataset;

  if (action === 'open') return openServer(id);

  if (action === 'edit') {
    busy(btn, true, 'Opening…');
    try {
      openServerModal(await api(`/servers/${id}`));
    } catch (err) {
      toast(err.message, 'err');
    }
    return busy(btn, false);
  }

  if (action === 'delete') {
    if (!confirm('Delete this server and its collected system details?')) return;
    await api(`/servers/${id}`, { method: 'DELETE' });
    toast('Server deleted');
    return loadServers();
  }

  busy(btn, true, action === 'test' ? 'Testing…' : 'Collecting…');
  try {
    if (action === 'test') {
      const r = await api(`/servers/${id}/test`, { method: 'POST' });
      toast(`Connected to ${r.hostname} as ${r.user} (${r.latencyMs}ms) — ${r.os}`);
    } else {
      const r = await api(`/servers/${id}/facts`, { method: 'POST' });
      toast(`Collected system details from ${r.identity.hostname} in ${r.meta.durationMs}ms`);
    }
    await loadServers();
  } catch (err) {
    toast(err.message, 'err');
    busy(btn, false);
    await loadServers();
  }
});

/* ----------------------------------------------------- server detail */

let currentServerId = null;
let currentServer = null;

/**
 * The detail page is one tab per subject rather than one long scroll.
 *
 * The first five come straight out of the stored profile. The last four talk
 * to the server, so they are only fetched when their tab is first opened —
 * which also means opening a server no longer starts several SSH sessions at once.
 */
const SERVER_TABS = [
  { key: 'overview', label: 'Overview', facts: true, load: () => loadServerSummary() },
  { key: 'storage', label: 'Storage', facts: true, load: () => loadFileBrowser() },
  { key: 'network', label: 'Network', facts: true },
  { key: 'processes', label: 'Processes', facts: true },
  { key: 'system', label: 'System', facts: true },
  { key: 'live', label: 'Live', load: () => startLiveStats() },
  { key: 'apps', label: 'Apps', load: () => loadServerApps() },
  { key: 'docker', label: 'Docker', load: () => loadServerDocker() },
  { key: 'nginx', label: 'Nginx', load: () => loadServerNginx() },
  { key: 'cron', label: 'Cron', load: () => loadServerCron() },
  { key: 'services', label: 'Services', load: () => loadServerServices() },
  { key: 'runners', label: 'Runners', load: () => loadServerRunners() },
];

let currentTab = 'overview';
let tabsLoaded = new Set();

async function openServer(id) {
  stopLiveStats();
  // Opening a different server starts at the top; refreshing keeps your place.
  if (String(id) !== String(currentServerId)) {
    currentTab = 'overview';
    filesPath = '/';
    filesData = null;
    filesBack = [];
    filesForward = [];
    filesFilter = '';
  }
  currentServerId = id;
  tabsLoaded = new Set();

  show('server-detail');
  $('#detail-tabs').innerHTML = '';
  $('#detail-body').innerHTML = '<div class="empty">Loading…</div>';

  try {
    const s = await api(`/servers/${id}`);
    currentServer = s;
    $('#detail-name').innerHTML = `<span class="dot ${esc(s.status)}"></span> ${esc(s.name)}`;
    $('#detail-sub').textContent = `${s.username}@${s.host}:${s.port} · ${s.auth_type === 'key' ? 'SSH key auth' : 'password auth'}${s.notes ? ` · ${s.notes}` : ''}`;
    // Filled in properly by the status poll a moment later.
    $('#detail-status').innerHTML = `<span class="badge ${statusTone(s.status)}">${esc(s.status)}</span>`
      + `<span class="muted small"> ${s.last_checked_at ? `updated ${esc(agoWords(s.last_checked_at))}` : 'not checked yet'}</span>`;
    pollServerStatuses();

    const panels = s.facts ? renderFactTabs(s.facts) : null;
    const noFacts = '<div class="empty">No system details yet. Click <b>Fetch system details</b> to connect and read this server.</div>';

    $('#detail-tabs').innerHTML = SERVER_TABS.map((t) => `<button class="tab ${t.key === currentTab ? 'active' : ''}" data-tab="${t.key}"><span>${esc(t.label)}</span><span class="tab-count" id="tab-count-${t.key}"></span></button>`).join('');

    $('#detail-body').innerHTML = SERVER_TABS.map((t) => `
      <div class="tab-panel" data-panel="${t.key}" ${t.key === currentTab ? '' : 'hidden'}>
        ${t.key === 'overview' ? '<div class="section" id="server-summary"></div>' : ''}
        ${t.key === 'storage'
    // Drives first, like "This PC", then the explorer, then the technical tables.
    ? `${panels ? panels.storage : ''}<div class="section" id="files-panel"></div>${panels ? panels.storageMore : ''}`
    : t.facts ? (panels ? panels[t.key] : noFacts) : `<div class="section" id="${liveTabPanelId(t.key)}"></div>`}
      </div>`).join('');

    showServerTab(currentTab);
  } catch (err) {
    $('#detail-body').innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
  }
}

const liveTabPanelId = (key) => ({
  live: 'live-panel', apps: 'server-apps-panel', docker: 'docker-panel', nginx: 'nginx-panel',
  cron: 'cron-panel', services: 'services-panel', runners: 'server-runners-panel',
}[key]);

function showServerTab(key) {
  const tab = SERVER_TABS.find((t) => t.key === key) || SERVER_TABS[0];
  currentTab = tab.key;

  $$('#detail-tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab.key));
  $$('#detail-body .tab-panel').forEach((p) => { p.hidden = p.dataset.panel !== tab.key; });

  // The live view holds an SSH session open on the server, so it is dropped the
  // moment you look at something else — and taken up again when you come back.
  if (tab.key !== 'live') stopLiveStats();
  else if (tabsLoaded.has('live')) startLiveStats();

  // A live tab is read the first time you look at it, and cached after that.
  if (tab.load && !tabsLoaded.has(tab.key)) {
    tabsLoaded.add(tab.key);
    tab.load();
  }
}

/**
 * Switch to a live tab and make sure it shows what just changed — without
 * fetching twice when the switch itself is what loads it.
 */
function refreshServerTab(key) {
  const wasLoaded = tabsLoaded.has(key);
  showServerTab(key);
  if (wasLoaded) SERVER_TABS.find((t) => t.key === key)?.load?.();
}

/** The little number next to a tab's name, filled in once that tab has loaded. */
function setTabCount(key, count, kind = '') {
  const el = $(`#tab-count-${key}`);
  if (!el) return;
  el.textContent = count === null || count === undefined ? '' : String(count);
  el.className = `tab-count ${kind}`;
}

$('#detail-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (btn) showServerTab(btn.dataset.tab);
});

$('#btn-back').addEventListener('click', () => { show('servers'); loadServers(); });

$('#btn-detail-test').addEventListener('click', async (e) => {
  busy(e.target, true, 'Testing…');
  try {
    const r = await api(`/servers/${currentServerId}/test`, { method: 'POST' });
    toast(`Connected to ${r.hostname} as ${r.user} (${r.latencyMs}ms)`);
  } catch (err) {
    toast(err.message, 'err');
  }
  busy(e.target, false);
});

$('#btn-detail-refresh').addEventListener('click', async (e) => {
  busy(e.target, true, 'Collecting…');
  try {
    await api(`/servers/${currentServerId}/facts`, { method: 'POST' });
    toast('System details updated');
    await openServer(currentServerId);
  } catch (err) {
    toast(err.message, 'err');
  }
  busy(e.target, false);
});

/* ----------------------------------------------------- facts rendering */

function meterClass(p) { return p >= 90 ? 'err' : p >= 75 ? 'warn' : ''; }

function tile(label, value, sub, meterPct) {
  return `<div class="tile">
    <div class="label">${esc(label)}</div>
    <div class="value">${value}</div>
    ${sub ? `<div class="sub">${sub}</div>` : ''}
    ${meterPct !== undefined && meterPct !== null ? `<div class="meter"><span class="${meterClass(meterPct)}" style="width:${Math.min(100, meterPct)}%"></span></div>` : ''}
  </div>`;
}

function section(title, inner) {
  return `<div class="section"><h2>${esc(title)}</h2>${inner}</div>`;
}

function kvCard(title, pairs) {
  const rows = pairs.filter(([, v]) => v !== undefined).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('');
  return `<div class="card">${title ? `<h3>${esc(title)}</h3>` : ''}<dl class="kv">${rows}</dl></div>`;
}

function table(headers, rows, emptyText = 'Nothing reported') {
  if (!rows.length) return `<div class="card"><p class="muted small" style="margin:0">${esc(emptyText)}</p></div>`;
  return `<div class="card" style="padding:4px 0">
    <table>
      <thead><tr>${headers.map((h) => `<th class="${h.num ? 'num' : ''}">${esc(h.label)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td class="${headers[i].num ? 'num' : ''}">${c}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>
  </div>`;
}

/**
 * The stored system profile, split the way the detail page's tabs are.
 * Each key is one tab's HTML; the live tabs (Docker, services, runners) are
 * filled in separately when they are first opened.
 */
function renderFactTabs(f) {
  return {
    overview: factsOverview(f),
    storage: factsStorage(f),
    storageMore: factsStorageMore(f),
    network: factsNetwork(f),
    processes: factsProcesses(f),
    system: factsSystem(f),
  };
}

function factsOverview(f) {
  const out = [];

  if (f.warnings?.length) {
    out.push(f.warnings.map((w) => `<div class="msg info" style="margin-bottom:12px">${esc(w)}</div>`).join(''));
  }

  const rootDisk = f.disks?.find((d) => d.mount === '/') || f.disks?.[0];
  const loadPct = f.cpu?.cores && f.load?.one !== null ? Math.round((f.load.one / f.cpu.cores) * 100) : null;

  /* overview */
  out.push(section('Overview', `<div class="tiles">
    ${tile('Operating system', val(f.os.pretty), `${val(f.os.codename)} · ${val(f.identity.arch)}`)}
    ${tile('Kernel', val(f.identity.kernel), val(f.identity.virtualization))}
    ${tile('Uptime', val(f.uptime.human), `since ${val(f.uptime.bootTime)}`)}
    ${tile('Load average', `${val(f.load.one)}`, `5m ${val(f.load.five)} · 15m ${val(f.load.fifteen)} · ${val(f.cpu.cores)} vCPU`, loadPct)}
    ${tile('Memory', pct(f.memory.usedPct), `${bytes(f.memory.usedBytes)} of ${bytes(f.memory.totalBytes)}`, f.memory.usedPct)}
    ${tile('Root disk', pct(rootDisk?.usedPct), rootDisk ? `${bytes(rootDisk.usedBytes)} of ${bytes(rootDisk.sizeBytes)} · ${bytes(rootDisk.availableBytes)} free` : '—', rootDisk?.usedPct)}
    ${tile('Public IP', val(f.network.publicIp), `gateway ${val(f.network.gateway?.via)}`)}
    ${tile('Processes', val(f.processes.total), `${f.services.running.length} running services`)}
  </div>`));

  /* identity + cpu */
  out.push(section('System', `<div class="two-col">
    ${kvCard('Host', [
      ['Hostname', val(f.identity.hostname)],
      ['FQDN', val(f.identity.fqdn)],
      ['Machine ID', `<code>${val(f.identity.machineId)}</code>`],
      ['Distribution', `${val(f.os.name)} ${val(f.os.version)}`],
      ['Kernel', val(f.identity.kernel)],
      ['Architecture', val(f.identity.arch)],
      ['Virtualization', val(f.identity.virtualization)],
      ['Init system', val(f.identity.init)],
      ['Timezone', val(f.identity.timezone)],
      ['Local time', val(f.identity.localTime)],
      ['Booted at', val(f.identity.bootTime)],
      ['Probe ran as', `${val(f.meta.runAs)} ${f.meta.sudoAvailable ? '<span class="badge ok">sudo</span>' : '<span class="badge">no sudo</span>'}`],
    ])}
    ${kvCard('CPU', [
      ['Model', val(f.cpu.model)],
      ['Vendor', val(f.cpu.vendor)],
      ['vCPUs', val(f.cpu.cores)],
      ['Sockets', val(f.cpu.sockets)],
      ['Cores per socket', val(f.cpu.coresPerSocket)],
      ['Threads per core', val(f.cpu.threadsPerCore)],
      ['Clock', f.cpu.mhz ? `${Math.round(f.cpu.mhz)} MHz` : '—'],
      ['L3 cache', val(f.cpu.cacheL3)],
      ['Hypervisor', val(f.cpu.hypervisor)],
      ['Virtualization type', val(f.cpu.virtType)],
    ])}
  </div>`));

  /* memory */
  out.push(section('Memory', `<div class="two-col">
    ${kvCard('RAM', [
      ['Total', bytes(f.memory.totalBytes)],
      ['Used', `${bytes(f.memory.usedBytes)} (${pct(f.memory.usedPct)})`],
      ['Available', bytes(f.memory.availableBytes)],
      ['Free', bytes(f.memory.freeBytes)],
      ['Buffers', bytes(f.memory.buffersBytes)],
      ['Cached', bytes(f.memory.cachedBytes)],
    ])}
    ${kvCard('Swap', [
      ['Total', bytes(f.memory.swapTotalBytes)],
      ['Free', bytes(f.memory.swapFreeBytes)],
      ['Used', pct(f.memory.swapUsedPct)],
    ])}
  </div>`));

  return out.join('');
}

/** A mount as Windows would name a drive: "System (/)", "boot (/boot)". */
const driveName = (mount) => (mount === '/' ? 'System' : String(mount).split('/').filter(Boolean).pop() || mount);
const usageTone = (p) => (p >= 90 ? 'err' : p >= 75 ? 'warn' : '');

/** Storage tab, top: every filesystem as a drive card, like "This PC". */
function factsStorage(f) {
  const disks = f.disks || [];
  if (!disks.length) return section('Devices and drives', '<div class="card"><p class="muted small" style="margin:0">No filesystems reported</p></div>');
  return `<div class="section">
    <div class="section-head"><h2>Devices and drives</h2><span class="muted small">${disks.length} drive${disks.length === 1 ? '' : 's'} · click one to open it below</span></div>
    <div class="drive-grid">${disks.map((d) => `
      <button type="button" class="drive" data-drive-go="${esc(d.mount)}" title="Open ${esc(d.mount)} in the file explorer">
        ${FX_ICONS.drive(d.mount === '/')}
        <span class="drive-info">
          <b>${esc(driveName(d.mount))} <span class="muted">(${esc(d.mount)})</span></b>
          <span class="drive-bar"><span class="${usageTone(d.usedPct)}" style="width:${Math.min(100, Number(d.usedPct) || 0)}%"></span></span>
          <small>${bytes(d.availableBytes)} free of ${bytes(d.sizeBytes)} · ${pct(d.usedPct)} used</small>
          <small class="muted">${val(d.type)} · ${val(d.filesystem)}</small>
        </span>
      </button>`).join('')}
    </div>
  </div>`;
}

/** Storage tab, bottom: the raw device and inode tables, folded away. */
function factsStorageMore(f) {
  const out = [];

  if ((f.blockDevices || []).length) {
    out.push(section('Block devices', table(
      [{ label: 'Device' }, { label: 'Type' }, { label: 'Size', num: true }, { label: 'FS' }, { label: 'Mount' }, { label: 'Model' }],
      f.blockDevices.map((d) => [val(d.name), val(d.type), bytes(d.sizeBytes), val(d.fstype), val(d.mount), val(d.model)])
    )));
  }

  if ((f.inodes || []).length) {
    out.push(section('Inodes', table(
      [{ label: 'Mount' }, { label: 'Filesystem' }, { label: 'Inodes', num: true }, { label: 'Used', num: true }, { label: 'Free', num: true }, { label: 'Use%', num: true }],
      f.inodes.map((d) => [
        `<b>${val(d.mount)}</b>`, val(d.filesystem), Number(d.inodes || 0).toLocaleString(),
        Number(d.used || 0).toLocaleString(), Number(d.free || 0).toLocaleString(),
        `<span class="badge ${d.usedPct >= 90 ? 'err' : d.usedPct >= 75 ? 'warn' : 'ok'}">${pct(d.usedPct)}</span>`,
      ])
    )));
  }

  return out.length
    ? `<details class="fx-details"><summary>Technical details <span class="muted small">block devices and inodes</span></summary>${out.join('')}</details>`
    : '';
}

/* ------------------------------------------ Storage tab: file manager */

/** Where people usually need to go on a server. */
const FILE_JUMPS = [
  ['/', '/'], ['/home', 'Home'], ['/etc', '/etc'], ['/var/log', 'Logs'], ['/etc/nginx', 'nginx'],
  ['/opt/auto-deploy/apps', 'App folders'], ['/var/lib/docker/volumes', 'Docker volumes'], ['/tmp', '/tmp'],
];

let filesPath = '/';
let filesData = null;
let filesBack = [];      // folders behind you, for the Back button
let filesForward = [];   // folders ahead of you after going Back
let filesSelected = null;
let filesFilter = '';
let filesSort = { key: 'name', dir: 1 };
let filesView = 'details';
try { filesView = localStorage.getItem('ad-files-view') === 'icons' ? 'icons' : 'details'; } catch { /* storage blocked */ }
const filesApi = (path, options) => api(`/servers/${currentServerId}${path}`, options);
const joinPath = (dir, name) => (dir === '/' ? `/${name}` : `${dir}/${name}`);
const parentPath = (p) => (p === '/' ? null : p.split('/').slice(0, -1).join('/') || '/');
const downloadUrl = (path) => `/api/servers/${currentServerId}/files/download?path=${encodeURIComponent(path)}`;

/* icons: Windows-style folders, pages and drives, drawn inline so they suit both themes */

const FILE_KINDS = [
  [/\.(zip|tar|gz|tgz|bz2|xz|7z|rar|zst)$/i, 'archive', '#d97706'],
  [/\.(png|jpe?g|gif|svg|webp|ico|bmp)$/i, 'image', '#16a34a'],
  [/\.(pem|key|crt|cer|pub|p12|pfx)$|^id_(rsa|ed25519|ecdsa)/i, 'key', '#dc2626'],
  [/\.(js|mjs|cjs|ts|jsx|tsx|json|ya?ml|conf|cnf|env|sh|bash|py|php|ini|toml|xml|html?|css|scss|sql|go|rs|java|rb|c|cpp|h|service|socket|timer)$|^\.env|^Dockerfile$|^Makefile$/i, 'code', '#2563eb'],
  [/\.(log|txt|md|csv|out|err)$/i, 'text', '#64748b'],
];
const fileKind = (e) => {
  if (e.type === 'dir') return { kind: 'dir' };
  if (e.type === 'link') return { kind: 'link', color: '#0891b2' };
  const hit = FILE_KINDS.find(([re]) => re.test(e.name));
  return hit ? { kind: hit[1], color: hit[2] } : { kind: 'file', color: '#475569' };
};
const fileExt = (name) => { const m = /\.([a-z0-9]{1,5})$/i.exec(name); return m ? m[1].toUpperCase() : ''; };

const FX_ICONS = {
  folder: () => `<svg class="fx-svg" viewBox="0 0 48 48" aria-hidden="true">
    <path d="M5 11.5A3.5 3.5 0 0 1 8.5 8h10.1c.9 0 1.8.4 2.5 1l3.3 3H39.5a3.5 3.5 0 0 1 3.5 3.5V19H5z" fill="#e0a526"/>
    <path d="M5 17.5A3.5 3.5 0 0 1 8.5 14h31a3.5 3.5 0 0 1 3.5 3.5v19a3.5 3.5 0 0 1-3.5 3.5h-31A3.5 3.5 0 0 1 5 36.5z" fill="#fbc94a"/>
    <path d="M5 18h38" stroke="#fde38e" stroke-width="1.4"/></svg>`,
  page: (color, label = '', link = false) => `<svg class="fx-svg" viewBox="0 0 48 48" aria-hidden="true">
    <path d="M11 5.5A2.5 2.5 0 0 1 13.5 3H29l11 11v28.5a2.5 2.5 0 0 1-2.5 2.5h-24A2.5 2.5 0 0 1 11 42.5z" fill="#fdfdfe" stroke="#b9c2d0" stroke-width="1.2"/>
    <path d="M29 3v8.5a2.5 2.5 0 0 0 2.5 2.5H40" fill="#e7ebf1" stroke="#b9c2d0" stroke-width="1.2" stroke-linejoin="round"/>
    ${label ? `<rect x="7" y="27" width="${Math.max(18, label.length * 6.4 + 8)}" height="11" rx="2" fill="${color}"/>
    <text x="${7 + Math.max(18, label.length * 6.4 + 8) / 2}" y="35.2" text-anchor="middle" font-family="Segoe UI,system-ui,sans-serif" font-size="7.6" font-weight="700" fill="#fff">${esc(label)}</text>`
    : `<path d="M16 21h16M16 26h16M16 31h11" stroke="${color}" stroke-width="2" stroke-linecap="round"/>`}
    ${link ? '<rect x="7" y="33" width="12" height="12" rx="2" fill="#fff" stroke="#b9c2d0"/><path d="M10 42l6-6m0 0h-4.5m4.5 0v4.5" stroke="#0891b2" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' : ''}</svg>`,
  drive: (system) => `<svg class="fx-svg" viewBox="0 0 48 48" aria-hidden="true">
    <rect x="4" y="15" width="40" height="20" rx="4" fill="#d5dbe5"/>
    <rect x="4" y="25" width="40" height="10" rx="3.5" fill="#9ba6b9"/>
    <rect x="9" y="29" width="15" height="2.2" rx="1.1" fill="#667389"/>
    <circle cx="37.5" cy="30" r="2.1" fill="#3ddc97"/>
    ${system ? '<rect x="6" y="7" width="12" height="12" rx="2.5" fill="#2563eb"/><path d="M8.5 9.5h3v3h-3zM12.5 9.5h3v3h-3zM8.5 13.5h3v3h-3zM12.5 13.5h3v3h-3z" fill="#fff"/>' : ''}</svg>`,
};
function entryIcon(e) {
  const k = fileKind(e);
  if (k.kind === 'dir') return FX_ICONS.folder();
  return FX_ICONS.page(k.color, k.kind === 'text' || k.kind === 'file' ? '' : fileExt(e.name).slice(0, 4), k.kind === 'link');
}
const entryType = (e) => (e.type === 'dir' ? 'File folder' : e.type === 'link' ? 'Shortcut' : e.archive ? `${fileExt(e.name) || 'Archive'} archive` : fileExt(e.name) ? `${fileExt(e.name)} file` : 'File');
const isPseudo = (e) => /^\/(proc|sys|dev)(\/|$)/.test(e.path);

/* small line icons for the command bar and menus */
const UI_ICON = {
  back: '<path d="M15 6l-6 6 6 6"/>', forward: '<path d="M9 6l6 6-6 6"/>', up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>', newFolder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 10v6M9 13h6"/>',
  newFile: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M12 11v6M9 14h6"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>', download: '<path d="M12 4v12M7 11l5 5 5-5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  details: '<path d="M4 6h16M4 12h16M4 18h16"/>', icons: '<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4-4"/>', more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  open: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', edit: '<path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"/>',
  extract: '<path d="M4 7h16v13H4zM4 7l2-3h12l2 3M12 11v6M9 14l3 3 3-3"/>', rename: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  perms: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
};
const ui = (name) => `<svg class="fx-ui" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${UI_ICON[name]}</svg>`;

/* loading */

async function loadFileBrowser(path = filesPath, { history = true } = {}) {
  const box = $('#files-panel');
  if (!box) return;
  const from = filesPath;
  if (history && filesData && path !== from) { filesBack.push(from); filesForward = []; }
  filesPath = path;
  filesSelected = null;
  closeFxMenu();
  const loading = `<div class="fx-empty"><span class="spinner"></span>Reading ${esc(path)} and measuring folder sizes (up to 20 seconds)…</div>`;
  // Keep the explorer in place while the next folder loads, like Explorer does.
  if ($('#files-table')) {
    $('#files-table').innerHTML = loading;
    $$('#fx-path .fx-crumbs').forEach((c) => { c.innerHTML = `<span class="fx-crumb">${esc(path)}</span>`; });
  } else {
    box.innerHTML = `<div class="section-head"><h2>File explorer</h2></div><div class="fx">${loading}</div>`;
  }
  try {
    filesData = await filesApi(`/files?path=${encodeURIComponent(path)}`);
    filesPath = filesData.path;
    renderFileBrowser();
  } catch (err) {
    const up = parentPath(path);
    box.innerHTML = `<div class="section-head"><h2>File explorer</h2></div>
      <div class="msg err">${esc(err.message)}</div>
      <p><button class="btn tiny" data-files-go="/">Go to /</button> ${up ? `<button class="btn tiny" data-files-go="${esc(up)}">Up one level</button>` : ''}</p>`;
  }
}

/** Folders first, then the chosen column; the index into filesData.entries rides along. */
function sortedEntries() {
  const { key, dir } = filesSort;
  const value = (e) => (key === 'size' ? Number(e.size || 0) : key === 'modified' ? (e.modified ? Date.parse(e.modified) : 0)
    : key === 'type' ? entryType(e).toLowerCase() : e.name.toLowerCase());
  return filesData.entries.map((e, i) => ({ e, i })).sort((a, b) => {
    const fa = a.e.type === 'dir' ? 0 : 1;
    const fb = b.e.type === 'dir' ? 0 : 1;
    if (fa !== fb) return fa - fb;
    const va = value(a.e);
    const vb = value(b.e);
    return (va < vb ? -1 : va > vb ? 1 : a.e.name.localeCompare(b.e.name)) * dir;
  });
}

const matchesFilter = (e) => !filesFilter || e.name.toLowerCase().includes(filesFilter);

function renderFileBrowser() {
  const d = filesData;
  const folders = d.entries.filter((e) => e.type === 'dir').length;
  const fsys = d.filesystem;
  const segments = d.path.split('/').filter(Boolean);
  const here = segments[segments.length - 1] || '/';
  const drives = (currentServer?.facts?.disks || []);
  const fsPct = fsys && fsys.size ? Math.round((fsys.used / fsys.size) * 100) : null;
  const cmd = (act, icon, label, extra = '') => `<button type="button" class="fx-cmd" data-files-act="${act}" ${extra}>${ui(icon)}<span>${label}</span></button>`;

  $('#files-panel').innerHTML = `
    <div class="section-head"><h2>File explorer</h2></div>
    <div class="fx" id="fx">
      <div class="fx-command">
        ${ifCan('create', cmd('new-folder', 'newFolder', 'New folder'))}
        ${ifCan('create', cmd('new-file', 'newFile', 'New file'))}
        ${ifCan('create', cmd('upload', 'upload', 'Upload'))}
        ${canDo('create') && canDo('edit') ? '<span class="fx-sep"></span>' : ''}
        ${ifCan('edit', `<a class="fx-cmd" href="${downloadUrl(d.path)}" download>${ui('download')}<span>Download folder</span></a>`)}
        <div class="fx-view" role="group" aria-label="View">
          <button type="button" data-fx-view="details" class="${filesView === 'details' ? 'active' : ''}" title="Details">${ui('details')}<span>Details</span></button>
          <button type="button" data-fx-view="icons" class="${filesView === 'icons' ? 'active' : ''}" title="Large icons">${ui('icons')}<span>Large icons</span></button>
        </div>
      </div>

      <div class="fx-address">
        <button type="button" class="fx-navbtn" data-fx-nav="back" title="Back" ${filesBack.length ? '' : 'disabled'}>${ui('back')}</button>
        <button type="button" class="fx-navbtn" data-fx-nav="forward" title="Forward" ${filesForward.length ? '' : 'disabled'}>${ui('forward')}</button>
        <button type="button" class="fx-navbtn" data-fx-nav="up" title="Up to ${esc(d.parent ?? '/')}" ${d.parent === null ? 'disabled' : ''}>${ui('up')}</button>
        <div class="fx-path" id="fx-path" title="Click to type a path">
          <span class="fx-path-ico">${FX_ICONS.folder()}</span>
          <span class="fx-crumbs">
            <button type="button" class="fx-crumb" data-files-go="/">This server</button>
            ${segments.map((s, i) => `<span class="fx-chev">›</span><button type="button" class="fx-crumb" data-files-go="/${esc(segments.slice(0, i + 1).join('/'))}">${esc(s)}</button>`).join('')}
          </span>
          <form id="files-goto" hidden><input name="path" value="${esc(d.path)}" aria-label="Path" autocomplete="off" spellcheck="false" /></form>
        </div>
        <button type="button" class="fx-navbtn" data-files-go="${esc(d.path)}" title="Refresh">${ui('refresh')}</button>
        <label class="fx-search">${ui('search')}<input type="search" id="files-filter" placeholder="Search ${esc(here)}" value="${esc(filesFilter)}" /></label>
      </div>

      <div class="fx-body">
        <nav class="fx-nav" aria-label="Places">
          <div class="fx-nav-title">Quick access</div>
          ${FILE_JUMPS.filter(([p]) => p !== '/').map(([p, label]) => `<button type="button" class="fx-nav-item ${p === d.path ? 'active' : ''}" data-files-go="${esc(p)}" title="${esc(p)}">${FX_ICONS.folder()}<span>${esc(label)}</span></button>`).join('')}
          <div class="fx-nav-title">This server</div>
          ${(drives.length ? drives : [{ mount: '/' }]).map((dv) => `<button type="button" class="fx-nav-item ${dv.mount === d.path ? 'active' : ''}" data-files-go="${esc(dv.mount)}" title="${esc(dv.mount)}">${FX_ICONS.drive(dv.mount === '/')}<span>${esc(driveName(dv.mount))} <span class="muted">(${esc(dv.mount)})</span></span></button>`).join('')}
        </nav>
        <div class="fx-main" id="files-table" tabindex="0" aria-label="Contents of ${esc(d.path)}">${fileItemsHtml()}</div>
      </div>

      <div class="fx-status">
        <span>${d.entries.length} item${d.entries.length === 1 ? '' : 's'} · ${folders} folder${folders === 1 ? '' : 's'}${d.total !== null ? ` · ${bytes(d.total)}` : ''}</span>
        <span id="fx-selected"></span>
        ${d.sizesComplete ? '' : '<span class="badge warn">some folder sizes timed out</span>'}
        ${fsys ? `<span class="fx-fs" title="Filesystem ${esc(fsys.mount)}"><span>${esc(driveName(fsys.mount))} (${esc(fsys.mount)})</span>
          <span class="drive-bar"><span class="${usageTone(fsPct)}" style="width:${fsPct ?? 0}%"></span></span>
          <span>${bytes(fsys.available)} free of ${bytes(fsys.size)}</span></span>` : ''}
      </div>
      <div class="fx-menu" id="fx-menu" role="menu" hidden></div>
    </div>`;
  updateFxSelection();
}

/** The folder's contents, as a details table or as large icons. */
function fileItemsHtml() {
  const d = filesData;
  const items = sortedEntries();
  if (!items.length) return '<div class="fx-empty">This folder is empty.</div>';
  const biggest = Math.max(1, ...d.entries.map((e) => Number(e.size || 0)));
  const when = (e) => (e.modified ? esc(new Date(e.modified).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })) : '—');

  if (filesView === 'icons') {
    return `<div class="fx-grid">${items.map(({ e, i }) => `
      <div class="fx-tile" data-file-row="${i}" ${matchesFilter(e) ? '' : 'hidden'} title="${esc(e.name)}${e.target ? ` → ${esc(e.target)}` : ''}">
        ${entryIcon(e)}
        <span class="fx-label">${esc(e.name)}</span>
        <small>${e.type === 'dir' ? (e.size !== null ? bytes(e.size) : 'Folder') : e.size !== null ? bytes(e.size) : ''}</small>
      </div>`).join('')}</div>`;
  }

  const head = (key, label, cls = '') => `<th class="${cls}" data-fx-sort="${key}">${label}${filesSort.key === key ? `<span class="fx-sort">${filesSort.dir > 0 ? '▲' : '▼'}</span>` : ''}</th>`;
  return `<table class="fx-table">
    <thead><tr>${head('name', 'Name')}${head('modified', 'Date modified')}${head('type', 'Type')}${head('size', 'Size', 'num')}<th>Permissions</th><th aria-label="Actions"></th></tr></thead>
    <tbody>${items.map(({ e, i }) => `
      <tr data-file-row="${i}" ${matchesFilter(e) ? '' : 'hidden'}>
        <td><div class="fx-name">${entryIcon(e)}<span class="fx-label">${esc(e.name)}</span>
          ${e.target ? `<span class="fx-target">→ ${esc(e.target)}</span>` : ''}${e.protected ? '<span class="badge">system</span>' : ''}</div></td>
        <td>${when(e)}</td>
        <td>${esc(entryType(e))}</td>
        <td class="num">${e.size === null ? '<span class="muted">—</span>' : bytes(e.size)}
          ${e.size ? `<div class="size-bar"><span style="width:${Math.max(2, Math.round((e.size / biggest) * 100))}%"></span></div>` : ''}</td>
        <td class="fx-perm"><code>${esc(e.mode)}</code> ${esc(e.owner)}:${esc(e.group)}</td>
        <td><button type="button" class="fx-more" data-fx-menu="${i}" aria-label="Actions for ${esc(e.name)}" title="More actions">${ui('more')}</button></td>
      </tr>`).join('')}</tbody>
  </table>`;
}

/* selection, menus, keyboard */

function updateFxSelection() {
  $$('#files-table [data-file-row]').forEach((el) => el.classList.toggle('selected', Number(el.dataset.fileRow) === filesSelected));
  const e = filesSelected !== null ? filesData?.entries[filesSelected] : null;
  const out = $('#fx-selected');
  if (out) out.textContent = e ? `1 item selected${e.size !== null ? ` · ${bytes(e.size)}` : ''}` : '';
}

function openFxEntry(i) {
  const e = filesData.entries[i];
  if (!e) return;
  if (e.type === 'dir') loadFileBrowser(e.path);
  else openFileEditor(e.path);
}

function closeFxMenu() {
  const m = $('#fx-menu');
  if (m) m.hidden = true;
}

/** The right-click menu: for one item, or for the folder itself. */
function openFxMenu(i, x, y) {
  const m = $('#fx-menu');
  const fx = $('#fx');
  if (!m || !fx) return;
  const item = (attrs, icon, label, cls = '') => `<button type="button" class="fx-menu-item ${cls}" role="menuitem" ${attrs}>${ui(icon)}<span>${label}</span></button>`;
  const sep = '<hr class="fx-menu-sep" />';
  let html;
  if (i === null) {
    html = [
      ifCan('create', item('data-files-act="new-folder"', 'newFolder', 'New folder')),
      ifCan('create', item('data-files-act="new-file"', 'newFile', 'New file')),
      ifCan('create', item('data-files-act="upload"', 'upload', 'Upload files')),
      item(`data-files-go="${esc(filesPath)}"`, 'refresh', 'Refresh'),
    ].join('');
  } else {
    const e = filesData.entries[i];
    const pseudo = isPseudo(e);
    html = [
      e.type === 'dir' ? item(`data-files-go="${esc(e.path)}"`, 'open', '<b>Open</b>')
        : item(`data-files-open="${i}"`, 'edit', `<b>${canDo('edit') && e.type === 'file' ? 'Edit' : 'Open'}</b>`),
      e.type !== 'link' && !pseudo ? ifCan('edit', `<a class="fx-menu-item" role="menuitem" href="${downloadUrl(e.path)}" download>${ui('download')}<span>Download</span></a>`) : '',
      e.archive ? ifCan('create', item(`data-files-act="extract" data-i="${i}"`, 'extract', 'Extract here')) : '',
      sep,
      e.protected ? '' : ifCan('edit', item(`data-files-act="move" data-i="${i}"`, 'rename', 'Rename / move')),
      pseudo ? '' : ifCan('create', item(`data-files-act="copy" data-i="${i}"`, 'copy', 'Copy')),
      pseudo ? '' : ifCan('edit', item(`data-files-act="perms" data-i="${i}"`, 'perms', 'Permissions')),
      e.protected ? '' : ifCan('delete', `${sep}${item(`data-files-act="delete" data-i="${i}"`, 'trash', 'Delete', 'danger')}`),
    ].join('').replace(new RegExp(`(${sep})+$`), '').replace(new RegExp(`(${sep}){2,}`, 'g'), sep);
  }
  m.innerHTML = html;
  m.hidden = false;
  // Keep the menu inside the explorer.
  const box = fx.getBoundingClientRect();
  const left = Math.min(x - box.left, box.width - m.offsetWidth - 8);
  const top = Math.min(y - box.top, box.height - m.offsetHeight - 8);
  m.style.left = `${Math.max(8, left)}px`;
  m.style.top = `${Math.max(8, top)}px`;
}

function showPathInput(show) {
  const form = $('#files-goto');
  if (!form) return;
  form.hidden = !show;
  $('#fx-path .fx-crumbs').hidden = show;
  if (show) { const input = form.querySelector('input'); input.focus(); input.select(); }
}

const coarsePointer = () => window.matchMedia && matchMedia('(pointer: coarse)').matches;

$('#detail-body').addEventListener('click', (ev) => {
  if (!ev.target.closest('#files-panel')) {
    const drive = ev.target.closest('[data-drive-go]');
    if (drive) {
      loadFileBrowser(drive.dataset.driveGo);
      $('#files-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    return;
  }
  const menuItem = ev.target.closest('.fx-menu-item');
  if (menuItem) { setTimeout(closeFxMenu); return; }
  if (!ev.target.closest('#fx-menu')) closeFxMenu();

  const nav = ev.target.closest('[data-fx-nav]');
  if (nav) {
    if (nav.dataset.fxNav === 'up' && filesData?.parent !== null) return loadFileBrowser(filesData.parent);
    if (nav.dataset.fxNav === 'back' && filesBack.length) { filesForward.push(filesPath); return loadFileBrowser(filesBack.pop(), { history: false }); }
    if (nav.dataset.fxNav === 'forward' && filesForward.length) { filesBack.push(filesPath); return loadFileBrowser(filesForward.pop(), { history: false }); }
    return;
  }
  const view = ev.target.closest('[data-fx-view]');
  if (view) {
    filesView = view.dataset.fxView;
    try { localStorage.setItem('ad-files-view', filesView); } catch { /* storage blocked */ }
    $$('[data-fx-view]').forEach((b) => b.classList.toggle('active', b === view));
    $('#files-table').innerHTML = fileItemsHtml();
    return updateFxSelection();
  }
  const sort = ev.target.closest('[data-fx-sort]');
  if (sort) {
    const key = sort.dataset.fxSort;
    filesSort = { key, dir: filesSort.key === key ? -filesSort.dir : (key === 'name' || key === 'type' ? 1 : -1) };
    $('#files-table').innerHTML = fileItemsHtml();
    return updateFxSelection();
  }
  const more = ev.target.closest('[data-fx-menu]');
  if (more) {
    ev.stopPropagation();
    filesSelected = Number(more.dataset.fxMenu);
    updateFxSelection();
    const r = more.getBoundingClientRect();
    return openFxMenu(filesSelected, r.right - 200, r.bottom + 4);
  }
  // Clicking the address bar (not a crumb) turns it into a text box.
  if (ev.target.closest('#fx-path') && !ev.target.closest('[data-files-go]') && !ev.target.closest('#files-goto')) return showPathInput(true);

  const row = ev.target.closest('[data-file-row]');
  if (row) {
    filesSelected = Number(row.dataset.fileRow);
    updateFxSelection();
    // Touch has no double-click: one tap opens.
    if (coarsePointer()) openFxEntry(filesSelected);
    return;
  }
  if (ev.target.closest('#files-table')) { filesSelected = null; updateFxSelection(); }
});

$('#detail-body').addEventListener('dblclick', (ev) => {
  const row = ev.target.closest('#files-panel [data-file-row]');
  if (row) openFxEntry(Number(row.dataset.fileRow));
});

$('#detail-body').addEventListener('contextmenu', (ev) => {
  if (!ev.target.closest('#files-table')) return;
  ev.preventDefault();
  const row = ev.target.closest('[data-file-row]');
  filesSelected = row ? Number(row.dataset.fileRow) : null;
  updateFxSelection();
  openFxMenu(filesSelected, ev.clientX, ev.clientY);
});

$('#detail-body').addEventListener('keydown', (ev) => {
  if (ev.target.closest('#files-goto') && ev.key === 'Escape') return showPathInput(false);
  if (ev.target.id !== 'files-table' || !filesData) return;
  if (ev.key === 'Escape') return closeFxMenu();
  const visible = $$('#files-table [data-file-row]:not([hidden])').map((el) => Number(el.dataset.fileRow));
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp' || ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
    if (!visible.length) return;
    ev.preventDefault();
    const at = visible.indexOf(filesSelected);
    const step = ev.key === 'ArrowDown' || ev.key === 'ArrowRight' ? 1 : -1;
    filesSelected = visible[at === -1 ? 0 : Math.min(visible.length - 1, Math.max(0, at + step))];
    updateFxSelection();
    $(`#files-table [data-file-row="${filesSelected}"]`)?.scrollIntoView({ block: 'nearest' });
  } else if (ev.key === 'Enter' && filesSelected !== null) {
    openFxEntry(filesSelected);
  } else if (ev.key === 'Backspace' && filesData.parent !== null) {
    ev.preventDefault();
    loadFileBrowser(filesData.parent);
  } else if (ev.key === 'Delete' && filesSelected !== null && canDo('delete') && !filesData.entries[filesSelected].protected) {
    fileAction('delete', filesData.entries[filesSelected]).catch((err) => toast(err.message, 'err'));
  }
});

$('#detail-body').addEventListener('focusout', (ev) => {
  if (ev.target.closest?.('#files-goto') && !ev.relatedTarget?.closest?.('#files-goto')) setTimeout(() => showPathInput(false), 120);
});
document.addEventListener('click', (ev) => { if (!ev.target.closest('#fx')) closeFxMenu(); });

/* file editor */

let editingFile = null;

async function openFileEditor(path) {
  const modal = $('#modal-file-edit');
  editingFile = path;
  $('#file-edit-title').textContent = path;
  $('#file-edit-meta').textContent = 'Opening…';
  $('#file-edit-msg').classList.add('hidden');
  $('#file-edit-text').value = '';
  $('#file-edit-text').disabled = true;
  $('#file-edit-save').disabled = true;
  $('#file-edit-download').href = downloadUrl(path);
  modal.classList.remove('hidden');
  try {
    const f = await filesApi(`/files/content?path=${encodeURIComponent(path)}`);
    $('#file-edit-meta').textContent = `${bytes(f.size)} · ${f.mode} ${f.owner}:${f.group}`;
    if (!f.editable) {
      formMsg($('#file-edit-msg'), `This file cannot be edited here: ${f.reason}`, 'info');
      return;
    }
    $('#file-edit-text').value = f.content;
    $('#file-edit-text').disabled = !canDo('edit');
    $('#file-edit-save').disabled = !canDo('edit');
    $('#file-edit-text').focus();
  } catch (err) {
    $('#file-edit-meta').textContent = '';
    formMsg($('#file-edit-msg'), err.message, 'err');
  }
}

async function saveEditedFile() {
  const btn = $('#file-edit-save');
  if (btn.disabled || !editingFile) return;
  busy(btn, true, 'Saving…');
  try {
    const r = await filesApi('/files/content', { method: 'PUT', body: { path: editingFile, content: $('#file-edit-text').value } });
    formMsg($('#file-edit-msg'), `Saved ${r.path} (${bytes(r.size)})`, 'ok');
    toast(`Saved ${r.path}`);
    loadFileBrowser(filesPath);
  } catch (err) {
    formMsg($('#file-edit-msg'), err.message, 'err');
  }
  busy(btn, false);
}

$('#file-edit-save').addEventListener('click', saveEditedFile);
$('#file-edit-text').addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveEditedFile(); }
  // Tab indents instead of leaving the editor.
  if (e.key === 'Tab' && !e.shiftKey) {
    e.preventDefault();
    const t = e.target;
    const at = t.selectionStart;
    t.setRangeText('  ', at, t.selectionEnd, 'end');
  }
});

/* uploads */

const readAsBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] || '');
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

$('#files-upload-input').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  const dir = filesPath;
  for (const file of files) {
    if (file.size > 50 * 1024 * 1024) { toast(`${file.name} is over 50 MB — copy it with scp instead`, 'err'); continue; }
    toast(`Uploading ${file.name} (${bytes(file.size)})…`);
    try {
      const data = await readAsBase64(file);
      const send = (overwrite) => filesApi('/files/upload', { method: 'POST', body: { dir, name: file.name, data, overwrite } });
      try {
        await send(false);
      } catch (err) {
        if (!/already exists/.test(err.message) || !confirm(`${joinPath(dir, file.name)} already exists. Replace it?`)) throw err;
        await send(true);
      }
      toast(`Uploaded ${file.name} to ${dir}`);
    } catch (err) {
      toast(`${file.name}: ${err.message}`, 'err');
    }
  }
  if (files.length && filesPath === dir) loadFileBrowser(dir);
});

/* actions */

async function fileAction(act, e) {
  const dir = filesPath;
  const reload = () => loadFileBrowser(dir);

  if (act === 'upload') return $('#files-upload-input').click();

  if (act === 'new-folder' || act === 'new-file') {
    const folder = act === 'new-folder';
    return openMyDialog({
      title: folder ? 'New folder' : 'New file',
      intro: `In <code>${esc(dir)}</code>`,
      fields: `<label>Name<input name="name" required autocomplete="off" placeholder="${folder ? 'backups' : 'notes.txt'}" /></label>`,
      submitLabel: 'Create',
      async submit(fd) {
        const r = await filesApi(folder ? '/files/folder' : '/files/file', { method: 'POST', body: { dir, name: fd.get('name') } });
        if (!folder) setTimeout(() => openFileEditor(r.path), 300);
        return `Created ${r.path}`;
      },
      after: reload,
    });
  }

  if (act === 'move') {
    return openMyDialog({
      title: `Rename or move ${e.name}`,
      intro: 'Change the name, or the whole path to move it somewhere else. Nothing that already exists is overwritten.',
      fields: `<label>New path<input name="to" value="${esc(e.path)}" required autocomplete="off" /></label>`,
      submitLabel: 'Move',
      async submit(fd) {
        const r = await filesApi('/files/move', { method: 'PUT', body: { from: e.path, to: fd.get('to').trim() } });
        return `Moved to ${r.to}`;
      },
      after: reload,
    });
  }

  if (act === 'copy') {
    const dot = e.type === 'file' ? e.name.lastIndexOf('.') : -1;
    const copyName = dot > 0 ? `${e.name.slice(0, dot)}-copy${e.name.slice(dot)}` : `${e.name}-copy`;
    return openMyDialog({
      title: `Copy ${e.name}`,
      intro: 'Permissions, owners and times are kept. Folders are copied with everything in them.',
      fields: `<label>Copy to<input name="to" value="${esc(joinPath(dir, copyName))}" required autocomplete="off" /></label>`,
      submitLabel: 'Copy',
      async submit(fd) {
        const r = await filesApi('/files/copy', { method: 'POST', body: { from: e.path, to: fd.get('to').trim() } });
        return `Copied to ${r.to}`;
      },
      after: reload,
    });
  }

  if (act === 'perms') {
    return openMyDialog({
      title: `Permissions of ${e.name}`,
      intro: `Now <code>${esc(e.mode)}</code>, owned by <b>${esc(e.owner)}:${esc(e.group)}</b>. 644 = files, 755 = folders and scripts, 600 = secrets.`,
      fields: `<div class="row">
          <label class="narrow">Mode<input name="mode" value="${esc(e.mode)}" pattern="[0-7]{3,4}" /></label>
          <label>Owner<input name="owner" value="${esc(e.owner)}" /></label>
          <label>Group<input name="group" value="${esc(e.group)}" /></label>
        </div>
        ${e.type === 'dir' && !e.protected ? '<label class="check" style="margin-top:12px"><input type="checkbox" name="recursive" /> Apply to everything inside too</label>' : ''}`,
      submitLabel: 'Apply',
      async submit(fd) {
        const body = { path: e.path, recursive: fd.get('recursive') === 'on' };
        if (fd.get('mode') !== e.mode || body.recursive) body.mode = fd.get('mode');
        if (fd.get('owner') !== e.owner || fd.get('group') !== e.group || body.recursive) { body.owner = fd.get('owner'); body.group = fd.get('group'); }
        await filesApi('/files/permissions', { method: 'PUT', body });
        return `Updated ${e.name}`;
      },
      after: reload,
    });
  }

  if (act === 'extract') {
    if (!confirm(`Extract ${e.name} into ${dir}? Files with the same names are overwritten.`)) return;
    try {
      toast(`Extracting ${e.name}…`);
      await filesApi('/files/extract', { method: 'POST', body: { path: e.path } });
      toast(`Extracted ${e.name}`);
    } catch (err) { toast(err.message, 'err'); }
    return reload();
  }

  if (act === 'delete') {
    const isDir = e.type === 'dir';
    return openMyDialog({
      title: `Delete ${e.name}?`,
      intro: `<div class="msg err">${esc(e.path)}${isDir ? ` and everything in it${e.size ? ` (${bytes(e.size)})` : ''}` : ''} is deleted for good. There is no undo.</div>`,
      fields: isDir ? `<label>Type <code>${esc(e.name)}</code> to confirm<input name="confirm" autocomplete="off" required /></label>` : '',
      submitLabel: 'Delete',
      danger: true,
      async submit(fd) {
        if (isDir && fd.get('confirm') !== e.name) throw new Error('The name does not match');
        await filesApi('/files', { method: 'DELETE', body: { path: e.path } });
        return `Deleted ${e.path}`;
      },
      after: reload,
    });
  }
}

$('#detail-body').addEventListener('click', async (ev) => {
  if (!ev.target.closest('#files-panel')) return;
  const go = ev.target.closest('[data-files-go]');
  if (go) { ev.preventDefault(); return loadFileBrowser(go.dataset.filesGo); }
  const open = ev.target.closest('[data-files-open]');
  if (open) return openFileEditor(filesData.entries[Number(open.dataset.filesOpen)].path);
  const act = ev.target.closest('[data-files-act]');
  if (act) {
    try {
      await fileAction(act.dataset.filesAct, act.dataset.i !== undefined ? filesData.entries[Number(act.dataset.i)] : null);
    } catch (err) { toast(err.message, 'err'); }
  }
});

$('#detail-body').addEventListener('submit', (ev) => {
  if (ev.target.id !== 'files-goto') return;
  ev.preventDefault();
  loadFileBrowser(new FormData(ev.target).get('path').trim() || '/');
});

$('#detail-body').addEventListener('input', (ev) => {
  if (ev.target.id !== 'files-filter') return;
  filesFilter = ev.target.value.trim().toLowerCase();
  $$('#files-table [data-file-row]').forEach((el) => {
    el.hidden = !matchesFilter(filesData.entries[Number(el.dataset.fileRow)]);
  });
});

function factsNetwork(f) {
  const out = [];

  out.push(section('Network', `
    <div class="two-col">
      ${kvCard('Connectivity', [
        ['Public IP', val(f.network.publicIp)],
        ['Default gateway', f.network.gateway ? `${val(f.network.gateway.via)} via ${val(f.network.gateway.dev)}` : '—'],
        ['DNS servers', (f.network.dns || []).map((d) => `<code>${esc(d)}</code>`).join(' ') || '—'],
      ])}
      ${table(
        [{ label: 'Interface' }, { label: 'Address' }, { label: 'Family' }, { label: 'Scope' }],
        (f.network.interfaces || []).map((i) => [`<b>${val(i.name)}</b>`, `<code>${val(i.cidr)}</code>`, val(i.family), val(i.scope)]),
        'No interfaces reported'
      )}
    </div>
    <div style="margin-top:12px">${table(
      [{ label: 'Port', num: true }, { label: 'Proto' }, { label: 'Listening on' }, { label: 'Process' }, { label: 'PID', num: true }],
      (f.network.listening || []).map((p) => [`<b>${val(p.port)}</b>`, val(p.proto), `<code>${val(p.local)}</code>`, val(p.process), val(p.pid)]),
      'No listening sockets reported (needs root or sudo for process names)'
    )}</div>
  `));

  return out.join('');
}

function factsProcesses(f) {
  const out = [];

  out.push(section('Top processes', `<div class="two-col">
    <div>
      <p class="muted small">By CPU</p>
      ${table(
        [{ label: 'PID', num: true }, { label: 'User' }, { label: 'Command' }, { label: 'CPU%', num: true }, { label: 'RSS', num: true }],
        (f.processes.topCpu || []).map((p) => [val(p.pid), val(p.user), `<code>${val(p.command)}</code>`, val(p.cpuPct), bytes(p.rssBytes)])
      )}
    </div>
    <div>
      <p class="muted small">By memory</p>
      ${table(
        [{ label: 'PID', num: true }, { label: 'User' }, { label: 'Command' }, { label: 'MEM%', num: true }, { label: 'RSS', num: true }],
        (f.processes.topMemory || []).map((p) => [val(p.pid), val(p.user), `<code>${val(p.command)}</code>`, val(p.memPct), bytes(p.rssBytes)])
      )}
    </div>
  </div>`));

  out.push(section('Sessions', table(
    [{ label: 'User' }, { label: 'TTY' }, { label: 'Since' }],
    (f.sessions || []).map((s) => [`<b>${val(s.user)}</b>`, `<code>${val(s.tty)}</code>`, val(s.since)]),
    'Nobody is logged in'
  )));

  out.push(`<p class="muted small">A snapshot from when the profile was collected — use <b>Fetch system details</b> for a fresh one.</p>`);
  return out.join('');
}

function factsSystem(f) {
  const out = [];

  /* mysql on the host */
  const my = f.mysql || {};
  out.push(section('MySQL', my.installed
    ? `<div class="two-col">
        ${kvCard('Engine', [
          ['Server', val(my.serverVersion)],
          ['Client', val(my.clientVersion)],
          ['Service', my.service ? `${esc(my.service)} <span class="badge ${my.running ? 'ok' : 'err'}">${my.running ? 'running' : 'stopped'}</span>` : '<span class="badge err">not running</span>'],
          ['Start on boot', val(my.enabled)],
          ['Port', val(my.port)],
        ])}
        ${kvCard('Storage &amp; binding', [
          ['Bind address', my.bindAddress ? `<code>${esc(my.bindAddress)}</code>` : 'not set in config'],
          ['Reachable', my.localOnly
            ? '<span class="badge warn">localhost only</span> — add a MySQL connection tunnelled through this server'
            : '<span class="badge">accepts remote connections</span>'],
          ['Data directory', `<code>${val(my.datadir)}</code>`],
          ['Data size', bytes(my.datadirBytes)],
          ['Listening', my.listening?.length ? `<code class="small">${esc(my.listening[0])}</code>` : '—'],
        ])}
      </div>`
    : `<div class="card"><p class="muted small" style="margin:0">No MySQL server on this host.${my.clientInstalled ? ' The <code>mysql</code> client is installed, so this machine talks to a database elsewhere.' : ''}</p></div>`));

  /* packages + security */
  const p = f.packages || {};
  const sec = f.security || {};
  out.push(section('Updates &amp; security', `<div class="two-col">
    ${kvCard('Packages', [
      ['Installed (dpkg)', val(p.dpkgInstalled)],
      ['Snaps', val(p.snapInstalled)],
      ['Updates available', p.updatesAvailable ? `<span class="badge warn">${p.updatesAvailable}</span>` : '<span class="badge ok">0</span>'],
      ['Security updates', p.securityUpdates ? `<span class="badge err">${p.securityUpdates}</span>` : '<span class="badge ok">0</span>'],
      ['Reboot required', p.rebootRequired ? `<span class="badge err">yes</span> ${esc(p.rebootPackages.join(', '))}` : '<span class="badge ok">no</span>'],
      ['Unattended upgrades', val(p.unattendedUpgrades)],
    ])}
    ${kvCard('Security', [
      ['Firewall (ufw)', val(sec.firewall)],
      ['fail2ban', val(sec.fail2ban)],
      ['SSH port(s)', sec.sshPort?.length ? sec.sshPort.map((x) => `<code>${esc(x)}</code>`).join(' ') : '<code>22</code> (default)'],
      ['PermitRootLogin', val(sec.permitRootLogin)],
      ['PasswordAuthentication', val(sec.passwordAuth)],
      ['Sudo users', sec.sudoUsers?.length ? sec.sudoUsers.map((u) => `<span class="chip">${esc(u)}</span>`).join(' ') : '—'],
      ['Active sessions', (f.sessions || []).map((s) => `${esc(s.user)}@${esc(s.tty)}`).join(', ') || '—'],
    ])}
  </div>`));

  /* tooling */
  const tools = Object.entries(f.tooling || {}).filter(([k]) => k !== 'docker_compose');
  out.push(section('Installed tooling', tools.length
    ? `<div class="card"><div class="chips">${tools.map(([k, v]) => `<span class="chip"><b>${esc(k)}</b> ${esc(v)}</span>`).join('')}</div></div>`
    : '<div class="card"><p class="muted small" style="margin:0">No known deployment tooling detected.</p></div>'));

  /* nginx + cron */
  if (f.web?.nginxSites?.length || f.cron?.length) {
    out.push(section('Web &amp; scheduled jobs', `<div class="two-col">
      ${f.web.nginxSites.length ? `<div class="card"><h3>nginx sites-enabled</h3><div class="chips" style="margin-top:10px">${f.web.nginxSites.map((s) => `<span class="chip">${esc(s)}</span>`).join('')}</div></div>` : ''}
      ${f.cron.length ? `<div class="card"><h3>crontab</h3><div style="margin-top:10px">${f.cron.map((c) => `<div><code>${esc(c)}</code></div>`).join('')}</div></div>` : ''}
    </div>`));
  }

  out.push(`<p class="muted small">Collected ${esc(f.collectedAt || f.meta.collectedAt)} in ${esc(f.meta.durationMs)}ms.</p>`);
  return out.join('');
}

/* --------------------------------------------- server: systemd services */

let servicesCache = [];
let serviceTotals = null;
const serviceFilter = { text: '', state: 'running' };

const SERVICE_STATES = [
  ['running', 'Running'],
  ['all', 'All services'],
  ['failed', 'Failed'],
  ['stopped', 'Stopped'],
  ['enabled', 'Starts on boot'],
  ['created', 'Created here'],
];

/** Stopping these by accident is how you lock yourself out of a server. */
const RISKY_UNIT = /^(ssh|sshd|systemd-logind|systemd-networkd|networking|network-manager|dbus|cloud-init)/i;

async function loadServerServices() {
  const box = $('#services-panel');
  if (!box) return;
  tabsLoaded.add('services');
  box.innerHTML = '<div class="empty"><span class="spinner"></span>Reading the service list from the server…</div>';
  try {
    const r = await api(`/servers/${currentServerId}/services`);
    servicesCache = r.services;
    serviceTotals = r.totals;
    setTabCount('services', r.totals.running, r.totals.failed ? 'err' : '');
    renderServicesPanel();
  } catch (err) {
    setTabCount('services', '!', 'err');
    box.innerHTML = `
      <div class="section-head">
        <h2>Services</h2>
        <div class="section-tools"><button class="btn tiny" data-svc-reload="1">Try again</button></div>
      </div>
      <div class="msg err">${esc(err.message)}</div>`;
  }
}

function renderServicesPanel() {
  const t = serviceTotals || {};
  $('#services-panel').innerHTML = `
    <div class="section-head">
      <h2>Services <span class="muted small" style="text-transform:none;letter-spacing:0">
        ${val(t.total)} units · ${val(t.running)} running · ${t.failed ? `<span style="color:var(--err)">${t.failed} failed</span>` : '0 failed'} · ${val(t.enabled)} start on boot
      </span></h2>
      <div class="section-tools">
        <input type="search" id="svc-search" placeholder="Filter by name or description…" value="${esc(serviceFilter.text)}" />
        <select id="svc-state">
          ${SERVICE_STATES.map(([v, label]) => `<option value="${v}" ${serviceFilter.state === v ? 'selected' : ''}>${esc(label)}</option>`).join('')}
        </select>
        <button class="btn tiny" data-svc-reload="1">Refresh</button>
        ${ifCan('create', '<button class="btn tiny primary" data-svc-add="1">+ Add service</button>')}
      </div>
    </div>
    <div id="svc-table"></div>`;
  renderServiceRows();
}

/** Only the table is redrawn while filtering, so the search box keeps focus. */
function renderServiceRows() {
  const rows = servicesCache.filter(matchesServiceFilter);
  $('#svc-table').innerHTML = `
    <div class="scroll-table">${table(
      [{ label: 'Unit' }, { label: 'State' }, { label: 'On boot' }, { label: 'Description' }, { label: '' }],
      rows.map((s) => [
        `<button class="link-db" data-svc-action="logs" data-unit="${esc(s.unit)}">${esc(s.unit)}</button>
         ${s.createdHere ? ' <span class="badge ok">created here</span>' : s.managed ? ' <span class="badge">local unit</span>' : ''}`,
        serviceStateBadge(s),
        s.enabled ? `<span class="badge ${s.enabled === 'enabled' ? 'ok' : ''}">${esc(s.enabled)}</span>` : '—',
        `<span class="small">${val(s.description)}</span>`,
        `<div class="row-actions">${serviceActions(s)}</div>`,
      ]),
      servicesCache.length ? 'No service matches this filter' : 'systemd reported no services'
    )}</div>
    <p class="muted small" style="margin-top:8px">Showing ${rows.length} of ${servicesCache.length} units. Click a unit name for its status and journal.</p>`;
}

function serviceStateBadge(s) {
  if (s.active === 'failed') return '<span class="badge err">failed</span>';
  if (s.sub === 'running') return '<span class="badge ok">running</span>';
  if (s.active === 'activating') return '<span class="badge warn">starting</span>';
  return `<span class="badge">${esc(s.sub || s.active || 'inactive')}</span>`;
}

function serviceActions(s) {
  const btn = (action, label, cls = '') =>
    `<button class="btn tiny ${cls}" data-svc-action="${action}" data-unit="${esc(s.unit)}">${label}</button>`;
  const out = [];
  if (s.sub === 'running') {
    out.push(btn('restart', 'Restart'), btn('stop', 'Stop'));
  } else if (s.load !== 'not-found' && s.load !== 'masked') {
    out.push(btn('start', 'Start'));
  }
  if (s.enabled === 'enabled') out.push(btn('disable', 'Disable'));
  else if (s.enabled === 'disabled') out.push(btn('enable', 'Enable'));
  if (s.createdHere) out.push(btn('delete', 'Delete', 'danger'));
  return out.join('');
}

function matchesServiceFilter(s) {
  const text = serviceFilter.text.trim().toLowerCase();
  if (text && !`${s.unit} ${s.description || ''}`.toLowerCase().includes(text)) return false;
  switch (serviceFilter.state) {
    case 'running': return s.sub === 'running';
    case 'failed': return s.active === 'failed';
    case 'stopped': return s.sub !== 'running' && s.active !== 'failed';
    case 'enabled': return s.enabled === 'enabled';
    case 'created': return Boolean(s.createdHere);
    default: return true;
  }
}

/* one delegated listener for the whole server-detail view */

$('#view-server-detail').addEventListener('input', (e) => {
  if (e.target.id !== 'svc-search') return;
  serviceFilter.text = e.target.value;
  renderServiceRows();
});

$('#view-server-detail').addEventListener('change', (e) => {
  if (e.target.id !== 'svc-state') return;
  serviceFilter.state = e.target.value;
  renderServiceRows();
});

$('#view-server-detail').addEventListener('click', async (e) => {
  if (e.target.closest('[data-svc-reload]')) return loadServerServices();
  if (e.target.closest('[data-svc-add]')) return openServiceModal();
  if (e.target.closest('[data-runner-reload]')) return loadServerRunners();

  const svcBtn = e.target.closest('button[data-svc-action]');
  if (svcBtn) return serviceAction(svcBtn);

  const runnerBtn = e.target.closest('button[data-runner-action]');
  if (runnerBtn) return runnerAction(runnerBtn, loadServerRunners);
});

async function serviceAction(btn) {
  const { svcAction: action, unit } = btn.dataset;

  if (action === 'logs') return openServiceDetail(unit);

  if (action === 'delete') {
    if (!confirm(`Delete ${unit}? It is stopped, disabled and its unit file removed from the server.`)) return;
  } else if (RISKY_UNIT.test(unit) && ['stop', 'disable', 'restart'].includes(action)) {
    if (!confirm(`${unit} keeps this server reachable. ${action === 'stop' ? 'Stopping' : action === 'disable' ? 'Disabling' : 'Restarting'} it can cut the panel off from this machine. Continue?`)) return;
  }

  busy(btn, true, '…');
  try {
    if (action === 'delete') {
      await api(`/servers/${currentServerId}/services/${encodeURIComponent(unit)}`, { method: 'DELETE' });
      toast(`${unit} removed`);
    } else {
      const r = await api(`/servers/${currentServerId}/services/${encodeURIComponent(unit)}/action`, {
        method: 'POST',
        body: { action },
      });
      toast(`${unit}: ${action} → ${r.active || 'done'}${r.enabled ? ` (${r.enabled})` : ''}`);
    }
    await loadServerServices();
  } catch (err) {
    // The message already carries the tail of the journal; the full one is a click away.
    toast(err.message, 'err');
    busy(btn, false);
    await loadServerServices();
  }
}

/* --------------------------------------------- server: service detail */

async function openServiceDetail(unit) {
  const modal = $('#modal-service-detail');
  $('#service-detail-name').textContent = unit;
  $('#service-detail-sub').textContent = currentServer ? `on ${currentServer.name} (${currentServer.host})` : '';
  $('#service-detail-body').innerHTML = '<div class="empty"><span class="spinner"></span>Reading the unit and its journal…</div>';
  modal.classList.remove('hidden');
  try {
    const { service: s } = await api(`/servers/${currentServerId}/services/${encodeURIComponent(unit)}`);
    $('#service-detail-sub').textContent = s.description || unit;
    $('#service-detail-body').innerHTML = `
      <div class="tiles" style="margin-bottom:14px">
        ${tile('State', serviceStateBadge({ active: s.active, sub: s.sub }), val(s.load))}
        ${tile('On boot', val(s.enabled), `type ${val(s.type)}`)}
        ${tile('Main PID', val(s.mainPid), s.tasks ? `${s.tasks} tasks` : '')}
        ${tile('Memory', s.memoryBytes ? bytes(s.memoryBytes) : '—', s.restarts ? `${s.restarts} restarts` : `restart ${val(s.restart)}`)}
      </div>
      ${kvCard('Unit', [
        ['Started', val(s.startedAt)],
        ['Command', s.execStart ? `<code class="small">${esc(s.execStart)}</code>` : '—'],
        ['Runs as', `${val(s.user || 'root')}${s.group ? `:${esc(s.group)}` : ''}`],
        ['Working directory', s.workingDirectory ? `<code>${esc(s.workingDirectory)}</code>` : '—'],
        ['Unit file', s.fragmentPath ? `<code class="small">${esc(s.fragmentPath)}</code>` : '—'],
      ])}
      ${s.unitFile ? `<div class="section" style="margin-top:14px"><h2>Unit file</h2><pre class="log">${esc(s.unitFile)}</pre></div>` : ''}
      <div class="section" style="margin-top:14px">
        <h2>Journal <span class="muted small" style="text-transform:none">last ${s.journal.length} lines</span></h2>
        <pre class="log tall">${s.journal.length ? esc(s.journal.join('\n')) : 'The journal has nothing for this unit.'}</pre>
      </div>`;
  } catch (err) {
    $('#service-detail-body').innerHTML = `<div class="msg err">${esc(err.message)}</div>${err.detail ? `<pre class="log">${esc(err.detail)}</pre>` : ''}`;
  }
}

/* --------------------------------------------- server: add a service */

const serviceModal = $('#modal-service');
const serviceForm = $('#form-service');

function openServiceModal() {
  if (!currentServerId) return toast('Open a server first', 'err');
  serviceForm.reset();
  $('#service-form-msg').classList.add('hidden');
  $('#service-form-log').classList.add('hidden');
  $('#service-server-name').textContent = currentServer ? currentServer.name : 'this server';
  serviceForm.user.placeholder = currentServer?.username || 'root';
  serviceModal.classList.remove('hidden');
  prepareServiceEnvPicker();
}

$('#btn-add-service').addEventListener('click', openServiceModal);

serviceForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter || $('button[type=submit]', serviceForm);
  const msg = $('#service-form-msg');
  const log = $('#service-form-log');
  const fd = new FormData(serviceForm);

  const body = Object.fromEntries(fd.entries());
  // Checkboxes are absent from FormData when unticked, so read them directly.
  body.enable = serviceForm.enable.checked;
  body.start = serviceForm.start.checked;
  body.overwrite = serviceForm.overwrite.checked;
  // The environment picker's own fields are not the service's.
  for (const k of Object.keys(body)) if (k.startsWith('envpick_')) delete body[k];
  const envPick = readEnvPicker($('#service-env-pick'));
  const envProblem = envPickerProblem($('#service-env-pick'));
  if (envProblem) return formMsg(msg, envProblem, 'err');

  busy(btn, true, 'Creating…');
  log.classList.add('hidden');
  formMsg(msg, 'Writing the unit file and asking systemd to load it…', 'info');
  try {
    const r = await api(`/servers/${currentServerId}/services`, { method: 'POST', body });
    serviceModal.classList.add('hidden');
    toast(`${r.unit} created — ${r.active}${r.enabled ? `, ${r.enabled}` : ''}`);
    // Its variables kept as a named environment, when that was asked for.
    if (envPick.environment_mode === 'new') {
      api('/environments', {
        method: 'POST',
        body: { name: envPick.environment_name, description: `systemd service ${r.unit} on ${currentServer?.name || 'a server'}`, env: body.environment || '' },
      }).then((env) => { envsCache = null; toast(`Environment "${env.name}" saved with ${env.count} variable(s)`); })
        .catch((err) => toast(`The service was created, but the environment was not saved: ${err.message}`, 'err'));
    }
    // Land on the tab that now shows what was just created, filtered to it.
    serviceFilter.text = '';
    serviceFilter.state = 'created';
    refreshServerTab('services');
  } catch (err) {
    formMsg(msg, err.message, 'err');
    if (err.detail) {
      log.textContent = err.detail;
      log.classList.remove('hidden');
    }
  }
  busy(btn, false);
});

/* ------------------------------------------------- runners on a server */

/**
 * The runners on this server, as the machine reports them.
 *
 * This asks the server itself rather than the provider, so it can say whether
 * each runner's service is actually up — and whether one is running a job this
 * second — instead of repeating what GitHub last thought.
 */
async function loadServerRunners() {
  const box = $('#server-runners-panel');
  if (!box) return;
  tabsLoaded.add('runners');
  box.innerHTML = '<div class="empty"><span class="spinner"></span>Checking the runners on this server…</div>';

  const head = `
    <div class="section-head">
      <h2>CI runners on this server</h2>
      <div class="section-tools"><button class="btn tiny" data-runner-reload="1">Check again</button></div>
    </div>`;

  try {
    const r = await api(`/servers/${currentServerId}/runners`);
    const { totals } = r;

    setTabCount('runners', totals.running, totals.stopped || totals.missing ? 'err' : '');

    box.innerHTML = `${head}
      ${runnerHeadline(r)}
      ${totals.installed
    ? table(
      [{ label: 'Runner' }, { label: 'Running here' }, { label: 'Registered against' }, { label: 'Provider' }, { label: '' }],
      r.runners.map((x) => [
        `<b>${esc(x.name)}</b>
             <div class="muted small">${esc(gitLabel(x.kind))} runner${x.labels.length ? ` · ${x.labels.map(esc).join(', ')}` : ''}</div>
             ${x.serviceName ? `<div class="muted small"><code>${esc(x.serviceName)}</code></div>` : ''}`,
        runnerLiveCell(x),
        `<code class="small">${esc(x.target)}</code>
             <div class="muted small">${x.scope === 'org' ? 'whole organisation / group' : 'single repository'}</div>`,
        `<span class="badge ${RUNNER_BADGE[x.providerStatus] ?? ''}">${esc(x.providerStatus)}</span>
             ${x.lastError ? `<div class="muted small" style="color:var(--err)">${esc(String(x.lastError).slice(0, 120))}</div>` : ''}`,
        `<div class="row-actions">
             <button class="btn tiny" data-runner-action="refresh" data-id="${x.id}">Check</button>
             ${x.serviceName ? ifCan('create', `<button class="btn tiny" data-runner-action="${x.running ? 'restart' : 'start'}" data-id="${x.id}">${x.running ? 'Restart' : 'Start'}</button>
             ${x.running ? `<button class="btn tiny" data-runner-action="stop" data-id="${x.id}">Stop</button>` : ''}`) : ''}
             ${ifCan('delete', `<button class="btn tiny danger" data-runner-action="delete" data-id="${x.id}" data-name="${esc(x.name)}">Remove</button>`)}
           </div>`,
      ]),
      'No runners yet'
    )
    : '<div class="card"><p class="muted small" style="margin:0">No CI runner is installed here. Open a git account and use <b>+ Add runner</b> to put one on this server.</p></div>'}

      ${r.unknown.length ? `
        <div style="margin-top:14px">
          <p class="muted small">Runner services on this machine that the panel did not install:</p>
          ${table(
    [{ label: 'Service' }, { label: 'State' }],
    r.unknown.map((u) => [
      `<code class="small">${esc(u.service)}</code>`,
      `<span class="badge ${u.active === 'active' ? 'ok' : ''}">${esc(u.active)}</span>
             <span class="muted small">${esc(u.sub || '')}</span>`,
    ])
  )}
        </div>` : ''}`;
  } catch (err) {
    box.innerHTML = `${head}<div class="msg err">${esc(err.message)}</div>`;
  }
}

/** The one sentence somebody actually wants: is anything running here? */
function runnerHeadline(r) {
  const { totals, jobsRunning } = r;

  if (!totals.installed) return '';

  if (!totals.running) {
    return `<div class="msg err" style="margin-bottom:12px">
      <b>No runner is running on this server.</b>
      ${totals.missing
    ? `${totals.missing} of them ${totals.missing === 1 ? 'has' : 'have'} no service on the machine at all — reinstall ${totals.missing === 1 ? 'it' : 'them'}.`
    : 'Their services are installed but stopped, so nothing here will pick up a job.'}
    </div>`;
  }

  const running = totals.running === 1
    ? `<b>This runner is running on this server.</b>`
    : `<b>${totals.running} of ${totals.installed} runners are running on this server.</b>`;

  return `<div class="msg ${totals.stopped || totals.missing ? 'warn' : 'ok'}" style="margin-bottom:12px">
    ${running}
    ${jobsRunning ? ` It is working on ${jobsRunning} job${jobsRunning > 1 ? 's' : ''} right now.` : ' Nothing is building at the moment.'}
    ${totals.stopped ? ` ${totals.stopped} other ${totals.stopped === 1 ? 'is' : 'are'} stopped.` : ''}
    ${totals.missing ? ` ${totals.missing} ${totals.missing === 1 ? 'has' : 'have'} no service on the machine.` : ''}
  </div>`;
}

/** Running / stopped / gone, with how long it has been that way. */
function runnerLiveCell(x) {
  if (!x.serviceName) return '<span class="muted small">no service recorded — reinstall it</span>';
  if (!x.live) return '<span class="badge err">not on this machine</span>';

  if (x.live.running) {
    return `<span class="badge ok">running</span>
      ${x.live.since ? `<div class="muted small">since ${esc(String(x.live.since).replace(/ [A-Z]{2,5}$/, ''))}</div>` : ''}
      <div class="muted small">${x.live.enabled === 'enabled' ? 'starts at boot' : `${esc(x.live.enabled)} at boot`}${x.live.pid ? ` · pid ${x.live.pid}` : ''}</div>`;
  }
  return `<span class="badge err">${esc(x.live.active)}</span>
    <div class="muted small">${x.live.enabled === 'enabled' ? 'would start at boot' : `${esc(x.live.enabled)} at boot`}</div>`;
}

/* ------------------------------------------------------ server modal */

const serverModal = $('#modal-server');
const serverForm = $('#form-server');

/** null adds a server; a row edits that one. */
let editingServerId = null;

function openServerModal(server = null) {
  editingServerId = server?.id ?? null;
  serverForm.reset();
  $('#server-form-msg').classList.add('hidden');

  $('#server-modal-title').textContent = server ? `Edit ${server.name}` : 'Add server';
  $('#server-modal-hint').textContent = server
    // The API keeps whatever is already stored when a secret box is left empty.
    ? 'Change anything here. Leave the password, key and sudo boxes empty to keep the ones already stored.'
    : 'Ubuntu hosts only. Credentials are encrypted before they touch disk.';
  $('#btn-server-save').textContent = server ? 'Save changes' : 'Save & connect';

  if (server) {
    serverForm.name.value = server.name;
    serverForm.host.value = server.host;
    serverForm.port.value = server.port;
    serverForm.username.value = server.username;
    serverForm.auth_type.value = server.auth_type;
    serverForm.tags.value = (server.tags || []).join(', ');
    serverForm.notes.value = server.notes || '';
    serverForm.password.placeholder = server.hasPassword ? 'unchanged' : '';
    serverForm.private_key.placeholder = server.hasPrivateKey ? 'unchanged — paste a new key to replace it' : '';
    serverForm.sudo_password.placeholder = 'unchanged';
  } else {
    serverForm.password.placeholder = '';
    serverForm.private_key.placeholder = '-----BEGIN OPENSSH PRIVATE KEY-----\n…\n-----END OPENSSH PRIVATE KEY-----';
    serverForm.sudo_password.placeholder = '';
  }

  // The password / key halves follow whichever authentication is selected.
  serverForm.auth_type.dispatchEvent(new Event('change'));
  serverModal.classList.remove('hidden');
}

$('#btn-add-server').addEventListener('click', () => openServerModal());

/** Edit from the server's own page, where the row is already loaded. */
$('#btn-detail-edit').addEventListener('click', () => {
  if (currentServer) openServerModal(currentServer);
});

$$('[data-close]').forEach((b) => b.addEventListener('click', () => {
  b.closest('.modal-backdrop').classList.add('hidden');
}));

serverForm.auth_type.addEventListener('change', (e) => {
  const isKey = e.target.value === 'key';
  $('#field-key').classList.toggle('hidden', !isKey);
  $('#field-password').classList.toggle('hidden', isKey);
});

function serverFormData() {
  const fd = new FormData(serverForm);
  return Object.fromEntries(fd.entries());
}

function formMsg(el, text, kind) {
  el.className = `msg ${kind}`;
  el.textContent = text;
  el.classList.remove('hidden');
}

$('#btn-test-conn').addEventListener('click', async (e) => {
  const msg = $('#server-form-msg');
  busy(e.target, true, 'Connecting…');
  try {
    // While editing, an empty secret box means "use the one already stored".
    const body = { ...serverFormData(), ...(editingServerId ? { server_id: editingServerId } : {}) };
    const r = await api('/servers/test', { method: 'POST', body });
    formMsg(msg, `Connected. ${r.user}@${r.hostname} — ${r.os} (${r.latencyMs}ms)`, 'ok');
  } catch (err) {
    formMsg(msg, err.message, 'err');
  }
  busy(e.target, false);
});

serverForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter || $('button[type=submit]', serverForm);
  const msg = $('#server-form-msg');
  busy(btn, true, 'Saving…');

  // Editing saves and closes; adding goes on to connect and read the machine.
  if (editingServerId) {
    try {
      const saved = await api(`/servers/${editingServerId}`, { method: 'PUT', body: serverFormData() });
      serverModal.classList.add('hidden');
      toast(`${saved.name} updated`);
      if (!$('#view-server-detail').classList.contains('hidden') && String(currentServerId) === String(saved.id)) {
        openServer(saved.id);
      } else {
        loadServers();
      }
    } catch (err) {
      formMsg(msg, err.message, 'err');
    }
    busy(btn, false);
    return;
  }

  try {
    const created = await api('/servers', { method: 'POST', body: serverFormData() });
    formMsg(msg, 'Saved. Connecting and collecting system details…', 'info');
    try {
      await api(`/servers/${created.id}/facts`, { method: 'POST' });
      serverModal.classList.add('hidden');
      toast(`${created.name} added and system details collected`);
      openServer(created.id);
    } catch (collectErr) {
      formMsg(msg, `Server saved, but collecting details failed: ${collectErr.message}`, 'err');
      loadServers();
    }
  } catch (err) {
    formMsg(msg, err.message, 'err');
  }
  busy(btn, false);
});

/* ------------------------------------------- Git accounts: browser sign-in */

/**
 * Opens the provider's sign-in page in a popup. The callback page posts the
 * outcome back to this window and closes itself.
 */
function connectWithOauth(kind, label) {
  const popup = window.open(
    `/api/git/oauth/start?kind=${encodeURIComponent(kind)}`,
    'auto-deploy-oauth',
    'width=760,height=780,menubar=no,toolbar=no'
  );

  if (!popup) {
    toast('Your browser blocked the sign-in window. Allow pop-ups for this page and try again.', 'err');
    $('#modal-git').classList.add('hidden');
    return;
  }

  const onMessage = (event) => {
    if (event.origin !== window.location.origin) return;
    const d = event.data;
    if (!d || d.source !== 'auto-deploy-oauth') return;
    cleanup();
    // The provider turned out not to be set up: stay in the wizard and show its one-time setup.
    if (d.needsSetup) {
      api('/git/oauth/providers').then((r) => { oauthInfo = r; }).catch(() => {}).finally(() => {
        chosenProvider = oauthInfo.providers.find((p) => p.kind === d.kind) || { kind: d.kind, label: gitLabel(d.kind) };
        showSetupStep();
      });
      return;
    }
    $('#modal-git').classList.add('hidden');
    if (d.ok) {
      toast(`Connected as ${d.login}`);
      openGit(d.id);
    } else {
      toast(d.error || 'Sign-in failed', 'err');
      loadGitList();
    }
  };

  // The popup can also be closed by hand, in which case no message ever arrives.
  const poll = setInterval(() => {
    if (popup.closed) { cleanup(); $('#modal-git').classList.add('hidden'); loadGitList(); }
  }, 700);

  function cleanup() {
    clearInterval(poll);
    window.removeEventListener('message', onMessage);
    try { if (!popup.closed) popup.close(); } catch { /* cross-origin while on the provider */ }
  }

  window.addEventListener('message', onMessage);
}

/* ------------------------------------------- Add-account wizard */

const GIT_LABELS = { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket' };
function gitLabel(kind) { return GIT_LABELS[kind] || 'GitHub'; }

const gitModal = $('#modal-git');
let oauthInfo = { providers: [], callbackUrl: '' };
let chosenProvider = null;

function gitStep(step) {
  $('#git-step-provider').classList.toggle('hidden', step !== 'provider');
  $('#git-step-setup').classList.toggle('hidden', step !== 'setup');
  $('#git-step-waiting').classList.toggle('hidden', step !== 'waiting');
  $('#git-modal-close-row').classList.toggle('hidden', step !== 'provider');
}

async function openGitWizard() {
  gitStep('provider');
  $('#git-setup-msg').classList.add('hidden');
  gitModal.classList.remove('hidden');
  try {
    oauthInfo = await api('/git/oauth/providers');
  } catch { /* the picker still works; setup will simply be needed */ }
}

$('#btn-add-git-account').addEventListener('click', openGitWizard);
$('#link-manual-token').addEventListener('click', () => {
  gitModal.classList.add('hidden');
  openCredModal('git');
});

/** Choosing a provider goes straight to sign-in, or to setup the first time. */
$('#git-step-provider').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-pick]');
  if (!btn) return;
  const kind = btn.dataset.pick;
  // Ask again: what the wizard read when it opened may be out of date (keys added to or removed from .env since).
  try { oauthInfo = await api('/git/oauth/providers'); } catch { /* go with what we have */ }
  chosenProvider = oauthInfo.providers.find((p) => p.kind === kind) || { kind, label: gitLabel(kind) };

  if (chosenProvider.configured) {
    gitStep('waiting');
    connectWithOauth(kind, chosenProvider.label);
  } else {
    showSetupStep();
  }
});

function showSetupStep() {
  const p = chosenProvider;
  const setup = {
    github: {
      hint: 'The form opens with the name and callback already filled in — just press <b>Register application</b>, then <b>Generate a new client secret</b>.',
      id: 'After registering, the page shows a <b>Client ID</b> like <code>Ov23li8xQ2...</code> or <code>Iv1.8a61f9b3...</code>.',
      placeholder: 'Ov23li0123456789abcd',
    },
    gitlab: {
      hint: 'Press <b>Add new application</b>. Tick the scopes <code>read_api</code>, <code>read_repository</code> and <code>read_user</code>, and paste the callback URL below.',
      id: 'After saving, GitLab shows an <b>Application ID</b> (a long hex string) and a <b>Secret</b>.',
      placeholder: '9f8c1e2b3a4d5e6f7a8b9c0d1e2f3a4b…',
    },
    bitbucket: {
      hint: 'Open your workspace, then <b>Settings → OAuth consumers → Add consumer</b>. Paste the callback URL below, tick <b>This is a private consumer</b>, and give it the permissions <b>Account: Read</b>, <b>Workspace membership: Read</b> and <b>Repositories: Read</b>.',
      id: 'After saving, open the consumer: it shows a <b>Key</b> (use it as the client ID) and a <b>Secret</b>.',
      placeholder: 'aBcD1234eFgH5678iJ',
    },
  }[p.kind] || {};
  $('#setup-provider-name').textContent = p.label;
  $('#setup-intro').textContent =
    `${p.label} needs to know about this panel before it will let you sign in. This takes about a minute, once.`;
  $('#setup-hint').innerHTML = setup.hint;
  $('#setup-id-hint').innerHTML = setup.id;
  $('#setup-client-id').placeholder = setup.placeholder;
  $('#setup-callback').textContent = oauthInfo.callbackUrl || `${window.location.origin}/api/git/oauth/callback`;
  $('#btn-open-register').dataset.url = p.registerUrl || '';
  $('#setup-client-id').value = '';
  $('#setup-client-secret').value = '';
  $('#git-setup-msg').classList.add('hidden');
  gitStep('setup');
}

$('#btn-open-register').addEventListener('click', (e) => {
  const url = e.currentTarget.dataset.url;
  if (url) window.open(url, '_blank', 'noopener');
});

$('#btn-copy-callback').addEventListener('click', async (e) => {
  try {
    await navigator.clipboard.writeText($('#setup-callback').textContent);
    e.target.textContent = 'Copied';
    setTimeout(() => { e.target.textContent = 'Copy'; }, 1500);
  } catch {
    toast('Could not copy — select the URL and copy it manually', 'err');
  }
});

$('#btn-setup-back').addEventListener('click', () => gitStep('provider'));

$('#btn-setup-save').addEventListener('click', async (e) => {
  const msg = $('#git-setup-msg');
  const clientId = $('#setup-client-id').value.trim();
  const clientSecret = $('#setup-client-secret').value.trim();
  if (!clientId || !clientSecret) {
    return formMsg(msg, 'Paste both the client ID and the client secret.', 'err');
  }
  busy(e.target, true, 'Saving…');
  try {
    await api('/git/oauth/config', { method: 'POST', body: { kind: chosenProvider.kind, clientId, clientSecret } });
    oauthInfo = await api('/git/oauth/providers');
    chosenProvider = oauthInfo.providers.find((p) => p.kind === chosenProvider.kind);
    busy(e.target, false);
    gitStep('waiting');
    connectWithOauth(chosenProvider.kind, chosenProvider.label);
  } catch (err) {
    formMsg(msg, err.message, 'err');
    busy(e.target, false);
  }
});

$('#btn-reopen-popup').addEventListener('click', () => {
  if (chosenProvider) connectWithOauth(chosenProvider.kind, chosenProvider.label);
});

/* -------------------------------------------------- Git accounts: list */

async function loadGitList() {
  const box = $('#git-list');
  box.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const list = await api('/credentials?provider=git');
    if (!list.length) {
      box.innerHTML = '<div class="empty">No git accounts yet. Click <b>+ Add git account</b>, pick GitHub, GitLab or Bitbucket, and sign in there.</div>';
      return;
    }
    box.innerHTML = list.map((c) => {
      const a = c.extra.account || {};
      return `
      <div class="card">
        <div class="card-head">
          <div style="display:flex;gap:10px;align-items:center">
            ${a.avatarUrl ? `<img src="${esc(a.avatarUrl)}" alt="" width="38" height="38" style="border-radius:50%;border:1px solid var(--line)">` : ''}
            <div>
              <h3>${esc(c.name)}</h3>
              <div class="muted small">${a.login ? `${esc(a.login)}${a.name ? ` · ${esc(a.name)}` : ''}` : esc(c.username || 'not authenticated')}</div>
            </div>
          </div>
          <span class="badge ${c.status === 'valid' ? 'ok' : c.status === 'invalid' ? 'err' : ''}">${esc(c.status)}</span>
        </div>
        <dl class="kv">
          <dt>Hosting</dt><dd>${esc(gitLabel(c.extra.kind))} <span class="muted small">${esc(c.extra.apiUrl || '')}</span></dd>
          <dt>Connected by</dt><dd>${c.extra.auth === 'oauth'
            ? '<span class="badge ok">browser sign-in</span>' + (c.extra.hasRefreshToken ? ' <span class="muted small">auto-renewing</span>' : '')
            : '<span class="badge">pasted token</span>'}</dd>
          <dt>Token</dt><dd><code>${esc(c.secretHint)}</code>${a.tokenStyle ? ` <span class="muted small">${esc(a.tokenStyle)}</span>` : ''}
            ${c.extra.expiresAt ? `<div class="muted small">expires ${esc(String(c.extra.expiresAt).replace('T', ' ').slice(0, 16))}</div>` : ''}</dd>
          <dt>Scopes</dt><dd>${a.scopes?.length ? a.scopes.map((s) => `<span class="chip">${esc(s)}</span>`).join(' ') : '<span class="muted small">none reported</span>'}</dd>
          <dt>Authenticated</dt><dd>${val(c.verified_at)}</dd>
        </dl>
        ${c.last_error ? `<div class="msg err" style="margin-top:10px">${esc(c.last_error)}</div>` : ''}
        <div class="card-actions">
          <button class="btn tiny" data-git-action="open" data-id="${c.id}">Repositories</button>
          <button class="btn tiny" data-git-action="reauth" data-id="${c.id}">Re-authenticate</button>
          ${ifCan('delete', `<button class="btn tiny danger" data-git-action="delete" data-id="${c.id}">Disconnect</button>`)}
        </div>
      </div>`;
    }).join('');
  } catch (err) {
    box.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

$('#git-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-git-action]');
  if (!btn) return;
  const { gitAction, id } = btn.dataset;

  if (gitAction === 'open') return openGit(id);
  if (gitAction === 'delete') {
    if (!confirm('Disconnect this git account? The token is deleted from the panel.')) return;
    await api(`/credentials/${id}`, { method: 'DELETE' });
    toast('Git account disconnected');
    return loadGitList();
  }
  busy(btn, true, 'Authenticating…');
  try {
    const r = await api(`/credentials/${id}/git/account`, { method: 'POST' });
    toast(`Authenticated as ${r.account.login} (${r.account.latencyMs}ms)`);
  } catch (err) {
    toast(err.message, 'err');
  }
  await loadGitList();
});


/* ------------------------------------------------ Git accounts: detail */

let currentGitId = null;
let currentGitRepos = [];

async function openGit(id) {
  currentGitId = id;
  show('git-detail');
  $('#git-body').innerHTML = '<div class="empty"><span class="spinner"></span>Loading repositories…</div>';
  try {
    const cred = await api(`/credentials/${id}`);
    const a = cred.extra.account || {};
    $('#git-name').textContent = cred.name;
    $('#git-sub').textContent = `${a.login || cred.username || '—'}${a.name ? ` · ${a.name}` : ''} · ${gitLabel(cred.extra.kind)} (${cred.extra.apiUrl})`;
    const r = await api(`/credentials/${id}/git/repositories`, { method: 'POST' });
    currentGitRepos = r.repositories;
    $('#git-body').innerHTML = renderGitAccount(cred, r.repositories);
    loadGitRunners();
  } catch (err) {
    $('#git-body').innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
  }
}

$('#btn-git-back').addEventListener('click', () => openAccounts('git'));
$('#btn-git-repos').addEventListener('click', () => openGit(currentGitId));
$('#btn-git-reauth').addEventListener('click', async (e) => {
  busy(e.target, true, 'Authenticating…');
  try {
    const r = await api(`/credentials/${currentGitId}/git/account`, { method: 'POST' });
    toast(`Authenticated as ${r.account.login}`);
    await openGit(currentGitId);
  } catch (err) {
    toast(err.message, 'err');
  }
  busy(e.target, false);
});

function renderGitAccount(cred, repos) {
  const a = cred.extra.account || {};
  const out = [];

  out.push(section('Account', `<div class="tiles">
    ${tile('Login', val(a.login), val(a.name))}
    ${tile('Type', val(a.accountType), val(a.company))}
    ${tile('Repositories', val(repos.length), `${repos.filter((r) => r.private).length} private`)}
    ${tile('Token', val(a.tokenStyle || 'token'), a.scopes?.length ? `${a.scopes.length} scopes` : 'no scopes reported')}
    ${a.rateLimit ? tile('API budget', `${a.rateLimit.remaining} / ${a.rateLimit.limit}`, 'requests left this hour') : ''}
  </div>`));

  // Filled in by loadGitRunners() once the repository list is on screen.
  out.push('<div class="section" id="git-runners-panel"></div>');

  out.push(section('Repositories', table(
    [{ label: 'Repository' }, { label: 'Visibility' }, { label: 'Default branch' }, { label: 'Language' }, { label: 'Updated' }],
    repos.map((r) => [
      `<button class="link-db" data-repo="${esc(r.fullName)}">${esc(r.fullName)}</button>${r.archived ? ' <span class="badge">archived</span>' : ''}
       ${r.description ? `<div class="muted small">${esc(r.description)}</div>` : ''}`,
      r.private ? '<span class="badge warn">private</span>' : '<span class="badge">public</span>',
      `<code>${val(r.defaultBranch)}</code>`,
      val(r.language),
      `<span class="small">${val((r.updatedAt || '').slice(0, 10))}</span>`,
    ]),
    'This token cannot see any repositories'
  )));

  out.push('<p class="muted small">Click a repository to list its branches and recent commits.</p>');
  return out.join('');
}

$('#git-body').addEventListener('click', async (e) => {
  const repoBtn = e.target.closest('button[data-repo]');
  const branchBtn = e.target.closest('button[data-branch]');
  const box = $('#git-body');

  if (branchBtn) {
    const { repo, branch } = branchBtn.dataset;
    box.innerHTML = '<div class="empty"><span class="spinner"></span>Loading commits…</div>';
    try {
      const r = await api(`/credentials/${currentGitId}/git/commits`, { method: 'POST', body: { repo, branch } });
      box.innerHTML = `
        <button class="link-back" onclick="window.__reopenGit()">← back to repositories</button>
        ${section(`${repo} · ${branch}`, table(
          [{ label: 'Commit' }, { label: 'Message' }, { label: 'Author' }, { label: 'Date' }],
          r.commits.map((c) => [
            `<code>${esc(c.sha)}</code>`, esc(c.message), val(c.author),
            `<span class="small">${val((c.date || '').replace('T', ' ').slice(0, 16))}</span>`,
          ]),
          'No commits on this branch'
        ))}`;
    } catch (err) {
      toast(err.message, 'err');
      openGit(currentGitId);
    }
    return;
  }

  if (!repoBtn) return;
  const repo = repoBtn.dataset.repo;
  box.innerHTML = '<div class="empty"><span class="spinner"></span>Loading branches…</div>';
  try {
    const r = await api(`/credentials/${currentGitId}/git/branches`, { method: 'POST', body: { repo } });
    box.innerHTML = `
      <button class="link-back" onclick="window.__reopenGit()">← back to repositories</button>
      ${section(repo, table(
        [{ label: 'Branch' }, { label: 'Protected' }, { label: 'Last commit' }],
        r.branches.map((b) => [
          `<button class="link-db" data-repo="${esc(repo)}" data-branch="${esc(b.name)}"><b>${esc(b.name)}</b></button>`,
          b.protected ? '<span class="badge warn">protected</span>' : 'no',
          b.lastCommit ? `<code>${esc(b.lastCommit.sha)}</code> <span class="small">${esc(b.lastCommit.message || '')}</span>` : '—',
        ]),
        'No branches'
      ))}
      <p class="muted small">Click a branch to see its recent commits.</p>
      <div class="section" id="repo-runners-panel"></div>`;
    loadRepoRunners(repo);
  } catch (err) {
    toast(err.message, 'err');
    openGit(currentGitId);
  }
});

window.__reopenGit = () => openGit(currentGitId);

/* ---------------------------------------------------------- runners */

const RUNNER_BADGE = {
  online: 'ok', idle: 'ok', busy: 'warn', installing: '', pending: '',
  offline: 'err', missing: 'err', error: 'err',
};

/** The runner table, shown both under a git account and under a server. */
function runnerTable(runners, second = 'account') {
  return table(
    [
      { label: 'Runner' },
      { label: second === 'account' ? 'Git account' : 'Server' },
      { label: 'Registered against' },
      { label: 'Status' },
      { label: 'Service' },
      { label: '' },
    ],
    runners.map((r) => [
      `<b>${esc(r.name)}</b>
       <div class="muted small">${esc(gitLabel(r.kind))} runner${r.labels.length ? ` · ${r.labels.map(esc).join(', ')}` : ''}</div>`,
      second === 'account'
        ? (r.account ? esc(r.account.name) : '—')
        : (r.server ? `<b>${esc(r.server.name)}</b><div class="muted small">${esc(r.server.username)}@${esc(r.server.host)}</div>` : '—'),
      `<code class="small">${esc(r.target)}</code>
       <div class="muted small">${r.scope === 'org' ? 'whole organisation / group' : 'single repository'}</div>`,
      `<span class="badge ${RUNNER_BADGE[r.status] ?? ''}">${esc(r.status)}</span>
       ${r.last_error ? `<div class="muted small" style="color:var(--err)">${esc(String(r.last_error).slice(0, 120))}</div>` : ''}`,
      r.service_name ? `<code class="small">${esc(r.service_name)}</code>` : '<span class="muted small">—</span>',
      `<div class="row-actions">
        <button class="btn tiny" data-runner-action="refresh" data-id="${r.id}">Check</button>
        ${r.service_name ? ifCan('create', `<button class="btn tiny" data-runner-action="restart" data-id="${r.id}">Restart</button>
        <button class="btn tiny" data-runner-action="stop" data-id="${r.id}">Stop</button>`) : ''}
        ${ifCan('delete', `<button class="btn tiny danger" data-runner-action="delete" data-id="${r.id}" data-name="${esc(r.name)}">Remove</button>`)}
      </div>`,
    ]),
    'No runners yet'
  );
}

/** Check / restart / stop / remove, from either detail page. */
async function runnerAction(btn, reload) {
  const { runnerAction: action, id, name } = btn.dataset;

  if (action === 'delete') {
    if (!confirm(`Remove runner "${name}"? It is unregistered at the provider and deleted from the server.`)) return;
    busy(btn, true, 'Removing…');
    try {
      const r = await api(`/runners/${id}`, { method: 'DELETE' });
      toast(r.warnings?.length ? `Runner removed, with warnings: ${r.warnings.join(' · ')}` : 'Runner removed');
    } catch (err) {
      toast(err.message, 'err');
    }
    return reload();
  }

  busy(btn, true, action === 'refresh' ? 'Checking…' : '…');
  try {
    if (action === 'refresh') {
      const r = await api(`/runners/${id}/refresh`, { method: 'POST' });
      toast(r.runner
        ? `${r.runner.name} is ${r.status}${r.runner.os ? ` on ${r.runner.os}` : ''}`
        : 'The provider no longer lists this runner');
    } else {
      const r = await api(`/runners/${id}/action`, { method: 'POST', body: { action } });
      toast(`Runner service ${action} → ${r.active}`);
    }
  } catch (err) {
    toast(err.message, 'err');
  }
  reload();
}

/* ------------------------------------------- runners under a git account */

async function loadGitRunners() {
  const box = $('#git-runners-panel');
  if (!box) return;

  const head = `
    <div class="section-head">
      <h2>Self-hosted runners</h2>
      <div class="section-tools">
        <button class="btn tiny" data-git-runner-reload="1">Refresh</button>
        ${ifCan('create', '<button class="btn tiny primary" data-git-runner-add="1">+ Add runner</button>')}
      </div>
    </div>`;

  box.innerHTML = `${head}<div class="empty"><span class="spinner"></span>Loading runners…</div>`;

  try {
    const mine = await api(`/runners?credential_id=${currentGitId}`);

    // Ask the provider about every target we already have a runner for — so the
    // status shown is the live one — plus the most recently touched repositories,
    // which is where a runner registered outside this panel usually lives.
    const probes = [...new Map([
      ...mine.map((r) => [`${r.scope}:${r.target}`, { scope: r.scope, target: r.target }]),
      ...currentGitRepos.slice(0, 8).map((r) => [`repo:${r.fullName}`, { scope: 'repo', target: r.fullName }]),
    ]).values()].slice(0, 12);

    const live = await Promise.all(probes.map((p) => api(`/credentials/${currentGitId}/git/runners`, {
      method: 'POST',
      body: { scope: p.scope, target: p.target },
    }).catch(() => null)));

    const known = new Set(mine.map((r) => `${r.target}|${r.name}`));
    const foreign = [];
    for (const result of live.filter(Boolean)) {
      for (const runner of result.runners) {
        if (!known.has(`${result.target}|${runner.name}`)) foreign.push({ ...runner, target: result.target, settingsUrl: result.settingsUrl });
      }
      // Fold the live status back onto our own rows.
      for (const row of mine.filter((r) => r.target === result.target)) {
        const match = result.runners.find((x) => x.name === row.name || (row.remote_id && x.id === row.remote_id));
        if (match) row.status = match.busy ? 'busy' : match.status;
        else if (row.status === 'online') row.status = 'missing';
      }
    }

    box.innerHTML = `${head}
      ${mine.length
        ? runnerTable(mine, 'server')
        : `<div class="card"><p class="muted small" style="margin:0">
            No runner installed from this panel yet. <b>+ Add runner</b> picks one of your servers,
            registers it with this account and installs it over SSH.
          </p></div>`}
      ${foreign.length ? `<div style="margin-top:14px">
        <p class="muted small">Registered at the provider but not installed from this panel — found by checking ${probes.length} of this account's repositories:</p>
        ${table(
          [{ label: 'Runner' }, { label: 'Registered against' }, { label: 'Status' }, { label: 'Labels' }],
          foreign.map((r) => [
            `<b>${esc(r.name)}</b>${r.os ? `<div class="muted small">${esc(r.os)}</div>` : ''}`,
            `<code class="small">${esc(r.target)}</code>`,
            `<span class="badge ${RUNNER_BADGE[r.status] ?? ''}">${esc(r.busy ? 'busy' : r.status)}</span>`,
            r.labels?.length ? r.labels.map((l) => `<span class="chip">${esc(l)}</span>`).join(' ') : '—',
          ])
        )}
      </div>` : ''}`;
  } catch (err) {
    box.innerHTML = `${head}<div class="msg err">${esc(err.message)}</div>`;
  }
}

/** The runners one repository has, straight from the provider. */
async function loadRepoRunners(repo) {
  const box = $('#repo-runners-panel');
  if (!box) return;

  const head = `
    <div class="section-head">
      <h2>Runners for this repository</h2>
      <div class="section-tools">
        ${ifCan('create', `<button class="btn tiny primary" data-git-runner-add="1" data-target="${esc(repo)}">+ Add runner</button>`)}
      </div>
    </div>`;
  box.innerHTML = `${head}<div class="empty"><span class="spinner"></span>Asking the provider which runners this repository has…</div>`;

  try {
    const r = await api(`/credentials/${currentGitId}/git/runners`, { method: 'POST', body: { scope: 'repo', target: repo } });
    box.innerHTML = `${head}${table(
      [{ label: 'Runner' }, { label: 'Status' }, { label: 'Labels' }, { label: 'OS' }],
      r.runners.map((runner) => [
        `<b>${esc(runner.name)}</b>`,
        `<span class="badge ${RUNNER_BADGE[runner.busy ? 'busy' : runner.status] ?? ''}">${esc(runner.busy ? 'busy' : runner.status)}</span>`,
        runner.labels?.length ? runner.labels.map((l) => `<span class="chip">${esc(l)}</span>`).join(' ') : '—',
        val(runner.os || runner.ip),
      ]),
      'No runner is registered for this repository yet'
    )}`;
  } catch (err) {
    box.innerHTML = `${head}<div class="card"><p class="muted small" style="margin:0">Could not read the runners: ${esc(err.message)}</p></div>`;
  }
}

$('#view-git-detail').addEventListener('click', (e) => {
  if (e.target.closest('[data-git-runner-reload]')) return loadGitRunners();
  const add = e.target.closest('[data-git-runner-add]');
  if (add) return openRunnerModal({ credentialId: currentGitId, target: add.dataset.target });
  const btn = e.target.closest('button[data-runner-action]');
  if (btn) return runnerAction(btn, loadGitRunners);
});

$('#btn-git-add-runner').addEventListener('click', () => openRunnerModal({ credentialId: currentGitId }));

/* ------------------------------------------------------ add a runner */

const runnerModal = $('#modal-runner');
const runnerForm = $('#form-runner');
let runnerAccounts = [];

async function openRunnerModal(preset = {}) {
  runnerForm.reset();
  $('#runner-form-msg').classList.add('hidden');
  $('#runner-form-log').classList.add('hidden');
  $('#runner-target').innerHTML = '<option value="">Loading…</option>';
  runnerModal.classList.remove('hidden');

  const [allAccounts, servers] = await Promise.all([
    api('/credentials?provider=git').catch(() => []),
    api('/servers').catch(() => []),
  ]);
  // Runners are a GitHub and GitLab thing; Bitbucket accounts are for deploying only.
  const accounts = allAccounts.filter((a) => a.extra?.kind !== 'bitbucket');
  runnerAccounts = accounts;

  $('#runner-account').innerHTML = accounts.length
    ? accounts.map((a) => `<option value="${a.id}">${esc(a.name)}${a.extra?.account?.login ? ` — ${esc(a.extra.account.login)}` : ''} (${esc(gitLabel(a.extra?.kind))})</option>`).join('')
    : '<option value="">No GitHub or GitLab accounts yet — connect one first</option>';
  if (preset.credentialId && accounts.some((a) => String(a.id) === String(preset.credentialId))) {
    $('#runner-account').value = String(preset.credentialId);
  }

  // Every server you have added, so the runner can be placed on one of them.
  $('#runner-server').innerHTML = servers.length
    ? servers.map((s) => `<option value="${s.id}" data-username="${esc(s.username)}">${esc(s.name)} — ${esc(s.username)}@${esc(s.host)}${s.status && s.status !== 'unknown' ? ` · ${esc(s.status)}` : ''}</option>`).join('')
    : '<option value="">No servers yet — add a server first</option>';
  if (preset.serverId && servers.some((s) => String(s.id) === String(preset.serverId))) {
    $('#runner-server').value = String(preset.serverId);
  }

  if (!servers.length) {
    formMsg($('#runner-form-msg'), 'Add a server first — a runner has to live on one of your machines.', 'err');
  }

  applyRunnerKind();
  syncRunnerServiceUser();
  await loadRunnerTargets(preset.target);
}

/** GitHub and GitLab runners are installed differently, so the form follows the account. */
function applyRunnerKind() {
  const account = runnerAccounts.find((a) => String(a.id) === $('#runner-account').value);
  const isGitlab = account?.extra?.kind === 'gitlab';
  $('#runner-github-fields').classList.toggle('hidden', isGitlab);
  $('#runner-gitlab-fields').classList.toggle('hidden', !isGitlab);
  $('#runner-target-label').textContent = $('#runner-scope').value === 'org'
    ? (isGitlab ? 'Group' : 'Organisation')
    : (isGitlab ? 'Project' : 'Repository');
  $('#runner-server-hint').textContent = isGitlab
    ? 'The gitlab-runner package is installed on this server (once) and registered against the project.'
    : "The GitHub Actions runner is downloaded onto this server and kept running by its own systemd service.";
}

function syncRunnerServiceUser() {
  const option = $('#runner-server').selectedOptions[0];
  $('#runner-service-user').placeholder = option?.dataset.username || 'root';
}

async function loadRunnerTargets(preselect = null) {
  const select = $('#runner-target');
  const id = $('#runner-account').value;
  const scope = $('#runner-scope').value;
  if (!id) return void (select.innerHTML = '<option value="">Connect a git account first</option>');

  select.innerHTML = '<option value="">Loading…</option>';
  try {
    if (scope === 'org') {
      const r = await api(`/credentials/${id}/git/organizations`, { method: 'POST' });
      select.innerHTML = r.organizations.length
        ? r.organizations.map((o) => `<option value="${esc(o.login)}">${esc(o.login)}${o.name && o.name !== o.login ? ` — ${esc(o.name)}` : ''}</option>`).join('')
        : '<option value="">This account is not an admin of any organisation</option>';
    } else {
      const r = await api(`/credentials/${id}/git/repositories`, { method: 'POST' });
      select.innerHTML = r.repositories.length
        ? r.repositories.map((repo) => `<option value="${esc(repo.fullName)}">${esc(repo.fullName)}${repo.private ? ' (private)' : ''}</option>`).join('')
        : '<option value="">This account can see no repositories</option>';
    }
    // Opened from a repository page, that repository is already the answer.
    if (preselect && [...select.options].some((o) => o.value === preselect)) select.value = preselect;
  } catch (err) {
    select.innerHTML = `<option value="">${esc(err.message)}</option>`;
  }
}

$('#runner-account').addEventListener('change', () => { applyRunnerKind(); loadRunnerTargets(); });
$('#runner-scope').addEventListener('change', () => { applyRunnerKind(); loadRunnerTargets(); });
$('#runner-server').addEventListener('change', syncRunnerServiceUser);

runnerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter || $('button[type=submit]', runnerForm);
  const msg = $('#runner-form-msg');
  const log = $('#runner-form-log');
  const body = Object.fromEntries(new FormData(runnerForm).entries());

  if (!body.credential_id) return formMsg(msg, 'Connect a git account first.', 'err');
  if (!body.server_id) return formMsg(msg, 'Add a server first — the runner has to run somewhere.', 'err');
  if (!body.target) return formMsg(msg, 'Pick the repository or organisation this runner belongs to.', 'err');

  busy(btn, true, 'Installing…');
  log.classList.add('hidden');
  formMsg(msg, 'Registering with the provider and installing on the server. A first install downloads the runner, so this can take a couple of minutes…', 'info');

  try {
    const created = await api('/runners', { method: 'POST', body });
    runnerModal.classList.add('hidden');
    toast(`Runner "${created.name}" is installed on ${created.server?.name} for ${created.target}`);
    if (!$('#view-git-detail').classList.contains('hidden')) loadGitRunners();
    if (!$('#view-server-detail').classList.contains('hidden')) refreshServerTab('runners');
  } catch (err) {
    formMsg(msg, err.message, 'err');
    if (err.detail) {
      log.textContent = err.detail;
      log.classList.remove('hidden');
    }
  }
  busy(btn, false);
});

/* --------------------------------------------------- Databases: list */

/** Every database engine the panel connects to. MySQL has its own page; the rest share one. */
const DB_ENGINES = {
  mysql: { label: 'MySQL', icon: '🐬', port: 3306, dbLabel: 'Default database', userHint: 'root or an app user' },
  postgres: { label: 'PostgreSQL', icon: '🐘', port: 5432, dbLabel: 'Database to connect to', userHint: 'postgres or an app role' },
  mongodb: { label: 'MongoDB', icon: '🍃', port: 27017, dbLabel: 'Default database', userHint: 'empty if authentication is off' },
  redis: { label: 'Redis', icon: '⚡', port: 6379, dbLabel: 'Database number (0–15)', userHint: 'empty for the "default" user' },
};
const DB_PROVIDERS = Object.keys(DB_ENGINES);
let dbFilter = 'all';

async function loadMysqlList() {
  const box = $('#mysql-list');
  box.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const all = await api(`/credentials?provider=${DB_PROVIDERS.join(',')}`);
    const counts = Object.fromEntries(DB_PROVIDERS.map((p) => [p, all.filter((c) => c.provider === p).length]));
    $('#db-engine-filter').innerHTML = [['all', 'All', all.length], ...DB_PROVIDERS.map((p) => [p, `${DB_ENGINES[p].icon} ${DB_ENGINES[p].label}`, counts[p]])]
      .map(([key, text, n]) => `<button class="btn tiny ${dbFilter === key ? 'primary' : ''}" data-db-filter="${key}">${esc(text)} <span class="muted">${n}</span></button>`).join('');

    const list = dbFilter === 'all' ? all : all.filter((c) => c.provider === dbFilter);
    if (!list.length) {
      box.innerHTML = `<div class="empty">No ${dbFilter === 'all' ? 'database' : DB_ENGINES[dbFilter].label} connections yet. Click <b>+ Add database connection</b> to connect MySQL, PostgreSQL, MongoDB or Redis — or install one from <b>Installations</b> and it appears here by itself.</div>`;
      return;
    }
    box.innerHTML = list.map((c) => {
      const eng = DB_ENGINES[c.provider];
      return `
      <div class="card">
        <div class="card-head">
          <div>
            <h3>${eng.icon} ${esc(c.name)}</h3>
            <div class="muted small">${eng.label} · ${c.username ? `${esc(c.username)}@` : ''}${esc(c.extra.host)}:${esc(c.extra.port)}${c.extra.database ? ` · ${esc(c.extra.database)}` : ''}</div>
          </div>
          <span class="badge ${c.status === 'valid' ? 'ok' : c.status === 'invalid' ? 'err' : ''}">${esc(c.status)}</span>
        </div>
        <dl class="kv">
          <dt>Connection</dt><dd>${c.server ? `tunnelled via <b>${esc(c.server.name)}</b> <span class="muted small">(${esc(c.server.host)})</span>` : 'direct'}${c.extra.tls ? ' · TLS' : ''}</dd>
          <dt>Password</dt><dd>${c.secretHint ? `<code>${esc(c.secretHint)}</code>` : '<span class="muted">none</span>'}</dd>
          <dt>Last checked</dt><dd>${val(c.verified_at)}</dd>
        </dl>
        ${c.last_error ? `<div class="msg err" style="margin-top:10px">${esc(c.last_error)}</div>` : ''}
        <div class="card-actions">
          <button class="btn tiny" data-my-action="open" data-id="${c.id}" data-provider="${c.provider}">Open</button>
          <button class="btn tiny" data-my-action="verify" data-id="${c.id}">Test</button>
          ${ifCan('edit', `<button class="btn tiny" data-my-action="edit" data-id="${c.id}">Edit</button>`)}
          ${ifCan('delete', `<button class="btn tiny danger" data-my-action="delete" data-id="${c.id}">Delete</button>`)}
        </div>
      </div>`;
    }).join('');
  } catch (err) {
    box.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

$('#db-engine-filter').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-db-filter]');
  if (!btn) return;
  dbFilter = btn.dataset.dbFilter;
  loadMysqlList();
});

/** Open a connection on the page that belongs to its engine. */
function openDbConnection(id, provider) {
  return provider === 'mysql' ? openMysql(id) : openEngine(id);
}

$('#mysql-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-my-action]');
  if (!btn) return;
  const { myAction, id } = btn.dataset;

  if (myAction === 'open') return openDbConnection(id, btn.dataset.provider);
  if (myAction === 'edit') return editMysqlConnection(id);
  if (myAction === 'delete') {
    if (!confirm('Delete this connection? The database itself is not touched.')) return;
    await api(`/credentials/${id}`, { method: 'DELETE' });
    toast('Connection removed');
    return loadMysqlList();
  }
  busy(btn, true, 'Testing…');
  try {
    const r = await api(`/credentials/${id}/verify`, { method: 'POST' });
    const version = /^d/.test(r.detail.version) ? `MySQL ${r.detail.version}` : r.detail.version;
    toast(`Connected — ${version} as ${r.detail.currentUser} (${r.detail.latencyMs}ms)`);
  } catch (err) {
    toast(err.message, 'err');
  }
  await loadMysqlList();
});

$('#btn-add-mysql').addEventListener('click', () => openCredModal(DB_ENGINES[dbFilter] ? dbFilter : 'mysql'));

async function editMysqlConnection(id) {
  try {
    const cred = await api(`/credentials/${id}`);
    openCredModal(cred.provider, cred);
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ---------------------------------------------------- MySQL: detail */

let currentMysqlId = null;

/**
 * One MySQL connection, split into tabs. Each tab is read the first time it is
 * opened and kept until Refresh; what a change touches is re-read right after.
 */
const MYSQL_TABS = [
  { key: 'overview', label: 'Overview', load: () => loadMysqlOverview() },
  { key: 'databases', label: 'Databases', load: () => loadMysqlDatabases() },
  { key: 'users', label: 'Users', load: () => loadMysqlUsers() },
  { key: 'config', label: 'Configuration', load: () => loadMysqlConfig() },
];

let mysqlTab = 'overview';
let mysqlLoaded = new Set();
/** What each tab last read: overview facts, users, variables, charsets. */
let my = {};

const myApi = (path, options = { method: 'POST' }) => api(`/credentials/${currentMysqlId}/mysql${path}`, options);
const myPanel = (key) => $(`#mysql-panel-${key}`);
const myLoading = (key, text = 'Reading…') => { myPanel(key).innerHTML = `<div class="empty"><span class="spinner"></span>${esc(text)}</div>`; };
const myError = (key, err) => { myPanel(key).innerHTML = `<div class="msg err">${esc(err.message)}</div>`; };

async function openMysql(id, { reset = false } = {}) {
  if (reset || String(id) !== String(currentMysqlId)) mysqlTab = 'overview';
  currentMysqlId = id;
  mysqlLoaded = new Set();
  my = {};
  show('mysql-detail');

  $('#mysql-tabs').innerHTML = MYSQL_TABS.map((t) => `<button class="tab ${t.key === mysqlTab ? 'active' : ''}" data-my-tab="${t.key}"><span>${esc(t.label)}</span><span class="tab-count" id="my-count-${t.key}"></span></button>`).join('');
  $('#mysql-body').innerHTML = MYSQL_TABS.map((t) => `<div class="tab-panel" data-panel="${t.key}" id="mysql-panel-${t.key}" ${t.key === mysqlTab ? '' : 'hidden'}></div>`).join('');

  try {
    const cred = await api(`/credentials/${id}`);
    $('#mysql-name').textContent = cred.name;
    $('#mysql-sub').textContent = `${cred.username}@${cred.extra.host}:${cred.extra.port}`
      + (cred.server ? ` · tunnelled via ${cred.server.name} (${cred.server.host})` : ' · direct connection');
  } catch (err) {
    $('#mysql-body').innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
    return;
  }
  showMysqlTab(mysqlTab);
}

function showMysqlTab(key) {
  const tab = MYSQL_TABS.find((t) => t.key === key) || MYSQL_TABS[0];
  mysqlTab = tab.key;
  $$('#mysql-tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.myTab === tab.key));
  $$('#mysql-body > .tab-panel').forEach((p) => { p.hidden = p.dataset.panel !== tab.key; });
  if (!mysqlLoaded.has(tab.key)) {
    mysqlLoaded.add(tab.key);
    tab.load();
  }
}

function setMyCount(key, n) {
  const el = $(`#my-count-${key}`);
  if (el) el.textContent = n === null || n === undefined ? '' : String(n);
}

$('#mysql-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-my-tab]');
  if (btn) showMysqlTab(btn.dataset.myTab);
});

$('#btn-mysql-back').addEventListener('click', () => { show('databases'); loadMysqlList(); });
$('#btn-mysql-refresh').addEventListener('click', () => {
  // Refresh re-reads the tab you are on, and forgets the others.
  mysqlLoaded = new Set([mysqlTab]);
  my = {};
  MYSQL_TABS.find((t) => t.key === mysqlTab).load();
});
$('#btn-mysql-edit').addEventListener('click', () => editMysqlConnection(currentMysqlId));

/** The overview facts, read once and shared by the overview and databases tabs. */
async function mysqlFacts(force = false) {
  if (!my.overview || force) my.overview = await myApi('/overview');
  setMyCount('databases', my.overview.totals.databases);
  if (!my.overview.usersError) setMyCount('users', my.overview.users.length);
  return my.overview;
}

/* overview */

async function loadMysqlOverview() {
  myLoading('overview', 'Connecting…');
  try {
    myPanel('overview').innerHTML = renderMysqlOverview(await mysqlFacts(true));
  } catch (err) {
    myError('overview', err);
  }
}

function renderMysqlOverview(o) {
  const s = o.server;
  const r = o.runtime;
  const connPct = r.maxConnections ? Math.round((r.threadsConnected / r.maxConnections) * 100) : null;
  const users = o.users || [];
  const locked = users.filter((u) => u.locked).length;
  const out = [];

  out.push(section('Statistics', `<div class="tiles">
    ${tile('Version', val(s.version), val(s.flavor))}
    ${tile('Uptime', val(r.uptimeHuman), `${r.questions.toLocaleString()} queries served`)}
    ${tile('Databases', val(o.totals.databases), `${o.totals.tables} tables · ${bytes(o.totals.sizeBytes)}`)}
    ${tile('Rows (approx)', o.totals.approxRows.toLocaleString(), 'across user databases')}
    ${tile('Users', o.usersError ? '—' : val(users.length), o.usersError ? 'cannot read mysql.user' : `${locked} locked · ${users.length - locked} active`)}
    ${tile('Connections', `${r.threadsConnected} / ${r.maxConnections}`, `${r.threadsRunning} running · peak ${r.maxUsedConnections}`, connPct)}
    ${tile('Total connections', r.connections.toLocaleString(), `${r.abortedConnects} aborted`)}
    ${tile('Slow queries', val(r.slowQueries), r.uptimeSeconds ? `${(r.questions / r.uptimeSeconds).toFixed(1)} queries / s` : '')}
    ${tile('Buffer pool', bytes(r.bufferPoolBytes), `engine ${val(s.defaultEngine)}`)}
    ${tile('Traffic', bytes(r.bytesSent), `${bytes(r.bytesReceived)} received`)}
    ${tile('Binary log', s.binlog ? 'enabled' : 'disabled', s.readOnly ? 'server is READ ONLY' : 'read-write')}
  </div>`));

  out.push(section('Connection', `<div class="two-col">
    ${kvCard('Server', [
      ['Hostname', val(s.hostname)],
      ['Port', val(s.port)],
      ['Data directory', `<code>${val(s.datadir)}</code>`],
      ['Character set', `${val(s.charset)} / ${val(s.collation)}`],
      ['Default engine', val(s.defaultEngine)],
      ['Read only', s.readOnly ? '<span class="badge warn">yes</span>' : 'no'],
    ])}
    ${kvCard('Session', [
      ['Connected as', `<code>${val(s.currentUser)}</code>`],
      ['Login user', `<code>${val(s.loginUser)}</code>`],
      ['Max allowed packet', bytes(r.maxAllowedPacket)],
      ['Wait timeout', `${val(r.waitTimeout)}s`],
      ['SQL mode', `<span class="small">${val(s.sqlMode)}</span>`],
    ])}
  </div>`));

  if (o.topTables?.length) {
    out.push(section('Largest tables', table(
      [{ label: 'Table' }, { label: 'Engine' }, { label: 'Rows (approx)', num: true }, { label: 'Data', num: true }, { label: 'Indexes', num: true }, { label: 'Total', num: true }],
      o.topTables.map((t) => [
        `<button class="link-db" data-db="${esc(t.schema)}" data-table="${esc(t.name)}">${esc(t.schema)}.<b>${esc(t.name)}</b></button>`,
        val(t.engine), t.approxRows.toLocaleString(), bytes(t.dataBytes), bytes(t.indexBytes), `<b>${bytes(t.totalBytes)}</b>`,
      ])
    )));
  }

  out.push(section('Current sessions', o.processesError
    ? `<div class="card"><p class="muted small" style="margin:0">${esc(o.processesError)}</p></div>`
    : table(
      [{ label: 'ID', num: true }, { label: 'User' }, { label: 'Host' }, { label: 'DB' }, { label: 'Command' }, { label: 'Time', num: true }, { label: 'State' }],
      (o.processes || []).map((p) => [val(p.id), val(p.user), `<span class="small">${val(p.host)}</span>`, val(p.db), val(p.command), `${val(p.seconds)}s`, `<span class="small">${val(p.state)}</span>`])
    )));

  out.push(`<p class="muted small">Read ${esc(o.collectedAt)} in ${esc(o.durationMs)}ms.</p>`);
  return out.join('');
}

/* databases */

async function loadMysqlDatabases(force = false) {
  my.openDb = null;
  myLoading('databases');
  try {
    renderMysqlDatabases(await mysqlFacts(force));
  } catch (err) {
    myError('databases', err);
  }
}

function renderMysqlDatabases(o) {
  myPanel('databases').innerHTML = `
    <div class="section">
      <div class="section-head">
        <h2>Databases</h2>
        <div class="section-tools">
          <input type="search" id="my-db-filter" placeholder="Filter databases" />
          ${ifCan('create', '<button class="btn tiny primary" data-db-action="create">+ Create database</button>')}
        </div>
      </div>
      <div class="tiles" style="margin-bottom:14px">
        ${tile('Databases', val(o.totals.databases), `${(o.systemDatabases || []).length} system schemas hidden`)}
        ${tile('Tables', val(o.totals.tables), '')}
        ${tile('Rows (approx)', o.totals.approxRows.toLocaleString(), '')}
        ${tile('Size', bytes(o.totals.sizeBytes), 'data + indexes')}
      </div>
      ${o.databasesError ? `<div class="msg err" style="margin-bottom:12px">${esc(o.databasesError)}</div>` : ''}
      <div id="my-db-table">${table(
        [{ label: 'Database' }, { label: 'Tables', num: true }, { label: 'Rows (approx)', num: true }, { label: 'Data', num: true }, { label: 'Indexes', num: true }, { label: 'Total', num: true }, { label: 'Charset / collation' }, { label: '' }],
        (o.databases || []).map((d) => [
          `<button class="link-db" data-db="${esc(d.name)}">${esc(d.name)}</button>`,
          val(d.tableCount), d.approxRows.toLocaleString(), bytes(d.dataBytes), bytes(d.indexBytes),
          `<b>${bytes(d.totalBytes)}</b>`, `<span class="small">${val(d.charset)} / ${val(d.collation)}</span>`,
          `<div class="row-actions">
            <button class="btn tiny" data-db-action="open" data-db="${esc(d.name)}">Details</button>
            ${ifCan('edit', `<button class="btn tiny" data-db-action="alter" data-db="${esc(d.name)}" data-charset="${esc(d.charset)}" data-collation="${esc(d.collation)}">Charset</button>`)}
            ${ifCan('delete', `<button class="btn tiny danger" data-db-action="drop" data-db="${esc(d.name)}">Drop</button>`)}
          </div>`,
        ]),
        'No user databases on this server'
      )}</div>
    </div>`;
}

$('#mysql-body').addEventListener('input', (e) => {
  if (e.target.id === 'my-db-filter') {
    const q = e.target.value.trim().toLowerCase();
    $$('#my-db-table tbody tr').forEach((tr) => { tr.hidden = q && !tr.cells[0].textContent.toLowerCase().includes(q); });
  }
  if (e.target.id === 'my-var-filter') {
    const q = e.target.value.trim().toLowerCase();
    $$('#my-var-table tbody tr').forEach((tr) => { tr.hidden = q && !tr.textContent.toLowerCase().includes(q); });
  }
});

/** One database: statistics, who can reach it, who is in it, and what it holds. */
async function openMysqlDatabase(db) {
  if (mysqlTab !== 'databases') {
    mysqlLoaded.add('databases');
    showMysqlTab('databases');
  }
  my.openDb = db;
  myLoading('databases');
  try {
    myPanel('databases').innerHTML = renderDatabaseDetail(await myApi(`/databases/${encodeURIComponent(db)}`));
  } catch (err) {
    myError('databases', err);
  }
}

async function openMysqlTable(db, tableName) {
  if (mysqlTab !== 'databases') {
    mysqlLoaded.add('databases');
    showMysqlTab('databases');
  }
  my.openDb = null;
  myLoading('databases');
  try {
    myPanel('databases').innerHTML = renderTableDetail(await myApi(`/databases/${encodeURIComponent(db)}/tables/${encodeURIComponent(tableName)}`));
  } catch (err) {
    myError('databases', err);
  }
}

function renderDatabaseDetail(d) {
  const t = d.totals;
  const engines = Object.entries(d.engines || {}).map(([k, n]) => `${esc(k)} ${n}`).join(' · ');
  const accounts = [...new Set((d.access || []).map((a) => `${a.user}@${a.host}`))];
  return `
    <button class="link-back" data-my-nav="databases">← all databases</button>
    <div class="section">
      <div class="section-head">
        <h2>${esc(d.database)}</h2>
        <div class="section-tools">
          ${ifCan('create', `<button class="btn tiny" data-user-action="create" data-db="${esc(d.database)}">+ User for this database</button>`)}
          ${ifCan('edit', `<button class="btn tiny" data-db-action="alter" data-db="${esc(d.database)}" data-charset="${esc(d.charset)}" data-collation="${esc(d.collation)}">Charset</button>`)}
          ${ifCan('delete', `<button class="btn tiny danger" data-db-action="drop" data-db="${esc(d.database)}">Drop database</button>`)}
        </div>
      </div>
      <div class="tiles">
        ${tile('Tables', val(t.tables), `${t.views} views · ${t.columns} columns`)}
        ${tile('Rows (approx)', t.approxRows.toLocaleString(), engines || '')}
        ${tile('Data', bytes(t.dataBytes), `${bytes(t.indexBytes)} indexes`)}
        ${tile('Total size', bytes(t.dataBytes + t.indexBytes), `${val(d.charset)} / ${val(d.collation)}`)}
        ${tile('Users with access', val(t.users), d.accessError ? 'cannot read mysql.db' : `${(d.access || []).filter((a) => a.scope !== '*').length} granted here · rest global`)}
        ${tile('Open sessions', val(t.sessions), 'connections using this database now')}
        ${tile('Routines', val(t.routines), `${t.triggers} triggers · ${t.events} events`)}
      </div>
    </div>
    ${section('Tables', table(
      [{ label: 'Table' }, { label: 'Engine' }, { label: 'Rows', num: true }, { label: 'Data', num: true }, { label: 'Indexes', num: true }, { label: 'Auto inc', num: true }, { label: 'Updated' }, { label: 'Comment' }],
      d.tables.map((x) => [
        `<button class="link-db" data-db="${esc(d.database)}" data-table="${esc(x.name)}"><b>${esc(x.name)}</b></button>`,
        val(x.engine), Number(x.approxRows || 0).toLocaleString(), bytes(x.dataBytes), bytes(x.indexBytes),
        val(x.autoIncrement), `<span class="small">${val(x.updatedAt)}</span>`, `<span class="small">${val(x.comment)}</span>`,
      ]),
      'This database has no tables'
    ))}
    ${section('Users with access', d.accessError
      ? `<div class="card"><p class="muted small" style="margin:0">This MySQL user cannot read <code>mysql.db</code>: ${esc(d.accessError)}</p></div>`
      : table(
        [{ label: 'Account' }, { label: 'Scope' }, { label: 'Privileges' }, { label: '' }],
        (d.access || []).map((a) => [
          `<b>${esc(a.user)}</b><span class="muted">@${esc(a.host)}</span>`,
          a.scope === '*' ? '<span class="badge">all databases</span>' : `<code>${esc(a.scope)}</code>`,
          `<span class="small">${a.privileges.length >= 15 ? 'ALL PRIVILEGES' : esc(a.privileges.join(', '))}</span>`,
          a.scope === '*' ? '' : ifCan('delete', `<div class="row-actions"><button class="btn tiny danger" data-user-action="revoke" data-user="${esc(a.user)}" data-host="${esc(a.host)}" data-db="${esc(a.scope)}">Revoke</button></div>`),
        ]),
        'No account has been granted access to this database'
      ))}
    <p class="muted small" style="margin-top:-6px">${accounts.length} account(s). Manage them on the <button class="link-db" data-my-nav="users">Users</button> tab.</p>
    ${d.sessions.length ? section('Open sessions', table(
      [{ label: 'ID', num: true }, { label: 'User' }, { label: 'Host' }, { label: 'Command' }, { label: 'Time', num: true }, { label: 'State' }],
      d.sessions.map((p) => [val(p.id), val(p.user), `<span class="small">${val(p.host)}</span>`, val(p.command), `${val(p.seconds)}s`, `<span class="small">${val(p.state)}</span>`])
    )) : ''}
    ${d.views.length ? section('Views', `<div class="card"><div class="chips">${d.views.map((v) => `<span class="chip">${esc(v)}</span>`).join('')}</div></div>`) : ''}
    ${d.routines.length ? section('Routines', `<div class="card"><div class="chips">${d.routines.map((r) => `<span class="chip"><b>${esc(r.type)}</b> ${esc(r.name)}</span>`).join('')}</div></div>`) : ''}
    ${d.triggers.length ? section('Triggers', table(
      [{ label: 'Trigger' }, { label: 'Table' }, { label: 'When' }],
      d.triggers.map((x) => [`<b>${esc(x.name)}</b>`, `<code>${esc(x.tableName)}</code>`, `${esc(x.timing)} ${esc(x.event)}`])
    )) : ''}
    ${d.events.length ? section('Events', table(
      [{ label: 'Event' }, { label: 'Status' }, { label: 'Every' }],
      d.events.map((x) => [`<b>${esc(x.name)}</b>`, val(x.status), x.intervalValue ? `${esc(x.intervalValue)} ${esc(x.intervalField)}` : 'once'])
    )) : ''}
  `;
}

function renderTableDetail(t) {
  return `
    <button class="link-back" data-my-nav="db" data-db="${esc(t.database)}">← ${esc(t.database)}</button>
    ${section(`${t.database}.${t.table}`, table(
      [{ label: 'Column' }, { label: 'Type' }, { label: 'Null' }, { label: 'Key' }, { label: 'Default' }, { label: 'Extra' }, { label: 'Comment' }],
      t.columns.map((c) => [
        `<b>${esc(c.name)}</b>`, `<code>${esc(c.type)}</code>`, val(c.nullable),
        c.keyType ? `<span class="badge ${c.keyType === 'PRI' ? 'ok' : ''}">${esc(c.keyType)}</span>` : '—',
        val(c.defaultValue), `<span class="small">${val(c.extra)}</span>`, `<span class="small">${val(c.comment)}</span>`,
      ])
    ))}
    ${section('Indexes', table(
      [{ label: 'Index' }, { label: 'Columns' }, { label: 'Unique' }, { label: 'Type' }],
      t.indexes.map((i) => [
        `<b>${esc(i.name)}</b>`, `<code>${esc(i.columns)}</code>`,
        Number(i.nonUnique) === 0 ? '<span class="badge ok">yes</span>' : 'no', val(i.type),
      ]),
      'No indexes'
    ))}
    ${t.foreignKeys.length ? section('Foreign keys', table(
      [{ label: 'Constraint' }, { label: 'Column' }, { label: 'References' }],
      t.foreignKeys.map((f) => [esc(f.name), `<code>${esc(f.column_name)}</code>`, `<code>${esc(f.refTable)}.${esc(f.refColumn)}</code>`])
    )) : ''}
  `;
}

/* users */

async function loadMysqlUsers() {
  myLoading('users');
  try {
    my.users = await myApi('/users/list');
    setMyCount('users', my.users.totals.users);
    renderMysqlUsers(my.users);
  } catch (err) {
    myError('users', err);
  }
}

function renderMysqlUsers(u) {
  const t = u.totals;
  myPanel('users').innerHTML = `
    <div class="section">
      <div class="section-head">
        <h2>User management</h2>
        <div class="section-tools">
          <label class="check"><input type="checkbox" id="my-show-system" /> Show internal accounts</label>
          ${ifCan('create', '<button class="btn tiny primary" data-user-action="create">+ Create user</button>')}
        </div>
      </div>
      <div class="tiles" style="margin-bottom:14px">
        ${tile('Total users', val(t.users), `${u.users.filter((x) => !x.system).length} excluding MySQL internal accounts`)}
        ${tile('Active', val(t.users - t.locked), `${t.withSessions} connected now`)}
        ${tile('Locked', val(t.locked), 'cannot sign in')}
        ${tile('Password expired', val(t.expired), 'must change on next login')}
      </div>
      <p class="muted small">The panel is connected as <code>${esc(u.currentUser)}</code>. Managing users needs the <code>CREATE USER</code> and <code>GRANT OPTION</code> privileges.</p>
      <div id="my-user-table">${table(
        [{ label: 'Account' }, { label: 'Auth' }, { label: 'State' }, { label: 'Sessions', num: true }, { label: 'Grants' }, { label: '' }],
        u.users.map((x) => {
          const me = u.currentUser === `${x.user}@${x.host}`;
          return [
            `<b>${esc(x.user)}</b><span class="muted">@${esc(x.host)}</span>${me ? ' <span class="badge ok">panel</span>' : ''}${x.system ? ' <span class="badge">internal</span>' : ''}`,
            `<span class="small">${val(x.plugin)}</span>`,
            x.locked ? '<span class="badge err">locked</span>' : x.passwordExpired ? '<span class="badge warn">password expired</span>' : '<span class="badge ok">active</span>',
            val(x.sessions),
            `<details><summary class="small">${x.grants.length} grant(s)</summary>${x.grants.map((g) => `<div><code class="small">${esc(g)}</code></div>`).join('')}</details>`,
            `<div class="row-actions">
              ${ifCan('create', `<button class="btn tiny" data-user-action="grant" data-user="${esc(x.user)}" data-host="${esc(x.host)}">Grant</button>`)}
              ${ifCan('delete', `<button class="btn tiny" data-user-action="revoke" data-user="${esc(x.user)}" data-host="${esc(x.host)}">Revoke</button>`)}
              ${ifCan('edit', `<button class="btn tiny" data-user-action="password" data-user="${esc(x.user)}" data-host="${esc(x.host)}">Password</button>`)}
              ${ifCan('edit', me ? '' : `<button class="btn tiny" data-user-action="${x.locked ? 'unlock' : 'lock'}" data-user="${esc(x.user)}" data-host="${esc(x.host)}">${x.locked ? 'Unlock' : 'Lock'}</button>`)}
              ${ifCan('delete', me ? '' : `<button class="btn tiny danger" data-user-action="drop" data-user="${esc(x.user)}" data-host="${esc(x.host)}">Drop</button>`)}
            </div>`,
          ];
        }),
        'This account cannot list MySQL users'
      )}</div>
    </div>`;
  applySystemUserFilter();
}

function applySystemUserFilter() {
  const showSystem = $('#my-show-system')?.checked;
  const users = my.users?.users || [];
  $$('#my-user-table tbody tr').forEach((tr, i) => { tr.hidden = !showSystem && users[i]?.system; });
}

$('#mysql-body').addEventListener('change', (e) => {
  if (e.target.id === 'my-show-system') applySystemUserFilter();
});

/* configuration */

async function loadMysqlConfig() {
  myLoading('config');
  try {
    my.vars = await myApi('/variables');
    renderMysqlConfig(my.vars);
  } catch (err) {
    myError('config', err);
  }
}

const varValue = (v) => (v.unit === 'bytes' && /^\d+$/.test(v.value) ? `${esc(v.value)} <span class="muted small">(${bytes(Number(v.value))})</span>` : `<code>${val(v.value)}</code>`);

function renderMysqlConfig(c) {
  const groups = {};
  for (const v of c.editable) (groups[v.group] ||= []).push(v);

  myPanel('config').innerHTML = `
    <p class="muted small">Changes apply at once with <code>SET GLOBAL</code>${c.persistSupported ? ', and can be persisted with <code>SET PERSIST</code> so they survive a restart' : ' and are lost when MySQL restarts — put them in <code>my.cnf</code> to keep them'}. They need the <code>SYSTEM_VARIABLES_ADMIN</code> (or <code>SUPER</code>) privilege.</p>
    ${Object.entries(groups).map(([group, vars]) => section(group, table(
      [{ label: 'Setting' }, { label: 'Value' }, { label: 'What it does' }, { label: '' }],
      vars.map((v) => [
        `<b>${esc(v.name)}</b>`, varValue(v), `<span class="small muted">${esc(v.hint)}</span>`,
        ifCan('edit', `<div class="row-actions"><button class="btn tiny" data-var-edit="${esc(v.name)}">Change</button></div>`),
      ])
    ))).join('')}
    <div class="section">
      <div class="section-head">
        <h2>All server variables</h2>
        <div class="section-tools"><input type="search" id="my-var-filter" placeholder="Filter ${c.variables.length} variables" /></div>
      </div>
      <div class="scroll-table card" id="my-var-table" style="padding:4px 0">
        <table>
          <thead><tr><th>Variable</th><th>Value</th></tr></thead>
          <tbody>${c.variables.map((v) => `<tr><td>${v.editable ? `<b>${esc(v.name)}</b>` : esc(v.name)}</td><td><span class="small" style="word-break:break-all">${val(v.value)}</span></td></tr>`).join('')}</tbody>
        </table>
      </div>
    </div>`;
}

/* ------------------------------------------ MySQL: management dialogs */

const myDialog = $('#modal-mysql-action');
const myDialogForm = $('#form-mysql-action');
let myDialogSubmit = null;

/**
 * One modal for every change: `fields` is its form HTML, `submit` turns the
 * FormData into an API call and returns the toast text, `after` re-reads
 * whatever the change touched.
 */
function openMyDialog({ title, intro = '', fields, submitLabel = 'Save', danger = false, submit, after, onOpen }) {
  $('#mysql-action-title').textContent = title;
  $('#mysql-action-intro').innerHTML = intro;
  $('#mysql-action-fields').innerHTML = fields;
  $('#mysql-action-msg').classList.add('hidden');
  const btn = $('#mysql-action-submit');
  btn.textContent = submitLabel;
  btn.classList.toggle('danger', danger);
  btn.classList.toggle('primary', !danger);
  myDialogSubmit = { submit, after };
  myDialog.classList.remove('hidden');
  onOpen?.(myDialogForm);
  myDialogForm.querySelector('input:not([type=hidden]):not([type=checkbox]), select')?.focus();
}

myDialogForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter || $('#mysql-action-submit');
  busy(btn, true, 'Working…');
  try {
    const message = await myDialogSubmit.submit(new FormData(myDialogForm));
    myDialog.classList.add('hidden');
    toast(message);
    await myDialogSubmit.after?.();
  } catch (err) {
    formMsg($('#mysql-action-msg'), err.message, 'err');
  }
  busy(btn, false);
});

/** Database names for pickers, from the overview facts. */
async function databaseNames() {
  try {
    return (await mysqlFacts()).databases.map((d) => d.name);
  } catch {
    return [];
  }
}

async function charsetInfo() {
  if (!my.charsets) my.charsets = await myApi('/charsets');
  return my.charsets;
}

/** Charset + collation pickers that keep each other honest. */
async function charsetFields(charset, collation) {
  const c = await charsetInfo();
  const pick = charset || c.defaults.charset || 'utf8mb4';
  return {
    html: `<div class="row">
      <label>Character set<select name="charset">${c.charsets.map((x) => `<option value="${esc(x.name)}" ${x.name === pick ? 'selected' : ''}>${esc(x.name)} — ${esc(x.description)}</option>`).join('')}</select></label>
      <label>Collation<select name="collation"></select></label>
    </div>`,
    onOpen(form) {
      const fill = (keep) => {
        const cs = form.charset.value;
        const def = c.charsets.find((x) => x.name === cs)?.defaultCollation;
        form.collation.innerHTML = c.collations.filter((x) => x.charset === cs)
          .map((x) => `<option value="${esc(x.name)}" ${x.name === (keep || def) ? 'selected' : ''}>${esc(x.name)}${x.name === def ? ' (default)' : ''}</option>`).join('');
      };
      fill(collation);
      form.charset.addEventListener('change', () => fill());
    },
  };
}

const privilegeChecks = (list, checked = ['ALL PRIVILEGES']) => `<div class="chips" style="margin-top:6px">${list.map((p) => `
  <label class="check"><input type="checkbox" name="privileges" value="${esc(p)}" ${checked.includes(p) ? 'checked' : ''} /> ${esc(p)}</label>`).join('')}</div>`;

async function privilegeList() {
  if (my.users?.privileges) return my.users.privileges;
  return ['ALL PRIVILEGES', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'INDEX', 'REFERENCES',
    'CREATE VIEW', 'SHOW VIEW', 'CREATE ROUTINE', 'ALTER ROUTINE', 'EXECUTE', 'TRIGGER', 'EVENT', 'CREATE TEMPORARY TABLES', 'LOCK TABLES'];
}

async function databaseOptions(selected, { allowAll = true, allowNone = false } = {}) {
  const names = await databaseNames();
  return [
    allowNone ? `<option value="">— no database yet —</option>` : '',
    allowAll ? `<option value="*" ${selected === '*' ? 'selected' : ''}>* (all databases)</option>` : '',
    ...names.map((n) => `<option value="${esc(n)}" ${n === selected ? 'selected' : ''}>${esc(n)}</option>`),
  ].join('');
}

/** Re-read what a change touched, wherever you are looking. */
async function afterDatabaseChange(openDb) {
  my.overview = null;
  mysqlLoaded.delete('overview');
  if (openDb) return openMysqlDatabase(openDb);
  mysqlLoaded.add('databases');
  return loadMysqlDatabases(true);
}

async function afterUserChange() {
  my.overview = null;
  mysqlLoaded.delete('overview');
  mysqlLoaded.delete('users');
  if (mysqlTab === 'users') {
    mysqlLoaded.add('users');
    return loadMysqlUsers();
  }
  // A database's own page lists who can reach it, so re-read that too.
  if (mysqlTab === 'databases' && my.openDb) return openMysqlDatabase(my.openDb);
}

async function dbAction(action, db, btn) {
  if (action === 'open') return openMysqlDatabase(db);

  if (action === 'create') {
    const cs = await charsetFields();
    return openMyDialog({
      title: 'Create database',
      intro: 'utf8mb4 stores every character, emoji included — keep it unless you know you need something else.',
      fields: `<label>Name<input name="name" placeholder="shop_production" required pattern="[A-Za-z0-9_$\\-]{1,64}" /></label>${cs.html}
        <label class="check" style="margin-top:12px"><input type="checkbox" name="withUser" /> Also create a user with full access to it</label>
        <div class="row" id="my-db-user-fields" hidden>
          <label>Username<input name="user" placeholder="shop_app" /></label>
          <label>Host<input name="host" value="%" /></label>
          <label>Password<input name="password" type="password" autocomplete="new-password" minlength="8" /></label>
        </div>`,
      submitLabel: 'Create database',
      onOpen(form) {
        cs.onOpen(form);
        form.withUser.addEventListener('change', () => { $('#my-db-user-fields').hidden = !form.withUser.checked; });
      },
      async submit(fd) {
        const name = fd.get('name').trim();
        await myApi('/schemas', { method: 'POST', body: { name, charset: fd.get('charset'), collation: fd.get('collation') } });
        if (fd.get('withUser')) {
          await myApi('/users', { method: 'POST', body: { user: fd.get('user').trim(), host: fd.get('host').trim() || '%', password: fd.get('password'), database: name, privileges: ['ALL PRIVILEGES'] } });
          mysqlLoaded.delete('users');
          return `Created database ${name} and user ${fd.get('user')}`;
        }
        return `Created database ${name}`;
      },
      after: () => afterDatabaseChange(),
    });
  }

  if (action === 'alter') {
    const cs = await charsetFields(btn.dataset.charset, btn.dataset.collation);
    return openMyDialog({
      title: `Character set of ${db}`,
      intro: 'This changes the default for new tables only. Existing tables keep their own character set until they are converted.',
      fields: cs.html,
      onOpen: cs.onOpen,
      async submit(fd) {
        await myApi(`/databases/${encodeURIComponent(db)}`, { method: 'PUT', body: { charset: fd.get('charset'), collation: fd.get('collation') } });
        return `${db} now defaults to ${fd.get('charset')} / ${fd.get('collation')}`;
      },
      after: () => afterDatabaseChange(my.openDb),
    });
  }

  if (action === 'drop') {
    return openMyDialog({
      title: `Drop ${db}?`,
      intro: `<div class="msg err">Every table and every row in <b>${esc(db)}</b> is deleted for good. There is no undo — take a backup first if you might need it.</div>`,
      fields: `<label>Type <code>${esc(db)}</code> to confirm<input name="confirm" autocomplete="off" required /></label>`,
      submitLabel: 'Drop database',
      danger: true,
      async submit(fd) {
        if (fd.get('confirm') !== db) throw new Error('The name does not match');
        await myApi(`/databases/${encodeURIComponent(db)}`, { method: 'DELETE', body: { confirm: fd.get('confirm') } });
        return `Dropped database ${db}`;
      },
      after: () => afterDatabaseChange(),
    });
  }
}

async function userAction(action, { user, host, db }) {
  const who = `${user}@${host}`;

  if (action === 'create') {
    const privs = await privilegeList();
    return openMyDialog({
      title: 'Create MySQL user',
      intro: 'Host <code>%</code> lets the account connect from anywhere; <code>localhost</code> only from the server itself.',
      fields: `<div class="row">
          <label>Username<input name="user" placeholder="shop_app" required /></label>
          <label>Host<input name="host" value="%" required /></label>
        </div>
        <div class="row">
          <label>Password<input name="password" type="password" autocomplete="new-password" minlength="8" required /></label>
          <label class="narrow" style="align-self:end"><button type="button" class="btn tiny" id="my-gen-pass">Generate</button></label>
        </div>
        <label>Access to database<select name="database">${await databaseOptions(db || '', { allowNone: true })}</select></label>
        <div id="my-user-privs">${privilegeChecks(privs)}</div>`,
      submitLabel: 'Create user',
      onOpen(form) {
        $('#my-gen-pass').addEventListener('click', () => {
          const bytesArr = crypto.getRandomValues(new Uint8Array(18));
          form.password.type = 'text';
          form.password.value = btoa(String.fromCharCode(...bytesArr)).replace(/[+/=]/g, '').slice(0, 20);
        });
        const sync = () => { $('#my-user-privs').hidden = !form.database.value; };
        form.database.addEventListener('change', sync);
        sync();
      },
      async submit(fd) {
        await myApi('/users', { method: 'POST', body: {
          user: fd.get('user').trim(), host: fd.get('host').trim(), password: fd.get('password'),
          database: fd.get('database') || null, privileges: fd.getAll('privileges'),
        } });
        return `Created ${fd.get('user')}@${fd.get('host')}`;
      },
      after: afterUserChange,
    });
  }

  if (action === 'grant') {
    return openMyDialog({
      title: `Grant privileges to ${who}`,
      fields: `<label>On database<select name="database">${await databaseOptions(db || '')}</select></label>
        ${privilegeChecks(await privilegeList(), ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])}
        <label class="check" style="margin-top:12px"><input type="checkbox" name="grantOption" /> Let this user grant these privileges to others</label>`,
      submitLabel: 'Grant',
      async submit(fd) {
        const r = await myApi('/users/grants', { method: 'POST', body: {
          user, host, database: fd.get('database'), privileges: fd.getAll('privileges'), grantOption: Boolean(fd.get('grantOption')),
        } });
        return `Granted ${r.privileges.join(', ')} on ${r.database === '*' ? 'all databases' : r.database}`;
      },
      after: afterUserChange,
    });
  }

  if (action === 'revoke') {
    return openMyDialog({
      title: `Revoke privileges from ${who}`,
      intro: 'Removes every privilege the account holds at that level. The account itself stays.',
      fields: `<label>On database<select name="database">${await databaseOptions(db || '')}</select></label>`,
      submitLabel: 'Revoke',
      danger: true,
      async submit(fd) {
        await myApi('/users/grants', { method: 'DELETE', body: { user, host, database: fd.get('database') } });
        return `Revoked ${who}'s privileges on ${fd.get('database') === '*' ? 'all databases' : fd.get('database')}`;
      },
      after: afterUserChange,
    });
  }

  if (action === 'password') {
    return openMyDialog({
      title: `Change password of ${who}`,
      intro: 'Apps that sign in as this account need the new password too, or they will stop connecting.',
      fields: `<label>New password<input name="password" type="password" autocomplete="new-password" minlength="8" required /></label>
        <label>Max connections <span class="muted small">(optional — 0 means no limit)</span><input name="maxConnections" type="number" min="0" /></label>`,
      async submit(fd) {
        await myApi('/users', { method: 'PUT', body: { user, host, password: fd.get('password'), maxConnections: fd.get('maxConnections') } });
        return `Updated ${who}`;
      },
      after: afterUserChange,
    });
  }

  if (action === 'lock' || action === 'unlock') {
    const lock = action === 'lock';
    if (lock && !confirm(`Lock ${who}? It will not be able to sign in until unlocked. Open sessions stay connected.`)) return;
    try {
      await myApi('/users', { method: 'PUT', body: { user, host, locked: lock } });
      toast(`${who} ${lock ? 'locked' : 'unlocked'}`);
      await afterUserChange();
    } catch (err) {
      toast(err.message, 'err');
    }
    return;
  }

  if (action === 'drop') {
    return openMyDialog({
      title: `Drop ${who}?`,
      intro: `<div class="msg err">The account and all its grants are removed. Anything signing in as <b>${esc(who)}</b> stops working. Its data is not touched.</div>`,
      fields: `<label>Type <code>${esc(user)}</code> to confirm<input name="confirm" autocomplete="off" required /></label>`,
      submitLabel: 'Drop user',
      danger: true,
      async submit(fd) {
        if (fd.get('confirm') !== user) throw new Error('The name does not match');
        await myApi('/users', { method: 'DELETE', body: { user, host } });
        return `Dropped ${who}`;
      },
      after: afterUserChange,
    });
  }
}

function editVariable(name) {
  const v = my.vars.editable.find((x) => x.name === name);
  if (!v) return;
  const input = v.type === 'bool' || v.type === 'enum'
    ? `<select name="value">${(v.type === 'bool' ? ['ON', 'OFF'] : v.options).map((o) => `<option ${String(v.value).toUpperCase() === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`
    : `<input name="value" value="${esc(v.value)}" ${v.type === 'number' ? 'inputmode="decimal"' : ''} required />`;
  openMyDialog({
    title: `Change ${name}`,
    intro: `${esc(v.hint)}.${v.unit === 'bytes' ? ' Value in bytes — 134217728 is 128 MB.' : ''}`,
    fields: `<label>Value${input}</label>
      ${my.vars.persistSupported ? '<label class="check" style="margin-top:12px"><input type="checkbox" name="persist" checked /> Keep after a restart (SET PERSIST)</label>' : ''}`,
    submitLabel: 'Apply',
    async submit(fd) {
      const r = await myApi('/variables', { method: 'PUT', body: { name, value: fd.get('value'), persist: Boolean(fd.get('persist')) } });
      return `${name} = ${r.value}${r.persisted ? ' (persisted)' : ''}`;
    },
    after: () => { mysqlLoaded.delete('overview'); my.overview = null; return loadMysqlConfig(); },
  });
}

/* one click handler for everything inside a connection's page */
$('#mysql-body').addEventListener('click', async (e) => {
  const nav = e.target.closest('[data-my-nav]');
  if (nav) {
    const to = nav.dataset.myNav;
    if (to === 'databases') return loadMysqlDatabases();
    if (to === 'db') return openMysqlDatabase(nav.dataset.db);
    if (to === 'users') return showMysqlTab('users');
  }

  const link = e.target.closest('button.link-db');
  if (link && link.dataset.db) {
    return link.dataset.table ? openMysqlTable(link.dataset.db, link.dataset.table) : openMysqlDatabase(link.dataset.db);
  }

  const dbBtn = e.target.closest('button[data-db-action]');
  if (dbBtn) {
    try { await dbAction(dbBtn.dataset.dbAction, dbBtn.dataset.db, dbBtn); } catch (err) { toast(err.message, 'err'); }
    return;
  }

  const userBtn = e.target.closest('button[data-user-action]');
  if (userBtn) {
    try { await userAction(userBtn.dataset.userAction, userBtn.dataset); } catch (err) { toast(err.message, 'err'); }
    return;
  }

  const varBtn = e.target.closest('button[data-var-edit]');
  if (varBtn) editVariable(varBtn.dataset.varEdit);
});

/* ------------------------------- PostgreSQL / MongoDB / Redis: detail */

/**
 * One page for every engine that is not MySQL. The server answers in fixed
 * shapes (stat tiles, key/value cards, tables, form fields — see
 * src/lib/engines/shape.js), so nothing here knows which engine it is drawing.
 */
const ENGINE_TABS = [
  { key: 'overview', label: 'Overview', load: () => loadEngineOverview() },
  { key: 'databases', label: 'Databases', load: () => loadEngineDatabases() },
  { key: 'users', label: 'Users', load: () => loadEngineUsers() },
  { key: 'config', label: 'Configuration', load: () => loadEngineConfig() },
];

let currentEngineId = null;
let engineTab = 'overview';
/** What each tab last read, plus which tabs have been read. */
let eng = { loaded: new Set() };

const engApi = (path, body = {}, method = 'POST') => api(`/credentials/${currentEngineId}/db${path}`, { method, body });
const engPanel = (key) => $(`#db-panel-${key}`);
const engLoading = (key, what = 'Reading…') => { engPanel(key).innerHTML = `<div class="empty"><span class="spinner"></span>${esc(what)}</div>`; };
const engError = (key, err) => { engPanel(key).innerHTML = `<div class="msg err">${esc(err.message)}</div>`; };

/* drawing the shapes */

function engCell(c) {
  if (c === null || c === undefined) return '—';
  if (typeof c !== 'object') return esc(c);
  if (c.link) {
    return `<button class="link-db" data-eng-db="${esc(c.link.database)}"${c.link.item !== undefined ? ` data-eng-item="${esc(c.link.item)}"` : ''}>${esc(c.text)}</button>`;
  }
  if (c.badge !== undefined) return `<span class="badge ${esc(c.badge)}">${esc(c.text)}</span>`;
  if (c.code) return `<code>${esc(c.text)}</code>`;
  if (c.small) return `<span class="small">${esc(c.text)}</span>`;
  return esc(c.text);
}

const engStats = (stats) => `<div class="tiles">${stats.map((s) => tile(s.label, esc(s.value), esc(s.sub), s.pct)).join('')}</div>`;
const engTable = (t) => {
  const html = table(t.columns, t.rows.map((r) => r.map(engCell)), t.empty);
  // A long list (a Redis key sample, hundreds of tables) scrolls inside its own box.
  return section(t.title, t.rows.length > 25 ? `<div class="scroll-table">${html}</div>` : html);
};
const engKv = (k) => kvCard(k.title, k.pairs.map(([key, v]) => [key, engCell(v)]));

/** A form field as the engine described it. */
function engField(f) {
  const req = f.required ? 'required' : '';
  const hint = f.hint ? `<span class="muted small" style="display:block;margin-top:4px">${esc(f.hint)}</span>` : '';
  if (f.type === 'checkbox') {
    return `<label class="check" style="margin-top:12px"><input type="checkbox" name="${esc(f.name)}" ${f.default ? 'checked' : ''} /> ${esc(f.label)}</label>${hint}`;
  }
  if (f.type === 'select') {
    return `<label>${esc(f.label)}<select name="${esc(f.name)}" ${req}>${(f.options || []).map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(f.default) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>${hint}</label>`;
  }
  const type = f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text';
  return `<label>${esc(f.label)}<input name="${esc(f.name)}" type="${type}" value="${esc(f.default)}" placeholder="${esc(f.placeholder)}" ${req}
    ${type === 'password' ? 'autocomplete="new-password" minlength="8"' : 'autocomplete="off"'} />${hint}</label>`;
}

/** FormData as a plain object, with ticked boxes as true and unticked ones present as false. */
function engFormValues(fd, fields) {
  const out = Object.fromEntries(fd.entries());
  for (const f of fields) if (f.type === 'checkbox') out[f.name] = fd.get(f.name) === 'on';
  return out;
}

/* opening a connection */

async function openEngine(id) {
  if (String(id) !== String(currentEngineId)) engineTab = 'overview';
  currentEngineId = id;
  eng = { loaded: new Set() };
  show('db-detail');

  $('#db-tabs').innerHTML = ENGINE_TABS.map((t) => `<button class="tab ${t.key === engineTab ? 'active' : ''}" data-eng-tab="${t.key}"><span>${esc(t.label)}</span><span class="tab-count" id="eng-count-${t.key}"></span></button>`).join('');
  $('#db-body').innerHTML = ENGINE_TABS.map((t) => `<div class="tab-panel" data-panel="${t.key}" id="db-panel-${t.key}" ${t.key === engineTab ? '' : 'hidden'}></div>`).join('');

  try {
    eng.cred = await api(`/credentials/${id}`);
    const e = DB_ENGINES[eng.cred.provider];
    $('#db-name').textContent = `${e.icon} ${eng.cred.name}`;
    $('#db-sub').textContent = `${e.label} · ${eng.cred.username ? `${eng.cred.username}@` : ''}${eng.cred.extra.host}:${eng.cred.extra.port}`
      + (eng.cred.server ? ` · tunnelled via ${eng.cred.server.name} (${eng.cred.server.host})` : ' · direct connection')
      + (eng.cred.extra.tls ? ' · TLS' : '');
  } catch (err) {
    $('#db-body').innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
    return;
  }
  showEngineTab(engineTab);
}

function showEngineTab(key) {
  const tab = ENGINE_TABS.find((t) => t.key === key) || ENGINE_TABS[0];
  engineTab = tab.key;
  $$('#db-tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.engTab === tab.key));
  $$('#db-body > .tab-panel').forEach((p) => { p.hidden = p.dataset.panel !== tab.key; });
  if (!eng.loaded.has(tab.key)) {
    eng.loaded.add(tab.key);
    tab.load();
  }
}

function setEngCount(key, n) {
  const el = $(`#eng-count-${key}`);
  if (el) el.textContent = n === null || n === undefined ? '' : String(n);
}

$('#db-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-eng-tab]');
  if (btn) showEngineTab(btn.dataset.engTab);
});
$('#btn-db-back').addEventListener('click', () => { show('databases'); loadMysqlList(); });
$('#btn-db-edit').addEventListener('click', () => editMysqlConnection(currentEngineId));
$('#btn-db-refresh').addEventListener('click', () => {
  eng = { loaded: new Set([engineTab]), cred: eng.cred, queryHelp: eng.queryHelp };
  ENGINE_TABS.find((t) => t.key === engineTab).load();
});

/* overview */

async function loadEngineOverview() {
  engLoading('overview', 'Connecting…');
  try {
    const o = await engApi('/overview');
    eng.queryHelp = o.queryHelp;
    setEngCount('databases', o.counts?.databases);
    setEngCount('users', o.counts?.users);
    engPanel('overview').innerHTML = [
      section('Statistics', engStats(o.stats)),
      o.info?.length ? section('Connection', `<div class="two-col">${o.info.map(engKv).join('')}</div>`) : '',
      ...(o.tables || []).map(engTable),
      `<p class="muted small">Read in ${esc(o.durationMs)}ms.</p>`,
    ].join('');
  } catch (err) {
    engError('overview', err);
  }
}

/* databases */

async function loadEngineDatabases() {
  eng.openDb = null;
  engLoading('databases');
  try {
    eng.databases = await engApi('/databases');
    renderEngineDatabases(eng.databases);
  } catch (err) {
    engError('databases', err);
  }
}

function renderEngineDatabases(d) {
  const caps = d.caps || {};
  setEngCount('databases', d.rows.filter((r) => !r.system && !r.empty).length);
  engPanel('databases').innerHTML = `
    <div class="section">
      <div class="section-head">
        <h2>Databases</h2>
        <div class="section-tools">
          <input type="search" id="eng-db-filter" placeholder="Filter databases" />
          ${caps.create ? ifCan('create', '<button class="btn tiny primary" data-eng-action="create-db">+ Create database</button>') : ''}
        </div>
      </div>
      ${engStats(d.stats)}
      ${caps.createNote && !caps.create ? `<p class="muted small" style="margin-top:10px">${esc(caps.createNote)}</p>` : ''}
      <div id="eng-db-table" style="margin-top:14px">${table(
        [...d.columns.map((c) => (typeof c === 'string' ? { label: c } : c)), { label: '' }],
        d.rows.map((r) => [
          ...r.cells.map(engCell),
          `<div class="row-actions">
            <button class="btn tiny" data-eng-db="${esc(r.name)}">Details</button>
            ${caps.drop && !r.system ? ifCan('delete', `<button class="btn tiny danger" data-eng-action="drop-db" data-name="${esc(r.name)}">${esc(caps.dropLabel || 'Drop')}</button>`) : ''}
          </div>`,
        ]),
        'No databases'
      )}</div>
    </div>`;
}

async function openEngineDatabase(name) {
  if (engineTab !== 'databases') { eng.loaded.add('databases'); showEngineTab('databases'); }
  eng.openDb = name;
  engLoading('databases');
  try {
    const d = await engApi('/database', { name });
    const caps = eng.databases?.caps || {};
    engPanel('databases').innerHTML = `
      <button class="link-back" data-eng-nav="databases">← all databases</button>
      <div class="section">
        <div class="section-head">
          <h2>${esc(d.title)}</h2>
          <div class="section-tools">
            ${eng.cred?.provider === 'redis' ? '' : ifCan('create', `<button class="btn tiny" data-eng-action="create-user" data-db="${esc(name)}">+ User for this database</button>`)}
            ${caps.drop !== false ? ifCan('delete', `<button class="btn tiny danger" data-eng-action="drop-db" data-name="${esc(name)}">${esc(caps.dropLabel || 'Drop')} database</button>`) : ''}
          </div>
        </div>
        ${engStats(d.stats)}
      </div>
      ${(d.tables || []).map(engTable).join('')}`;
  } catch (err) {
    engError('databases', err);
  }
}

async function openEngineItem(database, item) {
  if (engineTab !== 'databases') { eng.loaded.add('databases'); showEngineTab('databases'); }
  engLoading('databases');
  try {
    const d = await engApi('/item', { database, item });
    engPanel('databases').innerHTML = `
      <button class="link-back" data-eng-db="${esc(database)}">← ${esc(database)}</button>
      <div class="section"><h2>${esc(d.title)}</h2>${d.stats?.length ? engStats(d.stats) : ''}</div>
      ${(d.tables || []).map(engTable).join('')}
      ${d.pre ? section(d.pre.title, `<pre class="log tall">${esc(d.pre.text)}</pre>`) : ''}`;
  } catch (err) {
    engError('databases', err);
  }
}

/* users */

async function loadEngineUsers() {
  engLoading('users');
  try {
    eng.users = await engApi('/users/list');
    setEngCount('users', eng.users.users.length);
    renderEngineUsers(eng.users);
  } catch (err) {
    engError('users', err);
  }
}

function renderEngineUsers(u) {
  const caps = u.caps || {};
  engPanel('users').innerHTML = `
    <div class="section">
      <div class="section-head">
        <h2>User management</h2>
        <div class="section-tools">${ifCan('create', '<button class="btn tiny primary" data-eng-action="create-user">+ Create user</button>')}</div>
      </div>
      ${engStats(u.stats)}
      <p class="muted small" style="margin-top:12px">${esc(u.note || '')}</p>
      ${table(
        [...u.columns.map((c) => (typeof c === 'string' ? { label: c } : c)), { label: 'Grants' }, { label: '' }],
        u.users.map((x, i) => [
          ...x.cells.map(engCell).map((html, col) => (col === 0 && x.self ? `${html} <span class="badge ok">panel</span>` : html)),
          `<details><summary class="small">${x.grants.length} grant(s)</summary>${x.grants.map((g) => `<div><code class="small">${esc(g)}</code></div>`).join('')}</details>`,
          `<div class="row-actions">
            ${ifCan('create', `<button class="btn tiny" data-eng-user="grant" data-i="${i}">Grant</button>`)}
            ${x.self ? '' : ifCan('delete', `<button class="btn tiny" data-eng-user="revoke" data-i="${i}">Revoke</button>`)}
            ${ifCan('edit', `<button class="btn tiny" data-eng-user="password" data-i="${i}">Password</button>`)}
            ${caps.lock && !x.self ? ifCan('edit', `<button class="btn tiny" data-eng-user="${x.locked ? 'unlock' : 'lock'}" data-i="${i}">${esc((caps.lockLabel || ['Lock', 'Unlock'])[x.locked ? 1 : 0])}</button>`) : ''}
            ${x.self ? '' : ifCan('delete', `<button class="btn tiny danger" data-eng-user="drop" data-i="${i}">Drop</button>`)}
          </div>`,
        ]),
        'No users'
      )}
    </div>`;
}

/* configuration */

async function loadEngineConfig() {
  engLoading('config');
  try {
    eng.config = await engApi('/config');
    renderEngineConfig(eng.config);
  } catch (err) {
    engError('config', err);
  }
}

function renderEngineConfig(c) {
  const groups = {};
  for (const v of c.editable) (groups[v.group] ||= []).push(v);
  engPanel('config').innerHTML = `
    <p class="muted small">${esc(c.note || '')}</p>
    ${Object.entries(groups).map(([group, vars]) => section(group, table(
      [{ label: 'Setting' }, { label: 'Value' }, { label: 'What it does' }, { label: '' }],
      vars.map((v) => [
        `<b>${esc(v.name)}</b>${v.restart ? ' <span class="badge warn">restart</span>' : ''}`, `<code>${esc(v.display ?? v.value)}</code>`,
        `<span class="small muted">${esc(v.hint)}</span>`,
        ifCan('edit', `<div class="row-actions"><button class="btn tiny" data-eng-var="${esc(v.name)}">Change</button></div>`),
      ])
    ))).join('')}
    <div class="section">
      <div class="section-head">
        <h2>All settings</h2>
        <div class="section-tools"><input type="search" id="eng-var-filter" placeholder="Filter ${c.all.length} settings" /></div>
      </div>
      <div class="scroll-table card" id="eng-var-table" style="padding:4px 0">
        <table>
          <thead><tr><th>Setting</th><th>Value</th></tr></thead>
          <tbody>${c.all.map((v) => `<tr><td>${esc(v.name)}${v.hint ? `<div class="muted small">${esc(v.hint)}</div>` : ''}</td><td><span class="small" style="word-break:break-all">${val(v.value)}</span></td></tr>`).join('')}</tbody>
        </table>
      </div>
    </div>`;
}

/* changes — all through the shared management dialog */

async function engineAfterDatabaseChange() {
  eng.loaded.delete('overview');
  if (engineTab === 'databases' && eng.openDb && $('#view-db-detail [data-eng-nav="databases"]')) return openEngineDatabase(eng.openDb);
  eng.loaded.add('databases');
  return loadEngineDatabases();
}

async function engineAfterUserChange() {
  eng.loaded.delete('overview');
  eng.loaded.delete('users');
  if (engineTab === 'users') { eng.loaded.add('users'); return loadEngineUsers(); }
  if (engineTab === 'databases' && eng.openDb) return openEngineDatabase(eng.openDb);
}

/** The databases list and the users list carry the forms; read whichever is missing. */
async function engineCaps(which) {
  if (which === 'databases' && !eng.databases) eng.databases = await engApi('/databases');
  if (which === 'users' && !eng.users) eng.users = await engApi('/users/list');
  return (which === 'databases' ? eng.databases : eng.users).caps || {};
}

async function engineAction(action, btn) {
  if (action === 'create-db') {
    const caps = await engineCaps('databases');
    return openMyDialog({
      title: 'Create database',
      intro: esc(caps.createNote || ''),
      fields: caps.createFields.map(engField).join(''),
      submitLabel: 'Create database',
      submit: async (fd) => (await engApi('/schemas', engFormValues(fd, caps.createFields))).summary,
      after: () => { eng.openDb = null; return engineAfterDatabaseChange(); },
    });
  }

  if (action === 'drop-db') {
    const caps = await engineCaps('databases');
    const name = btn.dataset.name;
    const verb = caps.dropLabel || 'Drop';
    return openMyDialog({
      title: `${verb} ${name}?`,
      intro: `<div class="msg err">${esc(caps.dropNote || `Everything in ${name} is deleted for good. There is no undo — take a backup first if you might need it.`)}</div>`,
      fields: `<label>Type <code>${esc(name)}</code> to confirm<input name="confirm" autocomplete="off" required /></label>${(caps.dropFields || []).map(engField).join('')}`,
      submitLabel: `${verb} database`,
      danger: true,
      submit: async (fd) => {
        if (fd.get('confirm') !== name) throw new Error('The name does not match');
        return (await engApi('/databases', { name, ...engFormValues(fd, caps.dropFields || []) }, 'DELETE')).summary;
      },
      after: () => { eng.openDb = null; return engineAfterDatabaseChange(); },
    });
  }

  if (action === 'create-user') {
    const caps = await engineCaps('users');
    const fields = caps.createFields.map((f) => (f.name === 'database' && btn.dataset.db ? { ...f, default: btn.dataset.db } : f));
    return openMyDialog({
      title: 'Create user',
      fields: fields.map(engField).join(''),
      submitLabel: 'Create user',
      submit: async (fd) => (await engApi('/users', engFormValues(fd, fields))).summary,
      after: engineAfterUserChange,
    });
  }
}

async function engineUserAction(action, i) {
  const caps = await engineCaps('users');
  const u = eng.users.users[i];
  if (!u) return;
  const key = u.key;

  if (action === 'grant') {
    return openMyDialog({
      title: `Grant access to ${u.label}`,
      fields: caps.grantFields.map(engField).join(''),
      submitLabel: 'Grant',
      submit: async (fd) => (await engApi('/users/grants', { key, ...engFormValues(fd, caps.grantFields) })).summary,
      after: engineAfterUserChange,
    });
  }

  if (action === 'revoke') {
    return openMyDialog({
      title: `Revoke access from ${u.label}`,
      intro: esc(caps.revokeNote || 'Takes back what the user was granted there. The user itself stays.'),
      fields: (caps.revokeFields || []).map(engField).join(''),
      submitLabel: 'Revoke',
      danger: true,
      submit: async (fd) => (await engApi('/users/grants', { key, ...engFormValues(fd, caps.revokeFields || []) }, 'DELETE')).summary,
      after: engineAfterUserChange,
    });
  }

  if (action === 'password') {
    const extra = caps.passwordFields || [];
    return openMyDialog({
      title: `Change password of ${u.label}`,
      intro: 'Apps that sign in as this user need the new password too, or they will stop connecting.',
      fields: `<label>New password<input name="password" type="password" autocomplete="new-password" minlength="8" required /></label>${extra.map(engField).join('')}`,
      submit: async (fd) => (await engApi('/users', { key, ...engFormValues(fd, extra) }, 'PUT')).summary,
      after: engineAfterUserChange,
    });
  }

  if (action === 'lock' || action === 'unlock') {
    const lock = action === 'lock';
    if (lock && !confirm(`${(caps.lockLabel || ['Lock'])[0]} ${u.label}? It will not be able to sign in until you undo it.`)) return;
    try {
      toast((await engApi('/users', { key, locked: lock }, 'PUT')).summary);
      await engineAfterUserChange();
    } catch (err) {
      toast(err.message, 'err');
    }
    return;
  }

  if (action === 'drop') {
    const name = key.user || key.name;
    return openMyDialog({
      title: `Drop ${u.label}?`,
      intro: `<div class="msg err">The user and its grants are removed. Anything signing in as <b>${esc(u.label)}</b> stops working. Data is not touched.</div>`,
      fields: `<label>Type <code>${esc(name)}</code> to confirm<input name="confirm" autocomplete="off" required /></label>`,
      submitLabel: 'Drop user',
      danger: true,
      submit: async (fd) => {
        if (fd.get('confirm') !== name) throw new Error('The name does not match');
        return (await engApi('/users', { key }, 'DELETE')).summary;
      },
      after: engineAfterUserChange,
    });
  }
}

function engineEditSetting(name) {
  const v = eng.config?.editable.find((x) => x.name === name);
  if (!v) return;
  const input = v.type === 'bool' || v.type === 'enum'
    ? `<select name="value">${(v.type === 'bool' ? ['on', 'off'] : v.options).map((o) => `<option ${String(v.value).toLowerCase() === String(o).toLowerCase() ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`
    : `<input name="value" value="${esc(v.value)}" required />`;
  openMyDialog({
    title: `Change ${name}`,
    intro: `${esc(v.hint)}.${v.unit ? ` Stored in ${esc(v.unit)}; a unit like 256MB also works.` : ''}${v.restart ? ' <b>Takes effect after a restart.</b>' : ''}`,
    fields: `<label>Value${input}</label>
      ${eng.config.persistLabel ? `<label class="check" style="margin-top:12px"><input type="checkbox" name="persist" checked /> ${esc(eng.config.persistLabel)}</label>` : ''}`,
    submitLabel: 'Apply',
    submit: async (fd) => (await engApi('/config', { name, value: fd.get('value'), persist: fd.get('persist') === 'on' }, 'PUT')).summary,
    after: () => { eng.loaded.delete('overview'); return loadEngineConfig(); },
  });
}

$('#db-body').addEventListener('input', (e) => {
  const filters = { 'eng-db-filter': '#eng-db-table tbody tr', 'eng-var-filter': '#eng-var-table tbody tr' };
  if (!filters[e.target.id]) return;
  const q = e.target.value.trim().toLowerCase();
  $$(filters[e.target.id]).forEach((tr) => { tr.hidden = q && !tr.textContent.toLowerCase().includes(q); });
});

$('#db-body').addEventListener('click', async (e) => {
  const nav = e.target.closest('[data-eng-nav]');
  if (nav) return loadEngineDatabases();

  const link = e.target.closest('[data-eng-db]');
  if (link) {
    return link.dataset.engItem !== undefined ? openEngineItem(link.dataset.engDb, link.dataset.engItem) : openEngineDatabase(link.dataset.engDb);
  }

  try {
    const act = e.target.closest('button[data-eng-action]');
    if (act) return await engineAction(act.dataset.engAction, act);
    const user = e.target.closest('button[data-eng-user]');
    if (user) return await engineUserAction(user.dataset.engUser, Number(user.dataset.i));
    const v = e.target.closest('button[data-eng-var]');
    if (v) return engineEditSetting(v.dataset.engVar);
  } catch (err) {
    toast(err.message, 'err');
  }
});

/* query */

const ENGINE_QUERY_FALLBACK = {
  postgres: { placeholder: 'SELECT * FROM customers LIMIT 20', hint: 'Read-only, inside a transaction that is rolled back.', databaseLabel: 'Database' },
  mongodb: { placeholder: '{ "collection": "orders", "filter": {}, "limit": 20 }', hint: 'A JSON find or aggregate. Nothing that writes.', databaseLabel: 'Database' },
  redis: { placeholder: 'GET mykey', hint: 'One read-only command.', databaseLabel: 'Database (db0–db15)' },
};

$('#btn-db-query').addEventListener('click', () => {
  const help = eng.queryHelp || ENGINE_QUERY_FALLBACK[eng.cred?.provider] || {};
  $('#db-query-hint').textContent = help.hint || '';
  $('#db-query-db-label').textContent = help.databaseLabel || 'Database';
  $('#db-query-text').placeholder = help.placeholder || '';
  const def = eng.openDb || eng.cred?.extra?.database;
  $('#db-query-db').value = def ? (eng.cred?.provider === 'redis' && /^\d+$/.test(def) ? `db${def}` : def) : '';
  $('#db-query-msg').classList.add('hidden');
  $('#db-query-result').innerHTML = '';
  $('#modal-db-query').classList.remove('hidden');
});

$('#form-db-query').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const btn = e.submitter;
  busy(btn, true, 'Running…');
  try {
    const r = await engApi('/query', { text: fd.get('text'), database: fd.get('database') || null });
    $('#db-query-msg').classList.add('hidden');
    $('#db-query-result').innerHTML = `
      <p class="muted small">${r.rowCount} row(s) in ${r.durationMs}ms${r.truncated ? ' — showing the first ones' : ''}</p>
      ${table(r.columns.map((c) => ({ label: c })), r.rows.map((row) => row.map((v) => `<span class="small" style="white-space:pre-wrap">${esc(v)}</span>`)), 'No rows')}`;
  } catch (err) {
    $('#db-query-result').innerHTML = '';
    formMsg($('#db-query-msg'), err.message, 'err');
  }
  busy(btn, false);
});

/* ------------------------------------------------- MySQL: query runner */

const queryModal = $('#modal-query');

$('#btn-mysql-query').addEventListener('click', () => {
  $('#query-msg').classList.add('hidden');
  $('#query-result').innerHTML = '';
  queryModal.classList.remove('hidden');
});

$('#form-query').addEventListener('submit', async (e) => {
  e.preventDefault();
  const sql = new FormData(e.target).get('sql');
  const btn = e.submitter;
  const msg = $('#query-msg');
  busy(btn, true, 'Running…');
  try {
    const r = await api(`/credentials/${currentMysqlId}/mysql/query`, { method: 'POST', body: { sql } });
    msg.classList.add('hidden');
    $('#query-result').innerHTML = `
      <p class="muted small">${r.rowCount} row(s) in ${r.durationMs}ms${r.truncated ? ' — showing the first 200' : ''}</p>
      ${table(
        r.columns.map((c) => ({ label: c })),
        r.rows.map((row) => r.columns.map((c) => `<span class="small">${val(row[c])}</span>`)),
        'Query returned no rows'
      )}`;
  } catch (err) {
    $('#query-result').innerHTML = '';
    formMsg(msg, err.message, 'err');
  }
  busy(btn, false);
});

/* ------------------------------------------------ account management */

/**
 * One page for every outside account the panel signs in with. Each provider
 * has its own tab, list and "add" button; MySQL stays under Databases.
 */
const ACCOUNT_TABS = [
  { key: 'git', label: 'Git', intro: 'GitHub, GitLab and Bitbucket accounts. Sign in at the provider and pick your account there — nothing is typed in by hand.', load: () => loadGitList(), add: '#btn-add-git-account' },
  { key: 'cloudflare', label: 'Cloudflare', intro: 'Cloudflare accounts, their zones and DNS. Sign in on Cloudflare and the panel reads the account details itself.', load: () => loadCloudflareList(), add: '#btn-add-cloudflare' },
  { key: 'dockerhub', label: 'Docker Hub', intro: 'Docker Hub accounts used to pull and push images. Sign in on Docker Hub and the panel reads the account itself; tokens are stored AES-256-GCM encrypted.', load: () => loadCredentials(), add: '#btn-add-dockerhub' },
];
let accountsTab = 'git';

function openAccounts(tab = accountsTab) {
  accountsTab = tab;
  show('accounts');
  setHeading('Account management');
  loadAccounts();
}

async function loadAccounts() {
  const current = ACCOUNT_TABS.find((t) => t.key === accountsTab) || ACCOUNT_TABS[0];
  $('#accounts-intro').textContent = current.intro;
  $('#accounts-tabs').innerHTML = ACCOUNT_TABS.map((t) =>
    `<button class="tab ${t.key === current.key ? 'active' : ''}" data-accounts-tab="${t.key}"><span>${esc(t.label)}</span><span class="tab-count" data-accounts-count="${t.key}"></span></button>`).join('');
  $$('[data-accounts-panel]').forEach((p) => { p.hidden = p.dataset.accountsPanel !== current.key; });
  ACCOUNT_TABS.forEach((t) => $(t.add).classList.toggle('hidden', t.key !== current.key));

  // Counts on every tab, so an empty provider shows without opening it.
  api('/credentials').then((list) => {
    for (const t of ACCOUNT_TABS) {
      const el = $(`[data-accounts-count="${t.key}"]`);
      if (el) el.textContent = String(list.filter((c) => c.provider === t.key).length || '');
    }
  }).catch(() => {});

  try {
    await current.load();
  } catch (err) {
    $(`[data-accounts-panel="${current.key}"] .grid`).innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

$('#accounts-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-accounts-tab]');
  if (!btn) return;
  accountsTab = btn.dataset.accountsTab;
  loadAccounts();
});

/* -------------------------------------------- Cloudflare: browser sign-in */

/**
 * Cloudflare has no OAuth for panels like this one, so "sign in" opens the
 * dashboard's Create API token form pre-filled with the right permissions.
 * When the person comes back with the token on their clipboard the panel
 * picks it up, verifies it and reads the account — no typing needed.
 */
const cfModal = $('#modal-cloudflare');
let cfWait = null;
const looksLikeCfToken = (t) => /^[A-Za-z0-9_-]{37,60}$/.test(String(t || '').trim());

function stopCfWait() {
  if (!cfWait) return;
  clearInterval(cfWait.timer);
  window.removeEventListener('focus', cfWait.onFocus);
  cfWait = null;
  $('#cf-waiting').hidden = true;
}

async function openCloudflareModal() {
  stopCfWait();
  $('#cf-token').value = '';
  $('#cf-token-name').value = '';
  $('#cf-msg').classList.add('hidden');
  $('#cf-permissions').textContent = 'Zone: Edit, Zone Settings: Read, DNS: Edit, Account Settings: Read, User Details: Read, Cloudflare Tunnel: Edit, Zero Trust: Edit';
  cfModal.classList.remove('hidden');
  try {
    const link = await api('/credentials/cloudflare/token-link');
    $('#btn-cf-open').dataset.url = link.url;
    $('#cf-permissions').textContent = link.permissions.join(', ');
  } catch { /* the button falls back to the plain tokens page */ }
}

$('#btn-add-cloudflare').addEventListener('click', openCloudflareModal);

$('#btn-cf-open').addEventListener('click', (e) => {
  const url = e.currentTarget.dataset.url || 'https://dash.cloudflare.com/profile/api-tokens';
  const popup = window.open(url, 'auto-deploy-cloudflare', 'width=1100,height=860');
  if (!popup) return toast('Your browser blocked the Cloudflare window. Allow pop-ups for this page and try again.', 'err');

  stopCfWait();
  const started = Date.now();
  $('#cf-waiting').hidden = false;
  $('#cf-timer').textContent = '0:00';

  // Coming back to this tab is the cue to look on the clipboard for the token.
  const onFocus = () => setTimeout(tryClipboard, 250);
  cfWait = {
    onFocus,
    timer: setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      $('#cf-timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      // Stop watching after ten minutes; the paste box still works.
      if (s >= 600) stopCfWait();
    }, 1000),
  };
  window.addEventListener('focus', onFocus);
});

async function tryClipboard() {
  if (!cfWait || cfModal.classList.contains('hidden') || !navigator.clipboard?.readText) return;
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (looksLikeCfToken(text) && text !== $('#cf-token').value) {
      $('#cf-token').value = text;
      connectCloudflare();
    }
  } catch { /* clipboard access refused — the paste box is the fallback */ }
}

// Pasting a token is enough; no need to press Connect as well.
$('#cf-token').addEventListener('paste', () => setTimeout(() => {
  if (looksLikeCfToken($('#cf-token').value)) connectCloudflare();
}, 0));

$('#btn-cf-connect').addEventListener('click', () => connectCloudflare());

let cfConnecting = false;
async function connectCloudflare() {
  if (cfConnecting) return;
  const msg = $('#cf-msg');
  const btn = $('#btn-cf-connect');
  const secret = $('#cf-token').value.trim();
  if (!secret) return formMsg(msg, 'Create the token on Cloudflare, then paste it here.', 'err');

  cfConnecting = true;
  busy(btn, true, 'Reading account…');
  try {
    const r = await api('/credentials/cloudflare/connect', { method: 'POST', body: { secret, name: $('#cf-token-name').value.trim() } });
    stopCfWait();
    cfModal.classList.add('hidden');
    const a = r.credential.extra.account || {};
    toast(`Connected ${r.credential.name} — ${a.accounts?.length || 0} accounts, ${a.zones?.length || 0} zones`);
    openCloudflare(r.credential.id);
  } catch (err) {
    formMsg(msg, err.message, 'err');
  }
  busy(btn, false);
  cfConnecting = false;
}

// Closing the modal stops watching for the token.
cfModal.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', stopCfWait));

/* ---------------------------------------------------- Cloudflare: list */

async function loadCloudflareList() {
  const box = $('#cf-list');
  box.innerHTML = '<div class="empty">Loading…</div>';
  const list = await api('/credentials?provider=cloudflare');
  if (!list.length) {
    box.innerHTML = '<div class="empty">No Cloudflare accounts yet. Click <b>+ Connect Cloudflare</b> and sign in on Cloudflare.</div>';
    return;
  }
  box.innerHTML = list.map((c) => {
    const a = c.extra.account || {};
    const accounts = a.accounts || [];
    const zones = a.zones || [];
    return `
    <div class="card">
      <div class="card-head">
        <div>
          <h3>${esc(c.name)}</h3>
          <div class="muted small">${a.email ? `${esc(a.email)}${a.name ? ` · ${esc(a.name)}` : ''}` : esc(accounts.map((x) => x.name).join(', ') || 'not read yet')}</div>
        </div>
        <span class="badge ${c.status === 'valid' ? 'ok' : c.status === 'invalid' ? 'err' : ''}">${esc(c.status)}</span>
      </div>
      <dl class="kv">
        <dt>Accounts</dt><dd>${accounts.length ? accounts.map((x) => `<span class="chip">${esc(x.name)}</span>`).join(' ') : '<span class="muted small">none visible</span>'}</dd>
        <dt>Zones</dt><dd>${zones.length ? `${zones.length} <span class="muted small">${esc(zones.slice(0, 4).map((z) => z.name).join(', '))}${zones.length > 4 ? '…' : ''}</span>` : '<span class="muted small">none visible</span>'}</dd>
        <dt>Token</dt><dd><code>${esc(c.secretHint)}</code> ${a.tokenStatus ? `<span class="badge ${a.tokenStatus === 'active' ? 'ok' : 'warn'}">${esc(a.tokenStatus)}</span>` : ''}
          ${a.expiresOn ? `<div class="muted small">expires ${esc(String(a.expiresOn).replace('T', ' ').slice(0, 16))}</div>` : ''}</dd>
        <dt>Checked</dt><dd>${val(c.verified_at)}</dd>
      </dl>
      ${c.last_error ? `<div class="msg err" style="margin-top:10px">${esc(c.last_error)}</div>` : ''}
      <div class="card-actions">
        <button class="btn tiny" data-cf-action="open" data-id="${c.id}">Zones &amp; DNS</button>
        <button class="btn tiny" data-cf-action="zt" data-id="${c.id}">Zero Trust</button>
        <button class="btn tiny" data-cf-action="refresh" data-id="${c.id}">Refresh details</button>
        ${ifCan('delete', `<button class="btn tiny danger" data-cf-action="delete" data-id="${c.id}">Disconnect</button>`)}
      </div>
    </div>`;
  }).join('');
}

$('#cf-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-cf-action]');
  if (!btn) return;
  const { cfAction, id } = btn.dataset;

  if (cfAction === 'open') return openCloudflare(id);
  if (cfAction === 'zt') return openCloudflare(id).then(() => String(currentCf?.id) === String(id) && openZeroTrust());
  if (cfAction === 'delete') {
    if (!confirm('Disconnect this Cloudflare account? The token is deleted from the panel (it stays valid on Cloudflare until you revoke it there).')) return;
    await api(`/credentials/${id}`, { method: 'DELETE' });
    toast('Cloudflare account disconnected');
    return loadAccounts();
  }
  busy(btn, true, 'Reading…');
  try {
    const r = await api(`/credentials/${id}/cloudflare/account`, { method: 'POST' });
    toast(`Read ${r.account.accounts.length} accounts and ${r.account.zones.length} zones (${r.account.latencyMs}ms)`);
  } catch (err) {
    toast(err.message, 'err');
  }
  await loadCloudflareList();
});

/* -------------------------------------------------- Cloudflare: detail */

let currentCfId = null;
let currentCf = null;

async function openCloudflare(id) {
  currentCfId = id;
  show('cf-detail');
  setHeading('Account management');
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === 'accounts'));
  $('#cf-body').innerHTML = '<div class="empty"><span class="spinner"></span>Loading…</div>';
  try {
    currentCf = await api(`/credentials/${id}`);
    renderCloudflare();
  } catch (err) {
    $('#cf-body').innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
  }
}

const cfDate = (v) => (v ? esc(String(v).replace('T', ' ').slice(0, 16)) : '—');
const yesNo = (v) => (v === null || v === undefined ? '—' : v ? 'yes' : 'no');
const nsList = (list) => (list?.length ? list.map((n) => `<code class="small">${esc(n)}</code>`).join('<br>') : '—');

function renderCloudflare() {
  const c = currentCf;
  const a = c.extra.account || {};
  const u = a.user || {};
  const zones = a.zones || [];
  const accounts = a.accounts || [];
  const access = a.access || {};
  $('#cf-name').textContent = c.name;
  $('#cf-sub').textContent = [a.email, a.name, `token ${a.tokenStatus || 'unknown'}`].filter(Boolean).join(' · ');

  const missing = [
    access.user === false && 'User Details: Read (email, name, profile)',
    access.accounts === false && 'Account Settings: Read (account list)',
    access.zones === false && 'Zone: Read (domains)',
  ].filter(Boolean);

  $('#cf-body').innerHTML = [
    section('Overview', `<div class="tiles">
      ${tile('Email', val(a.email), val(a.name))}
      ${tile('Accounts', val(accounts.length), esc(accounts.map((x) => x.name).join(', ')) || '—')}
      ${tile('Domains', val(zones.length), `${zones.filter((z) => z.status === 'active').length} active · ${zones.filter((z) => z.status === 'pending').length} pending`)}
      ${tile('Token', val(a.tokenStatus), a.expiresOn ? `expires ${esc(String(a.expiresOn).slice(0, 10))}` : 'no expiry')}
      ${typeof a.twoFactor === 'boolean' ? tile('Two-factor', a.twoFactor ? 'on' : 'off', 'on the Cloudflare login') : ''}
    </div>
    ${missing.length ? `<div class="msg err" style="margin-top:12px">This token cannot read: ${esc(missing.join('; '))}. Connect again with a new token to add them.</div>` : ''}`),

    `<div class="grid">
      ${kvCard('Profile', [
        ['User ID', a.userId ? `<code class="small">${esc(a.userId)}</code>` : '—'],
        ['Email', val(a.email)],
        ['Name', val(a.name)],
        ['Username', val(u.username)],
        ['Country', val(u.country)],
        ['Zip code', val(u.zipcode)],
        ['Telephone', val(u.telephone)],
        ['Two-factor', yesNo(a.twoFactor)],
        ['Suspended', yesNo(access.user ? u.suspended : null)],
        ['Paid plans', access.user ? esc([u.hasProZones && 'Pro', u.hasBusinessZones && 'Business', u.hasEnterpriseZones && 'Enterprise'].filter(Boolean).join(', ') || 'none') : '—'],
        ['Member since', cfDate(u.createdOn)],
        ['Profile updated', cfDate(u.modifiedOn)],
      ])}
      ${kvCard('API token', [
        ['Token ID', a.tokenId ? `<code class="small">${esc(a.tokenId)}</code>` : '—'],
        ['Stored as', `<code>${esc(c.secretHint)}</code>`],
        ['Status', a.tokenStatus ? `<span class="badge ${a.tokenStatus === 'active' ? 'ok' : 'warn'}">${esc(a.tokenStatus)}</span>` : '—'],
        ['Valid from', cfDate(a.notBefore)],
        ['Expires', a.expiresOn ? cfDate(a.expiresOn) : 'never'],
        ['Can read profile', yesNo(access.user)],
        ['Can list accounts', yesNo(access.accounts)],
        ['Can list domains', yesNo(access.zones)],
        ['Panel status', `<span class="badge ${c.status === 'valid' ? 'ok' : c.status === 'invalid' ? 'err' : ''}">${esc(c.status)}</span>`],
        ['Connected', cfDate(c.created_at)],
        ['Last read', cfDate(a.checkedAt || c.verified_at)],
        ['Round trip', a.latencyMs ? `${esc(a.latencyMs)} ms` : '—'],
      ])}
    </div>`,

    section('Accounts', table(
      [{ label: 'Account' }, { label: 'Type' }, { label: 'Domains', num: true }, { label: '2FA enforced' }, { label: 'Created' }, { label: 'ID' }],
      accounts.map((x) => [esc(x.name), val(x.type), val(x.zones), yesNo(x.enforceTwoFactor), cfDate(x.createdOn), `<code class="small">${esc(x.id)}</code>`]),
      'This token cannot list any accounts',
    )),

    section('Domains', table(
      [{ label: 'Domain' }, { label: 'Status' }, { label: 'Plan' }, { label: 'Name servers' }, { label: 'Registrar' }, { label: 'Activated' }, { label: '' }],
      zones.map((z) => [
        `<button class="link-db" data-zone="${esc(z.id)}">${esc(z.name)}</button>${z.paused ? ' <span class="badge warn">paused</span>' : ''}
         <div class="muted small">${esc(z.accountName || '')}${z.type ? ` · ${esc(z.type)} setup` : ''}</div>`,
        `<span class="badge ${z.status === 'active' ? 'ok' : 'warn'}">${esc(z.status)}</span>`,
        val(z.plan),
        `<span class="small">${nsList(z.nameServers)}</span>`,
        val(z.originalRegistrar),
        `<span class="small">${cfDate(z.activatedOn)}</span>`,
        `<div style="display:flex;gap:6px;justify-content:flex-end">
          <button class="btn tiny" data-zone="${esc(z.id)}">Details</button>
          ${ifCan('delete', `<button class="btn tiny danger" data-zone-remove="${esc(z.id)}">Remove</button>`)}
        </div>`,
      ]),
      'This token cannot see any domains',
    )),
    '<p class="muted small">Click a domain for its full details, settings and DNS records.</p>',
  ].join('');
}

async function openCfZone(zoneId) {
  const box = $('#cf-body');
  box.innerHTML = '<div class="empty"><span class="spinner"></span>Loading domain…</div>';
  try {
    const r = await api(`/credentials/${currentCfId}/cloudflare/zones/${zoneId}`, { method: 'POST' });
    const z = r.zone;
    cfZone = { id: z.id, name: z.name, records: r.records || [] };
    const settingValue = (v) => (typeof v === 'object' && v !== null ? `<code class="small">${esc(JSON.stringify(v))}</code>` : esc(v));

    box.innerHTML = `
      <button class="link-back" data-cf-back>← back to domains</button>
      <div class="page-head" style="margin:8px 0 0">
        <div><h2 style="margin:0">${esc(z.name)} <span class="badge ${z.status === 'active' ? 'ok' : 'warn'}">${esc(z.status)}</span></h2>
          <p class="muted small" style="margin:4px 0 0">${esc(z.accountName || '')} · ${esc(z.plan || 'no plan')}</p></div>
        <div class="actions">
          ${ifCan('delete', `<button class="btn danger" data-zone-remove="${esc(z.id)}">Remove domain</button>`)}
        </div>
      </div>
      <div class="grid">
        ${kvCard('Domain', [
          ['Zone ID', `<code class="small">${esc(z.id)}</code>`],
          ['Status', esc(z.status)],
          ['Paused', yesNo(z.paused)],
          ['Setup', val(z.type)],
          ['Plan', val(z.plan)],
          ['Account', `${val(z.accountName)}${z.accountId ? `<div class="muted small"><code>${esc(z.accountId)}</code></div>` : ''}`],
          ['Development mode', z.developmentMode > 0 ? `on (${Math.round(z.developmentMode / 60)} min left)` : 'off'],
          ['Added', cfDate(z.createdOn)],
          ['Activated', cfDate(z.activatedOn)],
          ['Modified', cfDate(z.modifiedOn)],
        ])}
        ${kvCard('Name servers', [
          ['Cloudflare', nsList(z.nameServers)],
          ['Vanity', nsList(z.vanityNameServers)],
          ['Original', nsList(z.originalNameServers)],
          ['Original registrar', val(z.originalRegistrar)],
          ['Original DNS host', val(z.originalDnsHost)],
          ['Token may', z.permissions?.length ? z.permissions.map((p) => `<span class="chip">${esc(p.replace('#', ''))}</span>`).join(' ') : '—'],
        ])}
      </div>
      ${section('Settings', r.settings
        ? table([{ label: 'Setting' }, { label: 'Value' }, { label: 'Editable' }],
          r.settings.map((s) => [esc(s.id.replace(/_/g, ' ')), settingValue(s.value), yesNo(s.editable)]), 'No settings reported')
        : `<div class="card"><p class="muted small" style="margin:0">Settings are not readable with this token (needs Zone Settings: Read). ${esc(r.settingsError || '')}</p></div>`)}
      ${section(`DNS records${r.records ? ` · ${r.records.length}` : ''}`, r.records
        ? `${ifCan('create', '<div style="display:flex;justify-content:flex-end;margin-bottom:10px"><button class="btn primary" data-dns-add>+ Add record</button></div>')}
          ${table(
          [{ label: 'Type' }, { label: 'Name' }, { label: 'Content' }, { label: 'Proxy' }, { label: 'TTL' }, { label: 'Modified' }, { label: '' }],
          r.records.map((d) => [
            `<span class="chip">${esc(d.type)}</span>`,
            esc(d.name),
            `<code class="small">${esc(d.content)}</code>${d.priority !== null ? ` <span class="muted small">prio ${esc(d.priority)}</span>` : ''}${d.comment ? `<div class="muted small">${esc(d.comment)}</div>` : ''}`,
            d.proxied ? '<span class="badge warn">proxied</span>' : '<span class="badge">DNS only</span>',
            d.ttl === 1 ? 'auto' : val(d.ttl),
            `<span class="small">${cfDate(d.modifiedOn)}</span>`,
            `<div style="display:flex;gap:6px;justify-content:flex-end">
              ${d.editable ? ifCan('edit', `<button class="btn tiny" data-dns-edit="${esc(d.id)}">Edit</button>`) : '<span class="muted small" title="Edit this type in the Cloudflare dashboard">dashboard only</span>'}
              ${ifCan('delete', `<button class="btn tiny danger" data-dns-delete="${esc(d.id)}">Delete</button>`)}
            </div>`,
          ]),
          'No DNS records in this domain yet')}`
        : `<div class="card"><p class="muted small" style="margin:0">DNS records are not readable with this token. ${esc(r.recordsError || '')}</p></div>`)}`;
  } catch (err) {
    toast(err.message, 'err');
    renderCloudflare();
  }
}

/** Remove a domain from Cloudflare, after its name is typed back as confirmation. */
async function removeCfZone(zoneId, btn) {
  const zone = (currentCf.extra.account?.zones || []).find((z) => z.id === zoneId);
  if (!zone) return toast('That domain is no longer on this account — refresh the details.', 'err');
  const typed = prompt(
    `Remove ${zone.name} from Cloudflare?\n\n`
    + 'This deletes the domain and ALL of its DNS records on Cloudflare. It cannot be undone from here.\n\n'
    + 'Type the domain name to confirm:'
  );
  if (typed === null) return;
  if (typed.trim().toLowerCase() !== zone.name.toLowerCase()) return toast('The name did not match — nothing was removed.', 'err');

  busy(btn, true, 'Removing…');
  try {
    await api(`/credentials/${currentCfId}/cloudflare/zones/${zoneId}`, { method: 'DELETE', body: { confirm: typed.trim() } });
    toast(`Removed ${zone.name} from Cloudflare`);
    await openCloudflare(currentCfId);
  } catch (err) {
    toast(err.message, 'err');
    busy(btn, false);
  }
}

/* ------------------------------------------------ Cloudflare: DNS records */

let cfZone = null;
let editingDns = null;
const dnsModal = $('#modal-dns');
const dnsForm = $('#form-dns');

/** What the content box holds, per record type. */
const DNS_CONTENT = {
  A: ['IPv4 address', '203.0.113.10'],
  AAAA: ['IPv6 address', '2001:db8::1'],
  CNAME: ['Target host name', 'app.example.net'],
  TXT: ['Text', 'v=spf1 include:_spf.google.com ~all'],
  MX: ['Mail server', 'mail.example.com'],
  NS: ['Name server', 'ns1.example.net'],
  PTR: ['Domain name', 'host.example.com'],
};

function applyDnsType() {
  const type = dnsForm.type.value;
  const [label, placeholder] = DNS_CONTENT[type];
  $('#dns-content-label').textContent = label;
  dnsForm.content.placeholder = placeholder;
  $('#dns-priority-field').classList.toggle('hidden', type !== 'MX');
  $('#dns-proxied-field').classList.toggle('hidden', !['A', 'AAAA', 'CNAME'].includes(type));
  // Proxied records always use Auto TTL.
  dnsForm.ttl.disabled = dnsForm.proxied.checked && ['A', 'AAAA', 'CNAME'].includes(type);
  if (dnsForm.ttl.disabled) dnsForm.ttl.value = '1';
}

/** The name as typed in the form: "@" for the apex, the part before the zone otherwise. */
function shortDnsName(name) {
  if (name === cfZone.name) return '@';
  return name.endsWith(`.${cfZone.name}`) ? name.slice(0, -(cfZone.name.length + 1)) : name;
}

function openDnsModal(record = null) {
  editingDns = record;
  dnsForm.reset();
  [...dnsForm.ttl.options].filter((o) => o.dataset.custom).forEach((o) => o.remove());
  $('#dns-msg').classList.add('hidden');
  $('#dns-title').textContent = record ? 'Edit DNS record' : 'Add DNS record';
  $('#btn-dns-save').textContent = record ? 'Save changes' : 'Add record';
  $('#dns-zone-note').innerHTML = `On <b>${esc(cfZone.name)}</b>. Changes go live on Cloudflare straight away.`;
  if (record) {
    dnsForm.type.value = record.type;
    $('#dns-name').value = shortDnsName(record.name);
    dnsForm.content.value = record.content;
    dnsForm.proxied.checked = record.proxied;
    dnsForm.priority.value = record.priority ?? 10;
    dnsForm.comment.value = record.comment || '';
    // Keep an unusual TTL selectable rather than silently changing it.
    if (![...dnsForm.ttl.options].some((o) => Number(o.value) === record.ttl)) {
      const o = new Option(`${record.ttl} s`, String(record.ttl));
      o.dataset.custom = '1';
      dnsForm.ttl.add(o);
    }
    dnsForm.ttl.value = String(record.ttl);
  }
  applyDnsType();
  dnsModal.classList.remove('hidden');
  $('#dns-name').focus();
}

dnsForm.type.addEventListener('change', applyDnsType);
dnsForm.proxied.addEventListener('change', applyDnsType);

dnsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#btn-dns-save');
  const body = {
    type: dnsForm.type.value,
    name: $('#dns-name').value.trim(),
    content: dnsForm.content.value.trim(),
    ttl: Number(dnsForm.ttl.value),
    proxied: dnsForm.proxied.checked,
    priority: Number(dnsForm.priority.value),
    comment: dnsForm.comment.value.trim(),
  };
  const base = `/credentials/${currentCfId}/cloudflare/zones/${cfZone.id}/dns/records`;
  busy(btn, true, 'Saving…');
  try {
    const r = editingDns
      ? await api(`${base}/${editingDns.id}`, { method: 'PUT', body })
      : await api(base, { method: 'POST', body });
    dnsModal.classList.add('hidden');
    toast(`${editingDns ? 'Updated' : 'Added'} ${r.record.type} ${r.record.name}`);
    busy(btn, false);
    openCfZone(cfZone.id);
  } catch (err) {
    formMsg($('#dns-msg'), err.message, 'err');
    busy(btn, false);
  }
});

async function deleteDns(recordId, btn) {
  const d = cfZone.records.find((x) => x.id === recordId);
  if (!d) return;
  if (!confirm(`Delete this DNS record on Cloudflare?\n\n${d.type}  ${d.name}  →  ${d.content}\n\nIt stops resolving straight away.`)) return;
  busy(btn, true, '…');
  try {
    await api(`/credentials/${currentCfId}/cloudflare/zones/${cfZone.id}/dns/records/${recordId}`, { method: 'DELETE' });
    toast(`Deleted ${d.type} ${d.name}`);
    openCfZone(cfZone.id);
  } catch (err) {
    toast(err.message, 'err');
    busy(btn, false);
  }
}

$('#cf-body').addEventListener('click', (e) => {
  if (e.target.closest('button[data-cf-back]')) return renderCloudflare();
  if (e.target.closest('button[data-dns-add]')) return openDnsModal();
  const edit = e.target.closest('button[data-dns-edit]');
  if (edit) return openDnsModal(cfZone.records.find((x) => x.id === edit.dataset.dnsEdit));
  const del = e.target.closest('button[data-dns-delete]');
  if (del) return deleteDns(del.dataset.dnsDelete, del);
  const remove = e.target.closest('button[data-zone-remove]');
  if (remove) return removeCfZone(remove.dataset.zoneRemove, remove);
  const open = e.target.closest('button[data-zone]');
  if (open) openCfZone(open.dataset.zone);
});

$('#btn-cf-back').addEventListener('click', () => openAccounts('cloudflare'));
$('#btn-cf-refresh').addEventListener('click', async (e) => {
  busy(e.target, true, 'Reading…');
  try {
    const r = await api(`/credentials/${currentCfId}/cloudflare/account`, { method: 'POST' });
    toast(`Read ${r.account.accounts.length} accounts and ${r.account.zones.length} zones`);
    await openCloudflare(currentCfId);
  } catch (err) {
    toast(err.message, 'err');
  }
  busy(e.target, false);
});

/* --------------------------------------------- Cloudflare: Zero Trust */

/**
 * Tunnels with their public hostnames, private networks reached from PCs
 * running WARP, and the PCs themselves. Everything is per account.
 */
let zt = null;
let ztTab = 'tunnels';
let ztFilter = null; // 'running' or 'all'; starts on running when any are

/** A tunnel is running while cloudflared holds at least one connection. */
const isRunning = (t) => t.status === 'healthy' || t.status === 'degraded';

const ztBase = () => `/credentials/${currentCfId}/cloudflare/accounts/${zt.account.id}`;
const ztZones = () => (currentCf.extra.account?.zones || []).filter((z) => z.accountId === zt.account.id);

async function openZeroTrust(accountId) {
  const accounts = currentCf?.extra.account?.accounts || [];
  if (!accounts.length) return toast('This token cannot see any Cloudflare account. Refresh the details, or connect again with a new token.', 'err');
  const acc = accounts.find((a) => a.id === accountId) || accounts.find((a) => a.id === zt?.account.id) || accounts[0];
  if (acc.id !== zt?.account.id) ztFilter = null;
  const box = $('#cf-body');
  box.innerHTML = '<div class="empty"><span class="spinner"></span>Loading Zero Trust…</div>';
  try {
    zt = await api(`/credentials/${currentCfId}/cloudflare/accounts/${acc.id}/zero-trust`, { method: 'POST' });
    renderZeroTrust();
  } catch (err) {
    toast(err.message, 'err');
    renderCloudflare();
  }
}

const TUNNEL_STATUS = { healthy: 'ok', degraded: 'warn', down: 'err', inactive: '' };
const ztNote = (text) => `<div class="card"><p class="muted small" style="margin:0">${text}</p></div>`;

function renderZeroTrust() {
  const accounts = currentCf.extra.account?.accounts || [];
  const tunnels = zt.tunnels || [];
  const tabs = [
    ['tunnels', 'Tunnels & public hostnames', zt.tunnels?.length],
    ['networks', 'Private networks', zt.routes?.length],
    ['devices', 'Devices (PCs)', zt.devices?.length],
  ];

  const running = tunnels.filter(isRunning);
  if (!ztFilter) ztFilter = running.length ? 'running' : 'all';
  const shown = ztFilter === 'running' ? running : tunnels;

  let body = '';
  if (ztTab === 'tunnels') {
    body = zt.tunnels === null
      ? ztNote(`Tunnels are not readable with this token. ${esc(zt.tunnelsError || '')}`)
      : `<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
          <button class="btn tiny ${ztFilter === 'running' ? 'primary' : ''}" data-zt-filter="running">Running · ${running.length}</button>
          <button class="btn tiny ${ztFilter === 'all' ? 'primary' : ''}" data-zt-filter="all">All · ${tunnels.length}</button>
          <span style="flex:1"></span>
          ${ifCan('create', `<button class="btn primary" data-zt-host-new ${tunnels.some((t) => t.remoteConfig) ? '' : 'disabled title="Create a tunnel first"'}>+ Add public hostname</button>
            <button class="btn" data-zt-tunnel-add>+ Create tunnel</button>`)}
        </div>
        ${shown.length
          ? shown.map(tunnelCard).join('')
          : ztNote(tunnels.length
            ? 'No tunnel is running right now — none has cloudflared connected. Show <b>All</b> to see them, and run a tunnel\'s install command on its machine to start it.'
            : 'No tunnels on this account yet. Create one, run the command it gives you on a machine, then add public hostnames to it.')}`;
  } else if (ztTab === 'networks') {
    body = zt.routes === null
      ? ztNote(`Private network routes are not readable with this token. ${esc(zt.routesError || '')}`)
      : `${ifCan('create', `<div style="display:flex;justify-content:flex-end;margin-bottom:10px"><button class="btn primary" data-zt-route-add ${tunnels.length ? '' : 'disabled title="Create a tunnel first"'}>+ Add private network</button></div>`)}
        ${table(
          [{ label: 'Network' }, { label: 'Tunnel' }, { label: 'Comment' }, { label: 'Added' }, { label: '' }],
          zt.routes.map((r) => [
            `<code>${esc(r.network)}</code>`,
            esc(r.tunnelName || tunnels.find((t) => t.id === r.tunnelId)?.name || r.tunnelId),
            val(r.comment),
            `<span class="small">${cfDate(r.createdAt)}</span>`,
            `<div style="display:flex;gap:6px;justify-content:flex-end">
              ${ifCan('edit', `<button class="btn tiny" data-zt-route-edit="${esc(r.id)}">Edit</button>`)}
              ${ifCan('delete', `<button class="btn tiny danger" data-zt-route-delete="${esc(r.id)}">Delete</button>`)}
            </div>`,
          ]),
          'No private networks yet. Add one so PCs running WARP can reach machines behind a tunnel by their private IP.')}
        <p class="muted small">PCs reach these ranges once they are signed in to your Zero Trust organisation with the Cloudflare WARP client (see Devices).</p>`;
  } else {
    body = zt.devices === null
      ? ztNote(`Devices are not readable with this token. ${esc(zt.devicesError || '')}`)
      : `${table(
          [{ label: 'Device' }, { label: 'User' }, { label: 'OS' }, { label: 'WARP' }, { label: 'IP' }, { label: 'Last seen' }, { label: '' }],
          zt.devices.map((d) => [
            `${val(d.name)}<div class="muted small">${esc([d.model, d.serial].filter(Boolean).join(' · '))}</div>`,
            d.user ? `${val(d.user.email)}${d.user.name ? `<div class="muted small">${esc(d.user.name)}</div>` : ''}` : '—',
            `${d.type ? `<span class="chip">${esc(d.type)}</span> ` : ''}<span class="small">${val(d.osVersion)}</span>`,
            val(d.version),
            d.ip ? `<code class="small">${esc(d.ip)}</code>` : '—',
            `<span class="small">${cfDate(d.lastSeen)}</span>`,
            ifCan('delete', `<button class="btn tiny danger" data-zt-device-revoke="${esc(d.id)}">Revoke</button>`),
          ]),
          'No PCs are enrolled yet.')}
        <p class="muted small">To add a PC: install Cloudflare WARP from <a href="https://one.one.one.one/" target="_blank" rel="noopener">one.one.one.one</a>, then in WARP go to Preferences → Account → <b>Login to Cloudflare Zero Trust</b> and enter your team name${zt.team?.teamName ? ` <code>${esc(zt.team.teamName)}</code>` : ''}. It shows here once enrolled; revoking signs it out.</p>`;
  }

  const team = zt.team
    ? `Team domain <b><a href="https://${esc(zt.team.authDomain)}" target="_blank" rel="noopener">${esc(zt.team.authDomain)}</a></b>
       <span class="muted small">· team name <code>${esc(zt.team.teamName)}</code>${zt.team.name ? ` · ${esc(zt.team.name)}` : ''}</span>`
    : zt.teamError
      ? `<span class="muted small">Team domain: ${esc(zt.teamError)}</span>`
      : `<span>Zero Trust is not set up on this account yet — it has no team domain.</span>
         ${ifCan('create', '<button class="btn tiny primary" data-zt-team-add style="margin-left:8px">+ Add team domain</button>')}`;

  $('#cf-body').innerHTML = `
    <button class="link-back" data-cf-back>← back to domains</button>
    <div class="page-head" style="margin:8px 0 0">
      <div><h2 style="margin:0">Zero Trust</h2><p class="muted small" style="margin:4px 0 0">${esc(zt.account.name)}</p></div>
      <div class="actions">
        ${accounts.length > 1 ? `<select id="zt-account">${accounts.map((a) => `<option value="${esc(a.id)}" ${a.id === zt.account.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>` : ''}
        <button class="btn" data-zt-reload>Reload</button>
      </div>
    </div>
    ${zt.needsReconnect ? `<div class="msg err" style="margin-top:12px">
      This token was created without Zero Trust access, so Cloudflare hides your tunnels, routes and devices from it.
      Connect again — the new token asks for <b>Cloudflare Tunnel: Edit</b> and <b>Zero Trust: Edit</b> — and this account is updated in place.
      ${ifCan('create', '<div style="margin-top:8px"><button class="btn tiny primary" data-zt-reconnect>Reconnect with Zero Trust access</button></div>')}
    </div>` : ''}
    <div class="card" style="margin-top:12px">${team}</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin:14px 0">
      ${tabs.map(([key, label, n]) => `<button class="btn ${key === ztTab ? 'primary' : ''}" data-zt-tab="${key}">${esc(label)}${n ? ` · ${n}` : ''}</button>`).join('')}
    </div>
    ${body}`;
}

function tunnelCard(t) {
  const conns = t.connections.filter((c) => !c.pending);
  const hostRows = t.hostnames.map((h, i) => [
    `<a href="https://${esc(h.hostname)}${h.path ? `/${esc(h.path.replace(/^\//, ''))}` : ''}" target="_blank" rel="noopener">${esc(h.hostname)}</a>`,
    h.path ? `<code class="small">${esc(h.path)}</code>` : '<span class="muted small">*</span>',
    `<code class="small">${esc(h.service)}</code>`,
    `<span class="small">${esc([h.noTLSVerify && 'no TLS verify', h.httpHostHeader && `Host: ${h.httpHostHeader}`].filter(Boolean).join(' · ')) || '—'}</span>`,
    `<div style="display:flex;gap:6px;justify-content:flex-end">
      ${ifCan('edit', `<button class="btn tiny" data-zt-host-edit="${esc(t.id)}" data-i="${i}">Edit</button>`)}
      ${ifCan('delete', `<button class="btn tiny danger" data-zt-host-delete="${esc(t.id)}" data-i="${i}">Delete</button>`)}
    </div>`,
  ]);
  return `<div class="section">
    <div class="card" style="margin-bottom:8px">
      <div class="card-head">
        <div>
          <h3>${esc(t.name)} <span class="badge ${TUNNEL_STATUS[t.status] ?? ''}">${esc(t.status)}</span>${t.warpRouting ? ' <span class="chip">WARP routing</span>' : ''}</h3>
          <div class="muted small"><code>${esc(t.id)}</code> · created ${cfDate(t.createdAt)}</div>
          <div class="muted small">${conns.length ? `${conns.length} connection${conns.length > 1 ? 's' : ''}: ${esc(conns.map((c) => `${c.colo}${c.originIp ? ` from ${c.originIp}` : ''}`).join(', '))}${conns[0].version ? ` · cloudflared ${esc(conns[0].version)}` : ''}` : 'not connected — run the install command on the machine'}</div>
        </div>
      </div>
      <div class="card-actions">
        ${ifCan('create', `<button class="btn tiny" data-zt-tunnel-install="${esc(t.id)}">Install command</button>`)}
        ${t.remoteConfig ? ifCan('create', `<button class="btn tiny primary" data-zt-host-add="${esc(t.id)}">+ Public hostname</button>`) : ''}
        ${ifCan('delete', `<button class="btn tiny danger" data-zt-tunnel-delete="${esc(t.id)}">Delete tunnel</button>`)}
      </div>
    </div>
    ${t.remoteConfig
      ? table([{ label: 'Public hostname' }, { label: 'Path' }, { label: 'Service' }, { label: 'Options' }, { label: '' }], hostRows, 'No public hostnames on this tunnel yet.')
      : ztNote('This tunnel is managed locally by its config.yml, so its public hostnames are changed on the machine, not here.')}
  </div>`;
}

const findTunnel = (id) => (zt.tunnels || []).find((t) => t.id === id);

/* --- tunnels */

const tunnelModal = $('#modal-tunnel');
const tunnelForm = $('#form-tunnel');
let tunnelCmd = null;

const INSTALL_COMMANDS = {
  Windows: (t) => `winget install --id Cloudflare.cloudflared\ncloudflared.exe service install ${t}`,
  Linux: (t) => `curl -L -o cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb\nsudo dpkg -i cloudflared.deb\nsudo cloudflared service install ${t}`,
  macOS: (t) => `brew install cloudflared\nsudo cloudflared service install ${t}`,
  Docker: (t) => `docker run -d --name cloudflared --restart unless-stopped cloudflare/cloudflared:latest tunnel --no-autoupdate run --token ${t}`,
};

function showInstall(name, token) {
  tunnelForm.hidden = true;
  $('#tunnel-install').hidden = false;
  $('#tunnel-title').textContent = `Run tunnel ${name}`;
  const pick = (os) => {
    tunnelCmd = INSTALL_COMMANDS[os](token);
    $('#tunnel-cmd').textContent = tunnelCmd;
    $$('#tunnel-os button').forEach((b) => b.classList.toggle('primary', b.dataset.os === os));
  };
  $('#tunnel-os').innerHTML = Object.keys(INSTALL_COMMANDS).map((os) => `<button type="button" class="btn tiny" data-os="${os}">${os}</button>`).join('');
  pick('Windows');
  $('#tunnel-os').onclick = (e) => { const b = e.target.closest('button[data-os]'); if (b) pick(b.dataset.os); };
  tunnelModal.classList.remove('hidden');
}

function openTunnelModal() {
  tunnelForm.reset();
  tunnelForm.hidden = false;
  $('#tunnel-install').hidden = true;
  $('#tunnel-title').textContent = 'Create tunnel';
  $('#tunnel-msg').classList.add('hidden');
  tunnelModal.classList.remove('hidden');
  $('#tunnel-name').focus();
}

tunnelForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#btn-tunnel-save');
  busy(btn, true, 'Creating…');
  try {
    const r = await api(`${ztBase()}/tunnels`, { method: 'POST', body: { name: $('#tunnel-name').value.trim() } });
    toast(`Created tunnel ${r.tunnel.name}`);
    zt.tunnels = [...(zt.tunnels || []), r.tunnel];
    renderZeroTrust();
    showInstall(r.tunnel.name, r.token);
  } catch (err) {
    formMsg($('#tunnel-msg'), err.message, 'err');
  }
  busy(btn, false);
});

$('#btn-tunnel-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(tunnelCmd);
    toast('Command copied');
  } catch {
    toast('Copy failed — select the command and copy it by hand.', 'err');
  }
});

async function installTunnel(id, btn) {
  const t = findTunnel(id);
  busy(btn, true, '…');
  try {
    const r = await api(`${ztBase()}/tunnels/${id}/token`, { method: 'POST' });
    showInstall(t.name, r.token);
  } catch (err) {
    toast(err.message, 'err');
  }
  busy(btn, false);
}

async function deleteTunnel(id, btn) {
  const t = findTunnel(id);
  const typed = prompt(
    `Delete tunnel ${t.name}?\n\n`
    + `Its ${t.hostnames.length} public hostname(s) stop working, their DNS records are removed, and private networks routed through it are removed too. `
    + 'cloudflared on the machine is disconnected.\n\nType the tunnel name to confirm:'
  );
  if (typed === null) return;
  if (typed.trim() !== t.name) return toast('The name did not match — nothing was deleted.', 'err');
  busy(btn, true, 'Deleting…');
  try {
    await api(`${ztBase()}/tunnels/${id}`, { method: 'DELETE', body: { name: t.name } });
    toast(`Deleted tunnel ${t.name}`);
    openZeroTrust(zt.account.id);
  } catch (err) {
    toast(err.message, 'err');
    busy(btn, false);
  }
}

/* --- public hostnames */

const hostModal = $('#modal-hostname');
const hostForm = $('#form-hostname');
let editingHost = null;

const SERVICE_PLACEHOLDER = {
  http: 'localhost:8080', https: 'localhost:8443', ssh: 'localhost:22', rdp: 'localhost:3389',
  tcp: 'localhost:5432', smb: 'localhost:445', unix: '/run/app.sock', http_status: '404',
};

function splitService(service) {
  const m = /^([a-z_]+):(?:\/\/)?(.*)$/.exec(service || '');
  if (!m || !(m[1] in SERVICE_PLACEHOLDER)) return ['http', ''];
  return [m[1], m[2]];
}

/**
 * Add or edit a public hostname. Without a tunnel the person picks one; the
 * tunnels that are running come first, since only they answer straight away.
 */
function openHostModal(tunnelId = null, index = null) {
  const choices = (zt.tunnels || []).filter((x) => x.remoteConfig)
    .sort((a, b) => Number(isRunning(b)) - Number(isRunning(a)) || a.name.localeCompare(b.name));
  if (!choices.length) return toast('No tunnel here can take public hostnames. Create a tunnel first.', 'err');
  const t = findTunnel(tunnelId) || choices[0];
  const host = index === null ? null : t.hostnames[index];
  editingHost = { original: host };
  hostForm.reset();
  $('#hostname-msg').classList.add('hidden');
  $('#hostname-title').textContent = host ? 'Edit public hostname' : 'Add public hostname';
  $('#btn-hostname-save').textContent = host ? 'Save changes' : 'Add hostname';
  $('#hostname-note').innerHTML = 'A proxied CNAME to the tunnel is created in DNS for you; changes go live straight away.';
  $('#hostname-tunnel').innerHTML = choices.map((x) =>
    `<option value="${esc(x.id)}" ${x.id === t.id ? 'selected' : ''}>${esc(x.name)} — ${isRunning(x) ? `running (${esc(x.status)})` : `not running (${esc(x.status)})`}</option>`).join('');
  // A hostname stays on its tunnel while it is edited; delete and re-add to move it.
  $('#hostname-tunnel').disabled = Boolean(host);

  const zones = ztZones().map((z) => z.name).sort();
  let sub = '';
  let domain = zones[0] || '';
  if (host) {
    const bare = host.hostname;
    domain = zones.filter((z) => bare === z || bare.endsWith(`.${z}`)).sort((a, b) => b.length - a.length)[0] || bare.split('.').slice(-2).join('.');
    sub = bare === domain ? '' : bare.slice(0, -(domain.length + 1));
    if (!zones.includes(domain)) zones.push(domain);
  }
  $('#hostname-domain').innerHTML = zones.length
    ? zones.map((z) => `<option ${z === domain ? 'selected' : ''}>${esc(z)}</option>`).join('')
    : '<option value="">No domains on this account</option>';
  $('#hostname-sub').value = sub;

  if (host) {
    const [type, url] = splitService(host.service);
    hostForm.serviceType.value = type;
    hostForm.serviceUrl.value = url;
    hostForm.path.value = host.path;
    hostForm.noTLSVerify.checked = host.noTLSVerify;
    hostForm.httpHostHeader.value = host.httpHostHeader;
  }
  hostForm.serviceUrl.placeholder = SERVICE_PLACEHOLDER[hostForm.serviceType.value];
  hostModal.classList.remove('hidden');
  $('#hostname-sub').focus();
}

hostForm.serviceType.addEventListener('change', () => { hostForm.serviceUrl.placeholder = SERVICE_PLACEHOLDER[hostForm.serviceType.value]; });

hostForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#btn-hostname-save');
  const sub = $('#hostname-sub').value.trim().replace(/\.+$/, '');
  const domain = hostForm.domain.value;
  if (!domain) return formMsg($('#hostname-msg'), 'Add a domain to this Cloudflare account first.', 'err');
  const body = {
    hostname: sub ? `${sub}.${domain}` : domain,
    path: hostForm.path.value.trim(),
    serviceType: hostForm.serviceType.value,
    serviceUrl: hostForm.serviceUrl.value.trim(),
    noTLSVerify: hostForm.noTLSVerify.checked,
    httpHostHeader: hostForm.httpHostHeader.value.trim(),
  };
  const { original } = editingHost;
  const tunnelId = $('#hostname-tunnel').value;
  busy(btn, true, 'Saving…');
  try {
    const r = await api(`${ztBase()}/tunnels/${tunnelId}/hostnames`, original
      ? { method: 'PUT', body: { ...body, original: { hostname: original.hostname, path: original.path } } }
      : { method: 'POST', body });
    findTunnel(tunnelId).hostnames = r.hostnames;
    hostModal.classList.add('hidden');
    toast(`${original ? 'Updated' : 'Added'} ${body.hostname}`);
    renderZeroTrust();
  } catch (err) {
    formMsg($('#hostname-msg'), err.message, 'err');
  }
  busy(btn, false);
});

async function deleteHost(tunnelId, index, btn) {
  const t = findTunnel(tunnelId);
  const h = t.hostnames[index];
  if (!confirm(`Remove ${h.hostname}${h.path ? ` (path ${h.path})` : ''} from tunnel ${t.name}?\n\nIt stops answering straight away, and its DNS record is removed.`)) return;
  busy(btn, true, '…');
  try {
    const r = await api(`${ztBase()}/tunnels/${tunnelId}/hostnames`, { method: 'DELETE', body: { hostname: h.hostname, path: h.path } });
    t.hostnames = r.hostnames;
    toast(`Removed ${h.hostname}`);
    renderZeroTrust();
  } catch (err) {
    toast(err.message, 'err');
    busy(btn, false);
  }
}

/* --- private networks */

const routeModal = $('#modal-route');
const routeForm = $('#form-route');
let editingRoute = null;

function openRouteModal(route = null) {
  editingRoute = route;
  routeForm.reset();
  $('#route-msg').classList.add('hidden');
  $('#route-title').textContent = route ? 'Edit private network' : 'Add private network';
  $('#btn-route-save').textContent = route ? 'Save changes' : 'Add network';
  $('#route-tunnel').innerHTML = (zt.tunnels || []).map((t) => `<option value="${esc(t.id)}">${esc(t.name)} (${esc(t.status)})</option>`).join('');
  if (route) {
    routeForm.network.value = route.network;
    routeForm.tunnelId.value = route.tunnelId;
    routeForm.comment.value = route.comment;
  }
  routeModal.classList.remove('hidden');
  routeForm.network.focus();
}

routeForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#btn-route-save');
  const body = { network: routeForm.network.value.trim(), tunnelId: routeForm.tunnelId.value, comment: routeForm.comment.value.trim() };
  busy(btn, true, 'Saving…');
  try {
    const r = editingRoute
      ? await api(`${ztBase()}/routes/${editingRoute.id}`, { method: 'PUT', body })
      : await api(`${ztBase()}/routes`, { method: 'POST', body });
    routeModal.classList.add('hidden');
    toast(`${editingRoute ? 'Updated' : 'Added'} private network ${r.route.network}`);
    busy(btn, false);
    openZeroTrust(zt.account.id);
  } catch (err) {
    formMsg($('#route-msg'), err.message, 'err');
    busy(btn, false);
  }
});

async function deleteRoute(id, btn) {
  const r = zt.routes.find((x) => x.id === id);
  if (!confirm(`Remove private network ${r.network}?\n\nPCs running WARP can no longer reach it through the tunnel.`)) return;
  busy(btn, true, '…');
  try {
    await api(`${ztBase()}/routes/${id}`, { method: 'DELETE', body: { network: r.network } });
    zt.routes = zt.routes.filter((x) => x.id !== id);
    toast(`Removed ${r.network}`);
    renderZeroTrust();
  } catch (err) {
    toast(err.message, 'err');
    busy(btn, false);
  }
}

/* --- devices */

async function revokeDevice(id, btn) {
  const d = zt.devices.find((x) => x.id === id);
  const label = d.name || d.model || id;
  if (!confirm(`Revoke ${label}${d.user?.email ? ` (${d.user.email})` : ''}?\n\nThe PC is signed out of Zero Trust and has to enrol again with WARP.`)) return;
  busy(btn, true, '…');
  try {
    await api(`${ztBase()}/devices/${id}`, { method: 'DELETE', body: { name: label } });
    zt.devices = zt.devices.filter((x) => x.id !== id);
    toast(`Revoked ${label}`);
    renderZeroTrust();
  } catch (err) {
    toast(err.message, 'err');
    busy(btn, false);
  }
}

/** Check Cloudflare for the tunnels running right now, then add a hostname to one. */
async function newHostname(btn) {
  busy(btn, true, 'Checking tunnels…');
  try {
    const fresh = await api(`${ztBase()}/zero-trust`, { method: 'POST' });
    zt = fresh;
    renderZeroTrust();
    const running = (zt.tunnels || []).filter((t) => t.remoteConfig && isRunning(t));
    if (!running.length && (zt.tunnels || []).some((t) => t.remoteConfig)) {
      toast('No tunnel is running right now — the hostname will answer once its tunnel is started.', 'err');
    }
    openHostModal();
  } catch (err) {
    toast(err.message, 'err');
    busy(btn, false);
  }
}

/** Set up Zero Trust on the account with a team domain, <team>.cloudflareaccess.com. */
async function addTeamDomain(btn) {
  const suggestion = String(zt.account.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const typed = prompt(
    'Team name for Zero Trust on this account.\n\n'
    + 'It becomes your team domain, <team>.cloudflareaccess.com — people type it in WARP to enrol their PC, and it is where they sign in.\n\n'
    + 'Team name:', suggestion
  );
  if (typed === null || !typed.trim()) return;
  busy(btn, true, 'Setting up…');
  try {
    const r = await api(`${ztBase()}/team`, { method: 'POST', body: { teamName: typed.trim(), name: zt.account.name } });
    zt.team = r.team;
    zt.teamError = null;
    toast(`Zero Trust is set up — team domain ${r.team.authDomain}`);
    renderZeroTrust();
  } catch (err) {
    toast(err.message, 'err');
    busy(btn, false);
  }
}

$('#btn-cf-zt').addEventListener('click', () => openZeroTrust());

$('#cf-body').addEventListener('change', (e) => {
  if (e.target.id === 'zt-account') openZeroTrust(e.target.value);
});

$('#cf-body').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || !zt) return;
  const d = b.dataset;
  if (d.ztTab) { ztTab = d.ztTab; return renderZeroTrust(); }
  if ('ztReload' in d) return openZeroTrust(zt.account.id);
  if (d.ztFilter) { ztFilter = d.ztFilter; return renderZeroTrust(); }
  if ('ztHostNew' in d) return newHostname(b);
  if ('ztTeamAdd' in d) return addTeamDomain(b);
  if ('ztReconnect' in d) {
    // The same name makes the connect step update this account instead of adding another.
    openCloudflareModal();
    $('#cf-token-name').value = currentCf.name;
    return;
  }
  if ('ztTunnelAdd' in d) return openTunnelModal();
  if (d.ztTunnelInstall) return installTunnel(d.ztTunnelInstall, b);
  if (d.ztTunnelDelete) return deleteTunnel(d.ztTunnelDelete, b);
  if (d.ztHostAdd) return openHostModal(d.ztHostAdd);
  if (d.ztHostEdit) return openHostModal(d.ztHostEdit, Number(d.i));
  if (d.ztHostDelete) return deleteHost(d.ztHostDelete, Number(d.i), b);
  if ('ztRouteAdd' in d) return openRouteModal();
  if (d.ztRouteEdit) return openRouteModal(zt.routes.find((r) => r.id === d.ztRouteEdit));
  if (d.ztRouteDelete) return deleteRoute(d.ztRouteDelete, b);
  if (d.ztDeviceRevoke) return revokeDevice(d.ztDeviceRevoke, b);
});

/* -------------------------------------------------------- credentials */

const CRED_HINTS = {
  git: 'A GitHub or GitLab access token with repo/read_api scope, or a Bitbucket API or access token. It is authenticated as soon as you save.',
  dockerhub: 'Docker Hub username plus an access token from Account Settings → Security.',
  cloudflare: 'Cloudflare API token with Zone:Read and DNS:Edit for the zones you manage (plus Cloudflare Tunnel:Edit and Zero Trust:Edit for Zero Trust).',
  mysql: 'A MySQL user and password. Pick the server it runs on so the panel can tunnel over SSH.',
  postgres: 'A PostgreSQL role and password. A superuser (or a role with CREATEROLE and CREATEDB) can also manage users and databases.',
  mongodb: 'A MongoDB user, or nothing if authentication is off. A full mongodb+srv:// connection string also works as the host (Atlas).',
  redis: 'The Redis password (requirepass), plus an ACL username on Redis 6+ if you use one.',
};

/** Docker Hub accounts, on their tab under Account management. */
async function loadCredentials() {
  const box = $('#cred-list');
  box.innerHTML = '<div class="empty">Loading…</div>';
  const creds = await api('/credentials?provider=dockerhub');
  if (!creds.length) {
    box.innerHTML = '<div class="empty">No Docker Hub accounts yet. Click <b>+ Connect Docker Hub</b> and sign in on Docker Hub.</div>';
    return;
  }
  box.innerHTML = creds.map((c) => {
    const a = c.extra.account || {};
    const repos = a.repositories || [];
    const access = a.access
      ? ['pull', a.access.push && 'push', a.access.delete && 'delete'].filter(Boolean).map((x) => `<span class="chip">${x}</span>`).join(' ')
        + (a.access.push ? '' : ' <span class="badge warn">cannot push</span>')
      : '—';
    return `
    <div class="card">
      <div class="card-head">
        <div>
          <h3>${esc(c.name)}</h3>
          <div class="muted small">${c.username ? `<a href="https://hub.docker.com/u/${esc(c.username)}" target="_blank" rel="noopener">${esc(c.username)}</a>` : ''}${a.fullName ? ` · ${esc(a.fullName)}` : ''}${a.email ? ` · ${esc(a.email)}` : ''}</div>
        </div>
        <span class="badge ${c.status === 'valid' ? 'ok' : c.status === 'invalid' ? 'err' : ''}">${esc(c.status)}</span>
      </div>
      <dl class="kv">
        <dt>Token</dt><dd><code>${esc(c.secretHint)}</code>${a.tokenKind ? ` <span class="muted small">${esc(a.tokenKind)}</span>` : ''}</dd>
        <dt>May</dt><dd>${access}</dd>
        <dt>Repositories</dt><dd>${a.repositoryCount !== undefined && a.repositoryCount !== null
          ? `${esc(a.repositoryCount)} <span class="muted small">${esc(repos.slice(0, 4).map((r) => r.name).join(', '))}${repos.length > 4 ? '…' : ''}</span>`
          : '<span class="muted small">not read yet — press Verify</span>'}</dd>
        ${a.organizations?.length ? `<dt>Organisations</dt><dd>${a.organizations.map((o) => `<span class="chip">${esc(o.name)}</span>`).join(' ')}</dd>` : ''}
        <dt>Verified</dt><dd>${val(c.verified_at)}</dd>
      </dl>
      ${c.last_error ? `<div class="msg err" style="margin-top:10px">${esc(c.last_error)}</div>` : ''}
      <div class="card-actions">
        <button class="btn tiny" data-cred-action="open" data-id="${c.id}">Repositories</button>
        <button class="btn tiny" data-cred-action="verify" data-id="${c.id}">Verify</button>
        ${ifCan('create', `<button class="btn tiny" data-cred-action="reconnect" data-id="${c.id}" data-user="${esc(c.username || '')}" data-name="${esc(c.name)}">Reconnect</button>`)}
        ${ifCan('delete', `<button class="btn tiny danger" data-cred-action="delete" data-id="${c.id}">Delete</button>`)}
      </div>
    </div>`;
  }).join('');
}

/* ------------------------------------------- Docker Hub: browser sign-in */

/**
 * Docker Hub has no OAuth for panels like this one, so "sign in" opens its
 * New access token page. When the person comes back with the token on their
 * clipboard the panel picks it up, signs in with it and reads the account.
 */
const dhModal = $('#modal-dockerhub');
let dhWait = null;
let dhConnecting = false;
const looksLikeDhToken = (t) => /^dckr_(pat|oat)_[A-Za-z0-9_-]{20,}$/.test(String(t || '').trim());

function stopDhWait() {
  if (!dhWait) return;
  clearInterval(dhWait.timer);
  window.removeEventListener('focus', dhWait.onFocus);
  dhWait = null;
  $('#dh-waiting').hidden = true;
}

async function openDockerHubModal({ username = '', name = '' } = {}) {
  stopDhWait();
  let remembered = '';
  try { remembered = localStorage.getItem('dockerhub-id') || ''; } catch { /* storage blocked */ }
  $('#dh-username').value = username || remembered;
  $('#dh-token').value = '';
  $('#dh-name').value = name;
  $('#dh-msg').classList.add('hidden');
  dhModal.classList.remove('hidden');
  ($('#dh-username').value ? $('#btn-dh-open') : $('#dh-username')).focus();
  try {
    const link = await api('/credentials/dockerhub/token-link');
    $('#btn-dh-open').dataset.url = link.url;
    $('#dh-description').textContent = link.description;
  } catch { /* the button falls back to the plain tokens page */ }
}

$('#btn-dh-open').addEventListener('click', (e) => {
  if (!$('#dh-username').value.trim()) {
    formMsg($('#dh-msg'), 'Type your Docker ID first — Docker Hub tokens sign in together with it.', 'err');
    return $('#dh-username').focus();
  }
  const url = e.currentTarget.dataset.url || 'https://app.docker.com/settings/personal-access-tokens/create';
  const popup = window.open(url, 'auto-deploy-dockerhub', 'width=1100,height=860');
  if (!popup) return toast('Your browser blocked the Docker Hub window. Allow pop-ups for this page and try again.', 'err');

  stopDhWait();
  const started = Date.now();
  $('#dh-waiting').hidden = false;
  $('#dh-timer').textContent = '0:00';
  // Coming back to this tab is the cue to look on the clipboard for the token.
  const onFocus = () => setTimeout(tryDhClipboard, 250);
  dhWait = {
    onFocus,
    timer: setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      $('#dh-timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      if (s >= 600) stopDhWait();
    }, 1000),
  };
  window.addEventListener('focus', onFocus);
});

async function tryDhClipboard() {
  if (!dhWait || dhModal.classList.contains('hidden') || !navigator.clipboard?.readText) return;
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (looksLikeDhToken(text) && text !== $('#dh-token').value) {
      $('#dh-token').value = text;
      connectDockerHub();
    }
  } catch { /* clipboard access refused — the paste box is the fallback */ }
}

// Pasting a token is enough; no need to press Connect as well.
$('#dh-token').addEventListener('paste', () => setTimeout(() => {
  if (looksLikeDhToken($('#dh-token').value)) connectDockerHub();
}, 0));

$('#btn-dh-connect').addEventListener('click', () => connectDockerHub());

async function connectDockerHub() {
  if (dhConnecting) return;
  const msg = $('#dh-msg');
  const btn = $('#btn-dh-connect');
  const username = $('#dh-username').value.trim();
  const secret = $('#dh-token').value.trim();
  if (!username) return formMsg(msg, 'Type your Docker ID.', 'err');
  if (!secret) return formMsg(msg, 'Create the token on Docker Hub, then paste it here.', 'err');

  dhConnecting = true;
  busy(btn, true, 'Signing in…');
  try {
    const r = await api('/credentials/dockerhub/connect', { method: 'POST', body: { username, secret, name: $('#dh-name').value.trim() } });
    try { localStorage.setItem('dockerhub-id', username); } catch { /* storage blocked */ }
    stopDhWait();
    dhModal.classList.add('hidden');
    const a = r.credential.extra.account || {};
    toast(`Connected Docker Hub ${a.username} — ${a.repositoryCount ?? 0} repositories${a.access && !a.access.push ? ' (this token cannot push)' : ''}`);
    if (!$('#view-accounts').classList.contains('hidden')) loadAccounts();
    else if (!$('#view-dh-detail').classList.contains('hidden')) openDockerHub(r.credential.id);
  } catch (err) {
    formMsg(msg, err.message, 'err');
  }
  busy(btn, false);
  dhConnecting = false;
}

// Closing the modal stops watching for the token.
dhModal.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', stopDhWait));

/* ------------------------------------ Docker Hub: repositories and tags */

let currentDh = null;   // the credential
let dhRepos = null;     // { namespace, count, repositories }
let dhRepo = null;      // one repository with its tags
let dhFilter = '';

const dhBase = () => `/credentials/${currentDh.id}/dockerhub/repositories`;
const hubDate = (v) => (v ? esc(String(v).replace('T', ' ').slice(0, 16)) : '—');
const shortDigest = (d) => (d ? `<code class="small" title="${esc(d)}">${esc(d.replace(/^sha256:/, '').slice(0, 12))}</code>` : '—');
const hubCount = (n) => (n === null || n === undefined ? '—' : esc(Number(n).toLocaleString()));

async function openDockerHub(id, namespace) {
  show('dh-detail');
  setHeading('Account management');
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === 'accounts'));
  $('#dh-body').innerHTML = '<div class="empty"><span class="spinner"></span>Loading repositories…</div>';
  try {
    currentDh = await api(`/credentials/${id}`);
    const a = currentDh.extra.account || {};
    $('#dh-title').textContent = currentDh.name;
    $('#dh-sub').textContent = [currentDh.username, a.fullName, a.email].filter(Boolean).join(' · ');
    const namespaces = [currentDh.username, ...(a.organizations || []).map((o) => o.name)].filter(Boolean);
    const ns = namespace || namespaces[0];
    $('#dh-namespace').innerHTML = namespaces.map((n) => `<option ${n === ns ? 'selected' : ''}>${esc(n)}</option>`).join('');
    $('#dh-namespace').classList.toggle('hidden', namespaces.length < 2);
    dhRepos = await api(dhBase(), { method: 'POST', body: { namespace: ns } });
    dhFilter = '';
    renderHubRepos();
  } catch (err) {
    $('#dh-body').innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
  }
}

function renderHubRepos(keepFocus = false) {
  const all = dhRepos.repositories;
  const q = dhFilter.toLowerCase();
  const list = q ? all.filter((r) => r.name.includes(q) || r.description.toLowerCase().includes(q)) : all;
  const a = currentDh.extra.account || {};
  $('#dh-body').innerHTML = `
    <div class="tiles">
      ${tile('Repositories', hubCount(dhRepos.count), `${all.filter((r) => r.private).length} private · ${all.filter((r) => !r.private).length} public`)}
      ${tile('Pulls', hubCount(all.reduce((s, r) => s + (r.pulls || 0), 0)), `across ${esc(dhRepos.namespace)}`)}
      ${tile('Stars', hubCount(all.reduce((s, r) => s + (r.stars || 0), 0)))}
      ${tile('Token may', a.access ? esc(['pull', a.access.push && 'push', a.access.delete && 'delete'].filter(Boolean).join(', ')) : '—', esc(a.tokenKind || ''))}
    </div>
    ${section(`Repositories in ${dhRepos.namespace}`, `
      <input id="dh-search" placeholder="Search repositories" value="${esc(dhFilter)}" autocomplete="off" style="margin-bottom:10px" />
      ${table(
        [{ label: 'Repository' }, { label: 'Visibility' }, { label: 'Pulls', num: true }, { label: 'Stars', num: true }, { label: 'Size', num: true }, { label: 'Updated' }],
        list.map((r) => [
          `<button class="link-db" data-hub-repo="${esc(r.name)}">${esc(r.namespace)}/${esc(r.name)}</button>${r.description ? `<div class="muted small">${esc(r.description)}</div>` : ''}`,
          r.private ? '<span class="badge warn">private</span>' : '<span class="badge ok">public</span>',
          hubCount(r.pulls),
          hubCount(r.stars),
          r.storageSize !== null ? bytes(r.storageSize) : '—',
          `<span class="small">${hubDate(r.lastUpdated)}</span>`,
        ]),
        q ? 'No repository matches that search' : 'No repositories in this namespace yet — push an image to create one.')}`)}
    <p class="muted small">Click a repository for its details and every tag.</p>`;
  // Typing re-renders the list; keep the cursor in the search box.
  if (keepFocus) {
    const search = $('#dh-search');
    search.focus();
    search.setSelectionRange(search.value.length, search.value.length);
  }
}

async function openHubRepo(repo) {
  const ns = dhRepos.namespace;
  $('#dh-body').innerHTML = '<div class="empty"><span class="spinner"></span>Loading tags…</div>';
  try {
    dhRepo = await api(`${dhBase()}/${encodeURIComponent(ns)}/${encodeURIComponent(repo)}`, { method: 'POST' });
    renderHubRepo();
  } catch (err) {
    toast(err.message, 'err');
    renderHubRepos();
  }
}

function renderHubRepo() {
  const r = dhRepo.repository;
  const full = `${r.namespace}/${r.name}`;
  const tags = dhRepo.tags;
  const perms = r.permissions ? ['read', 'write', 'admin'].filter((p) => r.permissions[p]).join(', ') || 'none' : '—';
  const latest = tags.find((t) => t.name === 'latest') || tags[0];

  $('#dh-body').innerHTML = `
    <button class="link-back" data-hub-back>← back to repositories</button>
    <div class="page-head" style="margin:8px 0 0">
      <div><h2 style="margin:0">${esc(full)} ${r.private ? '<span class="badge warn">private</span>' : '<span class="badge ok">public</span>'}</h2>
        <p class="muted small" style="margin:4px 0 0">${esc(r.description || 'No short description')}</p></div>
      <div class="actions"><a class="btn" href="https://hub.docker.com/r/${esc(full)}" target="_blank" rel="noopener">Open on Docker Hub ↗</a></div>
    </div>
    <div class="tiles">
      ${tile('Tags', hubCount(dhRepo.tagCount))}
      ${tile('Pulls', hubCount(r.pulls))}
      ${tile('Stars', hubCount(r.stars))}
      ${tile('Storage', r.storageSize !== null ? bytes(r.storageSize) : '—')}
      ${tile('Last push', hubDate(r.lastUpdated))}
    </div>
    <div class="grid">
      ${kvCard('Repository', [
        ['Name', `<code>${esc(full)}</code>`],
        ['Status', val(r.status)],
        ['Type', val(r.type)],
        ['Your access', esc(perms)],
        ['Collaborators', val(r.collaborators)],
        ['Categories', r.categories.length ? r.categories.map((c) => `<span class="chip">${esc(c)}</span>`).join(' ') : '—'],
        ['Immutable tags', yesNo(r.immutableTags)],
        ['Created', hubDate(r.registered)],
        ['Modified', hubDate(r.lastModified)],
      ])}
      ${kvCard('Pull', [
        ['Latest', `<code class="small">docker pull ${esc(full)}${latest && latest.name !== 'latest' ? `:${esc(latest.name)}` : ''}</code>
          <button class="btn tiny" data-hub-copy="docker pull ${esc(full)}${latest && latest.name !== 'latest' ? `:${esc(latest.name)}` : ''}">Copy</button>`],
        ['Push', `<code class="small">docker push ${esc(full)}:&lt;tag&gt;</code>`],
        ['Media types', r.mediaTypes.length ? `<span class="small">${r.mediaTypes.map((m) => esc(m.replace(/^application\//, ''))).join('<br>')}</span>` : '—'],
      ])}
    </div>
    ${section(`Tags · ${tags.length}${dhRepo.tagCount > tags.length ? ` of ${dhRepo.tagCount}` : ''}`, table(
      [{ label: 'Tag' }, { label: 'Platforms' }, { label: 'Size', num: true }, { label: 'Digest' }, { label: 'Pushed' }, { label: 'Pulled' }, { label: '' }],
      tags.map((t) => [
        `<b>${esc(t.name)}</b>${t.pushedBy ? `<div class="muted small">by ${esc(t.pushedBy)}</div>` : ''}${t.status && t.status !== 'active' ? ` <span class="badge warn">${esc(t.status)}</span>` : ''}`,
        t.images.length
          ? `<details><summary class="small">${t.images.length} platform${t.images.length > 1 ? 's' : ''}: ${esc(t.images.slice(0, 3).map((i) => i.platform).join(', '))}${t.images.length > 3 ? '…' : ''}</summary>
              <table class="small" style="margin-top:6px"><tbody>${t.images.map((i) => `<tr><td>${esc(i.platform)}</td><td class="num">${i.size !== null ? bytes(i.size) : '—'}</td><td>${shortDigest(i.digest)}</td><td>${hubDate(i.lastPushed)}</td></tr>`).join('')}</tbody></table>
            </details>`
          : '<span class="muted small">—</span>',
        t.size !== null ? bytes(t.size) : '—',
        shortDigest(t.digest),
        `<span class="small">${hubDate(t.lastPushed || t.lastUpdated)}</span>`,
        `<span class="small">${hubDate(t.lastPulled)}</span>`,
        `<div style="display:flex;gap:6px;justify-content:flex-end">
          <button class="btn tiny" data-hub-copy="docker pull ${esc(full)}:${esc(t.name)}">Copy pull</button>
          ${ifCan('delete', `<button class="btn tiny danger" data-hub-tag-delete="${esc(t.name)}">Delete</button>`)}
        </div>`,
      ]),
      'This repository has no tags yet'))}
    ${r.fullDescription ? section('Overview (README)', `<div class="card"><pre class="log tall" style="white-space:pre-wrap">${esc(r.fullDescription)}</pre></div>`) : ''}`;
}

async function deleteHubTag(tag, btn) {
  const r = dhRepo.repository;
  if (!confirm(`Delete tag ${r.namespace}/${r.name}:${tag} on Docker Hub?\n\nAnything pulling this tag stops getting it. This cannot be undone.`)) return;
  busy(btn, true, '…');
  try {
    await api(`${dhBase()}/${encodeURIComponent(r.namespace)}/${encodeURIComponent(r.name)}/tags/${encodeURIComponent(tag)}`, { method: 'DELETE' });
    toast(`Deleted ${r.name}:${tag}`);
    openHubRepo(r.name);
  } catch (err) {
    toast(err.message, 'err');
    busy(btn, false);
  }
}

$('#dh-body').addEventListener('input', (e) => {
  if (e.target.id !== 'dh-search') return;
  dhFilter = e.target.value;
  renderHubRepos(true);
});

$('#dh-body').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const d = b.dataset;
  if (d.hubRepo) return openHubRepo(d.hubRepo);
  if ('hubBack' in d) return renderHubRepos();
  if (d.hubTagDelete) return deleteHubTag(d.hubTagDelete, b);
  if (d.hubCopy) {
    try {
      await navigator.clipboard.writeText(d.hubCopy);
      toast('Copied');
    } catch {
      toast('Copy failed — select the command and copy it by hand.', 'err');
    }
  }
});

$('#dh-namespace').addEventListener('change', (e) => openDockerHub(currentDh.id, e.target.value));
$('#btn-dh-back').addEventListener('click', () => openAccounts('dockerhub'));
$('#btn-dh-refresh').addEventListener('click', async (e) => {
  busy(e.target, true, 'Reading…');
  // On a repository page refresh its tags; otherwise the repository list.
  if ($('#dh-body [data-hub-back]')) await openHubRepo(dhRepo.repository.name);
  else await openDockerHub(currentDh.id, dhRepos?.namespace);
  busy(e.target, false);
});

$('#cred-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-cred-action]');
  if (!btn) return;
  const { credAction, id } = btn.dataset;
  if (credAction === 'open') return openDockerHub(id);
  if (credAction === 'reconnect') return openDockerHubModal({ username: btn.dataset.user, name: btn.dataset.name });
  if (credAction === 'delete') {
    if (!confirm('Delete this credential?')) return;
    await api(`/credentials/${id}`, { method: 'DELETE' });
    return loadCredentials();
  }
  busy(btn, true, 'Verifying…');
  try {
    const r = await api(`/credentials/${id}/verify`, { method: 'POST' });
    toast(`Verified: ${JSON.stringify(r.detail)}`);
  } catch (err) {
    toast(err.message, 'err');
  }
  await loadCredentials();
});

const CRED_TITLES = {
  git: 'Add git access token', dockerhub: 'Add Docker Hub account', cloudflare: 'Add Cloudflare API token',
  mysql: 'Add database connection', postgres: 'Add database connection', mongodb: 'Add database connection', redis: 'Add database connection',
};

/** MongoDB and Redis can run without authentication. */
const passwordOptional = (provider) => provider === 'mongodb' || provider === 'redis';

/** The form as the API wants it: an unticked TLS box is still an answer. */
function credBody() {
  const body = Object.fromEntries(new FormData(credForm).entries());
  body.provider = credForm.provider.value;
  if (DB_ENGINES[body.provider] && body.provider !== 'mysql') body.tls = credForm.tls.checked ? 'on' : 'off';
  return body;
}

const credModal = $('#modal-cred');
const credForm = $('#form-cred');

/**
 * Open the credential modal, optionally preset to one provider. Given an
 * existing credential it edits that one instead; the secret is then optional
 * and left alone unless something is typed into it.
 */
async function openCredModal(provider = 'git', existing = null) {
  credForm.reset();
  $('#cred-form-msg').classList.add('hidden');
  // Opened for a database, the picker offers only databases; opened for an account, only accounts.
  const forDatabase = Boolean(DB_ENGINES[provider]);
  for (const opt of credForm.provider.options) {
    const isDb = Boolean(DB_ENGINES[opt.value]);
    opt.hidden = isDb !== forDatabase;
    opt.disabled = isDb !== forDatabase;
  }
  credForm.provider.previousSibling.textContent = forDatabase ? 'Database' : 'Provider';
  credForm.provider.value = provider;
  applyCredProvider(provider);
  credForm.dataset.editId = existing ? existing.id : '';
  credForm.provider.disabled = Boolean(existing);
  credForm.secret.required = !existing && !passwordOptional(provider);
  credForm.secret.placeholder = existing ? `unchanged (${existing.secretHint || 'none'}) — type to replace` : '';
  if (existing) {
    $('#cred-title').textContent = `Edit ${existing.name}`;
    credForm.name.value = existing.name || '';
    credForm.username.value = existing.username || '';
    if (DB_ENGINES[provider]) {
      credForm.host.value = existing.extra?.host || '127.0.0.1';
      credForm.port.value = existing.extra?.port || DB_ENGINES[provider].port;
      credForm.database.value = existing.extra?.database ?? '';
      credForm.authSource.value = existing.extra?.authSource || 'admin';
      credForm.tls.checked = Boolean(existing.extra?.tls);
    }
    if (provider === 'git') {
      credForm.kind.value = existing.extra?.kind || 'github';
      credForm.authUser.value = existing.extra?.authUser || '';
      applyGitKind(credForm.kind.value);
    }
  }
  credModal.classList.remove('hidden');

  // The server list drives the SSH tunnel picker.
  try {
    const servers = await api('/servers');
    credForm.server_id.innerHTML = '<option value="">Direct connection (no tunnel)</option>'
      + servers.map((s) => `<option value="${s.id}">${esc(s.name)} — ${esc(s.host)}</option>`).join('');
    if (existing?.server_id) credForm.server_id.value = existing.server_id;
  } catch { /* the picker simply stays at "direct" */ }
}

function applyCredProvider(provider) {
  const engine = DB_ENGINES[provider];
  const isGit = provider === 'git';
  $('#cred-title').textContent = CRED_TITLES[provider] || 'Add credential';
  $('#cred-hint').textContent = CRED_HINTS[provider];
  $('#cred-mysql-fields').classList.toggle('hidden', !engine);
  $('#cred-git-fields').classList.toggle('hidden', !isGit);
  $('#btn-test-mysql').classList.toggle('hidden', !engine);
  $('#btn-test-git').classList.toggle('hidden', !isGit);
  // Git and Cloudflare identify the account from the token itself.
  $('#cred-username-field').classList.toggle('hidden', provider === 'cloudflare' || isGit);
  credForm.secret.parentElement.childNodes[0].textContent =
    engine ? `${engine.label} password${passwordOptional(provider) ? ' (empty if none)' : ''}` : isGit ? 'Access token' : 'Token / password';
  if (!credForm.dataset.editId) credForm.secret.required = !passwordOptional(provider);

  credForm.name.placeholder = engine ? `prod ${engine.label}` : 'main-github';
  $('#btn-cred-save').textContent = engine ? 'Save connection' : 'Save credential';

  if (engine) {
    $('#cred-authsource-field').classList.toggle('hidden', provider !== 'mongodb');
    $('#cred-tls-field').classList.toggle('hidden', provider === 'mysql');
    $('#cred-db-label').textContent = engine.dbLabel;
    credForm.username.placeholder = engine.userHint;
    // Switching engines moves the port along, unless it was typed in by hand.
    if (!credForm.port.value || Object.values(DB_ENGINES).some((e) => String(e.port) === credForm.port.value)) {
      credForm.port.value = engine.port;
    }
  } else {
    credForm.username.placeholder = 'account username';
  }
  if (isGit) applyGitKind(credForm.kind.value);
}

/** Bitbucket signs in with an email + API token (or a bare access token) and has no self-hosted API URL. */
function applyGitKind(kind) {
  const bitbucket = kind === 'bitbucket';
  $('#cred-apiurl-field').classList.toggle('hidden', bitbucket);
  $('#cred-authuser-field').classList.toggle('hidden', !bitbucket);
  $('#cred-bitbucket-hint').classList.toggle('hidden', !bitbucket);
  credForm.apiUrl.placeholder = kind === 'gitlab' ? 'https://gitlab.com/api/v4' : 'https://api.github.com';
  if (bitbucket) credForm.apiUrl.value = '';
}
credForm.kind.addEventListener('change', (e) => applyGitKind(e.target.value));

$('#btn-test-git').addEventListener('click', async (e) => {
  const msg = $('#cred-form-msg');
  busy(e.target, true, 'Authenticating…');
  try {
    const r = await api('/credentials/test-git', { method: 'POST', body: Object.fromEntries(new FormData(credForm).entries()) });
    const a = r.account;
    formMsg(msg, `Authenticated as ${a.login}${a.name ? ` (${a.name})` : ''} — ${a.accountType}`
      + `${a.scopes?.length ? `, scopes: ${a.scopes.join(', ')}` : `, ${a.tokenStyle}`} · ${a.latencyMs}ms`, 'ok');
  } catch (err) {
    formMsg(msg, err.message, 'err');
  }
  busy(e.target, false);
});

$('#btn-add-dockerhub').addEventListener('click', () => openDockerHubModal());
$('#btn-dh-connect-top').addEventListener('click', () => openDockerHubModal());

credForm.provider.addEventListener('change', (e) => applyCredProvider(e.target.value));

$('#btn-test-mysql').addEventListener('click', async (e) => {
  const msg = $('#cred-form-msg');
  busy(e.target, true, 'Connecting…');
  try {
    const body = credBody();
    if (body.provider === 'mysql') {
      const r = await api('/credentials/test-mysql', { method: 'POST', body });
      formMsg(msg, `Connected. MySQL ${r.version} on ${r.hostname}:${r.port} as ${r.currentUser} (${r.latencyMs}ms)`, 'ok');
    } else {
      const r = await api('/credentials/test-db', { method: 'POST', body });
      formMsg(msg, `Connected. ${r.version} as ${r.currentUser} (${r.latencyMs}ms)`, 'ok');
    }
  } catch (err) {
    formMsg(msg, err.message, 'err');
  }
  busy(e.target, false);
});

credForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#cred-form-msg');
  const btn = e.submitter;
  const provider = credForm.provider.value;
  const editId = credForm.dataset.editId;
  busy(btn, true, 'Saving…');
  try {
    if (editId) {
      await api(`/credentials/${editId}`, { method: 'PUT', body: credBody() });
      credModal.classList.add('hidden');
      toast('Connection updated');
      if (provider === 'mysql' && String(currentMysqlId) === String(editId) && !$('#view-mysql-detail').classList.contains('hidden')) openMysql(editId, { reset: true });
      else if (DB_ENGINES[provider] && String(currentEngineId) === String(editId) && !$('#view-db-detail').classList.contains('hidden')) openEngine(editId);
      else if (DB_ENGINES[provider]) loadMysqlList();
      busy(btn, false);
      return;
    }
    const created = await api('/credentials', { method: 'POST', body: credBody() });
    credModal.classList.add('hidden');
    if (DB_ENGINES[provider]) {
      toast('Connection saved');
      openDbConnection(created.id, provider);
    } else if (provider === 'git') {
      if (created.status === 'valid') {
        toast(`Connected as ${created.extra.account?.login}`);
        openGit(created.id);
      } else {
        // Saved, but the token did not authenticate — show why on the list.
        toast(created.last_error || 'Saved, but the token could not be authenticated', 'err');
        openAccounts('git');
      }
    } else {
      if (created.status === 'invalid') toast(created.last_error || 'Saved, but the token could not be verified', 'err');
      else toast('Account saved');
      openAccounts(provider);
    }
  } catch (err) {
    formMsg(msg, err.message, 'err');
  }
  busy(btn, false);
});

/* ------------------------------------------------------------ apps */

const APP_BADGE = { running: 'ok', deploying: 'warn', exited: 'err', error: 'err', pending: '', missing: 'err' };

/** How each project type shows itself on a card. */
const APP_TYPE_MARKS = {
  nextjs: { icon: '▲', label: 'Next.js' },
  nestjs: { icon: '🐦', label: 'NestJS' },
  nuxt: { icon: '💚', label: 'Nuxt' },
  node: { icon: '🟢', label: 'Node.js' },
  angular: { icon: '🅰️', label: 'Angular' },
  react: { icon: '⚛️', label: 'React · Vite' },
  static: { icon: '📄', label: 'Static site' },
};

/** The API sends a label; this keeps a sensible one if it ever does not. */
function appTypeMark(app) {
  const mark = APP_TYPE_MARKS[app.app_type] || {};
  return { icon: mark.icon || '📦', label: app.typeLabel || mark.label || 'Node.js' };
}

let appPoll = null;
let appWatch = null;

/**
 * A deployment takes minutes and runs on the server, so the page watches the
 * cards rather than holding a request open. Polling stops as soon as nothing
 * is in progress, and whenever the view holding the cards is left.
 *
 * The same cards appear on the Apps page and on a server's Apps tab, so the
 * watcher is told which view it is watching and what to call to redraw it.
 */
function watchDeployments(apps, { view = '#view-apps', reload = loadApps } = {}) {
  // A domain being set up after the deploy keeps the cards refreshing too.
  const busyNow = apps.some((a) => a.status === 'deploying' || a.domain_status === 'configuring');
  tickElapsed();

  if (!busyNow) return appPoll ? stopWatchingDeployments() : undefined;

  appWatch = { view, reload };
  if (!appPoll) appPoll = setInterval(() => {
    if ($(appWatch.view).classList.contains('hidden')) return stopWatchingDeployments();
    tickElapsed();
    appWatch.reload({ quiet: true });
  }, 5000);
}

function stopWatchingDeployments() {
  clearInterval(appPoll);
  appPoll = null;
  appWatch = null;
}

/** "deploying… 1m 20s", counted from when the server started. */
function tickElapsed() {
  for (const el of $$('[data-since]')) {
    // Through parseWhen: the database's times are UTC, and read as local they were hours off.
    const started = parseWhen(el.dataset.since);
    if (!started) continue;
    const secs = Math.max(0, Math.round((Date.now() - started) / 1000));
    el.textContent = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
  }
}
// Every second, so "1m 20s" counts up smoothly on cards and on the app page alike.
setInterval(() => { if (document.querySelector('[data-since]')) tickElapsed(); }, 1000);

async function loadApps({ quiet = false } = {}) {
  const box = $('#app-list');
  if (!quiet) box.innerHTML = '<div class="empty"><span class="spinner"></span>Loading…</div>';
  try {
    const apps = await api('/apps');
    if (!apps.length) {
      stopWatchingDeployments();
      box.innerHTML = `<div class="empty">
        No custom services yet. <b>+ Custom service</b> takes a Node.js repository from one of your git
        accounts, builds it into a Docker image on a server, and runs it there.
      </div>`;
      return;
    }
    box.innerHTML = `<div class="grid">${apps.map((a) => appCard(a)).join('')}</div>`;
    watchDeployments(apps);
  } catch (err) {
    if (!quiet) box.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

/**
 * The same app cards, on the server they run on. Deploying, logs, restarting
 * and removing all work from here exactly as they do on the Apps page.
 */
async function loadServerApps({ quiet = false } = {}) {
  const box = $('#server-apps-panel');
  if (!box) return;
  tabsLoaded.add('apps');

  const head = (tools) => `
    <div class="section-head">
      <h2>Apps deployed on this server</h2>
      <div class="section-tools">${tools}</div>
    </div>`;

  if (!quiet) box.innerHTML = `${head('')}<div class="empty"><span class="spinner"></span>Loading apps…</div>`;
  try {
    const apps = await api(`/apps?server_id=${currentServerId}`);
    setTabCount('apps', apps.length);
    box.innerHTML = `
      ${head(`<button class="btn tiny" data-app-reload="1">Refresh</button>
              ${ifCan('create', '<button class="btn tiny primary" data-app-add="1">+ Custom service</button>')}`)}
      ${apps.length
        ? `<div class="grid">${apps.map((a) => appCard(a)).join('')}</div>`
        : `<div class="card"><p class="muted small" style="margin:0">
             Nothing is deployed here yet. <b>+ Custom service</b> takes a repository from one of your git
             accounts, builds it into a Docker image on ${esc(currentServer?.name || 'this server')} and runs it.
           </p></div>`}`;
    watchDeployments(apps, { view: '#view-server-detail', reload: loadServerApps });
  } catch (err) {
    box.innerHTML = `${head('')}<div class="msg err">${esc(err.message)}</div>`;
  }
}

function appCard(a) {
  const d = a.detected || {};
  const busyNow = a.status === 'deploying';
  const mark = appTypeMark(a);
  return `
  <div class="card ${busyNow ? 'working' : ''}" data-app-card="${a.id}">
    <div class="card-head">
      <div>
        <h3><button class="file-name dir" data-app-action="details" data-id="${a.id}" data-name="${esc(a.name)}" title="All details and settings">🚀 ${esc(a.name)}</button></h3>
        <div class="muted small"><code>${esc(a.repo)}</code>${a.root_dir ? ` › <code>${esc(a.root_dir)}</code>` : ''} · ${esc(a.branch)}${a.deployedCommit ? ` · <code title="${esc(a.deployedCommit.message)}">${esc(a.deployedCommit.short)}</code>` : ''}</div>
      </div>
      <div class="head-badges">
        ${a.autoDeploy?.enabled ? `<span class="badge ok" title="${a.autoDeploy.trigger === 'merge' ? 'Merged pull / merge requests' : 'Every push'} to ${esc(a.branch)} deploys it">⚡ auto</span>` : ''}
        <span class="badge type">${mark.icon} ${esc(mark.label)}</span>
        <span class="badge ${APP_BADGE[a.status] ?? ''}">${busyNow ? 'in progress' : esc(a.status)}</span>
      </div>
    </div>
    ${busyNow && a.currentDeploy ? deployBanner(a, { compact: true }) : busyNow ? `<div class="deploy-progress">
      <div class="muted small"><span class="spinner"></span>${a.currentStep ? `${esc(a.currentStep)}…` : 'Starting…'}
        <span data-since="${esc(a.deploy_started_at || '')}"></span></div>
      <div class="meter indeterminate"><span></span></div>
    </div>` : ''}
    <dl class="kv">
      <dt>Server</dt><dd>${a.server ? `<b>${esc(a.server.name)}</b> <span class="muted small">${esc(a.server.host)}</span>` : '—'}</dd>
      <dt>Address</dt><dd>${appAddress(a)}</dd>
      <dt>Last deployed</dt><dd>${a.last_deployed_at ? `${esc(agoWords(a.last_deployed_at))}` : '<span class="muted">never</span>'}</dd>
    </dl>
    ${appProblem(a)}
    <div class="card-actions">
      <button class="btn tiny primary" data-app-action="details" data-id="${a.id}" data-name="${esc(a.name)}">View details</button>
      ${busyNow || a.domain_status === 'configuring'
    ? `<button class="btn tiny" data-app-action="progress" data-id="${a.id}" data-name="${esc(a.name)}"><span class="spinner"></span>Check progress</button>` : ''}
      ${busyNow ? '' : ifCan('create', `<button class="btn tiny" data-app-action="deploy" data-id="${a.id}" data-name="${esc(a.name)}">Redeploy</button>`)}
      ${busyNow ? '' : ifCan('create', `<button class="btn tiny" data-app-action="${a.status === 'running' ? 'stop' : 'start'}" data-id="${a.id}">${a.status === 'running' ? 'Stop' : 'Start'}</button>`)}
    </div>
  </div>`;
}

/** Where the service answers: its first live domain, or its first port on the server. */
function appAddress(a) {
  const live = (a.domains || []).filter((d) => d.status === 'active');
  const main = live[0]
    ? `https://${live[0].domain}`
    : a.server && a.containers[0] ? `http://${a.server.host}:${a.containers[0].port}` : null;
  if (!main) return '<span class="muted">—</span>';
  const others = (a.domains || []).length + a.containers.length - 1;
  const pending = (a.domains || []).filter((d) => d.status !== 'active').length;
  return `<a class="link-inline" href="${esc(main)}" target="_blank" rel="noopener">${esc(main.replace(/^https?:\/\//, ''))}</a>
    ${others > 0 ? `<span class="muted small">+${others} more</span>` : ''}
    ${pending ? ` <span class="badge warn">${pending} domain${pending > 1 ? 's' : ''} not live</span>` : ''}`;
}

/** One line saying what is wrong, if anything; the whole story is in View details. */
function appProblem(a) {
  const failed = (a.domains || []).filter((d) => d.status === 'error');
  const text = a.last_error ? a.last_error : failed.length ? `${failed[0].domain}: ${failed[0].error || 'setup failed'}` : '';
  if (!text) return '';
  return `<div class="msg err" style="margin-top:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(text)}">${esc(String(text).slice(0, 160))}</div>`;
}

$('#btn-apps-refresh').addEventListener('click', loadApps);

const DOMAIN_STATUS = {
  pending: ['waiting for the deploy', ''],
  configuring: ['setting up…', 'warn'],
  active: ['live', 'ok'],
  error: ['failed', 'err'],
};

/** One domain of an app: the link once it is live, how far its setup got, and how it is wired. */
function domainLine(d) {
  const [text, tone] = DOMAIN_STATUS[d.status] || [d.status || 'not set up', ''];
  const how = d.config?.mode === 'zerotrust' ? `Cloudflare Tunnel${d.config?.tunnelName ? ` (${d.config.tunnelName})` : ''}` : `DNS + nginx + SSL${d.config?.proxied ? ' · proxied' : ''}`;
  const name = d.status === 'active'
    ? `<a class="link-inline" href="https://${esc(d.domain)}" target="_blank" rel="noopener">https://${esc(d.domain)}</a>`
    : `<code class="small">${esc(d.domain)}</code>`;
  return `${name} <span class="badge ${tone}">${d.status === 'configuring' ? '<span class="spinner"></span>' : ''}${esc(text)}</span>
    <div class="muted small">${esc(how)} → port ${esc(d.port)}</div>`;
}

/* --- the "Check progress" window */

/** Every step a deploy goes through, in order. The server marks each one in the log as it starts it. */
const DEPLOY_STEPS = [
  ['account', 'Git account'],
  ['connect', 'Connect to the server'],
  ['prepare', 'Check the server'],
  ['clone', 'Clone the repository'],
  ['dockerfile', 'Dockerfile'],
  ['build', 'Build the image'],
  ['push', 'Push to Docker Hub'],
  ['start', 'Start the containers'],
  ['verify', 'Check it stays up'],
];

let progressWatch = null;

/**
 * What the log says about each step: done, running, failed or not reached.
 * "::step::key::label" starts a step, "::failed::message" ends the deploy badly
 * and "::done::" ends it well.
 */
/** A marker line: "::step::key::label::1759000000", the time being optional (older logs have none). */
const STEP_RE = /^::step::([a-z]+)::(.*?)(?:::(\d{9,}))?$/;
const END_RE = /^::(failed|done)::(.*?)(?:::(\d{9,}))?$/;

/** "4s", "2m 05s", "1h 03m". */
function duration(secs) {
  const s = Math.max(0, Math.round(secs));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}
const clock = (epoch) => new Date(epoch * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function deploySteps(a, log) {
  const seen = [];
  const labels = {};
  const started = {};
  let failed = null;
  let done = false;
  let endedAt = null;
  for (const line of String(log || '').split('\n')) {
    const s = STEP_RE.exec(line);
    if (s) {
      if (!seen.includes(s[1])) seen.push(s[1]);
      labels[s[1]] = s[2];
      if (s[3] && !started[s[1]]) started[s[1]] = Number(s[3]);
      continue;
    }
    const e = END_RE.exec(line);
    if (e) {
      if (e[1] === 'failed') failed = e[2];
      else done = true;
      if (e[3]) endedAt = Number(e[3]);
    }
  }
  const running = a.status === 'deploying';
  const last = seen[seen.length - 1];
  const plan = DEPLOY_STEPS.filter(([key]) => key !== 'push' || a.pushed || seen.includes('push'));
  const nowSecs = Date.now() / 1000;
  // A step lasts until the next one starts, or until the deploy ends (or now, while it runs).
  const endOf = (key) => {
    const next = seen[seen.indexOf(key) + 1];
    if (next && started[next]) return started[next];
    return endedAt || (running ? nowSecs : null);
  };
  const firstStart = started[seen[0]] || null;
  return {
    failed,
    startedAt: firstStart,
    total: firstStart ? (endedAt || (running ? nowSecs : null) || firstStart) - firstStart : null,
    steps: plan.map(([key, label]) => {
      const at = started[key] || null;
      const end = at ? endOf(key) : null;
      const time = at ? { at, took: end ? end - at : null } : null;
      let state = 'pending';
      if (seen.includes(key)) {
        if (key !== last || done) state = 'done';
        else if (failed || (!running && a.status === 'error')) state = 'failed';
        else if (running) state = 'active';
        else state = 'done';
      } else if (done || (!running && seen.length)) {
        state = 'skipped';
      }
      return { key, label, sub: labels[key] && labels[key] !== label ? labels[key] : '', state, time };
    }),
  };
}

const STEP_ICON = { done: '✓', active: '<span class="spinner"></span>', failed: '✕', pending: '○', skipped: '–' };

/** The log with step markers turned into headings. */
function renderDeployLog(log) {
  const at = (t) => (t ? `<span class="log-time">${clock(Number(t))}</span> ` : '');
  return String(log || '').split('\n').map((line) => {
    const s = STEP_RE.exec(line);
    if (s) return `${at(s[3])}<span class="log-step">▶ ${esc(s[2])}</span>`;
    const e = END_RE.exec(line);
    if (e && e[1] === 'failed') return `${at(e[3])}<span class="log-fail">✕ ${esc(e[2])}</span>`;
    if (e) return `${at(e[3])}<span class="log-done">✓ Deployed</span>`;
    const c = /^::commit::([0-9a-f]{7,40})::(.*)$/.exec(line);
    if (c) {
      // "<time>::<parents>::<author>::<subject>" — or just the subject in older logs.
      const parts = c[2].split('::');
      const [when, parents, author, ...subject] = parts.length >= 4 ? parts : ['', '', '', c[2]];
      const at = when ? new Date(when) : null;
      return `Commit <b>${esc(c[1].slice(0, 7))}</b>${subject.join('::') ? ` — ${esc(subject.join('::'))}` : ''}`
        + `${Number(parents) >= 2 ? ' · <span class="badge kind-merge">merge commit</span>' : ''}${author ? ` · by ${esc(author)}` : ''}`
        + `${at && !Number.isNaN(at.getTime()) ? ` · ${esc(at.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))}` : ''}`;
    }
    return esc(line);
  }).join('\n');
}

async function openAppProgress(id, name) {
  stopProgressWatch();
  $('#progress-title').textContent = name;
  $('#progress-sub').textContent = 'Loading…';
  $('#progress-steps').innerHTML = '';
  $('#progress-log').innerHTML = '';
  $('#progress-follow').checked = true;
  $('#modal-app-progress').classList.remove('hidden');
  await refreshAppProgress(id);
}

async function refreshAppProgress(id) {
  const modal = $('#modal-app-progress');
  if (modal.classList.contains('hidden')) return stopProgressWatch();
  let a;
  try {
    a = await api(`/apps/${id}`);
  } catch (err) {
    $('#progress-sub').textContent = err.message;
    return stopProgressWatch();
  }

  const { steps, failed, startedAt, total } = deploySteps(a, a.deployLog);
  // One timeline step per domain, after the deploy's own.
  const domainOn = (a.domains || []).length > 0;
  const allSteps = [...steps, ...(a.domains || []).map((d) => ({
    key: `domain-${d.id}`,
    label: `Domain ${d.domain}`,
    sub: d.config?.mode === 'zerotrust' ? 'Cloudflare Tunnel' : 'DNS, nginx and SSL',
    state: { active: 'done', configuring: 'active', error: 'failed' }[d.status] || 'pending',
  }))];

  $('#progress-steps').innerHTML = allSteps.map((s) => `
    <li class="${s.state}"><span class="step-icon">${STEP_ICON[s.state]}</span>
      <span class="step-body">${esc(s.label)}${s.sub ? `<span class="step-sub">${esc(s.sub)}</span>` : ''}</span>
      ${s.time ? `<span class="step-time">${clock(s.time.at)}${s.time.took !== null ? `<b>${duration(s.time.took)}</b>` : ''}</span>` : ''}</li>`).join('');

  const running = a.status === 'deploying' || a.domain_status === 'configuring';
  $('#progress-state').innerHTML = a.status === 'deploying'
    ? '<span class="badge warn"><span class="spinner"></span>deploying</span>'
    : a.domain_status === 'configuring' ? '<span class="badge warn"><span class="spinner"></span>setting up the domain</span>'
      : `<span class="badge ${APP_BADGE[a.status] ?? ''}">${esc(a.status)}</span>`;
  $('#progress-sub').textContent = `${a.repo} · ${a.branch} → ${a.server?.name || ''} (${a.server?.host || ''})`
    + (startedAt ? ` · started ${clock(startedAt)}` : '')
    + (total !== null && startedAt ? ` · ${a.status === 'deploying' ? 'running for' : 'took'} ${duration(total)}` : '')
    + (failed ? ` · failed: ${failed}` : '');

  const box = $('#progress-log');
  box.innerHTML = a.deployLog ? renderDeployLog(a.deployLog) : (a.status === 'deploying' ? 'Waiting for the first output…' : 'No deploy log yet.');
  if ($('#progress-follow').checked) box.scrollTop = box.scrollHeight;

  $('#progress-domain').classList.toggle('hidden', !domainOn);
  if (domainOn) {
    const d = $('#progress-domain-log');
    d.textContent = a.domainLog || (a.domain_status === 'pending' ? 'Starts once the deploy has finished.' : 'Nothing logged yet.');
    if ($('#progress-follow').checked) d.scrollTop = d.scrollHeight;
  }

  // Keep refreshing while anything is still happening.
  if (running) {
    if (!progressWatch) progressWatch = setInterval(() => refreshAppProgress(id), 2000);
  } else {
    stopProgressWatch();
  }
}

function stopProgressWatch() {
  clearInterval(progressWatch);
  progressWatch = null;
}

/* --- Edit */

/**
 * Change how a service is built and run. Name, server and repository stay;
 * the rest takes effect on the next deploy, or straight away with "Redeploy now".
 */
async function openAppEdit(id, name, reload) {
  let a;
  let hubs;
  try {
    [a, hubs] = await Promise.all([api(`/apps/${id}`), api('/credentials?provider=dockerhub').catch(() => [])]);
  } catch (err) {
    return toast(err.message, 'err');
  }
  const s = a.settings;
  const opt = (value, label, current) => `<option value="${esc(value)}" ${String(value) === String(current ?? '') ? 'selected' : ''}>${esc(label)}</option>`;
  const types = a.editOptions.types;

  openMyDialog({
    title: `Edit ${name}`,
    intro: `<code>${esc(a.repo)}</code> on <b>${esc(a.server?.name || '')}</b>. The name, server and repository stay as they are.
      <div class="inline-tools" style="margin-top:8px">
        <button type="button" class="btn tiny" data-edit-jump="env">Environment variables…</button>
        <button type="button" class="btn tiny" data-edit-jump="containers">Containers, ports &amp; volumes…</button>
      </div>`,
    fields: `
      <div class="row">
        <label>Branch<select name="branch">${opt(a.branch, a.branch, a.branch)}</select></label>
        <label>Project type<select name="type">${types.map((t) => opt(t.key, `${APP_TYPE_MARKS[t.key]?.icon || '📦'} ${t.label}`, a.app_type)).join('')}</select></label>
      </div>
      <label>Project folder <span class="muted small">(empty = repository root)</span>
        <input name="root_dir" value="${esc(s.root_dir || '')}" list="edit-folders" placeholder="apps/api" autocomplete="off" />
      </label>
      <datalist id="edit-folders"></datalist>
      <div class="row">
        <label>Node version<select name="node_version">${[...new Set([a.node_version, ...a.editOptions.nodeVersions].filter(Boolean))].map((v) => opt(v, `Node ${v}`, a.node_version)).join('')}</select></label>
        <label class="narrow">Port in container<input name="container_port" type="number" min="1" max="65535" value="${esc(s.container_port)}" required /></label>
      </div>
      <label>Install command<input name="install" value="${esc(s.install || '')}" /></label>
      <label>Build command <span class="muted small">(empty if there is nothing to build)</span><input name="build" value="${esc(s.build || '')}" /></label>
      <label data-edit-field="start">Start command<input name="start" value="${esc(s.start || '')}" /></label>
      <label data-edit-field="output">Build output folder <span class="muted small">(served by nginx)</span><input name="output_dir" value="${esc(s.output_dir || '')}" placeholder="dist" /></label>
      <div class="row">
        <label>Restart policy<select name="restart">${['unless-stopped', 'always', 'on-failure', 'no'].map((r) => opt(r, r, s.restart)).join('')}</select></label>
        <label>Docker network <span class="muted small">(empty = default bridge)</span><input name="network" value="${esc(s.network || '')}" /></label>
      </div>
      <label class="check" style="margin-top:12px"><input type="checkbox" name="use_repo_dockerfile" ${s.use_repo_dockerfile ? 'checked' : ''} /> Use the Dockerfile in the repository</label>
      <div class="card" style="margin-top:12px">
        <label class="check"><input type="checkbox" name="push" ${a.pushed ? 'checked' : ''} ${hubs.length ? '' : 'disabled'} /> Push the image to Docker Hub</label>
        <div class="row" data-edit-field="push">
          <label>Docker Hub account<select name="registry_cred_id">${hubs.map((h) => opt(h.id, `${h.name} — ${h.username || ''}`, s.registry_cred_id)).join('')}</select></label>
          <label class="narrow">Tag<input name="tag" value="${esc(a.tag || 'latest')}" /></label>
        </div>
      </div>
      <label class="check" style="margin-top:12px"><input type="checkbox" name="redeploy" checked /> Redeploy now so the changes take effect</label>`,
    submitLabel: 'Save',
    onOpen(form) {
      const sync = () => {
        const isStatic = types.find((t) => t.key === form.type.value)?.runtime === 'static';
        // style, not [hidden]: the stylesheet gives labels and rows their own display.
        form.querySelector('[data-edit-field=start]').style.display = isStatic ? 'none' : '';
        form.querySelector('[data-edit-field=output]').style.display = isStatic ? '' : 'none';
        form.querySelector('[data-edit-field=push]').style.display = form.push.checked ? '' : 'none';
      };
      form.type.addEventListener('change', sync);
      form.push.addEventListener('change', sync);
      sync();

      // The repository's branches, once they arrive; the current one is there meanwhile.
      api(`/credentials/${s.credential_id}/git/branches`, { method: 'POST', body: { repo: a.repo } })
        .then((r) => { form.branch.innerHTML = r.branches.map((b) => opt(b.name, b.name, a.branch)).join(''); })
        .catch(() => {});

      // The project folders on the chosen branch, as suggestions.
      const loadFolders = () => api('/apps/folders', { method: 'POST', body: { credential_id: s.credential_id, repo: a.repo, branch: form.branch.value } })
        .then((r) => { $('#edit-folders').innerHTML = r.folders.filter((f) => f.path).map((f) => `<option value="${esc(f.path)}"></option>`).join(''); })
        .catch(() => {});
      loadFolders();
      form.branch.addEventListener('change', loadFolders);

      // Environment and containers have their own editors.
      $('#mysql-action-intro').querySelectorAll('[data-edit-jump]').forEach((b) => b.addEventListener('click', () => {
        myDialog.classList.add('hidden');
        if (b.dataset.editJump === 'env') openAppEnv(id, name, reload);
        else openAppContainers(id, name, reload);
      }));
    },
    async submit(fd) {
      const body = {
        branch: fd.get('branch'), root_dir: fd.get('root_dir') || '', type: fd.get('type'), node_version: fd.get('node_version'),
        container_port: fd.get('container_port'), install: fd.get('install'), build: fd.get('build'),
        start: fd.get('start'), output_dir: fd.get('output_dir'), restart: fd.get('restart'), network: fd.get('network'),
        use_repo_dockerfile: fd.get('use_repo_dockerfile') === 'on', push: fd.get('push') === 'on',
        registry_cred_id: fd.get('registry_cred_id'), tag: fd.get('tag') || 'latest', redeploy: fd.get('redeploy') === 'on',
      };
      const r = await api(`/apps/${id}/settings`, { method: 'PUT', body });
      if (r.redeploying) setTimeout(() => openAppProgress(id, name), 300);
      return r.redeploying ? `Saved — redeploying ${name}` : `Saved — the changes apply on the next deploy of ${name}`;
    },
    after: reload,
  });
}

/** One domain's step-by-step setup log, with Retry. */
async function openDomainLog(id, name, reload, domainId) {
  let a;
  try {
    a = await api(`/apps/${id}`);
  } catch (err) {
    return toast(err.message, 'err');
  }
  const d = a.domains.find((x) => String(x.id) === String(domainId));
  if (!d) return toast('That domain is no longer on this app', 'err');
  const log = a.domainLogs.find((x) => x.id === d.id)?.log;
  openMyDialog({
    title: `${d.domain} — ${name}`,
    intro: domainLine(d),
    fields: `<pre class="log tall">${esc(log || (d.status === 'pending' ? 'Waiting for the deploy to finish — the domain is set up right after.' : 'Nothing logged yet.'))}</pre>`,
    submitLabel: d.status === 'active' ? 'Run the setup again' : 'Retry',
    async submit() {
      await api(`/apps/${id}/domains/${d.id}/retry`, { method: 'POST' });
      return `Setting up ${d.domain} — the card shows its progress`;
    },
    after: reload,
  });
}

/* --- the Details window: everything about one service */

let detailsAppId = null;
let detailsTab = 'overview';

/** Redraw whichever list of app cards is on screen, quietly. */
function reloadAppLists() {
  if (!$('#view-apps').classList.contains('hidden')) loadApps({ quiet: true });
  if (!$('#view-server-detail').classList.contains('hidden')) loadServerApps({ quiet: true });
}

const detailsOpen = () => !$('#view-app-detail').classList.contains('hidden');

/** After a change made from the Details page: redraw it (or the list the change came from). */
const reloadDetails = () => {
  reloadAppLists();
  if (detailsAppId && detailsOpen()) openAppDetails(detailsAppId, detailsTab);
};

/** Where "← back" goes: the Apps page, or the server whose Apps tab the service was opened from. */
let detailsFrom = 'apps';

async function openAppDetails(id, tab = detailsTab) {
  const switching = String(detailsAppId) !== String(id) || !detailsOpen();
  if (!detailsOpen()) detailsFrom = $('#view-server-detail').classList.contains('hidden') ? 'apps' : 'server';
  detailsAppId = id;
  detailsTab = tab;
  if (switching) {
    $('#ad-title').textContent = 'Loading…';
    $('#ad-sub').textContent = '';
    $('#ad-state').innerHTML = '';
    $('#ad-tabs').innerHTML = '';
    $('#ad-body').innerHTML = '<div class="empty"><span class="spinner"></span>Reading the service…</div>';
    $('#ad-actions').innerHTML = '';
    $('#btn-app-detail-back').textContent = detailsFrom === 'server' ? `← ${currentServer?.name || 'Server'}` : '← Apps';
    show('app-detail');
    setHeading('Apps');
    window.scrollTo(0, 0);
  }
  let a;
  try {
    a = await api(`/apps/${id}`);
  } catch (err) {
    $('#ad-body').innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
    return;
  }
  if (String(detailsAppId) !== String(id)) return;
  renderAppDetails(a);
}

function renderAppDetails(a) {
  const n = esc(a.name);
  const s = a.settings || {};
  const busyNow = a.status === 'deploying';
  const mark = appTypeMark(a);
  const btn = (action, label, extra = '') => `<button class="btn tiny ${extra}" data-app-action="${action}" data-id="${a.id}" data-name="${n}">${label}</button>`;
  const live = (a.domains || []).filter((d) => d.status === 'active');

  $('#ad-title').innerHTML = `🚀 ${n}`;
  $('#ad-state').innerHTML = `<span class="badge type">${mark.icon} ${esc(mark.label)}</span> <span class="badge ${APP_BADGE[a.status] ?? ''}">${busyNow ? 'deploying' : esc(a.status)}</span>`;
  $('#ad-sub').innerHTML = `<code class="small">${esc(a.repo)}</code>${a.root_dir ? ` › <code class="small">${esc(a.root_dir)}</code>` : ''} · ${esc(a.branch)} · 🖥 ${esc(a.server?.name || '—')} (${esc(a.server?.host || '')})`;
  $('#ad-actions').innerHTML = `
    ${busyNow ? btn('progress', '<span class="spinner"></span>Check progress', 'primary') : a.hasLog ? btn('progress', 'Deploy log') : ''}
    ${btn('logs', 'Container logs')}
    ${busyNow ? '' : ifCan('edit', btn('edit', 'Edit settings'))}
    ${busyNow ? '' : ifCan('edit', btn('env', 'Environment'))}
    ${busyNow ? '' : ifCan('edit', btn('containers', 'Containers'))}
    ${busyNow ? '' : ifCan('create', btn('domain-add', '+ Domain'))}
    ${busyNow ? '' : ifCan('create', btn('deploy', 'Redeploy', 'primary'))}
    ${busyNow ? '' : ifCan('create', `<button class="btn tiny" data-app-action="${a.status === 'running' ? 'stop' : 'start'}" data-id="${a.id}">${a.status === 'running' ? 'Stop' : 'Start'}</button>`)}
    ${busyNow ? '' : ifCan('create', `<button class="btn tiny" data-app-action="restart" data-id="${a.id}">Restart</button>`)}
    <button class="btn tiny" data-ad-refresh="1">Refresh</button>
    ${ifCan('delete', `<button class="btn tiny danger" data-app-action="delete" data-id="${a.id}" data-name="${n}" data-domain="${esc((a.domains || []).map((d) => d.domain).join(', '))}" data-volumes="${(a.volumes || []).length}">Remove</button>`)}`;

  const tabs = [['overview', 'Overview'], ['settings', 'Settings'], ['auto', 'Auto deploy'], ['history', 'Deploy history'], ['domains', `Domains (${(a.domains || []).length})`],
    ['containers', `Containers (${a.containers.length})`], ['env', 'Environment & volumes'], ['activity', 'Activity']];
  const ad = a.autoDeploy || {};
  const when = (v) => (v ? esc(String(v).replace('T', ' ').slice(0, 16)) : '—');

  const panels = {
    overview: `
      ${deployBanner(a)}
      <div class="tiles">
        ${tile('Status', busyNow ? 'deploying' : esc(a.status), a.currentStep ? esc(a.currentStep) : a.last_error ? 'see the error below' : '')}
        ${tile('Containers', `${a.containers.filter((c) => c.status === 'running').length} / ${a.containers.length}`, 'running')}
        ${tile('Domains', `${live.length} / ${(a.domains || []).length}`, 'live')}
        ${tile('Image', a.image_bytes ? bytes(a.image_bytes) : '—', `${esc(a.image)}:${esc(a.tag)}`)}
        ${tile('Last deployed', a.last_deployed_at ? esc(agoWords(a.last_deployed_at)) : 'never', when(a.last_deployed_at))}
        ${tile('Auto deploy', ad.enabled ? '⚡ On' : 'Off', ad.enabled ? `${ad.trigger === 'merge' ? 'merged requests' : 'every push'} to ${esc(a.branch)}` : 'deploys only when you click')}
      </div>
      ${a.last_error ? `<div class="msg err" style="margin-top:12px">${esc(a.last_error)}</div>` : ''}
      <div class="two-col" style="margin-top:14px">
        ${kvCard('Where it runs', [
    ['Server', `<b>${esc(a.server?.name || '—')}</b> <span class="muted small">${esc(a.server?.host || '')}</span>`],
    ['Addresses', [...live.map((d) => `<a class="link-inline" href="https://${esc(d.domain)}" target="_blank" rel="noopener">https://${esc(d.domain)}</a>`),
      ...a.containers.map((c) => `<a class="link-inline" href="http://${esc(a.server?.host || '')}:${c.port}" target="_blank" rel="noopener">http://${esc(a.server?.host || '')}:${c.port}</a>`)].map((x) => `<div>${x}</div>`).join('') || '—'],
    ['Created', when(a.created_at)],
    ['Last deployed', when(a.last_deployed_at)],
  ])}
        ${kvCard('Source', [
    ['Repository', `<code class="small">${esc(a.repo)}</code>`],
    ['Folder', a.root_dir ? `<code class="small">${esc(a.root_dir)}</code>` : 'repository root'],
    ['Branch', `${esc(a.branch)}${ad.enabled ? ' <span class="badge ok">⚡ auto deploy</span>' : ''}`],
    ['Running commit', a.deployedCommit ? `<code class="small">${esc(a.deployedCommit.short)}</code> <span class="small">${esc(a.deployedCommit.message)}</span>` : '<span class="muted">not recorded yet — shown after the next deploy</span>'],
    ['Git account', esc(a.account?.name || '—')],
    ['Image', `<code class="small">${esc(a.image)}:${esc(a.tag)}</code>${a.pushed ? ' <span class="badge ok">pushed to Docker Hub</span>' : ''}`],
  ])}
      </div>`,
    settings: `<div class="two-col">
        ${kvCard('Build', [
    ['Project type', `${mark.icon} ${esc(mark.label)}`],
    ['Node version', a.runtime === 'static' ? 'built with Node, served by nginx' : `Node ${esc(a.node_version)}`],
    ['Install', `<code class="small">${val(s.install)}</code>`],
    ['Build', s.build ? `<code class="small">${esc(s.build)}</code>` : '<span class="muted">nothing to build</span>'],
    ['Start', a.runtime === 'static' ? '<span class="muted">served by nginx</span>' : `<code class="small">${val(s.start)}</code>`],
    ...(a.runtime === 'static' ? [['Output folder', `<code class="small">${val(s.output_dir)}</code>`]] : []),
    ['Dockerfile', s.use_repo_dockerfile ? "the repository's own" : 'written by the panel'],
  ])}
        ${kvCard('Run', [
    ['Port in container', esc(s.container_port)],
    ['Published ports', (a.ports || []).map((p) => `<code class="small">${p}</code>`).join(' ') || '—'],
    ['Containers', esc(a.instances || 1)],
    ['Restart policy', esc(s.restart)],
    ['Docker network', val(s.network || 'default bridge')],
    ['Docker Hub', a.pushed ? `push as <code class="small">${esc(a.image)}:${esc(a.tag)}</code>${a.registry ? ` (${esc(a.registry.name)})` : ''}` : 'not pushed — the image stays on the server'],
  ])}
      </div>
      ${ifCan('edit', `<p style="margin-top:12px">${btn('edit', 'Edit these settings', 'primary')}</p>`)}`,
    auto: `${deployBanner(a)}<div id="ad-auto-panel" data-app="${a.id}">${autoSummaryHtml(a)}</div>`,
    history: `${deployBanner(a)}<div id="ad-history-panel" data-app="${a.id}"><div class="empty"><span class="spinner"></span>Reading the deploy history…</div></div>`,
    domains: `
      ${(a.domains || []).length ? table(
    [{ label: 'Domain' }, { label: 'Status' }, { label: 'How' }, { label: 'Port', num: true }, { label: '' }],
    a.domains.map((d) => [
      d.status === 'active' ? `<a class="link-inline" href="https://${esc(d.domain)}" target="_blank" rel="noopener"><b>${esc(d.domain)}</b></a>` : `<b>${esc(d.domain)}</b>`,
      `<span class="badge ${(DOMAIN_STATUS[d.status] || [])[1] || ''}">${d.status === 'configuring' ? '<span class="spinner"></span>' : ''}${esc((DOMAIN_STATUS[d.status] || [d.status])[0])}</span>${d.error ? `<div class="small" style="color:var(--err)">${esc(String(d.error).slice(0, 160))}</div>` : ''}`,
      `<span class="small">${d.config?.mode === 'zerotrust' ? `Cloudflare Tunnel${d.config.tunnelName ? ` · ${esc(d.config.tunnelName)}` : ''}` : `DNS + nginx + SSL${d.config?.proxied ? ' · proxied' : ''}`}</span>`,
      esc(d.port),
      `<div class="row-actions">
        <button class="btn tiny" data-app-action="domain-log" data-id="${a.id}" data-name="${n}" data-domain-id="${d.id}">Setup log</button>
        ${d.status !== 'configuring' ? ifCan('create', `<button class="btn tiny" data-app-action="domain-retry" data-id="${a.id}" data-name="${n}" data-domain-id="${d.id}" data-domain="${esc(d.domain)}">${d.status === 'active' ? 'Run again' : 'Retry'}</button>`) : ''}
        ${d.status !== 'configuring' ? ifCan('delete', `<button class="btn tiny danger" data-app-action="domain-remove" data-id="${a.id}" data-name="${n}" data-domain-id="${d.id}" data-domain="${esc(d.domain)}">Remove</button>`) : ''}
      </div>`,
    ])
  ) : '<div class="card"><p class="muted small" style="margin:0">No domain yet — the service answers on its server address only.</p></div>'}
      ${busyNow ? '' : ifCan('create', `<p style="margin-top:12px">${btn('domain-add', '+ Add a domain', 'primary')}</p>`)}`,
    containers: table(
      [{ label: 'Container' }, { label: 'Port on the server', num: true }, { label: 'State' }, { label: 'Open' }],
      a.containers.map((c) => [`<b>${esc(c.name)}</b>${c.id ? `<div class="muted small">${esc(c.id)}</div>` : ''}`, esc(c.port),
        `<span class="badge ${c.status === 'running' ? 'ok' : c.status ? 'err' : ''}">${esc(c.status || 'unknown')}</span>`,
        `<a class="link-inline" href="http://${esc(a.server?.host || '')}:${c.port}" target="_blank" rel="noopener">http://${esc(a.server?.host || '')}:${c.port}</a>`]),
      'No containers yet'
    ),
    env: `
      ${section('Environment variables', `<div class="card"><div class="chips">${a.envKeys.length ? a.envKeys.map((k) => `<span class="chip">${esc(k)}</span>`).join('') : '<span class="muted small">none</span>'}</div>
        <p class="muted small" style="margin:10px 0 0">Values are not shown here. ${ifCan('edit', 'Open <b>Environment</b> above to see and change them.')}</p></div>`)}
      ${section('Volumes', table([{ label: 'Volume' }, { label: 'Mounted at' }, { label: 'Mode' }],
    (a.volumes || []).map((v) => [`<code class="small">${esc(v.name)}</code>`, `<code class="small">${esc(v.path)}</code>`, v.readOnly ? 'read only' : 'read-write']),
    'No volumes — nothing it writes survives a deploy'))}`,
    activity: (a.activity || []).length
      ? table([{ label: 'When' }, { label: 'What' }, { label: 'Who' }],
        a.activity.map((x) => [`<span class="small">${when(x.created_at)}</span>`,
          `<span class="${x.level === 'error' ? 'badge err' : x.level === 'warn' ? 'badge warn' : ''}">${esc(x.action)}</span> <span class="small">${esc(x.message)}</span>`,
          `<span class="small">${esc(x.user_name || 'panel')}</span>`]))
      : '<div class="card"><p class="muted small" style="margin:0">Nothing recorded yet.</p></div>',
  };

  // The same side rail of tabs the server pages use.
  $('#ad-tabs').innerHTML = tabs.map(([k, label]) => {
    const m = /^(.*?)(?: \((\d+)\))?$/.exec(label);
    return `<button class="tab ${k === detailsTab ? 'active' : ''}" data-ad-tab="${k}"><span>${esc(m[1])}</span><span class="tab-count">${m[2] ?? ''}</span></button>`;
  }).join('');
  $('#ad-body').innerHTML = tabs.map(([k]) => `<div class="tab-panel" data-ad-panel="${k}" ${k === detailsTab ? '' : 'hidden'}>${panels[k]}</div>`).join('');
  if (detailsTab === 'auto') loadAutoPanel(a);
  if (detailsTab === 'history') loadHistoryPanel(a.id);

  // Keep it current while something is still happening.
  clearTimeout(renderAppDetails.timer);
  if (busyNow || (a.domains || []).some((d) => d.status === 'configuring')) {
    renderAppDetails.timer = setTimeout(() => {
      if (detailsOpen() && String(detailsAppId) === String(a.id)) openAppDetails(a.id, detailsTab);
    }, 4000);
  }
}

/** Back to wherever the service was opened from. */
function leaveAppDetails() {
  clearTimeout(renderAppDetails.timer);
  if (detailsFrom === 'server' && currentServerId) {
    show('server-detail');
    setHeading('Servers');
    refreshServerTab('apps');
  } else {
    show('apps');
    setHeading('Apps');
    loadApps();
  }
}

$('#btn-app-detail-back').addEventListener('click', leaveAppDetails);

$('#view-app-detail').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-ad-tab]');
  if (tab) {
    detailsTab = tab.dataset.adTab;
    $$('#ad-tabs [data-ad-tab]').forEach((b) => b.classList.toggle('active', b === tab));
    $$('#ad-body [data-ad-panel]').forEach((p) => { p.hidden = p.dataset.adPanel !== detailsTab; });
    if (detailsTab === 'auto') loadAutoPanel({ id: detailsAppId });
    if (detailsTab === 'history') loadHistoryPanel(detailsAppId);
    return;
  }
  if (e.target.closest('[data-ad-refresh]')) return openAppDetails(detailsAppId, detailsTab);
  const act = e.target.closest('button[data-app-action]');
  if (act) appCardAction(act, reloadDetails);
});

/** Take one domain off an app, undoing its Cloudflare, nginx and certificate setup. */
async function removeDomain(id, domainId, domain, reload) {
  openMyDialog({
    title: `Remove ${domain}?`,
    intro: `<div class="msg err">${esc(domain)} stops answering. Its DNS record or tunnel hostname is removed, and so are its nginx site and certificate. The app keeps running on its other addresses.</div>`,
    fields: '',
    submitLabel: 'Remove domain',
    danger: true,
    async submit() {
      const r = await api(`/apps/${id}/domains/${domainId}`, { method: 'DELETE' });
      return r.warnings?.length ? `Removed ${domain}, with warnings: ${r.warnings.join(' · ')}` : `Removed ${domain}${r.done?.length ? ` — ${r.done.join(', ')}` : ''}`;
    },
    after: reload,
  });
}

/** Add a domain to an app that is already running. */
async function openDomainAdd(id, name, reload) {
  const [clouds, a] = await Promise.all([api('/credentials?provider=cloudflare').catch(() => []), api(`/apps/${id}`).catch(() => null)]);
  if (!clouds.length) {
    toast('Connect a Cloudflare account first (Account management → Cloudflare)', 'err');
    return;
  }
  const ports = a?.ports || [];
  const existing = (a?.domains || []).map((d) => d.domain);
  openMyDialog({
    title: `Add a domain to ${name}`,
    intro: `${existing.length ? `Already on: ${existing.map((d) => `<code>${esc(d)}</code>`).join(', ')}. ` : ''}The domain is set up in the background; the card shows each step.`,
    fields: `
      <label>Cloudflare account<select name="domain_cred_id">${clouds.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
      <div class="row">
        <label>Subdomain <span class="muted small">(empty for the main domain)</span><input name="domain_sub" placeholder="shop" autocomplete="off" /></label>
        <label>Main domain<select name="domain_zone" required></select></label>
      </div>
      <p class="muted small" style="margin:6px 0 0" data-domain-preview></p>
      ${ports.length > 1 ? `<label>Send it to<select name="domain_port">${ports.map((p, i) => `<option value="${p}">port ${p}${i === 0 ? ' (first container)' : ` (container ${i + 1})`}</option>`).join('')}</select></label>` : ''}
      <label>How<select name="domain_mode">
        <option value="dns">DNS — nginx + free SSL certificate (needs ports 80 and 443 open)</option>
        <option value="zerotrust">Zero Trust — Cloudflare Tunnel (no open ports)</option>
      </select></label>
      <label data-tunnel-field style="display:none">Tunnel<select name="domain_tunnel"><option value="new">This app's tunnel, or a new one on this server</option></select></label>
      <label>Email for the certificate <span class="muted small">(DNS only, optional)</span><input name="domain_email" type="email" value="${esc(session.user?.email || '')}" /></label>
      <label class="check" style="margin-top:10px"><input type="checkbox" name="domain_proxied" /> Then proxy it through Cloudflare (DNS only)</label>`,
    submitLabel: 'Set up domain',
    onOpen(form) {
      const preview = form.querySelector('[data-domain-preview]');
      const fillZones = () => {
        const zones = zonesOfAccount(clouds.find((c) => String(c.id) === form.domain_cred_id.value));
        form.domain_zone.innerHTML = zones.length
          ? zones.map((z) => `<option value="${esc(z)}">.${esc(z)}</option>`).join('')
          : '<option value="">No domains on this account</option>';
        showPreview();
      };
      const showPreview = () => {
        const full = joinDomain(form.domain_sub.value, form.domain_zone.value);
        preview.innerHTML = full ? `The app will answer on <b>https://${esc(full)}</b>` : 'This account has no domains on Cloudflare — add the domain there first.';
      };
      // Zero Trust: offer the account's own tunnels too (e.g. one already running elsewhere).
      const tunnelField = form.querySelector('[data-tunnel-field]');
      const loadTunnels = async () => {
        const zt = form.domain_mode.value === 'zerotrust';
        tunnelField.style.display = zt ? '' : 'none';
        if (!zt) return;
        const cred = clouds.find((c) => String(c.id) === form.domain_cred_id.value);
        const lists = await Promise.all((cred?.extra?.account?.accounts || []).map((acc) => api(`/credentials/${cred.id}/cloudflare/accounts/${acc.id}/zero-trust`, { method: 'POST' })
          .then((r) => (r.tunnels || []).filter((t) => t.remoteConfig)).catch(() => [])));
        form.domain_tunnel.innerHTML = `<option value="new">This app's tunnel, or a new one on this server</option>${lists.flat().map((t) => `<option value="${esc(t.id)}" data-name="${esc(t.name)}">Existing: ${esc(t.name)} — ${esc(t.status)}</option>`).join('')}`;
      };
      form.domain_mode.addEventListener('change', loadTunnels);
      form.domain_cred_id.addEventListener('change', () => { fillZones(); loadTunnels(); });
      form.domain_zone.addEventListener('change', showPreview);
      form.domain_sub.addEventListener('input', showPreview);
      fillZones();
    },
    async submit(fd) {
      const tunnelOpt = myDialogForm.domain_tunnel.selectedOptions[0];
      const r = await api(`/apps/${id}/domains`, { method: 'POST', body: {
        domain: joinDomain(fd.get('domain_sub'), fd.get('domain_zone')), domain_cred_id: fd.get('domain_cred_id'), domain_mode: fd.get('domain_mode'),
        domain_email: fd.get('domain_email'), domain_proxied: fd.get('domain_proxied') === 'on',
        domain_tunnel: fd.get('domain_tunnel') || 'new', domain_tunnel_name: tunnelOpt?.dataset.name || '',
        domain_port: fd.get('domain_port') || '',
      } });
      return `Setting up ${r.domain} for ${name}`;
    },
    after: reload,
  });
}

/** One card button, wherever the card is drawn; `reload` redraws that list. */
async function appCardAction(btn, reload) {
  const { appAction: action, id, name } = btn.dataset;

  if (action === 'logs') return openAppLogs(id, name);
  if (action === 'env') return openAppEnv(id, name, reload);
  if (action === 'containers') return openAppContainers(id, name, reload);
  if (action === 'progress') return openAppProgress(id, name);
  if (action === 'edit') return openAppEdit(id, name, reload);
  if (action === 'domain-log') return openDomainLog(id, name, reload, btn.dataset.domainId);
  if (action === 'details') return openAppDetails(id, 'overview');
  if (action === 'history') return openAppDetails(id, 'history');
  if (action === 'domain-remove') return removeDomain(id, btn.dataset.domainId, btn.dataset.domain, reload);
  if (action === 'domain-retry') {
    busy(btn, true, '…');
    try {
      await api(`/apps/${id}/domains/${btn.dataset.domainId}/retry`, { method: 'POST' });
      toast(`Setting up ${btn.dataset.domain} again`);
    } catch (err) { toast(err.message, 'err'); }
    return reload();
  }
  if (action === 'domain-add') return openDomainAdd(id, name, reload);

  if (action === 'delete') {
    const domain = btn.dataset.domain;
    if (!confirm(`Remove "${name}"? Its container and the clone on the server are deleted.`
      + (domain ? `\n\nIts domain ${domain} is removed too: the Cloudflare record or tunnel hostname, and the nginx site and certificate or the tunnel the panel made for it.` : ''))) return;

    // Volumes are the one part that cannot be rebuilt from the repository, so
    // they are kept unless somebody says otherwise.
    const volumes = Number(btn.dataset.volumes || 0);
    const dropVolumes = volumes > 0 && !confirm(
      `Keep its ${volumes} volume${volumes > 1 ? 's' : ''}?\n\n`
      + 'OK = keep the data, so redeploying this service finds it again.\n'
      + 'Cancel = delete the volumes and everything in them, for good.'
    );

    busy(btn, true, 'Removing…');
    try {
      const r = await api(`/apps/${id}${dropVolumes ? '?delete_volumes=1' : ''}`, { method: 'DELETE' });
      toast(r.warnings?.length ? `Removed, with warnings: ${r.warnings.join(' · ')}`
        : `${name} removed${r.domainRemoved?.length ? ` — ${r.domainRemoved.join(', ')}` : ''}`);
      // Removed from its own Details page: that page has nothing left to show.
      if (String(detailsAppId) === String(id) && detailsOpen()) {
        detailsAppId = null;
        leaveAppDetails();
        return;
      }
    } catch (err) {
      toast(err.message, 'err');
    }
    return reload();
  }

  if (action === 'deploy') {
    busy(btn, true, 'Starting…');
    try {
      await api(`/apps/${id}/deploy`, { method: 'POST' });
      toast(`Rebuilding ${name} — the card shows its progress`);
    } catch (err) {
      toast(err.message, 'err');
    }
    return reload();
  }

  busy(btn, true, '…');
  try {
    const r = await api(`/apps/${id}/action`, { method: 'POST', body: { action } });
    toast(`${action} → ${r.state}`);
  } catch (err) {
    toast(err.message, 'err');
  }
  reload();
}

$('#view-apps').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-app-action]');
  if (btn) appCardAction(btn, loadApps);
});

/* ---------------------------------------------------------- app logs */

let logsAppId = null;

async function openAppLogs(id, name, deployLog = null) {
  logsAppId = id;
  $('#app-logs-name').textContent = name;
  $('#app-logs-sub').textContent = 'Last 200 lines from the container';
  $('#app-logs-body').textContent = 'Loading…';
  $('#app-logs-deploy').innerHTML = deployLog
    ? `<div class="section-head" style="margin:14px 0 8px"><h2 style="font-size:13px">Build output</h2></div>
       <pre class="log">${esc(deployLog)}</pre>`
    : '';
  $('#modal-app-logs').classList.remove('hidden');
  try {
    const r = await api(`/apps/${id}/logs`);
    $('#app-logs-body').textContent = r.logs.length ? r.logs.join('\n') : 'This container has printed nothing.';
  } catch (err) {
    $('#app-logs-body').textContent = err.message;
  }
}

$('#btn-app-logs-refresh').addEventListener('click', () => {
  if (logsAppId) openAppLogs(logsAppId, $('#app-logs-name').textContent);
});

/* ------------------------------------- environment of a running service */

/** The same rules the server applies, so the editor and it agree. */
function parseEnvLines(text) {
  const pairs = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const body = line.replace(/^export\s+/, '');
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\(n|"|\\)/g, (_, c) => (c === 'n' ? '\n' : c));
    }
    pairs.push([key, value]);
  }
  return pairs;
}

function drawEnvRows(box, pairs) {
  box.innerHTML = pairs.length
    ? pairs.map(([k, v]) => `
      <div class="item-row">
        <input class="fixed" data-env-key value="${esc(k)}" placeholder="KEY" spellcheck="false" />
        <input class="grow" data-env-value value="${esc(v)}" placeholder="value" spellcheck="false" />
        <button type="button" class="btn tiny danger" data-remove-row>Remove</button>
      </div>`).join('')
    : '<div class="empty">No variables. <b>+ Add variable</b> or import a .env file.</div>';
}

const readEnvRows = (box) => $$('.item-row', box)
  .map((row) => [$('[data-env-key]', row).value.trim(), $('[data-env-value]', row).value])
  .filter(([k]) => k);

let envApp = null;      // { id, name } being edited
let envReload = null;   // how to redraw the list the card came from

async function openAppEnv(id, name, reload) {
  envApp = { id, name };
  envReload = reload;
  $('#app-env-sub').textContent = `${name} — variables given to every container of this service`;
  $('#app-env-msg').classList.add('hidden');
  $('#env-apply').checked = true;
  $('#env-rows').innerHTML = '<div class="empty">Loading…</div>';
  $('#modal-app-env').classList.remove('hidden');

  $('#app-env-source').value = '';
  try {
    const r = await api(`/apps/${id}/env`);
    drawEnvRows($('#env-rows'), r.env);
    envApp.linkedId = r.environment?.id ?? null;
    envApp.environmentId = envApp.linkedId;
    prepareAppEnvSource(r.environment);
  } catch (err) {
    $('#env-rows').innerHTML = '';
    formMsg($('#app-env-msg'), err.message, 'err');
  }
}

$('#btn-env-add').addEventListener('click', () => {
  drawEnvRows($('#env-rows'), [...readEnvRows($('#env-rows')), ['', '']]);
});

$('#env-rows').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-remove-row]');
  if (!btn) return;
  const rows = $$('.item-row', $('#env-rows'));
  const index = rows.indexOf(btn.closest('.item-row'));
  drawEnvRows($('#env-rows'), readEnvRows($('#env-rows')).filter((_, i) => i !== index));
});

$('#btn-env-import').addEventListener('click', () => $('#env-file').click());

readTextFile($('#env-file'), (text, file) => {
  // A key the file also has is replaced; everything else is kept.
  const merged = new Map(readEnvRows($('#env-rows')));
  for (const [k, v] of parseEnvLines(text)) merged.set(k, v);
  drawEnvRows($('#env-rows'), [...merged]);
  formMsg($('#app-env-msg'), `${file.name} imported — review the values, then save.`, 'info');
});

$('#form-app-env').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#btn-env-save');
  const apply = $('#env-apply').checked;
  busy(btn, true, apply ? 'Applying…' : 'Saving…');
  try {
    const r = await api(`/apps/${envApp.id}/env`, {
      method: 'PUT',
      body: {
        env: readEnvRows($('#env-rows')),
        apply,
        // Sent only when "Load from an environment" changed the link.
        ...(envApp.environmentId !== envApp.linkedId ? { environment_id: envApp.environmentId } : {}),
      },
    });
    envsCache = null;
    $('#modal-app-env').classList.add('hidden');
    toast(r.applied
      ? `${envApp.name} restarted with the new environment`
      : `Saved — ${envApp.name} picks the new environment up at its next deploy`);
    if (envReload) envReload();
  } catch (err) {
    formMsg($('#app-env-msg'), err.message, 'err');
  }
  busy(btn, false);
});

/* --------------------------------- containers of a running service */

let containersApp = null;
let containersReload = null;

const redrawLiveContainers = wirePortRows({
  box: $('#containers-rows'),
  addButton: $('#btn-containers-add'),
  name: () => containersApp?.name,
});

async function openAppContainers(id, name, reload) {
  containersApp = { id, name };
  containersReload = reload;
  $('#app-containers-sub').textContent = `${name} — add, remove or move the containers this service runs as`;
  $('#app-containers-msg').classList.add('hidden');
  $('#containers-rows').innerHTML = '<div class="empty">Loading…</div>';
  $('#modal-app-containers').classList.remove('hidden');

  try {
    const app = await api(`/apps/${id}`);
    containersApp = { id, name: app.name };
    redrawLiveContainers(app.ports?.length ? app.ports : [app.port]);
  } catch (err) {
    $('#containers-rows').innerHTML = '';
    formMsg($('#app-containers-msg'), err.message, 'err');
  }
}

$('#form-app-containers').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#btn-containers-save');
  busy(btn, true, 'Applying…');
  try {
    const r = await api(`/apps/${containersApp.id}/containers`, {
      method: 'PUT',
      body: { ports: readPortRows($('#containers-rows')) },
    });
    $('#modal-app-containers').classList.add('hidden');
    toast(`${containersApp.name} now runs ${r.containers.length} container(s)`);
    if (containersReload) containersReload();
  } catch (err) {
    formMsg($('#app-containers-msg'), err.detail ? `${err.message}\n\n${err.detail}` : err.message, 'err');
  }
  busy(btn, false);
});

/* ------------------------------------------------- the deploy wizard */

const appModal = $('#modal-app');
let appInspection = null;
let appTypes = [];

function appStep(step) {
  $('#form-app-pick').classList.toggle('hidden', step !== 'pick');
  $('#form-app-deploy').classList.toggle('hidden', step !== 'deploy');
}

/** `presetServerId` arrives when the wizard is opened from a server's Apps tab. */
async function openAppModal(presetServerId = null) {
  $('#form-app-pick').reset();
  $('#form-app-deploy').reset();
  $('#app-pick-msg').classList.add('hidden');
  $('#app-deploy-msg').classList.add('hidden');
  $('#app-deploy-log').classList.add('hidden');
  appInspection = null;
  appStep('pick');
  appModal.classList.remove('hidden');

  const [accounts, servers, hubs, clouds] = await Promise.all([
    api('/credentials?provider=git').catch(() => []),
    api('/servers').catch(() => []),
    api('/credentials?provider=dockerhub').catch(() => []),
    api('/credentials?provider=cloudflare').catch(() => []),
  ]);
  fillDomainAccounts(clouds);

  $('#app-account').innerHTML = accounts.length
    ? accounts.map((a) => `<option value="${a.id}">${esc(a.name)}${a.extra?.account?.login ? ` — ${esc(a.extra.account.login)}` : ''}</option>`).join('')
    : '<option value="">No git accounts — connect one first</option>';

  $('#app-server').innerHTML = servers.length
    ? servers.map((s) => `<option value="${s.id}">${esc(s.name)} — ${esc(s.host)}</option>`).join('')
    : '<option value="">No servers yet — add one first</option>';
  if (presetServerId && servers.some((s) => String(s.id) === String(presetServerId))) {
    $('#app-server').value = String(presetServerId);
  }

  $('#app-registry').innerHTML = hubs.length
    ? hubs.map((c) => `<option value="${c.id}" data-user="${esc(c.username || '')}">${esc(c.name)} — ${esc(c.username || '')}</option>`).join('')
    : '<option value="">No Docker Hub account saved</option>';

  // Without an account there is nothing to push to — say so, and offer the way
  // to fix it, rather than leaving a checkbox that quietly refuses to tick.
  $('#app-push').disabled = !hubs.length;
  $('#app-push').checked = false;
  $('#app-registry-missing').classList.toggle('hidden', hubs.length > 0);
  $('#app-registry-fields').classList.add('hidden');
  $('#app-env-note').textContent = 'Imported exactly as written — comments and quotes included.';

  if (!accounts.length) formMsg($('#app-pick-msg'), 'Connect a git account first — that is where the repository comes from.', 'err');
  else await loadAppRepos();
}

$('#btn-add-app').addEventListener('click', () => openAppModal());

/* --- the "Add a domain" part of the form */

let domainAccounts = [];

/** Fill the Cloudflare picker; without an account, say so and offer to connect one. */
function fillDomainAccounts(clouds) {
  domainAccounts = clouds;
  $('#app-domain-on').checked = false;
  $('#app-domain-on').disabled = !clouds.length;
  $('#app-domain-missing').classList.toggle('hidden', clouds.length > 0);
  $('#app-domain-fields').classList.add('hidden');
  $('#app-domain-cred').innerHTML = clouds.map((c) => `<option value="${c.id}">${esc(c.name)}${c.username ? ` — ${esc(c.username)}` : ''}</option>`).join('');
  $('#app-domain-email').value = session.user?.email || '';
  $('#app-domain-tunnel').innerHTML = '<option value="new">Create a new tunnel on this server</option>';
  updateDomainZones();
}

/** The main domains (zones) of the chosen account, for the picker. */
const zonesOfAccount = (cred) => (cred?.extra?.account?.zones || []).map((z) => z.name).sort();

/** "shop" + "example.com" → "shop.example.com"; an empty alias is the main domain itself. */
function joinDomain(sub, zone) {
  const alias = String(sub || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!zone) return '';
  // Pasting the whole name into the alias box still works.
  if (alias === zone || alias.endsWith(`.${zone}`)) return alias;
  return alias ? `${alias}.${zone}` : zone;
}

function updateDomainZones() {
  const cred = domainAccounts.find((c) => String(c.id) === $('#app-domain-cred').value);
  const zones = zonesOfAccount(cred);
  $('#app-domain-zone').innerHTML = zones.length
    ? zones.map((z) => `<option value="${esc(z)}">.${esc(z)}</option>`).join('')
    : '<option value="">No domains on this account</option>';
  updateDomainPreview();
}

function updateDomainPreview() {
  const full = joinDomain($('#app-domain-sub').value, $('#app-domain-zone').value);
  $('#app-domain-preview').innerHTML = full
    ? `The app will answer on <b>https://${esc(full)}</b>`
    : 'This account has no domains on Cloudflare — add the domain there first.';
}

$('#app-domain-sub').addEventListener('input', updateDomainPreview);
$('#app-domain-zone').addEventListener('change', updateDomainPreview);

/** Tunnels on the chosen account that the panel can add a hostname to. */
async function loadDomainTunnels() {
  const select = $('#app-domain-tunnel');
  const cred = domainAccounts.find((c) => String(c.id) === $('#app-domain-cred').value);
  const newOpt = '<option value="new">Create a new tunnel on this server</option>';
  select.innerHTML = `${newOpt}<option disabled>Loading tunnels…</option>`;
  if (!cred) { select.innerHTML = newOpt; return; }
  const accounts = cred.extra?.account?.accounts || [];
  const lists = await Promise.all(accounts.map((a) => api(`/credentials/${cred.id}/cloudflare/accounts/${a.id}/zero-trust`, { method: 'POST' })
    .then((r) => (r.tunnels || []).filter((t) => t.remoteConfig)).catch(() => [])));
  const tunnels = lists.flat();
  select.innerHTML = newOpt + tunnels.map((t) => {
    const where = [...new Set(t.connections.map((c) => c.originIp).filter(Boolean))].join(', ');
    return `<option value="${esc(t.id)}" data-name="${esc(t.name)}">Existing: ${esc(t.name)} — ${esc(t.status)}${where ? ` · runs on ${esc(where)}` : ''}</option>`;
  }).join('');
}

function syncDomainFields() {
  const on = $('#app-domain-on').checked;
  $('#app-domain-fields').classList.toggle('hidden', !on);
  $('#app-domain-zone').required = on;
  const zt = $('#form-app-deploy').domain_mode.value === 'zerotrust';
  $('#app-domain-dns').classList.toggle('hidden', zt);
  $('#app-domain-zt').classList.toggle('hidden', !zt);
  if (on && zt && $('#app-domain-tunnel').options.length <= 1) loadDomainTunnels();
}

$('#app-domain-on').addEventListener('change', syncDomainFields);
$$('#form-app-deploy [name=domain_mode]').forEach((r) => r.addEventListener('change', syncDomainFields));
$('#app-domain-cred').addEventListener('change', () => {
  updateDomainZones();
  $('#app-domain-tunnel').innerHTML = '<option value="new">Create a new tunnel on this server</option>';
  syncDomainFields();
});
$('#btn-app-add-cf').addEventListener('click', () => {
  appModal.classList.add('hidden');
  openCloudflareModal();
});

/** The domain fields as the API wants them, or nothing when the box is not ticked. */
function domainBody(form) {
  if (!$('#app-domain-on').checked) return {};
  const tunnel = $('#app-domain-tunnel');
  return {
    domain_enabled: true,
    domain: joinDomain(form.domain_sub.value, form.domain_zone.value),
    domain_cred_id: form.domain_cred_id.value,
    domain_mode: form.domain_mode.value,
    domain_email: form.domain_email.value.trim(),
    domain_proxied: $('#app-domain-proxied').checked,
    domain_tunnel: tunnel.value,
    domain_tunnel_name: tunnel.selectedOptions[0]?.dataset.name || '',
  };
}

/** Straight from the deploy form to adding the Docker Hub account it needs. */
$('#btn-app-add-hub').addEventListener('click', () => {
  appModal.classList.add('hidden');
  openDockerHubModal();
});

async function loadAppRepos() {
  const select = $('#app-repo');
  const id = $('#app-account').value;
  if (!id) return;
  select.innerHTML = '<option value="">Loading…</option>';
  try {
    const r = await api(`/credentials/${id}/git/repositories`, { method: 'POST' });
    select.innerHTML = r.repositories.length
      ? r.repositories.map((repo) =>
        `<option value="${esc(repo.fullName)}" data-branch="${esc(repo.defaultBranch || '')}">${esc(repo.fullName)}${repo.private ? ' (private)' : ''}</option>`).join('')
      : '<option value="">This account can see no repositories</option>';
    await loadAppBranches();
  } catch (err) {
    select.innerHTML = `<option value="">${esc(err.message)}</option>`;
  }
}

async function loadAppBranches() {
  const select = $('#app-branch');
  const repo = $('#app-repo').value;
  const fallback = $('#app-repo').selectedOptions[0]?.dataset.branch || '';
  if (!repo) return;
  select.innerHTML = `<option value="${esc(fallback)}">${esc(fallback || 'default branch')}</option>`;
  try {
    const r = await api(`/credentials/${$('#app-account').value}/git/branches`, { method: 'POST', body: { repo } });
    select.innerHTML = r.branches.map((b) =>
      `<option value="${esc(b.name)}" ${b.name === fallback ? 'selected' : ''}>${esc(b.name)}</option>`).join('');
  } catch { /* the default branch is still there to deploy */ }
  loadAppFolders();
}

/**
 * The folders on the chosen branch that hold a project (a package.json), for
 * a repository with several apps in it. The root is the default.
 */
let folderRequest = 0;
async function loadAppFolders() {
  const select = $('#app-folder');
  const hint = $('#app-folder-hint');
  const repo = $('#app-repo').value;
  const branch = $('#app-branch').value;
  select.innerHTML = '<option value="">Repository root</option>';
  if (!repo || !branch) return;
  const mine = ++folderRequest;
  hint.textContent = 'Looking for projects on this branch…';
  try {
    const r = await api('/apps/folders', { method: 'POST', body: { credential_id: $('#app-account').value, repo, branch } });
    if (mine !== folderRequest) return;
    const kind = (f) => [f.next && 'Next.js', f.angular && 'Angular', f.vite && 'Vite', f.dockerfile && 'Dockerfile'].filter(Boolean).join(', ');
    select.innerHTML = r.folders.map((f) => `<option value="${esc(f.path)}">${f.path ? `📁 ${esc(f.path)}` : 'Repository root'}${f.missing ? ' (no package.json)' : ''}${kind(f) ? ` — ${esc(kind(f))}` : ''}</option>`).join('');
    const projects = r.folders.filter((f) => !f.missing);
    // A repository whose only project sits in a folder: start on that folder.
    if (r.folders[0]?.missing && projects.length === 1) select.value = projects[0].path;
    hint.textContent = projects.length > 1
      ? `${projects.length} projects on this branch — pick the one to deploy. Each one becomes its own service.`
      : projects.length === 1 ? 'One project on this branch.' : 'No package.json found on this branch.';
  } catch (err) {
    if (mine === folderRequest) hint.textContent = `Could not list the folders (${err.message}) — the repository root is used.`;
  }
}

$('#app-account').addEventListener('change', loadAppRepos);
$('#app-repo').addEventListener('change', loadAppBranches);
$('#app-branch').addEventListener('change', loadAppFolders);

/** Step one: ask the provider what is in this repository. */
$('#form-app-pick').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#btn-app-inspect');
  const msg = $('#app-pick-msg');
  const fd = new FormData(e.target);

  busy(btn, true, 'Checking…');
  formMsg(msg, 'Reading package.json from the branch…', 'info');
  try {
    const r = await api('/apps/inspect', {
      method: 'POST',
      body: { credential_id: fd.get('credential_id'), repo: fd.get('repo'), branch: fd.get('branch'), root_dir: fd.get('root_dir') || '' },
    });

    if (!r.ok) {
      // Not a Node project — say so plainly and stay on this step.
      formMsg(msg, r.reason || 'This repository cannot be deployed.', 'err');
      busy(btn, false);
      return;
    }

    appInspection = r;
    fillDeployStep(r, fd);
    msg.classList.add('hidden');
    appStep('deploy');
    prepareAppEnvPicker();
    prepareAutoDeployCard();
  } catch (err) {
    formMsg(msg, err.message, 'err');
  }
  busy(btn, false);
});

/** Step two, prefilled with whatever the repository told us. */
function fillDeployStep(r, fd) {
  const d = r.detected;
  const s = r.suggested;

  $('#app-detected').innerHTML = `
    <b>${esc(r.repo)}@${esc(r.branch)}${r.rootDir ? ` — folder <code>${esc(r.rootDir)}</code> —` : ''} is a Node.js project.</b><br />
    Detected as <b>${esc(d.typeLabel)}</b>${d.engines ? ` · engines.node ${esc(d.engines)}` : ''} · ${esc(d.packageManager)}
    ${d.hasLockfile ? '· lockfile found' : '· no lockfile'}${d.hasDockerfile ? ' · has its own Dockerfile' : ''}
    ${d.scripts.length ? `<div class="muted small" style="margin-top:4px">scripts: ${d.scripts.map(esc).join(', ')}</div>` : ''}`;

  $('#app-node').innerHTML = r.nodeVersions.map((v) =>
    `<option value="${v}" ${v === s.nodeVersion ? 'selected' : ''}>Node ${v}</option>`).join('');

  $('#app-type').innerHTML = r.types.map((t) =>
    `<option value="${esc(t.key)}" ${t.key === s.type ? 'selected' : ''}>${APP_TYPE_MARKS[t.key]?.icon || '📦'} ${esc(t.label)}</option>`).join('');
  appTypes = r.types;

  $('#app-name').value = s.name;
  $('#app-install').value = s.install;
  $('#app-build').value = s.build || '';
  $('#app-start').value = s.start || '';
  $('#app-output').value = s.outputDir || '';
  appMaxContainers = r.maxContainers || 10;
  appMaxVolumes = r.maxVolumes || 6;
  appDefaultVolumePath = r.defaultVolumePath || '/app/data';
  redrawAppPortRows([s.port]);

  // A static site is built into the image and served by nginx, so it has
  // nothing to keep; anything else is offered the default volume up front.
  const isStatic = r.types.find((t) => t.key === s.type)?.runtime === 'static';
  drawVolumeRows($('#app-volume-rows'), isStatic ? [] : [{ name: `${s.name}-data`, path: appDefaultVolumePath }]);
  $('#app-container-port').value = s.port;
  $('#app-tag').value = 'latest';
  applyAppType();

  $('#app-dockerfile-field').classList.toggle('hidden', !d.hasDockerfile);
  $('#app-use-dockerfile').checked = Boolean(d.hasDockerfile);
  toggleDockerfileMode();

  // The repository and account chosen in step one travel with the form.
  $('#form-app-deploy').dataset.repo = fd.get('repo');
  $('#form-app-deploy').dataset.branch = r.branch;
  $('#form-app-deploy').dataset.rootDir = r.rootDir || '';
  $('#form-app-deploy').dataset.credentialId = fd.get('credential_id');

  loadAppNetworks();
  updateImagePreview();
}

/**
 * A static type is built and then served by nginx, so it has no start command
 * and needs to know which folder the build lands in. A server type is the
 * other way round. Switching between them swaps the fields over.
 */
function applyAppType() {
  const type = appTypes.find((t) => t.key === $('#app-type').value);
  if (!type) return;
  const isStatic = type.runtime === 'static';

  $('#app-type-hint').textContent = type.hint;
  $('#app-start-field').classList.toggle('hidden', isStatic);
  $('#app-output-field').classList.toggle('hidden', !isStatic);
  $('#app-start').required = !isStatic;

  if (isStatic && !$('#app-output').value) $('#app-output').value = type.outputDir || 'dist';
  if (!isStatic && !$('#app-start').value) $('#app-start').value = type.start || 'npm run start';
  if (type.build && !$('#app-build').value) $('#app-build').value = type.build;

  // nginx listens on 80; a Node service listens on whatever it was told.
  $('#app-container-port').value = isStatic ? 80 : ($('#app-container-port').value || type.port);
}

/* ------------------------------------------- containers, as editable rows */

let appMaxContainers = 10;

/** One container keeps the service's name; several are numbered. */
const containerNames = (name, count) =>
  Array.from({ length: count }, (_, i) => (count === 1 ? name || 'app' : `${name || 'app'}-${i + 1}`));

/** Draw one row per container, each with the port it publishes. */
function drawPortRows(box, ports, name) {
  const names = containerNames(name, ports.length);
  box.innerHTML = ports.map((port, i) => `
    <div class="item-row">
      <span class="item-label">${esc(names[i])}</span>
      <input class="grow" type="number" min="1" max="65535" value="${port}" data-port required />
      <button type="button" class="btn tiny danger" data-remove-row ${ports.length === 1 ? 'disabled' : ''}>Remove</button>
    </div>`).join('');
}

const readPortRows = (box) => $$('input[data-port]', box).map((i) => Number(i.value) || 0);

/** A new row lands on the next free port after the highest one in use. */
const nextPort = (ports) => Math.min(65535, Math.max(0, ...ports) + 1);

/**
 * Add and remove wired once for both places a container list appears: the
 * deploy form and the containers popup of a service that is already running.
 */
function wirePortRows({ box, addButton, name }) {
  const redraw = (ports) => {
    drawPortRows(box, ports, name());
    // The volume note depends on how many containers there are.
    if (box.id === 'app-container-rows') updateVolumeHint();
  };

  addButton.addEventListener('click', () => {
    const ports = readPortRows(box);
    if (ports.length >= appMaxContainers) return toast(`${appMaxContainers} containers is the most one service may run`, 'err');
    redraw([...ports, nextPort(ports)]);
  });

  box.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-remove-row]');
    if (!btn) return;
    const ports = readPortRows(box);
    if (ports.length < 2) return;
    const index = $$('.item-row', box).indexOf(btn.closest('.item-row'));
    redraw(ports.filter((_, i) => i !== index));
  });

  return redraw;
}

const redrawAppPortRows = wirePortRows({
  box: $('#app-container-rows'),
  addButton: $('#btn-app-add-container'),
  name: () => $('#app-name').value,
});

// Renaming the service renames its containers, so the labels follow along.
$('#app-name').addEventListener('input', () => redrawAppPortRows(readPortRows($('#app-container-rows'))));

/* ------------------------------------------------ volumes on the form */

let appMaxVolumes = 6;
let appDefaultVolumePath = '/app/data';

/** Name and mount path per row; an empty list is a service that keeps nothing. */
function drawVolumeRows(box, volumes) {
  box.innerHTML = volumes.length
    ? volumes.map((v) => `
      <div class="item-row">
        <input class="fixed" data-volume-name value="${esc(v.name)}" placeholder="name" spellcheck="false" />
        <input class="grow" data-volume-path value="${esc(v.path)}" placeholder="/app/data" spellcheck="false" />
        <button type="button" class="btn tiny danger" data-remove-row>Remove</button>
      </div>`).join('')
    : '<div class="empty">No volumes — nothing this service writes will survive its next deploy.</div>';
  updateVolumeHint();
}

/**
 * Several containers of one service all mount the same volume, which is fine
 * for files and wrong for anything that assumes it has the file to itself.
 */
function updateVolumeHint() {
  const hint = $('#app-volume-hint');
  if (!hint) return;
  const containers = readPortRows($('#app-container-rows')).length;
  const volumes = readVolumeRows($('#app-volume-rows')).length;

  hint.innerHTML = containers > 1 && volumes
    ? `<span class="badge warn">shared</span> All ${containers} containers mount the same volume${volumes > 1 ? 's' : ''}. `
      + 'That is what you want for uploads, and not what you want for a SQLite file — two processes writing '
      + 'one database file will corrupt it.'
    : 'Every deploy replaces the container, and anything written inside it goes with it. A volume is where '
      + 'uploads, a SQLite file or generated files survive that. The default is '
      + '<code>&lt;name&gt;-data</code> mounted at <code>/app/data</code>.';
}

const readVolumeRows = (box) => $$('.item-row', box)
  .map((row) => ({
    name: $('[data-volume-name]', row).value.trim(),
    path: $('[data-volume-path]', row).value.trim(),
  }))
  .filter((v) => v.name || v.path);

$('#btn-app-add-volume').addEventListener('click', () => {
  const box = $('#app-volume-rows');
  const rows = readVolumeRows(box);
  if (rows.length >= appMaxVolumes) return toast(`${appMaxVolumes} volumes is the most one service may mount`, 'err');
  drawVolumeRows(box, [...rows, { name: '', path: '' }]);
});

/** The one most services want: a volume of their own, at the default path. */
$('#btn-app-default-volume').addEventListener('click', () => {
  const box = $('#app-volume-rows');
  const rows = readVolumeRows(box);
  const name = `${($('#app-name').value || 'app').trim()}-data`;
  if (rows.some((v) => v.name === name || v.path === appDefaultVolumePath)) {
    return toast('That volume is already on the list');
  }
  drawVolumeRows(box, [...rows, { name, path: appDefaultVolumePath }]);
});

$('#app-volume-rows').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-remove-row]');
  if (!btn) return;
  const box = $('#app-volume-rows');
  const index = $$('.item-row', box).indexOf(btn.closest('.item-row'));
  drawVolumeRows(box, readVolumeRows(box).filter((_, i) => i !== index));
});

$('#app-type').addEventListener('change', applyAppType);

/** With the repository's own Dockerfile, our build settings do not apply. */
function toggleDockerfileMode() {
  const own = $('#app-use-dockerfile').checked && !$('#app-dockerfile-field').classList.contains('hidden');
  for (const id of ['#app-install', '#app-build', '#app-node']) {
    $(id).disabled = own;
    $(id).parentElement.style.opacity = own ? '.5' : '';
  }
}

$('#app-use-dockerfile').addEventListener('change', toggleDockerfileMode);

async function loadAppNetworks() {
  const serverId = $('#app-server').value;
  const select = $('#app-network');
  select.innerHTML = '<option value="">Default bridge</option>';
  if (!serverId) return;
  try {
    const r = await api(`/servers/${serverId}/docker`);
    select.innerHTML += (r.docker.networks || [])
      .filter((n) => !['bridge', 'host', 'none'].includes(n.name))
      .map((n) => `<option value="${esc(n.name)}">${esc(n.name)}</option>`).join('');
    if (!r.docker.installed || !r.docker.running) {
      formMsg($('#app-deploy-msg'), 'Docker is not running on that server — install it from the Installations page first.', 'err');
    } else {
      $('#app-deploy-msg').classList.add('hidden');
    }
  } catch { /* the deploy will report it properly */ }
}

$('#app-server').addEventListener('change', loadAppNetworks);

function updateImagePreview() {
  const user = $('#app-registry').selectedOptions[0]?.dataset.user || 'user';
  $('#app-image-preview').textContent = `${user}/${$('#app-name').value || 'app'}:${$('#app-tag').value || 'latest'}`;
}

$('#app-push').addEventListener('change', () => {
  $('#app-registry-fields').classList.toggle('hidden', !$('#app-push').checked);
  updateImagePreview();
});

/* ------------------------------------------ importing a .env file */

/** Read a picked file and hand its text over. Nothing is uploaded. */
function readTextFile(input, onText) {
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      onText(await file.text(), file);
    } catch (err) {
      toast(`${file.name} could not be read: ${err.message}`, 'err');
    }
    input.value = ''; // so picking the same file twice still fires
  });
}

$('#btn-app-env-import').addEventListener('click', () => $('#app-env-file').click());

readTextFile($('#app-env-file'), (text, file) => {
  // Kept exactly as the file has it — the server skips comments when it parses.
  const existing = $('#app-env').value.trim();
  $('#app-env').value = existing ? `${existing}\n${text.trim()}` : text.trim();
  $('#app-env-note').textContent = `${file.name} imported as it is (${text.split(/\r?\n/).length} lines).`;
});
['#app-registry', '#app-name', '#app-tag'].forEach((id) => $(id).addEventListener('input', updateImagePreview));
$('#app-registry').addEventListener('change', updateImagePreview);

$('#btn-app-back').addEventListener('click', () => appStep('pick'));

$('#form-app-deploy').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#btn-app-deploy');
  const msg = $('#app-deploy-msg');
  const log = $('#app-deploy-log');
  const fd = new FormData(e.target);
  const form = e.target;

  const body = {
    credential_id: form.dataset.credentialId,
    server_id: fd.get('server_id'),
    repo: form.dataset.repo,
    branch: form.dataset.branch,
    root_dir: form.dataset.rootDir || '',
    name: fd.get('name'),
    type: fd.get('type'),
    ports: readPortRows($('#app-container-rows')),
    volumes: readVolumeRows($('#app-volume-rows')),
    output_dir: fd.get('output_dir'),
    detected: appInspection?.detected || null,
    node_version: fd.get('node_version'),
    install: fd.get('install'),
    build: fd.get('build'),
    start: fd.get('start'),
    container_port: fd.get('container_port'),
    env: fd.get('env'),
    network: fd.get('network'),
    restart: fd.get('restart'),
    use_repo_dockerfile: $('#app-use-dockerfile').checked && !$('#app-dockerfile-field').classList.contains('hidden'),
    push: $('#app-push').checked,
    registry_cred_id: fd.get('registry_cred_id'),
    tag: fd.get('tag') || 'latest',
    ...domainBody(form),
    ...readEnvPicker($('#app-env-pick')),
    auto_deploy: $('#app-auto').checked,
    auto_deploy_trigger: form.querySelector('input[name="auto_deploy_trigger"]:checked')?.value || 'push',
  };

  const envProblem = envPickerProblem($('#app-env-pick'));
  if (envProblem) return formMsg(msg, envProblem, 'err');

  busy(btn, true, 'Starting…');
  log.classList.add('hidden');
  formMsg(msg, 'Handing the build to the server…', 'info');

  try {
    // The server answers as soon as the job is accepted; the build carries on
    // there, so the popup closes and the card takes over from here.
    const r = await api('/apps', { method: 'POST', body });
    appModal.classList.add('hidden');
    envsCache = null;
    toast(`${r.name} is building on ${r.server?.name}${r.domain ? `, then ${r.domain} is set up` : ''} — watch its card for progress`);

    // Started from the server's own page: stay there and open its Apps tab.
    const onThisServer = !$('#view-server-detail').classList.contains('hidden')
      && String(currentServerId) === String(r.server?.id);
    if (onThisServer) {
      refreshServerTab('apps');
    } else {
      show('apps');
      $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === 'apps'));
      loadApps();
    }
    // Straight into the timeline; closing it leaves the card, whose "Check progress" reopens it.
    openAppProgress(r.id, r.name);
  } catch (err) {
    formMsg(msg, err.message, 'err');
    if (err.detail) {
      log.textContent = err.detail;
      log.classList.remove('hidden');
    }
  }
  busy(btn, false);
});

/* -------------------------------------------------------- installations */

let catalog = [];
const catalogEntry = (key) => catalog.find((c) => c.key === key) || null;

const INSTALL_BADGE = { running: 'ok', installing: '', exited: 'err', missing: 'err', error: 'err', created: '', paused: 'warn' };

async function loadCatalog() {
  if (catalog.length) return catalog;
  const r = await api('/installs/catalog');
  catalog = r.catalog;
  return catalog;
}

async function loadInstallsView() {
  const box = $('#install-catalog');
  box.innerHTML = '<div class="empty">Loading…</div>';
  try {
    await loadCatalog();
    box.innerHTML = catalog.map((c) => `
      <div class="card install-card">
        <div class="icon">${c.icon}</div>
        <h3>${esc(c.label)}</h3>
        <div class="tagline">${esc(c.tagline)}</div>
        <div class="muted small">${c.kind === 'host'
          ? '<span class="badge warn">installed on the host</span>'
          : `<span class="badge">docker</span> <code>${esc(c.image)}:${esc(c.defaultTag)}</code>`}</div>
        <div class="card-actions">
          ${ifCan('create', `<button class="btn tiny primary" data-install="${esc(c.key)}">Install</button>`)}
        </div>
      </div>`).join('');
  } catch (err) {
    box.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
  loadInstallList();
}

/** Everything the panel has installed, across every server. */
async function loadInstallList() {
  const box = $('#install-list-panel');
  box.innerHTML = '<div class="empty"><span class="spinner"></span>Loading installed services…</div>';
  try {
    const installs = await api('/installs');
    box.innerHTML = `
      <div class="section-head">
        <h2>Installed services</h2>
        <div class="section-tools"><span class="muted small">${installs.length} across your servers</span></div>
      </div>
      ${installs.length
        ? installTable(installs, true)
        : '<div class="card"><p class="muted small" style="margin:0">Nothing installed yet. Pick a card above — Docker first, if a server does not have it.</p></div>'}`;
  } catch (err) {
    box.innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
  }
}

/** The installed-services table, used on this page and on a server page. */
function installTable(installs, withServer = false) {
  return table(
    [
      { label: 'Service' },
      ...(withServer ? [{ label: 'Server' }] : []),
      { label: 'Image' },
      { label: 'Port' },
      { label: 'Network' },
      { label: 'Status' },
      { label: '' },
    ],
    installs.map((i) => [
      `<span style="font-size:15px">${i.icon}</span> <b>${esc(i.name)}</b>
       <div class="muted small">${esc(i.label)}</div>`,
      ...(withServer ? [i.server ? `${esc(i.server.name)}<div class="muted small">${esc(i.server.host)}</div>` : '—'] : []),
      `<code class="small">${esc(i.image)}:${esc(i.tag)}</code>`,
      i.port
        ? `<b>${i.port}</b> <span class="muted small">→ ${i.container_port}</span>
           ${(i.extraPorts || []).map((p) =>
    `<div class="muted small"><b>${p.port}</b> → ${p.containerPort} · ${esc(p.label)}</div>`).join('')}
           ${ifCan('edit', `<div><button class="link-db small" data-install-action="port" data-id="${i.id}">change</button></div>`)}`
        : '—',
      i.network ? `<span class="chip">${esc(i.network)}</span>` : '<span class="muted small">default bridge</span>',
      `<span class="badge ${INSTALL_BADGE[i.status] ?? ''}">${esc(i.status)}</span>
       ${i.last_error ? `<div class="muted small" style="color:var(--err)">${esc(String(i.last_error).slice(0, 110))}</div>` : ''}`,
      `<div class="row-actions">
        <button class="btn tiny" data-install-action="logs" data-id="${i.id}" data-name="${esc(i.name)}">Logs</button>
        ${ifCan('create', `<button class="btn tiny" data-install-action="restart" data-id="${i.id}">Restart</button>
        <button class="btn tiny" data-install-action="${i.status === 'running' ? 'stop' : 'start'}" data-id="${i.id}">${i.status === 'running' ? 'Stop' : 'Start'}</button>`)}
        ${ifCan('delete', `<button class="btn tiny danger" data-install-action="delete" data-id="${i.id}" data-name="${esc(i.name)}">Remove</button>`)}
      </div>`,
    ]),
    'Nothing installed'
  );
}

$('#btn-installs-refresh').addEventListener('click', loadInstallsView);

$('#view-installs').addEventListener('click', (e) => {
  const card = e.target.closest('button[data-install]');
  if (card) return openInstallModal(card.dataset.install);
  const action = e.target.closest('button[data-install-action]');
  if (action) return installAction(action, loadInstallList);
});

/* ---------------------------------------------------- the install modal */

const installModal = $('#modal-install');
const installForm = $('#form-install');
let installKind = null;
let installDocker = null;

/**
 * The install popup.
 *
 * `key` is only what it opens on — the service picker inside stays live, so
 * the same popup installs anything in the catalog onto any server. Opened from
 * a server's Docker tab it arrives with that server already chosen.
 */
async function openInstallModal(key, presetServerId = null) {
  await loadCatalog();
  if (!catalog.length) return toast('The install catalog could not be loaded', 'err');

  installForm.reset();
  $('#install-msg').classList.add('hidden');
  $('#install-log').classList.add('hidden');

  $('#install-kind').innerHTML = catalog.map((c) =>
    `<option value="${esc(c.key)}">${c.icon} ${esc(c.label)}${c.kind === 'host' ? ' — onto the host' : ''}</option>`).join('');
  $('#install-kind').value = catalogEntry(key) ? key : catalog[0].key;
  applyInstallKind();

  installModal.classList.remove('hidden');

  try {
    const servers = await api('/servers');
    $('#install-server').innerHTML = servers.length
      ? servers.map((s) => `<option value="${s.id}">${esc(s.name)} — ${esc(s.username)}@${esc(s.host)}</option>`).join('')
      : '<option value="">No servers yet — add a server first</option>';
    if (presetServerId && servers.some((s) => String(s.id) === String(presetServerId))) {
      $('#install-server').value = String(presetServerId);
    }
  } catch (err) {
    formMsg($('#install-msg'), err.message, 'err');
  }

  checkInstallServer();
}

/** Redraw the popup for whichever service is picked. */
function applyInstallKind() {
  installKind = $('#install-kind').value;
  const entry = catalogEntry(installKind);
  if (!entry) return;

  $('#install-icon').textContent = entry.icon;
  $('#install-title').textContent = `Install ${entry.label}`;
  $('#install-detail').textContent = entry.detail;
  $('#btn-install-go').disabled = false;

  // A hidden field that is still `required` stops the browser submitting at all.
  const isHost = entry.kind === 'host';
  $('#install-container-fields').classList.toggle('hidden', isHost);
  $('#install-name').required = !isHost;
  $('#install-port').required = !isHost;

  if (isHost) {
    $('#install-fields').innerHTML = '';
    $('#install-extra-ports').innerHTML = '';
    $('#install-env-pick').classList.add('hidden');
    return;
  }

  $('#install-name').value = entry.key;
  $('#install-port').value = entry.defaultPort;
  $('#install-tag').innerHTML = entry.tags
    .map((t) => `<option value="${esc(t)}" ${t === entry.defaultTag ? 'selected' : ''}>${esc(t)}</option>`).join('');
  $('#install-fields').innerHTML = entry.fields.map(renderInstallField).join('');

  // A broker or a search engine answers on more than one port; each gets a box.
  $('#install-extra-ports').innerHTML = (entry.extraPorts || []).length
    ? `<div class="row">${entry.extraPorts.map((p) => `
        <label>${esc(p.label)}${p.optional ? ' <span class="muted small">(optional)</span>' : ''}
          <input name="extra_${esc(p.name)}" type="number" min="1" max="65535" value="${p.default}"
            data-container-port="${p.containerPort}" ${p.optional ? '' : 'required'} />
          ${p.hint ? `<span class="muted small">${esc(p.hint)}</span>` : ''}
        </label>`).join('')}</div>`
    : '';

  prepareInstallEnvPicker(entry);
}

// Switching service redraws the form and re-checks the chosen server for it.
$('#install-kind').addEventListener('change', () => {
  applyInstallKind();
  checkInstallServer();
});

function renderInstallField(f) {
  return `<label>${esc(f.label)}${f.required ? '' : ' <span class="muted small">(optional)</span>'}
    <input name="field_${esc(f.name)}" type="${f.type === 'password' ? 'password' : 'text'}"
      placeholder="${esc(f.placeholder)}" autocomplete="off" ${f.required ? 'required' : ''} />
    ${f.hint ? `<span class="muted small">${esc(f.hint)}</span>` : ''}
  </label>`;
}

/**
 * Selecting a server checks Docker straight away, so "Docker is not installed"
 * is on screen before anything is attempted rather than after.
 */
async function checkInstallServer() {
  const entry = catalogEntry(installKind);
  const box = $('#install-docker-state');
  const serverId = $('#install-server').value;
  installDocker = null;

  if (!serverId) {
    box.classList.add('hidden');
    return;
  }
  if (entry.key === 'docker') {
    box.className = 'msg info';
    box.textContent = 'Checking this server…';
    box.classList.remove('hidden');
  } else {
    box.className = 'msg info';
    box.innerHTML = '<span class="spinner"></span>Checking Docker on this server…';
    box.classList.remove('hidden');
  }
  $('#btn-install-go').disabled = true;

  try {
    const r = await api(`/servers/${serverId}/docker`);
    installDocker = r.docker;

    // The network picker is whatever this server actually has.
    const networks = r.docker.networks.filter((n) => n.driver !== 'null');
    $('#install-network').innerHTML = '<option value="">Default bridge</option>'
      + networks.filter((n) => !['bridge', 'host', 'none'].includes(n.name))
        .map((n) => `<option value="${esc(n.name)}">${esc(n.name)} (${esc(n.driver)})</option>`).join('');

    if (entry.key === 'docker') {
      if (r.docker.installed && r.docker.running) {
        setInstallState(box, 'ok', `Docker ${esc(r.docker.serverVersion || '')} is already installed and running here. Installing again just updates it.`);
      } else {
        setInstallState(box, 'info', 'Docker is not on this server yet — this will install it.');
      }
      $('#btn-install-go').disabled = false;
      return;
    }

    if (!r.docker.installed) {
      setInstallState(box, 'err',
        `<b>Docker is not installed on this server.</b> Everything except Docker itself runs as a container, so there is nothing to install into.
         <button type="button" class="btn tiny" style="margin-top:8px" data-install-docker="${esc(serverId)}">Install Docker here first</button>`);
      return;
    }
    if (!r.docker.running) {
      setInstallState(box, 'err', '<b>Docker is installed but the daemon is not running.</b> Start it on the server, then try again.');
      return;
    }
    if (entry.key === 'compose' && r.docker.composeInstalled) {
      setInstallState(box, 'ok', `The compose plugin (${esc(r.docker.composeVersion)}) is already installed here. Installing again updates it.`);
      $('#btn-install-go').disabled = false;
      return;
    }

    setInstallState(box, 'ok', `Docker ${esc(r.docker.serverVersion || '')} is running — ${r.docker.containersRunning} container(s) up.`);
    $('#btn-install-go').disabled = false;
    warnIfPortTaken();
  } catch (err) {
    setInstallState(box, 'err', `Could not reach this server: ${esc(err.message)}`);
  }
}

function setInstallState(box, kind, html) {
  box.className = `msg ${kind}`;
  box.innerHTML = html;
  box.classList.remove('hidden');
}

/**
 * A port already published by another container is the most common install
 * failure. Every port box is checked, not just the first — a broker's dashboard
 * clashes as easily as its own port does.
 */
function warnIfPortTaken() {
  if (!installDocker) return;
  for (const input of [$('#install-port'), ...$$('#install-extra-ports input')]) {
    const port = String(input.value || '');
    const box = input.parentElement;
    box.querySelector('.port-warning')?.remove();
    if (!port) continue;
    const clash = installDocker.containers.find((c) => new RegExp(`:${port}->`).test(c.ports || ''));
    if (clash) {
      box.insertAdjacentHTML('beforeend',
        `<span class="muted small port-warning" style="color:var(--warn)">in use by ${esc(clash.name)}</span>`);
    }
  }
}

$('#install-server').addEventListener('change', checkInstallServer);
$('#install-port').addEventListener('input', warnIfPortTaken);
$('#install-extra-ports').addEventListener('input', warnIfPortTaken);

$('#modal-install').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-install-docker]');
  if (btn) openInstallModal('docker', btn.dataset.installDocker);
});

installForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(installForm);
  const entry = catalogEntry(fd.get('kind'));
  if (!entry) return;
  const btn = $('#btn-install-go');
  const msg = $('#install-msg');
  const log = $('#install-log');

  const body = { kind: entry.key, server_id: fd.get('server_id') };
  if (entry.kind === 'container') {
    body.name = fd.get('name');
    body.tag = fd.get('tag');
    body.port = fd.get('port');
    body.network = fd.get('network');
    body.bind = fd.get('bind');
    body.settings = {};
    for (const f of entry.fields) body.settings[f.name] = fd.get(`field_${f.name}`) || '';
    // The other published ports travel as settings too, so one object carries
    // everything this service was asked for.
    for (const p of entry.extraPorts || []) body.settings[p.name] = fd.get(`extra_${p.name}`) || '';
    Object.assign(body, readEnvPicker($('#install-env-pick')));
    const envProblem = !$('#install-env-pick').classList.contains('hidden') && envPickerProblem($('#install-env-pick'));
    if (envProblem) return formMsg(msg, envProblem, 'err');
  }

  busy(btn, true, 'Installing…');
  log.classList.add('hidden');
  formMsg(msg, entry.kind === 'host'
    ? `Installing ${entry.label} on the server…`
    : `Pulling ${entry.image}:${body.tag} and starting the container…`, 'info');

  try {
    const r = await api('/installs', { method: 'POST', body });
    installModal.classList.add('hidden');
    envsCache = null;
    toast(entry.kind === 'host'
      ? `${entry.label} installed${r.version ? ` — ${r.version}` : ''}`
      : `${entry.label} is running as "${r.name}" on port ${r.port}${r.connection ? ` — added to Databases as "${r.connection.name}"` : ''}`);
    if (!$('#view-installs').classList.contains('hidden')) loadInstallList();
    if (!$('#view-server-detail').classList.contains('hidden')) refreshServerTab('docker');
  } catch (err) {
    formMsg(msg, err.message, 'err');
    if (err.body?.dockerMissing) {
      msg.innerHTML += ' <button type="button" class="btn tiny" style="margin-top:8px" '
        + `data-install-docker="${esc(fd.get('server_id'))}">Install Docker here first</button>`;
    }
    if (err.detail) {
      log.textContent = err.detail;
      log.classList.remove('hidden');
    }
  }
  busy(btn, false);
});

/* -------------------------------------------------- acting on installs */

async function installAction(btn, reload) {
  const { installAction: action, id, name } = btn.dataset;

  if (action === 'port') return openPortModal(id);
  if (action === 'logs') return openContainerLogs(id, name);

  if (action === 'delete') {
    if (!confirm(`Remove "${name}"? The container is deleted from the server.`)) return;
    const keepData = !confirm(`Also delete its data volume?\n\nOK = delete the data for good.\nCancel = keep the volume, so re-installing finds the data again.`);
    busy(btn, true, 'Removing…');
    try {
      const r = await api(`/installs/${id}${keepData ? '' : '?delete_data=1'}`, { method: 'DELETE' });
      toast(r.warnings?.length ? `Removed, with warnings: ${r.warnings.join(' · ')}`
        : `${name} removed${r.domainRemoved?.length ? ` — ${r.domainRemoved.join(', ')}` : ''}`);
    } catch (err) {
      toast(err.message, 'err');
    }
    return reload();
  }

  busy(btn, true, '…');
  try {
    const r = await api(`/installs/${id}/action`, { method: 'POST', body: { action } });
    toast(`${action} → ${r.state}`);
  } catch (err) {
    toast(err.message, 'err');
  }
  reload();
}

/* --------------------------------------------------------- change port */

const portModal = $('#modal-port');
let portInstallId = null;

async function openPortModal(id) {
  portInstallId = id;
  $('#port-msg').classList.add('hidden');
  try {
    const install = await api(`/installs/${id}`);
    $('#port-service-name').textContent = `${install.name} (${install.label})`;
    $('#form-port').port.value = install.port;
    const r = await api(`/servers/${install.server_id}/docker`).catch(() => null);
    const networks = (r?.docker?.networks || []).filter((n) => !['bridge', 'host', 'none'].includes(n.name));
    $('#port-network').innerHTML = '<option value="">Default bridge</option>'
      + networks.map((n) => `<option value="${esc(n.name)}" ${n.name === install.network ? 'selected' : ''}>${esc(n.name)}</option>`).join('');
    if (install.network) $('#port-network').value = install.network;
    portModal.classList.remove('hidden');
  } catch (err) {
    toast(err.message, 'err');
  }
}

$('#form-port').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  const msg = $('#port-msg');
  busy(btn, true, 'Rebuilding…');
  formMsg(msg, 'Recreating the container on the new port — its volume is kept.', 'info');
  try {
    const fd = new FormData(e.target);
    const r = await api(`/installs/${portInstallId}/port`, {
      method: 'PUT',
      body: { port: fd.get('port'), network: fd.get('network') },
    });
    portModal.classList.add('hidden');
    toast(r.unchanged ? 'Nothing to change' : `${r.name} is now on port ${r.port}`);
    if (!$('#view-installs').classList.contains('hidden')) loadInstallList();
    if (!$('#view-server-detail').classList.contains('hidden')) loadServerDocker();
  } catch (err) {
    formMsg(msg, err.message, 'err');
  }
  busy(btn, false);
});

/* ---------------------------------------------------------- container logs */

async function openContainerLogs(id, name) {
  $('#container-logs-name').textContent = name;
  $('#container-logs-sub').textContent = 'Last 200 lines from the container';
  $('#container-logs-body').textContent = 'Loading…';
  $('#modal-container-logs').classList.remove('hidden');
  try {
    const r = await api(`/installs/${id}/logs`);
    $('#container-logs-body').textContent = r.logs.length ? r.logs.join('\n') : 'This container has printed nothing.';
  } catch (err) {
    $('#container-logs-body').textContent = err.message;
  }
}

/* ------------------------------------------------ docker on a server */

async function loadServerDocker() {
  const box = $('#docker-panel');
  if (!box) return;
  tabsLoaded.add('docker');
  box.innerHTML = '<div class="empty"><span class="spinner"></span>Reading Docker…</div>';

  const head = (extra = '') => `
    <div class="section-head">
      <h2>Docker</h2>
      <div class="section-tools">
        ${extra}
        <button class="btn tiny" data-docker-reload="1">Refresh</button>
      </div>
    </div>`;

  try {
    const [{ docker: d }, installs] = await Promise.all([
      api(`/servers/${currentServerId}/docker`),
      api(`/installs?server_id=${currentServerId}`).catch(() => []),
    ]);

    if (!d.installed || !d.running) {
      setTabCount('docker', '!', 'err');
      box.innerHTML = `${head()}
        <div class="card">
          <div class="msg err" style="margin-top:0">
            <b>${d.installed ? 'Docker is installed but the daemon is not running.' : 'Docker is not installed on this server.'}</b><br />
            ${d.installed
              ? 'Start it on the server, then refresh — until then nothing can be installed here.'
              : 'Everything the panel installs runs as a container, so Docker has to come first.'}
          </div>
          ${d.installed ? '' : ifCan('create', '<div class="card-actions"><button class="btn tiny primary" data-docker-install="1">Install Docker on this server</button></div>')}
        </div>`;
      return;
    }

    setTabCount('docker', d.containersRunning);
    box.innerHTML = `${head(ifCan('create', '<button class="btn tiny primary" data-docker-add-install="1">+ Install a service</button>'))}
      <div class="tiles" style="margin-bottom:14px">
        ${tile('Engine', val(d.serverVersion), val(d.cliVersion))}
        ${tile('Compose', d.composeInstalled ? esc(d.composeVersion) : '<span class="muted">not installed</span>',
          d.composeInstalled ? 'docker compose' : 'install it from the Installations page')}
        ${tile('Containers', `${d.containersRunning} / ${d.containersTotal}`, 'running / total')}
        ${tile('Volumes', String((d.volumes || []).length),
    (d.volumes || []).filter((v) => v.dangling).length
      ? `${(d.volumes || []).filter((v) => v.dangling).length} used by nothing`
      : 'all in use')}
        ${tile('Registry', hubLogin(d.registry) ? esc(hubLogin(d.registry).username) : '<span class="muted">not signed in</span>',
          hubLogin(d.registry) ? 'signed in to Docker Hub' : 'public images only')}
      </div>

      <div class="section-head" style="margin-top:6px">
        <h2 style="font-size:13px">Registry sign-in</h2>
        <div class="section-tools">${ifCan('create', '<button class="btn tiny" data-docker-login="1">+ Sign in to a registry</button>')}</div>
      </div>
      ${renderRegistry(d.registry)}

      <div class="section-head" style="margin-top:18px">
        <h2 style="font-size:13px">Networks</h2>
        <div class="section-tools">${ifCan('create', '<button class="btn tiny" data-docker-add-network="1">+ Add network</button>')}</div>
      </div>
      <div class="card">
        <div class="chips">
          ${d.networks.map((n) => `<span class="chip"><b>${esc(n.name)}</b> ${esc(n.driver)}
            ${['bridge', 'host', 'none'].includes(n.name) ? '' : `<button class="link-db" style="margin-left:6px" data-docker-rm-network="${esc(n.name)}" title="Remove this network">✕</button>`}
          </span>`).join('')}
        </div>
        <p class="muted small" style="margin:10px 0 0">Containers on the same user-defined network reach each other by container name.</p>
      </div>

      <div class="section-head" style="margin-top:18px">
        <h2 style="font-size:13px">Volumes</h2>
        <div class="section-tools">${volumeSummary(d.volumes)}</div>
      </div>
      ${volumeTable(d.volumes, installs)}

      <div class="section-head" style="margin-top:18px">
        <h2 style="font-size:13px">Installed services</h2>
        <div class="section-tools"><span class="muted small">${installs.length} installed by this panel</span></div>
      </div>
      ${installs.length
        ? installTable(installs, false)
        : '<div class="card"><p class="muted small" style="margin:0">Nothing installed here yet. <b>+ Install a service</b> runs MySQL, MongoDB or Redis on this server as a container.</p></div>'}

      <div class="section-head" style="margin-top:18px">
        <h2 style="font-size:13px">Containers</h2>
        <div class="section-tools">
          <input type="search" id="ct-filter" placeholder="Filter containers" />
          <span class="muted small">${d.containersRunning} running of ${d.containers.length}</span>
        </div>
      </div>
      ${containerTable(d.containers)}`;
  } catch (err) {
    box.innerHTML = `${head()}<div class="msg err">${esc(err.message)}</div>`;
  }
}

/* ------------------------------------------------------ docker containers */

const CT_STATE = { running: 'ok', paused: 'warn', restarting: 'warn', exited: 'err', dead: 'err', created: '' };

/** Who put a container there: a custom service, an installed service, or someone else. */
const ctOwner = (c) => (c.managedKind === 'app' ? `🚀 app${c.managedApp ? ` ${esc(c.managedApp)}` : ''}` : c.managedKind ? `📦 installed ${esc(c.managedKind)}` : '');

/**
 * Docker's port list, readable: "0.0.0.0:4200->80/tcp, [::]:4200->80/tcp"
 * becomes one line "4200 → 80". The IPv6 twin of an IPv4 mapping is dropped,
 * a port bound to one address keeps it, and an unpublished port says so.
 */
function portLines(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text || '').split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = /^(?:(\[[^\]]*\]|[\d.]+):)?(\d+)->(\d+)\/(\w+)$/.exec(raw);
    if (!m) { out.push(`${raw} <span class="muted">(not published)</span>`); continue; }
    const [, addr, host, inside, proto] = m;
    const key = `${host}-${inside}-${proto}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const bound = addr && !['0.0.0.0', '[::]'].includes(addr) ? `${addr}:` : '';
    out.push(`${bound}${host} → ${inside}${proto !== 'tcp' ? `/${proto}` : ''}`);
  }
  return out.length ? out.map((l) => `<div class="nowrap">${l}</div>`).join('') : '—';
}

function containerTable(containers) {
  if (!containers.length) return '<div class="card"><p class="muted small" style="margin:0">No containers on this server.</p></div>';
  return `<div id="ct-table">${table(
    [{ label: 'Container · image' }, { label: 'State' }, { label: 'Ports' }, { label: '' }],
    containers.map((c) => {
      const n = esc(c.name);
      const running = c.state === 'running';
      const paused = c.state === 'paused';
      return [
        // Name, then the image it runs, then who put it there — one column instead of two.
        `<button class="link-db nowrap" data-ct-action="details" data-name="${n}"><b>${n}</b></button>
          <div style="margin-top:3px"><code class="small">${esc(c.image)}</code></div>
          ${ctOwner(c) ? `<div class="muted small nowrap" style="margin-top:2px">${ctOwner(c)}</div>` : ''}`,
        `<span class="badge ${CT_STATE[c.state] ?? ''}">${esc(c.state)}</span><div class="muted small">${esc(c.status || '')}</div>`,
        `<span class="small">${portLines(c.ports)}</span>`,
        `<div class="row-actions">
          <button class="btn tiny" data-ct-action="details" data-name="${n}">Details</button>
          <button class="btn tiny" data-ct-action="logs" data-name="${n}">Logs</button>
          ${ifCan('create', running
    ? `<button class="btn tiny" data-ct-action="stop" data-name="${n}">Stop</button>`
    : paused ? `<button class="btn tiny" data-ct-action="unpause" data-name="${n}">Resume</button>`
      : `<button class="btn tiny" data-ct-action="start" data-name="${n}">Start</button>`)}
          ${ifCan('create', `<button class="btn tiny" data-ct-action="restart" data-name="${n}">Restart</button>`)}
        </div>`,
      ];
    })
  )}</div>`;
}

$('#detail-body').addEventListener('input', (e) => {
  if (e.target.id !== 'ct-filter') return;
  const q = e.target.value.trim().toLowerCase();
  $$('#ct-table tbody tr').forEach((tr) => { tr.hidden = q && !tr.textContent.toLowerCase().includes(q); });
});

async function containerRowAction(btn) {
  const { ctAction: action, name } = btn.dataset;
  if (action === 'details') return openContainerDetails(name, 'overview');
  if (action === 'logs') return openContainerDetails(name, 'logs');

  if (action === 'remove') {
    return openMyDialog({
      title: `Remove ${name}?`,
      intro: `<div class="msg err">The container is stopped and deleted. Its image stays, and so do named volumes — only what was written inside the container itself is lost.</div>`,
      fields: `<label>Type <code>${esc(name)}</code> to confirm<input name="confirm" autocomplete="off" required /></label>
        <label class="check" style="margin-top:12px"><input type="checkbox" name="volumes" /> Also delete its anonymous volumes</label>`,
      submitLabel: 'Remove container',
      danger: true,
      async submit(fd) {
        if (fd.get('confirm') !== name) throw new Error('The name does not match');
        await api(`/servers/${currentServerId}/containers/${encodeURIComponent(name)}`, { method: 'DELETE', body: { volumes: fd.get('volumes') === 'on' } });
        $('#modal-container').classList.add('hidden');
        return `Removed ${name}`;
      },
      after: loadServerDocker,
    });
  }

  if ((action === 'stop' || action === 'pause') && !confirm(`${action === 'stop' ? 'Stop' : 'Pause'} ${name}? Anything it serves stops answering until it is ${action === 'stop' ? 'started' : 'resumed'} again.`)) return;
  busy(btn, true, '…');
  try {
    const r = await api(`/servers/${currentServerId}/containers/${encodeURIComponent(name)}/action`, { method: 'POST', body: { action } });
    toast(`${name}: ${action} → ${r.state}`);
  } catch (err) {
    toast(err.message, 'err');
  }
  busy(btn, false);
  loadServerDocker();
  if (!$('#modal-container').classList.contains('hidden')) openContainerDetails(name, currentCtTab);
}

/* the details window */

let currentCt = null;
let currentCtTab = 'overview';

async function openContainerDetails(name, tab = 'overview') {
  currentCt = name;
  currentCtTab = tab;
  const modal = $('#modal-container');
  $('#ct-title').textContent = name;
  $('#ct-sub').textContent = 'Reading…';
  $('#ct-state').innerHTML = '';
  $('#ct-actions').innerHTML = '';
  $('#ct-body').innerHTML = '<div class="empty"><span class="spinner"></span>Inspecting the container…</div>';
  modal.classList.remove('hidden');
  try {
    const { container: c } = await api(`/servers/${currentServerId}/containers/${encodeURIComponent(name)}`);
    if (currentCt !== name) return;
    renderContainerDetails(c);
  } catch (err) {
    $('#ct-sub').textContent = '';
    $('#ct-body').innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
  }
}

const since = (iso) => {
  const t = Date.parse(iso || '');
  return t ? agoWords(new Date(t).toISOString()) : null;
};

function renderContainerDetails(c) {
  const st = c.state;
  const n = esc(c.name);
  $('#ct-sub').innerHTML = `<code class="small">${esc(c.image)}</code> · id ${esc(c.id)}${ctOwner(c) ? ` · ${ctOwner(c)}` : ''}`;
  $('#ct-state').innerHTML = `<span class="badge ${CT_STATE[st.status] ?? ''}">${esc(st.status)}</span>`
    + (st.health ? ` <span class="badge ${st.health.status === 'healthy' ? 'ok' : st.health.status === 'unhealthy' ? 'err' : 'warn'}">${esc(st.health.status)}</span>` : '');
  $('#ct-actions').innerHTML = `
    ${ifCan('create', st.running && !st.paused
    ? `<button class="btn tiny" data-ct-action="stop" data-name="${n}">Stop</button>`
    : st.paused ? `<button class="btn tiny" data-ct-action="unpause" data-name="${n}">Resume</button>`
      : `<button class="btn tiny" data-ct-action="start" data-name="${n}">Start</button>`)}
    ${ifCan('create', `<button class="btn tiny" data-ct-action="restart" data-name="${n}">Restart</button>`)}
    ${st.running && !st.paused ? ifCan('create', `<button class="btn tiny" data-ct-action="pause" data-name="${n}">Pause</button>`) : ''}
    ${c.managedKind ? '' : ifCan('delete', `<button class="btn tiny danger" data-ct-action="remove" data-name="${n}">Remove</button>`)}
    <button class="btn tiny" data-ct-refresh="1">Refresh</button>`;

  const s = c.stats;
  const tabs = [['overview', 'Overview'], ['network', `Ports & networks`], ['storage', `Mounts (${c.mounts.length})`],
    ['env', `Environment (${c.env.length})`], ['processes', 'Processes'], ['logs', 'Logs']];

  const panels = {
    overview: `
      <div class="tiles">
        ${tile('State', esc(st.status), st.running && st.startedAt ? `up ${duration((Date.now() - Date.parse(st.startedAt)) / 1000)}` : st.finishedAt ? `exited ${esc(since(st.finishedAt) || '')} · code ${esc(st.exitCode)}` : '')}
        ${tile('CPU', s ? esc(s.cpu) : '—', s ? `${esc(s.pids)} processes` : 'not running')}
        ${tile('Memory', s ? esc(String(s.memory).split('/')[0].trim()) : '—', s ? `${esc(s.memoryPct)} of ${esc(String(s.memory).split('/')[1]?.trim() || '')}` : '', s ? parseFloat(s.memoryPct) : null)}
        ${tile('Network I/O', s ? esc(s.net) : '—', 'received / sent')}
        ${tile('Disk I/O', s ? esc(s.block) : '—', 'read / written')}
        ${tile('Restarts', esc(c.restartCount), `policy: ${esc(c.restartPolicy)}`)}
        ${tile('Size', esc(c.size || '—'), 'written in the container (virtual = with image)')}
      </div>
      ${st.oomKilled ? '<div class="msg err" style="margin-top:12px">The last run was killed for using too much memory (OOM).</div>' : ''}
      ${st.error ? `<div class="msg err" style="margin-top:12px">${esc(st.error)}</div>` : ''}
      ${st.health?.last ? `<div class="msg ${st.health.status === 'healthy' ? 'ok' : 'err'}" style="margin-top:12px">Health check: ${esc(st.health.last)}</div>` : ''}
      <div class="two-col" style="margin-top:14px">
        ${kvCard('Container', [
    ['Image', `<code class="small">${esc(c.image)}</code>`],
    ['Image id', `<code class="small">${esc(c.imageId)}</code>`],
    ['Created', esc(new Date(c.created).toLocaleString())],
    ['Started', st.startedAt ? esc(new Date(st.startedAt).toLocaleString()) : '—'],
    ['Command', c.command ? `<code class="small" style="word-break:break-all">${esc(c.command)}</code>` : '—'],
    ['Working dir', val(c.workingDir)],
    ['User', val(c.user || 'root (image default)')],
  ])}
        ${kvCard('Runtime', [
    ['Restart policy', esc(c.restartPolicy)],
    ['Network mode', val(c.limits.networkMode)],
    ['Memory limit', c.limits.memory ? bytes(c.limits.memory) : 'none'],
    ['CPU limit', c.limits.cpus ? `${c.limits.cpus} CPUs` : 'none'],
    ['Privileged', c.limits.privileged ? '<span class="badge warn">yes</span>' : 'no'],
    ['Hostname', val(c.hostname)],
  ])}
      </div>
      ${Object.keys(c.labels).length ? section('Labels', table([{ label: 'Label' }, { label: 'Value' }],
    Object.entries(c.labels).map(([k, v]) => [`<code class="small">${esc(k)}</code>`, `<span class="small" style="word-break:break-all">${esc(v)}</span>`]))) : ''}`,
    network: `
      ${section('Published ports', table([{ label: 'Inside the container' }, { label: 'On the server' }],
    c.ports.map((p) => [`<code>${esc(p.inside)}</code>`, p.host ? `<code>${esc(p.host)}</code>` : '<span class="muted small">not published</span>']), 'No ports exposed'))}
      ${section('Networks', table([{ label: 'Network' }, { label: 'IP address' }, { label: 'Gateway' }, { label: 'Aliases' }],
    c.networks.map((x) => [`<b>${esc(x.name)}</b>`, `<code>${val(x.ip)}</code>`, `<code>${val(x.gateway)}</code>`, `<span class="small">${esc((x.aliases || []).join(', ') || '—')}</span>`]), 'Not attached to any network'))}`,
    storage: section('Mounts', table([{ label: 'Type' }, { label: 'Source' }, { label: 'Mounted at' }, { label: 'Mode' }],
      c.mounts.map((m) => [esc(m.type), `<code class="small" style="word-break:break-all">${esc(m.source)}</code>`, `<code class="small">${esc(m.destination)}</code>`, m.readOnly ? '<span class="badge">read only</span>' : 'read-write']),
      'Nothing mounted — anything written inside is lost when the container is removed')),
    env: `<p class="muted small">Only the names are shown — values stay on the server.</p>
      <div class="card"><div class="chips">${c.env.map((k) => `<span class="chip">${esc(k)}</span>`).join('') || '<span class="muted small">none</span>'}</div></div>`,
    processes: c.processes
      ? `<div class="scroll-table">${table(c.processes.header.map((h) => ({ label: h })),
        c.processes.rows.map((r) => [...r.slice(0, c.processes.header.length - 1), r.slice(c.processes.header.length - 1).join(' ')].map((v, i, all) => (i === all.length - 1 ? `<code class="small" style="word-break:break-all">${esc(v)}</code>` : esc(v)))))}</div>`
      : '<div class="card"><p class="muted small" style="margin:0">Not running — no processes.</p></div>',
    logs: `<div class="section-head" style="margin-bottom:6px">
        <span class="muted small">Last ${c.logs.length} lines, newest at the bottom</span>
        <input type="search" id="ct-log-filter" placeholder="Filter lines" />
      </div>
      <pre class="log tall" id="ct-log">${esc(c.logs.join('\n')) || 'No output yet.'}</pre>`,
  };

  $('#ct-body').innerHTML = `
    <div class="chips" id="ct-tabs" style="margin-bottom:12px">${tabs.map(([k, label]) => `<button class="btn tiny ${k === currentCtTab ? 'primary' : ''}" data-ct-tab="${k}">${esc(label)}</button>`).join('')}</div>
    ${tabs.map(([k]) => `<div data-ct-panel="${k}" ${k === currentCtTab ? '' : 'hidden'}>${panels[k]}</div>`).join('')}`;
  const log = $('#ct-log');
  if (log) log.scrollTop = log.scrollHeight;
  $('#ct-body').dataset.logs = JSON.stringify(c.logs);
}

$('#modal-container').addEventListener('click', (e) => {
  const tabBtn = e.target.closest('[data-ct-tab]');
  if (tabBtn) {
    currentCtTab = tabBtn.dataset.ctTab;
    $$('#ct-tabs [data-ct-tab]').forEach((b) => b.classList.toggle('primary', b === tabBtn));
    $$('#ct-body [data-ct-panel]').forEach((p) => { p.hidden = p.dataset.ctPanel !== currentCtTab; });
    if (currentCtTab === 'logs') { const l = $('#ct-log'); l.scrollTop = l.scrollHeight; }
    return;
  }
  if (e.target.closest('[data-ct-refresh]')) return openContainerDetails(currentCt, currentCtTab);
  const act = e.target.closest('button[data-ct-action]');
  if (act) containerRowAction(act);
});

$('#modal-container').addEventListener('input', (e) => {
  if (e.target.id !== 'ct-log-filter') return;
  const q = e.target.value.trim().toLowerCase();
  const all = JSON.parse($('#ct-body').dataset.logs || '[]');
  $('#ct-log').textContent = (q ? all.filter((l) => l.toLowerCase().includes(q)) : all).join('\n');
});

/* ------------------------------------------------ docker registry sign-in */

const hubLogin = (registry) => (registry?.logins || []).find((l) => l.isHub) || null;

/** Who this server can pull private images as. */
function renderRegistry(registry) {
  const logins = registry?.logins || [];

  if (!logins.length) {
    return `<div class="card">
      <p class="muted small" style="margin:0">
        This server is not signed in to any registry. Public images still pull fine —
        sign in to pull private ones, or to raise Docker Hub's rate limit.
      </p>
      ${ifCan('create', '<div class="card-actions"><button class="btn tiny primary" data-docker-login="1">Sign in to a registry</button></div>')}
    </div>`;
  }

  return table(
    [{ label: 'Registry' }, { label: 'Signed in as' }, { label: 'Stored in' }, { label: '' }],
    logins.map((l) => [
      `<b>${esc(l.label)}</b>${l.isHub ? '' : `<div class="muted small"><code>${esc(l.registry)}</code></div>`}`,
      `<span class="badge ok">${esc(l.username)}</span>`,
      l.viaHelper
        ? `<span class="muted small">credential helper${registry.credsStore ? ` (${esc(registry.credsStore)})` : ''}</span>`
        : `<code class="small">${esc(l.home || '')}/.docker/config.json</code>`,
      `<div class="row-actions">${ifCan('create',
        `<button class="btn tiny danger" data-docker-logout="${esc(l.registry)}" data-label="${esc(l.label)}">Sign out</button>`)}</div>`,
    ])
  );
}

const registryModal = $('#modal-docker-login');

async function openRegistryModal() {
  $('#form-docker-login').reset();
  $('#registry-msg').classList.add('hidden');
  $('#registry-server-name').textContent = currentServer ? currentServer.name : 'this server';
  registryModal.classList.remove('hidden');

  // Offer the Docker Hub accounts already stored in this organisation.
  try {
    const saved = await api('/credentials?provider=dockerhub');
    const has = saved.length > 0;
    $('#registry-saved-field').classList.toggle('hidden', !has);
    if (has) {
      $('#registry-credential').innerHTML = '<option value="">Type the details in below</option>'
        + saved.map((c) => `<option value="${c.id}">${esc(c.name)} — ${esc(c.username || '')}</option>`).join('');
      applyRegistrySource();
    }
  } catch { /* typing it in still works */ }
}

/** Picking a saved account hides the fields it would replace. */
function applyRegistrySource() {
  const usingSaved = Boolean($('#registry-credential').value);
  $('#registry-manual-fields').classList.toggle('hidden', usingSaved);
  $('#registry-host').disabled = usingSaved;
  $('#registry-host').placeholder = usingSaved ? 'Docker Hub' : 'Docker Hub (leave empty), or ghcr.io';
}

$('#registry-credential').addEventListener('change', applyRegistrySource);

$('#form-docker-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter || $('button[type=submit]', e.target);
  const msg = $('#registry-msg');
  const fd = new FormData(e.target);
  const body = {
    registry: fd.get('registry') || '',
    credential_id: fd.get('credential_id') || '',
    username: fd.get('username') || '',
    secret: fd.get('secret') || '',
  };

  busy(btn, true, 'Signing in…');
  formMsg(msg, 'Running docker login on the server…', 'info');
  try {
    const r = await api(`/servers/${currentServerId}/docker/login`, { method: 'POST', body });
    registryModal.classList.add('hidden');
    toast(`${currentServer?.name || 'The server'} is signed in to ${r.label} as ${r.username}`);
    loadServerDocker();
  } catch (err) {
    formMsg(msg, err.message, 'err');
  }
  busy(btn, false);
});

/* ------------------------------------------------------ docker volumes */

/** "6 volumes · 2 used by nothing", in the section's corner. */
function volumeSummary(volumes = []) {
  if (!volumes.length) return '<span class="muted small">none</span>';
  const spare = volumes.filter((v) => v.dangling).length;
  return `<span class="muted small">${volumes.length} volume${volumes.length === 1 ? '' : 's'}`
    + `${spare ? ` · ${spare} used by nothing` : ''}</span>`;
}

/**
 * Named volumes, with what is holding each one.
 *
 * A volume is where a container's data actually lives, so the useful facts are
 * its size, which container has it, and whether anything has it at all — an
 * unattached volume is either last week's database or free disk space, and the
 * panel cannot tell you which, so it only says which it is.
 */
function volumeTable(volumes = [], installs = []) {
  if (!volumes.length) {
    return '<div class="card"><p class="muted small" style="margin:0">This server has no named volumes. '
      + 'Installing a service here creates one, so its data survives the container.</p></div>';
  }

  const ownerOf = (name) => installs.find((i) => i.volume === name) || null;

  return table(
    [{ label: 'Volume' }, { label: 'Used by' }, { label: 'Size', num: true }, { label: 'Driver' }, { label: '' }],
    volumes.map((v) => {
      const owner = ownerOf(v.name);
      return [
        `<b>${esc(v.name)}</b>
         ${owner ? `<div class="muted small">${esc(owner.icon || '📦')} data for ${esc(owner.name)}</div>` : ''}
         ${v.mountpoint ? `<div class="muted small"><code>${esc(v.mountpoint)}</code></div>` : ''}`,
        v.usedBy.length
          ? v.usedBy.map((u) => `<div><span class="dot ${u.state === 'running' ? 'online' : 'unknown'}"></span>
             <span class="small">${esc(u.container)}</span></div>`).join('')
          : '<span class="badge warn">nothing</span>',
        v.size ? esc(v.size) : '<span class="muted small">—</span>',
        `<span class="small">${esc(v.driver)}</span>`,
        v.dangling && !owner
          ? ifCan('delete', `<button class="btn tiny danger" data-docker-rm-volume="${esc(v.name)}">Remove</button>`)
          : '',
      ];
    }),
    'No named volumes'
  );
}

/* the docker panel, the network modal and the install rows all live in the server view */

$('#view-server-detail').addEventListener('click', async (e) => {
  if (e.target.closest('[data-app-reload]')) return loadServerApps();
  if (e.target.closest('[data-app-add]')) return openAppModal(currentServerId);

  const appBtn = e.target.closest('button[data-app-action]');
  if (appBtn) return appCardAction(appBtn, loadServerApps);

  const ctBtn = e.target.closest('button[data-ct-action]');
  if (ctBtn) return containerRowAction(ctBtn);

  if (e.target.closest('[data-docker-reload]')) return loadServerDocker();
  if (e.target.closest('[data-docker-install]')) return openInstallModal('docker', currentServerId);
  if (e.target.closest('[data-docker-add-install]')) {
    // Opens on the first container service; the picker inside switches to any other.
    const first = catalog.find((c) => c.kind === 'container')?.key || 'mysql';
    return openInstallModal(first, currentServerId);
  }
  if (e.target.closest('[data-docker-add-network]')) return openNetworkModal();
  if (e.target.closest('[data-docker-login]')) return openRegistryModal();

  const out = e.target.closest('button[data-docker-logout]');
  if (out) {
    const { dockerLogout: registry, label } = out.dataset;
    if (!confirm(`Sign this server out of ${label}? Private images from it will stop pulling.`)) return;
    busy(out, true, 'Signing out…');
    try {
      await api(`/servers/${currentServerId}/docker/logout`, { method: 'POST', body: { registry } });
      toast(`Signed out of ${label}`);
    } catch (err) {
      toast(err.message, 'err');
    }
    return loadServerDocker();
  }

  const rmVolume = e.target.closest('button[data-docker-rm-volume]');
  if (rmVolume) {
    const name = rmVolume.dataset.dockerRmVolume;
    if (!confirm(`Delete the volume "${name}" and everything in it?\n\n`
      + 'No container is using it, but whatever a container once wrote there — a database, uploads — '
      + 'goes with it. This cannot be undone.')) return;
    busy(rmVolume, true, 'Removing…');
    try {
      await api(`/servers/${currentServerId}/docker/volumes/${encodeURIComponent(name)}`, { method: 'DELETE' });
      toast(`Volume ${name} removed`);
    } catch (err) {
      toast(err.message, 'err');
    }
    return loadServerDocker();
  }

  const rm = e.target.closest('button[data-docker-rm-network]');
  if (rm) {
    const name = rm.dataset.dockerRmNetwork;
    if (!confirm(`Remove the Docker network "${name}"? Containers still attached to it will stop it being removed.`)) return;
    try {
      await api(`/servers/${currentServerId}/docker/networks/${encodeURIComponent(name)}`, { method: 'DELETE' });
      toast(`Network ${name} removed`);
    } catch (err) {
      toast(err.message, 'err');
    }
    return loadServerDocker();
  }

  const action = e.target.closest('button[data-install-action]');
  if (action) return installAction(action, loadServerDocker);

  if (e.target.closest('[data-nginx-reload]')) return loadServerNginx();

  const nginxBtn = e.target.closest('button[data-nginx]');
  if (nginxBtn) return nginxPanelAction(nginxBtn);
});

/* -------------------------------------------------------- the live tab */

/**
 * The live view.
 *
 * The server holds one SSH session open and pushes a sample every few seconds
 * over server-sent events; this draws the frame once and then patches the
 * numbers, so nothing flickers and a button is never redrawn under a click.
 */
let statsStream = null;
let statsHistory = [];
let statsSeenAlerts = new Set();
let statsBusyContainer = null;

const HISTORY = 60; // samples kept for the sparklines — five minutes at 5s

function stopLiveStats() {
  if (statsStream) {
    statsStream.close();
    statsStream = null;
  }
}

function startLiveStats() {
  const box = $('#live-panel');
  if (!box) return;
  stopLiveStats();
  tabsLoaded.add('live');
  statsHistory = [];
  statsSeenAlerts = new Set();

  box.innerHTML = liveFrame();
  setLiveState('connecting', 'Opening a session on the server…');

  const stream = new EventSource(`/api/servers/${currentServerId}/stats/stream?every=5000`);
  statsStream = stream;

  stream.addEventListener('sample', (e) => {
    // A sample that arrives after the view moved on belongs to nothing.
    if (statsStream !== stream) return;
    try {
      drawLiveSample(JSON.parse(e.data));
    } catch { /* one bad frame is not worth tearing the view down */ }
  });

  stream.addEventListener('problem', (e) => {
    if (statsStream !== stream) return;
    const { error } = JSON.parse(e.data);
    setLiveState('problem', error);
  });

  stream.addEventListener('end', () => {
    if (statsStream === stream) setLiveState('reconnecting', 'The live view timed out — reconnecting…');
  });

  // EventSource retries on its own; this only says so on screen.
  stream.onerror = () => {
    if (statsStream === stream) setLiveState('reconnecting', 'Connection lost — reconnecting…');
  };
}

function setLiveState(kind, text) {
  const el = $('#live-state');
  if (!el) return;
  const tone = { live: 'ok', connecting: '', reconnecting: 'warn', problem: 'err' }[kind] ?? '';
  el.innerHTML = `<span class="badge ${tone}">${kind === 'live' ? 'live' : esc(kind)}</span>
    <span class="muted small">${esc(text)}</span>`;
}

/** The frame, drawn once; every id in here is patched by drawLiveSample. */
function liveFrame() {
  return `
    <div class="section-head">
      <h2>Live</h2>
      <div class="section-tools" id="live-state"></div>
    </div>

    <div id="live-alerts"></div>

    <div class="tiles" style="margin-bottom:14px">
      <div class="tile">
        <div class="label">CPU</div>
        <div class="value" id="live-cpu">—</div>
        <div class="sub" id="live-cpu-sub">&nbsp;</div>
        <div class="meter"><span id="live-cpu-meter" style="width:0"></span></div>
        <div id="live-cpu-spark" class="spark-box"></div>
      </div>
      <div class="tile">
        <div class="label">Memory</div>
        <div class="value" id="live-mem">—</div>
        <div class="sub" id="live-mem-sub">&nbsp;</div>
        <div class="meter"><span id="live-mem-meter" style="width:0"></span></div>
        <div id="live-mem-spark" class="spark-box"></div>
      </div>
      <div class="tile">
        <div class="label">Load average</div>
        <div class="value" id="live-load">—</div>
        <div class="sub" id="live-load-sub">&nbsp;</div>
        <div class="meter"><span id="live-load-meter" style="width:0"></span></div>
      </div>
      <div class="tile">
        <div class="label">Throughput</div>
        <div class="value" id="live-net">—</div>
        <div class="sub" id="live-net-sub">&nbsp;</div>
        <div class="sub" id="live-io">&nbsp;</div>
      </div>
    </div>

    <div class="section"><h2>Processor cores</h2><div id="live-cores" class="core-grid"></div></div>
    <div class="section"><h2>Filesystems</h2><div id="live-disks"></div></div>
    <div class="section">
      <div class="section-head"><h2>Containers</h2><div class="section-tools" id="live-docker-counts"></div></div>
      <div id="live-docker"></div>
    </div>
    <div class="two-col">
      <div class="section"><h2>Top by CPU</h2><div id="live-top-cpu"></div></div>
      <div class="section"><h2>Top by memory</h2><div id="live-top-mem"></div></div>
    </div>
    <p class="muted small" id="live-footer">&nbsp;</p>`;
}

/**
 * One series over time, in a tile. The number above it carries the value, so
 * the line is only there to show the shape — no axis, no legend, no tooltip.
 */
function sparkline(values, { max = 100, color = 'var(--accent)', label = '' }) {
  if (values.length < 2) return '';
  const w = 200;
  const h = 34;
  const step = w / (values.length - 1);
  const y = (v) => h - 2 - (Math.max(0, Math.min(v, max)) / max) * (h - 4);
  const line = values.map((v, i) => `${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(' L');

  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img"
      aria-label="${esc(label)}">
    <path d="M${line} L${w},${h} L0,${h} Z" fill="${color}" opacity=".13" />
    <path d="M${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
  </svg>`;
}

const rate = (n) => `${bytes(n)}/s`;

function drawLiveSample(s) {
  statsHistory.push(s);
  if (statsHistory.length > HISTORY) statsHistory.shift();

  setLiveState('live', `every 5s · updated ${new Date(s.at).toLocaleTimeString()}`);
  setTabCount('live', s.worst === 'ok' ? `${Math.round(s.cpu.usedPct)}%` : '!',
    s.worst === 'critical' ? 'err' : s.worst === 'warning' ? 'warn' : '');

  /* --- the four tiles --- */
  const cpuHistory = statsHistory.map((h) => h.cpu.usedPct);
  $('#live-cpu').textContent = `${s.cpu.usedPct}%`;
  $('#live-cpu-sub').textContent = `${s.load.cores} core(s) · ${s.cpu.iowaitPct}% waiting on disk`
    + `${s.cpu.stealPct ? ` · ${s.cpu.stealPct}% stolen` : ''}`;
  $('#live-cpu-meter').style.width = `${Math.min(100, s.cpu.usedPct)}%`;
  $('#live-cpu-meter').className = meterClass(s.cpu.usedPct);
  $('#live-cpu-spark').innerHTML = sparkline(cpuHistory, {
    label: `CPU over the last ${cpuHistory.length} samples, now ${s.cpu.usedPct}%`,
  });

  const memHistory = statsHistory.map((h) => h.memory.usedPct);
  $('#live-mem').textContent = `${s.memory.usedPct}%`;
  $('#live-mem-sub').textContent = `${bytes(s.memory.usedBytes)} of ${bytes(s.memory.totalBytes)}`
    + `${s.memory.swapTotalBytes ? ` · swap ${s.memory.swapUsedPct}%` : ''}`;
  $('#live-mem-meter').style.width = `${Math.min(100, s.memory.usedPct)}%`;
  $('#live-mem-meter').className = meterClass(s.memory.usedPct);
  $('#live-mem-spark').innerHTML = sparkline(memHistory, {
    color: 'var(--accent-2)',
    label: `Memory over the last ${memHistory.length} samples, now ${s.memory.usedPct}%`,
  });

  $('#live-load').textContent = s.load.one.toFixed(2);
  $('#live-load-sub').textContent = `${s.load.five} / ${s.load.fifteen} over 5 and 15 min · ${s.load.perCore} per core`
    + `${s.load.processes ? ` · ${s.load.processes} processes` : ''}`;
  $('#live-load-meter').style.width = `${Math.min(100, (s.load.perCore / 4) * 100)}%`;
  $('#live-load-meter').className = meterClass((s.load.perCore / 4) * 100);

  $('#live-net').textContent = `↓ ${rate(s.network.rxBytesPerSec)}`;
  $('#live-net-sub').textContent = `↑ ${rate(s.network.txBytesPerSec)} out`;
  $('#live-io').textContent = `disk ${rate(s.diskIo.readBytesPerSec)} read · ${rate(s.diskIo.writeBytesPerSec)} write`;

  /* --- per core --- */
  $('#live-cores').innerHTML = s.cpu.cores.map((c) => `
    <div class="core">
      <div class="muted small">core ${c.core} <b style="color:var(--text)">${c.usedPct}%</b></div>
      <div class="meter"><span class="${meterClass(c.usedPct)}" style="width:${Math.min(100, c.usedPct)}%"></span></div>
    </div>`).join('');

  /* --- filesystems --- */
  $('#live-disks').innerHTML = table(
    [{ label: 'Mounted on' }, { label: 'Device' }, { label: 'Used', num: true }, { label: 'Free', num: true }, { label: '' }],
    s.disks.map((d) => [
      `<b>${esc(d.mount)}</b>`,
      `<code class="small">${esc(d.device)}</code>`,
      `${bytes(d.usedBytes)} of ${bytes(d.sizeBytes)}`,
      bytes(d.availableBytes),
      `<div style="min-width:120px"><div class="meter"><span class="${meterClass(d.usedPct)}" style="width:${d.usedPct}%"></span></div>
       <div class="muted small">${d.usedPct}%</div></div>`,
    ]),
    'No filesystems reported'
  );

  /* --- containers --- */
  drawLiveDocker(s.docker);

  /* --- processes --- */
  const procRows = (list) => table(
    [{ label: 'Process' }, { label: 'User' }, { label: 'CPU', num: true }, { label: 'Memory', num: true }],
    list.map((p) => [
      `<code class="small">${esc(p.command)}</code> <span class="muted small">#${p.pid}</span>`,
      esc(p.user || ''),
      `${p.cpuPct}%`,
      `${p.memoryPct}%`,
    ]),
    'Nothing reported'
  );
  $('#live-top-cpu').innerHTML = procRows(s.topCpu);
  $('#live-top-mem').innerHTML = procRows(s.topMemory);

  $('#live-footer').textContent = `Up ${uptimeWords(s.uptimeSeconds)} · ${s.sessions} logged in`;

  drawLiveAlerts(s);
}

function uptimeWords(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

const CONTAINER_TONE = { running: 'ok', restarting: 'err', dead: 'err', exited: '', paused: 'warn', created: '' };

function drawLiveDocker(d) {
  const counts = $('#live-docker-counts');
  const box = $('#live-docker');
  if (!counts || !box) return;

  if (!d.installed) {
    counts.innerHTML = '';
    box.innerHTML = '<div class="card"><p class="muted small" style="margin:0">Docker is not installed on this server.</p></div>';
    return;
  }
  if (!d.running) {
    counts.innerHTML = '<span class="badge err">daemon stopped</span>';
    box.innerHTML = '<div class="card"><p class="muted small" style="margin:0">The Docker daemon is not running, so every container is down with it.</p></div>';
    return;
  }

  counts.innerHTML = `
    <span class="badge ok">${d.counts.running} running</span>
    ${d.counts.restarting ? `<span class="badge err">${d.counts.restarting} restarting</span>` : ''}
    ${d.counts.paused ? `<span class="badge warn">${d.counts.paused} paused</span>` : ''}
    ${d.counts.exited ? `<span class="badge">${d.counts.exited} stopped</span>` : ''}
    ${d.counts.dead ? `<span class="badge err">${d.counts.dead} dead</span>` : ''}
    <span class="muted small">${d.counts.total} in total</span>`;

  // A container being acted on keeps its row still until the action comes back.
  if (statsBusyContainer) return;

  box.innerHTML = table(
    [{ label: 'Container' }, { label: 'State' }, { label: 'CPU', num: true }, { label: 'Memory', num: true }, { label: 'Network', num: true }, { label: '' }],
    d.containers.map((c) => [
      `<b>${esc(c.name)}</b><div class="muted small"><code>${esc(c.image)}</code></div>
       ${c.ports ? `<div class="muted small">${esc(c.ports)}</div>` : ''}`,
      `<span class="badge ${CONTAINER_TONE[c.state] ?? ''}">${esc(c.state)}</span>
       ${c.health === 'unhealthy' ? '<div><span class="badge err">unhealthy</span></div>' : ''}
       <div class="muted small">${esc(c.status)}</div>`,
      c.cpuPct === undefined ? '—' : `${c.cpuPct}%`,
      c.memoryBytes === undefined || c.memoryBytes === null
        ? '—'
        : `${bytes(c.memoryBytes)}<div class="muted small">${c.memoryPct}%</div>`,
      c.netRxBytes === undefined || c.netRxBytes === null
        ? '—'
        : `↓ ${bytes(c.netRxBytes)}<div class="muted small">↑ ${bytes(c.netTxBytes)}</div>`,
      `<div class="row-actions">
        <button class="btn tiny" data-container="logs" data-name="${esc(c.name)}">Logs</button>
        ${ifCan('create', `<button class="btn tiny" data-container="${c.state === 'running' ? 'stop' : 'start'}" data-name="${esc(c.name)}">${c.state === 'running' ? 'Stop' : 'Start'}</button>`)}
        ${ifCan('create', `<button class="btn tiny" data-container="restart" data-name="${esc(c.name)}">Restart</button>`)}
      </div>`,
    ]),
    'This server is running no containers.'
  );
}

/**
 * Alerts, worst first — and a toast the first time each one appears, so a
 * problem that starts while you are looking elsewhere on the page still says so.
 */
function drawLiveAlerts(s) {
  const box = $('#live-alerts');
  if (!box) return;

  for (const a of s.alerts) {
    if (statsSeenAlerts.has(a.key)) continue;
    statsSeenAlerts.add(a.key);
    if (a.level === 'critical') toast(`${currentServer?.name || 'This server'}: ${a.title}`, 'err');
  }
  // A problem that clears can be announced again if it comes back.
  for (const key of [...statsSeenAlerts]) {
    if (!s.alerts.some((a) => a.key === key)) statsSeenAlerts.delete(key);
  }

  if (!s.alerts.length) {
    box.innerHTML = '<div class="msg ok" style="margin:0 0 14px">Nothing is in trouble — CPU, memory, disks and containers are all within their thresholds.</div>';
    return;
  }

  box.innerHTML = `<div class="alert-stack">${s.alerts.map((a) => `
    <div class="msg ${a.level === 'critical' ? 'err' : 'warn'}" style="margin:0">
      <b>${a.level === 'critical' ? '⛔' : '⚠️'} ${esc(a.title)}</b>
      ${a.detail ? `<div class="small" style="margin-top:2px">${esc(a.detail)}</div>` : ''}
    </div>`).join('')}</div>`;
}

/** Start / stop / restart / logs for any container on the machine. */
$('#view-server-detail').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-container]');
  if (!btn) return;
  const { container: action, name } = btn.dataset;

  if (action === 'logs') {
    $('#container-logs-name').textContent = name;
    $('#container-logs-sub').textContent = 'Last 200 lines from the container';
    $('#container-logs-body').textContent = 'Loading…';
    $('#modal-container-logs').classList.remove('hidden');
    try {
      const r = await api(`/servers/${currentServerId}/containers/${encodeURIComponent(name)}/logs`);
      $('#container-logs-body').textContent = r.logs.length ? r.logs.join('\n') : 'This container has printed nothing.';
    } catch (err) {
      $('#container-logs-body').textContent = err.message;
    }
    return;
  }

  statsBusyContainer = name;
  busy(btn, true, `${action}ing…`);
  try {
    const r = await api(`/servers/${currentServerId}/containers/${encodeURIComponent(name)}/action`, {
      method: 'POST', body: { action },
    });
    toast(`${name} → ${r.state || action}`);
  } catch (err) {
    toast(err.message, 'err');
  }
  statsBusyContainer = null;
  busy(btn, false);
});

/* ------------------------------------------- what is on this server */

/**
 * The counts across the top of the Overview tab.
 *
 * The profile below it says what the machine is; this says what is on it. Each
 * tile is a way into the tab that owns the thing it counts, so a number that
 * looks wrong is one click from its detail.
 */
async function loadServerSummary() {
  const box = $('#server-summary');
  if (!box) return;
  tabsLoaded.add('overview');

  box.innerHTML = `
    <div class="section-head">
      <h2>On this server</h2>
      <div class="section-tools"><span class="muted small"><span class="spinner"></span>counting…</span></div>
    </div>`;

  try {
    const { summary: s } = await api(`/servers/${currentServerId}/summary`);
    box.innerHTML = `
      <div class="section-head">
        <h2>On this server</h2>
        <div class="section-tools">
          <button class="btn tiny" data-summary-reload="1">Recount</button>
        </div>
      </div>
      <div class="tiles">
        ${summaryTile('network', '🔌 IPv4', ipv4Summary(s.network))}
        ${summaryTile('docker', '🐳 Containers', dockerSummary(s.docker))}
        ${summaryTile('apps', '🚀 Custom services', appsSummary(s.apps))}
        ${summaryTile('docker', '📦 Installed services', installsSummary(s.installs))}
        ${summaryTile('nginx', '🌐 Domains', nginxSummary(s.nginx, s.certbot))}
        ${summaryTile('cron', '⏱ Scheduled jobs', cronSummary(s.cron))}
        ${summaryTile('services', '⚙️ System services', servicesSummary(s.services))}
        ${summaryTile('runners', '🏃 CI runners', runnersSummary(s.runners, s.registeredRunners))}
        ${summaryTile('live', '💾 Docker storage', storageSummary(s.docker))}
      </div>
      <p class="muted small" style="margin:10px 0 0">Each tile opens the tab that owns it.</p>`;
  } catch (err) {
    box.innerHTML = `
      <div class="section-head"><h2>On this server</h2>
        <div class="section-tools"><button class="btn tiny" data-summary-reload="1">Try again</button></div>
      </div>
      <div class="msg err">${esc(err.message)}</div>`;
  }
}

/** A tile that is also a link into its tab. */
const summaryTile = (tab, label, body) => `
  <button class="tile tile-link" data-summary-tab="${esc(tab)}" type="button">
    <div class="label">${label}</div>
    ${body}
  </button>`;

/** The one number that matters, then the rest of the breakdown under it. */
const summaryBody = (value, sub, extra = '') =>
  `<div class="value">${value}</div><div class="sub">${sub}</div>${extra}`;

/**
 * The address the machine answers on, and its public one.
 *
 * Only those two: the other addresses a host holds are on the Network tab, and
 * repeating them here only made the tile harder to read.
 */
function ipv4Summary(n) {
  if (!n || !n.ipv4.length) return summaryBody('<span class="muted">—</span>', 'no IPv4 address found');

  const sub = n.publicIp
    ? (n.publicIp === n.primary ? 'also its public address' : `public ${esc(n.publicIp)}`)
    : 'no public address';

  return summaryBody(esc(n.primary || '—'), sub);
}

function dockerSummary(d) {
  if (!d.installed) return summaryBody('<span class="muted">—</span>', 'Docker is not installed');
  if (!d.running) return summaryBody('<span class="badge err">daemon stopped</span>', 'nothing is running');

  const c = d.containers;
  const parts = [
    `<span class="badge ok">${c.running} running</span>`,
    c.exited ? `<span class="badge">${c.exited} stopped</span>` : '',
    c.restarting ? `<span class="badge err">${c.restarting} restarting</span>` : '',
    c.paused ? `<span class="badge warn">${c.paused} paused</span>` : '',
    c.dead ? `<span class="badge err">${c.dead} dead</span>` : '',
    c.created ? `<span class="badge">${c.created} created</span>` : '',
  ].filter(Boolean).join(' ');

  return summaryBody(`${c.running} <span class="muted" style="font-size:14px">of ${c.total}</span>`,
    'containers up', `<div class="chips" style="margin-top:8px">${parts}</div>`);
}

const appsSummary = (a) => (a.total
  ? summaryBody(`${a.running} <span class="muted" style="font-size:14px">of ${a.total}</span>`, 'deployed from a repository',
    `<div class="chips" style="margin-top:8px">
      ${a.deploying ? `<span class="badge warn">${a.deploying} deploying</span>` : ''}
      ${a.broken ? `<span class="badge err">${a.broken} not running</span>` : '<span class="badge ok">all up</span>'}
    </div>`)
  : summaryBody('<span class="muted">none</span>', 'nothing deployed here yet'));

const installsSummary = (i) => (i.total
  ? summaryBody(`${i.running} <span class="muted" style="font-size:14px">of ${i.total}</span>`, 'databases and the like',
    i.broken ? `<div class="chips" style="margin-top:8px"><span class="badge err">${i.broken} not running</span></div>` : '')
  : summaryBody('<span class="muted">none</span>', 'nothing installed from the catalog'));

function nginxSummary(n, cert) {
  if (!n.installed) return summaryBody('<span class="muted">—</span>', 'nginx is not installed');
  const expiring = cert.soonestDays !== null && cert.soonestDays < 21;
  return summaryBody(String(n.domains), `served by nginx · ${n.ssl} site${n.ssl === 1 ? '' : 's'} on SSL`,
    `<div class="chips" style="margin-top:8px">
      ${n.running ? '<span class="badge ok">running</span>' : `<span class="badge err">${esc(n.active)}</span>`}
      ${cert.certificates ? `<span class="badge ${expiring ? 'warn' : ''}">${cert.certificates} certificate${cert.certificates === 1 ? '' : 's'}${
  cert.soonestDays === null ? '' : ` · ${cert.soonestDays}d`}</span>` : ''}
    </div>`);
}

const cronSummary = (c) => (c.installed
  ? summaryBody(String(c.jobs), `in user crontabs · ${c.systemJobs} system`,
    `<div class="chips" style="margin-top:8px">${c.running
      ? '<span class="badge ok">cron running</span>'
      : `<span class="badge err">cron ${esc(c.active)}</span>`}</div>`)
  : summaryBody('<span class="muted">—</span>', 'cron is not installed'));

const servicesSummary = (s) => summaryBody(String(s.running), `running of ${s.total} known units`,
  `<div class="chips" style="margin-top:8px">${s.failed
    ? `<span class="badge err">${s.failed} failed</span>`
    : '<span class="badge ok">none failed</span>'}</div>`);

const runnersSummary = (live, registered) => (live.units || registered.total
  ? summaryBody(`${live.running} <span class="muted" style="font-size:14px">of ${live.units}</span>`,
    `runner services up${registered.total ? ` · ${registered.total} registered here` : ''}`,
    live.units > live.running ? `<div class="chips" style="margin-top:8px"><span class="badge err">${live.units - live.running} stopped</span></div>` : '')
  : summaryBody('<span class="muted">none</span>', 'no CI runner on this machine'));

const storageSummary = (d) => (d.running
  ? summaryBody(String(d.volumes), `volumes · ${d.images} images · ${d.networks} networks`,
    d.composeVersion ? `<div class="chips" style="margin-top:8px"><span class="badge">compose ${esc(d.composeVersion)}</span></div>` : '')
  : summaryBody('<span class="muted">—</span>', 'Docker is not running'));

$('#view-server-detail').addEventListener('click', (e) => {
  if (e.target.closest('[data-summary-reload]')) return loadServerSummary();
  const tile = e.target.closest('[data-summary-tab]');
  if (tile) return showServerTab(tile.dataset.summaryTab);
  return undefined;
});

/* -------------------------------------------------------- the cron tab */

let cronCache = null;

/** What a schedule means, for the ones people actually write. */
const CRON_WORDS = {
  '@reboot': 'at every boot',
  '@hourly': 'every hour, on the hour',
  '@daily': 'every day at midnight',
  '@midnight': 'every day at midnight',
  '@weekly': 'every Sunday at midnight',
  '@monthly': 'on the 1st of each month, at midnight',
  '@yearly': 'on 1 January, at midnight',
  '@annually': 'on 1 January, at midnight',
};

const CRON_PRESETS = [
  ['Every 5 minutes', '*/5 * * * *'],
  ['Hourly', '0 * * * *'],
  ['Daily at 03:00', '0 3 * * *'],
  ['Weekly, Sunday 04:00', '0 4 * * 0'],
  ['Monthly, 1st at 05:00', '0 5 1 * *'],
  ['At boot', '@reboot'],
];

/** A plain-English reading of the common shapes, and nothing for the rest. */
function cronWords(schedule) {
  const s = String(schedule || '').trim();
  if (CRON_WORDS[s.toLowerCase()]) return CRON_WORDS[s.toLowerCase()];

  const [min, hour, dom, month, dow] = s.split(/\s+/);
  if (!dow) return '';
  const everyDay = dom === '*' && month === '*' && dow === '*';

  if (/^\*\/(\d+)$/.test(min) && hour === '*' && everyDay) return `every ${/^\*\/(\d+)$/.exec(min)[1]} minutes`;
  if (/^\d+$/.test(min) && hour === '*' && everyDay) return `every hour at ${min.padStart(2, '0')} past`;
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && everyDay) return `every day at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && month === '*' && /^[0-6]$/.test(dow)) {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return `every ${days[Number(dow)]} at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && /^\d+$/.test(dom) && month === '*' && dow === '*') {
    return `on day ${dom} of each month at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  }
  return '';
}

async function loadServerCron() {
  const box = $('#cron-panel');
  if (!box) return;
  tabsLoaded.add('cron');
  box.innerHTML = '<div class="empty"><span class="spinner"></span>Reading the schedule…</div>';

  const head = (tools = '') => `
    <div class="section-head">
      <h2>Scheduled jobs</h2>
      <div class="section-tools">${tools}<button class="btn tiny" data-cron-reload="1">Refresh</button></div>
    </div>`;

  try {
    const { cron: c } = await api(`/servers/${currentServerId}/cron`);
    cronCache = c;

    if (!c.installed) {
      setTabCount('cron', '—');
      box.innerHTML = `${head()}
        <div class="card">
          <div class="msg info" style="margin-top:0">
            <b>cron is not installed on this server.</b><br />
            Nothing here runs on a schedule until it is — no backups, no cleanups, no certificate renewals.
          </div>
          ${ifCan('create', '<div class="card-actions"><button class="btn tiny primary" data-cron="install">Install cron on this server</button></div>')}
        </div>`;
      return;
    }

    const editable = c.users.flatMap((u) => u.jobs);
    const readOnly = [...c.system.jobs, ...c.dropins.flatMap((f) => f.jobs)];
    setTabCount('cron', editable.length + readOnly.length, c.running ? '' : 'err');

    box.innerHTML = `${head(ifCan('create', '<button class="btn tiny primary" data-cron="add">+ Add a job</button>'))}

      ${c.running
    ? ''
    : `<div class="msg err" style="margin-bottom:12px"><b>The cron service is ${esc(c.active)}.</b>
         Jobs are written down but nothing is running them.</div>`}

      <div class="tiles" style="margin-bottom:14px">
        ${tile('Service', c.running ? '<span class="badge ok">running</span>' : `<span class="badge err">${esc(c.active)}</span>`,
    `${esc(c.unit || 'cron')} · ${esc(c.enabled)} at boot`)}
        ${tile('Your jobs', String(editable.length), `in ${c.users.length} crontab${c.users.length === 1 ? '' : 's'}`)}
        ${tile('System jobs', String(readOnly.length), '/etc/crontab and /etc/cron.d')}
        ${tile('Scripts', String(c.runParts.length), 'in cron.hourly, .daily, .weekly, .monthly')}
      </div>

      ${section('Crontabs', c.users.length
    ? c.users.map((u) => cronUserCard(u)).join('')
    : `<div class="card"><p class="muted small" style="margin:0">No user on this server has a crontab yet.
         <b>+ Add a job</b> writes the first one.</p></div>`)}

      ${readOnly.length ? section('System schedule', `
        ${table(
    [{ label: 'When' }, { label: 'As' }, { label: 'Command' }, { label: 'From' }],
    readOnly.map((j) => [
      `<code class="small">${esc(j.schedule)}</code>
             ${cronWords(j.schedule) ? `<div class="muted small">${esc(cronWords(j.schedule))}</div>` : ''}`,
      `<span class="small">${esc(j.user || 'root')}</span>`,
      `<code class="small">${esc(j.command)}</code>`,
      `<span class="muted small">${esc(j.source)}</span>`,
    ])
  )}
        <p class="muted small" style="margin:10px 0 0">These belong to the system and its packages, so the panel
          shows them but will not edit them. Change them on the server itself.</p>`) : ''}

      ${c.runParts.length ? section('Scripts run by the hour, day, week and month', `
        <div class="card"><div class="chips">
          ${c.runParts.map((p) => `<span class="chip"><b>${esc(p.name)}</b>
            <span class="muted">${esc(p.directory.replace('/etc/cron.', ''))}</span></span>`).join('')}
        </div>
        <p class="muted small" style="margin:10px 0 0">Anything dropped into these directories is run by
          <code>run-parts</code> on that cadence.</p></div>`) : ''}

      ${c.recent.length ? section('What cron logged recently', `<pre class="log">${esc(c.recent.join('\n'))}</pre>`) : ''}`;
  } catch (err) {
    setTabCount('cron', '!', 'err');
    box.innerHTML = `${head()}<div class="msg err">${esc(err.message)}</div>`;
  }
}

/** One user's crontab, with the jobs the panel may change. */
function cronUserCard(u) {
  return `
    <div class="card" style="margin-bottom:12px">
      <div class="card-head">
        <div><h3>${esc(u.user)}</h3>
          <div class="muted small">${u.jobs.length} job${u.jobs.length === 1 ? '' : 's'}${u.settings.length ? ` · ${u.settings.map(esc).join(' · ')}` : ''}</div>
        </div>
        ${ifCan('create', `<button class="btn tiny" data-cron="add" data-user="${esc(u.user)}">+ Add</button>`)}
      </div>
      ${table(
    [{ label: 'When' }, { label: 'Command' }, { label: '' }],
    u.jobs.map((j) => [
      `<code class="small">${esc(j.schedule)}</code>
         ${cronWords(j.schedule) ? `<div class="muted small">${esc(cronWords(j.schedule))}</div>` : ''}`,
      `<code class="small">${esc(j.command)}</code>`,
      `<div class="row-actions">
          ${ifCan('edit', `<button class="btn tiny" data-cron="edit" data-user="${esc(u.user)}" data-line="${esc(j.raw)}">Edit</button>`)}
          ${ifCan('delete', `<button class="btn tiny danger" data-cron="delete" data-user="${esc(u.user)}" data-line="${esc(j.raw)}">Delete</button>`)}
        </div>`,
    ]),
    'This crontab has no jobs'
  )}
    </div>`;
}

/* ------------------------------------------------- add / edit a job */

const cronModal = $('#modal-cron');
let editingCron = null;

$('#cron-presets').innerHTML = CRON_PRESETS
  .map(([label, value]) => `<button type="button" class="btn tiny" data-cron-preset="${esc(value)}">${esc(label)}</button>`)
  .join('');

$('#cron-presets').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-cron-preset]');
  if (!btn) return;
  $('#cron-schedule').value = btn.dataset.cronPreset;
  $('#cron-schedule').dispatchEvent(new Event('input'));
});

// Say what the schedule means as it is typed, so a wrong one is obvious here
// rather than at three in the morning.
$('#cron-schedule').addEventListener('input', () => {
  const words = cronWords($('#cron-schedule').value);
  $('#cron-schedule-hint').textContent = words
    ? `Runs ${words}.`
    : 'minute · hour · day of month · month · day of week';
});

function openCronModal({ user = 'root', job = null } = {}) {
  editingCron = job;
  $('#form-cron').reset();
  $('#cron-msg').classList.add('hidden');
  $('#cron-title').textContent = job ? 'Edit the scheduled job' : 'Add a scheduled job';
  $('#btn-cron-save').textContent = job ? 'Save the job' : 'Add the job';
  $('#cron-user').value = job?.user || user || 'root';
  $('#cron-schedule').value = job?.schedule || '';
  $('#cron-command').value = job?.command || '';
  $('#cron-schedule').dispatchEvent(new Event('input'));
  cronModal.classList.remove('hidden');
}

$('#form-cron').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#btn-cron-save');
  const msg = $('#cron-msg');
  const fd = new FormData(e.target);

  const body = {
    user: fd.get('user'),
    schedule: fd.get('schedule'),
    command: String(fd.get('command') || '').trim(),
    ...(editingCron ? { old_line: editingCron.raw } : {}),
  };

  busy(btn, true, 'Saving…');
  try {
    await api(`/servers/${currentServerId}/cron/jobs`, { method: editingCron ? 'PUT' : 'POST', body });
    cronModal.classList.add('hidden');
    toast(editingCron ? 'The job was changed' : 'The job was added');
    loadServerCron();
  } catch (err) {
    formMsg(msg, err.message, 'err');
  }
  busy(btn, false);
});

/** Every button on the cron tab. */
async function cronPanelAction(btn) {
  const { cron: what, user, line } = btn.dataset;

  if (what === 'add') return openCronModal({ user: user || 'root' });

  if (what === 'edit') {
    const job = (cronCache?.users || []).flatMap((u) => u.jobs).find((j) => j.raw === line && j.user === user);
    if (!job) return toast('That job is no longer there — refreshing', 'err');
    return openCronModal({ job });
  }

  if (what === 'delete') {
    if (!confirm(`Delete this job from ${user}'s crontab?\n\n${line}\n\nIt stops running immediately.`)) return;
    busy(btn, true, 'Deleting…');
    try {
      await api(`/servers/${currentServerId}/cron/jobs`, { method: 'DELETE', body: { user, old_line: line } });
      toast('The job was deleted');
    } catch (err) {
      toast(err.message, 'err');
    }
    return loadServerCron();
  }

  if (what === 'install') {
    busy(btn, true, 'Installing…');
    try {
      const r = await api(`/servers/${currentServerId}/cron/install`, { method: 'POST' });
      toast(r.active ? 'cron installed and running' : 'cron installed');
    } catch (err) {
      toast(err.message, 'err');
    }
    return loadServerCron();
  }
  return undefined;
}

$('#view-server-detail').addEventListener('click', (e) => {
  if (e.target.closest('[data-cron-reload]')) return loadServerCron();
  const btn = e.target.closest('button[data-cron]');
  if (btn) return cronPanelAction(btn);
  return undefined;
});

/* ------------------------------------------------------- the nginx tab */

let nginxCache = null;
const siteOf = (name) => (nginxCache?.sites || []).find((s) => s.name === name) || null;

/** How long a certificate has left, said plainly. */
function certChip(site) {
  if (!site.ssl) return '<span class="badge">no SSL</span>';
  const c = site.certificate;
  if (!c) return '<span class="badge ok">SSL</span>';
  const days = c.daysLeft;
  const tone = days === null ? 'ok' : days < 0 ? 'err' : days < 14 ? 'warn' : 'ok';
  const when = days === null ? 'certificate installed' : days < 0 ? `expired ${-days}d ago` : `${days}d left`;
  return `<span class="badge ${tone}">SSL · ${esc(when)}</span>`;
}

async function loadServerNginx() {
  const box = $('#nginx-panel');
  if (!box) return;
  tabsLoaded.add('nginx');
  box.innerHTML = '<div class="empty"><span class="spinner"></span>Reading nginx…</div>';

  const head = (tools = '') => `
    <div class="section-head">
      <h2>Nginx</h2>
      <div class="section-tools">${tools}<button class="btn tiny" data-nginx-reload="1">Refresh</button></div>
    </div>`;

  try {
    const { nginx: n } = await api(`/servers/${currentServerId}/nginx`);
    nginxCache = n;

    if (!n.installed) {
      setTabCount('nginx', '—');
      box.innerHTML = `${head()}
        <div class="card">
          <div class="msg info" style="margin-top:0">
            <b>nginx is not installed on this server.</b><br />
            Install it to put domains in front of the apps running here, with certificates from Let's Encrypt.
          </div>
          ${ifCan('create', '<div class="card-actions"><button class="btn tiny primary" data-nginx="install">Install nginx on this server</button></div>')}
        </div>`;
      return;
    }

    setTabCount('nginx', n.sites.filter((s) => s.enabled).length, n.configTest.ok ? '' : 'err');

    const statusTile = n.running
      ? tile('Status', '<span class="badge ok">running</span>', `${esc(n.enabled)} at boot`)
      : tile('Status', `<span class="badge err">${esc(n.active)}</span>`, 'not serving anything');

    box.innerHTML = `
      ${head(ifCan('create', '<button class="btn tiny primary" data-nginx="add-site">+ Add domain</button>'
        + '<button class="btn tiny" data-nginx="test">Test config</button>'
        + '<button class="btn tiny" data-nginx="reload">Reload</button>'))}

      <div class="tiles" style="margin-bottom:14px">
        ${tile('Version', esc(n.version || '—'), esc(n.confPath))}
        ${statusTile}
        ${tile('Workers', String(n.workers), n.ports.length ? `listening on ${esc(n.ports.join(', '))}` : 'nothing listening')}
        ${tile('Domains', String(n.sites.filter((s) => s.enabled).length),
    `${n.sites.filter((s) => s.ssl).length} on SSL · ${n.sites.length} file(s)`)}
      </div>

      ${n.configTest.ok
    ? ''
    : `<div class="msg err" style="margin-bottom:14px"><b>nginx -t does not pass on this server.</b>
         <pre class="log" style="margin-top:8px">${esc(n.configTest.output || 'no output')}</pre></div>`}

      ${section('Domains', table(
    [{ label: 'Domain' }, { label: 'Serves' }, { label: 'SSL' }, { label: 'State' }, { label: '' }],
    n.sites.map((s) => [
      `<b>${esc(s.domains[0] || s.name)}</b>
           ${s.domains.length > 1 ? `<div class="muted small">${esc(s.domains.slice(1).join(', '))}</div>` : ''}
           <div class="muted small"><code>${esc(s.file)}</code></div>`,
      s.kind === 'proxy'
        ? `<code class="small">${esc(s.proxyPass)}</code>`
        : s.kind === 'static'
          ? `<code class="small">${esc(s.root)}</code><div class="muted small">static files</div>`
          : '<span class="muted small">—</span>',
      `${certChip(s)}${s.certificate ? `<div class="muted small">${esc(s.certificate.name)}</div>` : ''}`,
      `${s.enabled ? '<span class="badge ok">enabled</span>' : '<span class="badge">disabled</span>'}
           ${s.managed ? '<div class="muted small">added here</div>' : ''}`,
      `<div class="row-actions">
           ${ifCan('edit', `<button class="btn tiny" data-nginx="edit-site" data-name="${esc(s.name)}">Edit</button>`)}
           ${ifCan('create', `<button class="btn tiny" data-nginx="ssl" data-name="${esc(s.name)}">${s.ssl ? 'Redo SSL' : 'Add SSL'}</button>`)}
           ${s.inConfD ? '' : ifCan('edit', `<button class="btn tiny" data-nginx="toggle-site" data-name="${esc(s.name)}" data-enable="${s.enabled ? '0' : '1'}">${s.enabled ? 'Disable' : 'Enable'}</button>`)}
           ${ifCan('delete', `<button class="btn tiny danger" data-nginx="remove-site" data-name="${esc(s.name)}">Remove</button>`)}
         </div>`,
    ]),
    'nginx is serving nothing yet. Add a domain to put it in front of an app on this server.'
  ))}

      ${upstreamPanel(n)}

      ${section('SSL certificates', certbotPanel(n.certbot))}`;
  } catch (err) {
    setTabCount('nginx', '!', 'err');
    box.innerHTML = `${head()}<div class="msg err">${esc(err.message)}</div>`;
  }
}

function certbotPanel(cb) {
  if (!cb.installed) {
    return `<div class="card">
      <div class="msg info" style="margin-top:0">
        <b>certbot is not installed on this server.</b><br />
        It is what gets free certificates from Let's Encrypt and renews them before they expire.
      </div>
      ${ifCan('create', '<div class="card-actions"><button class="btn tiny primary" data-nginx="install-certbot">Install certbot here</button></div>')}
    </div>`;
  }

  return `
    <div class="tiles" style="margin-bottom:12px">
      ${tile('certbot', esc(cb.version || 'installed'), cb.nginxPlugin ? 'with the nginx plugin' : 'without the nginx plugin')}
      ${tile('Automatic renewal', cb.autoRenew
    ? '<span class="badge ok">on</span>'
    : `<span class="badge warn">${esc(cb.timer)}</span>`,
  cb.autoRenew ? 'certbot.timer is active' : 'certificates will not renew themselves')}
      ${tile('Certificates', String(cb.certificates.length), 'issued on this server')}
    </div>
    ${table(
    [{ label: 'Certificate' }, { label: 'Domains' }, { label: 'Expires' }, { label: '' }],
    cb.certificates.map((c) => [
      `<b>${esc(c.name)}</b><div class="muted small"><code>${esc(c.path || '')}</code></div>`,
      c.domains.map((d) => `<span class="chip">${esc(d)}</span>`).join(' '),
      `${esc(String(c.expiry || '').slice(0, 16))}
         <div class="muted small">${c.daysLeft === null ? '' : c.daysLeft < 0 ? `expired ${-c.daysLeft} days ago` : `${c.daysLeft} days left`}</div>`,
      ifCan('create', `<button class="btn tiny" data-nginx="renew" data-name="${esc(c.name)}">Renew</button>`),
    ]),
    'No certificates yet. Add SSL to a domain above and one is issued for it.'
  )}
    ${ifCan('create', `<div class="card-actions" style="margin-top:10px">
      <button class="btn tiny" data-nginx="renew-all">Renew everything due</button>
    </div>`)}`;
}

/** Whether a backend answers, and what holds its port when it is on this server. */
function backendState(t) {
  if (t.kind === 'variable') return '<span class="muted small">set at request time</span>';
  if (t.kind === 'upstream') {
    const s = t.upstreamSummary;
    return s ? `<span class="badge ${s.up === s.servers ? 'ok' : s.up ? 'warn' : 'err'}">${s.up}/${s.servers} up</span>` : '—';
  }
  if (t.down) return '<span class="badge">marked down</span>';
  const badge = t.up === true ? '<span class="badge ok">answering</span>'
    : t.up === false ? '<span class="badge err">not answering</span>'
      : '<span class="badge">unknown</span>';
  const who = [
    t.container && `container <b>${esc(t.container.name)}</b> <span class="muted">(${esc(t.container.image)} :${esc(t.container.containerPort)})</span>`,
    t.processes?.length && `process ${esc(t.processes.join(', '))}`,
    t.bind?.length && `bound on ${esc(t.bind.join(', '))}`,
  ].filter(Boolean).join(' · ');
  const note = t.local && t.listening === false ? 'nothing is listening on this port' : who;
  return `${badge}${note ? `<div class="muted small">${note}</div>` : ''}`;
}

const backendAddress = (t) => (t.kind === 'unix' ? `unix:${t.path}` : t.kind === 'tcp' ? `${t.host}:${t.port}` : t.address);

/** Upstream blocks, proxied locations and the ports bound on this server. */
function upstreamPanel(n) {
  const upstreams = n.upstreams || [];
  const proxies = n.proxies || [];
  const ports = n.listeningPorts || [];
  const allBackends = [...upstreams.flatMap((u) => u.servers), ...proxies.map((p) => p.target).filter((t) => t.kind === 'tcp' || t.kind === 'unix')];
  const up = allBackends.filter((t) => t.up === true).length;
  const down = allBackends.filter((t) => t.up === false && !t.down).length;

  const tiles = `<div class="tiles" style="margin-bottom:14px">
    ${tile('Upstreams', String(upstreams.length), `${upstreams.reduce((s, u) => s + u.servers.length, 0)} server(s) in them`)}
    ${tile('Proxied locations', String(proxies.length), `${new Set(proxies.flatMap((p) => p.domains)).size} domain(s) · ${proxies.filter((p) => p.stream).length} TCP stream(s)`)}
    ${tile('Backends', `${up} <span class="muted small">up</span>${down ? ` · <span style="color:var(--err)">${down} down</span>` : ''}`, 'answering right now')}
    ${tile('Ports bound', String(ports.length), `${ports.filter((p) => p.nginxListens).length} held by nginx · ${ports.filter((p) => p.container).length} by containers · ${ports.filter((p) => p.localOnly).length} localhost only`)}
  </div>`;

  const upstreamTable = ifCan('create', '<div style="display:flex;justify-content:flex-end;margin-bottom:10px"><button class="btn tiny primary" data-nginx="add-upstream">+ Add upstream</button></div>') + table(
    [{ label: 'Upstream' }, { label: 'Balancing' }, { label: 'Servers' }, { label: 'Used by' }, { label: '' }],
    upstreams.map((u) => [
      `<b>${esc(u.name)}</b><div class="muted small"><code>${esc(u.file || '')}</code></div>`,
      `${esc(u.method)}${u.keepalive ? `<div class="muted small">keepalive ${esc(u.keepalive)}</div>` : ''}`,
      u.servers.map((sv) => `<div style="margin-bottom:6px">
        <code class="small">${esc(backendAddress(sv))}</code>
        ${sv.weight !== 1 ? `<span class="chip">weight ${esc(sv.weight)}</span>` : ''}
        ${sv.backup ? '<span class="chip">backup</span>' : ''}
        ${sv.maxConns ? `<span class="chip">max_conns ${esc(sv.maxConns)}</span>` : ''}
        <span class="muted small">max_fails ${esc(sv.maxFails)} / ${esc(sv.failTimeout)}</span>
        <div>${backendState(sv)}</div>
      </div>`).join('') || '<span class="muted small">no servers</span>',
      u.usedBy.length ? u.usedBy.map((d) => `<span class="chip">${esc(d)}</span>`).join(' ') : '<span class="muted small">not used by any site</span>',
      `<div class="row-actions">
        ${ifCan('edit', `<button class="btn tiny" data-nginx="add-upstream-server" data-name="${esc(u.name)}">+ Port</button>
          <button class="btn tiny" data-nginx="edit-upstream" data-name="${esc(u.name)}">Edit</button>`)}
        ${ifCan('delete', `<button class="btn tiny danger" data-nginx="delete-upstream" data-name="${esc(u.name)}">Delete</button>`)}
      </div>`,
    ]),
    'No upstream blocks — sites proxy straight to an address.',
  );

  const proxyTable = table(
    [{ label: 'Domain' }, { label: 'Location' }, { label: 'Sends to' }, { label: 'Backend' }],
    proxies.map((p) => [
      `${p.stream ? '<span class="chip">TCP stream</span>' : esc(p.domains[0] || '(default server)')}${p.domains.length > 1 ? `<div class="muted small">${esc(p.domains.slice(1).join(', '))}</div>` : ''}
       <div class="muted small">listen ${esc(p.listen.join(', ') || '80')}</div>`,
      p.stream ? '<span class="muted small">whole connection</span>' : `<code class="small">${esc(p.location)}</code>`,
      `<code class="small">${esc(p.target.address)}</code><div class="muted small">${esc(p.via)}${p.target.kind === 'upstream' ? ` → upstream ${esc(p.target.upstream)}` : ''}</div>`,
      backendState(p.target),
    ]),
    'No location proxies to a backend.',
  );

  const portTable = table(
    [{ label: 'Port', num: true }, { label: 'Bound on' }, { label: 'Held by' }, { label: 'nginx' }],
    ports.map((p) => [
      `<b>${esc(p.port)}</b>`,
      `<code class="small">${p.binds.map(esc).join('<br>')}</code>${p.localOnly ? ' <span class="chip">localhost only</span>' : ''}`,
      `${p.container ? `container <b>${esc(p.container.name)}</b> <span class="muted small">${esc(p.container.image)} → :${esc(p.container.containerPort)}</span><br>` : ''}
       ${p.processes.length ? `<span class="small">${esc(p.processes.join(', '))}</span>` : '<span class="muted small">—</span>'}`,
      p.nginxListens ? '<span class="badge ok">listens here</span>' : p.nginxProxiesTo ? '<span class="badge warn">proxies to it</span>' : '<span class="muted small">—</span>',
    ]),
    'Nothing is listening on TCP on this server.',
  );

  return `
    ${section('Upstreams & backends', tiles + upstreamTable)}
    ${section('Proxied locations', proxyTable)}
    ${section(`Ports bound on this server · ${ports.length}`, portTable)}`;
}

/* ---------------------------------------------- nginx: upstream editor */

const upstreamModal = $('#modal-upstream');
const upstreamForm = $('#form-upstream');
let editingUpstream = null;

function upstreamServerRow(s = {}) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input data-f="address" value="${esc(s.address || '')}" placeholder="127.0.0.1:3000" autocomplete="off" spellcheck="false" style="min-width:190px" /></td>
    <td><input data-f="weight" type="number" min="1" max="1000" value="${esc(s.weight ?? 1)}" style="width:70px" /></td>
    <td><input data-f="maxFails" type="number" min="0" max="1000" value="${esc(s.maxFails ?? 1)}" style="width:70px" /></td>
    <td><input data-f="failTimeout" value="${esc(s.failTimeout || '10s')}" style="width:70px" /></td>
    <td><input data-f="maxConns" type="number" min="0" value="${esc(s.maxConns ?? '')}" placeholder="—" style="width:80px" /></td>
    <td style="text-align:center"><input data-f="backup" type="checkbox" ${s.backup ? 'checked' : ''} /></td>
    <td style="text-align:center"><input data-f="down" type="checkbox" ${s.down ? 'checked' : ''} /></td>
    <td><button type="button" class="btn tiny danger" data-upstream-remove title="Remove this server">✕</button></td>`;
  $('#upstream-servers tbody').appendChild(tr);
  return tr;
}

function applyUpstreamMethod() {
  $('#upstream-hash-field').classList.toggle('hidden', $('#upstream-method').value !== 'hash');
}

/** Add an upstream, or edit one — optionally opening with an empty server row ready for a new port. */
function openUpstreamModal(name = null, { addServer = false } = {}) {
  const u = name ? (nginxCache?.upstreams || []).find((x) => x.name === name) : null;
  if (name && !u) return toast('That upstream is gone — refresh the tab.', 'err');
  editingUpstream = u;
  upstreamForm.reset();
  $('#upstream-msg').classList.add('hidden');
  $('#upstream-servers tbody').innerHTML = '';
  $('#upstream-title').textContent = u ? `Edit upstream ${u.name}` : 'Add upstream';
  $('#btn-upstream-save').textContent = u ? 'Save & reload nginx' : 'Add upstream';
  $('#upstream-note').innerHTML = u
    ? `In <code>${esc(u.file)}</code>. Only this block is rewritten; <code>nginx -t</code> has to pass before it is kept, otherwise the file is put back.${u.usedBy.length ? ` Used by ${esc(u.usedBy.join(', '))}.` : ''}`
    : 'Written to its own file in <code>/etc/nginx/conf.d</code>. Point a site at it with <code>proxy_pass http://NAME;</code>.';

  if (u) {
    $('#upstream-name').value = u.name;
    const hash = /^hash (.+)$/.exec(u.method);
    $('#upstream-method').value = hash ? 'hash' : u.method;
    upstreamForm.hashKey.value = hash ? hash[1] : '';
    upstreamForm.keepalive.value = u.keepalive ?? '';
    u.servers.forEach((s) => upstreamServerRow({ ...s, address: s.address }));
  }
  if (!u || addServer) {
    const row = upstreamServerRow();
    setTimeout(() => row.querySelector('[data-f="address"]').focus(), 0);
  }
  applyUpstreamMethod();
  upstreamModal.classList.remove('hidden');
  if (!addServer) $('#upstream-name').focus();
}

$('#upstream-method').addEventListener('change', applyUpstreamMethod);
$('#btn-upstream-add-server').addEventListener('click', () => upstreamServerRow().querySelector('[data-f="address"]').focus());
$('#upstream-servers').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-upstream-remove]');
  if (b) b.closest('tr').remove();
});

upstreamForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#btn-upstream-save');
  const servers = $$('#upstream-servers tbody tr').map((tr) => {
    const f = (k) => tr.querySelector(`[data-f="${k}"]`);
    return {
      address: f('address').value.trim(),
      weight: f('weight').value,
      maxFails: f('maxFails').value,
      failTimeout: f('failTimeout').value.trim(),
      maxConns: f('maxConns').value,
      backup: f('backup').checked,
      down: f('down').checked,
    };
  }).filter((s) => s.address);
  const body = {
    name: $('#upstream-name').value.trim(),
    method: $('#upstream-method').value,
    hashKey: upstreamForm.hashKey.value.trim(),
    keepalive: upstreamForm.keepalive.value,
    servers,
    ...(editingUpstream ? { file: editingUpstream.file } : {}),
  };
  if (editingUpstream && body.name !== editingUpstream.name && editingUpstream.usedBy.length
    && !confirm(`Renaming ${editingUpstream.name} to ${body.name} does not change the proxy_pass lines of ${editingUpstream.usedBy.join(', ')} — nginx -t will fail until they are updated. Rename anyway?`)) return;

  busy(btn, true, 'Testing & reloading…');
  try {
    const r = editingUpstream
      ? await api(`/servers/${currentServerId}/nginx/upstreams/${encodeURIComponent(editingUpstream.name)}`, { method: 'PUT', body })
      : await api(`/servers/${currentServerId}/nginx/upstreams`, { method: 'POST', body });
    upstreamModal.classList.add('hidden');
    toast(`Upstream ${r.name} ${editingUpstream ? 'saved' : 'added'} in ${r.file} — nginx reloaded`);
    loadServerNginx();
  } catch (err) {
    formMsg($('#upstream-msg'), err.message, 'err');
  }
  busy(btn, false);
});

/** Every button in the nginx tab, in one place. */
async function nginxPanelAction(btn) {
  const { nginx: what, name } = btn.dataset;

  if (what === 'add-site') return openDomainModal();
  if (what === 'edit-site') return openDomainModal(siteOf(name));
  if (what === 'ssl') return openSslModal(siteOf(name));

  if (what === 'remove-site') {
    const site = siteOf(name);
    if (!confirm(`Remove ${site?.domains[0] || name} from nginx?\n\nThe file is deleted and nginx reloaded.`
      + `${site?.ssl ? '\n\nIts certificate is kept — certbot can reuse it if you add the domain again.' : ''}`)) return;
    busy(btn, true, 'Removing…');
    try {
      await api(`/servers/${currentServerId}/nginx/sites/${encodeURIComponent(name)}`, { method: 'DELETE' });
      toast(`${name} removed from nginx`);
    } catch (err) {
      toast(err.message, 'err');
    }
    return loadServerNginx();
  }

  if (what === 'toggle-site') {
    const enable = btn.dataset.enable === '1';
    busy(btn, true, enable ? 'Enabling…' : 'Disabling…');
    try {
      await api(`/servers/${currentServerId}/nginx/sites/${encodeURIComponent(name)}`, {
        method: 'PUT', body: { enabled: enable },
      });
      toast(`${name} ${enable ? 'enabled' : 'disabled'}`);
    } catch (err) {
      toast(err.message, 'err');
    }
    return loadServerNginx();
  }

  if (what === 'add-upstream') return openUpstreamModal();
  if (what === 'edit-upstream') return openUpstreamModal(name);
  if (what === 'add-upstream-server') return openUpstreamModal(name, { addServer: true });
  if (what === 'delete-upstream') {
    const u = (nginxCache?.upstreams || []).find((x) => x.name === name);
    if (u?.usedBy.length) return toast(`"${name}" is still used by ${u.usedBy.join(', ')} — point those at something else first.`, 'err');
    if (!confirm(`Delete upstream ${name}?\n\nIt is removed from ${u?.file || 'its file'}, the configuration is tested, and nginx reloaded.`)) return;
    busy(btn, true, 'Deleting…');
    try {
      await api(`/servers/${currentServerId}/nginx/upstreams/${encodeURIComponent(name)}`, { method: 'DELETE' });
      toast(`Upstream ${name} deleted — nginx reloaded`);
    } catch (err) {
      toast(err.message, 'err');
    }
    return loadServerNginx();
  }

  if (what === 'install' || what === 'install-certbot') {
    const label = what === 'install' ? 'nginx' : 'certbot';
    busy(btn, true, 'Installing…');
    try {
      const r = await api(`/servers/${currentServerId}/nginx/install`, {
        method: 'POST', body: { what: label },
      });
      toast(`${label} installed${r.version ? ` — ${r.version}` : ''}`);
    } catch (err) {
      toast(err.message, 'err');
    }
    return loadServerNginx();
  }

  if (what === 'renew' || what === 'renew-all') {
    if (what === 'renew-all' && !confirm('Run certbot renew for every certificate that is due?')) return;
    busy(btn, true, 'Renewing…');
    try {
      const r = await api(`/servers/${currentServerId}/nginx/ssl/renew`, {
        method: 'POST', body: what === 'renew' ? { cert_name: name } : {},
      });
      toast(r.upToDate ? 'Nothing was due for renewal yet' : 'Renewed — nginx reloaded');
    } catch (err) {
      toast(err.message, 'err');
    }
    return loadServerNginx();
  }

  // reload / restart / test
  busy(btn, true, '…');
  try {
    const r = await api(`/servers/${currentServerId}/nginx/action`, { method: 'POST', body: { action: what } });
    toast(what === 'test' ? (r.output || 'the configuration passes') : `nginx ${what} — ${r.active || 'done'}`);
  } catch (err) {
    toast(err.message, 'err');
  }
  return loadServerNginx();
}

/* -------------------------------------------------- add / edit a domain */

const domainModal = $('#modal-domain');
let editingSite = null;

function applyDomainKind() {
  const isStatic = $('#domain-kind').value === 'static';
  $('#domain-proxy-fields').classList.toggle('hidden', isStatic);
  $('#domain-root-field').classList.toggle('hidden', !isStatic);
  $('#domain-spa-field').classList.toggle('hidden', !isStatic);
  $('#domain-ws-field').classList.toggle('hidden', isStatic);
}

$('#domain-kind').addEventListener('change', applyDomainKind);

$('#domain-raw-check').addEventListener('change', () => {
  const raw = $('#domain-raw-check').checked;
  $('#domain-raw-field').classList.toggle('hidden', !raw);
  $('#domain-form-fields').classList.toggle('hidden', raw);
});

/** `site` is null when adding, or the parsed site when editing. */
async function openDomainModal(site = null) {
  editingSite = site;
  $('#form-domain').reset();
  $('#domain-msg').classList.add('hidden');
  $('#domain-log').classList.add('hidden');
  $('#domain-config').value = '';
  $('#domain-title').textContent = site ? `Edit ${site.domains[0] || site.name}` : 'Add domain';
  $('#btn-domain-save').textContent = site ? 'Save changes' : 'Add domain';
  $('#domain-enabled').checked = site ? site.enabled : true;
  domainModal.classList.remove('hidden');

  if (!site) {
    $('#domain-sub').textContent = 'Writes an nginx site on the server. The configuration is tested before nginx '
      + 'is reloaded, and put back as it was if the test fails.';
    $('#domain-raw-check').checked = false;
    $('#domain-raw-check').disabled = false;
    $('#domain-raw-toggle').classList.remove('hidden');
    $('#domain-raw-field').classList.add('hidden');
    $('#domain-form-fields').classList.remove('hidden');
    applyDomainKind();
    return;
  }

  $('#domain-names').value = site.domains.join(' ');
  $('#domain-kind').value = site.kind === 'static' ? 'static' : 'proxy';
  $('#domain-upstream').value = site.proxyPass || '';
  $('#domain-root').value = site.root || '';
  applyDomainKind();

  // A site certbot has rewritten carries its HTTPS server block; regenerating
  // it from the form would throw that away, so those are edited as the file.
  const mustBeRaw = site.ssl || site.kind === 'other' || !site.managed;
  $('#domain-raw-check').checked = mustBeRaw;
  $('#domain-raw-check').disabled = mustBeRaw;
  $('#domain-raw-field').classList.toggle('hidden', !mustBeRaw);
  $('#domain-form-fields').classList.toggle('hidden', mustBeRaw);
  $('#domain-sub').textContent = mustBeRaw
    ? 'This file was not written by the panel — or SSL has been added to it — so it is edited as it is. '
      + 'nginx -t has to pass before it is kept.'
    : 'Change the fields, or tick the box below to edit the file itself.';

  $('#domain-config').value = 'Loading the file from the server…';
  try {
    const r = await api(`/servers/${currentServerId}/nginx/sites/${encodeURIComponent(site.name)}`);
    $('#domain-config').value = r.content;
  } catch (err) {
    $('#domain-config').value = '';
    formMsg($('#domain-msg'), err.message, 'err');
  }
}

$('#form-domain').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#btn-domain-save');
  const msg = $('#domain-msg');
  const log = $('#domain-log');
  const fd = new FormData(e.target);
  const raw = $('#domain-raw-check').checked;

  const body = {
    domains: fd.get('domains'),
    enabled: $('#domain-enabled').checked,
    ...(raw
      ? { config: $('#domain-config').value }
      : {
        kind: fd.get('kind'),
        port: fd.get('port'),
        upstream: fd.get('upstream'),
        root: fd.get('root'),
        spa: $('#domain-spa').checked,
        websockets: $('#domain-ws').checked,
        max_body_size: fd.get('max_body_size'),
      }),
  };

  busy(btn, true, 'Saving…');
  log.classList.add('hidden');
  formMsg(msg, 'Writing the file and testing the configuration…', 'info');
  try {
    const path = editingSite
      ? `/servers/${currentServerId}/nginx/sites/${encodeURIComponent(editingSite.name)}`
      : `/servers/${currentServerId}/nginx/sites`;
    const r = await api(path, { method: editingSite ? 'PUT' : 'POST', body });
    domainModal.classList.add('hidden');
    toast(`${(r.domains || [])[0] || r.name} saved — nginx reloaded`);
    loadServerNginx();
  } catch (err) {
    formMsg(msg, err.message, 'err');
    if (err.detail) {
      log.textContent = err.detail;
      log.classList.remove('hidden');
    }
  }
  busy(btn, false);
});

/* ------------------------------------------------------------- SSL */

const sslModal = $('#modal-ssl');

function openSslModal(site) {
  $('#form-ssl').reset();
  $('#ssl-msg').classList.add('hidden');
  $('#ssl-log').classList.add('hidden');
  $('#ssl-redirect').checked = true;
  $('#ssl-domains').value = site ? site.domains.join(' ') : '';
  sslModal.classList.remove('hidden');

  if (!nginxCache?.certbot.installed) {
    formMsg($('#ssl-msg'), 'certbot is not installed on this server yet — install it from the Nginx tab first.', 'err');
  }
}

$('#form-ssl').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#btn-ssl-go');
  const msg = $('#ssl-msg');
  const log = $('#ssl-log');
  const fd = new FormData(e.target);

  busy(btn, true, 'Asking Let\'s Encrypt…');
  log.classList.add('hidden');
  formMsg(msg, 'certbot is proving you control the domain, then installing the certificate…', 'info');
  try {
    const r = await api(`/servers/${currentServerId}/nginx/ssl`, {
      method: 'POST',
      body: {
        domains: fd.get('domains'),
        email: fd.get('email'),
        redirect: $('#ssl-redirect').checked,
        staging: $('#ssl-staging').checked,
      },
    });
    sslModal.classList.add('hidden');
    toast(`Certificate installed for ${r.domains.join(', ')}`);
    loadServerNginx();
  } catch (err) {
    formMsg(msg, err.message, 'err');
    if (err.detail) {
      log.textContent = err.detail;
      log.classList.remove('hidden');
    }
  }
  busy(btn, false);
});

const networkModal = $('#modal-network');

function openNetworkModal() {
  $('#form-network').reset();
  $('#network-msg').classList.add('hidden');
  $('#network-server-name').textContent = currentServer ? currentServer.name : 'this server';
  networkModal.classList.remove('hidden');
}

$('#form-network').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  const msg = $('#network-msg');
  busy(btn, true, 'Creating…');
  try {
    const fd = new FormData(e.target);
    await api(`/servers/${currentServerId}/docker/networks`, {
      method: 'POST',
      body: { name: fd.get('name'), driver: fd.get('driver') },
    });
    networkModal.classList.add('hidden');
    toast(`Network ${fd.get('name')} created`);
    loadServerDocker();
  } catch (err) {
    formMsg(msg, err.message, 'err');
  }
  busy(btn, false);
});

/* ------------------------------------------------------------ settings */

let teamState = { members: [], roles: [], canManage: false, organisations: [] };
let settingsTab = 'profile';

/**
 * Settings is one page with a rail of its own: your account first, then the
 * people in this organisation, then the organisations themselves.
 */
const SETTINGS_TABS = [
  { key: 'profile', label: 'Your account' },
  { key: 'team', label: 'Team', needs: 'members', inOrg: true },
  { key: 'organisations', label: 'Organisations', inOrg: true },
  { key: 'panel', label: 'About this panel' },
];

function openSettings(tab = settingsTab) {
  settingsTab = tab;
  show('settings');
  setHeading('Settings');
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === 'settings'));
  loadSettings();
}

async function loadSettings() {
  const box = $('#settings-body');
  const visible = SETTINGS_TABS.filter((t) => (!t.needs || canDo(t.needs)) && (!t.inOrg || session.user?.orgId));
  if (!visible.some((t) => t.key === settingsTab)) settingsTab = 'profile';

  $('#settings-tabs').innerHTML = visible.map((t) =>
    `<button class="tab ${t.key === settingsTab ? 'active' : ''}" data-settings-tab="${t.key}"><span>${esc(t.label)}</span></button>`).join('');

  box.innerHTML = '<div class="empty"><span class="spinner"></span>Loading…</div>';

  try {
    const [team, orgs] = await Promise.all([
      api('/team/members').catch(() => ({ members: [], roles: [], canManage: false })),
      api('/team/organisations').catch(() => ({ organisations: [], canManage: false })),
    ]);
    teamState = { ...team, organisations: orgs.organisations, canManageOrgs: orgs.canManage };

    box.innerHTML = {
      profile: settingsProfile,
      team: settingsTeam,
      organisations: settingsOrganisations,
      panel: settingsPanel,
    }[settingsTab]();

    if (settingsTab === 'panel') fillPanelFacts();
  } catch (err) {
    box.innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
  }
}

$('#settings-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-settings-tab]');
  if (!btn) return;
  settingsTab = btn.dataset.settingsTab;
  loadSettings();
});

/** Who you are, and the two things you can change about yourself. */
function settingsProfile() {
  const u = session.user || {};
  return `
    ${section('Your account', `<div class="card">
      <dl class="kv">
        <dt>Name</dt><dd>${esc(u.name || '')}</dd>
        <dt>Email</dt><dd><code>${esc(u.email || '')}</code></dd>
        <dt>Role</dt><dd><span class="badge ${u.role === 'super_admin' ? 'ok' : ''}">${esc(roleLabel(u.role))}</span>
          <div class="muted small">${esc(session.roles.find((r) => r.key === u.role)?.detail || '')}</div></dd>
        <dt>Organisation</dt><dd>${esc(u.organisation?.name || 'none')}</dd>
        <dt>Last signed in</dt><dd>${val(u.lastLoginAt ? String(u.lastLoginAt).replace('T', ' ').slice(0, 16) : 'this is your first time')}</dd>
      </dl>
      <div class="card-actions">
        <button class="btn tiny" data-settings-action="profile">Edit profile</button>
        <button class="btn tiny" data-settings-action="password">Change password</button>
        <button class="btn tiny danger" data-settings-action="signout">Sign out</button>
      </div>
    </div>`)}

    ${section('What your role may do', roleTable([u.role]))}`;
}

/** The permission matrix, with one row optionally highlighted. */
function roleTable(highlight = []) {
  return `<div class="card" style="padding:4px 0">
    <table>
      <thead><tr><th>Role</th><th>View</th><th>Add</th><th>Edit</th><th>Delete</th><th>Manage people</th><th>Organisations</th></tr></thead>
      <tbody>${session.roles.map((r) => `<tr>
        <td><b>${esc(r.label)}</b>${highlight.includes(r.key) ? ' <span class="badge ok">you</span>' : ''}
          <div class="muted small">${esc(r.detail)}</div></td>
        ${['view', 'create', 'edit', 'delete', 'members', 'orgs'].map((p) =>
          `<td>${r.can[p] ? '<span class="badge ok">yes</span>' : '<span class="muted small">no</span>'}</td>`).join('')}
      </tr>`).join('')}</tbody>
    </table>
  </div>`;
}

function settingsPanel() {
  return section('About this panel', `<div class="card" id="panel-facts">
    <p class="muted small" style="margin:0"><span class="spinner"></span>Reading…</p>
  </div>`);
}

async function fillPanelFacts() {
  try {
    const h = await api('/health');
    const box = $('#panel-facts');
    if (!box) return;
    box.innerHTML = `<dl class="kv">
      <dt>Organisation</dt><dd>${esc(h.organisation || '—')}</dd>
      <dt>Servers</dt><dd>${val(h.servers)}</dd>
      <dt>Credentials</dt><dd>${val(h.credentials)}</dd>
      <dt>Runners</dt><dd>${val(h.runners)}</dd>
      <dt>Database</dt><dd><code class="small">${esc(h.database)}</code></dd>
      <dt>Running for</dt><dd>${Math.floor((h.uptimeSeconds || 0) / 3600)}h ${Math.floor(((h.uptimeSeconds || 0) % 3600) / 60)}m</dd>
    </dl>
    <p class="muted small" style="margin:12px 0 0">Everything above is scoped to the organisation you are working in.</p>`;
  } catch { /* the page is still useful without it */ }
}

function settingsTeam() {
  const team = teamState;
  return `
      ${section('People', table(
        [{ label: 'Name' }, { label: 'Email' }, { label: 'Role' }, { label: 'Account' }, { label: 'Last signed in' }, { label: '' }],
        team.members.map((m) => [
          `<b>${esc(m.name)}</b>${m.id === session.user?.id ? ' <span class="badge">you</span>' : ''}`,
          `<span class="small">${esc(m.email)}</span>${m.phone ? `<div class="muted small">📱 ${esc(m.phone)}</div>` : PHONE_ROLES.includes(m.role) ? '<div class="small" style="color:var(--warn)">📱 no mobile number</div>' : ''}`,
          `<span class="badge ${m.role === 'super_admin' ? 'ok' : m.role === 'viewer' ? '' : 'warn'}">${esc(m.roleLabel)}</span>`,
          m.status === 'active' ? '<span class="badge ok">active</span>' : '<span class="badge err">disabled</span>',
          `<span class="small">${val(m.lastLoginAt ? String(m.lastLoginAt).replace('T', ' ').slice(0, 16) : 'never')}</span>`,
          team.canManage && m.id !== session.user?.id ? `<div class="row-actions">
            <button class="btn tiny" data-member="edit" data-id="${m.id}">Edit</button>
            <button class="btn tiny danger" data-member="delete" data-id="${m.id}" data-name="${esc(m.name)}">Remove</button>
          </div>` : '<span class="muted small">—</span>',
        ]),
        'Nobody else here yet'
      ))}

      ${team.canManage ? '<p class="muted small">Adding somebody gives them a password you choose — they can change it once they are in.</p>' : ''}
      ${section('What each role may do', roleTable())}`;
}

function settingsOrganisations() {
  return `
      ${section('Organisations', table(
        [{ label: 'Organisation' }, { label: 'People', num: true }, { label: 'Servers', num: true }, { label: 'Credentials', num: true }, { label: '' }],
        teamState.organisations.map((o) => [
          `<b>${esc(o.name)}</b>${o.current ? ' <span class="badge ok">current</span>' : ''}
           ${o.notes ? `<div class="muted small">${esc(o.notes)}</div>` : ''}`,
          o.counts.members, o.counts.servers, o.counts.credentials,
          teamState.canManageOrgs ? `<div class="row-actions">
            ${o.current ? '' : `<button class="btn tiny" data-org="switch" data-id="${o.id}">Work in it</button>`}
            <button class="btn tiny" data-org="edit" data-id="${o.id}">Rename</button>
            ${o.current ? '' : `<button class="btn tiny danger" data-org="delete" data-id="${o.id}" data-name="${esc(o.name)}">Delete</button>`}
          </div>` : '',
        ]),
        'No organisations'
      ))}

      <p class="muted small">Servers, credentials, runners and installations all belong to an organisation — nothing is shared between them.</p>`;
}

$('#view-settings').addEventListener('click', async (e) => {
  const member = e.target.closest('button[data-member]');
  if (member) return memberAction(member);
  const org = e.target.closest('button[data-org]');
  if (org) return orgAction(org);

  const own = e.target.closest('button[data-settings-action]');
  if (!own) return;
  if (own.dataset.settingsAction === 'profile') return $('#btn-edit-profile').click();
  if (own.dataset.settingsAction === 'password') return $('#btn-password').click();
  if (own.dataset.settingsAction === 'signout') return $('#btn-signout').click();
});

async function memberAction(btn) {
  const { member: action, id, name } = btn.dataset;
  if (action === 'edit') return openMemberModal(teamState.members.find((m) => String(m.id) === id));
  if (!confirm(`Remove ${name}? Their account and every session it has are deleted.`)) return;
  busy(btn, true, 'Removing…');
  try {
    await api(`/team/members/${id}`, { method: 'DELETE' });
    toast(`${name} removed`);
  } catch (err) {
    toast(err.message, 'err');
  }
  loadSettings();
}

/* ------------------------------------------------------ member modal */

const memberModal = $('#modal-member');
const memberForm = $('#form-member');
let editingMemberId = null;

function openMemberModal(member = null) {
  editingMemberId = member?.id || null;
  memberForm.reset();
  $('#member-msg').classList.add('hidden');
  $('#member-title').textContent = member ? `Edit ${member.name}` : 'Add person';
  $('#btn-member-save').textContent = member ? 'Save changes' : 'Add person';
  $('#member-org-name').textContent = session.user?.organisation?.name || 'this organisation';

  $('#member-role').innerHTML = teamState.roles.map((r) =>
    `<option value="${esc(r.key)}">${esc(r.label)}</option>`).join('');

  // Only a super admin places someone into a different organisation, and only on the way in.
  const canPickOrg = session.user?.role === 'super_admin' && !member;
  $('#member-org-field').classList.toggle('hidden', !canPickOrg);
  if (canPickOrg) {
    $('#member-org').innerHTML = teamState.organisations.map((o) =>
      `<option value="${o.id}" ${o.current ? 'selected' : ''}>${esc(o.name)}</option>`).join('');
  }

  $('#member-status-field').classList.toggle('hidden', !member);
  $('#member-password-label').childNodes[0].textContent = member ? 'New password ' : 'Password';
  memberForm.password.required = !member;

  if (member) {
    memberForm.name.value = member.name;
    memberForm.phone.value = member.phone || '';
    memberForm.email.value = member.email;
    memberForm.email.disabled = true;
    memberForm.role.value = member.role;
    memberForm.status.value = member.status;
  } else {
    memberForm.email.disabled = false;
  }

  showRoleDetail();
  memberModal.classList.remove('hidden');
}

function showRoleDetail() {
  const role = teamState.roles.find((r) => r.key === $('#member-role').value);
  $('#member-role-detail').textContent = role?.detail || '';
  // An admin must be reachable: their mobile number is required.
  const needed = PHONE_ROLES.includes($('#member-role').value);
  memberForm.phone.required = needed;
  $('#member-phone-hint').textContent = needed ? '(required for an admin — with country code)' : '(optional)';
}

$('#member-role').addEventListener('change', showRoleDetail);
$('#btn-add-member').addEventListener('click', () => openMemberModal());

memberForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#btn-member-save');
  const msg = $('#member-msg');
  const body = Object.fromEntries(new FormData(memberForm).entries());
  busy(btn, true, 'Saving…');
  try {
    if (editingMemberId) {
      if (!body.password) delete body.password;
      await api(`/team/members/${editingMemberId}`, { method: 'PUT', body });
      toast('Saved');
    } else {
      await api('/team/members', { method: 'POST', body });
      toast(`${body.name} can now sign in`);
    }
    memberModal.classList.add('hidden');
    loadSettings();
  } catch (err) {
    formMsg(msg, err.message, 'err');
  }
  busy(btn, false);
});

/* ------------------------------------------------ organisation modal */

const orgModal = $('#modal-org');
let editingOrgId = null;

function openOrgModal(org = null) {
  editingOrgId = org?.id || null;
  $('#form-org').reset();
  $('#org-msg').classList.add('hidden');
  $('#org-title').textContent = org ? `Rename ${org.name}` : 'Add organisation';
  if (org) {
    $('#form-org').name.value = org.name;
    $('#form-org').notes.value = org.notes || '';
  }
  orgModal.classList.remove('hidden');
}

$('#btn-add-org').addEventListener('click', () => openOrgModal());

async function orgAction(btn) {
  const { org: action, id, name } = btn.dataset;
  const org = teamState.organisations.find((o) => String(o.id) === id);

  if (action === 'edit') return openOrgModal(org);

  if (action === 'switch') {
    try {
      const r = await api('/auth/organisation', { method: 'POST', body: { org_id: id } });
      session.user = r.user;
      applyIdentity();
      toast(`Now working in ${r.user.organisation?.name}`);
      await enterApp({ keepOrgPicker: false });
      openSettings('organisations');
    } catch (err) {
      toast(err.message, 'err');
    }
    return;
  }

  if (!confirm(`Delete "${name}"? This only works while it is empty.`)) return;
  try {
    await api(`/team/organisations/${id}`, { method: 'DELETE' });
    toast(`${name} deleted`);
  } catch (err) {
    toast(err.message, 'err');
  }
  loadSettings();
}

$('#form-org').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  const body = Object.fromEntries(new FormData(e.target).entries());
  busy(btn, true, 'Saving…');
  try {
    await api(editingOrgId ? `/team/organisations/${editingOrgId}` : '/team/organisations',
      { method: editingOrgId ? 'PUT' : 'POST', body });
    orgModal.classList.add('hidden');
    toast(editingOrgId ? 'Organisation renamed' : `${body.name} created`);
    await loadOrgSwitcher();
    loadSettings();
  } catch (err) {
    formMsg($('#org-msg'), err.message, 'err');
  }
  busy(btn, false);
});

/* ------------------------------------------------------------ activity */

async function loadActivity() {
  const rows = await api('/activity');
  $('#activity-list').innerHTML = rows.length
    ? `<table><thead><tr><th>When</th><th>Who</th><th>Entity</th><th>Action</th><th>Message</th></tr></thead><tbody>
        ${rows.map((r) => `<tr>
          <td class="muted small nowrap">${esc(r.created_at)}</td>
          <td class="small nowrap">${val(r.user_name)}</td>
          <td class="small nowrap">${esc(r.entity)}${r.entity_id ? ` #${esc(r.entity_id)}` : ''}</td>
          <td class="nowrap"><span class="badge ${r.level === 'error' ? 'err' : r.level === 'warn' ? 'warn' : ''}">${esc(r.action)}</span></td>
          <td class="small">${esc(r.message)}</td>
        </tr>`).join('')}
      </tbody></table>`
    : '<p class="muted small" style="margin:0">Nothing yet.</p>';
}

/* ---------------------------------------------------------------- boot */

async function health() {
  try {
    const h = await api('/health');
    $('#health-dot').className = 'dot online';
    $('#health-text').textContent = !h.signedIn ? 'signed out'
      : !session.user?.orgId ? 'Platform · connected'
        : `${h.servers} servers · ${h.credentials} creds · ${h.runners} runners`;
  } catch {
    $('#health-dot').className = 'dot error';
    $('#health-text').textContent = 'API unreachable';
  }
}

/* ========================================================= super admin */

/**
 * The whole platform on one page: the numbers, every organisation and person,
 * the plans on sale and the payments recorded against them. Each tab is read
 * the first time it is opened, and again after anything changes.
 */
const pf = { tab: 'dashboard', lastTab: 'dashboard', loaded: new Set(), orgs: null, plans: null, users: null, payments: null, roles: [], orgId: null, detail: null };

/** Each page of the platform, picked from the side menu. `org` is one organisation, opened from the list. */
const PF_TABS = [
  { key: 'dashboard', label: 'Dashboard', sub: 'Revenue, organisations, clients and everything under management.', load: pfDashboard },
  { key: 'leads', label: 'Leads', sub: 'Everyone who asked about the platform — follow each one up until they become a client.', load: pfLeads },
  { key: 'leadstats', label: 'Lead analysis', sub: 'Where leads come from, how fast they get an answer and how many become clients.', load: pfLeadStats },
  { key: 'orgs', label: 'Organisations', sub: 'Every client organisation: its plan, its people and what it uses.', load: pfOrganisations },
  { key: 'users', label: 'Clients', sub: 'Everyone who signs in to a client organisation.', load: pfUsers },
  { key: 'plans', label: 'Plans', sub: 'What is on sale. Active, public plans appear on the landing page.', load: pfPlans },
  { key: 'payments', label: 'Payments', sub: 'Money received from clients, recorded by hand.', load: pfPayments },
  { key: 'admins', label: 'Super admins', sub: 'The people who run this platform. They belong to no organisation.', load: pfAdmins },
  { key: 'org', label: 'Organisation', sub: '', load: pfOrgDetail },
  { key: 'lead', label: 'Lead', sub: '', load: pfLeadDetail },
];

const PF_ACTIONS = {
  orgs: '<button class="btn primary" data-pf="new-org">+ Organisation</button>',
  users: '<button class="btn primary" data-pf="new-client">+ Client</button>',
  plans: '<button class="btn primary" data-pf="new-plan">+ Plan</button>',
  payments: '<button class="btn primary" data-pf="new-payment">+ Record payment</button>',
  admins: '<button class="btn primary" data-pf="new-admin">+ Super admin</button>',
  org: '<button class="btn" data-pf="org-back">← All organisations</button>',
  leads: '<button class="btn" data-pf="leads-csv">⬇ Export CSV</button><button class="btn primary" data-pf="new-lead">+ Lead</button>',
  lead: '<button class="btn" data-pf="leads-back">← All leads</button>',
};

const SUB_BADGE = { active: 'ok', trial: 'type', past_due: 'warn', cancelled: 'err', ended: '', pending: 'warn', declined: 'err', withdrawn: '' };
const SUB_WORD = { active: 'active', trial: 'trial', past_due: 'past due', cancelled: 'cancelled', ended: 'ended', pending: 'requested', declined: 'declined', withdrawn: 'withdrawn' };
const PAY_METHODS = ['Bank transfer', 'UPI', 'Card', 'Cash', 'Cheque', 'Other'];

const fmtDay = (d) => { const at = parseWhen(d); return at ? new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; };
const isoDay = (d) => { const at = d ? parseWhen(d) : Date.now(); return at ? new Date(at).toISOString().slice(0, 10) : ''; };
const monthWord = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleString(undefined, { month: 'short' }); };

/** Open one of the platform's pages from the side menu (or from a link inside it). */
function openPlatform(key = 'dashboard') {
  pf.tab = key;
  refreshLeadBadge();
  show('platform');
  if (!$('#pf-body').children.length) loadPlatform();
  else showPfTab(key);
}

async function loadPlatform() {
  if (session.user?.role !== 'super_admin') {
    $('#pf-actions').innerHTML = '';
    $('#pf-body').innerHTML = '<div class="empty">Only a super admin can see the platform.</div>';
    return;
  }
  pf.loaded = new Set();
  $('#pf-body').innerHTML = PF_TABS.map((t) => `
    <div class="tab-panel" data-panel="${t.key}" ${t.key === pf.tab ? '' : 'hidden'}>
      <div id="pf-panel-${t.key}"><div class="empty">Loading…</div></div>
    </div>`).join('');
  showPfTab(pf.tab);
}

function showPfTab(key, { reload = false } = {}) {
  const tab = PF_TABS.find((t) => t.key === key) || PF_TABS[0];
  pf.tab = tab.key;
  // One organisation still counts as Organisations in the side menu, one lead as Leads.
  const parent = { org: 'orgs', lead: 'leads' }[tab.key] || tab.key;
  if (parent === tab.key) pf.lastTab = tab.key;
  $$('#pf-body .tab-panel').forEach((p) => { p.hidden = p.dataset.panel !== tab.key; });
  pfChrome(tab);
  $('#pf-actions').innerHTML = `<button class="btn" data-pf="refresh">↻ Refresh</button>${PF_ACTIONS[tab.key] || ''}`;

  if (reload || !pf.loaded.has(tab.key)) {
    pf.loaded.add(tab.key);
    pfRun(tab);
  }
}

/** Whether a side-menu item stands for this platform page. Contact leads is the Leads page showing only the contact form. */
function pfNavIs(b, key) {
  const parent = { org: 'orgs', lead: 'leads' }[key] || key;
  if (b.dataset.pftab !== parent) return false;
  return parent !== 'leads' || (b.dataset.leadform || '') === (leadFilter.form === 'contact' ? 'contact' : '');
}

/** The page's title, its line underneath, the heading and which menu item is lit. */
function pfChrome(tab) {
  const parent = { org: 'orgs', lead: 'leads' }[tab.key] || tab.key;
  const contact = parent === 'leads' && leadFilter.form === 'contact';
  $$('.nav-item').forEach((b) => b.classList.toggle('active', pfNavIs(b, tab.key)));
  $('#pf-title').textContent = tab.key === 'org' ? (pf.detail?.organisation?.name || 'Organisation')
    : tab.key === 'lead' ? (pf.lead?.lead?.name || 'Lead')
    : contact ? 'Contact leads' : tab.label;
  $('#pf-sub').textContent = tab.key === 'org' ? 'Its plan, its people, and what it has paid.'
    : tab.key === 'leads' && contact ? 'Everyone who wrote in through the contact form — answer each one and move it along.' : tab.sub;
  setHeading(contact ? 'Contact leads' : PF_TABS.find((t) => t.key === parent).label);
}

async function pfRun(tab) {
  try {
    await tab.load();
  } catch (err) {
    pf.loaded.delete(tab.key);
    $(`#pf-panel-${tab.key}`).innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
  }
}

/** Something changed: whatever was read before is stale, and this page is read again. */
async function pfReload() {
  pf.loaded = new Set([pf.tab]);
  await pfRun(PF_TABS.find((t) => t.key === pf.tab));
}

/* ---------------------------------------------------------- charts */

/** A step that lands on 1, 2 or 5 of some power of ten. */
function niceStep(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

/**
 * One series over the months, as bars from a zero baseline: rounded at the
 * data end, a hover title per month, and only the latest value written out.
 */
function barChart(points, {
  format = (v) => String(v), integer = false, label = '',
  labelOf = (p) => monthWord(p.month), titleOf = (p) => `${monthWord(p.month)} ${p.month.slice(0, 4)}`,
} = {}) {
  // Close to the card's real width, so the 12px labels stay about 12px.
  const W = 440; const H = 190; const L = 48; const R = 8; const T = 20; const B = 26;
  const max = Math.max(0, ...points.map((p) => p.total));
  let step = niceStep(max / 4 || 0.25);
  if (integer) step = Math.max(1, Math.round(step));
  const top = Math.max(step, Math.ceil(max / step) * step);
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const slot = (W - L - R) / points.length;
  const bw = Math.min(28, slot * 0.56);

  const grid = [];
  for (let v = 0; v <= top + 1e-9; v += step) {
    grid.push(`<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="${v === 0 ? 'base' : ''}"/>
      <text x="${L - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${esc(format(v, true))}</text>`);
  }
  const bars = points.map((p, i) => {
    const cx = L + slot * i + slot / 2;
    const x = cx - bw / 2;
    const h = y(0) - y(p.total);
    const r = Math.min(4, bw / 2, h);
    const shape = h > 0.5
      ? `<path class="bar" d="M${x},${y(0)} V${y(p.total) + r} Q${x},${y(p.total)} ${x + r},${y(p.total)} H${x + bw - r} Q${x + bw},${y(p.total)} ${x + bw},${y(p.total) + r} V${y(0)} Z"/>`
      : '';
    const last = i === points.length - 1 && p.total > 0
      ? `<text class="val" x="${cx}" y="${(y(p.total) - 7).toFixed(1)}" text-anchor="middle">${esc(format(p.total))}</text>` : '';
    return `<g class="col"><title>${esc(`${titleOf(p)}: ${format(p.total)}`)}</title>
      <rect class="hit" x="${L + slot * i}" y="${T}" width="${slot}" height="${H - T - B}"/>${shape}${last}
      <text x="${cx}" y="${H - 8}" text-anchor="middle">${esc(labelOf(p))}</text></g>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}"><g class="grid">${grid.join('')}</g>${bars}</svg>`;
}

function chartCard(title, total, svg) {
  return `<div class="card chart-card"><div class="chart-head"><h3>${esc(title)}</h3><span class="muted small">${total}</span></div>${svg}</div>`;
}

/* -------------------------------------------------------- dashboard */

async function pfDashboard() {
  const d = await api('/platform/dashboard');
  const cur = d.currency;
  const m = (v) => fmtMoney(v, cur);
  const mShort = (v, axis) => fmtMoney(v, cur, { compact: axis || v >= 100000 });
  const r = d.revenue;
  const s = d.subscriptions;
  const o = d.organisations;
  const u = d.users;
  const x = d.resources;

  const change = r.lastMonth ? Math.round(((r.thisMonth - r.lastMonth) / r.lastMonth) * 100) : null;
  const changeWord = change === null ? (r.thisMonth ? 'nothing last month' : 'no payments yet')
    : `<span class="${change >= 0 ? 'up' : 'down'}">${change >= 0 ? '▲' : '▼'} ${Math.abs(change)}%</span> vs ${esc(m(r.lastMonth))} last month`;

  const sum = (arr) => arr.reduce((n, p) => n + p.total, 0);

  const mixMax = Math.max(0, ...s.byPlan.map((p) => p.mrr));
  const byMrr = mixMax > 0;
  const mixTop = byMrr ? mixMax : Math.max(1, ...s.byPlan.map((p) => p.subscribers));
  const mix = s.byPlan.length ? `<div class="card"><div class="hbars">${s.byPlan.map((p) => {
    const v = byMrr ? p.mrr : p.subscribers;
    return `<div class="hbar-row" title="${esc(`${p.name}: ${p.subscribers} subscriber(s), ${m(p.mrr)} a month`)}">
      <span class="hbar-label">${esc(p.name)}${p.status === 'archived' ? ' <span class="badge">archived</span>' : ''}</span>
      <span class="hbar-track"><span style="width:${v ? Math.max(2, (v / mixTop) * 100) : 0}%"></span></span>
      <span class="hbar-value"><b>${esc(m(p.mrr))}</b><span class="muted small"> · ${p.subscribers} org${p.subscribers === 1 ? '' : 's'}</span></span>
    </div>`;
  }).join('')}</div>${s.withoutPlan ? `<p class="muted small" style="margin:12px 0 0">${s.withoutPlan} organisation${s.withoutPlan === 1 ? ' has' : 's have'} no plan.</p>` : ''}</div>`
    : table([], [], 'No plans yet — create one on the Plans tab.');

  $('#pf-panel-dashboard').innerHTML = `
    ${d.mixedCurrencies ? `<div class="msg info">Subscriptions or payments use more than one currency; the totals below add them together as ${esc(cur)}.</div>` : ''}
    ${d.requests.length ? section(`Plan requests waiting for you (${d.requests.length})`, table(
      [{ label: 'Organisation' }, { label: 'Asked for' }, { label: 'Price', num: true }, { label: 'Requested' }, { label: '' }],
      d.requests.map((q) => [
        `<button class="link-btn" data-pf="org-view" data-id="${q.orgId}"><b>${esc(q.organisation)}</b></button>`,
        `${esc(q.plan)} <span class="muted small">${esc(q.cycle)}</span>`,
        `<span class="nowrap">${esc(fmtMoney(q.amount, q.currency))}</span>`,
        `<span class="nowrap">${esc(agoWords(q.requestedAt))}</span>`,
        `<div class="row-actions nowrap"><button class="btn tiny primary" data-pf="req-activate" data-id="${q.orgId}">Activate</button><button class="btn tiny" data-pf="req-decline" data-id="${q.orgId}">Decline</button></div>`,
      ])), ) : ''}
    ${section('Revenue', `<div class="tiles">
      ${tile('MRR', esc(m(r.mrr)), `${s.active} paying subscription${s.active === 1 ? '' : 's'}`)}
      ${tile('ARR', esc(m(r.arr)), 'MRR × 12')}
      ${tile('Collected this month', esc(m(r.thisMonth)), changeWord)}
      ${tile('Collected all time', esc(m(r.total)), `ARPA ${esc(m(r.arpa))} / month`)}
    </div>`)}
    ${section('Platform', `<div class="tiles">
      ${tile('Organisations', o.total, `${o.active} active · ${o.suspended} suspended · +${o.newThisMonth} this month`)}
      ${tile('Users', u.total, `${u.activeLast30} signed in within 30 days · ${u.superAdmins} super admin${u.superAdmins === 1 ? '' : 's'}`)}
      ${tile('Subscriptions', s.active + s.trial + s.pastDue, `${s.active} active · ${s.trial} trial · ${s.pastDue} past due`)}
      ${tile('Open leads', d.leads.open, `${d.leads.new} new · ${d.leads.thisMonth} this month`)}
      ${tile('Cancelled this month', s.cancelledThisMonth, `${s.withoutPlan} organisation${s.withoutPlan === 1 ? '' : 's'} without a plan`)}
    </div>`)}
    ${section('Everything under management', `<div class="tiles">
      ${tile('Servers', x.servers, `${x.serversOnline} online`, x.servers ? Math.round((x.serversOnline / x.servers) * 100) : null)}
      ${tile('Apps', x.apps, `${x.appsRunning} running`)}
      ${tile('Domains', x.domains, `${x.domainsLive} live`)}
      ${tile('Databases', x.databases, 'connections')}
      ${tile('Installations', x.installs, 'Docker, databases, runners')}
    </div>`)}
    ${section('Last 12 months', `<div class="chart-grid">
      ${chartCard('Revenue collected', esc(m(sum(r.byMonth))), barChart(r.byMonth, { format: (v, axis) => (axis ? mShort(v, true) : m(v)), label: 'Revenue collected per month' }))}
      ${chartCard('New organisations', `${sum(o.byMonth)} in 12 months`, barChart(o.byMonth, { integer: true, label: 'New organisations per month' }))}
      ${chartCard('New users', `${sum(u.byMonth)} in 12 months`, barChart(u.byMonth, { integer: true, label: 'New users per month' }))}
      <div class="chart-card-wrap"><h3 class="mix-title">Plan mix <span class="muted small">— monthly value by plan</span></h3>${mix}</div>
    </div>`)}
    <div class="grid pf-split">
      ${section('Recent payments', table(
        [{ label: 'Date' }, { label: 'Organisation' }, { label: 'Method' }, { label: 'Amount', num: true }],
        d.recentPayments.map((p) => [`<span class="nowrap">${esc(fmtDay(p.paidAt))}</span>`, esc(p.organisation), val(p.method), `<b class="nowrap">${esc(fmtMoney(p.amount, p.currency))}</b>`]),
        'No payments recorded yet.'))}
      ${section('Renewals in the next 14 days', table(
        [{ label: 'Organisation' }, { label: 'Plan' }, { label: 'Renews' }, { label: 'Amount', num: true }],
        d.renewing.map((p) => {
          const overdue = parseWhen(p.renewsAt) < Date.now();
          return [esc(p.org), `${esc(p.plan)} <span class="muted small">${esc(p.cycle)}</span>`,
            `<span class="badge ${overdue ? 'err' : 'warn'} nowrap">${overdue ? 'overdue · ' : ''}${esc(fmtDay(p.renewsAt))}</span>`,
            `<span class="nowrap">${esc(fmtMoney(p.amount, p.currency))}</span>`];
        }),
        'Nothing renews in the next two weeks.'))}
    </div>
    ${section('Largest organisations', table(
      [{ label: 'Organisation' }, { label: 'Plan' }, { label: 'Users', num: true }, { label: 'Servers', num: true }, { label: 'Apps', num: true }, { label: 'Paid', num: true }],
      o.top.map((g) => [
        `<b>${esc(g.name)}</b>${g.status === 'suspended' ? ' <span class="badge err">suspended</span>' : ''}`,
        g.subscription ? esc(g.subscription.plan) : '<span class="muted">no plan</span>',
        g.counts.users, g.counts.servers, g.counts.apps, `<span class="nowrap">${esc(m(g.paid))}</span>`,
      ]),
      'No organisations yet.'))}`;
}

/* ---------------------------------------------------- organisations */

async function pfOrganisations() {
  const r = await api('/platform/organisations');
  pf.orgs = r.organisations;
  pf.plans = r.plans;
  const el = $('#pf-panel-orgs');
  el.innerHTML = `
    <div class="section-head">
      <h2>${r.organisations.length} organisation${r.organisations.length === 1 ? '' : 's'}</h2>
      <div class="section-tools">
        <input type="search" id="pf-org-q" placeholder="Search organisations…" />
        <select id="pf-org-status"><option value="">Any status</option><option value="active">Active</option><option value="suspended">Suspended</option></select>
        <select id="pf-org-plan"><option value="">Any plan</option><option value="none">No plan</option><option value="requested">Plan requested</option>${r.plans.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
      </div>
    </div>
    <div id="pf-org-table"></div>`;
  const draw = () => {
    const q = $('#pf-org-q').value.trim().toLowerCase();
    const st = $('#pf-org-status').value;
    const pl = $('#pf-org-plan').value;
    const rows = pf.orgs.filter((o) => (!q || `${o.name} ${o.notes || ''}`.toLowerCase().includes(q))
      && (!st || o.status === st)
      && (!pl || (pl === 'none' ? !o.subscription : pl === 'requested' ? Boolean(o.request) : String(o.subscription?.planId) === pl)));
    $('#pf-org-table').innerHTML = table(
      [{ label: 'Organisation' }, { label: 'Plan' }, { label: 'MRR', num: true }, { label: 'Users', num: true }, { label: 'Resources' },
        { label: 'Paid', num: true }],
      rows.map((o) => {
        const sub = o.subscription;
        return [
          `<button class="link-btn" data-pf="org-view" data-id="${o.id}" title="${esc(`Created ${fmtDay(o.createdAt)} · ${o.lastActive ? `last sign-in ${agoWords(o.lastActive)}` : 'nobody has signed in yet'}`)}"><b>${esc(o.name)}</b></button>${o.status === 'suspended' ? ' <span class="badge err">suspended</span>' : ''}
            ${o.notes ? `<div class="muted small clamp-1">${esc(o.notes)}</div>` : ''}
            <div class="row-actions pf-org-actions">
            <button class="btn tiny" data-pf="org-view" data-id="${o.id}">View</button>
            <button class="btn tiny" data-pf="org-plan" data-id="${o.id}">Plan</button>
            <button class="btn tiny" data-pf="org-pay" data-id="${o.id}">+ Payment</button>
            <button class="btn tiny" data-pf="org-enter" data-id="${o.id}" title="Work inside this organisation, as its admin would">Open</button>
          </div>`,
          `${sub ? `<span class="nowrap">${esc(sub.plan)} <span class="badge ${SUB_BADGE[sub.status] || ''}">${esc(SUB_WORD[sub.status] || sub.status)}</span></span>
            <div class="muted small nowrap">${sub.amount ? `${esc(fmtMoney(sub.amount, sub.currency))} ${sub.cycle === 'yearly' ? 'a year' : 'a month'}` : 'free'}${sub.renewsAt ? ` · renews ${esc(fmtDay(sub.renewsAt))}` : ''}</div>`
            : '<span class="badge err">no plan</span>'}
            ${o.request ? requestLine(o) : ''}`,
          sub ? `<span class="nowrap">${esc(fmtMoney(sub.mrr, sub.currency))}</span>` : '—',
          `${o.counts.activeUsers}<span class="muted">/${o.counts.users}</span>`,
          `<div class="muted small nowrap">${o.counts.servers} servers · ${o.counts.apps} apps</div><div class="muted small nowrap">${o.counts.domains} domains · ${o.counts.databases} DBs</div>`,
          `<span class="nowrap">${esc(fmtMoney(o.paid, sub?.currency || 'INR'))}</span>`,
        ];
      }),
      pf.orgs.length ? 'No organisation matches.' : 'No organisations yet.'
    );
  };
  ['#pf-org-q', '#pf-org-status', '#pf-org-plan'].forEach((s) => $(s).addEventListener('input', draw));
  draw();
}

/** "Asked for Starter (monthly)" with the buttons that answer it. */
const requestLine = (o) => `<div class="request-line">
    <span class="badge warn nowrap">requested ${esc(o.request.plan)} · ${esc(o.request.cycle)}</span>
    <button class="btn tiny primary" data-pf="req-activate" data-id="${o.id}">Activate</button>
    <button class="btn tiny" data-pf="req-decline" data-id="${o.id}">Decline</button>
  </div>`;

/** The plans an organisation can be put on — read once, then kept. */
async function pfPlanList() {
  if (!pf.plans) pf.plans = (await api('/platform/organisations')).plans;
  return pf.plans;
}

const planOptions = (plans, selected, none = '') => `${none ? `<option value="">${esc(none)}</option>` : ''}${plans.map((p) =>
  `<option value="${p.id}" ${String(p.id) === String(selected) ? 'selected' : ''}>${esc(p.name)} — ${esc(fmtMoney(p.priceMonthly, p.currency))}/mo · ${esc(fmtMoney(p.priceYearly, p.currency))}/yr</option>`).join('')}`;

async function pfNewOrganisation() {
  const plans = await pfPlanList();
  openMyDialog({
    title: 'New organisation',
    intro: 'An organisation owns its servers, apps and credentials. Give it a first admin to hand it over straight away.',
    fields: `
      <label>Name<input name="name" required maxlength="120" placeholder="Acme Pvt Ltd" /></label>
      <label>Notes <span class="muted small">(optional — only super admins see these)</span><textarea name="notes" rows="2"></textarea></label>
      <div class="row">
        <label>Plan<select name="plan_id">${planOptions(plans, '', '— no plan yet —')}</select></label>
        <label class="narrow">Billing<select name="cycle"><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></label>
        <label class="narrow">Start as<select name="sub_status"><option value="active">Active</option><option value="trial">Trial</option></select></label>
      </div>
      <fieldset class="fieldset"><legend>First admin <span class="muted small">(optional)</span></legend>
        <div class="row">
          <label>Name<input name="admin_name" maxlength="120" /></label>
          <label>Email<input name="admin_email" type="email" autocomplete="off" /></label>
        </div>
        <div class="row">
          <label>Mobile number <span class="muted small">(required with an admin)</span><input name="admin_phone" type="tel" inputmode="tel" autocomplete="off" maxlength="32" placeholder="+91 98765 43210" /></label>
          <label>Password <span class="muted small">(10+ characters, letters and numbers)</span><input name="admin_password" type="password" autocomplete="new-password" /></label>
        </div>
      </fieldset>`,
    onOpen(form) {
      // Naming a first admin makes their number (and password) required too.
      const sync = () => { const on = Boolean(form.admin_email.value.trim()); form.admin_phone.required = on; form.admin_password.required = on; };
      form.admin_email.addEventListener('input', sync);
      sync();
    },
    submitLabel: 'Create organisation',
    async submit(fd) {
      const body = Object.fromEntries(fd.entries());
      await api('/platform/organisations', { method: 'POST', body });
      return `Created ${body.name}`;
    },
    after: pfAfterOrgChange,
  });
}

function pfEditOrganisation(o) {
  const own = o.id === session.user?.organisation?.id;
  openMyDialog({
    title: `Edit ${o.name}`,
    intro: 'Suspending an organisation keeps everything in it but stops its people from using the panel until it is reactivated.',
    fields: `
      <label>Name<input name="name" required maxlength="120" value="${esc(o.name)}" /></label>
      <label>Notes<textarea name="notes" rows="3">${esc(o.notes || '')}</textarea></label>
      <label>Status<select name="status" ${own ? 'disabled' : ''}>
        <option value="active" ${o.status === 'active' ? 'selected' : ''}>Active</option>
        <option value="suspended" ${o.status === 'suspended' ? 'selected' : ''}>Suspended — its people cannot sign in to it</option>
      </select></label>
      ${own ? '<p class="muted small">This is the organisation you are working in, so it cannot be suspended from here.</p>' : ''}`,
    submitLabel: 'Save',
    async submit(fd) {
      await api(`/platform/organisations/${o.id}`, { method: 'PUT', body: { name: fd.get('name'), notes: fd.get('notes'), status: fd.get('status') || o.status } });
      return `Saved ${fd.get('name')}`;
    },
    after: pfAfterOrgChange,
  });
}

async function pfSetPlan(o) {
  const plans = await pfPlanList();
  const sub = o.subscription;
  openMyDialog({
    title: `Plan for ${o.name}`,
    intro: sub
      ? `Now on <b>${esc(sub.plan)}</b> (${esc(sub.cycle)}, ${esc(SUB_WORD[sub.status] || sub.status)}). Saving starts a new subscription and ends this one.`
      : 'This organisation has no plan yet.',
    fields: `
      <label>Plan<select name="plan_id">${planOptions(plans, sub?.planId, sub ? '— no plan: cancel the subscription —' : '— pick a plan —')}</select></label>
      <div class="row">
        <label>Billing<select name="cycle"><option value="monthly" ${sub?.cycle !== 'yearly' ? 'selected' : ''}>Monthly</option><option value="yearly" ${sub?.cycle === 'yearly' ? 'selected' : ''}>Yearly</option></select></label>
        <label>Status<select name="status">
          ${['active', 'trial', 'past_due'].map((s) => `<option value="${s}" ${sub?.status === s ? 'selected' : ''}>${SUB_WORD[s]}</option>`).join('')}
        </select></label>
      </div>
      <div class="row">
        <label>Price <span class="muted small">(empty = plan price)</span><input name="amount" type="number" min="0" step="0.01" /></label>
        <label>Renews on<input name="renews_at" type="date" /></label>
      </div>
      <label>Notes<input name="notes" maxlength="255" placeholder="e.g. 20% launch discount" /></label>`,
    submitLabel: 'Save plan',
    onOpen(form) {
      const hint = () => {
        const p = plans.find((x) => String(x.id) === form.plan_id.value);
        const yearly = form.cycle.value === 'yearly';
        form.amount.placeholder = p ? String(yearly ? p.priceYearly : p.priceMonthly) : '';
        const d = new Date(Date.now() + (yearly ? 365 : 30) * 86400000);
        form.renews_at.placeholder = isoDay(d);
        if (!form.renews_at.dataset.touched) form.renews_at.value = isoDay(d);
        [form.cycle, form.status, form.amount, form.renews_at, form.notes].forEach((f) => { f.disabled = !p; });
      };
      form.renews_at.addEventListener('input', () => { form.renews_at.dataset.touched = '1'; });
      form.plan_id.addEventListener('change', hint);
      form.cycle.addEventListener('change', hint);
      hint();
    },
    async submit(fd) {
      if (!fd.get('plan_id')) {
        if (!sub) throw new Error('Pick a plan');
        if (!confirm(`Cancel the ${sub.plan} subscription of ${o.name}?`)) throw new Error('Nothing was changed');
        await api(`/platform/organisations/${o.id}/subscription`, { method: 'PUT', body: { cancel: true } });
        return `Cancelled the subscription of ${o.name}`;
      }
      await api(`/platform/organisations/${o.id}/subscription`, { method: 'PUT', body: Object.fromEntries(fd.entries()) });
      return `${o.name} is now on ${plans.find((p) => String(p.id) === fd.get('plan_id'))?.name}`;
    },
    after: pfReload,
  });
}

async function pfRecordPayment(org) {
  if (!pf.orgs) pf.orgs = (await api('/platform/organisations')).organisations;
  const orgs = pf.orgs;
  if (!orgs.length) return toast('Create an organisation first', 'err');
  const pick = org || orgs.find((o) => o.subscription) || orgs[0];
  openMyDialog({
    title: org ? `Payment from ${org.name}` : 'Record a payment',
    intro: 'The panel keeps the books; it does not take the money. Record what has been received.',
    fields: `
      <label>Organisation<select name="org_id" ${org ? 'disabled' : ''}>${orgs.map((o) => `<option value="${o.id}" ${o.id === pick.id ? 'selected' : ''}>${esc(o.name)}${o.subscription ? ` — ${esc(o.subscription.plan)}` : ''}</option>`).join('')}</select></label>
      <div class="row">
        <label>Amount<input name="amount" type="number" min="0.01" step="0.01" required /></label>
        <label class="narrow">Currency<input name="currency" maxlength="3" required style="text-transform:uppercase" /></label>
        <label>Received on<input name="paid_at" type="date" value="${isoDay()}" required /></label>
      </div>
      <div class="row">
        <label>Method<select name="method">${PAY_METHODS.map((x) => `<option>${x}</option>`).join('')}</select></label>
        <label>Reference <span class="muted small">(UTR, invoice no.)</span><input name="reference" maxlength="190" /></label>
      </div>
      <label>Notes<input name="notes" maxlength="500" /></label>
      <label class="check" id="pf-extend"><input type="checkbox" name="extend" checked /> <span>Mark the subscription active and move its renewal date on by one billing cycle</span></label>`,
    submitLabel: 'Record payment',
    onOpen(form) {
      const fill = () => {
        const o = orgs.find((x) => String(x.id) === form.org_id.value);
        form.amount.value = o?.subscription?.amount || '';
        form.currency.value = o?.subscription?.currency || 'INR';
        $('#pf-extend').classList.toggle('hidden', !o?.subscription);
        form.extend.checked = Boolean(o?.subscription);
      };
      form.org_id.addEventListener('change', fill);
      fill();
      form.amount.focus();
    },
    async submit(fd) {
      const id = org ? org.id : fd.get('org_id');
      const body = Object.fromEntries(fd.entries());
      body.extend = fd.has('extend');
      await api(`/platform/organisations/${id}/payments`, { method: 'POST', body });
      return `Recorded ${fmtMoney(body.amount, String(body.currency).toUpperCase())}`;
    },
    after: pfReload,
  });
}

async function pfEnterOrganisation(o) {
  try {
    const r = await api('/auth/organisation', { method: 'POST', body: { org_id: o.id } });
    session.user = r.user;
    applyIdentity();
    toast(`Now working in ${o.name}`);
    await enterApp({ keepOrgPicker: false });
  } catch (err) {
    toast(err.message, 'err');
  }
}

function pfDeleteOrganisation(o) {
  const c = o.counts;
  const held = [c.servers && `${c.servers} server(s)`, c.apps && `${c.apps} app(s)`, c.users && `${c.users} user(s)`].filter(Boolean);
  openMyDialog({
    title: `Delete ${o.name}?`,
    intro: held.length
      ? `It still holds ${esc(held.join(', '))}. An organisation can only be deleted once it is empty — move or remove those first.`
      : 'The organisation, its subscriptions and its payment records are deleted. This cannot be undone.',
    fields: `<label>Type the name to confirm<input name="confirm" autocomplete="off" placeholder="${esc(o.name)}" /></label>`,
    submitLabel: 'Delete organisation',
    danger: true,
    async submit(fd) {
      if (fd.get('confirm') !== o.name) throw new Error('The name does not match');
      await api(`/team/organisations/${o.id}`, { method: 'DELETE' });
      return `Deleted ${o.name}`;
    },
    after: async () => {
      pf.orgs = null;
      if (pf.tab !== 'org') return pfReload();
      pf.loaded.delete('orgs');
      openPlatform('orgs');
    },
  });
}

/* ------------------------------------------------------------ users */

async function pfUsers() {
  const [r, orgs] = await Promise.all([api('/platform/users'), pf.orgs ? { organisations: pf.orgs } : api('/platform/organisations')]);
  pf.users = r.users;
  pf.roles = r.roles;
  if (!pf.orgs) { pf.orgs = orgs.organisations; pf.plans = orgs.plans; }
  $('#pf-panel-users').innerHTML = `
    <div class="section-head">
      <h2>${r.users.length} user${r.users.length === 1 ? '' : 's'} across ${pf.orgs.length} organisation${pf.orgs.length === 1 ? '' : 's'}</h2>
      <div class="section-tools">
        <input type="search" id="pf-user-q" placeholder="Search name or email…" />
        <select id="pf-user-org"><option value="">Every organisation</option>${pf.orgs.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('')}</select>
        <select id="pf-user-role"><option value="">Any role</option>${r.roles.map((x) => `<option value="${esc(x.key)}">${esc(x.label)}</option>`).join('')}</select>
        <select id="pf-user-status"><option value="">Any status</option><option value="active">Active</option><option value="disabled">Disabled</option></select>
      </div>
    </div>
    <div id="pf-user-table"></div>`;
  const draw = () => {
    const q = $('#pf-user-q').value.trim().toLowerCase();
    const og = $('#pf-user-org').value;
    const rl = $('#pf-user-role').value;
    const st = $('#pf-user-status').value;
    const rows = pf.users.filter((x) => (!q || `${x.name} ${x.email}`.toLowerCase().includes(q))
      && (!og || String(x.orgId) === og) && (!rl || x.role === rl) && (!st || x.status === st));
    $('#pf-user-table').innerHTML = table(
      [{ label: 'Person' }, { label: 'Organisation' }, { label: 'Role' }, { label: 'Status' }, { label: 'Last sign-in' }, { label: '' }],
      rows.map((x) => [
        `<b title="${esc(`Joined ${fmtDay(x.createdAt)}`)}">${esc(x.name)}</b>${x.you ? ' <span class="badge type">you</span>' : ''}<div class="muted small">${esc(x.email)}</div>${x.phone ? `<div class="muted small">📱 ${esc(x.phone)}</div>` : ''}`,
        val(x.organisation),
        `<span class="badge ${x.role === 'super_admin' ? 'warn' : x.role === 'admin' ? 'type' : ''}">${esc(x.roleLabel)}</span>`,
        `<span class="badge ${x.status === 'active' ? 'ok' : 'err'}">${esc(x.status)}</span>`,
        `<span class="nowrap">${x.lastLoginAt ? esc(agoWords(x.lastLoginAt)) : '<span class="muted">never</span>'}</span>
          <div class="muted small nowrap">${x.sessions} open session${x.sessions === 1 ? '' : 's'}</div>`,
        `<div class="row-actions nowrap">
          <button class="btn tiny" data-pf="user-edit" data-id="${x.id}">Edit</button>
          <button class="btn tiny" data-pf="user-move" data-id="${x.id}">Move</button>
          ${x.you ? '' : `<button class="btn tiny danger" data-pf="user-delete" data-id="${x.id}">Remove</button>`}
        </div>`,
      ]),
      pf.users.length ? 'Nobody matches.' : 'No users yet.'
    );
  };
  ['#pf-user-q', '#pf-user-org', '#pf-user-role', '#pf-user-status'].forEach((s) => $(s).addEventListener('input', draw));
  draw();
}

function pfEditUser(x) {
  openMyDialog({
    title: `Edit ${x.name}`,
    intro: `${esc(x.email)} · ${esc(x.organisation || 'no organisation')}. A new role, a disabled account or a new password signs them out everywhere.`,
    fields: `
      <label>Name<input name="name" required maxlength="120" value="${esc(x.name)}" /></label>
      <div class="row">
        <label>Role<select name="role" ${x.you ? 'disabled' : ''}>${pf.roles.map((r) => `<option value="${esc(r.key)}" ${r.key === x.role ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}</select></label>
        <label>Status<select name="status" ${x.you ? 'disabled' : ''}><option value="active" ${x.status === 'active' ? 'selected' : ''}>Active</option><option value="disabled" ${x.status === 'disabled' ? 'selected' : ''}>Disabled</option></select></label>
      </div>
      ${PHONE_FIELD('phone', x.phone, PHONE_ROLES.includes(x.role))}
      <label>New password <span class="muted small">(leave empty to keep the current one)</span><input name="password" type="password" autocomplete="new-password" /></label>`,
    submitLabel: 'Save',
    onOpen(form) { phoneFollowsRole(form); },
    async submit(fd) {
      const body = { name: fd.get('name'), phone: fd.get('phone') };
      if (!x.you) { body.role = fd.get('role'); body.status = fd.get('status'); }
      if (fd.get('password')) body.password = fd.get('password');
      await api(`/team/members/${x.id}`, { method: 'PUT', body });
      return `Saved ${body.name}`;
    },
    after: pfReload,
  });
}

function pfMoveUser(x) {
  openMyDialog({
    title: `Move ${x.name}`,
    intro: `Now in <b>${esc(x.organisation || 'no organisation')}</b>. Their role stays the same; what they can see becomes the new organisation's.`,
    fields: `<label>Organisation<select name="org_id">${pf.orgs.map((o) => `<option value="${o.id}" ${o.id === x.orgId ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select></label>`,
    submitLabel: 'Move',
    async submit(fd) {
      if (Number(fd.get('org_id')) === x.orgId) throw new Error('They are already there');
      await api(`/platform/users/${x.id}/organisation`, { method: 'PUT', body: { org_id: fd.get('org_id') } });
      return `Moved ${x.name}`;
    },
    after: async () => { pf.orgs = null; await pfReload(); },
  });
}

function pfDeleteUser(x) {
  openMyDialog({
    title: `Remove ${x.name}?`,
    intro: `${esc(x.email)} loses access and their account is deleted. What they created stays with the organisation.`,
    fields: '',
    submitLabel: 'Remove',
    danger: true,
    async submit() {
      await api(`/team/members/${x.id}`, { method: 'DELETE' });
      return `Removed ${x.name}`;
    },
    after: pfReload,
  });
}

/* ------------------------------------------------------------ plans */

async function pfPlans() {
  const r = await api('/platform/plans');
  pf.allPlans = r.plans;
  pf.limitKeys = r.limitKeys;
  pf.plans = r.plans.filter((p) => p.status === 'active');
  const el = $('#pf-panel-plans');
  if (!r.plans.length) {
    el.innerHTML = `<div class="empty">No plans yet. Plans you mark as public appear in the Pricing section of the landing page, before sign-in.
      <div style="margin-top:14px"><button class="btn primary" data-pf="new-plan">+ Create the first plan</button></div></div>`;
    return;
  }
  el.innerHTML = `
    <p class="muted small" style="margin:0 0 14px">Active, public plans are shown on the landing page's Pricing section, in this order.</p>
    <div class="plan-grid">${r.plans.map((p) => `
      <div class="card plan-card ${p.highlighted ? 'featured' : ''} ${p.status === 'archived' ? 'archived' : ''}">
        <div class="plan-top">
          <h3>${esc(p.name)}</h3>
          <div class="chips">
            ${p.status === 'archived' ? '<span class="badge">archived</span>' : p.isPublic ? '<span class="badge ok">public</span>' : '<span class="badge">hidden</span>'}
            ${p.highlighted ? '<span class="badge type">highlighted</span>' : ''}
          </div>
        </div>
        ${p.tagline ? `<p class="muted small" style="margin:4px 0 0">${esc(p.tagline)}</p>` : ''}
        <div class="plan-price"><b>${esc(fmtMoney(p.priceMonthly, p.currency))}</b><span class="muted">/month</span>
          <span class="muted small">· ${esc(fmtMoney(p.priceYearly, p.currency))}/year</span></div>
        <ul class="plan-limits">${r.limitKeys.map((k) => `<li>${esc(limitLine(k, p.limits[k]))}</li>`).join('')}</ul>
        ${p.features.length ? `<ul class="plan-features">${p.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
        <p class="muted small plan-subs">${p.subscribers} organisation${p.subscribers === 1 ? '' : 's'} on this plan · order ${p.sortOrder}</p>
        <div class="card-actions">
          <button class="btn tiny" data-pf="plan-edit" data-id="${p.id}">Edit</button>
          ${p.status === 'archived'
            ? `<button class="btn tiny" data-pf="plan-restore" data-id="${p.id}">Restore</button>`
            : `<button class="btn tiny danger" data-pf="plan-delete" data-id="${p.id}">${p.subscribers ? 'Archive' : 'Delete'}</button>`}
        </div>
      </div>`).join('')}</div>`;
}

function planBody(fd, keepStatus) {
  const body = Object.fromEntries(fd.entries());
  body.highlighted = fd.has('highlighted') ? 'on' : 'off';
  body.is_public = fd.has('is_public') ? 'on' : 'off';
  if (keepStatus) body.status = keepStatus;
  return body;
}

function pfPlanDialog(p) {
  const keys = pf.limitKeys || Object.keys(LIMIT_WORDS);
  const lim = p?.limits || {};
  openMyDialog({
    title: p ? `Edit ${p.name}` : 'New plan',
    intro: 'Leave a limit empty for unlimited. Features are one per line and are shown as a ticked list on the pricing card.',
    fields: `
      <div class="row">
        <label>Name<input name="name" required maxlength="120" value="${esc(p?.name || '')}" placeholder="Starter" /></label>
        <label class="narrow">Order<input name="sort_order" type="number" step="1" value="${esc(p?.sortOrder ?? 0)}" /></label>
      </div>
      <label>Tagline<input name="tagline" maxlength="255" value="${esc(p?.tagline || '')}" placeholder="For a side project or a single server" /></label>
      <div class="row">
        <label>Monthly price<input name="price_monthly" type="number" min="0" step="0.01" required value="${esc(p?.priceMonthly ?? '')}" /></label>
        <label>Yearly price<input name="price_yearly" type="number" min="0" step="0.01" required value="${esc(p?.priceYearly ?? '')}" /></label>
        <label class="narrow">Currency<input name="currency" maxlength="3" required value="${esc(p?.currency || 'INR')}" style="text-transform:uppercase" /></label>
      </div>
      <fieldset class="fieldset"><legend>Limits</legend>
        <div class="limit-grid">${keys.map((k) => `<label>${esc(LIMIT_WORDS[k]?.[1] || k)}<input name="limit_${k}" type="number" min="0" step="1" placeholder="Unlimited" value="${esc(lim[k] ?? '')}" /></label>`).join('')}</div>
      </fieldset>
      <label>Features<textarea name="features" rows="5" placeholder="Free SSL on every domain&#10;Email support">${esc((p?.features || []).join('\n'))}</textarea></label>
      <div class="chips">
        <label class="check"><input type="checkbox" name="is_public" ${!p || p.isPublic ? 'checked' : ''} /> Show on the landing page</label>
        <label class="check"><input type="checkbox" name="highlighted" ${p?.highlighted ? 'checked' : ''} /> Highlight as “Most popular”</label>
      </div>`,
    submitLabel: p ? 'Save plan' : 'Create plan',
    onOpen(form) {
      // Ten months for a year is the usual deal; offered, never forced.
      form.price_monthly.addEventListener('input', () => {
        if (!form.price_yearly.dataset.touched) form.price_yearly.value = form.price_monthly.value ? String(Math.round(Number(form.price_monthly.value) * 10 * 100) / 100) : '';
      });
      form.price_yearly.addEventListener('input', () => { form.price_yearly.dataset.touched = '1'; });
      if (p) form.price_yearly.dataset.touched = '1';
    },
    async submit(fd) {
      const body = planBody(fd, p?.status);
      if (p) await api(`/platform/plans/${p.id}`, { method: 'PUT', body });
      else await api('/platform/plans', { method: 'POST', body });
      return `${p ? 'Saved' : 'Created'} ${body.name}`;
    },
    after: pfReload,
  });
}

async function pfPlanDelete(p) {
  const archive = p.subscribers > 0;
  if (!confirm(archive
    ? `Archive "${p.name}"? The ${p.subscribers} organisation(s) on it stay on it, but it is no longer sold or shown.`
    : `Delete "${p.name}"? Nobody has ever been on it.`)) return;
  try {
    const r = await api(`/platform/plans/${p.id}`, { method: 'DELETE' });
    toast(r.archived ? `Archived ${p.name}` : `Deleted ${p.name}`);
    await pfReload();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function pfPlanRestore(p) {
  try {
    await api(`/platform/plans/${p.id}`, { method: 'PUT', body: {
      name: p.name, tagline: p.tagline, price_monthly: p.priceMonthly, price_yearly: p.priceYearly, currency: p.currency,
      limits: p.limits, features: p.features, highlighted: p.highlighted, is_public: false, sort_order: p.sortOrder, status: 'active',
    } });
    toast(`Restored ${p.name} — it is hidden until you make it public`);
    await pfReload();
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* --------------------------------------------------------- payments */

async function pfPayments() {
  const r = await api('/platform/payments');
  pf.payments = r.payments;
  const orgNames = [...new Map(r.payments.map((p) => [p.orgId, p.organisation])).entries()];
  $('#pf-panel-payments').innerHTML = `
    <div class="tiles" id="pf-pay-tiles" style="margin-bottom:20px"></div>
    <div class="section-head">
      <h2>Payments</h2>
      <div class="section-tools">
        <input type="search" id="pf-pay-q" placeholder="Search reference, notes…" />
        <select id="pf-pay-org"><option value="">Every organisation</option>${orgNames.map(([id, n]) => `<option value="${id}">${esc(n)}</option>`).join('')}</select>
        <select id="pf-pay-method"><option value="">Any method</option>${PAY_METHODS.map((x) => `<option>${x}</option>`).join('')}</select>
      </div>
    </div>
    <div id="pf-pay-table"></div>`;
  const draw = () => {
    const q = $('#pf-pay-q').value.trim().toLowerCase();
    const og = $('#pf-pay-org').value;
    const me = $('#pf-pay-method').value;
    const rows = pf.payments.filter((p) => (!q || `${p.organisation} ${p.reference || ''} ${p.notes || ''} ${p.plan || ''}`.toLowerCase().includes(q))
      && (!og || String(p.orgId) === og) && (!me || p.method === me));
    const cur = rows[0]?.currency || 'INR';
    const total = rows.reduce((n, p) => n + p.amount, 0);
    const thisMonth = new Date().toISOString().slice(0, 7);
    const month = rows.filter((p) => isoDay(p.paidAt).startsWith(thisMonth)).reduce((n, p) => n + p.amount, 0);
    $('#pf-pay-tiles').innerHTML = [
      tile('Collected', esc(fmtMoney(total, cur)), og || me || q ? 'matching the filters' : 'all time'),
      tile('This month', esc(fmtMoney(month, cur)), new Date().toLocaleString(undefined, { month: 'long', year: 'numeric' })),
      tile('Payments', rows.length, rows.length ? `average ${esc(fmtMoney(Math.round(total / rows.length), cur))}` : ''),
    ].join('');
    $('#pf-pay-table').innerHTML = table(
      [{ label: 'Received' }, { label: 'Organisation' }, { label: 'Plan' }, { label: 'Method' }, { label: 'Reference' }, { label: 'Recorded by' }, { label: 'Amount', num: true }, { label: '' }],
      rows.map((p) => [
        `<span class="nowrap">${esc(fmtDay(p.paidAt))}</span>`,
        `<b>${esc(p.organisation)}</b>${p.notes ? `<div class="muted small clamp-1">${esc(p.notes)}</div>` : ''}`,
        val(p.plan), val(p.method), p.reference ? `<code>${esc(p.reference)}</code>` : '—', val(p.by),
        `<b class="nowrap">${esc(fmtMoney(p.amount, p.currency))}</b>`,
        `<div class="row-actions"><button class="btn tiny danger" data-pf="pay-delete" data-id="${p.id}">Delete</button></div>`,
      ]),
      pf.payments.length ? 'No payment matches.' : 'No payments recorded yet — use “+ Record payment”.'
    );
  };
  ['#pf-pay-q', '#pf-pay-org', '#pf-pay-method'].forEach((s) => $(s).addEventListener('input', draw));
  draw();
}

async function pfPaymentDelete(p) {
  if (!confirm(`Delete the payment of ${fmtMoney(p.amount, p.currency)} from ${p.organisation} (${fmtDay(p.paidAt)})?`)) return;
  try {
    await api(`/platform/payments/${p.id}`, { method: 'DELETE' });
    toast('Payment deleted');
    await pfReload();
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ---------------------------------------------- one organisation */

function pfOpenOrganisation(id) {
  pf.orgId = id;
  pf.detail = null;
  $('#pf-panel-org').innerHTML = '<div class="empty">Loading…</div>';
  showPfTab('org', { reload: true });
}

/** How much of each limit is used, as small meters. Unlimited shows as such. */
function usageMeters(usage, limits) {
  return `<div class="usage-grid">${Object.keys(LIMIT_WORDS).map((k) => {
    const used = usage[k] || 0;
    const cap = limits ? limits[k] : undefined;
    const unlimited = cap === undefined || cap === null;
    const p = unlimited ? 0 : cap ? Math.min(100, Math.round((used / cap) * 100)) : 100;
    return `<div class="usage-item">
      <div class="usage-top"><span>${esc(LIMIT_WORDS[k][1])}</span><b>${used}<span class="muted"> / ${unlimited ? '∞' : cap}</span></b></div>
      <div class="meter"><span class="${unlimited ? '' : meterClass(p)}" style="width:${unlimited ? 0 : p}%"></span></div>
    </div>`;
  }).join('')}</div>`;
}

async function pfOrgDetail() {
  if (!pf.orgId) return openPlatform('orgs');
  const d = await api(`/platform/organisations/${pf.orgId}`);
  const o = d.organisation;
  pf.detail = d;
  pf.roles = d.roles;
  // Dialogs shared with the Clients page look people up by id.
  d.users.forEach((u) => { u.orgId = o.id; u.organisation = o.name; u.you = false; });
  if (!pf.orgs) pf.orgs = (await api('/platform/organisations')).organisations;
  $('#pf-title').textContent = o.name;

  const sub = o.subscription;
  const cur = sub?.currency || 'INR';
  $('#pf-panel-org').innerHTML = `
    <div class="card org-hero">
      <div class="org-hero-main">
        <div class="chips">
          <span class="badge ${o.status === 'suspended' ? 'err' : 'ok'}">${esc(o.status)}</span>
          ${sub ? `<span class="badge ${SUB_BADGE[sub.status] || ''}">${esc(sub.plan)} · ${esc(SUB_WORD[sub.status] || sub.status)}</span>` : '<span class="badge err">no plan</span>'}
        </div>
        ${o.notes ? `<p class="muted" style="margin:10px 0 0">${esc(o.notes)}</p>` : ''}
        <p class="muted small" style="margin:8px 0 0">Created ${esc(fmtDay(o.createdAt))} · ${o.lastActive ? `last sign-in ${esc(agoWords(o.lastActive))}` : 'nobody has signed in yet'}</p>
      </div>
      <div class="row-actions">
        <button class="btn tiny" data-pf="org-edit" data-id="${o.id}">Edit</button>
        <button class="btn tiny" data-pf="org-plan" data-id="${o.id}">Change plan</button>
        <button class="btn tiny" data-pf="org-pay" data-id="${o.id}">+ Payment</button>
        <button class="btn tiny" data-pf="org-enter" data-id="${o.id}">Open as super admin</button>
        <button class="btn tiny danger" data-pf="org-delete" data-id="${o.id}">Delete</button>
      </div>
    </div>
    ${o.request ? `<div class="msg info request-msg">⏳ <b>${esc(o.name)}</b> asked for <b>${esc(o.request.plan)}</b> (${esc(o.request.cycle)}, ${esc(fmtMoney(o.request.amount, o.request.currency))}) ${esc(agoWords(o.request.requestedAt))}.
      <span class="row-actions" style="display:inline-flex;margin-left:8px"><button class="btn tiny primary" data-pf="req-activate" data-id="${o.id}">Activate</button><button class="btn tiny" data-pf="req-decline" data-id="${o.id}">Decline</button></span></div>` : ''}

    ${section('Plan', `<div class="tiles">
      ${tile('Plan', sub ? esc(sub.plan) : '—', sub ? `${sub.amount ? `${esc(fmtMoney(sub.amount, cur))} ${sub.cycle === 'yearly' ? 'a year' : 'a month'}` : 'free'}${sub.renewsAt ? ` · renews ${esc(fmtDay(sub.renewsAt))}` : ''}` : 'Nothing is usable until a plan is active')}
      ${tile('Monthly value', sub ? esc(fmtMoney(sub.mrr, cur)) : '—', sub ? `since ${esc(fmtDay(sub.startedAt))}` : '')}
      ${tile('Paid in total', esc(fmtMoney(o.paid, cur)), `${d.payments.length} payment${d.payments.length === 1 ? '' : 's'}`)}
      ${tile('Clients', o.counts.users, `${o.counts.activeUsers} active`)}
    </div>`)}
    ${section('Usage against the plan', `<div class="card">${usageMeters(d.usage, d.limits)}</div>`)}

    <div class="section">
      <div class="section-head"><h2>Clients in ${esc(o.name)}</h2>
        <div class="section-tools"><button class="btn tiny primary" data-pf="org-add-user" data-id="${o.id}">+ Client</button></div></div>
      ${table(
        [{ label: 'Person' }, { label: 'Role' }, { label: 'Status' }, { label: 'Last sign-in' }, { label: '' }],
        d.users.map((x) => [
          `<b>${esc(x.name)}</b><div class="muted small">${esc(x.email)}</div>${x.phone ? `<div class="muted small">📱 ${esc(x.phone)}</div>` : PHONE_ROLES.includes(x.role) ? '<div class="small" style="color:var(--warn)">📱 no mobile number</div>' : ''}`,
          `<span class="badge ${x.role === 'admin' ? 'type' : ''}">${esc(x.roleLabel)}</span>`,
          `<span class="badge ${x.status === 'active' ? 'ok' : 'err'}">${esc(x.status)}</span>`,
          `<span class="nowrap">${x.lastLoginAt ? esc(agoWords(x.lastLoginAt)) : '<span class="muted">never</span>'}</span>`,
          `<div class="row-actions nowrap">
            <button class="btn tiny" data-pf="user-edit" data-id="${x.id}">Edit</button>
            <button class="btn tiny" data-pf="user-move" data-id="${x.id}">Move</button>
            <button class="btn tiny danger" data-pf="user-delete" data-id="${x.id}">Remove</button>
          </div>`,
        ]),
        'Nobody here yet — add the client’s first admin with “+ Client”.'
      )}
    </div>

    <div class="grid pf-split">
      ${section('Plan history', table(
        [{ label: 'Plan' }, { label: 'Status' }, { label: 'From' }, { label: 'To' }, { label: 'Price', num: true }],
        d.history.map((h) => [
          `${esc(h.plan)} <span class="muted small">${esc(h.cycle)}</span>`,
          `<span class="badge ${SUB_BADGE[h.status] || ''}">${esc(SUB_WORD[h.status] || h.status)}</span>`,
          `<span class="nowrap">${esc(fmtDay(h.status === 'pending' ? h.createdAt : h.startedAt))}</span>`,
          `<span class="nowrap">${h.endedAt ? esc(fmtDay(h.endedAt)) : h.renewsAt ? `renews ${esc(fmtDay(h.renewsAt))}` : '—'}</span>`,
          `<span class="nowrap">${h.amount ? esc(fmtMoney(h.amount, h.currency)) : 'free'}</span>`,
        ]),
        'Never had a plan.'))}
      ${section('Payments', table(
        [{ label: 'Received' }, { label: 'Method' }, { label: 'Reference' }, { label: 'Amount', num: true }],
        d.payments.map((p) => [
          `<span class="nowrap">${esc(fmtDay(p.paidAt))}</span>`, val(p.method),
          p.reference ? `<code>${esc(p.reference)}</code>` : '—',
          `<b class="nowrap">${esc(fmtMoney(p.amount, p.currency))}</b>`,
        ]),
        'No payments recorded.'))}
    </div>`;
}

/** After a change to one organisation, whichever page is showing it is read again. */
async function pfAfterOrgChange() {
  pf.orgs = null;
  await pfReload();
}

async function pfRequest(id, activate) {
  const name = pf.orgs?.find((o) => o.id === id)?.name || pf.detail?.organisation?.name || 'this organisation';
  if (!activate && !confirm(`Decline the plan request of ${name}? Whatever it is on now stays as it is.`)) return;
  try {
    if (activate) await api(`/platform/organisations/${id}/subscription/activate`, { method: 'POST' });
    else await api(`/platform/organisations/${id}/subscription/request`, { method: 'DELETE' });
    toast(activate ? `Activated the plan for ${name}` : `Declined the request of ${name}`);
    await pfAfterOrgChange();
  } catch (err) {
    toast(err.message, 'err');
  }
}

/** In a dialog with a role picker, the mobile number is required exactly when the role is admin. */
function phoneFollowsRole(form) {
  const sync = () => {
    const needed = PHONE_ROLES.includes(form.role.value);
    form.phone.required = needed;
    const hint = form.phone.closest('label').querySelector('.muted');
    if (hint) hint.textContent = needed ? '(required for an admin — with country code)' : '(optional)';
  };
  form.role.addEventListener('change', sync);
  sync();
}

/** A new person in a client organisation — from its page (fixed) or from Clients (pick one). */
async function pfNewClient(orgId) {
  if (!pf.orgs) pf.orgs = (await api('/platform/organisations')).organisations;
  if (!pf.orgs.length) return toast('Create an organisation first', 'err');
  const roles = pf.roles?.length ? pf.roles : [{ key: 'admin', label: 'Admin' }, { key: 'editor', label: 'Editor' }, { key: 'viewer', label: 'Viewer' }];
  const fixed = orgId ? pf.orgs.find((o) => o.id === orgId) : null;
  openMyDialog({
    title: fixed ? `New client in ${fixed.name}` : 'New client',
    intro: 'An <b>admin</b> runs the organisation — its team and its plan. An <b>editor</b> can add and change things, a <b>viewer</b> only looks.',
    fields: `
      ${fixed ? '' : `<label>Organisation<select name="org_id">${pf.orgs.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('')}</select></label>`}
      <div class="row">
        <label>Name<input name="name" required maxlength="120" /></label>
        <label>Email<input name="email" type="email" required autocomplete="off" /></label>
      </div>
      <div class="row">
        <label>Role<select name="role">${roles.map((r) => `<option value="${esc(r.key)}" ${r.key === 'admin' ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}</select></label>
        <label>Password <span class="muted small">(10+ characters, letters and numbers)</span><input name="password" type="password" required autocomplete="new-password" /></label>
      </div>
      ${PHONE_FIELD('phone', '', true)}`,
    submitLabel: 'Add client',
    onOpen(form) { phoneFollowsRole(form); },
    async submit(fd) {
      const id = fixed ? fixed.id : fd.get('org_id');
      await api(`/platform/organisations/${id}/users`, { method: 'POST', body: Object.fromEntries(fd.entries()) });
      return `Added ${fd.get('name')}`;
    },
    after: pfAfterOrgChange,
  });
}

/* ------------------------------------------------------ super admins */

async function pfAdmins() {
  const r = await api('/platform/admins');
  pf.admins = r.admins;
  $('#pf-panel-admins').innerHTML = `
    <p class="muted small" style="margin:0 0 14px">Every super admin can see and change the whole platform. There is always at least one active, and nobody can disable or remove themselves.</p>
    ${table(
      [{ label: 'Super admin' }, { label: 'Status' }, { label: 'Last sign-in' }, { label: 'Added' }, { label: '' }],
      r.admins.map((a) => [
        `<b>${esc(a.name)}</b>${a.you ? ' <span class="badge type">you</span>' : ''}${a.fromEnv ? ' <span class="badge" title="Its password is set from .env on every restart">.env</span>' : ''}
          <div class="muted small">${esc(a.email)}</div>${a.phone ? `<div class="muted small">📱 ${esc(a.phone)}</div>` : '<div class="small" style="color:var(--warn)">📱 no mobile number yet</div>'}`,
        `<span class="badge ${a.status === 'active' ? 'ok' : 'err'}">${esc(a.status)}</span>`,
        `<span class="nowrap">${a.lastLoginAt ? esc(agoWords(a.lastLoginAt)) : '<span class="muted">never</span>'}</span>
          <div class="muted small nowrap">${a.sessions} open session${a.sessions === 1 ? '' : 's'}</div>`,
        `<span class="nowrap">${esc(fmtDay(a.createdAt))}</span>${a.createdBy ? `<div class="muted small nowrap">by ${esc(a.createdBy)}</div>` : ''}`,
        `<div class="row-actions nowrap">
          <button class="btn tiny" data-pf="admin-edit" data-id="${a.id}">Edit</button>
          ${a.you ? '' : `<button class="btn tiny danger" data-pf="admin-delete" data-id="${a.id}">Remove</button>`}
        </div>`,
      ]),
      'No super admins.'
    )}`;
}

function pfAdminDialog(a) {
  openMyDialog({
    title: a ? `Edit ${a.name}` : 'New super admin',
    intro: a
      ? `${a.fromEnv ? 'This account comes from <code>.env</code>: its password is set from <code>SUPER_ADMIN_PASSWORD</code> on every restart, so a password changed here lasts until then. ' : ''}A new password or a disabled account signs them out everywhere.`
      : 'A super admin runs the whole platform — every organisation, client, plan and payment. Give this only to people you trust with all of it.',
    fields: `
      <div class="row">
        <label>Name<input name="name" required maxlength="120" value="${esc(a?.name || '')}" /></label>
        <label>Email<input name="email" type="email" required autocomplete="off" value="${esc(a?.email || '')}" /></label>
      </div>
      ${PHONE_FIELD('phone', a?.phone, true)}
      ${a ? `<label>Status<select name="status" ${a.you ? 'disabled' : ''}><option value="active" ${a.status === 'active' ? 'selected' : ''}>Active</option><option value="disabled" ${a.status === 'disabled' ? 'selected' : ''}>Disabled — cannot sign in</option></select></label>` : ''}
      <label>${a ? 'New password <span class="muted small">(leave empty to keep the current one)</span>' : 'Password <span class="muted small">(10+ characters, letters and numbers)</span>'}
        <input name="password" type="password" ${a ? '' : 'required'} autocomplete="new-password" /></label>`,
    submitLabel: a ? 'Save' : 'Create super admin',
    async submit(fd) {
      const body = Object.fromEntries(fd.entries());
      if (!body.password) delete body.password;
      if (a) await api(`/platform/admins/${a.id}`, { method: 'PUT', body });
      else await api('/platform/admins', { method: 'POST', body });
      return `${a ? 'Saved' : 'Created'} ${body.name}`;
    },
    after: pfReload,
  });
}

function pfAdminDelete(a) {
  openMyDialog({
    title: `Remove ${a.name}?`,
    intro: `${esc(a.email)} will no longer be able to sign in, and the account is deleted.${a.fromEnv ? ' It is set in <code>.env</code>, so it comes back on the next restart unless you remove it there too.' : ''}`,
    fields: '',
    submitLabel: 'Remove super admin',
    danger: true,
    async submit() {
      await api(`/platform/admins/${a.id}`, { method: 'DELETE' });
      return `Removed ${a.name}`;
    },
    after: pfReload,
  });
}

/* ------------------------------------------------------------ leads */

const LEAD_BADGE = { new: 'type', contacted: 'warn', qualified: 'warn', proposal: 'warn', won: 'ok', lost: 'err' };
const LEAD_WORD = { new: 'New', contacted: 'Contacted', qualified: 'Qualified', proposal: 'Proposal sent', won: 'Won', lost: 'Lost' };
const NOTE_ICON = { note: '📝', call: '📞', email: '✉️', meeting: '🤝', status: '🔁' };
const leadFilter = { status: '', q: '', source: '', plan: '', country: '', type: '', form: '', owner: '', days: '', unique: false };

const leadBadge = (s) => `<span class="badge ${LEAD_BADGE[s] || ''}">${esc(LEAD_WORD[s] || s)}</span>`;

/** The number of new leads, on the Leads item in the side menu. */
async function refreshLeadBadge() {
  if (session.user?.role !== 'super_admin') return;
  try {
    const r = await api('/platform/leads/summary');
    const el = $('#nav-leads-badge');
    el.textContent = r.new > 99 ? '99+' : String(r.new);
    el.hidden = !r.new;
    el.title = `${r.new} new lead${r.new === 1 ? '' : 's'} waiting`;
    const c = $('#nav-contact-badge');
    const n = r.newContact || 0;
    c.textContent = n > 99 ? '99+' : String(n);
    c.hidden = !n;
    c.title = `${n} new contact-form lead${n === 1 ? '' : 's'} waiting`;
  } catch { /* the badge is a nicety */ }
}
setInterval(() => { if (document.body.classList.contains('platform-mode')) refreshLeadBadge(); }, 60000);

/** "🇮🇳 Ahmedabad, Gujarat" — or "Local network" for a visitor on this server's own network. */
function placeOf(geo, { short = false } = {}) {
  if (!geo) return '';
  const where = short
    ? [geo.city, geo.countryCode || geo.country].filter(Boolean).join(', ')
    : [geo.city, geo.region, geo.country || geo.countryCode].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(', ');
  return `${geo.flag ? `${geo.flag} ` : ''}${where || 'Unknown place'}`;
}

/** The columns the leads table can show; which ones are on is remembered in this browser. */
const LEAD_COLUMNS = [
  { key: 'interest', label: 'Interested in', on: true },
  { key: 'source', label: 'Source', on: true },
  { key: 'status', label: 'Status', on: true },
  { key: 'owner', label: 'Owner', on: true },
  { key: 'location', label: 'Location', on: true },
  { key: 'system', label: 'OS & browser', on: true },
  { key: 'device', label: 'Device', on: false },
  { key: 'ip', label: 'IP address', on: false },
  { key: 'isp', label: 'Internet provider', on: false },
  { key: 'visitor', label: 'Visits', on: false },
  { key: 'value', label: 'Value', on: false },
  { key: 'received', label: 'Received', on: true },
];
const LEAD_COLS_KEY = 'ad-lead-columns';
function leadColumns() {
  try {
    const saved = JSON.parse(localStorage.getItem(LEAD_COLS_KEY) || 'null');
    if (Array.isArray(saved)) return LEAD_COLUMNS.filter((c) => saved.includes(c.key));
  } catch { /* storage blocked */ }
  return LEAD_COLUMNS.filter((c) => c.on);
}

const LEAD_CELL = {
  interest: (l) => `${l.plan ? `${esc(l.plan)}${l.cycle ? ` <span class="muted small">${esc(l.cycle)}</span>` : ''}` : '<span class="muted">Not sure yet</span>'}
    ${l.servers ? `<div class="muted small">${esc(l.servers)} server${l.servers === '1' ? '' : 's'}</div>` : ''}`,
  source: (l) => `<span class="nowrap">${esc(l.source)}</span>${l.utm.campaign ? `<div class="muted small clamp-1">${esc(l.utm.campaign)}</div>` : ''}`,
  status: (l) => `${leadBadge(l.status)}${l.notes ? `<div class="muted small">${l.notes} note${l.notes === 1 ? '' : 's'}</div>` : ''}`,
  owner: (l) => (l.assignee ? esc(l.assignee) : '<span class="muted">—</span>'),
  location: (l) => (l.geo ? `<span class="nowrap">${esc(placeOf(l.geo, { short: true }))}</span>${l.geo.local ? '<div class="muted small">same network as server</div>' : ''}` : '<span class="muted">—</span>'),
  system: (l) => (l.system.os !== 'Unknown' ? `<span class="nowrap">${esc(l.system.os)}</span><div class="muted small nowrap">${esc(l.system.browser)}${l.system.browserMajor ? ` ${esc(l.system.browserMajor)}` : ''}</div>` : '<span class="muted">—</span>'),
  device: (l) => `<span class="nowrap">${deviceIcon(l.system.type)} ${esc(l.system.type)}</span>${l.device?.screen?.width ? `<div class="muted small nowrap">${Math.round(l.device.screen.width * (l.device.screen.pixelRatio || 1))}×${Math.round(l.device.screen.height * (l.device.screen.pixelRatio || 1))}</div>` : ''}`,
  ip: (l) => (l.ip ? `<code>${esc(l.ip)}</code>` : '<span class="muted">—</span>'),
  isp: (l) => (l.geo?.isp ? `<span class="clamp-1">${esc(l.geo.isp)}</span>` : '<span class="muted">—</span>'),
  visitor: (l) => (l.visit ? `${l.visit.visits || 1} visit${l.visit.visits === 1 ? '' : 's'}${l.visit.firstSeen ? `<div class="muted small nowrap">since ${esc(fmtDay(l.visit.firstSeen))}</div>` : ''}` : '<span class="muted">—</span>'),
  value: (l) => (l.value ? `<span class="nowrap">${esc(fmtMoney(l.value))}</span>` : '<span class="muted">—</span>'),
  received: (l) => `<span class="nowrap" title="${esc(fmtDay(l.createdAt))}">${esc(agoWords(l.createdAt))}</span>`,
};

async function pfLeads() {
  const r = await api('/platform/leads');
  pf.leads = r.leads;
  pf.leadMeta = r;
  const counts = Object.fromEntries(r.statuses.map((s) => [s, r.leads.filter((l) => l.status === s).length]));
  const sources = [...new Set(r.leads.map((l) => l.source))].sort();
  const countries = [...new Map(r.leads.filter((l) => l.geo?.countryCode).map((l) => [l.geo.countryCode, `${l.geo.flag || ''} ${l.geo.country || l.geo.countryCode}`.trim()])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const types = [...new Set(r.leads.map((l) => l.system.type))].sort();
  const cols = leadColumns();
  $('#pf-panel-leads').innerHTML = `
    <div class="pipeline-chips" id="lead-chips">
      <button class="chip-btn ${leadFilter.status === '' ? 'active' : ''}" data-status="">All <b>${r.leads.length}</b></button>
      ${r.statuses.map((s) => `<button class="chip-btn ${leadFilter.status === s ? 'active' : ''}" data-status="${s}">${esc(LEAD_WORD[s])} <b>${counts[s]}</b></button>`).join('')}
    </div>
    <div class="section-head">
      <h2 id="lead-count"></h2>
      <div class="section-tools">
        <input type="search" id="lead-q" placeholder="Search name, email, company, IP, city…" value="${esc(leadFilter.q)}" />
        <select id="lead-source"><option value="">Any source</option>${sources.map((x) => `<option ${leadFilter.source === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>
        <select id="lead-plan"><option value="">Any plan</option><option value="none" ${leadFilter.plan === 'none' ? 'selected' : ''}>Not sure yet</option>${r.plans.map((p) => `<option value="${p.id}" ${String(leadFilter.plan) === String(p.id) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
        <select id="lead-country"><option value="">Any country</option>${countries.map(([cc, label]) => `<option value="${esc(cc)}" ${leadFilter.country === cc ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>
        <select id="lead-form"><option value="">Any form</option>${[['contact', 'Contact form'], ['pricing', 'Pricing buttons'], ['hero', 'Get started buttons'], ['manual', 'Added by hand']].map(([v, t]) => `<option value="${v}" ${leadFilter.form === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
        <select id="lead-type"><option value="">Any device</option>${types.map((t) => `<option ${leadFilter.type === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
        <select id="lead-owner"><option value="">Anyone</option><option value="none" ${leadFilter.owner === 'none' ? 'selected' : ''}>Unassigned</option>${r.admins.map((a) => `<option value="${a.id}" ${String(leadFilter.owner) === String(a.id) ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>
        <select id="lead-days"><option value="">All time</option>${[['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days']].map(([v, t]) => `<option value="${v}" ${leadFilter.days === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
        <label class="check tiny-check"><input type="checkbox" id="lead-unique" ${leadFilter.unique ? 'checked' : ''} /> One row per person</label>
        <div class="col-menu">
          <button class="btn tiny" type="button" id="btn-lead-cols" aria-haspopup="true">⚙ Columns</button>
          <div class="menu-pop hidden" id="lead-cols-pop" role="menu">
            <div class="menu-title">Show columns</div>
            ${LEAD_COLUMNS.map((c) => `<label class="menu-check-row"><input type="checkbox" value="${c.key}" ${cols.some((x) => x.key === c.key) ? 'checked' : ''} /> ${esc(c.label)}</label>`).join('')}
          </div>
        </div>
      </div>
    </div>
    <div id="lead-table"></div>`;

  const draw = () => {
    leadFilter.q = $('#lead-q').value.trim();
    leadFilter.source = $('#lead-source').value;
    leadFilter.plan = $('#lead-plan').value;
    leadFilter.country = $('#lead-country').value;
    leadFilter.type = $('#lead-type').value;
    if (leadFilter.form !== $('#lead-form').value) {
      leadFilter.form = $('#lead-form').value;
      if (pf.tab === 'leads') pfChrome(PF_TABS.find((t) => t.key === 'leads'));
    }
    leadFilter.owner = $('#lead-owner').value;
    leadFilter.days = $('#lead-days').value;
    leadFilter.unique = $('#lead-unique').checked;
    const q = leadFilter.q.toLowerCase();
    const since = leadFilter.days ? Date.now() - Number(leadFilter.days) * 86400000 : 0;
    let rows = pf.leads.filter((l) => (!leadFilter.status || l.status === leadFilter.status)
      && (!q || [l.name, l.email, l.company, l.phone, l.message, l.ip, l.geo?.city, l.geo?.region, l.geo?.country, l.geo?.isp, l.system.os, l.system.browser]
        .filter(Boolean).join(' ').toLowerCase().includes(q))
      && (!leadFilter.source || l.source === leadFilter.source)
      && (!leadFilter.plan || (leadFilter.plan === 'none' ? !l.planId : String(l.planId) === leadFilter.plan))
      && (!leadFilter.country || l.geo?.countryCode === leadFilter.country)
      && (!leadFilter.type || l.system.type === leadFilter.type)
      && (!leadFilter.form || l.form === leadFilter.form)
      && (!leadFilter.owner || (leadFilter.owner === 'none' ? !l.assignedTo : String(l.assignedTo) === leadFilter.owner))
      && (!since || parseWhen(l.createdAt) >= since));
    // One row per person: their latest enquiry stands for them.
    if (leadFilter.unique) {
      const seen = new Set();
      rows = rows.filter((l) => (seen.has(l.person) ? false : seen.add(l.person)));
    }
    pf.leadRows = rows;
    const peopleShown = new Set(rows.map((l) => l.person)).size;
    const value = rows.filter((l) => !['won', 'lost'].includes(l.status)).reduce((n, l) => n + (l.value || 0), 0);
    $('#lead-count').textContent = `${rows.length} lead${rows.length === 1 ? '' : 's'} · ${peopleShown} unique ${peopleShown === 1 ? 'person' : 'people'}${value ? ` · ${fmtMoney(value)} a month in play` : ''}`;
    const shown = leadColumns();
    $('#lead-table').innerHTML = table(
      [{ label: 'Lead' }, ...shown.map((c) => ({ label: c.label, num: c.key === 'value' }))],
      rows.map((l) => [
        `<button class="link-btn" data-pf="lead-view" data-id="${l.id}"><b>${esc(l.name)}</b></button>${l.company ? ` <span class="muted small">· ${esc(l.company)}</span>` : ''}
          ${l.personLeads > 1 ? ` <span class="badge warn" title="The same person (same email, browser or computer) sent ${l.personLeads} enquiries">×${l.personLeads}</span>` : ''}
          <div class="muted small">${esc(l.email)}${l.phone ? ` · ${esc(l.phone)}` : ''}</div>`,
        ...shown.map((c) => LEAD_CELL[c.key](l)),
      ]),
      pf.leads.length ? 'No lead matches these filters.' : 'No leads yet. They arrive from the “Get started” form on the public page.'
    );
  };
  ['#lead-q', '#lead-source', '#lead-plan', '#lead-country', '#lead-type', '#lead-form', '#lead-owner', '#lead-days', '#lead-unique'].forEach((sel) => $(sel).addEventListener('input', draw));
  $('#lead-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-status]');
    if (!b) return;
    leadFilter.status = b.dataset.status;
    $$('#lead-chips .chip-btn').forEach((x) => x.classList.toggle('active', x === b));
    draw();
  });
  // The column menu: tick what to see; it stays that way in this browser.
  const pop = $('#lead-cols-pop');
  $('#btn-lead-cols').addEventListener('click', (e) => { e.stopPropagation(); pop.classList.toggle('hidden'); });
  pop.addEventListener('click', (e) => e.stopPropagation());
  pop.addEventListener('change', () => {
    const keys = $$('input', pop).filter((i) => i.checked).map((i) => i.value);
    try { localStorage.setItem(LEAD_COLS_KEY, JSON.stringify(keys)); } catch { /* storage blocked: this view only */ }
    draw();
  });
  draw();
  refreshLeadBadge();
}
document.addEventListener('click', () => $('#lead-cols-pop')?.classList.add('hidden'));

/** The leads on screen, as a spreadsheet. */
function exportLeadsCsv() {
  const rows = pf.leadRows || pf.leads || [];
  const cols = [['Received', (l) => l.createdAt], ['Name', (l) => l.name], ['Email', (l) => l.email], ['Phone', (l) => l.phone],
    ['Company', (l) => l.company], ['Servers', (l) => l.servers], ['Plan', (l) => l.plan], ['Cycle', (l) => l.cycle],
    ['Status', (l) => l.status], ['Value / month', (l) => l.value], ['Owner', (l) => l.assignee], ['Source', (l) => l.source],
    ['UTM source', (l) => l.utm.source], ['UTM medium', (l) => l.utm.medium], ['UTM campaign', (l) => l.utm.campaign],
    ['Form', (l) => l.form], ['Operating system', (l) => [l.system.os, l.system.osVersion].filter(Boolean).join(' ')],
    ['Browser', (l) => [l.system.browser, l.system.browserVersion].filter(Boolean).join(' ')], ['Device', (l) => l.system.type],
    ['Screen', (l) => (l.device?.screen?.width ? `${l.device.screen.width}x${l.device.screen.height}` : '')],
    ['Timezone', (l) => l.device?.timezone], ['IP', (l) => l.ip],
    ['City', (l) => l.geo?.city], ['Region', (l) => l.geo?.region], ['Country', (l) => l.geo?.country || l.geo?.countryCode],
    ['Internet provider', (l) => l.geo?.isp], ['Latitude', (l) => l.geo?.latitude], ['Longitude', (l) => l.geo?.longitude],
    ['Browser ID', (l) => l.visitorId], ['Fingerprint', (l) => l.fingerprint], ['Visits', (l) => l.visit?.visits],
    ['Enquiries from this person', (l) => l.personLeads], ['Message', (l) => l.message], ['Lost reason', (l) => l.lostReason], ['Client', (l) => l.organisation]];
  const cell = (v) => { const t = String(v ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const csv = [cols.map(([h]) => h).join(','), ...rows.map((l) => cols.map(([, f]) => cell(f(l))).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
  a.download = `leads-${isoDay()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/**
 * Chrome wraps the card's name in its renderer details —
 * "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)" —
 * so the vendor prefix, device id and API are peeled off to leave "Intel(R) Iris(R) Xe Graphics".
 */
function gpuName(raw) {
  const m = /^ANGLE \((.*)\)$/.exec(String(raw).trim());
  if (!m) return raw;
  let name = m[1].replace(/^[^,]+,\s*/, '');
  name = name.replace(/^ANGLE Metal Renderer:\s*/i, '');
  name = name.replace(/\s*\(0x[0-9a-f]+\).*$/i, '').replace(/\s+(Direct3D|OpenGL|Vulkan|Metal)\b.*$/i, '').replace(/,\s*Unspecified Version$/i, '');
  return name.trim() || raw;
}

const deviceIcon = (type) => ({ Phone: '📱', Tablet: '📱', Desktop: '💻', 'Bot / script': '🤖' }[type] || '💻');

/** Everything the visitor's browser said about their computer, in plain words. */
function deviceCard(l) {
  const d = l.device || {};
  const sys = l.system || {};
  const sc = d.screen || {};
  const vp = d.viewport || {};
  const cn = d.connection || {};
  const offset = (m) => (m === undefined || m === null ? '' : ` (UTC${m >= 0 ? '+' : '−'}${String(Math.floor(Math.abs(m) / 60)).padStart(2, '0')}:${String(Math.abs(m) % 60).padStart(2, '0')})`);
  const yes = (v) => (v === undefined ? undefined : v ? 'Yes' : 'No');
  const rows = [
    ['Operating system', `<b>${esc(sys.os)}</b>${sys.osVersion ? ` <span class="muted small">version ${esc(sys.osVersion)}</span>` : ''}`],
    ['Browser', `<b>${esc(sys.browser)}</b>${sys.browserVersion ? ` <span class="muted small">${esc(sys.browserVersion)}</span>` : ''}`],
    ['Device', `${deviceIcon(sys.type)} ${esc(sys.type)}${sys.model ? ` · ${esc(sys.model)}` : ''}`],
    ['Processor', [sys.arch, d.cpuCores ? `${d.cpuCores} logical cores` : ''].filter(Boolean).map(esc).join(' · ') || undefined],
    ['Memory', d.memoryGb ? `about ${d.memoryGb} GB <span class="muted small">(as the browser rounds it)</span>` : undefined],
    ['Graphics', d.gpu ? `<span title="${esc(d.gpu)}">${esc(gpuName(d.gpu))}</span>` : undefined],
    ['Screen', sc.width ? `${sc.pixelRatio && sc.pixelRatio !== 1
      ? `${Math.round(sc.width * sc.pixelRatio)} × ${Math.round(sc.height * sc.pixelRatio)} <span class="muted small">at ${Math.round(sc.pixelRatio * 100)}% scaling</span>`
      : `${sc.width} × ${sc.height}`}${sc.colorDepth ? ` · ${sc.colorDepth}-bit colour` : ''}` : undefined],
    ['Browser window', vp.width ? `${vp.width} × ${vp.height}` : undefined],
    ['Touch screen', d.touchPoints !== undefined ? (d.touchPoints > 0 ? `Yes (${d.touchPoints} points)` : 'No') : undefined],
    ['Language', d.languages?.length ? esc(d.languages.join(', ')) : d.language ? esc(d.language) : undefined],
    ['Timezone', d.timezone ? `${esc(d.timezone)}${offset(d.tzOffset)}` : undefined],
    ['Theme', d.colorScheme ? `${esc(d.colorScheme)} mode${d.reducedMotion ? ' · reduced motion' : ''}` : undefined],
    ['Connection', cn.type ? `${esc(cn.type)}${cn.downlink ? ` · ~${cn.downlink} Mbps` : ''}${cn.rtt ? ` · ${cn.rtt} ms` : ''}${cn.saveData ? ' · data saver' : ''}` : undefined],
    ['Cookies enabled', yes(d.cookies)],
    ['Do not track', d.doNotTrack === '1' ? 'On' : d.doNotTrack ? 'Off' : undefined],
    ['User agent', l.userAgent ? `<code class="break">${esc(l.userAgent)}</code>` : undefined],
  ].filter(([, v]) => v !== undefined && v !== '');
  const note = l.device ? '' : '<p class="muted small" style="margin:0 0 10px">This lead came in before full device details were collected — only its user-agent is known.</p>';
  return `<div class="card">${note}<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl></div>`;
}

/** Where their connection is: place, network, a map link, and whether it agrees with their clock. */
function locationCard(l) {
  const g = l.geo;
  const tzBrowser = l.device?.timezone;
  const rows = [['IP address', l.ip ? `<code>${esc(l.ip)}</code>${g?.local && g.ip ? ` <span class="muted small">→ public ${esc(g.ip)}</span>` : ''}${g?.type ? ` <span class="muted small">${esc(g.type)}</span>` : ''}` : '—']];
  if (g) {
    rows.push(
      ['Place', `<b>${esc(placeOf(g))}</b>`],
      ['City', g.city ? esc(g.city) : undefined],
      ['Region / state', g.region ? esc(g.region) : undefined],
      ['Country', g.country || g.countryCode ? `${g.flag ? `${g.flag} ` : ''}${esc(g.country || g.countryCode)}${g.countryCode ? ` <span class="muted small">(${esc(g.countryCode)})</span>` : ''}${g.isEu ? ' <span class="badge">EU</span>' : ''}` : undefined],
      ['Continent', g.continent ? esc(g.continent) : undefined],
      ['Postal code', g.postal ? esc(g.postal) : undefined],
      ['Calling code', g.callingCode ? `+${esc(g.callingCode)}` : undefined],
      ['Coordinates', Number.isFinite(g.latitude) && Number.isFinite(g.longitude)
        ? `${g.latitude.toFixed(4)}, ${g.longitude.toFixed(4)} · <a href="https://www.openstreetmap.org/?mlat=${g.latitude}&mlon=${g.longitude}#map=11/${g.latitude}/${g.longitude}" target="_blank" rel="noopener">Open map ↗</a> <span class="muted small">(approximate — the connection, not the person)</span>` : undefined],
      ['Internet provider', g.isp ? esc(g.isp) : undefined],
      ['Organisation', g.org && g.org !== g.isp ? esc(g.org) : undefined],
      ['Network (ASN)', g.asn ? `AS${esc(g.asn)}${g.domain ? ` · ${esc(g.domain)}` : ''}` : undefined],
      ['Timezone of the IP', g.timezone ? `${esc(g.timezone)}${g.utcOffset ? ` (UTC${esc(g.utcOffset)})` : ''}` : undefined],
      ['Looked up', `${esc(g.source)} · ${esc(agoWords(g.at))}`],
    );
  }
  const vpn = g?.timezone && tzBrowser && g.timezone !== tzBrowser
    && !(g.timezone.replace('Kolkata', 'Calcutta') === tzBrowser.replace('Kolkata', 'Calcutta'));
  return `<div class="card">
    ${g?.local ? '<p class="muted small" style="margin:0 0 10px">This enquiry came from the same network as the server, so the location is that of the shared internet connection.</p>' : ''}
    ${vpn ? `<div class="msg info" style="margin:0 0 12px">⚠ Their computer's clock says <b>${esc(tzBrowser)}</b> but the IP address is in <b>${esc(g.timezone)}</b> — they may be using a VPN or proxy, or travelling.</div>` : ''}
    ${!g ? `<p class="muted small" style="margin:0 0 10px">${l.ip ? 'The location has not been looked up yet.' : 'No IP address was recorded.'}</p>` : ''}
    <dl class="kv">${rows.filter(([, v]) => v !== undefined).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>
    ${l.ip ? `<div style="margin-top:12px"><button class="btn tiny" data-pf="lead-locate" data-id="${l.id}">${g ? '↻ Look up again' : '📍 Look up location'}</button></div>` : ''}
  </div>`;
}

/** How they found their way to the form, and what ties their enquiries together. */
function visitorCard(l) {
  const v = l.visit;
  const secs = v?.secondsOnPage;
  const rows = [
    ['Browser ID', l.visitorId ? `<code>${esc(l.visitorId)}</code>` : '<span class="muted">not recorded</span>'],
    ['Device fingerprint', l.fingerprint ? `<code title="${esc(l.fingerprint)}">${esc(l.fingerprint.slice(0, 16))}…</code>` : '<span class="muted">not recorded</span>'],
    ['First visit', v?.firstSeen ? `${esc(fmtDay(v.firstSeen))} <span class="muted small">(${esc(agoWords(v.firstSeen))})</span>` : undefined],
    ['Visits before enquiring', v?.visits ? String(v.visits) : undefined],
    ['Time on the page', secs ? (secs < 60 ? `${secs} seconds` : `${Math.floor(secs / 60)} min ${secs % 60} s`) : undefined],
    ['First came from', v?.firstReferrer ? `<span class="break">${esc(v.firstReferrer)}</span>` : v ? 'Direct visit' : undefined],
    ['Enquiries from this person', l.personLeads ? String(l.personLeads) : undefined],
  ];
  return `<div class="card"><dl class="kv">${rows.filter(([, x]) => x !== undefined).map(([k, x]) => `<dt>${esc(k)}</dt><dd>${x}</dd>`).join('')}</dl>
    <p class="muted small" style="margin:10px 0 0">The browser ID is a random number the site keeps in their browser; the fingerprint is a one-way hash of their computer's details. Either one matching another lead means it is very likely the same person.</p></div>`;
}

/** Every detail of a lead as plain text — for pasting into an email, a CRM or a chat. */
function leadAsText(d) {
  const l = d.lead;
  const g = l.geo || {};
  const dv = l.device || {};
  const sc = dv.screen || {};
  const line = (k, v) => (v === undefined || v === null || v === '' ? null : `${k}: ${v}`);
  return [
    `Lead #${l.id} — ${l.name}`,
    line('Status', LEAD_WORD[l.status]), line('Email', l.email), line('Phone', l.phone), line('Company', l.company),
    line('Servers', l.servers), line('Interested in', l.plan ? `${l.plan} (${l.cycle})` : 'Not sure yet'), line('Value / month', l.value),
    line('Owner', l.assignee), line('Received', fmtDay(l.createdAt)), line('Message', l.message),
    '', '— Source',
    line('Source', l.source), line('Form', l.form), line('Campaign', l.utm.campaign), line('UTM source / medium', [l.utm.source, l.utm.medium].filter(Boolean).join(' / ')),
    line('Referrer', l.referrer), line('Landing page', l.landingPath),
    '', '— Location',
    line('IP address', l.ip), line('Place', [g.city, g.region, g.country || g.countryCode].filter(Boolean).join(', ')), line('Coordinates', Number.isFinite(g.latitude) ? `${g.latitude}, ${g.longitude}` : null),
    line('Internet provider', g.isp), line('Network', g.asn ? `AS${g.asn}` : null), line('IP timezone', g.timezone),
    '', '— Computer',
    line('Operating system', [l.system.os, l.system.osVersion].filter(Boolean).join(' ')), line('Browser', [l.system.browser, l.system.browserVersion].filter(Boolean).join(' ')),
    line('Device', l.system.type), line('Processor', [l.system.arch, dv.cpuCores ? `${dv.cpuCores} cores` : ''].filter(Boolean).join(', ')),
    line('Memory', dv.memoryGb ? `about ${dv.memoryGb} GB` : null), line('Graphics', dv.gpu ? gpuName(dv.gpu) : null),
    line('Screen', sc.width ? `${Math.round(sc.width * (sc.pixelRatio || 1))}×${Math.round(sc.height * (sc.pixelRatio || 1))}` : null),
    line('Language', (dv.languages || []).join(', ')), line('Timezone', dv.timezone), line('User agent', l.userAgent),
    '', '— Visitor',
    line('Browser ID', l.visitorId), line('Fingerprint', l.fingerprint), line('First visit', l.visit?.firstSeen ? fmtDay(l.visit.firstSeen) : null),
    line('Visits', l.visit?.visits), line('Seconds on page', l.visit?.secondsOnPage),
    d.others.length ? `Possibly the same person as: ${d.others.map((o) => `#${o.id} ${o.name} (${o.why.join(', ')})`).join('; ')}` : null,
  ].filter((x) => x !== null).join('\n');
}

function pfOpenLead(id) {
  pf.leadId = id;
  pf.lead = null;
  $('#pf-panel-lead').innerHTML = '<div class="empty">Loading…</div>';
  showPfTab('lead', { reload: true });
}

async function pfLeadDetail() {
  if (!pf.leadId) return openPlatform('leads');
  const d = await api(`/platform/leads/${pf.leadId}`);
  pf.lead = d;
  const l = d.lead;
  l.personLeads = 1 + d.others.filter((o) => o.why.some((w) => w !== 'same IP address')).length;
  $('#pf-title').textContent = l.name;
  $('#pf-sub').textContent = [l.company, `lead #${l.id}`, `received ${fmtDay(l.createdAt)}`].filter(Boolean).join(' · ');

  const digits = (l.phone || '').replace(/[^\d+]/g, '');
  const stepIndex = ['new', 'contacted', 'qualified', 'proposal', 'won'].indexOf(l.status);
  const kv = (pairs) => `<dl class="kv">${pairs.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;

  $('#pf-panel-lead').innerHTML = `
    <div class="card lead-hero">
      <div class="lead-hero-main">
        <div class="chips">${leadBadge(l.status)}${l.geo ? `<span class="badge">${esc(placeOf(l.geo, { short: true }))}</span>` : ''}${l.value ? `<span class="badge">${esc(fmtMoney(l.value))} / month</span>` : ''}${l.status === 'lost' && l.lostReason ? `<span class="badge err">${esc(l.lostReason)}</span>` : ''}</div>
        <div class="lead-contact">
          <a class="btn tiny" href="mailto:${esc(l.email)}">✉️ ${esc(l.email)}</a>
          ${l.phone ? `<a class="btn tiny" href="tel:${esc(digits)}">📞 ${esc(l.phone)}</a>` : ''}
          ${digits.replace('+', '').length >= 8 ? `<a class="btn tiny" href="https://wa.me/${esc(digits.replace('+', ''))}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
        </div>
      </div>
      <div class="row-actions">
        ${l.orgId ? `<button class="btn tiny" data-pf="org-view" data-id="${l.orgId}">Open client: ${esc(l.organisation)}</button>`
          : `<button class="btn tiny primary" data-pf="lead-convert" data-id="${l.id}">Convert to client</button>`}
        <button class="btn tiny" data-pf="lead-edit" data-id="${l.id}">Edit</button>
        <button class="btn tiny" data-pf="lead-copy" data-id="${l.id}" title="Copy every detail as text">⧉ Copy details</button>
        <button class="btn tiny" data-pf="lead-json" data-id="${l.id}" title="Download every detail as JSON">⬇ JSON</button>
        <button class="btn tiny danger" data-pf="lead-delete" data-id="${l.id}">Delete</button>
      </div>
    </div>

    <div class="stepper" role="group" aria-label="Lead status">
      ${['new', 'contacted', 'qualified', 'proposal', 'won'].map((s, i) => `
        <button class="step ${l.status === s ? 'current' : ''} ${l.status !== 'lost' && i < stepIndex ? 'done' : ''}" data-pf="lead-status" data-status="${s}" data-id="${l.id}">
          <span class="step-dot">${l.status !== 'lost' && i < stepIndex ? '✓' : i + 1}</span>${esc(LEAD_WORD[s])}</button>`).join('')}
      <button class="step lost ${l.status === 'lost' ? 'current' : ''}" data-pf="lead-status" data-status="lost" data-id="${l.id}"><span class="step-dot">✕</span>Lost</button>
    </div>

    <div class="lead-layout">
      <div>
        ${section('Details', `<div class="card">${kv([
          ['Email', `<a href="mailto:${esc(l.email)}">${esc(l.email)}</a>`],
          ['Phone', l.phone ? esc(l.phone) : '—'],
          ['Company', val(l.company)],
          ['Servers', l.servers ? esc(l.servers) : '—'],
          ['Interested in', l.plan ? `${esc(l.plan)}${l.cycle ? ` (${esc(l.cycle)})` : ''}` : 'Not sure yet'],
          ['Value', l.value ? `${esc(fmtMoney(l.value))} a month` : '—'],
          ['Owner', `<select id="lead-owner-pick" data-id="${l.id}" class="inline-select"><option value="">Unassigned</option>${d.admins.map((a) => `<option value="${a.id}" ${a.id === l.assignedTo ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>`],
          ['Received', `${esc(fmtDay(l.createdAt))} <span class="muted small">(${esc(agoWords(l.createdAt))})</span>`],
          ['First contact', l.contactedAt ? `${esc(fmtDay(l.contactedAt))} <span class="muted small">· ${esc(duration((parseWhen(l.contactedAt) - parseWhen(l.createdAt)) / 1000))} after</span>` : '<span class="badge warn">not yet</span>'],
          ['Closed', l.closedAt ? esc(fmtDay(l.closedAt)) : undefined],
        ])}</div>`)}
        ${l.message ? section('Their message', `<div class="card lead-message">${esc(l.message)}</div>`) : ''}
        ${section('Where they came from', `<div class="card">${kv([
          ['Source', `<b>${esc(l.source)}</b>`],
          ['Form', esc(l.form)],
          ['Campaign', l.utm.campaign ? esc(l.utm.campaign) : undefined],
          ['UTM source / medium', l.utm.source || l.utm.medium ? `${val(l.utm.source)} / ${val(l.utm.medium)}` : undefined],
          ['UTM term', l.utm.term ? esc(l.utm.term) : undefined],
          ['UTM content', l.utm.content ? esc(l.utm.content) : undefined],
          ['Referrer', l.referrer ? `<span class="break">${esc(l.referrer)}</span>` : 'Direct visit'],
          ['Landing page', l.landingPath ? `<code>${esc(l.landingPath)}</code>` : undefined],
        ])}</div>`)}
        ${section('Location & network', locationCard(l))}
        ${section('Their computer & system', deviceCard(l))}
        ${section('Visitor', visitorCard(l))}
        ${section(`Same person? ${d.others.length ? `(${d.others.length})` : ''}`, d.others.length
          ? table([{ label: 'Lead' }, { label: 'Why it matches' }, { label: 'Status' }, { label: 'Received' }],
            d.others.map((o) => [
              `<button class="link-btn" data-pf="lead-view" data-id="${o.id}"><b>${esc(o.name)}</b></button><div class="muted small">${esc(o.email)} · #${o.id}</div>`,
              o.why.map((w) => `<span class="badge ${w === 'same IP address' ? '' : 'warn'}">${esc(w)}</span>`).join(' '),
              leadBadge(o.status), `<span class="nowrap">${esc(fmtDay(o.createdAt))}</span>`]))
          : '<div class="card"><p class="muted small" style="margin:0">No other enquiry shares this email, browser, computer or IP address — a unique lead.</p></div>')}
      </div>

      <div>
        ${section('Timeline', `
          <form class="card note-form" id="lead-note-form">
            <div class="note-kinds">${['note', 'call', 'email', 'meeting'].map((k, i) => `<label class="check"><input type="radio" name="kind" value="${k}" ${i === 0 ? 'checked' : ''} /> ${NOTE_ICON[k]} ${k[0].toUpperCase()}${k.slice(1)}</label>`).join('')}</div>
            <textarea name="body" rows="3" maxlength="5000" placeholder="What happened? e.g. Called — wants a demo on Friday, 3 servers on Hetzner" required></textarea>
            <div class="note-form-foot"><span class="muted small">A call, email or meeting marks a new lead as contacted.</span><button class="btn primary tiny" type="submit">Add to timeline</button></div>
          </form>
          <ol class="timeline">
            ${d.notes.map((n) => `<li class="tl-item tl-${esc(n.kind)}">
              <span class="tl-icon">${NOTE_ICON[n.kind] || '•'}</span>
              <div class="tl-body">
                <div class="tl-head"><b>${esc(n.kind === 'status' ? 'Update' : n.kind[0].toUpperCase() + n.kind.slice(1))}</b>
                  <span class="muted small">${esc(n.by || 'the website')} · <span title="${esc(fmtDay(n.createdAt))}">${esc(agoWords(n.createdAt))}</span></span>
                  ${n.kind !== 'status' ? `<button class="icon-x" data-pf="note-delete" data-id="${n.id}" title="Delete this note" aria-label="Delete note">✕</button>` : ''}</div>
                <p>${esc(n.body)}</p>
              </div></li>`).join('')}
            <li class="tl-item tl-created"><span class="tl-icon">✨</span><div class="tl-body"><div class="tl-head"><b>Lead received</b>
              <span class="muted small">${esc(fmtDay(l.createdAt))} · ${esc(l.form)} form · ${esc(l.source)}</span></div></div></li>
          </ol>`)}
      </div>
    </div>`;

  $('#lead-note-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const btn = e.submitter;
    busy(btn, true, 'Adding…');
    try {
      await api(`/platform/leads/${l.id}/notes`, { method: 'POST', body: { kind: fd.get('kind'), body: fd.get('body') } });
      await pfAfterLeadChange();
    } catch (err) {
      toast(err.message, 'err');
      busy(btn, false);
    }
  });
  $('#lead-owner-pick').addEventListener('change', async (e) => {
    try {
      await api(`/platform/leads/${l.id}`, { method: 'PUT', body: { assigned_to: e.target.value || null } });
      toast('Owner updated');
      await pfAfterLeadChange();
    } catch (err) { toast(err.message, 'err'); }
  });
}

async function pfAfterLeadChange() {
  pf.loaded = new Set([pf.tab]);
  await pfRun(PF_TABS.find((t) => t.key === pf.tab));
  refreshLeadBadge();
}

async function pfLeadStatus(id, status) {
  const l = pf.lead?.lead;
  if (!l || l.status === status) return;
  if (status === 'lost') {
    return openMyDialog({
      title: `Mark ${l.name} as lost`,
      intro: 'Saying why helps the Lead analysis page show where leads are being lost.',
      fields: `<label>Reason<select name="lost_reason">${['Too expensive', 'Chose another product', 'No reply', 'Not a fit', 'Timing — maybe later', 'Other'].map((r) => `<option>${r}</option>`).join('')}</select></label>`,
      submitLabel: 'Mark as lost',
      danger: true,
      async submit(fd) {
        await api(`/platform/leads/${id}`, { method: 'PUT', body: { status: 'lost', lost_reason: fd.get('lost_reason') } });
        return `${l.name} marked as lost`;
      },
      after: pfAfterLeadChange,
    });
  }
  if (status === 'won' && !l.orgId && confirm(`${l.name} is won. Create their client organisation and account now?`)) return pfConvertLead(l);
  try {
    await api(`/platform/leads/${id}`, { method: 'PUT', body: { status } });
    toast(`${l.name}: ${LEAD_WORD[status]}`);
    await pfAfterLeadChange();
  } catch (err) { toast(err.message, 'err'); }
}

function pfLeadDialog(l) {
  const meta = pf.lead || pf.leadMeta;
  const plans = meta?.plans || [];
  openMyDialog({
    title: l ? `Edit ${l.name}` : 'New lead',
    intro: l ? '' : 'Someone who called, wrote or was referred — add them here to track them with the rest.',
    fields: `
      <div class="row">
        <label>Name<input name="name" required maxlength="190" value="${esc(l?.name || '')}" /></label>
        <label>Email<input name="email" type="email" required maxlength="190" value="${esc(l?.email || '')}" /></label>
      </div>
      <div class="row">
        <label>Phone<input name="phone" maxlength="40" value="${esc(l?.phone || '')}" /></label>
        <label>Company<input name="company" maxlength="190" value="${esc(l?.company || '')}" /></label>
      </div>
      <div class="row">
        <label>Servers<select name="servers"><option value="">—</option>${['1', '2-5', '6-20', '20+'].map((x) => `<option ${l?.servers === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
        <label>Plan<select name="plan_id"><option value="">Not sure yet</option>${plans.map((p) => `<option value="${p.id}" ${l?.planId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
        <label class="narrow">Billing<select name="cycle"><option value="monthly">Monthly</option><option value="yearly" ${l?.cycle === 'yearly' ? 'selected' : ''}>Yearly</option></select></label>
      </div>
      <div class="row">
        <label>Value <span class="muted small">(expected, per month)</span><input name="value" type="number" min="0" step="0.01" value="${esc(l?.value ?? '')}" /></label>
        ${l ? '' : '<label>Source<input name="source" maxlength="60" placeholder="e.g. referral, phone, event" /></label>'}
      </div>
      ${l ? '' : '<label>Notes<textarea name="message" rows="3" maxlength="5000"></textarea></label>'}`,
    submitLabel: l ? 'Save' : 'Add lead',
    async submit(fd) {
      const body = Object.fromEntries(fd.entries());
      if (l) await api(`/platform/leads/${l.id}`, { method: 'PUT', body });
      else {
        const r = await api('/platform/leads', { method: 'POST', body });
        pf.leadId = r.id;
      }
      return l ? 'Lead saved' : `Added ${body.name}`;
    },
    after: async () => { if (l) await pfAfterLeadChange(); else pfOpenLead(pf.leadId); },
  });
}

async function pfConvertLead(l) {
  const plans = pf.lead?.plans || [];
  openMyDialog({
    title: `Make ${l.name} a client`,
    intro: 'Creates their organisation and an admin account for them to sign in with, optionally on a plan, and marks the lead as won. Send them the password yourself.',
    fields: `
      <label>Organisation name<input name="name" required maxlength="120" value="${esc(l.company || l.name)}" /></label>
      <div class="row">
        <label>Admin name<input name="admin_name" required value="${esc(l.name)}" /></label>
        <label>Admin email<input name="admin_email" type="email" required value="${esc(l.email)}" /></label>
      </div>
      ${PHONE_FIELD('admin_phone', l.phone, true)}
      <label>Password for them <span class="muted small">(10+ characters, letters and numbers)</span><input name="admin_password" type="text" required autocomplete="off" /></label>
      <div class="row">
        <label>Plan<select name="plan_id"><option value="">No plan yet — they choose</option>${plans.map((p) => `<option value="${p.id}" ${p.id === l.planId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
        <label class="narrow">Billing<select name="cycle"><option value="monthly">Monthly</option><option value="yearly" ${l.cycle === 'yearly' ? 'selected' : ''}>Yearly</option></select></label>
        <label class="narrow">Start as<select name="sub_status"><option value="active">Active</option><option value="trial">Trial</option></select></label>
      </div>`,
    submitLabel: 'Create client',
    onOpen(form) {
      // A readable starting password they can change later.
      const words = ['Cloud', 'Deploy', 'Server', 'Rocket', 'Harbor', 'Summit'];
      form.admin_password.value = `${words[Math.floor(Math.random() * words.length)]}${Math.floor(1000 + Math.random() * 9000)}${words[Math.floor(Math.random() * words.length)].toLowerCase()}`;
    },
    async submit(fd) {
      await api(`/platform/leads/${l.id}/convert`, { method: 'POST', body: Object.fromEntries(fd.entries()) });
      return `${l.name} is now a client`;
    },
    after: async () => { pf.orgs = null; await pfAfterLeadChange(); },
  });
}

function pfLeadDelete(l) {
  openMyDialog({
    title: `Delete the lead ${l.name}?`,
    intro: 'The lead and its whole timeline are deleted. A client organisation made from it stays.',
    fields: '',
    submitLabel: 'Delete lead',
    danger: true,
    async submit() {
      await api(`/platform/leads/${l.id}`, { method: 'DELETE' });
      return `Deleted ${l.name}`;
    },
    after: async () => { pf.loaded.delete('leads'); openPlatform('leads'); refreshLeadBadge(); },
  });
}

/* ----------------------------------------------------- lead analysis */

/** One bar per row, longest first; the value is written out beside it. */
function hbarList(rows, { value = (r) => String(r.count), extra = () => '', empty = 'Nothing yet.' } = {}) {
  const max = Math.max(0, ...rows.map((r) => r.count));
  if (!max) return `<div class="card"><p class="muted small" style="margin:0">${esc(empty)}</p></div>`;
  return `<div class="card"><div class="hbars">${rows.map((r) => `
    <div class="hbar-row" title="${esc(`${r.name}: ${value(r)}`)}">
      <span class="hbar-label">${esc(r.label || r.name)}</span>
      <span class="hbar-track"><span style="width:${r.count ? Math.max(2, (r.count / max) * 100) : 0}%"></span></span>
      <span class="hbar-value"><b>${esc(value(r))}</b>${extra(r)}</span>
    </div>`).join('')}</div></div>`;
}

async function pfLeadStats() {
  const a = await api('/platform/leads/analytics');
  const t = a.totals;
  const change = t.lastMonth ? Math.round(((t.thisMonth - t.lastMonth) / t.lastMonth) * 100) : null;
  const hours = (h) => (h === null ? '—' : h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`);
  const top = a.funnel[0]?.count || 0;

  $('#pf-panel-leadstats').innerHTML = !t.all ? '<div class="empty">No leads yet. Once the “Get started” form on the public page starts bringing them in, this page shows where they come from and how many become clients.</div>' : `
    ${t.unanswered ? `<div class="msg info request-msg">⏰ <b>${t.unanswered}</b> new lead${t.unanswered === 1 ? ' has' : 's have'} waited more than a day for a reply.
      <button class="btn tiny" data-pf="leads-new">Show them</button></div>` : ''}
    ${section('Overview', `<div class="tiles">
      ${tile('Leads this month', t.thisMonth, change === null ? `${t.lastMonth} last month` : `<span class="${change >= 0 ? 'up' : 'down'}">${change >= 0 ? '▲' : '▼'} ${Math.abs(change)}%</span> vs ${t.lastMonth} last month`)}
      ${tile('Open pipeline', t.open, `${esc(fmtMoney(t.pipelineValue))} a month in play`)}
      ${tile('Conversion rate', t.conversionRate === null ? '—' : `${t.conversionRate}%`, `${t.won} won · ${t.lost} lost`)}
      ${tile('Won this month', t.wonThisMonth, `${esc(fmtMoney(t.wonValue))} a month won in total`)}
      ${tile('Time to first reply', hours(t.medianReplyHours), 'median')}
      ${tile('Time to win', t.medianDaysToWin === null ? '—' : `${Math.round(t.medianDaysToWin)} days`, 'median, from enquiry to won')}
      ${tile('All leads', t.all, `${t.new} still new`)}
      ${tile('Unique people', a.people.unique, `${a.people.repeat} came back more than once`)}
      ${tile('Visits before enquiring', a.people.medianVisits === null ? '—' : a.people.medianVisits, a.people.medianSecondsOnPage ? `median · ${Math.round(a.people.medianSecondsOnPage)} s on the page` : 'median')}
    </div>`)}
    <div class="chart-grid">
      ${chartCard('Leads per month', `${a.byMonth.reduce((n, m) => n + m.total, 0)} in 12 months`, barChart(a.byMonth, { integer: true, label: 'Leads per month' }))}
      ${chartCard('Clients won per month', `${a.byMonth.reduce((n, m) => n + m.won, 0)} in 12 months`, barChart(a.byMonth.map((m) => ({ month: m.month, total: m.won })), { integer: true, label: 'Leads won per month' }))}
    </div>
    <div class="chart-grid" style="margin-top:16px">
      <div>${section('Funnel — how far leads get', hbarList(a.funnel.map((f) => ({ name: f.stage, label: LEAD_WORD[f.stage], count: f.count })), {
        extra: (r) => `<span class="muted small"> · ${top ? Math.round((r.count / top) * 100) : 0}%</span>`,
      }))}</div>
      <div>${section('Where leads come from', hbarList(a.bySource, {
        extra: (r) => `<span class="muted small"> · ${r.won} won${r.rate === null ? '' : ` (${r.rate}%)`}</span>`,
      }))}</div>
      <div>${section('Plan they are interested in', hbarList(a.byPlan))}</div>
      <div>${section('Servers they run', hbarList(a.bySize.map((s) => ({ ...s, label: s.name === 'Not said' ? s.name : `${s.name} server${s.name === '1' ? '' : 's'}` }))))}</div>
      <div>${section('Status right now', hbarList(a.byStatus.map((s) => ({ ...s, label: LEAD_WORD[s.name] }))))}</div>
      <div>${section('Why leads are lost', hbarList(a.lostReasons, { empty: 'No lost leads — so far so good.' }))}</div>
      <div>${section('Countries', hbarList(a.byCountry, { empty: 'No locations yet.' }))}</div>
      <div>${section('Cities', hbarList(a.byCity, { empty: 'No locations yet.' }))}</div>
      <div>${section('Internet providers', hbarList(a.byIsp, { empty: 'No locations yet.' }))}</div>
      <div>${section('Operating system', hbarList(a.byOs))}</div>
      <div>${section('Browser', hbarList(a.byBrowser))}</div>
      <div>${section('Device type', hbarList(a.byDeviceType.map((x) => ({ ...x, label: `${deviceIcon(x.name)} ${x.name}` }))))}</div>
    </div>
    <div class="chart-grid" style="margin-top:16px">
      ${chartCard('Day of the week leads arrive', '', barChart(a.weekday.map((w) => ({ month: w.name, total: w.count })), {
        integer: true, label: 'Leads by day of the week', labelOf: (p) => p.month, titleOf: (p) => p.month,
      }))}
      <div>${section('Campaigns (UTM)', table([{ label: 'Campaign' }, { label: 'Leads', num: true }, { label: 'Won', num: true }],
        a.campaigns.map((c) => [esc(c.name), c.count, c.won]), 'No campaign links used yet. Add ?utm_campaign=… to the links in your ads and posts.'))}</div>
    </div>`;
}

/* One listener for every button on the page. */
$('#view-platform').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-pf]');
  if (!b) return;
  const id = Number(b.dataset.id);
  // On an organisation's own page its freshly read record wins over the list's.
  const org = () => (pf.detail?.organisation?.id === id ? pf.detail.organisation : pf.orgs?.find((o) => o.id === id));
  const user = () => (pf.tab === 'org' ? pf.detail?.users : pf.users)?.find((x) => x.id === id);
  const plan = () => pf.allPlans?.find((p) => p.id === id);
  try {
    switch (b.dataset.pf) {
      case 'refresh': pf.orgs = null; pf.plans = null; await pfReload(); break;
      case 'new-org': await pfNewOrganisation(); break;
      case 'new-plan': pfPlanDialog(null); break;
      case 'new-payment': await pfRecordPayment(null); break;
      case 'new-client': await pfNewClient(null); break;
      case 'new-admin': pfAdminDialog(null); break;
      case 'admin-edit': pfAdminDialog(pf.admins.find((a) => a.id === id)); break;
      case 'admin-delete': pfAdminDelete(pf.admins.find((a) => a.id === id)); break;
      case 'org-view': pfOpenOrganisation(id); break;
      case 'lead-view': pfOpenLead(id); break;
      case 'leads-back': pf.loaded.delete('leads'); openPlatform('leads'); break;
      case 'leads-new': leadFilter.status = 'new'; pf.loaded.delete('leads'); openPlatform('leads'); break;
      case 'leads-csv': exportLeadsCsv(); break;
      case 'new-lead': pfLeadDialog(null); break;
      case 'lead-edit': pfLeadDialog(pf.lead.lead); break;
      case 'lead-delete': pfLeadDelete(pf.lead.lead); break;
      case 'lead-copy':
        try {
          await navigator.clipboard.writeText(leadAsText(pf.lead));
          toast('Every detail of this lead is copied');
        } catch { toast('The browser would not allow copying — use ⬇ JSON instead', 'err'); }
        break;
      case 'lead-json': {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([JSON.stringify({ lead: pf.lead.lead, timeline: pf.lead.notes, samePerson: pf.lead.others }, null, 2)], { type: 'application/json' }));
        a.download = `lead-${id}-${pf.lead.lead.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        break;
      }
      case 'lead-locate':
        busy(b, true, 'Looking up…');
        try {
          await api(`/platform/leads/${id}/locate`, { method: 'POST' });
          toast('Location updated');
          await pfAfterLeadChange();
        } catch (err) { toast(err.message, 'err'); busy(b, false); }
        break;
      case 'lead-convert': await pfConvertLead(pf.lead.lead); break;
      case 'lead-status': await pfLeadStatus(id, b.dataset.status); break;
      case 'note-delete':
        if (confirm('Delete this note?')) {
          await api(`/platform/leads/${pf.leadId}/notes/${id}`, { method: 'DELETE' });
          await pfAfterLeadChange();
        }
        break;
      case 'org-back': openPlatform('orgs'); break;
      case 'org-add-user': await pfNewClient(id); break;
      case 'req-activate': await pfRequest(id, true); break;
      case 'req-decline': await pfRequest(id, false); break;
      case 'org-edit': pfEditOrganisation(org()); break;
      case 'org-plan': await pfSetPlan(org()); break;
      case 'org-pay': await pfRecordPayment(org()); break;
      case 'org-enter': await pfEnterOrganisation(org()); break;
      case 'org-delete': pfDeleteOrganisation(org()); break;
      case 'user-edit': pfEditUser(user()); break;
      case 'user-move': pfMoveUser(user()); break;
      case 'user-delete': pfDeleteUser(user()); break;
      case 'plan-edit': pfPlanDialog(plan()); break;
      case 'plan-delete': await pfPlanDelete(plan()); break;
      case 'plan-restore': await pfPlanRestore(plan()); break;
      case 'pay-delete': await pfPaymentDelete(pf.payments.find((p) => p.id === id)); break;
      default: break;
    }
  } catch (err) {
    toast(err.message, 'err');
  }
});

/* ================================================== a client's plan */

/**
 * Nothing in a client organisation can be used until it is on a plan. Until
 * then this page is the whole app: it says so, and lets the organisation's
 * admin pick a plan — a free one starts at once, a paid one waits for the
 * platform to confirm the payment.
 */
let billingCycle = 'monthly';

/** Read the organisation's plan; true when it has one it can use. */
async function refreshBilling() {
  try {
    session.billing = await api('/billing');
  } catch {
    session.billing = null;
  }
  const active = Boolean(session.billing?.active);
  document.body.classList.toggle('needs-plan', session.user?.role !== 'super_admin' && !active);
  return active;
}

async function openBilling() {
  stopLiveStats();
  show('billing');
  setHeading('Plan & billing');
  $('#billing-body').innerHTML = '<div class="empty">Loading…</div>';
  await refreshBilling();
  renderBilling();
}

/** An API call said there is no plan: go to the plan page rather than show an error. */
function planRequired() {
  if (!session.user || session.user.role === 'super_admin') return;
  const wasGated = document.body.classList.contains('needs-plan');
  document.body.classList.add('needs-plan');
  if (!wasGated || $('#view-billing').classList.contains('hidden')) openBilling();
}

function renderBilling() {
  const b = session.billing;
  const box = $('#billing-body');
  if (!b) {
    box.innerHTML = '<div class="msg err">Your plan could not be read. Reload the page to try again.</div>';
    return;
  }
  const sub = b.subscription;
  const pending = b.pending;
  $('#billing-sub').textContent = b.organisation ? `${b.organisation.name}'s plan and what it allows.` : '';

  const yearlyOffered = b.plans.some((p) => p.priceYearly > 0);
  if (!yearlyOffered) billingCycle = 'monthly';

  const gate = !b.active ? `
    <div class="plan-gate">
      <div class="plan-gate-icon">🔒</div>
      <div>
        <h2>Please activate your plan</h2>
        <p class="muted">${esc(b.organisation?.name || 'Your organisation')} has no active plan yet. Servers, apps, databases and domains open up as soon as one is active.
          ${b.canChoose ? 'Choose a plan below — a free plan starts straight away.' : 'Ask an admin of your organisation to choose one.'}</p>
      </div>
    </div>` : '';

  const waiting = pending ? `
    <div class="msg info request-msg">⏳ You asked for <b>${esc(pending.plan)}</b> (${esc(pending.cycle)}, ${esc(fmtMoney(pending.amount, pending.currency))}) ${esc(agoWords(pending.requestedAt))}.
      It is switched on as soon as the platform confirms your payment.
      ${b.canChoose ? '<button class="btn tiny" id="btn-withdraw-request" style="margin-left:8px">Withdraw request</button>' : ''}</div>` : '';

  const current = sub ? `
    <div class="section">
      <div class="section-head"><h2>Your plan</h2></div>
      <div class="card current-plan">
        <div class="current-plan-top">
          <div>
            <h3>${esc(sub.plan)} <span class="badge ${SUB_BADGE[sub.status] || ''}">${esc(SUB_WORD[sub.status] || sub.status)}</span></h3>
            <p class="muted small" style="margin:4px 0 0">${sub.amount ? `${esc(fmtMoney(sub.amount, sub.currency))} ${sub.cycle === 'yearly' ? 'a year' : 'a month'}` : 'Free'}
              · since ${esc(fmtDay(sub.startedAt))}${sub.renewsAt ? ` · renews ${esc(fmtDay(sub.renewsAt))}` : ''}</p>
          </div>
        </div>
        ${usageMeters(b.usage, b.limits)}
      </div>
    </div>` : '';

  const cards = b.plans.map((p) => {
    const free = p.priceMonthly === 0 && p.priceYearly === 0;
    const yearly = billingCycle === 'yearly' && p.priceYearly > 0;
    const price = yearly ? p.priceYearly : p.priceMonthly;
    const cycle = yearly ? 'yearly' : 'monthly';
    const isCurrent = sub && sub.planId === p.id && (free || sub.cycle === cycle);
    const isPending = pending && pending.planId === p.id && pending.cycle === cycle;
    let action;
    if (isCurrent) action = '<button class="btn big price-cta" disabled>Your current plan</button>';
    else if (isPending) action = '<button class="btn big price-cta" disabled>Requested — waiting</button>';
    else if (!b.canChoose) action = '<button class="btn big price-cta" disabled>Ask your admin</button>';
    else action = `<button class="btn ${p.highlighted ? 'primary' : ''} big price-cta" data-choose="${p.id}" data-cycle="${cycle}">${free ? 'Start free' : `Choose ${esc(p.name)}`}</button>`;
    const note = yearly ? `≈ ${fmtMoney(p.priceYearly / 12, p.currency)} a month, billed yearly`
      : (!free && p.priceYearly > 0 ? `or ${fmtMoney(p.priceYearly, p.currency)} a year` : '');
    return `<article class="price-card ${p.highlighted ? 'featured' : ''} ${isCurrent ? 'current' : ''}">
      ${p.highlighted ? '<span class="price-ribbon">Most popular</span>' : ''}
      <h3>${esc(p.name)}</h3>
      <p class="price-tagline">${esc(p.tagline || '')}</p>
      <div class="price-amount">${free ? '<b>Free</b>' : `<b>${esc(fmtMoney(price, p.currency))}</b><span>${yearly ? '/year' : '/month'}</span>`}</div>
      <p class="price-note">${esc(note) || '&nbsp;'}</p>
      ${action}
      <ul class="price-list">${Object.keys(LIMIT_WORDS).map((k) => `<li>${esc(limitLine(k, p.limits[k]))}</li>`).join('')}${p.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
    </article>`;
  }).join('');

  box.innerHTML = `${gate}${waiting}${current}
    <div class="section">
      <div class="section-head">
        <h2>${sub ? 'Change plan' : 'Choose a plan'}</h2>
        ${yearlyOffered ? `<div class="cycle-toggle" id="billing-cycle" role="group" aria-label="Billing cycle">
          <button type="button" class="${billingCycle === 'monthly' ? 'active' : ''}" data-cycle="monthly">Monthly</button>
          <button type="button" class="${billingCycle === 'yearly' ? 'active' : ''}" data-cycle="yearly">Yearly</button>
        </div>` : ''}
      </div>
      ${b.plans.length ? `<div class="price-grid">${cards}</div>` : '<div class="empty">No plans are on offer yet. Contact the platform administrator.</div>'}
    </div>`;
}

$('#billing-body').addEventListener('click', async (e) => {
  const cycleBtn = e.target.closest('#billing-cycle button[data-cycle]');
  if (cycleBtn) {
    billingCycle = cycleBtn.dataset.cycle;
    return renderBilling();
  }

  if (e.target.closest('#btn-withdraw-request')) {
    if (!confirm('Withdraw your plan request?')) return;
    try {
      await api('/billing/request', { method: 'DELETE' });
      toast('Request withdrawn');
      await openBilling();
    } catch (err) { toast(err.message, 'err'); }
    return;
  }

  const choose = e.target.closest('[data-choose]');
  if (!choose) return;
  const plan = session.billing.plans.find((p) => String(p.id) === choose.dataset.choose);
  const cycle = choose.dataset.cycle;
  const price = cycle === 'yearly' ? plan.priceYearly : plan.priceMonthly;
  const ask = price
    ? `Request ${plan.name} at ${fmtMoney(price, plan.currency)} ${cycle === 'yearly' ? 'a year' : 'a month'}?\n\nIt is switched on once the platform confirms your payment.`
    : `Switch to the free ${plan.name} plan now?`;
  if (!confirm(ask)) return;
  busy(choose, true, 'Saving…');
  try {
    const r = await api('/billing/choose', { method: 'POST', body: { plan_id: plan.id, cycle } });
    toast(r.message);
    const wasGated = document.body.classList.contains('needs-plan');
    await refreshBilling();
    // A plan that is on right away opens the rest of the app.
    if (wasGated && session.billing?.active) return enterApp({ keepOrgPicker: true });
    renderBilling();
  } catch (err) {
    toast(err.message, 'err');
    busy(choose, false);
  }
});

/* ================================================================ docs */

/**
 * The same guides as the public /docs pages, inside the app: a searchable
 * list by category on the left, the guide on the right. Links between guides
 * stay in the app. Super admins also get the platform-admin guides.
 */
const docsState = { docs: null, slug: 'getting-started' };

async function openDocs(slug) {
  show('docs');
  setHeading('Docs');
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === 'docs'));
  if (!docsState.docs) {
    try {
      const [pub, admin] = await Promise.all([
        api('/public/docs'),
        session.user?.role === 'super_admin' ? api('/platform/docs').catch(() => null) : null,
      ]);
      docsState.docs = (admin || pub).docs;
    } catch (err) {
      $('#app-docs-body').innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
      return;
    }
  }
  if (slug) docsState.slug = slug;
  if (!docsState.docs.some((d) => d.slug === docsState.slug)) docsState.slug = docsState.docs[0]?.slug;
  renderDocsNav();
  renderDocArticle();
}

function renderDocsNav() {
  const q = $('#app-docs-search').value.trim().toLowerCase();
  const cats = [...new Set(docsState.docs.map((d) => d.category))];
  $('#app-docs-nav').innerHTML = cats.map((cat) => {
    const items = docsState.docs.filter((d) => d.category === cat
      && (!q || `${d.title} ${d.summary} ${d.category} ${d.body.replace(/<[^>]+>/g, ' ')}`.toLowerCase().includes(q)));
    if (!items.length) return '';
    return `<div class="docs-group"><div class="docs-group-title">${esc(cat)}${cat === 'Platform admin' ? ' <span class="badge">super admin</span>' : ''}</div>
      ${items.map((d) => `<a href="/docs/${d.slug}" class="docs-link ${d.slug === docsState.slug ? 'active' : ''}" data-doc="${d.slug}">${esc(d.title)}</a>`).join('')}</div>`;
  }).join('') || '<p class="muted small">Nothing matches — try another word.</p>';
}

function renderDocArticle() {
  const docs = docsState.docs;
  const d = docs.find((x) => x.slug === docsState.slug);
  if (!d) return;
  const i = docs.indexOf(d);
  const prev = docs[i - 1];
  const next = docs[i + 1];
  // The guides are written by us (src/lib/docs.js), so their HTML is shown as it is.
  $('#app-docs-body').innerHTML = `
    <nav class="docs-crumbs">Docs › ${esc(d.category)}</nav>
    <article class="doc"><h1>${esc(d.title)}</h1><p class="docs-lead">${esc(d.summary)}</p>${d.body}</article>
    <nav class="docs-pager">
      ${prev ? `<a href="/docs/${prev.slug}" data-doc="${prev.slug}"><small>← Previous</small><b>${esc(prev.title)}</b></a>` : '<span></span>'}
      ${next ? `<a href="/docs/${next.slug}" data-doc="${next.slug}" class="next"><small>Next →</small><b>${esc(next.title)}</b></a>` : '<span></span>'}
    </nav>
    <div class="docs-help">Can't find the answer? Ask us through the <a href="/#contact" target="_blank" rel="noopener">contact form</a>${session.user?.role !== 'super_admin' ? ' or your organisation\'s admin' : ''}.</div>`;
  window.scrollTo({ top: 0 });
}

// Links between guides open inside the app instead of leaving it.
['#app-docs-nav', '#app-docs-body'].forEach((sel) => $(sel).addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="/docs/"]');
  if (!a) return;
  e.preventDefault();
  docsState.slug = a.dataset.doc || a.getAttribute('href').split('/').pop();
  renderDocsNav();
  renderDocArticle();
}));
$('#app-docs-search').addEventListener('input', renderDocsNav);

/** Everything that happens once there is a signed-in person. */
async function enterApp({ keepOrgPicker = false } = {}) {
  applyIdentity();
  closeAuth();
  if (!keepOrgPicker) await loadOrgSwitcher();
  // An admin or super admin without a mobile number adds one first.
  if (session.user.needsPhone) openProfile({ mustAddPhone: true });

  // A super admin on the platform starts at the platform's dashboard.
  if (session.user.role === 'super_admin' && !session.user.orgId) {
    openPlatform('dashboard');
    return health();
  }
  // A client without a plan starts — and stays — on the plan page.
  if (session.user.role !== 'super_admin' && !(await refreshBilling())) {
    openBilling();
    return health();
  }
  show('servers');
  setHeading('Servers');
  await Promise.all([health(), loadServers()]);
}

/** A super admin leaves the organisation they opened and is back on the platform. */
async function leaveOrganisation() {
  try {
    const r = await api('/auth/organisation', { method: 'POST', body: { org_id: null } });
    session.user = r.user;
    stopLiveStats();
    applyIdentity();
    openPlatform(pf.lastTab || 'orgs');
    health();
  } catch (err) {
    toast(err.message, 'err');
  }
}

$('#btn-sa-leave').addEventListener('click', leaveOrganisation);

/* =========================================================== environments */

/*
 * Named sets of variables, kept once and used by apps, one-click services and
 * systemd services. The page lists them; the pickers in each create form let
 * you use one or save the new variables as one.
 */

let envsCache = null;     // the organisation's environments, without values
let envsCanSee = false;   // whether this role may see values
let envsFilter = '';

async function fetchEnvironments(force = false) {
  if (!envsCache || force) {
    const r = await api('/environments');
    envsCache = r.environments;
    envsCanSee = r.canSeeValues;
  }
  return envsCache;
}

/** Pairs back into .env text: values with spaces, quotes or # are quoted. */
const envToText = (pairs) => pairs
  .map(([k, v]) => `${k}=${v === '' || /[\s"'#]/.test(String(v)) ? JSON.stringify(String(v)) : v}`).join('\n');

function downloadEnvFile(name, pairs) {
  const blob = new Blob([`${envToText(pairs)}\n`], { type: 'text/plain' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${name}.env` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* ------------------------------------------------------- the list page */

async function loadEnvironments() {
  const box = $('#envs-list');
  if (!envsCache) box.innerHTML = '<div class="empty"><span class="spinner"></span>Loading environments…</div>';
  try {
    await fetchEnvironments(true);
    renderEnvironments();
  } catch (err) {
    box.innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
  }
}

function envUsageHtml(u) {
  const items = [
    ...(u?.apps || []).map((a) => `<span class="chip" title="App on ${esc(a.server || '')}">🚀 ${esc(a.name)}</span>`),
    ...(u?.installs || []).map((i) => `<span class="chip" title="${esc(i.kind)} on ${esc(i.server || '')}">📦 ${esc(i.name)}</span>`),
  ];
  return items.length ? `<div class="chips">${items.join('')}</div>` : '<span class="muted small">Not used yet</span>';
}

function renderEnvironments() {
  const list = envsCache || [];
  const used = list.filter((e) => e.usage.apps.length || e.usage.installs.length);
  const apps = list.reduce((n, e) => n + e.usage.apps.length, 0);
  const installs = list.reduce((n, e) => n + e.usage.installs.length, 0);
  $('#envs-stats').innerHTML = `
    ${tile('Environments', list.length, 'named sets of variables')}
    ${tile('Variables', list.reduce((n, e) => n + e.count, 0), 'across all of them')}
    ${tile('In use', used.length, `${plural(apps, 'app')} · ${plural(installs, 'service')}`)}
    ${tile('Not used yet', list.length - used.length, 'ready for the next app')}`;

  const box = $('#envs-list');
  if (!list.length) {
    box.innerHTML = `<div class="card env-empty">
      <div class="env-empty-icon">🧩</div>
      <h3>No environments yet</h3>
      <p class="muted">Create one here, import a <code>.env</code> file — or one is made for you when you create an app or install a service and give it a name.</p>
      ${ifCan('create', '<div class="actions" style="justify-content:center"><button class="btn" data-env-page="import">Import .env file</button><button class="btn primary" data-env-page="new">+ New environment</button></div>')}
    </div>`;
    return;
  }

  const q = envsFilter;
  const shown = list.filter((e) => !q || e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q)
    || e.keys.some((k) => k.toLowerCase().includes(q)));
  box.innerHTML = table(
    [{ label: 'Environment' }, { label: 'Variables' }, { label: 'Used by' }, { label: 'Updated' }, { label: '' }],
    shown.map((e) => [
      `<button class="link-btn" data-env-act="view" data-id="${e.id}"><b>${esc(e.name)}</b></button>
        ${e.description ? `<div class="muted small clamp-1">${esc(e.description)}</div>` : ''}`,
      `<b>${e.count}</b> <span class="muted small">${e.count === 1 ? 'variable' : 'variables'}</span>
        ${e.keys.length ? `<div class="env-keys">${e.keys.slice(0, 4).map((k) => `<code>${esc(k)}</code>`).join('')}${e.keys.length > 4 ? `<span class="muted small">+${e.keys.length - 4} more</span>` : ''}</div>` : ''}`,
      envUsageHtml(e.usage),
      `<span class="nowrap">${esc(agoWords(e.updatedAt))}</span>${e.createdBy ? `<div class="muted small nowrap">by ${esc(e.createdBy)}</div>` : ''}`,
      `<div class="row-actions">
        <button class="btn tiny" data-env-act="view" data-id="${e.id}">View</button>
        ${ifCan('edit', `<button class="btn tiny" data-env-act="edit" data-id="${e.id}">Edit</button>`)}
        ${ifCan('edit', `<button class="btn tiny" data-env-act="download" data-id="${e.id}">Download .env</button>`)}
        ${ifCan('create', `<button class="btn tiny" data-env-act="duplicate" data-id="${e.id}">Duplicate</button>`)}
        ${ifCan('delete', `<button class="btn tiny danger" data-env-act="delete" data-id="${e.id}">Delete</button>`)}
      </div>`,
    ]),
    'No environment matches this search'
  );
}

$('#btn-envs-refresh').addEventListener('click', loadEnvironments);
$('#btn-envs-new').addEventListener('click', () => openEnvironmentEditor());
$('#btn-envs-import').addEventListener('click', () => $('#envs-import-file').click());
$('#envs-search').addEventListener('input', (e) => { envsFilter = e.target.value.trim().toLowerCase(); renderEnvironments(); });

// A file imported from the page starts a new environment named after it.
readTextFile($('#envs-import-file'), (text, file) => {
  const base = file.name.replace(/\.(env|txt)$/i, '').replace(/^\.env\.?/i, '').replace(/[^A-Za-z0-9 ._-]/g, '-') || 'imported';
  openEnvironmentEditor(null, { name: base, pairs: parseEnvLines(text), note: `${file.name} imported — ${plural(parseEnvLines(text).length, 'variable')}. Check the name, then save.` });
});

$('#view-environments').addEventListener('click', async (e) => {
  const page = e.target.closest('[data-env-page]');
  if (page) return page.dataset.envPage === 'new' ? openEnvironmentEditor() : $('#envs-import-file').click();
  const btn = e.target.closest('[data-env-act]');
  if (!btn) return;
  const env = (envsCache || []).find((x) => String(x.id) === btn.dataset.id);
  if (!env) return;
  const act = btn.dataset.envAct;
  try {
    if (act === 'view') return openEnvironmentView(env.id);
    if (act === 'edit') return openEnvironmentEditor(env.id);
    if (act === 'download') {
      const full = await api(`/environments/${env.id}`);
      return downloadEnvFile(full.name, full.env || []);
    }
    if (act === 'duplicate') {
      return openMyDialog({
        title: `Duplicate ${env.name}`,
        intro: `A new environment with the same ${plural(env.count, 'variable')} — handy for a staging copy of production.`,
        fields: `<label>Name of the copy<input name="name" value="${esc(`${env.name}-copy`)}" required maxlength="120" autocomplete="off" /></label>`,
        submitLabel: 'Duplicate',
        async submit(fd) {
          const r = await api(`/environments/${env.id}/duplicate`, { method: 'POST', body: { name: fd.get('name') } });
          return `Created ${r.name}`;
        },
        after: loadEnvironments,
      });
    }
    if (act === 'delete') {
      const users = env.usage.apps.length + env.usage.installs.length;
      return openMyDialog({
        title: `Delete ${env.name}?`,
        intro: `<div class="msg err">The environment and its ${plural(env.count, 'variable')} are deleted for good.</div>
          ${users ? `<p class="small" style="margin:10px 0 0">It is used by ${plural(users, 'app or service', 'apps and services')}. They keep the variables they already have — only the link to this environment goes.</p>` : ''}`,
        fields: `<label>Type <code>${esc(env.name)}</code> to confirm<input name="confirm" required autocomplete="off" /></label>`,
        submitLabel: 'Delete',
        danger: true,
        async submit(fd) {
          if (fd.get('confirm') !== env.name) throw new Error('The name does not match');
          await api(`/environments/${env.id}`, { method: 'DELETE' });
          return `Deleted ${env.name}`;
        },
        after: loadEnvironments,
      });
    }
  } catch (err) { toast(err.message, 'err'); }
});

/* ------------------------------------------------------------- editor */

const envEditor = { id: null, mode: 'rows' };
const envRowsBox = () => $('#environment-rows');

function envEditorPairs() {
  return envEditor.mode === 'text' ? parseEnvLines($('#environment-text').value) : readEnvRows(envRowsBox());
}

function setEnvEditorMode(mode) {
  if (mode === envEditor.mode) return;
  if (mode === 'text') $('#environment-text').value = envToText(readEnvRows(envRowsBox()));
  else drawEnvRows(envRowsBox(), parseEnvLines($('#environment-text').value));
  envEditor.mode = mode;
  envRowsBox().classList.toggle('hidden', mode === 'text');
  $('#environment-text').classList.toggle('hidden', mode !== 'text');
  $('#btn-environment-add').classList.toggle('hidden', mode === 'text');
  $$('[data-env-editor]').forEach((b) => b.classList.toggle('active', b.dataset.envEditor === mode));
  updateEnvCount();
}

function updateEnvCount() {
  const n = envEditorPairs().length;
  $('#environment-count').textContent = `· ${n}`;
}

async function openEnvironmentEditor(id = null, preset = null) {
  const form = $('#form-environment');
  form.reset();
  envEditor.id = id;
  envEditor.mode = 'rows';
  envRowsBox().classList.remove('hidden');
  $('#environment-text').classList.add('hidden');
  $('#btn-environment-add').classList.remove('hidden');
  $$('[data-env-editor]').forEach((b) => b.classList.toggle('active', b.dataset.envEditor === 'rows'));
  $('#environment-msg').classList.add('hidden');
  $('#environment-sync-wrap').classList.add('hidden');
  $('#environment-title').textContent = id ? 'Edit environment' : 'New environment';
  $('#environment-sub').textContent = id ? 'Loading…' : 'A named set of variables you can use for any app or service.';
  drawEnvRows(envRowsBox(), preset?.pairs || []);
  $('#environment-name').value = preset?.name || '';
  updateEnvCount();
  $('#modal-environment').classList.remove('hidden');
  if (preset?.note) formMsg($('#environment-msg'), preset.note, 'info');
  if (!id) return $('#environment-name').focus();

  try {
    const r = await api(`/environments/${id}`);
    $('#environment-name').value = r.name;
    $('#environment-desc').value = r.description || '';
    drawEnvRows(envRowsBox(), r.env || []);
    updateEnvCount();
    $('#environment-sub').textContent = `${plural(r.count, 'variable')} · updated ${agoWords(r.updatedAt)}${r.createdBy ? ` · created by ${r.createdBy}` : ''}`;
    const apps = r.usage?.apps || [];
    if (apps.length) {
      $('#environment-sync-label').textContent = `Also copy these variables to the ${plural(apps.length, 'app')} using it (${apps.map((a) => a.name).join(', ')}). Variables only an app has are kept; changes apply at its next deploy or restart.`;
      $('#environment-sync-wrap').classList.remove('hidden');
    }
  } catch (err) {
    formMsg($('#environment-msg'), err.message, 'err');
  }
}

$$('[data-env-editor]').forEach((b) => b.addEventListener('click', () => setEnvEditorMode(b.dataset.envEditor)));
$('#environment-text').addEventListener('input', updateEnvCount);
envRowsBox().addEventListener('input', updateEnvCount);
$('#btn-environment-add').addEventListener('click', () => {
  drawEnvRows(envRowsBox(), [...readEnvRows(envRowsBox()), ['', '']]);
  $$('[data-env-key]', envRowsBox()).pop()?.focus();
  updateEnvCount();
});
envRowsBox().addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-remove-row]');
  if (!btn) return;
  const index = $$('.item-row', envRowsBox()).indexOf(btn.closest('.item-row'));
  drawEnvRows(envRowsBox(), readEnvRows(envRowsBox()).filter((_, i) => i !== index));
  updateEnvCount();
});
$('#btn-environment-import').addEventListener('click', () => $('#environment-file').click());
readTextFile($('#environment-file'), (text, file) => {
  // A key the file also has is replaced; everything else is kept.
  const merged = new Map(envEditorPairs());
  const incoming = parseEnvLines(text);
  for (const [k, v] of incoming) merged.set(k, v);
  if (envEditor.mode === 'text') setEnvEditorMode('rows');
  drawEnvRows(envRowsBox(), [...merged]);
  updateEnvCount();
  if (!$('#environment-name').value.trim()) $('#environment-name').value = file.name.replace(/\.(env|txt)$/i, '').replace(/^\.env\.?/i, '') || '';
  formMsg($('#environment-msg'), `${file.name} imported — ${plural(incoming.length, 'variable')}. Review them, then save.`, 'info');
});

$('#form-environment').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#btn-environment-save');
  const body = {
    name: $('#environment-name').value.trim(),
    description: $('#environment-desc').value.trim(),
    // The text editor is sent as written, so the server reads quotes and comments exactly.
    env: envEditor.mode === 'text' ? $('#environment-text').value : readEnvRows(envRowsBox()),
    sync_apps: !$('#environment-sync-wrap').classList.contains('hidden') && $('#environment-sync').checked,
  };
  busy(btn, true, 'Saving…');
  try {
    const r = envEditor.id
      ? await api(`/environments/${envEditor.id}`, { method: 'PUT', body })
      : await api('/environments', { method: 'POST', body });
    $('#modal-environment').classList.add('hidden');
    toast(`${r.name} saved — ${plural(r.count, 'variable')}${r.synced ? `, copied to ${plural(r.synced, 'app')}` : ''}`);
    envsCache = null;
    if (!$('#view-environments').classList.contains('hidden')) loadEnvironments();
  } catch (err) {
    formMsg($('#environment-msg'), err.message, 'err');
  }
  busy(btn, false);
});

/* ----------------------------------------------------------- view only */

const envView = { data: null, reveal: false };

function renderEnvironmentView() {
  const r = envView.data;
  const hasValues = Array.isArray(r.env);
  const rows = hasValues ? r.env : r.keys.map((k) => [k, null]);
  $('#btn-envview-reveal').hidden = !hasValues || !rows.length;
  $('#btn-envview-reveal').textContent = envView.reveal ? 'Hide values' : 'Show values';
  $('#btn-envview-download').hidden = !hasValues;
  $('#envview-body').innerHTML = `
    ${hasValues ? '' : '<div class="msg info" style="margin-bottom:12px">Your role can see which variables this environment has, but not their values.</div>'}
    ${rows.length ? `<div class="card env-view-table" style="padding:0"><table>
      <thead><tr><th>Variable</th><th>Value</th>${hasValues ? '<th></th>' : ''}</tr></thead>
      <tbody>${rows.map(([k, v], i) => `<tr>
        <td><code>${esc(k)}</code></td>
        <td class="env-value">${v === null ? '<span class="muted">hidden</span>'
    : envView.reveal ? `<code>${esc(v) || '<span class="muted">(empty)</span>'}</code>` : `<span class="env-mask">${'•'.repeat(Math.min(12, Math.max(6, String(v).length)))}</span>`}</td>
        ${hasValues ? `<td style="width:1%"><button type="button" class="btn tiny" data-env-copy="${i}">Copy</button></td>` : ''}
      </tr>`).join('')}</tbody></table></div>` : '<div class="empty">This environment has no variables yet.</div>'}
    <div class="section" style="margin:18px 0 0"><div class="section-head"><h2>Used by</h2></div>${envUsageHtml(r.usage)}</div>`;
}

async function openEnvironmentView(id) {
  envView.reveal = false;
  $('#envview-title').textContent = 'Loading…';
  $('#envview-sub').textContent = '';
  $('#envview-body').innerHTML = '<div class="empty"><span class="spinner"></span></div>';
  $('#modal-environment-view').classList.remove('hidden');
  try {
    const r = await api(`/environments/${id}`);
    envView.data = r;
    $('#envview-title').textContent = r.name;
    $('#envview-sub').textContent = [r.description, plural(r.count, 'variable'), `updated ${agoWords(r.updatedAt)}`, r.createdBy ? `by ${r.createdBy}` : ''].filter(Boolean).join(' · ');
    renderEnvironmentView();
  } catch (err) {
    $('#envview-body').innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
  }
}

$('#btn-envview-reveal').addEventListener('click', () => { envView.reveal = !envView.reveal; renderEnvironmentView(); });
$('#btn-envview-download').addEventListener('click', () => downloadEnvFile(envView.data.name, envView.data.env || []));
$('#btn-envview-edit').addEventListener('click', () => {
  $('#modal-environment-view').classList.add('hidden');
  openEnvironmentEditor(envView.data.id);
});
$('#envview-body').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-env-copy]');
  if (!btn) return;
  const [k, v] = envView.data.env[Number(btn.dataset.envCopy)];
  try {
    await navigator.clipboard.writeText(String(v));
    toast(`${k} copied`);
  } catch { toast('The browser did not allow copying', 'err'); }
});

/* ----------------------------------------- the picker in the create forms */

const envPickHandlers = {};

/**
 * Get a picker ready: "create a new one" (named after what is being created),
 * "use an existing one" or "none". `onPick` fills the form from a chosen one.
 */
async function prepareEnvPicker(box, { name = '', onPick } = {}) {
  if (!box) return;
  const group = `envpick_${box.dataset.envPick}`;
  const noun = box.dataset.noun || 'app';
  if (onPick) envPickHandlers[box.id] = onPick;
  if (!box.dataset.ready) {
    box.innerHTML = `
      <div class="env-pick-title">Environment <span class="muted small">— keep these variables under a name to reuse them</span></div>
      <div class="env-pick-modes">
        <label class="env-mode"><input type="radio" name="${group}" value="new" checked />
          <span><b>Create a new environment</b><small>Saved under the name below</small></span></label>
        <label class="env-mode" data-env-existing><input type="radio" name="${group}" value="existing" />
          <span><b>Use an existing one</b><small data-env-existing-note>Fill the variables from it</small></span></label>
        <label class="env-mode"><input type="radio" name="${group}" value="none" />
          <span><b>None</b><small>Only for this ${esc(noun)}</small></span></label>
      </div>
      <label class="env-pick-new">Environment name
        <input data-env-name maxlength="120" autocomplete="off" placeholder="e.g. shop-production" /></label>
      <label class="env-pick-existing hidden">Environment
        <select data-env-select></select></label>
      <div class="muted small env-pick-note" data-env-note></div>`;
    box.addEventListener('change', async (e) => {
      if (e.target.matches('input[type=radio]')) return updateEnvPicker(box);
      if (e.target.matches('[data-env-select]')) {
        const note = $('[data-env-note]', box);
        if (!e.target.value) { note.textContent = ''; return; }
        note.textContent = 'Loading its variables…';
        try {
          const r = await api(`/environments/${e.target.value}`);
          const filled = envPickHandlers[box.id]?.(r);
          note.textContent = Array.isArray(r.env)
            ? `${r.name}: ${plural(r.count, 'variable')}${typeof filled === 'number' ? ` — ${plural(filled, 'field')} filled in` : ' loaded into the form'}.`
            : `${r.name} will be linked. Your role cannot see its values.`;
        } catch (err) { note.textContent = err.message; }
      }
    });
    $('[data-env-name]', box).addEventListener('input', (e) => { e.target.dataset.touched = '1'; });
    box.dataset.ready = '1';
  }

  const nameInput = $('[data-env-name]', box);
  delete nameInput.dataset.touched;
  nameInput.value = name;
  $(`input[value="new"]`, box).checked = true;
  $('[data-env-note]', box).textContent = '';

  let list = [];
  try { list = await fetchEnvironments(true); } catch { /* the picker still offers "new" and "none" */ }
  $('[data-env-select]', box).innerHTML = `<option value="">Choose an environment…</option>${list
    .map((x) => `<option value="${x.id}">${esc(x.name)} — ${plural(x.count, 'variable')}</option>`).join('')}`;
  const existing = $('input[value="existing"]', box);
  existing.disabled = !list.length;
  $('[data-env-existing]', box).classList.toggle('disabled', !list.length);
  $('[data-env-existing-note]', box).textContent = list.length ? 'Fill the variables from it' : 'None yet in this organisation';
  updateEnvPicker(box);
}

function updateEnvPicker(box) {
  const mode = $('input[type=radio]:checked', box)?.value || 'none';
  $('.env-pick-new', box).classList.toggle('hidden', mode !== 'new');
  $('.env-pick-existing', box).classList.toggle('hidden', mode !== 'existing');
  $$('.env-mode', box).forEach((l) => l.classList.toggle('active', $('input', l).checked));
  $('[data-env-name]', box).required = mode === 'new';
  $('[data-env-select]', box).required = mode === 'existing';
  if (mode !== 'existing') $('[data-env-note]', box).textContent = '';
}

/** Keep the suggested name in step with the app or service name, until it is typed over. */
function setEnvPickerName(box, name) {
  const input = box && $('[data-env-name]', box);
  if (input && !input.dataset.touched) input.value = name;
}

/** What the create request carries: `environment_mode` plus an id or a name. */
function readEnvPicker(box) {
  if (!box || box.classList.contains('hidden') || !box.dataset.ready) return {};
  const mode = $('input[type=radio]:checked', box)?.value || 'none';
  return {
    environment_mode: mode,
    environment_id: mode === 'existing' ? $('[data-env-select]', box).value : undefined,
    environment_name: mode === 'new' ? $('[data-env-name]', box).value.trim() : undefined,
  };
}

/** Caught in the browser first, so nothing is created under a name that is already taken. */
function envPickerProblem(box) {
  const pick = readEnvPicker(box);
  if (pick.environment_mode === 'new') {
    if (!pick.environment_name) return 'Give the new environment a name, or choose "None"';
    if ((envsCache || []).some((x) => x.name.toLowerCase() === pick.environment_name.toLowerCase())) {
      return `There is already an environment called "${pick.environment_name}" — pick it under "Use an existing one", or choose another name`;
    }
  }
  if (pick.environment_mode === 'existing' && !pick.environment_id) return 'Pick the environment to use, or choose "None"';
  return null;
}

/* the custom service (app) wizard */
$('#app-name').addEventListener('input', (e) => setEnvPickerName($('#app-env-pick'), e.target.value.trim()));

function prepareAppEnvPicker() {
  return prepareEnvPicker($('#app-env-pick'), {
    name: $('#app-name').value.trim(),
    onPick(r) {
      if (!Array.isArray(r.env)) return undefined;
      $('#app-env').value = envToText(r.env.filter(([k]) => !['PORT', 'INSTANCE'].includes(k)));
      $('#app-env-note').textContent = `Filled from the ${r.name} environment — edit anything here before you deploy.`;
      return undefined;
    },
  });
}

/* one-click installs: fields that are environment variables fill from the environment */
$('#install-name').addEventListener('input', (e) => setEnvPickerName($('#install-env-pick'), e.target.value.trim()));

function prepareInstallEnvPicker(entry) {
  const box = $('#install-env-pick');
  const envFields = (entry?.fields || []).filter((f) => f.env);
  box.classList.toggle('hidden', !envFields.length || entry.kind === 'host');
  if (box.classList.contains('hidden')) return;
  prepareEnvPicker(box, {
    name: $('#install-name').value.trim() || entry.key,
    onPick(r) {
      if (!Array.isArray(r.env)) return 0;
      const values = new Map(r.env);
      let filled = 0;
      for (const f of envFields) {
        const input = installForm.querySelector(`[name="field_${f.name}"]`);
        if (input && values.has(f.env)) { input.value = values.get(f.env); filled += 1; }
      }
      return filled;
    },
  });
}

/* systemd services: the Environment box fills from the environment */
serviceForm.unit.addEventListener('input', (e) => setEnvPickerName($('#service-env-pick'), e.target.value.trim()));

function prepareServiceEnvPicker() {
  return prepareEnvPicker($('#service-env-pick'), {
    name: '',
    onPick(r) {
      if (!Array.isArray(r.env)) return undefined;
      serviceForm.environment.value = envToText(r.env);
      return undefined;
    },
  });
}

/* the app's own Environment window: load from an environment */
async function prepareAppEnvSource(linked) {
  const select = $('#app-env-source');
  $('#app-env-link').innerHTML = linked ? `Linked to <b>${esc(linked.name)}</b>` : 'Not linked to an environment';
  try {
    const list = await fetchEnvironments(true);
    select.innerHTML = `<option value="">— keep what is here —</option>${list
      .map((x) => `<option value="${x.id}">${esc(x.name)} — ${plural(x.count, 'variable')}</option>`).join('')}`;
    select.disabled = !list.length;
  } catch {
    select.disabled = true;
  }
}

$('#app-env-source').addEventListener('change', async (e) => {
  const id = e.target.value;
  if (!id || !envApp) return;
  try {
    const r = await api(`/environments/${id}`);
    if (!Array.isArray(r.env)) return formMsg($('#app-env-msg'), 'Your role cannot see this environment\'s values.', 'err');
    // Its keys replace the same keys here; anything only this app has is kept.
    const merged = new Map(readEnvRows($('#env-rows')));
    for (const [k, v] of r.env) if (!['PORT', 'INSTANCE'].includes(k)) merged.set(k, v);
    drawEnvRows($('#env-rows'), [...merged]);
    envApp.environmentId = r.id;
    $('#app-env-link').innerHTML = `Will be linked to <b>${esc(r.name)}</b> when you save`;
    formMsg($('#app-env-msg'), `${plural(r.count, 'variable')} loaded from ${r.name} — review them, then save.`, 'info');
  } catch (err) {
    formMsg($('#app-env-msg'), err.message, 'err');
  }
});

/* =========================================================== auto deploy */

/*
 * An app can redeploy by itself when its branch changes: on every push, or
 * only when a pull / merge request is merged into it. The wizard offers it when
 * the app is created; the app's "Auto deploy" tab turns it on or off later,
 * shows what is running against what is on the branch, and sets up the webhook.
 */

const AUTO_TRIGGER = { push: 'Every push or commit', merge: 'Only merged pull / merge requests' };

/** Could GitHub reach this panel at the address it is open on? */
function panelLooksPublic(url = location.origin) {
  try {
    const { hostname } = new URL(url);
    if (hostname === 'localhost' || !hostname.includes('.') || /\.(local|internal)$/.test(hostname)) return false;
    return !/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(hostname) && !/^172\.(1[6-9]|2\d|3[01])\./.test(hostname);
  } catch { return false; }
}

/** What anyone can see, before (or instead of) the full settings. */
function autoSummaryHtml(a) {
  const ad = a.autoDeploy || {};
  return `<div class="card auto-panel">
    <div class="auto-head">
      <div><h3>Auto deploy ${ad.enabled ? '<span class="badge ok">⚡ on</span>' : '<span class="badge">off</span>'}</h3>
        <p class="muted small">${ad.enabled
    ? `${esc(AUTO_TRIGGER[ad.trigger] || AUTO_TRIGGER.push)} to <b>${esc(a.branch)}</b> rebuilds and restarts ${esc(a.name)}.`
    : `${esc(a.name)} deploys only when someone clicks Redeploy.`}</p></div>
    </div>
    ${canDo('edit') ? '<div class="empty"><span class="spinner"></span>Reading the branch…</div>' : ''}
  </div>`;
}

const autoCache = new Map();   // app id → { at, data }, so a refresh every few seconds does not ask GitHub every time

async function loadAutoPanel(a, { fresh = false } = {}) {
  const box = $('#ad-auto-panel');
  if (!box || !canDo('edit')) return;
  const cached = autoCache.get(String(a.id));
  if (cached && !fresh && Date.now() - cached.at < 30000) return renderAutoPanel(box, a.id, cached.data);
  try {
    const data = await api(`/apps/${a.id}/auto-deploy`);
    autoCache.set(String(a.id), { at: Date.now(), data });
    if (String(box.dataset.app) === String(a.id) && document.body.contains(box)) renderAutoPanel(box, a.id, data);
  } catch (err) {
    box.innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
  }
}

function copyRow(label, value) {
  return `<div class="copy-row"><span class="muted small">${esc(label)}</span><code>${esc(value)}</code>
    <button type="button" class="btn tiny" data-copy="${esc(value)}">Copy</button></div>`;
}

function renderAutoPanel(box, id, d) {
  const head = d.head && !d.head.error ? d.head : null;
  const upToDate = head && d.deployed && head.sha === d.deployed.sha;
  const provider = d.provider?.label || 'your git host';
  const hookEvents = { github: 'Just the push event, plus Pull requests', gitlab: 'Push events and Merge request events', bitbucket: 'Repository push and Pull request fulfilled' }[d.provider?.kind] || 'push and merged requests';

  const how = d.webhookRegistered
    ? `<div class="auto-how ok">✓ <b>Webhook on ${esc(provider)}</b> — a push to <b>${esc(d.branch)}</b> starts a deploy within seconds. The branch is also checked every minute, in case a delivery is missed.</div>`
    : d.publicUrl
      ? `<div class="auto-how warn"><b>No webhook yet.</b> The branch is checked every minute, so a change goes live within about a minute. Add the webhook to deploy within seconds.
          ${canDo('edit') && d.enabled ? '<div style="margin-top:8px"><button type="button" class="btn tiny primary" data-auto="hook">Add the webhook on ' + esc(provider) + '</button></div>' : ''}</div>`
      : `<div class="auto-how info"><b>Checked every minute.</b> This panel is open at <code>${esc(d.panelUrl)}</code>, which ${esc(provider)} cannot reach from the internet — so instead of a webhook the panel reads the branch every minute, and a change goes live within about a minute. Open the panel on a public address (set <code>SITE_URL</code>) to deploy within seconds.</div>`;

  box.innerHTML = `
    <div class="card auto-panel">
      <form id="form-auto" class="auto-form">
        <div class="auto-head">
          <div>
            <h3>Auto deploy ${d.enabled ? '<span class="badge ok">⚡ on</span>' : '<span class="badge">off</span>'}</h3>
            <p class="muted small">Watches <b>${esc(d.branch)}</b> on <code>${esc(d.repo)}</code>. To watch another branch (main, master, dev…) change it under <b>Edit settings</b>.</p>
          </div>
          <label class="switch"><input type="checkbox" name="enabled" ${d.enabled ? 'checked' : ''} /><span></span><b>${d.enabled ? 'On' : 'Off'}</b></label>
        </div>
        <div class="auto-triggers">
          ${['push', 'merge'].map((t) => `<label class="env-mode ${d.trigger === t ? 'active' : ''}"><input type="radio" name="trigger" value="${t}" ${d.trigger === t ? 'checked' : ''} />
            <span><b>${AUTO_TRIGGER[t]}</b><small>${t === 'push'
    ? `Any new commit on ${esc(d.branch)} — direct pushes and merges alike`
    : `Only a pull / merge request merged into ${esc(d.branch)}, e.g. dev → ${esc(d.branch)}. Direct pushes are left alone.`}</small></span></label>`).join('')}
        </div>
        <div class="actions" style="margin-top:12px">
          <button type="submit" class="btn primary" id="btn-auto-save">Save</button>
          ${d.enabled ? '<button type="button" class="btn" data-auto="check">Check now</button>' : ''}
        </div>
      </form>
    </div>

    <div class="two-col" style="margin-top:14px">
      ${kvCard('Branch and running version', [
    ['On the branch', head ? `<code class="small">${esc(head.sha.slice(0, 7))}</code> <span class="small">${esc(head.message || '')}</span>${head.author ? `<div class="muted small">${esc(head.author)}${head.date ? ` · ${esc(agoWords(head.date))}` : ''}</div>` : ''}`
      : `<span class="small" style="color:var(--err)">${esc(d.head?.error || 'could not be read')}</span>`],
    ['Running now', d.deployed ? `<code class="small">${esc(d.deployed.sha.slice(0, 7))}</code> <span class="small">${esc(d.deployed.message || '')}</span>` : '<span class="muted small">not recorded yet — shown after the next deploy</span>'],
    ['State', !head ? '—' : !d.deployed ? '<span class="badge">unknown</span>' : upToDate ? '<span class="badge ok">up to date</span>'
      : `<span class="badge warn">a newer commit is on ${esc(d.branch)}</span>${d.enabled ? '<div class="muted small">It deploys at the next check.</div>' : ''}`],
    ['Last checked', d.checkedAt ? esc(agoWords(d.checkedAt)) : '<span class="muted">not yet</span>'],
  ])}
      <div class="card">
        <h3>How changes reach the panel</h3>
        ${d.enabled ? how : '<p class="muted small" style="margin:0">Turn auto deploy on to choose.</p>'}
        ${d.error ? `<div class="msg err" style="margin-top:10px">${esc(d.error)}</div>` : ''}
      </div>
    </div>

    ${d.enabled && d.webhookUrl ? `<details class="fx-details" style="margin-top:14px">
      <summary>Set the webhook up by hand <span class="muted small">— if the automatic one cannot be added</span></summary>
      <div class="section">
        <p class="small" style="margin:0 0 10px">In ${esc(provider)}, open <b>${esc(d.repo)}</b> → Settings → Webhooks → Add webhook, and fill in:</p>
        ${copyRow('Payload URL', d.webhookUrl)}
        ${copyRow('Secret / token', d.webhookSecret)}
        <div class="copy-row"><span class="muted small">Content type</span><code>application/json</code></div>
        <div class="copy-row"><span class="muted small">Events</span><span class="small">${esc(hookEvents)}</span></div>
        <p class="muted small" style="margin:10px 0 0">Keep the URL private: anyone with it can start a deploy of this branch (never of other code).</p>
      </div>
    </details>` : ''}`;
}

$('#view-app-detail').addEventListener('change', (e) => {
  const form = e.target.closest('#form-auto');
  if (!form) return;
  $$('.env-mode', form).forEach((l) => l.classList.toggle('active', $('input', l).checked));
  if (e.target.name === 'enabled') $('.switch b', form).textContent = e.target.checked ? 'On' : 'Off';
});

$('#view-app-detail').addEventListener('submit', async (e) => {
  if (e.target.id !== 'form-auto') return;
  e.preventDefault();
  const form = e.target;
  const btn = $('#btn-auto-save');
  const body = { enabled: form.enabled.checked, trigger: form.trigger.value };
  busy(btn, true, 'Saving…');
  try {
    const r = await api(`/apps/${detailsAppId}/auto-deploy`, { method: 'PUT', body });
    toast(body.enabled
      ? `Auto deploy is on — ${body.trigger === 'merge' ? 'merged requests' : 'every push'} to ${r.branch} deploys ${r.name}${r.webhook?.ok ? ' (webhook added)' : ''}`
      : `Auto deploy is off for ${r.name}`);
    if (r.webhook && !r.webhook.ok) toast(r.webhook.error, 'err');
    autoCache.delete(String(detailsAppId));
    openAppDetails(detailsAppId, 'auto');
  } catch (err) {
    toast(err.message, 'err');
  }
  busy(btn, false);
});

$('#view-app-detail').addEventListener('click', async (e) => {
  const copy = e.target.closest('#ad-auto-panel [data-copy]');
  if (copy) {
    try { await navigator.clipboard.writeText(copy.dataset.copy); toast('Copied'); } catch { toast('The browser did not allow copying', 'err'); }
    return;
  }
  const act = e.target.closest('#ad-auto-panel [data-auto]');
  if (!act) return;
  busy(act, true, act.dataset.auto === 'check' ? 'Checking…' : 'Adding…');
  try {
    if (act.dataset.auto === 'check') {
      const r = await api(`/apps/${detailsAppId}/auto-deploy/check`, { method: 'POST' });
      if (r.error) toast(r.error, 'err');
      else if (r.deployed) toast(`New commit ${r.sha.slice(0, 7)} found — deploying now`);
      else toast(r.skipped === 'already deployed' ? 'Up to date — the branch has nothing new' : `Nothing to deploy: ${r.skipped}`);
    } else {
      const form = $('#form-auto');
      const r = await api(`/apps/${detailsAppId}/auto-deploy`, { method: 'PUT', body: { enabled: true, trigger: form.trigger.value } });
      if (r.webhook?.ok) toast('Webhook added — pushes now deploy within seconds');
      else toast(r.webhook?.error || 'The webhook could not be added', 'err');
    }
    autoCache.delete(String(detailsAppId));
    openAppDetails(detailsAppId, 'auto');
  } catch (err) {
    toast(err.message, 'err');
  }
  busy(act, false);
});

/* the create wizard */

function prepareAutoDeployCard() {
  const branch = $('#form-app-deploy').dataset.branch || 'main';
  $('#app-auto').checked = false;
  $('#app-auto-fields').classList.add('hidden');
  $('#app-auto-branch').textContent = branch;
  $$('[data-auto-branch]').forEach((el) => { el.textContent = branch; });
  $('input[name="auto_deploy_trigger"][value="push"]').checked = true;
  $$('#app-auto-fields .env-mode').forEach((l) => l.classList.toggle('active', $('input', l).checked));
  $('#app-auto-how').textContent = panelLooksPublic()
    ? `A webhook is added on the repository for you (when the git account is allowed to), so a change to ${branch} goes live within seconds; the branch is also checked every minute.`
    : `This panel is not reachable from the internet, so it checks ${branch} every minute instead of waiting for a webhook — a change goes live within about a minute.`;
}

$('#app-auto').addEventListener('change', (e) => $('#app-auto-fields').classList.toggle('hidden', !e.target.checked));
$('#app-auto-fields').addEventListener('change', () => {
  $$('#app-auto-fields .env-mode').forEach((l) => l.classList.toggle('active', $('input', l).checked));
});
// The watched branch is the one being deployed: changing it means going back to step one.
$('#btn-app-auto-branch').addEventListener('click', () => appStep('pick'));

/* ========================================================= deploy history */

/*
 * Every deploy of an app is kept with its log: what started it (a person, the
 * first deploy, or auto deploy), the branch, whether the change was a merge or
 * a commit, when that was made, and how the deploy ended. A deploy running now
 * is announced on the app's card and page, with its live log one click away.
 */

const TRIGGER_WORD = { auto: '⚡ Auto deploy', manual: 'Redeploy', first: 'First deploy' };
const DEPLOY_STATE = { running: ['in progress', 'warn'], success: ['deployed', 'ok'], failed: ['failed', 'err'], interrupted: ['interrupted', ''] };

/** "Merge #42 from dev" / "Commit" — what kind of change was deployed. */
function changeKindHtml(d) {
  if (d.kind === 'merge' || d.pr) {
    return `<span class="badge kind-merge">🔀 Merge${d.pr ? ` #${esc(d.pr.number)}` : ''}${d.pr?.from ? ` from ${esc(d.pr.from)}` : ''}</span>`;
  }
  if (d.kind === 'commit') return '<span class="badge kind-commit">● Commit</span>';
  return '<span class="muted small">—</span>';
}

const whenFull = (v) => (v ? new Date(parseWhen(v) || v).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');

/** Seconds between two times, as "1m 20s". */
function deployDuration(d) {
  const a = parseWhen(d.startedAt);
  const b = d.finishedAt ? parseWhen(d.finishedAt) : Date.now();
  return a && b ? duration((b - a) / 1000) : '—';
}

/**
 * How far a running deploy has got: one segment per step (done, running now,
 * still to come), "Step 5 of 8 · Build the image", a percentage and the time so far.
 */
function deployProgressHtml(a) {
  const d = a.currentDeploy;
  const seen = d?.steps || [];
  // Pushing to Docker Hub is a step only for an app that pushes.
  const plan = DEPLOY_STEPS.filter(([key]) => key !== 'push' || a.pushed || seen.includes('push'));
  const current = seen[seen.length - 1];
  const at = Math.max(0, plan.findIndex(([key]) => key === current));
  const started = seen.length > 0;
  // A step counts half while it runs, so the bar moves as soon as it starts.
  const pct = started ? Math.min(99, Math.round(((at + 0.5) / plan.length) * 100)) : 2;
  const label = started ? (plan[at]?.[1] || a.currentStep || 'Working') : 'Starting';
  return `<div class="deploy-bar" title="${esc(plan.map(([, l]) => l).join(' → '))}">
    <div class="deploy-bar-head">
      <span><b>Step ${started ? at + 1 : 0} of ${plan.length}</b> · ${esc(label)}…</span>
      <span><b>${pct}%</b> · <span data-since="${esc(a.deploy_started_at || d?.startedAt || '')}"></span></span>
    </div>
    <div class="deploy-segments">${plan.map(([key, l], i) => `<span class="seg-${!started ? 'todo' : i < at ? 'done' : i === at ? 'now' : 'todo'}" title="${esc(l)}"></span>`).join('')}</div>
  </div>`;
}

/** The banner on a card or page while a deploy runs: why, which change, and the live log. */
function deployBanner(a, { compact = false } = {}) {
  const d = a.currentDeploy;
  if (!d) return '';
  const auto = d.trigger === 'auto';
  const c = d.commit;
  const change = d.pr
    ? `merge #${esc(d.pr.number)}${d.pr.from ? ` from <b>${esc(d.pr.from)}</b>` : ''}${d.pr.title ? ` — ${esc(d.pr.title)}` : ''}`
    : c ? `commit <code>${esc(c.short)}</code>${c.message ? ` — ${esc(c.message)}` : ''}` : 'the latest commit';
  return `<div class="deploy-banner ${auto ? 'auto' : ''} ${compact ? 'compact' : ''}">
    <div class="deploy-banner-text">
      <b>${auto ? '⚡ Auto deploy in progress' : d.trigger === 'first' ? 'First deploy in progress' : 'Deploy in progress'}</b>
      <span>on <b>${esc(d.branch || a.branch)}</b> · ${change}</span>
      <span class="muted small">${c?.author ? `by ${esc(c.author)} · ` : ''}${c?.at ? `${d.kind === 'merge' || d.pr ? 'merged' : 'committed'} ${esc(agoWords(c.at))} · ` : ''}started ${esc(agoWords(d.startedAt))}${d.by ? ` by ${esc(d.by)}` : ''}</span>
    </div>
    <div class="deploy-banner-actions">
      <button class="btn tiny primary" data-app-action="progress" data-id="${a.id}" data-name="${esc(a.name)}"><span class="spinner"></span>View live logs</button>
      ${compact ? '' : `<button class="btn tiny" data-app-action="history" data-id="${a.id}" data-name="${esc(a.name)}">All deploys</button>`}
    </div>
    ${deployProgressHtml(a)}
  </div>`;
}

/* ------------------------------------------------ the Deploy history tab */

async function loadHistoryPanel(appId) {
  const box = $('#ad-history-panel');
  if (!box) return;
  try {
    const r = await api(`/apps/${appId}/deployments`);
    if (String(box.dataset.app) !== String(appId) || !document.body.contains(box)) return;
    const list = r.deployments;
    if (!list.length) {
      box.innerHTML = '<div class="card"><p class="muted small" style="margin:0">No deploys recorded yet — the next deploy appears here with its full log.</p></div>';
      return;
    }
    const counts = { success: 0, failed: 0, auto: 0 };
    for (const d of list) { if (d.status === 'success') counts.success += 1; if (d.status === 'failed') counts.failed += 1; if (d.trigger === 'auto') counts.auto += 1; }
    box.innerHTML = `
      <div class="tiles" style="margin-bottom:14px">
        ${tile('Deploys', list.length, 'kept with their logs (last 50)')}
        ${tile('Succeeded', counts.success, `${counts.failed} failed`)}
        ${tile('Automatic', counts.auto, 'started by auto deploy')}
        ${tile('Last one', esc(agoWords(list[0].startedAt)), esc((DEPLOY_STATE[list[0].status] || [list[0].status])[0]))}
      </div>
      ${table(
    [{ label: 'Started' }, { label: 'Branch' }, { label: 'Change' }, { label: 'Merged / committed' }, { label: 'Result' }, { label: '' }],
    list.map((d) => [
      `<span class="nowrap">${esc(TRIGGER_WORD[d.trigger] || d.trigger)}</span>
        <div class="muted small nowrap">${esc(whenFull(d.startedAt))}</div>
        <div class="muted small nowrap">${esc(agoWords(d.startedAt))}${d.by ? ` · ${esc(d.by)}` : ''}</div>`,
      `<code class="small">${esc(d.branch || '—')}</code>`,
      // A merged request is named by its title; a plain commit by its message.
      `${changeKindHtml(d)}<div class="small change-text">${d.commit ? `<code>${esc(d.commit.short)}</code> ` : ''}${esc(d.pr?.title || d.commit?.message || '')}</div>`,
      d.commit?.at ? `<span class="nowrap">${esc(whenFull(d.commit.at))}</span><div class="muted small">${d.commit.author ? `${esc(d.commit.author)} · ` : ''}${esc(agoWords(d.commit.at))}</div>` : '<span class="muted small">—</span>',
      `<span class="badge ${(DEPLOY_STATE[d.status] || [])[1] || ''}">${d.status === 'running' ? '<span class="spinner"></span>' : ''}${esc((DEPLOY_STATE[d.status] || [d.status])[0])}</span>
        <div class="muted small">${esc(deployDuration(d))}</div>`,
      `<div class="row-actions"><button class="btn tiny ${d.status === 'running' ? 'primary' : ''}" data-deploy-log="${d.id}">${d.status === 'running' ? 'Live log' : 'View log'}</button></div>`,
    ])
  )}`;
  } catch (err) {
    box.innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
  }
}

/* ------------------------------------------------------- one deploy's log */

const deployLog = { appId: null, id: null, timer: null, text: '' };

async function openDeployLog(appId, id) {
  clearTimeout(deployLog.timer);
  Object.assign(deployLog, { appId, id, text: '' });
  $('#deploylog-title').textContent = 'Loading…';
  $('#deploylog-state').innerHTML = '';
  $('#deploylog-facts').innerHTML = '';
  $('#deploylog-log').innerHTML = '';
  $('#modal-deploy-log').classList.remove('hidden');
  await refreshDeployLog();
}

async function refreshDeployLog() {
  const { appId, id } = deployLog;
  if ($('#modal-deploy-log').classList.contains('hidden') || !id) return;
  try {
    const d = await api(`/apps/${appId}/deployments/${id}`);
    if (deployLog.id !== id) return;
    deployLog.text = d.log || '';
    $('#deploylog-title').textContent = `${TRIGGER_WORD[d.trigger] || 'Deploy'} · ${whenFull(d.startedAt)}`;
    $('#deploylog-state').innerHTML = `<span class="badge ${(DEPLOY_STATE[d.status] || [])[1] || ''}">${d.live ? '<span class="spinner"></span>' : ''}${esc((DEPLOY_STATE[d.status] || [d.status])[0])}</span>`;
    const c = d.commit;
    $('#deploylog-facts').innerHTML = [
      ['Branch', `<code>${esc(d.branch || '—')}</code>`],
      ['Change', `${changeKindHtml(d)}${c ? ` <code>${esc(c.short)}</code> ${esc(c.message || '')}` : ''}`],
      ['Merged / committed', c?.at ? `${esc(whenFull(c.at))}${c.author ? ` · ${esc(c.author)}` : ''}` : '—'],
      ['Started by', `${esc(TRIGGER_WORD[d.trigger] || d.trigger)}${d.by ? ` · ${esc(d.by)}` : ''}`],
      ['Duration', `${esc(deployDuration(d))}${d.finishedAt ? ` · ended ${esc(whenFull(d.finishedAt))}` : ' so far'}`],
      ...(d.reason ? [['Why', esc(d.reason)]] : []),
      ...(d.error ? [['Error', `<span style="color:var(--err)">${esc(d.error)}</span>`]] : []),
    ].map(([k, v]) => `<div><span class="muted small">${k}</span><div>${v}</div></div>`).join('');
    $('#deploylog-follow-wrap').classList.toggle('hidden', !d.live);
    const pre = $('#deploylog-log');
    pre.innerHTML = renderDeployLog(deployLog.text) || '<span class="muted">No log was recorded.</span>';
    if (d.live && $('#deploylog-follow').checked) pre.scrollTop = pre.scrollHeight;
    // A running deploy keeps writing: read it again every two seconds until it ends.
    if (d.live) deployLog.timer = setTimeout(refreshDeployLog, 2000);
  } catch (err) {
    $('#deploylog-log').textContent = err.message;
  }
}

$('#btn-deploylog-download').addEventListener('click', () => {
  const clean = deployLog.text.replace(/^::(step|done|failed)::.*$/gm, '').replace(/^::commit::([0-9a-f]{7}).*$/gm, 'Commit $1');
  const blob = new Blob([clean], { type: 'text/plain' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `deploy-${deployLog.id}.log` });
  document.body.append(a);
  a.click();
  a.remove();
});

$('#view-app-detail').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-deploy-log]');
  if (btn) openDeployLog(detailsAppId, Number(btn.dataset.deployLog));
});

/** The first thing the page does: find out whether anybody is signed in. */
async function boot() {
  try {
    const state = await api('/auth/state');
    session.roles = state.roles || [];
    session.user = state.user;
    if (!state.user) return showLanding(state.needsSetup);
    await enterApp();
  } catch (err) {
    $('#health-dot').className = 'dot error';
    $('#health-text').textContent = 'API unreachable';
    showLanding(false);
    openAuth('login');
    formMsg($('#login-msg'), `The panel could not be reached: ${err.message}`, 'err');
  }
}

boot();
