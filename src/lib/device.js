/**
 * A visitor's computer, as their browser describes it.
 *
 * `cleanDevice` keeps only the fields the form sends, trimmed to sensible
 * sizes, so nothing arbitrary is stored. `describeDevice` turns that (or, for
 * older leads, just the user-agent string) into plain words: "Windows 11",
 * "Chrome 140", "Desktop", "x86 64-bit".
 */

import { createHash } from 'node:crypto';

const str = (v, n = 120) => (v === undefined || v === null || v === '' ? undefined : String(v).slice(0, n));
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : undefined);
const bool = (v) => (typeof v === 'boolean' ? v : undefined);

/** Only the known fields, each bounded; anything else the browser sent is dropped. */
export function cleanDevice(d) {
  if (!d || typeof d !== 'object') return null;
  const s = d.screen || {};
  const v = d.viewport || {};
  const c = d.connection || {};
  const u = d.uaData || {};
  const out = {
    platform: str(d.platform, 60),
    language: str(d.language, 20),
    languages: Array.isArray(d.languages) ? d.languages.slice(0, 8).map((x) => String(x).slice(0, 20)) : undefined,
    timezone: str(d.timezone, 60),
    tzOffset: num(d.tzOffset),
    screen: {
      width: num(s.width), height: num(s.height), availWidth: num(s.availWidth), availHeight: num(s.availHeight),
      colorDepth: num(s.colorDepth), pixelRatio: num(s.pixelRatio), orientation: str(s.orientation, 30),
    },
    viewport: { width: num(v.width), height: num(v.height) },
    cpuCores: num(d.cpuCores),
    memoryGb: num(d.memoryGb),
    touchPoints: num(d.touchPoints),
    cookies: bool(d.cookies),
    doNotTrack: str(d.doNotTrack, 10),
    colorScheme: str(d.colorScheme, 10),
    reducedMotion: bool(d.reducedMotion),
    gpu: str(d.gpu, 160),
    gpuVendor: str(d.gpuVendor, 80),
    connection: { type: str(c.type, 20), downlink: num(c.downlink), rtt: num(c.rtt), saveData: bool(c.saveData) },
    uaData: {
      platform: str(u.platform, 40),
      platformVersion: str(u.platformVersion, 40),
      architecture: str(u.architecture, 20),
      bitness: str(u.bitness, 10),
      model: str(u.model, 80),
      mobile: bool(u.mobile),
      brands: Array.isArray(u.fullVersionList || u.brands)
        ? (u.fullVersionList || u.brands).slice(0, 6).map((b) => ({ brand: String(b.brand || '').slice(0, 40), version: String(b.version || '').slice(0, 30) }))
        : undefined,
    },
  };
  return out;
}

const major = (v) => Number(String(v || '').split('.')[0]) || 0;

function osFrom(ua, u) {
  const p = u?.platform || '';
  const pv = u?.platformVersion || '';
  // Client hints tell Windows 11 apart from 10, which the user-agent string no longer does.
  // Its platformVersion is an internal number ("19.0.0"), not the Windows build people know, so it is not shown.
  if (p === 'Windows') return { name: major(pv) >= 13 ? 'Windows 11' : major(pv) > 0 ? 'Windows 10' : 'Windows' };
  if (p === 'macOS') return { name: 'macOS', version: pv ? pv.replace(/\.0$/, '') : undefined };
  if (p === 'Android') return { name: 'Android', version: pv || undefined };
  if (p === 'Chrome OS' || p === 'ChromeOS') return { name: 'ChromeOS', version: pv || undefined };
  if (p === 'Linux') return { name: 'Linux' };

  let m;
  if ((m = ua.match(/Windows NT (\d+\.\d+)/))) return { name: { '10.0': 'Windows 10/11', '6.3': 'Windows 8.1', '6.2': 'Windows 8', '6.1': 'Windows 7' }[m[1]] || `Windows NT ${m[1]}` };
  if ((m = ua.match(/(?:iPhone|iPad|iPod).*? OS (\d+[_\d]*)/))) return { name: /iPad/.test(ua) ? 'iPadOS' : 'iOS', version: m[1].replace(/_/g, '.') };
  if ((m = ua.match(/Android (\d+(?:\.\d+)*)/))) return { name: 'Android', version: m[1] };
  if ((m = ua.match(/Mac OS X (\d+[_.\d]*)/))) return { name: 'macOS', version: m[1].replace(/_/g, '.') };
  if (/CrOS/.test(ua)) return { name: 'ChromeOS' };
  if (/Ubuntu/.test(ua)) return { name: 'Ubuntu Linux' };
  if (/Linux/.test(ua)) return { name: 'Linux' };
  return { name: 'Unknown' };
}

function browserFrom(ua, u) {
  const brands = (u?.brands || []).filter((b) => !/not.?a.?brand/i.test(b.brand));
  const pick = (names) => brands.find((b) => names.includes(b.brand));
  const b = pick(['Microsoft Edge']) || pick(['Opera', 'Brave', 'Vivaldi', 'Yandex']) || pick(['HeadlessChrome']) || pick(['Google Chrome']) || pick(['Chromium']);
  if (b) return { name: b.brand.replace('Google ', '').replace('HeadlessChrome', 'Headless Chrome'), version: b.version };

  let m;
  if ((m = ua.match(/Edg(?:e|A|iOS)?\/([\d.]+)/))) return { name: 'Edge', version: m[1] };
  if ((m = ua.match(/OPR\/([\d.]+)/))) return { name: 'Opera', version: m[1] };
  if ((m = ua.match(/SamsungBrowser\/([\d.]+)/))) return { name: 'Samsung Internet', version: m[1] };
  if ((m = ua.match(/Firefox\/([\d.]+)/))) return { name: 'Firefox', version: m[1] };
  if ((m = ua.match(/HeadlessChrome\/([\d.]+)/))) return { name: 'Headless Chrome', version: m[1] };
  if ((m = ua.match(/Chrome\/([\d.]+)/))) return { name: 'Chrome', version: m[1] };
  if ((m = ua.match(/Version\/([\d.]+).*Safari/))) return { name: 'Safari', version: m[1] };
  if (/curl|wget|python|node|axios|go-http/i.test(ua)) return { name: 'Script / bot' };
  return { name: 'Unknown' };
}

function typeFrom(ua, d) {
  if (/iPad|Tablet/i.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))) return 'Tablet';
  if (d?.uaData?.mobile || /Mobi|iPhone|Android/i.test(ua)) return 'Phone';
  if (/bot|crawler|spider|curl|wget|python|node/i.test(ua)) return 'Bot / script';
  return 'Desktop';
}

/** Plain words for the lead page, the list and the analysis. */
export function describeDevice(device, userAgent) {
  const ua = String(userAgent || '');
  const d = device && typeof device === 'object' ? device : null;
  const os = osFrom(ua, d?.uaData);
  const browser = browserFrom(ua, d?.uaData);
  const arch = d?.uaData?.architecture ? `${d.uaData.architecture}${d.uaData.bitness ? ` ${d.uaData.bitness}-bit` : ''}` : undefined;
  return {
    os: os.name,
    osVersion: os.version,
    browser: browser.name,
    browserVersion: browser.version,
    browserMajor: browser.version ? String(browser.version).split('.')[0] : undefined,
    type: typeFrom(ua, d),
    arch,
    model: d?.uaData?.model || undefined,
  };
}

/**
 * A fingerprint of the computer: the same browser on the same machine gives
 * the same value, even under another email address. Built only from what the
 * browser reported, hashed so none of it can be read back.
 */
export function fingerprintOf(device, userAgent) {
  if (!device) return null;
  const s = device.screen || {};
  const parts = [
    userAgent, device.platform, device.uaData?.platform, device.uaData?.architecture,
    s.width, s.height, s.pixelRatio, s.colorDepth, device.timezone,
    (device.languages || []).join(','), device.cpuCores, device.memoryGb, device.gpu, device.touchPoints,
  ];
  if (parts.filter((p) => p !== undefined && p !== null && p !== '').length < 6) return null;
  return createHash('sha256').update(parts.map((p) => String(p ?? '')).join('|')).digest('hex');
}

/** How the visitor found their way to the form: a browser id kept in their browser, visits, and time spent. */
export function cleanVisit(v) {
  if (!v || typeof v !== 'object') return null;
  const id = /^[A-Za-z0-9-]{8,64}$/.test(String(v.id || '')) ? String(v.id) : null;
  const when = (x) => (x && !Number.isNaN(Date.parse(x)) ? new Date(x).toISOString() : undefined);
  const n = (x, max) => (Number.isFinite(Number(x)) && Number(x) >= 0 ? Math.min(Number(x), max) : undefined);
  return {
    id,
    firstSeen: when(v.firstSeen),
    visits: n(v.visits, 100000),
    secondsOnPage: n(v.secondsOnPage, 86400 * 7),
    firstReferrer: v.firstReferrer ? String(v.firstReferrer).slice(0, 300) : undefined,
  };
}
