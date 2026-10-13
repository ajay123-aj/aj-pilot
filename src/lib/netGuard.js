/**
 * Where the panel itself may be asked to connect.
 *
 * Database and server "test connection" forms dial whatever host they are
 * given, from the panel's own machine. On a panel with open sign-up that would
 * let any tenant reach the panel's loopback, its private network and cloud
 * metadata endpoints. So targets are resolved once here and refused if they
 * land somewhere private; the caller then connects to the resolved address,
 * which keeps a DNS answer from changing between the check and the connect.
 *
 * PRIVATE_TARGETS=allow turns the check off for a single-tenant panel that
 * manages machines on its own LAN. Unset, it is allowed only while sign-up is off.
 */

import dns from 'node:dns/promises';
import net from 'node:net';

const BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

const v4ToInt = (ip) => ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;

function blockedV4(ip) {
  const n = v4ToInt(ip);
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (v4ToInt(base) & mask);
  });
}

function blockedV6(ip) {
  const v = ip.toLowerCase();
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return blockedV4(mapped[1]);
  return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || /^ff/.test(v);
}

export const isBlockedIp = (ip) => (net.isIPv4(ip) ? blockedV4(ip) : net.isIPv6(ip) ? blockedV6(ip) : true);

/*
 * Ordinary LAN ranges. Managing the machines on your own network is what the
 * panel is for, so SSH servers may live here; the panel's own loopback and the
 * cloud metadata service (169.254.169.254) stay off limits.
 */
const LAN_V4 = [['10.0.0.0', 8], ['100.64.0.0', 10], ['172.16.0.0', 12], ['192.168.0.0', 16]];
function lanIp(ip) {
  const v = ip.toLowerCase().replace(/^::ffff:(?=\d+\.)/, '');
  if (net.isIPv4(v)) {
    const n = v4ToInt(v);
    return LAN_V4.some(([base, bits]) => (n & ((~0 << (32 - bits)) >>> 0)) === (v4ToInt(base) & ((~0 << (32 - bits)) >>> 0)));
  }
  return /^f[cd]/.test(v);
}

export function privateTargetsAllowed() {
  const setting = String(process.env.PRIVATE_TARGETS || '').toLowerCase();
  if (setting === 'allow') return true;
  if (setting === 'block') return false;
  return String(process.env.ALLOW_SIGNUP ?? 'true').toLowerCase() === 'false';
}

/**
 * Resolve `host` and return an address that is safe to dial, or throw.
 * With private targets allowed, the host is returned unchanged.
 */
export async function safeTarget(host, { allowLan = false } = {}) {
  const name = String(host || '').trim().replace(/^\[|\]$/g, '');
  if (!name) throw new Error('A host is required');
  if (privateTargetsAllowed()) return name;

  let address = name;
  if (!net.isIP(name)) {
    try {
      ({ address } = await dns.lookup(name));
    } catch {
      throw new Error(`"${name}" could not be resolved`);
    }
  }
  if (isBlockedIp(address) && !(allowLan && lanIp(address))) {
    throw new Error(allowLan
      ? `"${name}" points at this panel's own machine or a reserved address (${address}), which it will not connect to.`
      : `"${name}" points at a private or reserved address (${address}). Reach it through a server or connector instead.`);
  }
  return address;
}
