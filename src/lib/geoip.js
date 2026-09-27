/**
 * Where a visitor's internet connection is, from their IP address.
 *
 * Behind Cloudflare the answer comes free in the request headers. Otherwise
 * the address is looked up once at ipwho.is (no key needed) and remembered
 * for a day. GEOIP=off in .env turns outside lookups off entirely.
 *
 * A private address (127.0.0.1, 192.168.x.x …) means the visitor is on the
 * same network as this server, so they share its internet connection — the
 * lookup then asks about the server's own public address, and says so.
 */

import { config } from '../config.js';

const PRIVATE = [
  /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^0\./,
  /^::1$/, /^::$/, /^f[cd][0-9a-f]{2}:/i, /^fe80:/i,
];

/** "::ffff:192.168.1.5" → "192.168.1.5". */
export const plainIp = (ip) => String(ip || '').trim().replace(/^::ffff:/i, '');
export const isPrivateIp = (ip) => !ip || PRIVATE.some((re) => re.test(plainIp(ip)));

/** The visitor's address, trusting the proxies this panel is normally behind (Cloudflare, nginx). */
export function clientIp(req) {
  const h = req.headers;
  const ip = h['cf-connecting-ip'] || String(h['x-forwarded-for'] || '').split(',')[0] || h['x-real-ip'] || req.socket.remoteAddress || '';
  return plainIp(ip).slice(0, 64);
}

/** Cloudflare's own idea of where the visitor is, when it is in front of the site. */
export function fromCloudflare(req) {
  const h = req.headers;
  const cc = String(h['cf-ipcountry'] || '').toUpperCase();
  if (!cc || cc === 'XX' || cc === 'T1') return null;
  const n = (v) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
  return {
    source: 'cloudflare',
    countryCode: cc,
    city: h['cf-ipcity'] || undefined,
    region: h['cf-region'] || undefined,
    postal: h['cf-postal-code'] || undefined,
    latitude: n(h['cf-iplatitude']),
    longitude: n(h['cf-iplongitude']),
    timezone: h['cf-timezone'] || undefined,
    continent: h['cf-ipcontinent'] || undefined,
    at: new Date().toISOString(),
  };
}

const cache = new Map();
const DAY = 86400000;

/** Look an address up; resolves to null when switched off, offline, or the service will not say. */
export async function lookupIp(ip) {
  if (String(config.geoip || '').toLowerCase() === 'off') return null;
  const local = isPrivateIp(ip);
  const key = local ? '(this server)' : plainIp(ip);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < DAY) return { ...hit.geo, local };

  try {
    const res = await fetch(`https://ipwho.is/${local ? '' : encodeURIComponent(key)}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'aj-pilot-panel' },
      signal: AbortSignal.timeout(6000),
    });
    const d = await res.json();
    if (!d || d.success === false) return null;
    const geo = {
      source: 'ipwho.is',
      ip: d.ip,
      type: d.type,
      city: d.city || undefined,
      region: d.region || undefined,
      country: d.country || undefined,
      countryCode: d.country_code || undefined,
      continent: d.continent || undefined,
      postal: d.postal || undefined,
      latitude: d.latitude,
      longitude: d.longitude,
      callingCode: d.calling_code || undefined,
      flag: d.flag?.emoji || undefined,
      timezone: d.timezone?.id || undefined,
      utcOffset: d.timezone?.utc || undefined,
      isp: d.connection?.isp || undefined,
      org: d.connection?.org || undefined,
      asn: d.connection?.asn || undefined,
      domain: d.connection?.domain || undefined,
      isEu: d.is_eu,
      at: new Date().toISOString(),
    };
    cache.set(key, { t: Date.now(), geo });
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
    return { ...geo, local };
  } catch {
    return null;
  }
}
