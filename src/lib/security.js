/**
 * Request-level hardening that every route gets for free: security headers,
 * a same-origin check on anything that changes state, and the one place that
 * decides which address a request really came from.
 */

import { config } from '../config.js';

/**
 * The page has inline <script> blocks (theme bootstrap, structured data), so
 * scripts keep 'unsafe-inline' for now; everything else is pinned to this site.
 * frame-ancestors stops the panel being framed for clickjacking.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // Only meaningful over HTTPS, and only promised once the cookie is HTTPS-only too.
  if (config.auth.secureCookie) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // API answers carry secrets and per-user data: never cache them anywhere.
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The hosts this panel is served at: the one asked for, and SITE_URL if set. */
function ownHosts(req) {
  const hosts = new Set([String(req.headers.host || '').toLowerCase()]);
  if (config.trustProxy && req.headers['x-forwarded-host']) {
    hosts.add(String(req.headers['x-forwarded-host']).split(',')[0].trim().toLowerCase());
  }
  if (config.siteUrl) {
    try { hosts.add(new URL(config.siteUrl).host.toLowerCase()); } catch { /* a bad SITE_URL adds nothing */ }
  }
  return hosts;
}

/**
 * Cross-site request forgery. The session cookie is SameSite=Lax, which stops
 * other sites — but not a sibling subdomain, and this panel puts customer apps
 * on subdomains. So a state-changing request must come from this very origin.
 */
export function sameOriginOnly(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return res.status(403).json({ error: 'Cross-site request refused' });
  }
  const origin = req.headers.origin || req.headers.referer;
  if (origin) {
    let host;
    try { host = new URL(origin).host.toLowerCase(); } catch { host = null; }
    if (!host || !ownHosts(req).has(host)) return res.status(403).json({ error: 'Cross-site request refused' });
  }
  next();
}

/**
 * The address a request came from. Forwarding headers are only believed when
 * TRUST_PROXY says a proxy (nginx, Cloudflare) sits in front — otherwise anyone
 * could pick their own address and walk around rate limits.
 */
export function clientIp(req) {
  if (config.trustProxy) {
    const h = req.headers;
    const forwarded = h['cf-connecting-ip'] || String(h['x-forwarded-for'] || '').split(',')[0] || h['x-real-ip'];
    if (forwarded) return String(forwarded).trim().slice(0, 64);
  }
  return String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '').slice(0, 64);
}

/**
 * A small in-memory fixed-window limiter, keyed however the caller likes
 * (an IP, an email, both). Enough for a single panel process.
 */
export function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, v] of hits) if (v.reset <= now) hits.delete(key);
  }, Math.min(windowMs, 60_000)).unref();

  return {
    /** Count one attempt; returns seconds to wait when over the limit, else 0. */
    hit(key) {
      const now = Date.now();
      let v = hits.get(key);
      if (!v || v.reset <= now) { v = { count: 0, reset: now + windowMs }; hits.set(key, v); }
      v.count += 1;
      return v.count > max ? Math.ceil((v.reset - now) / 1000) : 0;
    },
    reset(key) { hits.delete(key); },
  };
}
