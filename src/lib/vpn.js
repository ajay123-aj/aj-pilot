/**
 * VPN client connections on a server.
 *
 * Some machines only exist inside an office network — reachable from a laptop
 * once Sophos Connect (or any OpenVPN-based VPN) is up, and from nowhere else.
 * The panel cannot join that VPN itself, but a server it manages can: give that
 * server the VPN profile, keep it connected with systemd, and then use it as the
 * jump host for the office machines.
 *
 * Each profile is an OpenVPN client config at /etc/openvpn/client/aj-<name>.conf,
 * run by Ubuntu's own `openvpn-client@` unit, so it survives reboots and
 * reconnects on its own. Sophos Firewall hands out exactly this: the user portal's
 * "SSL VPN configuration for other OSs" download is an .ovpn file.
 */

import { rootExec, assertOk } from './ssh.js';

const DIR = '/etc/openvpn/client';
const PREFIX = 'aj-';
const q = (v) => `'${String(v ?? '').replace(/'/g, `'\\''`)}'`;
const b64 = (text) => Buffer.from(String(text), 'utf8').toString('base64');

export function validateVpnName(name) {
  const clean = String(name || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(clean)) {
    return { error: 'The name takes lowercase letters, digits and dashes (for example "office"), up to 31 characters' };
  }
  return { value: clean };
}

/**
 * Make an uploaded .ovpn file run unattended:
 *  - credentials come from a root-only file instead of a prompt,
 *  - optionally ignore "send all traffic through the VPN", so the server keeps
 *    its own internet (and the panel keeps reaching it) while office routes still apply,
 *  - an old `cipher` line keeps working with OpenVPN 2.6, which negotiates ciphers.
 */
export function prepareConfig(raw, { name, hasAuth, splitTunnel }) {
  const text = String(raw || '').replace(/\r\n/g, '\n');
  if (!/^\s*(client|remote)\b/m.test(text)) {
    return { error: 'That does not look like an OpenVPN client profile (.ovpn) — it has no "client" or "remote" line' };
  }
  if (text.length > 200 * 1024) return { error: 'The profile is too large to be an .ovpn file' };

  const lines = text.split('\n').filter((l) => !/^\s*auth-user-pass\b/.test(l));
  const extra = ['', '# ---- added by AJ Pilot ----'];
  if (hasAuth || /^\s*auth-user-pass\b/m.test(text)) extra.push(`auth-user-pass ${DIR}/${PREFIX}${name}.auth`);
  if (splitTunnel) extra.push('pull-filter ignore "redirect-gateway"');

  const cipher = text.match(/^\s*cipher\s+(\S+)/m)?.[1];
  if (cipher && !/^\s*data-ciphers\b/m.test(text)) {
    extra.push(`data-ciphers AES-256-GCM:AES-128-GCM:CHACHA20-POLY1305:${cipher}`);
    extra.push(`data-ciphers-fallback ${cipher}`);
  }
  return { value: `${lines.join('\n').trimEnd()}\n${extra.join('\n')}\n` };
}

/** Is OpenVPN here, which profiles exist, and which are connected. */
export async function vpnState(conn, row) {
  const script = `
command -v openvpn >/dev/null 2>&1 && echo "installed=$(openvpn --version 2>/dev/null | head -n1 | awk '{print $2}')" || echo "installed="
for f in ${DIR}/${PREFIX}*.conf; do
  [ -e "$f" ] || continue
  n="$(basename "$f" .conf)"
  u="openvpn-client@$n"
  remote="$(awk '$1=="remote"{print $2":"$3; exit}' "$f")"
  printf 'profile\\t%s\\t%s\\t%s\\t%s\\n' "\${n#${PREFIX}}" "$(systemctl is-active "$u" 2>/dev/null)" "$(systemctl is-enabled "$u" 2>/dev/null)" "$remote"
done
ip -4 -o addr show 2>/dev/null | awk '$2 ~ /^tun|^tap/ {print "iface\\t"$2"\\t"$4}'
ip -4 route show 2>/dev/null | awk '/ dev (tun|tap)/ {print "route\\t"$0}'
`;
  const r = assertOk(await rootExec(conn, row, script, { timeout: 20000 }), 'Reading the VPN state');
  const state = { installed: false, version: null, profiles: [], interfaces: [], routes: [] };
  for (const line of r.stdout.split('\n')) {
    const [kind, ...f] = line.split('\t');
    if (line.startsWith('installed=')) {
      const v = line.slice('installed='.length).trim();
      state.installed = Boolean(v);
      state.version = v || null;
    } else if (kind === 'profile') {
      state.profiles.push({ name: f[0], active: f[1] || 'inactive', enabled: f[2] || 'disabled', remote: f[3] || '', connected: f[1] === 'active' });
    } else if (kind === 'iface') {
      state.interfaces.push({ name: f[0], address: f[1] });
    } else if (kind === 'route') {
      state.routes.push(f.join('\t').trim());
    }
  }
  return state;
}

/** The last lines OpenVPN logged for one profile. */
export async function vpnLog(conn, row, name, lines = 60) {
  const r = await rootExec(conn, row, `journalctl -u openvpn-client@${PREFIX}${name} -n ${Number(lines) || 60} --no-pager -o short-iso 2>&1`, { timeout: 20000 });
  return r.stdout.trim();
}

/**
 * Install OpenVPN if needed, write the profile (and credentials), start it now
 * and at every boot, then wait for OpenVPN to say the tunnel is up.
 */
export async function saveVpn(conn, row, { name, config, username, password, splitTunnel = true }) {
  const hasAuth = Boolean(username);
  const prepared = prepareConfig(config, { name, hasAuth, splitTunnel });
  if (prepared.error) throw new Error(prepared.error);
  if (/^\s*auth-user-pass\b/m.test(config) && !hasAuth) {
    throw new Error('This profile signs in with a username and password — enter your VPN username and password');
  }

  const unit = `openvpn-client@${PREFIX}${name}`;
  const script = `
set -e
if ! command -v openvpn >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq openvpn
fi
mkdir -p ${DIR}
umask 077
echo ${q(b64(prepared.value))} | base64 -d > ${DIR}/${PREFIX}${name}.conf
${hasAuth ? `printf '%s\\n%s\\n' ${q(username)} ${q(password || '')} > ${DIR}/${PREFIX}${name}.auth` : `rm -f ${DIR}/${PREFIX}${name}.auth`}
chmod 600 ${DIR}/${PREFIX}${name}.*
systemctl enable ${unit} >/dev/null 2>&1
since="$(date '+%Y-%m-%d %H:%M:%S')"
systemctl restart ${unit}
for i in $(seq 1 25); do
  if journalctl -u ${unit} --since "$since" --no-pager 2>/dev/null | grep -q 'Initialization Sequence Completed'; then echo "@@UP"; break; fi
  if journalctl -u ${unit} --since "$since" --no-pager 2>/dev/null | grep -qiE 'AUTH_FAILED|auth-failure|Exiting due to fatal error|Options error'; then echo "@@FAILED"; break; fi
  sleep 1
done
echo "@@LOG"
journalctl -u ${unit} --since "$since" --no-pager -o cat 2>/dev/null | tail -n 40
`;
  const r = assertOk(await rootExec(conn, row, script, { timeout: 240000 }), 'Setting up the VPN');
  const out = r.stdout;
  const log = out.split('@@LOG').pop().trim();
  if (out.includes('@@UP')) return { connected: true, log };

  let reason = 'OpenVPN did not report a connection within 25 seconds.';
  if (/AUTH_FAILED|auth-failure/i.test(log)) reason = 'The VPN refused the username or password (AUTH_FAILED). If Sophos asks for an OTP, append the code to the password.';
  else if (/Options error/i.test(log)) reason = 'OpenVPN could not read the profile — see the log below.';
  else if (/TLS key negotiation failed|Connection timed out|RESOLVE|Cannot resolve/i.test(log)) reason = 'The server could not reach the VPN gateway — check the "remote" address and that the port is open to this network.';
  const e = new Error(`${reason} The profile is saved; it keeps retrying in the background.`);
  e.cause = log;
  e.log = log;
  throw e;
}

export async function vpnAction(conn, row, name, action) {
  const unit = `openvpn-client@${PREFIX}${name}`;
  const cmd = {
    connect: `systemctl enable --now ${unit} && systemctl restart ${unit}`,
    disconnect: `systemctl disable --now ${unit}`,
    restart: `systemctl restart ${unit}`,
  }[action];
  if (!cmd) throw new Error(`Unknown action "${action}"`);
  assertOk(await rootExec(conn, row, `test -f ${DIR}/${PREFIX}${name}.conf || { echo "No VPN profile called ${name}" >&2; exit 1; }\n${cmd}`, { timeout: 30000 }), `${action} ${name}`);
  return { ok: true };
}

export async function removeVpn(conn, row, name) {
  const unit = `openvpn-client@${PREFIX}${name}`;
  assertOk(await rootExec(conn, row, `systemctl disable --now ${unit} >/dev/null 2>&1 || true\nrm -f ${DIR}/${PREFIX}${name}.conf ${DIR}/${PREFIX}${name}.auth`, { timeout: 30000 }), `Removing ${name}`);
  return { ok: true };
}
