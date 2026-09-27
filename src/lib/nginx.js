/**
 * nginx and its certificates on a managed server.
 *
 * Everything here reads or writes the server's own nginx — the panel does not
 * keep a copy of anything. A domain is a file in `sites-available` symlinked
 * into `sites-enabled` (or, on a server whose nginx.conf does not include that
 * directory, a file in `conf.d`), and the file itself is the truth.
 *
 * Nothing is ever reloaded without `nginx -t` passing first: every write keeps
 * a backup, tests the configuration, and puts the old file back if the test
 * fails. A bad domain cannot take the web server down.
 */

import { rootExec } from './ssh.js';
import { splitSections } from './systemInfo.js';

const q = (v) => `'${String(v ?? '').replace(/'/g, `'\\''`)}'`;
const b64 = (text) => Buffer.from(String(text), 'utf8').toString('base64');
const lines = (t) => String(t || '').split('\n').map((l) => l.trim()).filter(Boolean);

/** A hostname, or a wildcard one. Anything else never reaches a command line. */
export function validateDomain(name, what = 'domain') {
  const clean = String(name || '').trim().toLowerCase();
  if (!clean) return { error: `A ${what} is required` };
  if (clean.length > 253) return { error: `That ${what} is too long` };
  if (!/^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(clean)
    && !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(clean)) {
    return { error: `"${clean}" is not a valid ${what}` };
  }
  return { value: clean };
}

/** The file a domain is stored as. Derived from the domain, never typed. */
export function validateSiteName(name) {
  const clean = String(name || '').trim().toLowerCase().replace(/\.conf$/, '');
  if (!/^[a-z0-9][a-z0-9._-]{0,80}$/.test(clean)) return { error: `"${name}" is not a site this panel wrote` };
  return { value: clean };
}

/* ----------------------------------------------------------- reading it */

/**
 * Everything the Nginx tab shows, in one pass: whether nginx is there and
 * running, what its configuration test says, every site it serves with the
 * certificate it uses, and the same for certbot.
 */
export async function nginxState(conn, server) {
  const script = `export LC_ALL=C
echo '@@@nginx'
if command -v nginx >/dev/null 2>&1; then
  echo "installed=yes"
  echo "version=$(nginx -v 2>&1 | sed 's#.*nginx/##')"
  echo "active=$(systemctl is-active nginx 2>/dev/null || echo unknown)"
  echo "enabled=$(systemctl is-enabled nginx 2>/dev/null || echo unknown)"
  echo "conf=$(nginx -V 2>&1 | tr ' ' '\\n' | sed -n 's/^--conf-path=//p' | head -n1)"
  echo "started=$(systemctl show nginx -p ActiveEnterTimestamp --value 2>/dev/null)"
  echo "workers=$(pgrep -c -f 'nginx: worker' 2>/dev/null || echo 0)"
  echo "include_sites=$(grep -qs 'sites-enabled' /etc/nginx/nginx.conf && echo yes || echo no)"
else
  echo "installed=no"
fi
echo '@@@configtest'
command -v nginx >/dev/null 2>&1 && nginx -t 2>&1 | tail -n 6
echo '@@@ports'
(ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep -i nginx | awk '{print $4}' | sort -u
echo '@@@sites'
for f in /etc/nginx/sites-available/* /etc/nginx/conf.d/*.conf; do
  [ -f "$f" ] || continue
  base="$(basename "$f")"
  case "$f" in
    /etc/nginx/conf.d/*) enabled=yes ;;
    *) if [ -e "/etc/nginx/sites-enabled/$base" ]; then enabled=yes; else enabled=no; fi ;;
  esac
  names="$(sed -n 's/^[[:space:]]*server_name[[:space:]]\\+\\([^;]*\\);.*/\\1/p' "$f" | tr '\\n' ' ' | tr -s ' ')"
  listens="$(sed -n 's/^[[:space:]]*listen[[:space:]]\\+\\([^;]*\\);.*/\\1/p' "$f" | tr '\\n' ',' | tr -s ' ')"
  cert="$(sed -n 's/^[[:space:]]*ssl_certificate[[:space:]]\\+\\([^;]*\\);.*/\\1/p' "$f" | head -n1)"
  root="$(sed -n 's/^[[:space:]]*root[[:space:]]\\+\\([^;]*\\);.*/\\1/p' "$f" | head -n1)"
  proxy="$(sed -n 's/^[[:space:]]*proxy_pass[[:space:]]\\+\\([^;]*\\);.*/\\1/p' "$f" | head -n1)"
  mine="$(grep -qsE '^# Managed by (AJ Pilot|Auto Deploy)' "$f" && echo yes || echo no)"
  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$base" "$f" "$enabled" "$names" "$listens" "$cert" "$root" "$proxy" "$mine"
done
echo '@@@dump'
command -v nginx >/dev/null 2>&1 && nginx -T 2>/dev/null | head -c 2000000
echo
echo '@@@listening'
ss -ltnpH 2>/dev/null || netstat -ltnp 2>/dev/null | tail -n +3
echo '@@@containers'
command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}' 2>/dev/null
echo '@@@certbot'
if command -v certbot >/dev/null 2>&1; then
  echo "installed=yes"
  echo "version=$(certbot --version 2>&1 | head -n1)"
  echo "timer=$(systemctl is-active certbot.timer 2>/dev/null || echo none)"
  echo "plugin=$(certbot plugins --nginx 2>/dev/null | grep -c nginx || echo 0)"
  echo "webroot=$( [ -d /var/www/html ] && echo yes || echo no)"
else
  echo "installed=no"
fi
echo '@@@certs'
command -v certbot >/dev/null 2>&1 && certbot certificates 2>/dev/null | grep -v '^[[:space:]]*$'
echo '@@@done'
echo ok`;

  const result = await rootExec(conn, server, script, { timeout: 90000 });
  const s = splitSections(result.stdout);
  if (!s.done) {
    throw new Error(`Could not read nginx on this server: ${(result.stderr || result.stdout || '').trim().slice(0, 300)}`);
  }

  const kv = (text) => {
    const out = {};
    for (const line of lines(text)) {
      const i = line.indexOf('=');
      if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
    }
    return out;
  };

  const n = kv(s.nginx);
  const cb = kv(s.certbot);
  const certificates = parseCertificates(s.certs);
  const sites = parseSites(s.sites, certificates);
  const upstream = await upstreamDetails(conn, server, s.dump, s.listening, s.containers);

  return {
    installed: n.installed === 'yes',
    version: n.version || null,
    active: n.active || 'unknown',
    enabled: n.enabled || 'unknown',
    running: n.active === 'active',
    confPath: n.conf || '/etc/nginx/nginx.conf',
    startedAt: n.started || null,
    workers: Number(n.workers || 0),
    includesSitesEnabled: n.include_sites === 'yes',
    configTest: {
      output: (s.configtest || '').trim(),
      ok: /syntax is ok/i.test(s.configtest || '') && /test is successful/i.test(s.configtest || ''),
    },
    ports: lines(s.ports),
    sites,
    ...upstream,
    certbot: {
      installed: cb.installed === 'yes',
      version: cb.version || null,
      autoRenew: cb.timer === 'active',
      timer: cb.timer || 'none',
      nginxPlugin: Number(cb.plugin || 0) > 0,
      certificates,
    },
  };
}

/* ------------------------------------------------ upstreams and backends */

/**
 * The configuration nginx actually runs (`nginx -T`) as a tree of blocks:
 * every directive is { name, args, file, children? }. Comments are dropped
 * and quoted strings kept whole.
 */
function parseConfigTree(dump) {
  const root = { name: 'main', args: [], children: [] };
  const stack = [root];
  let file = null;
  let words = [];

  for (const raw of String(dump || '').split('\n')) {
    const header = /^# configuration file (.+):$/.exec(raw);
    if (header) { file = header[1]; continue; }
    const tokens = raw.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|#.*$|[{};]|[^\s{};"'#]+(?:#[^\s{};]*)?/g) || [];
    for (const t of tokens) {
      if (t.startsWith('#')) break;
      if (t === '{' || t === ';') {
        if (words.length) {
          const node = { name: words[0], args: words.slice(1).map((w) => w.replace(/^["']|["']$/g, '')), file };
          if (t === '{') { node.children = []; stack.at(-1).children.push(node); stack.push(node); }
          else stack.at(-1).children.push(node);
        }
        words = [];
      } else if (t === '}') {
        if (stack.length > 1) stack.pop();
        words = [];
      } else {
        words.push(t);
      }
    }
  }
  return root;
}

const walk = (node, fn, parents = []) => {
  fn(node, parents);
  (node.children || []).forEach((c) => walk(c, fn, [...parents, node.name]));
};
const directive = (node, name) => (node.children || []).filter((c) => c.name === name);

/** "host:port", "[::1]:8080", "unix:/run/x.sock" or "host" (port 80) as parts. */
function parseAddress(addr, defaultPort = 80) {
  const a = String(addr || '');
  if (a.startsWith('unix:')) return { kind: 'unix', path: a.slice(5), address: a };
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(a);
  if (v6) return { kind: 'tcp', host: v6[1], port: Number(v6[2] || defaultPort), address: a };
  const m = /^([^:/]+)(?::(\d+))?$/.exec(a);
  if (m) return { kind: 'tcp', host: m[1], port: Number(m[2] || defaultPort), address: a };
  return { kind: 'unknown', address: a };
}

/** A proxy_pass / fastcgi_pass target: an upstream by name, an address, or a variable. */
function parseTarget(value, upstreamNames) {
  const v = String(value || '');
  const url = /^(https?|grpcs?|uwsgi):\/\/([^/]+)(\/.*)?$/i.exec(v);
  const hostPart = url ? url[2] : v;
  // A variable in the path still goes to a known host; only a variable host is unknowable.
  if (upstreamNames.has(hostPart)) return { kind: 'upstream', upstream: hostPart, address: v };
  if (hostPart.includes('$')) return { kind: 'variable', address: v };
  const scheme = url ? url[1].toLowerCase() : null;
  return { ...parseAddress(hostPart, scheme === 'https' || scheme === 'grpcs' ? 443 : 80), address: v };
}

/** `server 127.0.0.1:3000 weight=2 max_fails=3 backup;` inside an upstream. */
function parseUpstreamServer(args) {
  const [addr, ...params] = args;
  const opt = {};
  for (const p of params) {
    const [k, v] = p.split('=');
    opt[k] = v === undefined ? true : v;
  }
  return {
    ...parseAddress(addr),
    weight: Number(opt.weight || 1),
    maxFails: opt.max_fails !== undefined ? Number(opt.max_fails) : 1,
    failTimeout: opt.fail_timeout || '10s',
    maxConns: opt.max_conns !== undefined ? Number(opt.max_conns) : null,
    backup: Boolean(opt.backup),
    down: Boolean(opt.down),
    resolve: Boolean(opt.resolve),
  };
}

/** `ss -ltnpH` as { address, host, port, processes }. */
function parseListening(text) {
  const out = [];
  for (const line of lines(text)) {
    const cols = line.split(/\s+/);
    // ss: State Recv-Q Send-Q Local Peer [Process]; netstat: Proto Recv Send Local Foreign State PID/Program
    const local = cols[0] === 'LISTEN' ? cols[3] : /^tcp/.test(cols[0]) ? cols[3] : null;
    if (!local) continue;
    const i = local.lastIndexOf(':');
    const port = Number(local.slice(i + 1));
    if (!port) continue;
    const processes = [...line.matchAll(/\("([^"]+)",pid=(\d+)/g)].map((m) => ({ name: m[1], pid: Number(m[2]) }));
    const ns = /(\d+)\/([^\s]+)\s*$/.exec(line);
    if (!processes.length && ns && cols[0] !== 'LISTEN') processes.push({ name: ns[2], pid: Number(ns[1]) });
    out.push({ address: local, host: local.slice(0, i).replace(/^\[|\]$/g, ''), port, processes });
  }
  // One row per port and address, with every process that holds it.
  const merged = new Map();
  for (const l of out) {
    const key = `${l.host}|${l.port}`;
    const prev = merged.get(key);
    if (prev) prev.processes.push(...l.processes.filter((p) => !prev.processes.some((q2) => q2.pid === p.pid)));
    else merged.set(key, l);
  }
  return [...merged.values()].sort((a, b) => a.port - b.port || a.host.localeCompare(b.host));
}

/** `docker ps` port columns as host port → container. */
function parseContainerPorts(text) {
  const map = new Map();
  for (const line of lines(text)) {
    const [name, image, ports] = line.split('\t');
    for (const m of String(ports || '').matchAll(/(?:[\d.]+|\[?::\]?):(\d+)(?:-(\d+))?->(\d+)(?:-\d+)?\/(tcp|udp)/g)) {
      if (m[4] !== 'tcp') continue;
      const from = Number(m[1]);
      const to = Number(m[2] || m[1]);
      for (let p = from; p <= to && p - from < 100; p++) {
        if (!map.has(p)) map.set(p, { name, image, containerPort: Number(m[3]) + (p - from) });
      }
    }
  }
  return map;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '::', '*']);

/** Ask the server itself whether each backend answers, two seconds each. */
async function probeBackends(conn, server, targets) {
  const safe = targets.filter((t) => (t.kind === 'tcp' && /^[A-Za-z0-9._:-]+$/.test(t.host) && t.port > 0 && t.port < 65536)
    || (t.kind === 'unix' && /^\/[A-Za-z0-9._/-]+$/.test(t.path))).slice(0, 60);
  if (!safe.length) return new Map();
  // All at once, so a handful of dead backends costs two seconds, not two each.
  const script = `${safe.map((t, i) => (t.kind === 'unix'
    ? `( [ -S ${q(t.path)} ] && echo "${i} up" || echo "${i} down" ) &`
    : `( timeout 2 bash -c ${q(`: </dev/tcp/${t.host}/${t.port}`)} >/dev/null 2>&1 && echo "${i} up" || echo "${i} down" ) &`)).join('\n')}
wait`;
  const result = await rootExec(conn, server, script, { timeout: 60000 }).catch(() => null);
  const out = new Map();
  for (const line of lines(result?.stdout)) {
    const [i, state] = line.split(' ');
    const t = safe[Number(i)];
    if (t) out.set(t.kind === 'unix' ? `unix:${t.path}` : `${t.host}:${t.port}`, state === 'up');
  }
  return out;
}

/**
 * Upstream blocks, every proxied location and the ports on this server: what
 * nginx sends traffic to, whether anything answers there, and which process
 * or container holds each port.
 */
async function upstreamDetails(conn, server, dump, listeningText, containersText) {
  const tree = parseConfigTree(dump);
  const listening = parseListening(listeningText);
  const containers = parseContainerPorts(containersText);

  const upstreams = [];
  walk(tree, (node) => {
    if (node.name !== 'upstream' || !node.children) return;
    const method = ['least_conn', 'ip_hash', 'hash', 'random', 'least_time'].find((m) => directive(node, m).length) || 'round-robin';
    const hashArg = directive(node, 'hash')[0]?.args.join(' ');
    upstreams.push({
      name: node.args[0],
      file: node.file,
      method: hashArg ? `hash ${hashArg}` : method,
      keepalive: directive(node, 'keepalive')[0] ? Number(directive(node, 'keepalive')[0].args[0]) : null,
      servers: directive(node, 'server').map((d) => parseUpstreamServer(d.args)),
      usedBy: [],
    });
  });
  const upstreamNames = new Set(upstreams.map((u) => u.name));

  // Every place traffic leaves nginx for a backend, per domain and location.
  const PASS = ['proxy_pass', 'fastcgi_pass', 'grpc_pass', 'uwsgi_pass', 'scgi_pass'];
  const proxies = [];
  walk(tree, (node, parents) => {
    if (node.name !== 'server' || !node.children) return;
    // A server inside `stream {}` forwards raw TCP/UDP (a database, MQTT) rather than HTTP.
    const stream = parents.includes('stream');
    const domains = directive(node, 'server_name').flatMap((d) => d.args).filter((d) => d && d !== '_');
    const listen = directive(node, 'listen').map((d) => d.args.join(' '));
    const visit = (block, location) => {
      for (const c of block.children || []) {
        if (PASS.includes(c.name)) {
          // nginx -T prints included files on their own, so a stream server from
          // an include is not inside `stream {}` in the dump. A proxy_pass with no
          // scheme, straight in the server block, only exists in stream servers.
          const streamLike = stream || (c.name === 'proxy_pass' && location === '(server)' && !/^[a-z]+:\/\//i.test(c.args[0] || ''));
          proxies.push({ domains, listen, stream: streamLike, file: c.file, location, via: c.name, target: parseTarget(c.args[0], upstreamNames) });
        } else if (c.name === 'location' && c.children) {
          visit(c, c.args.join(' '));
        } else if (c.name === 'if' && c.children) {
          visit(c, `${location} (if)`);
        }
      }
    };
    visit(node, '(server)');
  });
  for (const p of proxies) {
    if (p.target.kind !== 'upstream') continue;
    const u = upstreams.find((x) => x.name === p.target.upstream);
    const users = p.domains.length ? p.domains : [p.stream ? `stream :${p.listen[0] || '?'}` : '(default server)'];
    for (const d of users) if (!u.usedBy.includes(d)) u.usedBy.push(d);
  }

  // Which process or container holds a local port.
  const holder = (port) => {
    const l = listening.filter((x) => x.port === port);
    const container = containers.get(port) || null;
    return {
      listening: l.length > 0,
      bind: l.map((x) => x.address),
      processes: [...new Set(l.flatMap((x) => x.processes.map((p) => p.name)))],
      container,
    };
  };

  const backends = [
    ...upstreams.flatMap((u) => u.servers),
    ...proxies.map((p) => p.target).filter((t) => t.kind === 'tcp' || t.kind === 'unix'),
  ];
  const seen = new Set();
  const unique = backends.filter((t) => {
    const k = t.kind === 'unix' ? `unix:${t.path}` : `${t.host}:${t.port}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const reach = await probeBackends(conn, server, unique);

  const status = (t) => {
    if (t.kind === 'unix') return { up: reach.get(`unix:${t.path}`) ?? null, local: true };
    if (t.kind !== 'tcp') return { up: null, local: null };
    const local = LOCAL_HOSTS.has(t.host);
    return { up: reach.get(`${t.host}:${t.port}`) ?? null, local, ...(local ? holder(t.port) : {}) };
  };
  for (const u of upstreams) u.servers = u.servers.map((sv) => ({ ...sv, ...status(sv) }));
  for (const p of proxies) {
    p.target = { ...p.target, ...status(p.target) };
    if (p.target.kind === 'upstream') {
      const u = upstreams.find((x) => x.name === p.target.upstream);
      const live = u.servers.filter((sv) => !sv.down && sv.up).length;
      p.target.upstreamSummary = { servers: u.servers.length, up: live };
    }
  }

  // Which listening ports nginx itself holds, and which it forwards traffic to.
  const targetPorts = new Set(backends.filter((t) => t.kind === 'tcp' && LOCAL_HOSTS.has(t.host)).map((t) => t.port));
  // One row per port: IPv4 and IPv6 binds of the same port are one service.
  const byPort = new Map();
  for (const l of listening) {
    const row = byPort.get(l.port) || { port: l.port, binds: [], processes: new Set() };
    row.binds.push(l.address);
    l.processes.forEach((p) => row.processes.add(p.name));
    byPort.set(l.port, row);
  }
  const ports = [...byPort.values()].map((r) => ({
    port: r.port,
    binds: r.binds,
    // Bound only to loopback means nothing outside the server can reach it directly.
    localOnly: r.binds.every((b) => /^(127\.|\[?::1\]?:|localhost)/.test(b)),
    processes: [...r.processes],
    container: containers.get(r.port) || null,
    nginxListens: r.processes.has('nginx'),
    nginxProxiesTo: targetPorts.has(r.port),
  }));

  return { upstreams, proxies, listeningPorts: ports };
}

/* ------------------------------------------------- managing upstreams */

export const UPSTREAM_METHODS = ['round-robin', 'least_conn', 'ip_hash', 'hash', 'random'];

/**
 * Check an upstream from the form. Every value that reaches the file is
 * validated here, so nothing typed can add a directive of its own.
 */
export function validateUpstream(input) {
  const name = String(input.name || '').trim();
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(name)) return { error: 'An upstream name is letters, digits, "_", "-" or "." — like app_backend' };

  const method = UPSTREAM_METHODS.includes(input.method) ? input.method : 'round-robin';
  let hashKey = null;
  if (method === 'hash') {
    hashKey = String(input.hashKey || '').trim();
    if (!/^[$A-Za-z0-9_]+( consistent)?$/.test(hashKey)) return { error: 'The hash key must be a variable such as $remote_addr (optionally followed by "consistent")' };
  }

  let keepalive = null;
  if (input.keepalive !== undefined && input.keepalive !== null && String(input.keepalive).trim() !== '') {
    keepalive = Number(input.keepalive);
    if (!Number.isInteger(keepalive) || keepalive < 1 || keepalive > 10000) return { error: 'Keepalive must be a number of connections, 1–10000' };
  }

  const servers = [];
  for (const [i, raw] of (Array.isArray(input.servers) ? input.servers : []).entries()) {
    const where = `Server ${i + 1}`;
    let address = String(raw.address || '').trim();
    if (!address) continue;
    // "3000" alone means a port on this server.
    if (/^\d{1,5}$/.test(address)) address = `127.0.0.1:${address}`;
    const parsed = parseAddress(address);
    if (parsed.kind === 'unix') {
      if (!/^\/[A-Za-z0-9._/-]{1,200}$/.test(parsed.path)) return { error: `${where}: a unix socket must be an absolute path` };
    } else if (parsed.kind !== 'tcp' || !/^[A-Za-z0-9._-]+$|^[0-9a-f:]+$/i.test(parsed.host) || !(parsed.port >= 1 && parsed.port <= 65535)) {
      return { error: `${where}: "${address}" must look like 127.0.0.1:3000, app.internal:8080 or unix:/run/app.sock` };
    }
    const weight = Number(raw.weight || 1);
    if (!Number.isInteger(weight) || weight < 1 || weight > 1000) return { error: `${where}: weight must be 1–1000` };
    const maxFails = raw.maxFails === '' || raw.maxFails === undefined || raw.maxFails === null ? 1 : Number(raw.maxFails);
    if (!Number.isInteger(maxFails) || maxFails < 0 || maxFails > 1000) return { error: `${where}: max_fails must be 0–1000` };
    const failTimeout = String(raw.failTimeout || '10s').trim();
    if (!/^\d{1,6}(ms|s|m|h)?$/.test(failTimeout)) return { error: `${where}: fail_timeout must look like 10s or 1m` };
    const maxConns = raw.maxConns === '' || raw.maxConns === undefined || raw.maxConns === null ? null : Number(raw.maxConns);
    if (maxConns !== null && (!Number.isInteger(maxConns) || maxConns < 0 || maxConns > 100000)) return { error: `${where}: max_conns must be a whole number` };
    const backup = raw.backup === true || raw.backup === 'true';
    if (backup && ['ip_hash', 'hash', 'random'].includes(method)) return { error: `${where}: nginx does not allow backup servers with ${method}` };
    servers.push({ address, weight, maxFails, failTimeout, maxConns, backup, down: raw.down === true || raw.down === 'true' });
  }
  if (!servers.length) return { error: 'Add at least one server (a host:port) to the upstream' };
  if (servers.length > 200) return { error: 'That is more servers than one upstream should carry' };
  if (servers.every((s) => s.down || s.backup)) return { error: 'At least one server has to be active — not all of them can be down or backup' };

  return { value: { name, method, hashKey, keepalive, servers } };
}

/** The upstream block the form describes, indented to sit where the old one was. */
export function buildUpstreamBlock(spec, indent = '') {
  const i2 = `${indent}    `;
  const out = [`${indent}upstream ${spec.name} {`];
  if (spec.method === 'hash') out.push(`${i2}hash ${spec.hashKey};`);
  else if (spec.method !== 'round-robin') out.push(`${i2}${spec.method};`);
  for (const s of spec.servers) {
    const params = [
      s.weight !== 1 && `weight=${s.weight}`,
      s.maxFails !== 1 && `max_fails=${s.maxFails}`,
      s.failTimeout !== '10s' && `fail_timeout=${s.failTimeout}`,
      s.maxConns !== null && `max_conns=${s.maxConns}`,
      s.backup && 'backup',
      s.down && 'down',
    ].filter(Boolean);
    out.push(`${i2}server ${s.address}${params.length ? ` ${params.join(' ')}` : ''};`);
  }
  if (spec.keepalive) out.push(`${i2}keepalive ${spec.keepalive};`);
  out.push(`${indent}}`);
  return out.join('\n');
}

/** Where `upstream NAME { … }` sits in a file: start, end and indentation. */
function findUpstreamBlock(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|\\n)([ \\t]*)upstream\\s+${escaped}\\s*\\{`, 'g');
  let m;
  while ((m = re.exec(text))) {
    const start = m.index + m[1].length;
    let depth = 0;
    let quote = null;
    for (let i = re.lastIndex - 1; i < text.length; i++) {
      const c = text[i];
      if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '#') { const nl = text.indexOf('\n', i); if (nl < 0) break; i = nl; continue; }
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return { start, end: i + 1, indent: m[2] };
    }
  }
  return null;
}

/** A path under /etc/nginx that the panel may read and rewrite. */
function checkConfigPath(path) {
  const p = String(path || '');
  if (!/^\/etc\/nginx\/[A-Za-z0-9._/-]+$/.test(p) || p.includes('..')) throw new Error('Only files under /etc/nginx can be changed here');
  return p;
}

async function readConfigFile(conn, server, path) {
  const result = await rootExec(conn, server, `cat ${q(checkConfigPath(path))}`, { timeout: 60000 });
  if (result.code !== 0) throw new Error(`Could not read ${path} on this server`);
  return result.stdout;
}

/**
 * Write a config file, test the whole configuration and reload — or put the
 * file back exactly as it was. `remove` deletes the file instead.
 */
async function writeConfigFile(conn, server, path, content, { remove = false } = {}) {
  const script = `set -uo pipefail
FILE=${q(checkConfigPath(path))}
BACKUP="$(mktemp /tmp/auto-deploy-nginx.XXXXXX)"
HAD=no
if [ -f "$FILE" ]; then cp -p "$FILE" "$BACKUP"; HAD=yes; fi
${remove ? 'rm -f "$FILE"' : `mkdir -p "$(dirname "$FILE")"
echo ${b64(content)} | base64 -d > "$FILE"
chmod 0644 "$FILE"`}
TEST="$(nginx -t 2>&1)"
if [ $? -ne 0 ]; then
  echo "$TEST" >&2
  if [ "$HAD" = yes ]; then cp -p "$BACKUP" "$FILE"; else rm -f "$FILE"; fi
  rm -f "$BACKUP"
  exit 4
fi
rm -f "$BACKUP"
systemctl reload nginx 2>&1 || { echo "nginx would not reload" >&2; exit 5; }
echo saved`;
  const result = await rootExec(conn, server, script, { timeout: 120000 });
  if (result.code !== 0) throw nginxError(`Saving ${path}`, result);
}

/**
 * Add an upstream, or change one in place. A new one goes in its own file in
 * conf.d (inside the http block on Debian/Ubuntu); an existing one is
 * rewritten where it is, leaving the rest of its file untouched.
 */
export async function saveUpstream(conn, server, { spec, originalName = null, file = null }) {
  const state = await nginxState(conn, server);
  if (!state.installed) throw new Error('nginx is not installed on this server yet.');
  const clash = state.upstreams.find((u) => u.name === spec.name && u.name !== originalName);
  if (clash) throw new Error(`There is already an upstream called "${spec.name}" (in ${clash.file}). Pick another name.`);

  if (!originalName) {
    const path = `/etc/nginx/conf.d/upstream-${spec.name.replace(/[^A-Za-z0-9_.-]/g, '')}.conf`;
    const content = `# Managed by AJ Pilot — upstream ${spec.name}.\n${buildUpstreamBlock(spec)}\n`;
    const exists = await rootExec(conn, server, `[ -e ${q(path)} ] && echo yes || echo no`, { timeout: 30000 });
    if (/yes/.test(exists.stdout)) throw new Error(`${path} already exists on this server`);
    await writeConfigFile(conn, server, path, content);
    return { name: spec.name, file: path, created: true };
  }

  const current = state.upstreams.find((u) => u.name === originalName);
  if (!current) throw new Error(`There is no upstream called "${originalName}" any more — refresh and try again.`);
  const path = checkConfigPath(file || current.file);
  if (path !== current.file) throw new Error('That upstream lives in a different file now — refresh and try again.');

  const text = await readConfigFile(conn, server, path);
  const at = findUpstreamBlock(text, originalName);
  if (!at) throw new Error(`Could not find "upstream ${originalName}" in ${path}. It may be written in an unusual way — edit the file by hand.`);
  const next = text.slice(0, at.start) + buildUpstreamBlock(spec, at.indent) + text.slice(at.end);
  await writeConfigFile(conn, server, path, next);

  // Renaming leaves proxy_pass lines pointing at the old name; say so rather than guess.
  return { name: spec.name, file: path, renamedFrom: spec.name !== originalName ? originalName : null, usedBy: current.usedBy };
}

/** Remove an upstream nothing uses any more. */
export async function deleteUpstream(conn, server, name) {
  const state = await nginxState(conn, server);
  const current = state.upstreams.find((u) => u.name === name);
  if (!current) throw new Error(`There is no upstream called "${name}" — refresh and try again.`);
  if (current.usedBy.length) {
    throw new Error(`"${name}" is still used by ${current.usedBy.join(', ')}. Point those at something else first.`);
  }
  const path = checkConfigPath(current.file);
  const text = await readConfigFile(conn, server, path);
  const at = findUpstreamBlock(text, name);
  if (!at) throw new Error(`Could not find "upstream ${name}" in ${path} — edit the file by hand.`);
  const rest = (text.slice(0, at.start) + text.slice(at.end)).replace(/\n{3,}/g, '\n\n');

  // A file the panel made for this upstream alone goes with it.
  const onlyComments = rest.split('\n').every((l) => !l.trim() || l.trim().startsWith('#'));
  if (onlyComments && /^# Managed by (AJ Pilot|Auto Deploy)/m.test(text)) await writeConfigFile(conn, server, path, '', { remove: true });
  else await writeConfigFile(conn, server, path, rest);
  return { name, file: path };
}

/** One line per vhost file, tab separated by the probe. */
function parseSites(text, certificates) {
  return lines(text).map((line) => {
    const [file, path, enabled, names, listens, cert, root, proxy, mine] = line.split('\t');
    const domains = (names || '').split(/\s+/).map((d) => d.trim()).filter((d) => d && d !== '_');
    const listenList = (listens || '').split(',').map((l) => l.trim()).filter(Boolean);

    // A site is on SSL when it has a certificate and something listening on 443.
    const ssl = Boolean(cert) && listenList.some((l) => /443|ssl/.test(l));
    const match = certificates.find((c) => c.path && cert && c.path === cert)
      || certificates.find((c) => domains.some((d) => c.domains.includes(d)));

    return {
      name: String(file || '').replace(/\.conf$/, ''),
      file: path,
      inConfD: String(path || '').startsWith('/etc/nginx/conf.d/'),
      enabled: enabled === 'yes',
      domains,
      listen: listenList,
      ssl,
      certificatePath: cert || null,
      certificate: match ? { name: match.name, expiry: match.expiry, daysLeft: match.daysLeft, valid: match.valid } : null,
      root: root || null,
      proxyPass: proxy || null,
      kind: proxy ? 'proxy' : (root ? 'static' : 'other'),
      managed: mine === 'yes',
    };
  });
}

/** `certbot certificates` as objects, expiry and all. */
function parseCertificates(text) {
  const out = [];
  let current = null;

  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    const name = /^Certificate Name:\s*(.+)$/.exec(line);
    if (name) {
      current = { name: name[1].trim(), domains: [], expiry: null, daysLeft: null, valid: null, path: null, keyPath: null };
      out.push(current);
      continue;
    }
    if (!current) continue;

    const domains = /^Domains:\s*(.+)$/.exec(line);
    if (domains) current.domains = domains[1].split(/\s+/).filter(Boolean);

    const expiry = /^Expiry Date:\s*(.+?)\s*(?:\((VALID|INVALID|EXPIRED)[^)]*\))?$/.exec(line);
    if (expiry) {
      current.expiry = expiry[1].trim();
      current.valid = expiry[2] ? expiry[2].toUpperCase() === 'VALID' : null;
      const days = /\((?:VALID|INVALID|EXPIRED):\s*(\d+)\s*day/i.exec(line);
      current.daysLeft = days ? Number(days[1]) : daysUntil(current.expiry);
    }

    const path = /^Certificate Path:\s*(.+)$/.exec(line);
    if (path) current.path = path[1].trim();
    const key = /^Private Key Path:\s*(.+)$/.exec(line);
    if (key) current.keyPath = key[1].trim();
  }

  return out;
}

function daysUntil(when) {
  const at = Date.parse(String(when || '').replace(' ', 'T'));
  if (!at) return null;
  return Math.round((at - Date.now()) / 86400000);
}

/* --------------------------------------------------------- writing sites */

/** The vhost the panel writes for a new domain. */
export function buildSiteConfig(spec) {
  const domains = spec.domains.join(' ');
  const body = spec.kind === 'static'
    ? [
      `    root ${spec.root};`,
      '    index index.html index.htm;',
      '',
      '    location / {',
      `        try_files $uri $uri/ ${spec.spa ? '/index.html' : '=404'};`,
      '    }',
    ]
    : [
      '    location / {',
      `        proxy_pass ${spec.upstream};`,
      '        proxy_http_version 1.1;',
      '        proxy_set_header Host $host;',
      '        proxy_set_header X-Real-IP $remote_addr;',
      '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
      '        proxy_set_header X-Forwarded-Proto $scheme;',
      ...(spec.websockets ? [
        '        proxy_set_header Upgrade $http_upgrade;',
        '        proxy_set_header Connection "upgrade";',
      ] : []),
      '        proxy_read_timeout 60s;',
      '    }',
    ];

  return [
    '# Managed by AJ Pilot.',
    '# Edit it here or on the server — the file is the truth, and this panel reads it back.',
    'server {',
    '    listen 80;',
    '    listen [::]:80;',
    `    server_name ${domains};`,
    '',
    `    client_max_body_size ${spec.maxBodySize};`,
    `    access_log /var/log/nginx/${spec.name}.access.log;`,
    `    error_log /var/log/nginx/${spec.name}.error.log;`,
    '',
    ...body,
    '}',
    '',
  ].join('\n');
}

/**
 * Write a vhost and reload, or put back exactly what was there.
 *
 * `mustBeNew` is what stops "add domain" from quietly overwriting a site that
 * somebody else — or an earlier install — already put on that server.
 */
export async function writeSite(conn, server, { name, content, enable = true, mustBeNew = false }) {
  const script = `set -uo pipefail
command -v nginx >/dev/null 2>&1 || { echo "nginx is not installed on this server" >&2; exit 3; }
NAME=${q(name)}

# A server whose nginx.conf has no sites-enabled include keeps its sites in conf.d.
if grep -qs 'sites-enabled' /etc/nginx/nginx.conf; then
  mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled
  FILE="/etc/nginx/sites-available/$NAME"
  LINK="/etc/nginx/sites-enabled/$NAME"
else
  mkdir -p /etc/nginx/conf.d
  FILE="/etc/nginx/conf.d/$NAME.conf"
  LINK=""
fi

${mustBeNew ? `[ -e "$FILE" ] && { echo "EXISTS $FILE" >&2; exit 17; }` : ''}

BACKUP="$(mktemp /tmp/auto-deploy-nginx.XXXXXX)"
HAD=no
if [ -f "$FILE" ]; then cp -p "$FILE" "$BACKUP"; HAD=yes; fi

echo ${b64(content)} | base64 -d > "$FILE"
chmod 0644 "$FILE"
${enable ? '[ -n "$LINK" ] && ln -sfn "$FILE" "$LINK"' : '[ -n "$LINK" ] && rm -f "$LINK" || true'}

TEST="$(nginx -t 2>&1)"
if [ $? -ne 0 ]; then
  echo "$TEST" >&2
  # Put the server back exactly as it was before this write.
  if [ "$HAD" = yes ]; then cp -p "$BACKUP" "$FILE"; else rm -f "$FILE"; [ -n "$LINK" ] && rm -f "$LINK"; fi
  rm -f "$BACKUP"
  exit 4
fi
rm -f "$BACKUP"

systemctl reload nginx 2>&1 || systemctl restart nginx 2>&1 || { echo "nginx would not reload" >&2; exit 5; }

echo '@@@result'
echo "file=$FILE"
echo "enabled=$( [ -n "$LINK" ] && [ -e "$LINK" ] && echo yes || echo ${enable ? 'yes' : 'no'})"
echo "test=$TEST"`;

  const result = await rootExec(conn, server, script, { timeout: 120000 });
  if (result.code === 17) {
    throw new Error(`This server already has an nginx site called "${name}". Open it and edit that one instead.`);
  }
  if (result.code !== 0) throw nginxError(`Saving the site "${name}"`, result);

  const out = splitSections(result.stdout).result || '';
  return {
    name,
    file: (/file=(.*)/.exec(out) || [])[1] || null,
    enabled: /enabled=yes/.test(out),
    test: (out.split('test=')[1] || '').trim(),
  };
}

/** The file as it is on the server, for editing. */
export async function readSite(conn, server, name) {
  const script = `set -uo pipefail
NAME=${q(name)}
for f in "/etc/nginx/sites-available/$NAME" "/etc/nginx/conf.d/$NAME.conf"; do
  [ -f "$f" ] || continue
  echo '@@@file'
  echo "$f"
  echo '@@@content'
  cat "$f"
  exit 0
done
echo "no such site" >&2
exit 4`;

  const result = await rootExec(conn, server, script, { timeout: 60000 });
  if (result.code !== 0) throw new Error(`There is no nginx site called "${name}" on this server`);
  const s = splitSections(result.stdout);
  return { name, file: (s.file || '').trim(), content: s.content || '' };
}

/** Remove a vhost, and reload only if the rest of the configuration still passes. */
export async function removeSite(conn, server, name) {
  const script = `set -uo pipefail
NAME=${q(name)}
BACKUP="$(mktemp -d /tmp/auto-deploy-nginx.XXXXXX)"
FOUND=no
for f in "/etc/nginx/sites-available/$NAME" "/etc/nginx/conf.d/$NAME.conf"; do
  [ -e "$f" ] || continue
  FOUND=yes
  cp -p "$f" "$BACKUP/" 2>/dev/null || true
  echo "$f" >> "$BACKUP/paths"
  rm -f "$f"
done
rm -f "/etc/nginx/sites-enabled/$NAME"
[ "$FOUND" = yes ] || { echo "no such site" >&2; rm -rf "$BACKUP"; exit 4; }

TEST="$(nginx -t 2>&1)"
if [ $? -ne 0 ]; then
  echo "$TEST" >&2
  while read -r p; do cp -p "$BACKUP/$(basename "$p")" "$p" 2>/dev/null || true; done < "$BACKUP/paths"
  rm -rf "$BACKUP"
  exit 5
fi
rm -rf "$BACKUP"
systemctl reload nginx 2>&1 || true
echo "removed ${name}"`;

  const result = await rootExec(conn, server, script, { timeout: 120000 });
  if (result.code === 4) throw new Error(`There is no nginx site called "${name}" on this server`);
  if (result.code !== 0) throw nginxError(`Removing the site "${name}"`, result);
  return { name, removed: true };
}

/** Enable or disable a site without changing what is in it. */
export async function toggleSite(conn, server, name, enable) {
  const script = `set -uo pipefail
NAME=${q(name)}
FILE="/etc/nginx/sites-available/$NAME"
LINK="/etc/nginx/sites-enabled/$NAME"
[ -f "$FILE" ] || { echo "Only sites in sites-available can be switched on and off" >&2; exit 4; }
${enable ? 'ln -sfn "$FILE" "$LINK"' : 'rm -f "$LINK"'}
TEST="$(nginx -t 2>&1)"
if [ $? -ne 0 ]; then
  echo "$TEST" >&2
  ${enable ? 'rm -f "$LINK"' : 'ln -sfn "$FILE" "$LINK"'}
  exit 5
fi
systemctl reload nginx 2>&1 || true
echo "${enable ? 'enabled' : 'disabled'} ${name}"`;

  const result = await rootExec(conn, server, script, { timeout: 90000 });
  if (result.code !== 0) throw nginxError(`${enable ? 'Enabling' : 'Disabling'} "${name}"`, result);
  return { name, enabled: enable };
}

/** reload / restart / test, from the tab's own buttons. */
export async function nginxAction(conn, server, action) {
  if (!['reload', 'restart', 'start', 'stop', 'test'].includes(action)) throw new Error(`Unsupported action "${action}"`);

  const script = action === 'test'
    ? 'nginx -t 2>&1'
    : `set -uo pipefail
${action === 'reload' || action === 'restart' ? `nginx -t 2>&1 || { echo "The configuration does not pass, so nginx was left alone." >&2; exit 4; }` : ''}
systemctl ${action} nginx 2>&1
sleep 1
echo '@@@state'
echo "active=$(systemctl is-active nginx 2>/dev/null || echo unknown)"`;

  const result = await rootExec(conn, server, script, { timeout: 90000 });
  const output = `${result.stdout.split('@@@')[0]}\n${result.stderr}`.trim();
  if (result.code !== 0) throw nginxError(`nginx ${action}`, result);
  return { action, output, active: (/active=(\S+)/.exec(result.stdout) || [])[1] || null };
}

/* ------------------------------------------------------------- installing */

export async function installNginx(conn, server) {
  const script = `set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
if command -v nginx >/dev/null 2>&1; then
  echo "nginx is already installed."
else
  apt-get update -qq 2>&1 | tail -n 2
  apt-get install -y nginx 2>&1 | tail -n 12
fi
systemctl enable --now nginx 2>&1 | tail -n 3 || true

# Let it through the firewall, but only if one is actually on.
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi '^Status: active'; then
  ufw allow 'Nginx Full' >/dev/null 2>&1 && echo "Opened HTTP and HTTPS in ufw." || true
fi

echo '@@@state'
echo "version=$(nginx -v 2>&1 | sed 's#.*nginx/##')"
echo "active=$(systemctl is-active nginx 2>/dev/null || echo unknown)"
command -v nginx >/dev/null 2>&1 || exit 9`;

  const result = await rootExec(conn, server, script, { timeout: 10 * 60 * 1000 });
  const log = `${result.stdout.split('@@@')[0]}\n${result.stderr}`.trim();
  if (result.code !== 0) throw nginxError('Installing nginx', result);
  return { log, version: (/version=(.*)/.exec(result.stdout) || [])[1]?.trim() || null };
}

/** certbot with its nginx plugin, so certificates can be issued and installed in one step. */
export async function installCertbot(conn, server) {
  const script = `set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
if command -v certbot >/dev/null 2>&1; then
  echo "certbot is already installed."
else
  apt-get update -qq 2>&1 | tail -n 2
  apt-get install -y certbot python3-certbot-nginx 2>&1 | tail -n 12
fi
systemctl enable --now certbot.timer >/dev/null 2>&1 || true

echo '@@@state'
echo "version=$(certbot --version 2>&1 | head -n1)"
echo "timer=$(systemctl is-active certbot.timer 2>/dev/null || echo none)"
command -v certbot >/dev/null 2>&1 || exit 9`;

  const result = await rootExec(conn, server, script, { timeout: 10 * 60 * 1000 });
  const log = `${result.stdout.split('@@@')[0]}\n${result.stderr}`.trim();
  if (result.code !== 0) throw nginxError('Installing certbot', result);
  return {
    log,
    version: (/version=(.*)/.exec(result.stdout) || [])[1]?.trim() || null,
    autoRenew: /timer=active/.test(result.stdout),
  };
}

/* ---------------------------------------------------------- certificates */

/**
 * Ask Let's Encrypt for a certificate and let certbot install it into the
 * vhost. The domain has to resolve to this server already — that is what the
 * challenge checks, and the error says so when it does not.
 */
export async function issueCertificate(conn, server, { domains, email, redirect = true, staging = false }) {
  const args = [
    '--nginx',
    ...domains.flatMap((d) => ['-d', q(d)]),
    '--non-interactive', '--agree-tos',
    email ? `--email ${q(email)}` : '--register-unsafely-without-email',
    redirect ? '--redirect' : '--no-redirect',
    '--keep-until-expiring',
    staging ? '--staging' : '',
  ].filter(Boolean).join(' ');

  const script = `set -uo pipefail
command -v certbot >/dev/null 2>&1 || { echo "certbot is not installed on this server" >&2; exit 3; }
certbot ${args} 2>&1 | tail -n 40
rc=\${PIPESTATUS[0]}
echo '@@@state'
echo "rc=$rc"
systemctl reload nginx >/dev/null 2>&1 || true
exit $rc`;

  const result = await rootExec(conn, server, script, { timeout: 5 * 60 * 1000 });
  const output = `${result.stdout.split('@@@')[0]}\n${result.stderr}`.trim();
  if (result.code !== 0) {
    const err = new Error(explainCertbot(output, domains));
    err.cause = output;
    throw err;
  }
  return { domains, output };
}

/** Renew everything due, or one certificate by name. */
export async function renewCertificates(conn, server, { certName = null, force = false } = {}) {
  const script = `set -uo pipefail
command -v certbot >/dev/null 2>&1 || { echo "certbot is not installed on this server" >&2; exit 3; }
certbot renew ${certName ? `--cert-name ${q(certName)}` : ''} ${force ? '--force-renewal' : ''} 2>&1 | tail -n 40
rc=\${PIPESTATUS[0]}
systemctl reload nginx >/dev/null 2>&1 || true
exit $rc`;

  const result = await rootExec(conn, server, script, { timeout: 10 * 60 * 1000 });
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (result.code !== 0) {
    const err = new Error(explainCertbot(output, certName ? [certName] : []));
    err.cause = output;
    throw err;
  }
  return {
    certName,
    output,
    renewed: /(Congratulations|renewed|successfully renewed)/i.test(output),
    upToDate: /not yet due for renewal|No renewals were attempted/i.test(output),
  };
}

/** Forget a certificate entirely — only when the person asked for that. */
export async function deleteCertificate(conn, server, certName) {
  const result = await rootExec(conn, server,
    `certbot delete --cert-name ${q(certName)} --non-interactive 2>&1 | tail -n 20`, { timeout: 120000 });
  if (result.code !== 0) throw nginxError(`Deleting the certificate "${certName}"`, result);
  return { certName, deleted: true };
}

/* ---------------------------------------------------------------- errors */

function nginxError(what, result) {
  const text = `${result.stdout}\n${result.stderr}`;
  if (/sudo:.*(password is required|no tty|incorrect password)/i.test(text)) {
    return new Error(`${what} needs root on this server, but sudo asked for a password the panel does not have. `
      + 'Connect as root, give the SSH user passwordless sudo, or store its sudo password on the server.');
  }
  if (result.code === 3) return new Error('nginx is not installed on this server yet.');
  if (result.code === 4 && /nginx: \[emerg\]/.test(text)) {
    const detail = (/nginx: \[emerg\][^\n]*/.exec(text) || [])[0] || '';
    const err = new Error(`nginx refused the configuration, so nothing was changed: ${detail.slice(0, 250)}`);
    err.cause = text.trim().slice(-4000);
    return err;
  }
  if (/Could not resolve|Temporary failure|Failed to fetch/i.test(text)) {
    return new Error(`${what} failed: this server has no outbound internet access to its package mirrors.`);
  }
  const tail = lines(text).slice(-3).join(' · ');
  const err = new Error(`${what} failed${tail ? `: ${tail.slice(0, 300)}` : ` (exit code ${result.code})`}`);
  err.cause = text.trim().slice(-4000);
  return err;
}

function explainCertbot(output, domains) {
  const first = domains[0] || 'that domain';
  if (/DNS problem|NXDOMAIN|no valid A records/i.test(output)) {
    return `Let's Encrypt could not resolve ${first}. Point its DNS at this server and wait for it to propagate, then try again.`;
  }
  if (/Timeout during connect|Connection refused|Fetching http.*Timeout/i.test(output)) {
    return `Let's Encrypt could not reach ${first} on port 80. Open port 80 to the internet — that is how the challenge is answered — and try again.`;
  }
  if (/Invalid response|404|unauthorized/i.test(output) && /challenge/i.test(output)) {
    return `The challenge for ${first} was answered by something else. Check that this server is what the domain points at.`;
  }
  if (/too many certificates|rate ?limit/i.test(output)) {
    return "Let's Encrypt's rate limit has been hit for this domain. Wait an hour, or use the staging option to test.";
  }
  if (/could not automatically find a matching server block/i.test(output)) {
    return `certbot could not find an nginx server block for ${first}. Add the domain here first, then ask for its certificate.`;
  }
  const tail = lines(output).filter((l) => !/^\s*$/.test(l)).slice(-3).join(' · ');
  return `certbot failed${tail ? `: ${tail.slice(0, 300)}` : ''}`;
}
