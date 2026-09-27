/**
 * What is on this server, counted.
 *
 * The Overview tab draws instantly from the stored profile, which says what the
 * machine *is*. This says what is *on* it right now — containers, domains,
 * scheduled jobs, runners, services — and it is one SSH pass rather than the
 * five the individual tabs would each make, because a summary that costs five
 * connections is a summary nobody waits for.
 *
 * Everything here is a count. The tabs themselves have the detail, and each
 * tile on the overview is a way into the tab that owns it.
 */

import { rootExec } from './ssh.js';
import { splitSections } from './systemInfo.js';

const lines = (t) => String(t || '').split('\n').map((l) => l.trim()).filter(Boolean);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

const kv = (text) => {
  const out = {};
  for (const line of lines(text)) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
};

/**
 * The machine's IPv4 addresses.
 *
 * `primary` is the one on the interface the default route leaves by — the
 * address the machine actually answers on — which is not always the first one
 * `ip addr` prints, on a host with a private interface and a public one.
 */
function parseNetwork(text) {
  const meta = kv(text);
  const ipv4 = [];

  for (const line of lines(text)) {
    if (!line.startsWith('addr=')) continue;
    const [iface, cidr] = line.slice(5).split('\t');
    if (!cidr) continue;
    const [address, prefix] = cidr.split('/');
    // Loopback is not an address anything reaches this machine on. `scope
    // global` already excludes it; this covers the host that reports it anyway.
    if (iface === 'lo' || address.startsWith('127.')) continue;
    ipv4.push({
      iface,
      address,
      cidr,
      prefix: num(prefix),
      // 10/8, 172.16/12, 192.168/16 and 127/8 never reach the internet.
      private: /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address),
    });
  }

  const onRoute = ipv4.find((a) => a.iface === meta.route_iface);
  const publicIp = (meta.public || '').trim() || null;

  return {
    ipv4,
    primary: (onRoute || ipv4.find((a) => !a.private) || ipv4[0])?.address || null,
    gateway: meta.gateway || null,
    routeInterface: meta.route_iface || null,
    hostname: meta.hostname || null,
    // Only a sane-looking answer; a captive portal can return anything.
    publicIp: publicIp && /^\d{1,3}(\.\d{1,3}){3}$/.test(publicIp) ? publicIp : null,
  };
}

export async function collectSummary(conn, server) {
  const script = `export LC_ALL=C

echo '@@@network'
# Every global IPv4 the machine holds, tagged with the interface it sits on.
ip -o -4 addr show scope global 2>/dev/null | awk '{print "addr="$2"\\t"$4}'
echo "gateway=$(ip -4 route show default 2>/dev/null | awk '{print $3; exit}')"
echo "route_iface=$(ip -4 route show default 2>/dev/null | awk '{print $5; exit}')"
echo "hostname=$(hostname -f 2>/dev/null || hostname 2>/dev/null)"
# A short timeout: on a server with no outbound access this must not hold the
# whole summary up, and an empty answer is a perfectly good answer.
echo "public=$(curl -fsS --max-time 2 https://api.ipify.org 2>/dev/null || echo '')"

echo '@@@docker'
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    echo "state=running"
    echo "images=$(docker images -q 2>/dev/null | wc -l)"
    echo "volumes=$(docker volume ls -q 2>/dev/null | wc -l)"
    echo "networks=$(docker network ls -q 2>/dev/null | wc -l)"
    echo "compose=$(docker compose version --short 2>/dev/null)"
  else
    echo "state=stopped"
  fi
else
  echo "state=absent"
fi
echo '@@@containers'
docker ps -a --format '{{.State}}' 2>/dev/null

echo '@@@nginx'
if command -v nginx >/dev/null 2>&1; then
  echo "installed=yes"
  echo "active=$(systemctl is-active nginx 2>/dev/null || echo unknown)"
  # Distinct server_name entries across everything nginx is actually serving.
  echo "domains=$(cat /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf 2>/dev/null \\
    | sed -n 's/^[[:space:]]*server_name[[:space:]]\\+\\([^;]*\\);.*/\\1/p' \\
    | tr ' ' '\\n' | sed '/^$/d;/^_$/d' | sort -u | wc -l)"
  echo "sites=$(ls -1 /etc/nginx/sites-enabled 2>/dev/null | wc -l)"
  echo "ssl=$(grep -l 'ssl_certificate ' /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf 2>/dev/null | wc -l)"
else
  echo "installed=no"
fi
echo '@@@certs'
if command -v certbot >/dev/null 2>&1; then
  echo "installed=yes"
  certbot certificates 2>/dev/null | sed -n 's/^[[:space:]]*Expiry Date:[[:space:]]*\\(.*\\)$/\\1/p'
else
  echo "installed=no"
fi

echo '@@@cron'
if command -v crontab >/dev/null 2>&1; then
  echo "installed=yes"
  echo "active=$(systemctl is-active cron 2>/dev/null || systemctl is-active crond 2>/dev/null || echo unknown)"
  echo "jobs=$(for u in $(ls -1 /var/spool/cron/crontabs 2>/dev/null; ls -1 /var/spool/cron 2>/dev/null); do
      crontab -l -u "$u" 2>/dev/null
    done | grep -vE '^[[:space:]]*(#|$)' | grep -vE '^[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=' | wc -l)"
  echo "system=$(cat /etc/crontab /etc/cron.d/* 2>/dev/null | grep -vE '^[[:space:]]*(#|$)' | grep -vE '^[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=' | wc -l)"
else
  echo "installed=no"
fi

echo '@@@services'
echo "running=$(systemctl list-units --type=service --state=running --no-legend --plain 2>/dev/null | wc -l)"
echo "failed=$(systemctl list-units --type=service --state=failed --no-legend --plain 2>/dev/null | wc -l)"
echo "total=$(systemctl list-unit-files --type=service --no-legend 2>/dev/null | wc -l)"

echo '@@@runners'
systemctl list-units --type=service --all --no-legend --plain 2>/dev/null \\
  | awk '$1 ~ /^(actions\\.runner\\.|gitlab-runner)/ {print $1"\\t"$3}'

echo '@@@done'
echo ok`;

  const result = await rootExec(conn, server, script, { timeout: 60000 });
  const s = splitSections(result.stdout);
  if (!s.done) {
    throw new Error(`Could not read what is on this server: ${(result.stderr || '').trim().slice(0, 200)}`);
  }

  const docker = kv(s.docker);
  const nginx = kv(s.nginx);
  const cron = kv(s.cron);
  const services = kv(s.services);

  // `docker ps -a` gives one state per container; count them by name.
  const containers = { running: 0, exited: 0, restarting: 0, paused: 0, created: 0, dead: 0, total: 0 };
  for (const state of lines(s.containers)) {
    const key = state.toLowerCase();
    if (containers[key] !== undefined) containers[key] += 1;
    containers.total += 1;
  }

  const certLines = lines(s.certs).filter((l) => !l.startsWith('installed='));
  const expiries = certLines
    .map((l) => Date.parse(l.replace(/\s*\(.*$/, '').replace(' ', 'T')))
    .filter((t) => Number.isFinite(t));

  const runnerUnits = lines(s.runners).map((l) => {
    const [service, active] = l.split('\t');
    return { service, active };
  });

  return {
    network: parseNetwork(s.network),
    docker: {
      installed: docker.state !== 'absent',
      running: docker.state === 'running',
      containers,
      images: num(docker.images),
      volumes: num(docker.volumes),
      networks: num(docker.networks),
      composeVersion: docker.compose || null,
    },
    nginx: {
      installed: nginx.installed === 'yes',
      active: nginx.active || 'unknown',
      running: nginx.active === 'active',
      domains: num(nginx.domains),
      sites: num(nginx.sites),
      ssl: num(nginx.ssl),
    },
    certbot: {
      installed: (kv(s.certs).installed || 'no') === 'yes',
      certificates: expiries.length,
      // The one that matters is whichever expires first.
      soonestDays: expiries.length ? Math.round((Math.min(...expiries) - Date.now()) / 86400000) : null,
    },
    cron: {
      installed: cron.installed === 'yes',
      active: cron.active || 'unknown',
      running: cron.active === 'active',
      jobs: num(cron.jobs),
      systemJobs: num(cron.system),
    },
    services: {
      running: num(services.running),
      failed: num(services.failed),
      total: num(services.total),
    },
    runners: {
      units: runnerUnits.length,
      running: runnerUnits.filter((u) => u.active === 'active').length,
    },
  };
}
