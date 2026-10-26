/**
 * nginx's logs on a managed server — read, analysed, and acted on.
 *
 * The panel keeps no copy of any log. Each analysis tails the access and error
 * logs over SSH, reads the running configuration (`nginx -T`), fail2ban and the
 * firewall, and turns all of it into findings: what is wrong, the evidence, and
 * the fix — with the exact configuration to paste where there is one.
 *
 * "Installing" the analyzer adds two files to conf.d, both written through the
 * same test-then-reload path as every other nginx change here:
 *
 *   aj-pilot-logs.conf       a tab-separated log format with the host, timings
 *                            and upstream status the default "combined" lacks
 *   aj-pilot-blocklist.conf  the IPs blocked from this tab, as http-level deny
 *
 * Without it, the analysis still runs on whatever logs nginx already writes.
 */

import net from 'node:net';
import { rootExec } from './ssh.js';
import { splitSections } from './systemInfo.js';
import { parseConfigTree, writeConfigFile, nginxError } from './nginx.js';

const q = (v) => `'${String(v ?? '').replace(/'/g, `'\\''`)}'`;
const b64 = (text) => Buffer.from(String(text), 'utf8').toString('base64');
const lines = (t) => String(t || '').split('\n').map((l) => l.trim()).filter(Boolean);

export const LOG_CONF = '/etc/nginx/conf.d/aj-pilot-logs.conf';
export const BLOCK_CONF = '/etc/nginx/conf.d/aj-pilot-blocklist.conf';
export const LOG_FILE = '/var/log/nginx/aj-pilot.access.log';
const F2B_JAIL = '/etc/fail2ban/jail.d/aj-pilot-nginx.conf';

export const LINE_CHOICES = [5000, 20000, 50000, 100000];
const MAX_ACCESS_FILES = 12;
const MAX_ERROR_FILES = 4;
const ERROR_LINES = 3000;

/* ------------------------------------------------------------ addresses */

const v4ToInt = (ip) => ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;

function v6ToBig(ip) {
  let [head, tail = null] = ip.toLowerCase().split('::');
  const part = (s) => (s ? s.split(':') : []);
  let h = part(head);
  let t = tail === null ? [] : part(tail);
  // An embedded IPv4 tail ("::ffff:1.2.3.4") is two groups.
  const fix = (arr) => arr.flatMap((g) => (g.includes('.') ? [(v4ToInt(g) >>> 16).toString(16), (v4ToInt(g) & 0xffff).toString(16)] : [g]));
  h = fix(h); t = fix(t);
  const groups = tail === null ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return groups.reduce((n, g) => (n << 16n) + BigInt(parseInt(g || '0', 16)), 0n);
}

/** A single address or a CIDR range, normalised; null when it is neither. */
export function parseCidr(input) {
  const raw = String(input || '').trim().replace(/^::ffff:(?=\d+\.)/i, '');
  const [addr, bitsRaw] = raw.split('/');
  const family = net.isIP(addr);
  if (!family) return null;
  const max = family === 4 ? 32 : 128;
  const bits = bitsRaw === undefined ? max : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > max || (bitsRaw !== undefined && !/^\d+$/.test(bitsRaw))) return null;
  return { family, addr, bits, text: bits === max ? addr : `${addr}/${bits}` };
}

export function cidrContains(cidr, ip) {
  const c = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
  const plain = String(ip || '').replace(/^::ffff:(?=\d+\.)/i, '');
  const fam = net.isIP(plain);
  if (!c || !fam || fam !== c.family) return false;
  if (fam === 4) {
    const mask = c.bits === 0 ? 0 : (~0 << (32 - c.bits)) >>> 0;
    return (v4ToInt(plain) & mask) === (v4ToInt(c.addr) & mask);
  }
  const shift = BigInt(128 - c.bits);
  return (v6ToBig(plain) >> shift) === (v6ToBig(c.addr) >> shift);
}

const PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '100.64.0.0/10', '169.254.0.0/16', '::1/128', 'fc00::/7', 'fe80::/10']
  .map(parseCidr);
export const isPrivate = (ip) => PRIVATE.some((c) => cidrContains(c, ip));

// https://www.cloudflare.com/ips/ — stable for years; a new range only means a miss here, never a wrong block.
const CLOUDFLARE = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];
const CLOUDFLARE_CIDRS = CLOUDFLARE.map(parseCidr);
export const isCloudflare = (ip) => CLOUDFLARE_CIDRS.some((c) => cidrContains(c, ip));

/** An address or range that may go in the blocklist — never one that would lock out half the internet. */
export function validateBlockTarget(input) {
  const c = parseCidr(input);
  if (!c) return { error: `"${String(input || '').slice(0, 60)}" is not an IP address or CIDR range` };
  if (c.bits < (c.family === 4 ? 8 : 16)) return { error: `${c.text} is far too wide to block` };
  if (isCloudflare(c.addr)) {
    return { error: `${c.text} belongs to Cloudflare. Blocking it blocks every visitor who comes through Cloudflare — `
      + 'configure real_ip first so nginx sees the visitor\'s own address.' };
  }
  if (c.bits === (c.family === 4 ? 32 : 128) && isPrivate(c.addr)) {
    return { error: `${c.text} is a private address — usually a proxy, load balancer or this machine, not a visitor` };
  }
  return { value: c.text };
}

/* ------------------------------------------------------------- the files */

const LOG_CONF_TEXT = [
  '# Managed by AJ Pilot — nginx log analyzer.',
  '# One tab-separated line per request, with the host, timings and upstream',
  '# status the default "combined" format leaves out. Remove from the Nginx Logs tab.',
  "log_format aj_pilot '$msec\\t$remote_addr\\t$host\\t$request_method\\t$request_uri\\t$status\\t$body_bytes_sent\\t"
    + "$request_time\\t$upstream_response_time\\t$upstream_status\\t$http_referer\\t$http_user_agent\\t$http_x_forwarded_for';",
  `access_log ${LOG_FILE} aj_pilot;`,
  '',
].join('\n');

/** The blocklist as stored: `deny <ip>;  # <when> <note>`. */
function parseBlocklist(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*deny\s+([^;\s]+)\s*;\s*(?:#\s*(\S+)?\s*(.*))?$/.exec(line);
    if (!m) continue;
    const at = m[2] && !Number.isNaN(Date.parse(m[2])) ? m[2] : null;
    out.push({ ip: m[1], at, note: (at ? m[3] : [m[2], m[3]].filter(Boolean).join(' ')) || '' });
  }
  return out;
}

function blocklistText(entries) {
  const clean = (s) => String(s || '').replace(/[\r\n;#{}]/g, ' ').trim().slice(0, 120);
  return [
    '# Managed by AJ Pilot — IP blocklist, enforced at the http level.',
    '# A server or location with its own allow/deny rules does not inherit these;',
    '# include this file inside it (before its own rules) to apply them there too.',
    ...entries.map((e) => `deny ${e.ip};  # ${e.at || new Date().toISOString()} ${clean(e.note)}`.trimEnd()),
    '',
  ].join('\n');
}

async function readBlocklist(conn, server) {
  const r = await rootExec(conn, server, `cat ${q(BLOCK_CONF)} 2>/dev/null; true`, { timeout: 30000 });
  return parseBlocklist(r.stdout);
}

/* ------------------------------------------------------------ installing */

/**
 * Add the log format and an (empty) blocklist, test, reload — and make sure
 * conf.d is actually read, or the new log would never be written.
 */
export async function installAnalyzer(conn, server) {
  const pre = await rootExec(conn, server, `command -v nginx >/dev/null 2>&1 || exit 3
nginx -T 2>/dev/null | grep -q '^# configuration file /etc/nginx/conf.d/' && echo confd=yes || echo confd=no
[ -f ${q(BLOCK_CONF)} ] && echo block=yes || echo block=no`, { timeout: 60000 });
  if (pre.code === 3) throw new Error('nginx is not installed on this server yet — install it from the Nginx tab first.');
  if (pre.code !== 0) throw nginxError('Checking nginx', pre);
  if (/confd=no/.test(pre.stdout)) {
    throw new Error('This nginx does not include /etc/nginx/conf.d/*.conf in its http block, so the analyzer\'s '
      + 'log format would never be read. Add "include /etc/nginx/conf.d/*.conf;" inside http { } in nginx.conf, then install again.');
  }

  await writeConfigFile(conn, server, LOG_CONF, LOG_CONF_TEXT);
  if (/block=no/.test(pre.stdout)) await writeConfigFile(conn, server, BLOCK_CONF, blocklistText([]));

  const post = await rootExec(conn, server, `touch ${q(LOG_FILE)} 2>/dev/null
grep -qs '/var/log/nginx/' /etc/logrotate.d/nginx && echo rotate=yes || echo rotate=no`, { timeout: 30000 });
  return {
    installed: true,
    logFile: LOG_FILE,
    logrotate: /rotate=yes/.test(post.stdout),
  };
}

/** Take the log format away. The blocklist stays while it blocks anything. */
export async function removeAnalyzer(conn, server) {
  await writeConfigFile(conn, server, LOG_CONF, '', { remove: true });
  const blocked = await readBlocklist(conn, server);
  if (!blocked.length) await writeConfigFile(conn, server, BLOCK_CONF, '', { remove: true });
  return { removed: true, blocklistKept: blocked.length > 0, blocked: blocked.length };
}

/* --------------------------------------------------------- blocking IPs */

/** Add addresses to the blocklist (already-covered ones are skipped). */
export async function blockIps(conn, server, targets, note = '') {
  const current = await readBlocklist(conn, server);
  const added = [];
  for (const t of targets) {
    if (current.some((e) => e.ip === t || cidrContains(e.ip, t.split('/')[0]))) continue;
    current.push({ ip: t, at: new Date().toISOString(), note });
    added.push(t);
  }
  if (!added.length) return { added, blocked: current.length };
  await writeConfigFile(conn, server, BLOCK_CONF, blocklistText(current));
  return { added, blocked: current.length };
}

export async function unblockIps(conn, server, targets) {
  const current = await readBlocklist(conn, server);
  const keep = current.filter((e) => !targets.includes(e.ip));
  const removed = current.filter((e) => targets.includes(e.ip)).map((e) => e.ip);
  if (!removed.length) return { removed, blocked: current.length };
  await writeConfigFile(conn, server, BLOCK_CONF, blocklistText(keep));
  return { removed, blocked: keep.length };
}

/* --------------------------------------------------------------- fail2ban */

/**
 * fail2ban with the nginx jails it ships, enabled only where their filter
 * exists. If fail2ban will not start with them, the jail file is taken back out.
 */
export async function installFail2ban(conn, server) {
  const script = `set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
if ! command -v fail2ban-client >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq 2>&1 | tail -n 2
    apt-get install -y fail2ban 2>&1 | tail -n 8
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y epel-release >/dev/null 2>&1 || true
    dnf install -y fail2ban 2>&1 | tail -n 8
  elif command -v yum >/dev/null 2>&1; then
    yum install -y epel-release >/dev/null 2>&1 || true
    yum install -y fail2ban 2>&1 | tail -n 8
  fi
fi
command -v fail2ban-client >/dev/null 2>&1 || { echo "fail2ban could not be installed from this server's package manager" >&2; exit 9; }

JAIL=${q(F2B_JAIL)}
mkdir -p /etc/fail2ban/jail.d
{
  echo "# Managed by AJ Pilot — nginx jails, enabled from the Nginx Logs tab."
  for j in nginx-http-auth nginx-botsearch nginx-limit-req nginx-bad-request; do
    [ -f "/etc/fail2ban/filter.d/$j.conf" ] || continue
    printf '\\n[%s]\\nenabled  = true\\nbackend  = auto\\nport     = http,https\\nmaxretry = 5\\nfindtime = 10m\\nbantime  = 1h\\n' "$j"
    echo "enabled: $j" >&2
  done
} > "$JAIL"

systemctl enable fail2ban >/dev/null 2>&1 || true
systemctl restart fail2ban 2>&1
sleep 2
if ! fail2ban-client ping >/dev/null 2>&1; then
  echo "fail2ban would not start with the nginx jails — they were taken back out." >&2
  journalctl -u fail2ban -n 15 --no-pager 2>/dev/null >&2 || true
  rm -f "$JAIL"
  systemctl restart fail2ban >/dev/null 2>&1 || true
  exit 6
fi
echo '@@@state'
fail2ban-client status 2>/dev/null | sed -n 's/.*Jail list:[[:space:]]*//p'`;

  const result = await rootExec(conn, server, script, { timeout: 10 * 60 * 1000 });
  if (result.code !== 0) throw nginxError('Installing fail2ban', result);
  const jails = (result.stdout.split('@@@state')[1] || '').trim().split(/,\s*/).filter(Boolean);
  return { jails, log: `${result.stdout.split('@@@')[0]}\n${result.stderr}`.trim() };
}

/* ------------------------------------------------------- reading the server */

const kv = (text) => {
  const out = {};
  for (const line of lines(text)) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
};

async function readMeta(conn, server) {
  const script = `export LC_ALL=C
echo '@@@meta'
command -v nginx >/dev/null 2>&1 && echo installed=yes || echo installed=no
echo "analyzer=$([ -f ${q(LOG_CONF)} ] && echo yes || echo no)"
echo "logfile=$(stat -c %s ${q(LOG_FILE)} 2>/dev/null || echo 0)"
echo "logdir=$(du -sb /var/log/nginx 2>/dev/null | cut -f1)"
echo "logrotate=$(grep -qs '/var/log/nginx/' /etc/logrotate.d/nginx && echo yes || echo no)"
echo "now=$(date +%s)"
echo '@@@dump'
command -v nginx >/dev/null 2>&1 && nginx -T 2>/dev/null | head -c 3000000
echo
echo '@@@blocklist'
cat ${q(BLOCK_CONF)} 2>/dev/null
echo '@@@fail2ban'
if command -v fail2ban-client >/dev/null 2>&1; then
  echo "installed=yes"
  echo "active=$(systemctl is-active fail2ban 2>/dev/null || echo unknown)"
  for j in $(fail2ban-client status 2>/dev/null | sed -n 's/.*Jail list:[[:space:]]*//p' | tr ',' ' '); do
    s="$(fail2ban-client status "$j" 2>/dev/null)"
    printf 'jail=%s|%s|%s|%s\\n' "$j" \\
      "$(echo "$s" | sed -n 's/.*Currently banned:[[:space:]]*//p')" \\
      "$(echo "$s" | sed -n 's/.*Total banned:[[:space:]]*//p')" \\
      "$(echo "$s" | sed -n 's/.*Banned IP list:[[:space:]]*//p')"
  done
else
  echo "installed=no"
fi
echo '@@@firewall'
if command -v ufw >/dev/null 2>&1; then
  echo "ufw=$(ufw status 2>/dev/null | head -n1 | sed 's/^Status: //')"
  echo "ufw_deny=$(ufw status 2>/dev/null | grep -c DENY)"
fi
command -v iptables >/dev/null 2>&1 && echo "iptables_drop=$(iptables -S 2>/dev/null | grep -cE -- '-j (DROP|REJECT)')"
echo '@@@conns'
ss -Htn state established '( sport = :80 or sport = :443 )' 2>/dev/null \\
  | awk '{print $NF}' | sed 's/:[0-9]*$//; s/^\\[//; s/\\]$//; s/^::ffff://' | sort | uniq -c | sort -rn | head -n 15
echo '@@@done'
echo ok`;
  const result = await rootExec(conn, server, script, { timeout: 90000 });
  const s = splitSections(result.stdout);
  if (!s.done) throw nginxError('Reading nginx', result);
  return s;
}

/** Only plain file paths ever reach a command line. */
const safeLogPath = (p) => /^\/[A-Za-z0-9._/-]+$/.test(p) && !p.includes('..');

/** Every access_log and error_log nginx writes, with where it was declared. */
function logTargets(tree, analyzerInstalled) {
  const access = new Map();
  const errors = new Set();
  const visit = (node, parents) => {
    for (const c of node.children || []) {
      if (c.name === 'access_log' && c.args[0] && c.args[0] !== 'off' && safeLogPath(c.args[0])) {
        const level = parents.includes('server') ? 'server' : parents.includes('http') ? 'http' : 'other';
        const prev = access.get(c.args[0]);
        access.set(c.args[0], { path: c.args[0], format: c.args[1] || 'combined', levels: new Set([...(prev?.levels || []), level]) });
      }
      if (c.name === 'error_log' && c.args[0] && safeLogPath(c.args[0])) errors.add(c.args[0]);
      if (c.children) visit(c, [...parents, c.name]);
    }
  };
  if (tree) visit(tree, ['main']);

  let accessList = [...access.values()];
  if (analyzerInstalled) {
    // The analyzer's log sees every request an http-level log sees — reading both would count each twice.
    accessList = accessList.filter((a) => a.path === LOG_FILE || a.levels.has('server'));
    if (!accessList.some((a) => a.path === LOG_FILE)) accessList.unshift({ path: LOG_FILE, format: 'aj_pilot', levels: new Set(['http']) });
  }
  if (!accessList.length) accessList.push({ path: '/var/log/nginx/access.log', format: 'combined', levels: new Set(['http']) });
  if (!errors.size) errors.add('/var/log/nginx/error.log');

  return {
    access: accessList.slice(0, MAX_ACCESS_FILES).map((a) => ({ path: a.path, format: a.format })),
    errors: [...errors].slice(0, MAX_ERROR_FILES),
  };
}

async function readLogs(conn, server, targets, totalLines) {
  const per = Math.max(2000, Math.ceil(totalLines / targets.access.length));
  const tailOf = (path, n, key) => `echo '@@@${key}'
F=${q(path)}; N=${n}
if [ -f "$F" ]; then
  HAVE=$(tail -n "$N" "$F" | wc -l)
  if [ "$HAVE" -lt "$N" ] && [ -f "$F.1" ]; then tail -n $((N - HAVE)) "$F.1" | cut -c1-4000; fi
  tail -n "$N" "$F" | cut -c1-4000
else
  echo '@@@missing_${key}'
fi`;
  const script = ['export LC_ALL=C',
    ...targets.access.map((p, i) => tailOf(p.path, per, `a${i}`)),
    ...targets.errors.map((p, i) => tailOf(p, ERROR_LINES, `e${i}`)),
    "echo '@@@done'", 'echo ok'].join('\n');
  const result = await rootExec(conn, server, script, { timeout: 180000 });
  const s = splitSections(result.stdout);
  if (!s.done) throw nginxError('Reading the nginx logs', result);
  return {
    access: targets.access.map((t, i) => ({ ...t, missing: `missing_a${i}` in s, text: s[`a${i}`] || '' })),
    errors: targets.errors.map((p, i) => ({ path: p, missing: `missing_e${i}` in s, text: s[`e${i}`] || '' })),
  };
}

/* --------------------------------------------------------- parsing lines */

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** "26/Oct/2026:10:00:00 +0530" → epoch ms. */
function parseTimeLocal(t) {
  const m = /^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(t);
  if (!m) return null;
  const utc = Date.UTC(+m[3], MONTHS[m[2]] ?? 0, +m[1], +m[4], +m[5], +m[6]);
  const off = (+m[8] * 60 + +m[9]) * 60000;
  return m[7] === '+' ? utc - off : utc + off;
}

const dash = (v) => (v === '-' || v === undefined ? '' : v);
const num = (v) => {
  // "$upstream_response_time" is "0.012, 0.004" when nginx retried another server.
  const parts = String(v || '').split(/[,:]\s*/).map(Number).filter(Number.isFinite);
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
};

const COMBINED = /^(\S+) \S+ \S+ \[([^\]]+)\] "((?:[^"\\]|\\.)*)" (\d{3}) (\d+|-)(?: "((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)")?(.*)$/;

export function parseAccessLine(line) {
  if (/^\d{9,11}\.\d{3}\t/.test(line)) {
    const f = line.split('\t');
    if (f.length < 12) return null;
    return {
      ts: Math.round(Number(f[0]) * 1000), ip: f[1], host: dash(f[2]), method: dash(f[3]), uri: dash(f[4]),
      status: Number(f[5]), bytes: Number(f[6]) || 0, rt: num(f[7]), urt: num(f[8]), ustatus: dash(f[9]),
      referer: dash(f[10]), ua: dash(f[11]), xff: dash(f[12]),
    };
  }
  const m = COMBINED.exec(line);
  if (!m) return null;
  const req = m[3];
  const rm = /^([A-Z]{3,10}) (\S+)(?: HTTP\/[\d.]+)?$/.exec(req);
  // Formats like nginx's own "main" put $request_time / x-forwarded-for after the UA.
  const extra = (m[8] || '').trim();
  const rtExtra = /(?:^|\s)(\d+\.\d{3})(?:\s|$)/.exec(extra);
  return {
    ts: parseTimeLocal(m[2]), ip: m[1], host: '', method: rm ? rm[1] : '', uri: rm ? rm[2] : (req && req !== '-' ? req.slice(0, 200) : ''),
    status: Number(m[4]), bytes: Number(m[5]) || 0, rt: rtExtra ? Number(rtExtra[1]) : null, urt: null, ustatus: '',
    referer: dash(m[6]), ua: dash(m[7]), xff: '', junk: !rm,
  };
}

// 2026/10/26 10:00:00 [error] 1234#1234: *5678 message, client: 1.2.3.4, server: x, request: "GET / HTTP/1.1", upstream: "http://…", host: "x"
const ERROR_LINE = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2}) \[(\w+)\] \d+#\d+: (?:\*\d+ )?(.*)$/;

function parseErrorLine(line) {
  const m = ERROR_LINE.exec(line);
  if (!m) return null;
  const rest = m[8];
  const pick = (k) => (new RegExp(`, ${k}: "?([^",]*)"?`).exec(rest) || [])[1] || '';
  return {
    // The error log is in the server's local time, with no offset to say which; close enough to place it.
    ts: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]),
    level: m[7],
    message: rest.split(/, client: /)[0],
    client: pick('client'), server: pick('server'), upstream: pick('upstream'), request: pick('request'), host: pick('host'),
  };
}

/* ------------------------------------------------------------ the rules */

const PROBES = [
  [/\/\.env(?:[./?]|$)/i, 'env file', true],
  [/\/\.git(?:\/|$)/i, 'git repository', true],
  [/\/\.(?:svn|hg|DS_Store|aws|ssh|htpasswd|htaccess|bash_history|npmrc|docker)/i, 'hidden file', true],
  [/\/(?:[\w.-]*)(?:backup|dump|database|db|site|www)[\w.-]*\.(?:sql|zip|tar|tgz|gz|bak|7z|rar)(?:\?|$)/i, 'backup file', true],
  [/\/(?:config|settings|credentials|secrets?)\.(?:json|ya?ml|php\.bak|ini|old)(?:\?|$)/i, 'config file', true],
  [/wp-login\.php|xmlrpc\.php|\/wp-admin|\/wp-includes|\/wp-content\/plugins|wlwmanifest/i, 'WordPress probe', false],
  [/phpmyadmin|\/pma\/|\/myadmin|\/adminer/i, 'database admin probe', false],
  [/\/cgi-bin\/|\.cgi(?:\?|$)/i, 'CGI probe', false],
  [/vendor\/phpunit|eval-stdin\.php|\/think\/app|invokefunction/i, 'RCE exploit probe', false],
  [/\/(?:boaform|HNAP1|GponForm|setup\.cgi|manager\/html|jmx-console|actuator|solr\/admin|_ignition|telescope|debug\/default|console\/|\.well-known\/[^a]\w*\.php)/i, 'admin console probe', false],
  [/\.(?:php\d?|asp|aspx|jsp|cfm)(?:\?|$)/i, 'script probe', false],
];

const ATTACKS = [
  [/(?:\.\.\/|\.\.%2f|%2e%2e(?:%2f|\/)|\.\.\\)/i, 'path traversal'],
  [/(?:union(?:\s|%20|\+|\/\*\*\/)+(?:all(?:\s|%20|\+))?select|information_schema|sleep\(\d|benchmark\(|waitfor(?:\s|%20)+delay|(?:'|%27)(?:\s|%20|\+)*or(?:\s|%20|\+)+\d+(?:\s|%20)*=(?:\s|%20)*\d+)/i, 'SQL injection'],
  [/(?:<script|%3cscript|javascript:|onerror(?:=|%3d)|onload(?:=|%3d)|%3csvg|alert\()/i, 'cross-site scripting'],
  [/(?:\/etc\/passwd|\/proc\/self|cmd\.exe|\/bin\/(?:ba)?sh|(?:;|%3b|\|)(?:\s|%20)*(?:id|uname|cat|wget|curl)\b|\$\{jndi:|\$%7bjndi)/i, 'command injection'],
  [/(?:allow_url_include|auto_prepend_file|php:\/\/input|base64_decode\(|data:\/\/text)/i, 'PHP injection'],
];

const ATTACK_TOOLS = /(sqlmap|nikto|nmap|masscan|zgrab|nuclei|dirbuster|gobuster|ffuf|feroxbuster|wpscan|acunetix|nessus|openvas|w3af|hydra|zmeu|morfeus|l9explore|l9tcpid|censysinspect|expanse|netsparker|jorgee|fuzz|\$\{jndi)/i;
const SCRIPT_CLIENTS = /^(curl|wget|python-requests|python-urllib|python\/|aiohttp|go-http-client|libwww-perl|java\/|okhttp|apache-httpclient|scrapy|node-fetch|axios|php\/)/i;
const CRAWLERS = /(googlebot|bingbot|duckduckbot|baiduspider|yandex(?:bot)?|applebot|facebookexternalhit|twitterbot|linkedinbot|slackbot|discordbot|whatsapp|telegrambot)/i;
const SEO_CRAWLERS = /(ahrefsbot|semrushbot|mj12bot|dotbot|petalbot|bytespider|gptbot|claudebot|ccbot|amazonbot|dataforseobot|blexbot|serpstatbot|barkrowler|seekportbot)/i;
const LOGIN = /(?:wp-login\.php|xmlrpc\.php|\/log-?in\b|\/sign-?in\b|\/auth(?:enticate)?\b|\/session|\/user\/login|\/account\/login|\/api\/(?:v\d+\/)?(?:auth|login|token)|\/oauth\/token|\/admin(?:\/login)?\/?$)/i;
const ADMIN_LOCATION = /(admin|phpmyadmin|adminer|grafana|kibana|portainer|prometheus|netdata|pgadmin|rabbitmq|traefik|dashboard|\/manage)/i;

/** "/users/123/edit?x=1" → "/users/:id/edit" — so the same endpoint adds up. */
function normalizePath(uri) {
  const path = String(uri || '').split('?')[0] || '/';
  return path
    .split('/')
    .map((seg) => (/^\d+$/.test(seg) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) || /^[0-9a-f]{24,}$/i.test(seg) ? ':id' : seg))
    .join('/')
    .slice(0, 180);
}

const classOf = (s) => (s >= 500 ? '5xx' : s >= 400 ? '4xx' : s >= 300 ? '3xx' : s >= 200 ? '2xx' : 'other');

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

const round = (n, d = 3) => (n === null || n === undefined ? null : Math.round(n * 10 ** d) / 10 ** d);
const top = (map, n, by = (v) => v) => [...map.entries()].sort((a, b) => by(b[1]) - by(a[1])).slice(0, n);

/* --------------------------------------------------- the configuration */

/** Walk the tree keeping the actual parent nodes, so a rule knows its server and location. */
function walkNodes(node, fn, parents = []) {
  fn(node, parents);
  for (const c of node.children || []) walkNodes(c, fn, [...parents, node]);
}

function scopeOf(node, parents) {
  const chain = [...parents, node];
  const server = chain.find((p) => p.name === 'server');
  const names = server ? (server.children || []).filter((c) => c.name === 'server_name').flatMap((c) => c.args) : [];
  const location = [...chain].reverse().find((p) => p.name === 'location');
  // nginx -T prints included files on their own, so conf.d lands at the top level — which is http.
  const where = node.name === 'http' || node.name === 'main' ? 'all sites (http)'
    : server ? `${names[0] || '(default server)'}${location ? ` · location ${location.args.join(' ')}` : ''}` : node.name;
  return { where, file: node.file || chain.find((p) => p.file)?.file || '', server: names[0] || null, location: location ? location.args.join(' ') : null };
}

function configFacts(tree, blocklist) {
  const facts = {
    serverTokensOff: false, rateZones: [], rateApplied: 0, connZones: [], connApplied: 0,
    realIpFrom: [], realIpHeader: null, autoindex: [], oldTls: [], bodySize: [], ruleBlocks: [],
    adminOpen: [], dotfilesDenied: false, defaultCatchAll: false, serverNames: new Set(),
  };
  if (!tree) return facts;

  walkNodes(tree, (node, parents) => {
    const scope = () => scopeOf(node, parents);
    const args = node.args || [];
    switch (node.name) {
      case 'server_tokens': if (args[0] === 'off') facts.serverTokensOff = true; break;
      case 'limit_req_zone': facts.rateZones.push({ zone: (args.find((a) => a.startsWith('zone=')) || '').slice(5), key: args[0], rate: (args.find((a) => a.startsWith('rate=')) || '').slice(5) }); break;
      case 'limit_req': facts.rateApplied += 1; break;
      case 'limit_conn_zone': facts.connZones.push(args.join(' ')); break;
      case 'limit_conn': facts.connApplied += 1; break;
      case 'set_real_ip_from': facts.realIpFrom.push(args[0]); break;
      case 'real_ip_header': facts.realIpHeader = args[0]; break;
      case 'autoindex': if (args[0] === 'on') facts.autoindex.push(scopeOf(node, parents)); break;
      case 'ssl_protocols': if (args.some((a) => /^(SSLv[23]|TLSv1|TLSv1\.1)$/.test(a))) facts.oldTls.push({ ...scopeOf(node, parents), value: args.join(' ') }); break;
      case 'client_max_body_size': facts.bodySize.push({ ...scopeOf(node, parents), value: args[0] }); break;
      case 'server_name': args.forEach((n) => facts.serverNames.add(n.toLowerCase())); break;
      default: break;
    }

    if (!node.children) return;
    const kids = node.children;

    if (node.name === 'server') {
      const isDefault = kids.some((c) => c.name === 'listen' && c.args.includes('default_server'));
      const drops = kids.some((c) => c.name === 'return' && ['444', '403', '404'].includes(c.args[0]));
      if (isDefault && drops) facts.defaultCatchAll = true;
    }

    if (node.name === 'location' && args.some((a) => /\\\.|\/\\\.|\/\./.test(a))) {
      if (kids.some((c) => c.name === 'deny' && c.args[0] === 'all') || kids.some((c) => c.name === 'return' && /^40[34]$/.test(c.args[0]))) {
        facts.dotfilesDenied = true;
      }
    }

    // allow/deny in this block, in order — nginx stops at the first rule that matches.
    const all = kids.filter((c) => c.name === 'allow' || c.name === 'deny').map((c) => ({ action: c.name, value: c.args[0], file: c.file }));
    const includesBlocklist = all.some((r) => r.file === BLOCK_CONF);
    const rules = all.filter((r) => r.file !== BLOCK_CONF);
    const hasAuth = kids.some((c) => c.name === 'auth_basic' && c.args[0] !== 'off') || kids.some((c) => c.name === 'auth_request');

    if (node.name === 'location' && ADMIN_LOCATION.test(args.join(' ')) && !rules.length && !hasAuth) {
      const enclosing = [...parents].reverse().find((p) => p.name === 'server');
      const inherited = enclosing && (enclosing.children || []).some((c) => c.name === 'allow' || c.name === 'deny' || c.name === 'auth_basic');
      if (!inherited) facts.adminOpen.push(scope());
    }

    if (!rules.length) return;
    const problems = [];
    const allIdx = rules.findIndex((r) => r.value === 'all');
    if (allIdx >= 0 && allIdx < rules.length - 1) {
      problems.push(`"${rules[allIdx].action} all" comes before ${rules.length - allIdx - 1} other rule(s); nginx stops at the first match, so those never apply`);
    }
    if (rules.some((r) => r.action === 'allow') && !rules.some((r) => r.action === 'deny')) {
      problems.push('only "allow" rules and no "deny all" — everyone is still let in, the allow list restricts nothing');
    }
    if (rules.some((r) => r.action === 'allow' && (r.value === '0.0.0.0/0' || r.value === '::/0'))) {
      problems.push('allows 0.0.0.0/0 — the whole internet');
    }
    const httpLevel = node.name === 'http' || node.name === 'main';
    facts.ruleBlocks.push({
      ...scope(), file: [...new Set(rules.map((r) => r.file))].join(', '), context: node.name, rules, problems,
      // A block with its own allow/deny does not inherit the http-level blocklist.
      overridesBlocklist: !httpLevel && !includesBlocklist && blocklist.length > 0,
    });
  });

  return facts;
}

/* ---------------------------------------------------------- the analysis */

export function analyze({ accessFiles, errorFiles, tree, blocklist, fail2ban, firewall, conns, meta }) {
  const ips = new Map();
  const paths = new Map();
  const hosts = new Map();
  const agents = new Map();
  const minutes = new Map();
  const minuteClasses = new Map();
  const codes = {};
  const classes = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 };
  const methods = {};
  const exposures = new Map();
  const times = [];
  const blocked = blocklist.map((b) => ({ ...b, cidr: parseCidr(b.ip), atMs: b.at ? Date.parse(b.at) : null }));
  const f2bBanned = new Set(fail2ban.jails.flatMap((j) => j.banned));
  const throughBlock = new Map();

  let requests = 0;
  let bytes = 0;
  let unparsed = 0;
  let from = Infinity;
  let to = -Infinity;
  let hasHost = false;
  let hasTimings = false;
  let xffSeen = 0;

  const sources = [];

  for (const file of accessFiles) {
    let count = 0;
    for (const line of file.text.split('\n')) {
      if (!line.trim()) continue;
      const e = parseAccessLine(line);
      if (!e || !e.ip || !Number.isFinite(e.status)) { unparsed += 1; continue; }
      count += 1;
      requests += 1;
      bytes += e.bytes;
      if (e.ts) { from = Math.min(from, e.ts); to = Math.max(to, e.ts); }
      if (e.host) hasHost = true;
      if (e.rt !== null) { hasTimings = true; if (times.length < 200000) times.push(e.rt); }
      if (e.xff) xffSeen += 1;

      const cls = classOf(e.status);
      classes[cls] += 1;
      codes[e.status] = (codes[e.status] || 0) + 1;
      if (e.method) methods[e.method] = (methods[e.method] || 0) + 1;
      const minute = e.ts ? Math.floor(e.ts / 60000) : null;
      if (minute !== null) {
        minutes.set(minute, (minutes.get(minute) || 0) + 1);
        const m = minuteClasses.get(minute) || [0, 0, 0, 0];
        m[cls === '5xx' ? 3 : cls === '4xx' ? 2 : cls === '3xx' ? 1 : 0] += 1;
        minuteClasses.set(minute, m);
      }

      const uri = e.uri || '';
      let decoded = uri;
      try { decoded = decodeURIComponent(uri); } catch { /* keep it raw */ }
      const probe = PROBES.find(([re]) => re.test(uri));
      const attack = ATTACKS.find(([re]) => re.test(uri) || re.test(decoded) || re.test(e.ua));
      const isLogin = e.method === 'POST' && LOGIN.test(uri);

      // IP
      let ip = ips.get(e.ip);
      if (!ip) {
        ip = {
          ip: e.ip, requests: 0, bytes: 0, c4: 0, c5: 0, c404: 0, c401: 0, c403: 0, c429: 0, probes: 0, probeKinds: new Set(),
          attacks: 0, attackKinds: new Set(), loginPosts: 0, loginFails: 0, junk: 0, emptyUa: 0, uas: new Map(), paths: new Set(),
          first: e.ts, last: e.ts, perMin: new Map(), hosts: new Set(),
        };
        ips.set(e.ip, ip);
      }
      ip.requests += 1;
      ip.bytes += e.bytes;
      if (cls === '4xx') ip.c4 += 1;
      if (cls === '5xx') ip.c5 += 1;
      if (e.status === 404) ip.c404 += 1;
      if (e.status === 401) ip.c401 += 1;
      if (e.status === 403) ip.c403 += 1;
      if (e.status === 429) ip.c429 += 1;
      if (probe && e.status >= 400) { ip.probes += 1; ip.probeKinds.add(probe[1]); }
      if (attack) { ip.attacks += 1; ip.attackKinds.add(attack[1]); }
      if (isLogin) { ip.loginPosts += 1; if ([401, 403, 429].includes(e.status) || (e.status === 200 && /wp-login|xmlrpc/.test(uri))) ip.loginFails += 1; }
      if (e.junk || (e.status === 400 && !e.method)) ip.junk += 1;
      if (!e.ua) ip.emptyUa += 1;
      if (ip.uas.size < 4 || ip.uas.has(e.ua)) ip.uas.set(e.ua, (ip.uas.get(e.ua) || 0) + 1);
      if (ip.paths.size < 300) ip.paths.add(normalizePath(uri));
      if (e.host && ip.hosts.size < 10) ip.hosts.add(e.host);
      if (e.ts) { ip.first = Math.min(ip.first ?? e.ts, e.ts); ip.last = Math.max(ip.last ?? e.ts, e.ts); }
      if (minute !== null) ip.perMin.set(minute, (ip.perMin.get(minute) || 0) + 1);

      // Sensitive files that were actually served.
      if (probe && probe[2] && e.status === 200 && e.bytes > 0) {
        const key = normalizePath(uri);
        const x = exposures.get(key) || { path: key, kind: probe[1], hits: 0, ips: new Set(), bytes: 0 };
        x.hits += 1; x.bytes += e.bytes; x.ips.add(e.ip);
        exposures.set(key, x);
      }

      // A blocked address that still got an answer after it was blocked.
      if (e.status < 400) {
        const b = blocked.find((x) => x.cidr && cidrContains(x.cidr, e.ip) && (!x.atMs || (e.ts && e.ts > x.atMs + 60000)));
        if (b) {
          const t = throughBlock.get(b.ip) || { ip: b.ip, hits: 0, hosts: new Set(), paths: new Set() };
          t.hits += 1; if (e.host) t.hosts.add(e.host); if (t.paths.size < 5) t.paths.add(normalizePath(uri));
          throughBlock.set(b.ip, t);
        }
      }

      // Path
      if (!probe || e.status < 400) {
        const key = `${e.host ? `${e.host} ` : ''}${normalizePath(uri)}`;
        let p = paths.get(key);
        if (!p) { p = { path: normalizePath(uri), host: e.host, requests: 0, c404: 0, c5: 0, codes5: {}, bytes: 0, times: [], ips: new Set() }; paths.set(key, p); }
        p.requests += 1;
        p.bytes += e.bytes;
        if (e.status === 404) p.c404 += 1;
        if (cls === '5xx') { p.c5 += 1; p.codes5[e.status] = (p.codes5[e.status] || 0) + 1; }
        if (e.rt !== null && p.times.length < 2000) p.times.push(e.rt);
        if (p.ips.size < 1000) p.ips.add(e.ip);
      }

      if (e.host) {
        const h = hosts.get(e.host) || { host: e.host, requests: 0, c4: 0, c5: 0, bytes: 0 };
        h.requests += 1; h.bytes += e.bytes; if (cls === '4xx') h.c4 += 1; if (cls === '5xx') h.c5 += 1;
        hosts.set(e.host, h);
      }

      const ua = e.ua || '(none)';
      const a = agents.get(ua) || { ua, requests: 0, ips: new Set() };
      a.requests += 1; if (a.ips.size < 500) a.ips.add(e.ip);
      agents.set(ua, a);
    }
    sources.push({ kind: 'access', path: file.path, lines: count, missing: file.missing });
  }

  const spanMin = Number.isFinite(from) ? Math.max(1, Math.round((to - from) / 60000)) : 0;

  /* ---------------------------------------------- score every address */
  const cfShare = { requests: 0 };
  const privShare = { requests: 0 };
  const scored = [...ips.values()].map((ip) => {
    let peak = 0;
    for (const n of ip.perMin.values()) if (n > peak) peak = n;
    const ua = top(ip.uas, 1)[0]?.[0] || '';
    const cloudflare = isCloudflare(ip.ip);
    const priv = isPrivate(ip.ip);
    if (cloudflare) cfShare.requests += ip.requests;
    if (priv) privShare.requests += ip.requests;

    const flags = [];
    let score = 0;
    if (ip.attacks) { score += Math.min(60, 25 + ip.attacks * 5); flags.push(...[...ip.attackKinds].map((k) => `attack: ${k}`)); }
    if (ip.probes >= 3) { score += Math.min(45, ip.probes * 3); flags.push(`scanner (${[...ip.probeKinds].slice(0, 3).join(', ')})`); }
    if (ATTACK_TOOLS.test(ua)) { score += 45; flags.push('attack tool'); }
    else if (SCRIPT_CLIENTS.test(ua)) { score += 5; flags.push('script client'); }
    if (ip.loginPosts >= 15 && ip.loginFails >= 10) { score += 50; flags.push(`brute force (${ip.loginPosts} login attempts)`); }
    else if (ip.loginPosts >= 30) { score += 30; flags.push(`${ip.loginPosts} login attempts`); }
    if (peak >= 600) { score += 45; flags.push(`flood (${peak} req/min)`); }
    else if (peak >= 240) { score += 25; flags.push(`high rate (${peak} req/min)`); }
    if (ip.requests >= 30 && ip.c4 / ip.requests >= 0.7) { score += 20; flags.push(`${Math.round((ip.c4 / ip.requests) * 100)}% errors`); }
    if (ip.junk) { score += Math.min(20, ip.junk * 5); flags.push('malformed requests'); }
    if (ip.emptyUa === ip.requests && ip.requests >= 10) { score += 10; flags.push('no user agent'); }
    if (SEO_CRAWLERS.test(ua) && ip.requests >= 1000) { score += 15; flags.push('aggressive crawler'); }
    if (CRAWLERS.test(ua) && !ip.attacks && !ip.probes) { score = Math.max(0, score - 20); flags.push('search crawler'); }
    score = Math.min(100, score);

    const blockedBy = blocked.find((b) => b.cidr && cidrContains(b.cidr, ip.ip)) ? 'nginx' : f2bBanned.has(ip.ip) ? 'fail2ban' : null;
    // Never suggest blocking an address that stands for many visitors.
    const verdict = cloudflare || priv ? 'proxy' : blockedBy ? 'blocked' : score >= 60 ? 'block' : score >= 30 ? 'watch' : 'ok';

    return {
      ip: ip.ip, requests: ip.requests, share: requests ? round(ip.requests / requests, 4) : 0, bytes: ip.bytes,
      c4: ip.c4, c5: ip.c5, c404: ip.c404, c401: ip.c401, c403: ip.c403, c429: ip.c429,
      probes: ip.probes, attacks: ip.attacks, loginPosts: ip.loginPosts, peakPerMin: peak,
      first: ip.first, last: ip.last, ua, hosts: [...ip.hosts], samplePaths: [...ip.paths].slice(0, 8),
      flags, score, verdict, blockedBy, cloudflare, private: priv, _perMin: ip.perMin,
    };
  });

  const byThreat = [...scored].sort((a, b) => b.score - a.score || b.requests - a.requests);
  const toBlock = byThreat.filter((x) => x.verdict === 'block');

  /* -------------------------------------------------- error log */
  const errGroups = new Map();
  const levels = {};
  let errTotal = 0;
  const errorSources = [];
  for (const file of errorFiles) {
    let count = 0;
    for (const line of file.text.split('\n')) {
      const e = parseErrorLine(line.trim());
      if (!e) continue;
      count += 1; errTotal += 1;
      levels[e.level] = (levels[e.level] || 0) + 1;
      const cat = ERROR_KINDS.find((k) => k.re.test(e.message));
      const key = cat ? cat.key : e.message.replace(/"[^"]*"/g, '"…"').replace(/\d+/g, '#').slice(0, 160);
      const g = errGroups.get(key) || { key, kind: cat?.key || null, title: cat?.title || null, level: e.level, count: 0, last: 0, sample: e.message.slice(0, 300), servers: new Set(), upstreams: new Set(), clients: new Set() };
      g.count += 1; g.last = Math.max(g.last, e.ts);
      if (e.server && g.servers.size < 10) g.servers.add(e.server);
      if (e.upstream && g.upstreams.size < 10) g.upstreams.add(e.upstream.replace(/^(https?:\/\/[^/]+).*/, '$1'));
      if (e.client && g.clients.size < 500) g.clients.add(e.client);
      errGroups.set(key, g);
    }
    errorSources.push({ kind: 'error', path: file.path, lines: count, missing: file.missing });
  }
  const errorList = [...errGroups.values()].sort((a, b) => b.count - a.count).map((g) => ({
    ...g, servers: [...g.servers], upstreams: [...g.upstreams], clients: g.clients.size,
  }));

  /* --------------------------------------------------- findings */
  const cfg = configFacts(tree, blocklist);
  const findings = [];
  const add = (f) => findings.push(f);
  const pctOf = (n) => (requests ? `${((n / requests) * 100).toFixed(n / requests < 0.01 ? 2 : 1)}%` : '0%');

  // Sensitive files served.
  for (const x of exposures.values()) {
    add({
      severity: 'critical', category: 'security', title: `${x.kind === 'env file' ? 'A .env file' : `A ${x.kind}`} is downloadable: ${x.path}`,
      detail: `It answered 200 with ${x.bytes} bytes to ${x.ips.size} address(es) ${x.hits} time(s). Anything secret in it — database passwords, API keys — must be treated as leaked.`,
      evidence: [...x.ips].slice(0, 8).map((i) => `served to ${i}`),
      solution: 'Block dotfiles and backups in every site, move the file out of the web root, then rotate every secret it held.',
      snippet: 'location ~ /\\.(?!well-known) {\n    deny all;\n    return 404;\n}\nlocation ~* \\.(sql|bak|old|swp|tar|tgz|gz|zip|7z)$ {\n    deny all;\n    return 404;\n}',
    });
  }

  // Blocklist leaking past.
  for (const t of throughBlock.values()) {
    add({
      severity: 'high', category: 'restriction', title: `Blocked ${t.ip} is still being served`,
      detail: `${t.hits} request(s) after it was blocked got a normal answer${t.hosts.size ? ` from ${[...t.hosts].join(', ')}` : ''}. `
        + 'A server or location with its own allow/deny rules does not inherit the http-level blocklist.',
      evidence: [...t.paths],
      solution: 'Include the blocklist at the top of that server\'s (or location\'s) own rules, or block the address in the firewall instead.',
      snippet: `# inside the server { } or location { } that has its own allow/deny, before them:\ninclude ${BLOCK_CONF};`,
    });
  }

  // Attackers.
  if (toBlock.length) {
    const kinds = [...new Set(toBlock.flatMap((x) => x.flags))].slice(0, 6);
    add({
      severity: toBlock.some((x) => x.attacks) ? 'high' : 'medium', category: 'security',
      title: `${toBlock.length} address(es) are attacking or scanning this server`,
      detail: `Seen: ${kinds.join('; ')}. Together they sent ${toBlock.reduce((s, x) => s + x.requests, 0)} request(s).`,
      evidence: toBlock.slice(0, 8).map((x) => `${x.ip} — ${x.requests} req, score ${x.score}: ${x.flags.join(', ')}`),
      solution: 'Block them in nginx now. For the next ones, let fail2ban ban repeat offenders automatically, and add rate limiting.',
      action: { kind: 'block', label: `Block ${toBlock.length} address(es)`, ips: toBlock.map((x) => x.ip) },
    });
  }

  // Brute force on logins.
  const brute = scored.filter((x) => x.flags.some((f) => f.startsWith('brute force')));
  if (brute.length) {
    add({
      severity: 'high', category: 'security', title: `Password guessing against login pages from ${brute.length} address(es)`,
      detail: `${brute.reduce((s, x) => s + x.loginPosts, 0)} POSTs to login endpoints, mostly failing.`,
      evidence: brute.slice(0, 6).map((x) => `${x.ip}: ${x.loginPosts} login attempts`),
      solution: 'Rate-limit the login endpoint per address, and ban repeat failures with fail2ban. For WordPress, block xmlrpc.php outright if nothing uses it.',
      snippet: '# http { } level (e.g. /etc/nginx/conf.d/rate-limit.conf):\nlimit_req_zone $binary_remote_addr zone=login:10m rate=5r/m;\nlimit_req_status 429;\n\n# in the site:\nlocation ~ ^/(login|wp-login\\.php|api/auth) {\n    limit_req zone=login burst=5 nodelay;\n    proxy_pass http://your_backend;   # whatever this location already does\n}\nlocation = /xmlrpc.php { deny all; }',
    });
  }

  // Real visitor IP lost behind a proxy.
  const cfPct = requests ? cfShare.requests / requests : 0;
  const privPct = requests ? privShare.requests / requests : 0;
  if (cfPct >= 0.3 && !cfg.realIpHeader) {
    add({
      severity: 'high', category: 'restriction', title: 'Cloudflare is in front, but nginx logs and blocks Cloudflare\'s addresses',
      detail: `${Math.round(cfPct * 100)}% of requests come from Cloudflare ranges. Without real_ip, every allow/deny rule, rate limit and fail2ban ban applies to Cloudflare's edge — blocking one attacker blocks everyone behind that edge, and attackers are invisible here.`,
      solution: 'Tell nginx to trust Cloudflare\'s CF-Connecting-IP header from Cloudflare\'s own ranges only. Then block abusive countries/ASNs in Cloudflare\'s firewall rules, and individual IPs here.',
      snippet: `# /etc/nginx/conf.d/cloudflare-real-ip.conf\n${CLOUDFLARE.map((c) => `set_real_ip_from ${c};`).join('\n')}\nreal_ip_header CF-Connecting-IP;`,
    });
  } else if (privPct >= 0.5 && !cfg.realIpHeader) {
    add({
      severity: 'medium', category: 'restriction', title: 'Most traffic arrives from a private address — a proxy or load balancer',
      detail: `${Math.round(privPct * 100)}% of requests come from private addresses${xffSeen ? ', with X-Forwarded-For set' : ''}. IP rules and rate limits see the proxy, not the visitor.`,
      solution: 'If a load balancer or another proxy sits in front, trust its X-Forwarded-For — only from that proxy\'s address.',
      snippet: '# /etc/nginx/conf.d/real-ip.conf — use your proxy\'s address\nset_real_ip_from 10.0.0.0/8;\nreal_ip_header X-Forwarded-For;\nreal_ip_recursive on;',
    });
  }

  // Rule-order mistakes and blocks that ignore the blocklist.
  for (const r of cfg.ruleBlocks.filter((x) => x.problems.length)) {
    add({
      severity: 'high', category: 'restriction', title: `IP restriction does not do what it looks like: ${r.where}`,
      detail: r.problems.join('. '),
      evidence: [`${r.file}`, ...r.rules.map((x) => `${x.action} ${x.value};`)].slice(0, 10),
      solution: 'List the specific rules first and end with the catch-all. To allow only some addresses, end with "deny all;". To block some, list the denies and leave the rest allowed.',
      snippet: '# allow only these, refuse everyone else:\nallow 203.0.113.10;      # office\nallow 198.51.100.0/24;   # VPN\ndeny  all;',
    });
  }
  const overriding = cfg.ruleBlocks.filter((x) => x.overridesBlocklist);
  if (overriding.length) {
    add({
      severity: 'medium', category: 'restriction', title: `The blocklist is not applied in ${overriding.length} place(s) with their own allow/deny`,
      detail: 'nginx only inherits allow/deny from the http level when a block has none of its own, so these skip the panel\'s blocklist entirely.',
      evidence: overriding.map((x) => `${x.where} (${x.file})`),
      solution: 'Include the blocklist at the start of each, before its own rules.',
      snippet: `include ${BLOCK_CONF};`,
    });
  }

  // Admin areas without any restriction.
  if (cfg.adminOpen.length) {
    add({
      severity: 'medium', category: 'restriction', title: 'Admin areas are open to the whole internet',
      detail: 'These locations look like admin panels or dashboards and have no allow/deny or password in front of them.',
      evidence: cfg.adminOpen.map((x) => `${x.where} (${x.file})`).slice(0, 10),
      solution: 'Restrict them to your own addresses (office, VPN), or put basic auth in front.',
      snippet: 'location /admin {\n    allow 203.0.113.10;   # your office / VPN\n    deny  all;\n    # … what the location already does\n}',
    });
  }

  // Rate limiting.
  const abuse = toBlock.length > 0 || brute.length > 0 || scored.some((x) => x.peakPerMin >= 240 && x.verdict !== 'proxy');
  if (!cfg.rateZones.length) {
    add({
      severity: abuse ? 'high' : 'medium', category: 'restriction', title: 'No rate limiting is configured',
      detail: abuse ? 'Abusive traffic was found above and nothing limits how fast a single address may send requests.'
        : 'A single address can send as many requests as it likes; one script can take the backends down.',
      solution: 'Add a per-address request limit and connection limit, then apply them to the sites.',
      snippet: '# /etc/nginx/conf.d/rate-limit.conf (http level)\nlimit_req_zone  $binary_remote_addr zone=perip:10m rate=10r/s;\nlimit_conn_zone $binary_remote_addr zone=conns:10m;\nlimit_req_status  429;\nlimit_conn_status 429;\n\n# inside each server { }:\nlimit_req  zone=perip burst=40 nodelay;\nlimit_conn conns 30;',
    });
  } else if (!cfg.rateApplied) {
    add({
      severity: 'medium', category: 'restriction', title: 'Rate-limit zones exist but nothing uses them',
      detail: `limit_req_zone ${cfg.rateZones.map((z) => z.zone).join(', ')} is defined but no "limit_req" directive applies it, so no request is limited.`,
      solution: 'Add limit_req to the server or location blocks you want limited.',
      snippet: `limit_req zone=${cfg.rateZones[0].zone || 'perip'} burst=40 nodelay;`,
    });
  }

  // fail2ban.
  const nginxJails = fail2ban.jails.filter((j) => /nginx/i.test(j.name));
  if (!fail2ban.installed && (toBlock.length || brute.length)) {
    add({
      severity: 'medium', category: 'restriction', title: 'Nothing bans attackers automatically',
      detail: 'Blocking by hand only stops the addresses seen so far. fail2ban watches the nginx logs and bans repeat offenders in the firewall for an hour.',
      solution: 'Install fail2ban with its nginx jails (http-auth, botsearch, limit-req, bad-request).',
      action: { kind: 'fail2ban', label: 'Install fail2ban with nginx jails' },
    });
  } else if (fail2ban.installed && fail2ban.active !== 'active') {
    add({
      severity: 'high', category: 'restriction', title: 'fail2ban is installed but not running',
      detail: `systemctl reports "${fail2ban.active}", so nothing is being banned.`,
      solution: 'Reinstalling the nginx jails restarts it and shows why it would not start.',
      action: { kind: 'fail2ban', label: 'Set up fail2ban again' },
    });
  } else if (fail2ban.installed && !nginxJails.length && (toBlock.length || brute.length)) {
    add({
      severity: 'medium', category: 'restriction', title: 'fail2ban runs, but watches nothing in nginx',
      detail: `Its jails are: ${fail2ban.jails.map((j) => j.name).join(', ') || 'none'}.`,
      solution: 'Enable the nginx jails fail2ban ships with.',
      action: { kind: 'fail2ban', label: 'Enable the nginx jails' },
    });
  }

  // Server errors.
  const c5 = classes['5xx'];
  if (c5 >= 10 && c5 / Math.max(1, requests) >= 0.01) {
    const worst = [...paths.values()].filter((p) => p.c5).sort((a, b) => b.c5 - a.c5).slice(0, 6);
    const codeList = Object.entries(codes).filter(([c]) => c >= 500).sort((a, b) => b[1] - a[1]);
    const main = Number(codeList[0]?.[0]);
    add({
      severity: c5 / requests >= 0.05 ? 'high' : 'medium', category: 'errors',
      title: `${pctOf(c5)} of requests fail with a server error`,
      detail: `${codeList.map(([c, n]) => `${n}× ${c}`).join(', ')}. ${SERVER_ERROR_HELP[main] || ''}`,
      evidence: worst.map((p) => `${p.host ? `${p.host} ` : ''}${p.path} — ${p.c5} error(s) (${Object.entries(p.codes5).map(([c, n]) => `${n}× ${c}`).join(', ')})`),
      solution: SERVER_ERROR_FIX[main] || 'Check the application\'s own logs for the failing paths above.',
      snippet: main === 504 ? '# in the location that proxies to the slow backend:\nproxy_connect_timeout 10s;\nproxy_read_timeout    120s;\nproxy_send_timeout    120s;' : undefined,
    });
  }

  const c499 = codes[499] || 0;
  if (c499 >= 20 && c499 / requests >= 0.02) {
    add({
      severity: 'medium', category: 'performance', title: `${pctOf(c499)} of visitors gave up before the answer came (499)`,
      detail: 'A 499 is logged when the client closes the connection first — nearly always because the backend was too slow.',
      evidence: [...paths.values()].filter((p) => p.times.length).sort((a, b) => percentile(b.times, 95) - percentile(a.times, 95)).slice(0, 5)
        .map((p) => `${p.path} — p95 ${round(percentile(p.times, 95), 2)}s`),
      solution: 'Speed up the slow endpoints listed under "Slowest endpoints", or cache them.',
    });
  }

  if (codes[413]) {
    add({
      severity: 'medium', category: 'errors', title: `${codes[413]} upload(s) were refused as too large (413)`,
      detail: `nginx refuses request bodies above client_max_body_size (${cfg.bodySize.map((b) => `${b.value} in ${b.where}`).join(', ') || 'default 1m'}).`,
      solution: 'Raise the limit in the site that takes uploads.',
      snippet: 'client_max_body_size 50m;',
    });
  }

  // Slow endpoints.
  const allP95 = percentile(times, 95);
  const slow = [...paths.values()].filter((p) => p.times.length >= 5).map((p) => ({
    path: p.path, host: p.host, requests: p.requests, p95: round(percentile(p.times, 95), 3), avg: round(p.times.reduce((a, b) => a + b, 0) / p.times.length, 3),
    max: round(Math.max(...p.times), 3),
  })).sort((a, b) => b.p95 - a.p95).slice(0, 15);
  const verySlow = slow.filter((s) => s.p95 >= 2 && s.requests >= 20);
  if (verySlow.length) {
    add({
      severity: verySlow.some((s) => s.p95 >= 5) ? 'high' : 'medium', category: 'performance',
      title: `${verySlow.length} endpoint(s) take over 2 seconds for 1 in 20 requests`,
      detail: `Overall p95 is ${round(allP95, 2)}s.`,
      evidence: verySlow.slice(0, 6).map((s) => `${s.host ? `${s.host} ` : ''}${s.path} — p95 ${s.p95}s, avg ${s.avg}s, ${s.requests} req`),
      solution: 'Profile these endpoints in the application (slow queries are the usual cause). For pages that are the same for everyone, nginx can cache the response.',
      snippet: '# http level:\nproxy_cache_path /var/cache/nginx/app levels=1:2 keys_zone=app:20m max_size=1g inactive=10m;\n\n# in the location:\nproxy_cache app;\nproxy_cache_valid 200 1m;\nproxy_cache_use_stale error timeout updating;',
    });
  }

  // Missing files real visitors keep asking for.
  const missing = [...paths.values()].filter((p) => p.c404 >= 20 && p.ips.size >= 3).sort((a, b) => b.c404 - a.c404).slice(0, 8);
  if (missing.length) {
    add({
      severity: 'low', category: 'errors', title: `${missing.length} path(s) keep answering 404`,
      detail: 'Broken links or missing assets that many different visitors ask for (scanner probes are left out).',
      evidence: missing.map((p) => `${p.host ? `${p.host} ` : ''}${p.path} — ${p.c404}× from ${p.ips.size} visitors`),
      solution: 'Add the missing file (favicon.ico, robots.txt and apple-touch-icon are the usual ones), fix the link, or redirect the old URL.',
    });
  }

  // Spikes.
  const perMin = [...minutes.values()];
  if (perMin.length >= 10) {
    const median = percentile(perMin, 50) || 1;
    const [peakMin, peak] = [...minutes.entries()].sort((a, b) => b[1] - a[1])[0];
    if (peak >= 120 && peak >= median * 10) {
      const contributors = scored.map((x) => [x.ip, x._perMin.get(peakMin) || 0]).filter(([, n]) => n).sort((a, b) => b[1] - a[1]).slice(0, 5);
      add({
        severity: 'medium', category: 'performance', title: `Traffic spike: ${peak} requests in one minute (${Math.round(peak / median)}× normal)`,
        detail: `At ${new Date(peakMin * 60000).toISOString().replace('T', ' ').slice(0, 16)} UTC, against a median of ${median}/min.`,
        evidence: contributors.map(([ipAddr, n]) => `${ipAddr}: ${n} requests that minute`),
        solution: contributors[0] && contributors[0][1] / peak > 0.5
          ? 'One address made most of it — block it, and add rate limiting so the next one cannot.'
          : 'Spread across many addresses — likely real traffic or a distributed flood. Rate limiting and Cloudflare (or similar) in front absorb the second.',
      });
    }
  }

  // Requests for this server's bare IP / unknown host names.
  if (hasHost) {
    const unknown = [...hosts.values()].filter((h) => net.isIP(h.host) || !servesHost(cfg.serverNames, h.host));
    const n = unknown.reduce((s, h) => s + h.requests, 0);
    if (n >= 100 && !cfg.defaultCatchAll) {
      add({
        severity: 'low', category: 'security', title: `${n} request(s) were for hosts this server does not serve`,
        detail: 'Bots reach servers by IP address and get whichever site nginx picks as the default — which leaks that site to scanners.',
        evidence: unknown.sort((a, b) => b.requests - a.requests).slice(0, 6).map((h) => `${h.host}: ${h.requests}`),
        solution: 'Add a catch-all default server that closes the connection without answering.',
        snippet: 'server {\n    listen 80 default_server;\n    listen [::]:80 default_server;\n    server_name _;\n    return 444;\n}',
      });
    }
  }

  // Error-log based.
  for (const g of errorList.filter((x) => x.kind && x.count >= (ERROR_KINDS.find((k) => k.key === x.kind).min || 5)).slice(0, 8)) {
    const k = ERROR_KINDS.find((x) => x.key === g.kind);
    add({
      severity: k.severity, category: k.category || 'errors', title: `${k.title} (${g.count}× in the error log)`,
      detail: k.detail,
      evidence: [g.sample, ...g.upstreams.map((u) => `upstream ${u}`), ...g.servers.map((sv) => `server ${sv}`)].slice(0, 6),
      solution: k.solution, snippet: k.snippet,
    });
  }

  // Configuration hygiene.
  if (cfg.autoindex.length) {
    add({
      severity: 'medium', category: 'config', title: 'Directory listing is switched on',
      detail: 'autoindex on shows every file in a folder to anyone who asks.',
      evidence: cfg.autoindex.map((x) => `${x.where} (${x.file})`),
      solution: 'Turn it off unless the folder is meant to be browsed.',
      snippet: 'autoindex off;',
    });
  }
  if (cfg.oldTls.length) {
    add({
      severity: 'medium', category: 'config', title: 'Outdated TLS versions are accepted',
      detail: 'TLS 1.0 and 1.1 are broken and no current browser needs them.',
      evidence: cfg.oldTls.map((x) => `${x.where}: ssl_protocols ${x.value}`),
      solution: 'Accept TLS 1.2 and 1.3 only.',
      snippet: 'ssl_protocols TLSv1.2 TLSv1.3;',
    });
  }
  if (!cfg.serverTokensOff) {
    add({
      severity: 'low', category: 'config', title: 'nginx tells everyone its exact version',
      detail: 'Every error page and the Server header carry the version number, which helps attackers match known bugs.',
      solution: 'Hide it at the http level.',
      snippet: '# /etc/nginx/conf.d/hardening.conf\nserver_tokens off;',
    });
  }
  if (!cfg.dotfilesDenied && !exposures.size && scored.some((x) => x.probes)) {
    add({
      severity: 'low', category: 'security', title: 'Hidden files are not explicitly blocked',
      detail: 'Scanners are asking for .env, .git and similar. They answered 404 today, but nothing stops one being served if it ever lands in a web root.',
      solution: 'Deny dotfiles in every site.',
      snippet: 'location ~ /\\.(?!well-known) {\n    deny all;\n    return 404;\n}',
    });
  }
  if (meta.logrotate === 'no') {
    add({
      severity: 'medium', category: 'maintenance', title: 'nginx logs are not rotated',
      detail: 'Without logrotate the logs grow until the disk is full — and a full disk stops nginx writing anything.',
      solution: 'Add a logrotate rule for /var/log/nginx.',
      snippet: '# /etc/logrotate.d/nginx\n/var/log/nginx/*.log {\n    daily\n    rotate 14\n    missingok\n    compress\n    delaycompress\n    notifempty\n    sharedscripts\n    postrotate\n        [ -s /run/nginx.pid ] && kill -USR1 $(cat /run/nginx.pid)\n    endscript\n}',
    });
  }
  const logDir = Number(meta.logdir || 0);
  if (logDir > 2 * 1024 ** 3) {
    add({
      severity: 'low', category: 'maintenance', title: `nginx logs take ${(logDir / 1024 ** 3).toFixed(1)} GB`,
      detail: 'Old rotated logs are piling up.',
      solution: 'Keep fewer rotations (rotate 7) and compress them, or remove the old *.gz files.',
    });
  }
  if (!meta.analyzer && requests) {
    add({
      severity: 'info', category: 'maintenance', title: 'Install the analyzer for timings and per-site figures',
      detail: hasTimings ? 'The current log format has no host name, so figures cannot be split per site.'
        : 'The current log format records neither response time nor host, so slow endpoints and per-site figures cannot be shown.',
      solution: 'The analyzer adds its own log format beside the existing logs; nothing else changes.',
      action: { kind: 'install', label: 'Install the log analyzer' },
    });
  }

  const RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  findings.sort((a, b) => RANK[a.severity] - RANK[b.severity]);

  /* -------------------------------------------------- the report */
  const publicIp = (x) => { const { _perMin, ...rest } = x; return rest; };
  return {
    sources: [...sources, ...errorSources],
    unparsed,
    range: Number.isFinite(from) ? { from: new Date(from).toISOString(), to: new Date(to).toISOString(), minutes: spanMin } : null,
    totals: {
      requests, bytes, ips: ips.size, perMinute: spanMin ? round(requests / spanMin, 1) : null,
      classes, codes, methods, hasTimings, hasHost,
      p50: round(percentile(times, 50), 3), p95: round(allP95, 3), p99: round(percentile(times, 99), 3),
      threats: toBlock.length, watch: scored.filter((x) => x.verdict === 'watch').length,
    },
    findings,
    timeline: timelineOf(minuteClasses, from, to),
    ips: byThreat.filter((x) => x.score > 0 || x.blockedBy).slice(0, 60).map(publicIp),
    topIps: [...scored].sort((a, b) => b.requests - a.requests).slice(0, 25).map(publicIp),
    paths: {
      top: [...paths.values()].sort((a, b) => b.requests - a.requests).slice(0, 20).map(pathOut),
      notFound: [...paths.values()].filter((p) => p.c404).sort((a, b) => b.c404 - a.c404).slice(0, 15).map(pathOut),
      errors: [...paths.values()].filter((p) => p.c5).sort((a, b) => b.c5 - a.c5).slice(0, 15).map(pathOut),
      bandwidth: [...paths.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 10).map(pathOut),
      slow,
    },
    hosts: [...hosts.values()].sort((a, b) => b.requests - a.requests).slice(0, 20),
    agents: [...agents.values()].sort((a, b) => b.requests - a.requests).slice(0, 15).map((a) => ({
      ua: a.ua, requests: a.requests, ips: a.ips.size,
      kind: ATTACK_TOOLS.test(a.ua) ? 'attack tool' : CRAWLERS.test(a.ua) ? 'search crawler' : SEO_CRAWLERS.test(a.ua) ? 'SEO / AI crawler'
        : SCRIPT_CLIENTS.test(a.ua) ? 'script' : a.ua === '(none)' ? 'none' : 'browser / app',
    })),
    errors: { total: errTotal, levels, groups: errorList.slice(0, 25) },
    restrictions: {
      blocklist,
      rules: cfg.ruleBlocks,
      realIp: { header: cfg.realIpHeader, from: cfg.realIpFrom.length, cloudflareShare: round(cfPct, 3), privateShare: round(privPct, 3) },
      rateLimits: { zones: cfg.rateZones, applied: cfg.rateApplied, connZones: cfg.connZones.length, connApplied: cfg.connApplied },
      fail2ban, firewall,
    },
    liveConnections: conns,
  };
}

/**
 * Requests over time in at most 60 buckets of a round size (1 min … 1 day),
 * split ok / redirect / client error / server error — what the timeline draws.
 */
function timelineOf(minuteClasses, from, to) {
  if (!Number.isFinite(from) || !minuteClasses.size) return null;
  const first = Math.floor(from / 60000);
  const last = Math.floor(to / 60000);
  const span = last - first + 1;
  const size = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440].find((s) => span / s <= 60) || 1440;
  const start = Math.floor(first / size) * size;
  const count = Math.floor((last - start) / size) + 1;
  const buckets = Array.from({ length: count }, (_, i) => ({ at: new Date((start + i * size) * 60000).toISOString(), ok: 0, redirect: 0, client: 0, server: 0 }));
  for (const [minute, [ok, redirect, client, server]] of minuteClasses) {
    const b = buckets[Math.floor((minute - start) / size)];
    if (!b) continue;
    b.ok += ok; b.redirect += redirect; b.client += client; b.server += server;
  }
  return { bucketMinutes: size, buckets };
}

/** Whether a server_name list (exact, *.wildcard, .suffix or ~regex) covers a host. */
function servesHost(names, host) {
  const h = String(host || '').toLowerCase().replace(/:\d+$/, '');
  for (const n of names) {
    if (n === h) return true;
    if (n.startsWith('*.') && h.endsWith(n.slice(1))) return true;
    if (n.startsWith('.') && (h === n.slice(1) || h.endsWith(n))) return true;
    if (n.endsWith('.*') && h.startsWith(n.slice(0, -1))) return true;
    if (n.startsWith('~')) { try { if (new RegExp(n.slice(1), 'i').test(h)) return true; } catch { /* not a JS-compatible regex */ } }
  }
  return false;
}

function pathOut(p) {
  return {
    path: p.path, host: p.host, requests: p.requests, c404: p.c404, c5: p.c5, codes5: p.codes5, bytes: p.bytes, visitors: p.ips.size,
    p95: p.times.length ? round(percentile(p.times, 95), 3) : null,
  };
}

const SERVER_ERROR_HELP = {
  500: 'A 500 is the application itself failing.',
  502: 'A 502 means nginx could not get an answer from the backend at all — it is down, crashing, or on another port.',
  503: 'A 503 is usually nginx\'s own rate limit or a backend that says it is unavailable.',
  504: 'A 504 means the backend answered too slowly and nginx gave up waiting.',
};
const SERVER_ERROR_FIX = {
  500: 'Read the application\'s logs for the failing paths — the stack trace is there, not in nginx.',
  502: 'Check the backend is running and listening where proxy_pass points (the Nginx tab shows whether each backend answers). Restart policies (systemd Restart=always, docker --restart) keep a crashing app coming back.',
  503: 'If limit_req is set, check the burst is big enough for real visitors; otherwise check the backend\'s health.',
  504: 'Find out why the backend is slow; if the work genuinely takes long, raise nginx\'s proxy timeouts for that location only.',
};

const ERROR_KINDS = [
  {
    key: 'refused', re: /connect\(\) failed \(111: Connection refused\) while connecting to upstream/, title: 'Backend refused connections',
    severity: 'high', detail: 'nginx tried to reach the backend and nothing was listening — every one of these was a 502 to a visitor.',
    solution: 'Start the backend, or fix proxy_pass to point at the port it really listens on. Make it restart on its own when it crashes.',
  },
  {
    key: 'timeout', re: /upstream timed out \(110/, title: 'Backend too slow — upstream timed out',
    severity: 'high', detail: 'The backend took longer than proxy_read_timeout (60s by default) — visitors got a 504.',
    solution: 'Fix the slow work in the application, or raise the timeout only for the location that legitimately needs it.',
    snippet: 'proxy_read_timeout 180s;',
  },
  {
    key: 'nolive', re: /no live upstreams/, title: 'Every server in an upstream was marked down',
    severity: 'high', detail: 'After max_fails errors nginx stops trying a server for fail_timeout; when all are down, every request fails.',
    solution: 'Bring the backends back; consider a backup server in the upstream.',
  },
  {
    key: 'bigbody', re: /client intended to send too large body/, title: 'Uploads larger than client_max_body_size', min: 1,
    severity: 'medium', detail: 'Visitors got a 413 for these uploads.', solution: 'Raise the limit in the site that takes uploads.',
    snippet: 'client_max_body_size 50m;',
  },
  {
    key: 'workers', re: /worker_connections are not enough/, title: 'nginx ran out of connections', min: 1,
    severity: 'high', detail: 'Each worker can hold worker_connections at once; beyond that, new visitors are dropped.',
    solution: 'Raise worker_connections and the open-file limit together (nginx.conf, top level and events).',
    snippet: 'worker_rlimit_nofile 65535;\nevents {\n    worker_connections 8192;\n}',
  },
  {
    key: 'nofile', re: /Too many open files/, title: 'Out of file descriptors', min: 1,
    severity: 'high', detail: 'The operating system refused nginx more open files or sockets.',
    solution: 'Raise the limit for nginx.', snippet: '# nginx.conf, top level:\nworker_rlimit_nofile 65535;\n\n# systemctl edit nginx\n[Service]\nLimitNOFILE=65535',
  },
  {
    key: 'bigheader', re: /upstream sent too big header/, title: 'Backend response headers too large', min: 1,
    severity: 'medium', detail: 'Large cookies or headers from the backend overflow nginx\'s buffer — the visitor gets a 502.',
    solution: 'Give the proxy bigger header buffers.', snippet: 'proxy_buffer_size 16k;\nproxy_buffers 8 16k;\nproxy_busy_buffers_size 32k;',
  },
  {
    key: 'tempfile', re: /an upstream response is buffered to a temporary file/, title: 'Responses spill to disk', min: 20,
    severity: 'low', category: 'performance', detail: 'Responses bigger than the proxy buffers are written to disk first, which is slow.',
    solution: 'Raise the proxy buffers, or turn buffering off for streaming endpoints.', snippet: 'proxy_buffers 16 32k;',
  },
  {
    key: 'limited', re: /limiting (?:requests|connections)/, title: 'Rate limits are rejecting requests', min: 20,
    severity: 'low', category: 'restriction', detail: 'limit_req / limit_conn are working. If the clients in the log are real visitors, the limit is too tight.',
    solution: 'Check the addresses being limited; raise burst if they are real visitors, block them if not.',
  },
  {
    key: 'forbidden', re: /access forbidden by rule/, title: 'Requests refused by allow/deny rules', min: 50,
    severity: 'info', category: 'restriction', detail: 'Your IP restrictions are refusing these — expected, unless a real visitor is among them.',
    solution: 'Nothing to do unless someone legitimate is locked out.',
  },
  {
    key: 'permission', re: /\(13: Permission denied\)/, title: 'nginx cannot read files or sockets', min: 1,
    severity: 'high', detail: 'The nginx user (www-data or nginx) has no permission on a file, folder or socket it is asked to serve.',
    solution: 'Give the nginx user read access to the web root (and execute on each parent folder), or fix the socket\'s owner.',
  },
  {
    key: 'nofile404', re: /open\(\) ".*" failed \(2: No such file or directory\)/, title: 'Files asked for that do not exist', min: 200,
    severity: 'low', detail: 'Mostly scanners, but also broken links and missing assets.', solution: 'See the "keep answering 404" finding for the paths real visitors ask for.',
  },
  {
    key: 'dirindex', re: /directory index of .* is forbidden/, title: 'Folders without an index file', min: 20,
    severity: 'low', detail: 'A request for a folder found no index.html and listing is off — the visitor got a 403.',
    solution: 'Add an index file, or check the root/try_files of that site.',
  },
  {
    key: 'ssl', re: /SSL_do_handshake\(\) failed|ssl_handshake|SSL_read\(\) failed/i, title: 'TLS handshakes failing', min: 200,
    severity: 'info', detail: 'Usually scanners speaking old or broken TLS. Only a problem if real visitors complain.',
    solution: 'Nothing to do unless certificates are expired (see the Nginx tab).',
  },
];

/* ------------------------------------------------------------ entry point */

/** Read everything and analyse it. `lines` is how far back to look. */
export async function nginxLogReport(conn, server, { lines: wanted = 20000 } = {}) {
  const totalLines = LINE_CHOICES.includes(Number(wanted)) ? Number(wanted) : 20000;
  const s = await readMeta(conn, server);
  const meta = kv(s.meta);

  if (meta.installed !== 'yes') return { nginxInstalled: false };

  const analyzerInstalled = meta.analyzer === 'yes';
  const tree = s.dump ? parseConfigTree(s.dump) : null;
  const blocklist = parseBlocklist(s.blocklist);

  const f2b = { installed: false, active: null, jails: [] };
  for (const line of lines(s.fail2ban)) {
    if (line === 'installed=yes') f2b.installed = true;
    else if (line.startsWith('active=')) f2b.active = line.slice(7);
    else if (line.startsWith('jail=')) {
      const [name, current, total, list] = line.slice(5).split('|');
      f2b.jails.push({ name, current: Number(current) || 0, total: Number(total) || 0, banned: String(list || '').split(/\s+/).filter(Boolean).slice(0, 200) });
    }
  }
  const fw = kv(s.firewall);
  const firewall = { ufw: fw.ufw || null, ufwDeny: Number(fw.ufw_deny || 0), iptablesDrop: Number(fw.iptables_drop || 0) };
  const conns = lines(s.conns).map((l) => { const [count, ip] = l.split(/\s+/); return { ip, count: Number(count) }; })
    .filter((c) => c.ip).map((c) => ({ ...c, cloudflare: isCloudflare(c.ip), private: isPrivate(c.ip) }));

  const targets = logTargets(tree, analyzerInstalled);
  const logs = await readLogs(conn, server, targets, totalLines);

  const report = analyze({
    accessFiles: logs.access, errorFiles: logs.errors, tree, blocklist, fail2ban: f2b, firewall, conns,
    meta: { ...meta, analyzer: analyzerInstalled },
  });

  return {
    nginxInstalled: true,
    analyzer: {
      installed: analyzerInstalled,
      logFile: LOG_FILE,
      logBytes: Number(meta.logfile || 0),
      logDirBytes: Number(meta.logdir || 0),
      logrotate: meta.logrotate === 'yes',
    },
    lines: totalLines,
    readAt: meta.now ? new Date(Number(meta.now) * 1000).toISOString() : new Date().toISOString(),
    ...report,
  };
}
