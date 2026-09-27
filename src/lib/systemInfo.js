import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from './ssh.js';

const PROBE = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'probe.sh'),
  'utf8'
);

/** Run the probe over an open connection and return structured Ubuntu facts. */
export async function collectSystemInfo(conn) {
  const started = Date.now();
  const { stdout, stderr, code, timedOut } = await exec(conn, 'bash -s', { stdin: PROBE, timeout: 60000 });

  const sections = splitSections(stdout);
  if (!sections.probe_end) {
    const reason = timedOut ? 'the probe timed out' : `the probe exited with code ${code}`;
    throw new Error(`Could not collect system details — ${reason}. ${stderr.trim().slice(0, 300)}`);
  }

  const facts = buildFacts(sections);
  facts.meta.durationMs = Date.now() - started;
  return facts;
}

export function splitSections(raw) {
  const out = {};
  let current = null;
  for (const line of raw.split(/\r?\n/)) {
    const m = /^@@@(\w+)$/.exec(line);
    if (m) {
      current = m[1];
      out[current] = [];
    } else if (current) {
      out[current].push(line);
    }
  }
  for (const k of Object.keys(out)) out[k] = out[k].join('\n').trim();
  return out;
}

const kv = (text, sep = '=') => {
  const o = {};
  for (const line of (text || '').split('\n')) {
    const i = line.indexOf(sep);
    if (i > 0) o[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"|"$/g, '');
  }
  return o;
};

const num = (v) => {
  const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const lines = (t) => (t || '').split('\n').map((l) => l.trim()).filter(Boolean);

const round = (n) => Math.round(n * 10) / 10;

export function buildFacts(s) {
  const warnings = [];
  const meta = kv(s.probe_meta);
  const os = kv(s.os_release);
  const id = kv(s.identity);
  const cpuRaw = kv(s.cpu, ':');
  const mem = kv(s.meminfo, ':');
  const pkg = kv(s.packages);
  const sec = kv(s.security);
  const dockerState = kv(s.docker_state);

  const isUbuntu = /ubuntu/i.test(`${os.ID} ${os.NAME} ${os.PRETTY_NAME}`);
  if (!isUbuntu) {
    warnings.push(`This host reports "${os.PRETTY_NAME || os.NAME || 'unknown OS'}" — this tool targets Ubuntu, so some details may be missing.`);
  }
  if (meta.sudo_available === 'no' && meta.uid !== '0') {
    warnings.push('Connected as a non-root user without passwordless sudo — port owners, firewall state and docker details may be incomplete.');
  }

  const uptimeSeconds = num((s.uptime || '').split(/\s+/)[0]);
  const load = (s.loadavg || '').split(/\s+/);

  const memTotal = num(mem.MemTotal) * 1024;
  const memAvailable = num(mem.MemAvailable) * 1024;
  const memFree = num(mem.MemFree) * 1024;
  const swapTotal = num(mem.SwapTotal) * 1024;
  const swapFree = num(mem.SwapFree) * 1024;
  const memUsed = memTotal && memAvailable ? memTotal - memAvailable : null;

  const aptCheck = (pkg.apt_check || '').split(';');
  const cpuFallback = kv(s.cpu_fallback);

  return {
    meta: {
      collectedAt: meta.collected_at || new Date().toISOString(),
      runAs: meta.run_as,
      uid: num(meta.uid),
      sudoAvailable: meta.sudo_available === 'yes',
      isUbuntu,
    },
    os: {
      pretty: os.PRETTY_NAME || os.NAME || 'unknown',
      name: os.NAME,
      id: os.ID,
      version: os.VERSION || os.VERSION_ID,
      versionId: os.VERSION_ID,
      codename: os.VERSION_CODENAME || os.UBUNTU_CODENAME,
      isUbuntu,
    },
    identity: {
      hostname: id.hostname,
      fqdn: id.fqdn && id.fqdn !== id.hostname ? id.fqdn : null,
      kernel: id.kernel,
      arch: id.arch,
      machineId: id.machine_id,
      timezone: id.timezone,
      localTime: id.local_time,
      virtualization: id.virtualization,
      bootTime: id.boot_time,
      init: id.init,
    },
    uptime: {
      seconds: uptimeSeconds,
      human: humanUptime(uptimeSeconds),
      bootTime: id.boot_time,
    },
    load: {
      one: num(load[0]),
      five: num(load[1]),
      fifteen: num(load[2]),
      runnable: load[3] || null,
    },
    cpu: {
      model: cpuRaw['Model name'] || (s.cpu_fallback || '').split(':')[1]?.trim() || 'unknown',
      vendor: cpuRaw['Vendor ID'],
      cores: num(cpuRaw['CPU(s)']) || num(cpuFallback.cores),
      threadsPerCore: num(cpuRaw['Thread(s) per core']),
      coresPerSocket: num(cpuRaw['Core(s) per socket']),
      sockets: num(cpuRaw['Socket(s)']),
      mhz: num(cpuRaw['CPU MHz'] || cpuRaw['CPU max MHz']),
      cacheL3: cpuRaw['L3 cache'],
      hypervisor: cpuRaw['Hypervisor vendor'],
      virtType: cpuRaw['Virtualization type'] || cpuRaw.Virtualization,
    },
    memory: {
      totalBytes: memTotal || null,
      availableBytes: memAvailable || null,
      freeBytes: memFree || null,
      usedBytes: memUsed,
      usedPct: memTotal && memUsed !== null ? round((memUsed / memTotal) * 100) : null,
      buffersBytes: num(mem.Buffers) * 1024 || null,
      cachedBytes: num(mem.Cached) * 1024 || null,
      swapTotalBytes: swapTotal || null,
      swapFreeBytes: swapFree || null,
      swapUsedPct: swapTotal ? round(((swapTotal - swapFree) / swapTotal) * 100) : null,
    },
    disks: parseDf(s.disk),
    inodes: parseInodes(s.inodes),
    blockDevices: parseLsblk(s.blockdev),
    network: {
      interfaces: parseIpAddr(s.net_ipv4, 'ipv4').concat(parseIpAddr(s.net_ipv6, 'ipv6')),
      gateway: parseGateway(s.net_gateway),
      dns: parseDns(s.net_dns),
      publicIp: (s.net_public_ip || '').trim() || null,
      listening: parseSs(s.net_ports),
    },
    processes: {
      total: num(kv(s.proc_count).total),
      topCpu: parsePs(s.proc_cpu),
      topMemory: parsePs(s.proc_mem),
    },
    services: {
      running: parseServices(s.services),
      failed: parseServices(s.services_failed),
    },
    sessions: lines(s.logged_in).map((l) => {
      const [user, tty, ...rest] = l.split(/\s+/);
      return { user, tty, since: rest.join(' ') };
    }),
    packages: {
      dpkgInstalled: num(pkg.dpkg_installed),
      snapInstalled: num(pkg.snap_installed),
      updatesAvailable: num(aptCheck[0]),
      securityUpdates: num(aptCheck[1]),
      rebootRequired: pkg.reboot_required === 'yes',
      rebootPackages: (pkg.reboot_packages || '').split(',').filter(Boolean),
      unattendedUpgrades: pkg.unattended_upgrades,
    },
    security: {
      firewall: sec.ufw || 'unknown',
      fail2ban: sec.fail2ban,
      sshPort: (sec.ssh_port || '').split(',').filter(Boolean),
      permitRootLogin: sec.permit_root_login || 'default',
      passwordAuth: sec.password_auth || 'default',
      sudoUsers: (sec.sudo_users || '').split(',').filter(Boolean),
      lastLogins: (sec.last_logins || '').split('|').filter(Boolean),
    },
    tooling: kv(s.tooling),
    docker: {
      accessible: dockerState.accessible,
      serverVersion: dockerState.server_version || null,
      containersRunning: num(dockerState.containers_running),
      containersStopped: num(dockerState.containers_stopped),
      images: num(dockerState.images),
      storageDriver: dockerState.storage_driver || null,
      containers: lines(s.docker_containers).map((l) => {
        const [name, image, state, status, ports] = l.split('\t');
        return { name, image, state, status, ports: ports || '' };
      }),
    },
    mysql: shapeMysqlServer(kv(s.mysql_server)),
    web: { nginxSites: lines(s.web_sites) },
    cron: lines(s.crontab),
    warnings,
  };
}

function shapeMysqlServer(m) {
  const clientInstalled = m.client_installed === 'yes';
  if (m.installed !== 'yes') return { installed: false, clientInstalled };
  const bind = m.bind_address || null;
  return {
    installed: true,
    clientInstalled,
    clientVersion: m.client_version || null,
    serverVersion: m.server_version || null,
    service: m.service && m.service !== 'none' ? m.service : null,
    running: m.service_state === 'active',
    enabled: m.enabled || 'unknown',
    bindAddress: bind,
    // 127.0.0.1 means the panel must tunnel over SSH to reach it.
    localOnly: bind ? /^(127\.|::1|localhost)/.test(bind) : null,
    port: num(m.port) || 3306,
    datadir: m.datadir || null,
    datadirBytes: num(m.datadir_bytes),
    listening: (m.listening || '').split('|').filter(Boolean),
  };
}

function parseDf(text) {
  return lines(text).slice(1).map((l) => {
    const p = l.split(/\s+/);
    return {
      filesystem: p[0],
      type: p[1],
      sizeBytes: num(p[2]),
      usedBytes: num(p[3]),
      availableBytes: num(p[4]),
      usedPct: num(p[5]),
      mount: p.slice(6).join(' '),
    };
  }).filter((d) => d.sizeBytes);
}

function parseInodes(text) {
  return lines(text).slice(1).map((l) => {
    const p = l.split(/\s+/);
    return {
      filesystem: p[0],
      inodes: num(p[1]),
      used: num(p[2]),
      free: num(p[3]),
      usedPct: num(p[4]),
      mount: p.slice(5).join(' '),
    };
  }).filter((d) => d.inodes);
}

function parseLsblk(text) {
  return lines(text).map((l) => {
    const o = {};
    for (const m of l.matchAll(/(\w+)="([^"]*)"/g)) o[m[1].toLowerCase()] = m[2];
    return {
      name: o.name,
      sizeBytes: num(o.size),
      type: o.type,
      mount: o.mountpoint || null,
      fstype: o.fstype || null,
      model: (o.model || '').trim() || null,
    };
  }).filter((d) => d.name);
}

function parseIpAddr(text, family) {
  return lines(text).map((l) => {
    const m = /^\d+:\s+(\S+)\s+inet6?\s+(\S+)/.exec(l);
    if (!m) return null;
    const scope = /scope (\w+)/.exec(l);
    return {
      name: m[1],
      cidr: m[2],
      address: m[2].split('/')[0],
      family,
      scope: scope ? scope[1] : null,
    };
  }).filter(Boolean).filter((i) => i.name !== 'lo');
}

function parseGateway(text) {
  const m = /default via (\S+) dev (\S+)/.exec(text || '');
  return m ? { via: m[1], dev: m[2] } : null;
}

function parseDns(text) {
  const out = new Set();
  for (const l of lines(text)) {
    for (const m of l.matchAll(/(?:\d{1,3}\.){3}\d{1,3}/g)) out.add(m[0]);
  }
  return [...out];
}

function parseSs(text) {
  return lines(text).map((l) => {
    const p = l.split(/\s+/);
    const local = p[4];
    const procMatch = /users:\(\("([^"]+)",pid=(\d+)/.exec(l);
    const portMatch = /:(\d+)$/.exec(local || '');
    return {
      proto: p[0],
      local,
      port: portMatch ? num(portMatch[1]) : null,
      process: procMatch ? procMatch[1] : null,
      pid: procMatch ? num(procMatch[2]) : null,
    };
  }).filter((p) => p.port).sort((a, b) => a.port - b.port);
}

function parsePs(text) {
  return lines(text).slice(1).map((l) => {
    const p = l.split(/\s+/);
    return {
      pid: num(p[0]),
      user: p[1],
      cpuPct: num(p[2]),
      memPct: num(p[3]),
      rssBytes: num(p[4]) * 1024,
      command: p.slice(5).join(' '),
    };
  }).filter((p) => p.pid);
}

function parseServices(text) {
  return lines(text).map((l) => {
    const p = l.replace(/^\s*●\s*/, '').split(/\s+/);
    return {
      unit: p[0],
      load: p[1],
      active: p[2],
      sub: p[3],
      description: p.slice(4).join(' '),
    };
  }).filter((x) => x.unit);
}

function humanUptime(seconds) {
  if (!seconds) return null;
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return [d ? `${d}d` : null, d || h ? `${h}h` : null, `${m}m`].filter(Boolean).join(' ');
}
