/**
 * Live statistics for one server.
 *
 * Everything here is one sample: the script reads /proc twice a second apart,
 * so rates — CPU busy, network throughput, disk I/O — are worked out on the
 * machine itself rather than guessed at from single readings. Docker is asked
 * for its own numbers in the same pass when it is there.
 *
 * The panel holds one SSH connection open and takes a sample every few seconds,
 * which is what makes this cheap enough to watch.
 */

import { rootExec } from './ssh.js';
import { splitSections } from './systemInfo.js';

const lines = (t) => String(t || '').split('\n').map((l) => l.trim()).filter(Boolean);
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** How long the two readings are apart. Rates are divided by this. */
const GAP_SECONDS = 1;

/** What counts as bad enough to say so. */
export const THRESHOLDS = {
  cpuWarn: 75, cpuCritical: 90,
  memoryWarn: 80, memoryCritical: 92,
  swapWarn: 50,
  diskWarn: 80, diskCritical: 90,
  loadWarn: 2, loadCritical: 4, // per core
  iowaitWarn: 25,
};

/**
 * One sample. `withDocker` is off when the server has no Docker, so the
 * expensive `docker stats` call is not made on every tick for nothing.
 */
export async function collectLiveStats(conn, server, { withDocker = true } = {}) {
  const script = `export LC_ALL=C
echo '@@@cpu1'
grep '^cpu' /proc/stat
echo '@@@net1'
cat /proc/net/dev
echo '@@@disk1'
cat /proc/diskstats 2>/dev/null
sleep ${GAP_SECONDS}
echo '@@@cpu2'
grep '^cpu' /proc/stat
echo '@@@net2'
cat /proc/net/dev
echo '@@@disk2'
cat /proc/diskstats 2>/dev/null
echo '@@@mem'
cat /proc/meminfo
echo '@@@load'
cat /proc/loadavg
nproc 2>/dev/null || echo 1
echo '@@@uptime'
cat /proc/uptime
echo '@@@df'
df -PB1 -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null | tail -n +2
echo '@@@proccpu'
ps -eo pid,pcpu,pmem,user:16,comm --sort=-pcpu 2>/dev/null | head -n 7 | tail -n +2
echo '@@@procmem'
ps -eo pid,pcpu,pmem,user:16,comm --sort=-pmem 2>/dev/null | head -n 7 | tail -n +2
echo '@@@sessions'
who 2>/dev/null | wc -l
echo '@@@docker'
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then echo "state=running"; else echo "state=stopped"; fi
else
  echo "state=absent"
fi
${withDocker ? `echo '@@@dockerps'
docker ps -a --format '{{.Names}}\\t{{.State}}\\t{{.Status}}\\t{{.Image}}\\t{{.Ports}}\\t{{.RunningFor}}' 2>/dev/null
echo '@@@dockerstats'
docker stats --no-stream --format '{{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}\\t{{.MemPerc}}\\t{{.NetIO}}\\t{{.BlockIO}}\\t{{.PIDs}}' 2>/dev/null` : ''}
echo '@@@done'
echo ok`;

  // Reading /proc and asking Docker both work as root; a non-root user with
  // docker group access would also do, but root is what the panel already has.
  const result = await rootExec(conn, server, script, { timeout: 45000 });
  const s = splitSections(result.stdout);
  if (!s.done) {
    throw new Error('Could not read live statistics from this server: '
      + `${(result.stderr || result.stdout || '').trim().slice(0, 200) || 'the probe returned nothing'}`);
  }

  const cpu = cpuDelta(s.cpu1, s.cpu2);
  const memory = memoryOf(s.mem);
  const load = loadOf(s.load);
  const disks = disksOf(s.df);
  const network = networkDelta(s.net1, s.net2);
  const diskIo = diskDelta(s.disk1, s.disk2);
  const docker = dockerOf(s, withDocker);

  const sample = {
    at: new Date().toISOString(),
    cpu,
    memory,
    load,
    disks,
    network,
    diskIo,
    uptimeSeconds: Math.round(num(lines(s.uptime)[0]?.split(/\s+/)[0])),
    sessions: num(lines(s.sessions)[0]),
    topCpu: processesOf(s.proccpu),
    topMemory: processesOf(s.procmem),
    docker,
  };

  sample.alerts = alertsFor(sample);
  sample.worst = sample.alerts.some((a) => a.level === 'critical') ? 'critical'
    : sample.alerts.length ? 'warning' : 'ok';
  return sample;
}

/* --------------------------------------------------------------- CPU */

const cpuLine = (line) => {
  const [name, ...rest] = line.split(/\s+/);
  const v = rest.map(num);
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = v;
  return {
    name,
    idle: idle + iowait,
    total: user + nice + system + idle + iowait + irq + softirq + steal,
    iowait,
    steal,
    busy: user + nice + system + irq + softirq + steal,
  };
};

/** Busy percentage between the two readings, overall and per core. */
function cpuDelta(before, after) {
  const first = new Map(lines(before).map((l) => [l.split(/\s+/)[0], cpuLine(l)]));
  const cores = [];
  let overall = { usedPct: 0, iowaitPct: 0, stealPct: 0 };

  for (const line of lines(after)) {
    const now = cpuLine(line);
    const then = first.get(now.name);
    if (!then) continue;

    const total = now.total - then.total;
    if (total <= 0) continue;
    const used = Math.max(0, Math.min(100, round1(((now.busy - then.busy) / total) * 100)));

    if (now.name === 'cpu') {
      overall = {
        usedPct: used,
        iowaitPct: Math.max(0, round1(((now.iowait - then.iowait) / total) * 100)),
        stealPct: Math.max(0, round1(((now.steal - then.steal) / total) * 100)),
      };
    } else {
      cores.push({ core: Number(now.name.replace('cpu', '')), usedPct: used });
    }
  }

  cores.sort((a, b) => a.core - b.core);
  return { ...overall, cores };
}

/* ------------------------------------------------------------ memory */

function memoryOf(text) {
  const kb = {};
  for (const line of lines(text)) {
    const m = /^(\w+):\s+(\d+)/.exec(line);
    if (m) kb[m[1]] = Number(m[2]);
  }
  const total = (kb.MemTotal || 0) * 1024;
  // MemAvailable is what can actually be handed out, which is not the same as free.
  const available = (kb.MemAvailable ?? ((kb.MemFree || 0) + (kb.Cached || 0) + (kb.Buffers || 0))) * 1024;
  const used = Math.max(0, total - available);
  const swapTotal = (kb.SwapTotal || 0) * 1024;
  const swapUsed = Math.max(0, swapTotal - (kb.SwapFree || 0) * 1024);

  return {
    totalBytes: total,
    usedBytes: used,
    availableBytes: available,
    cachedBytes: (kb.Cached || 0) * 1024,
    buffersBytes: (kb.Buffers || 0) * 1024,
    usedPct: total ? round1((used / total) * 100) : 0,
    swapTotalBytes: swapTotal,
    swapUsedBytes: swapUsed,
    swapUsedPct: swapTotal ? round1((swapUsed / swapTotal) * 100) : 0,
  };
}

/* -------------------------------------------------------------- load */

function loadOf(text) {
  const rows = lines(text);
  const parts = (rows[0] || '').split(/\s+/);
  const cores = Math.max(1, num(rows[1]) || 1);
  const one = num(parts[0]);
  const running = /^(\d+)\/(\d+)$/.exec(parts[3] || '');
  return {
    one,
    five: num(parts[1]),
    fifteen: num(parts[2]),
    cores,
    perCore: round2(one / cores),
    runnable: running ? Number(running[1]) : null,
    processes: running ? Number(running[2]) : null,
  };
}

/* ------------------------------------------------------------- disks */

function disksOf(text) {
  return lines(text).map((line) => {
    const parts = line.split(/\s+/);
    if (parts.length < 6) return null;
    const [device, size, used, available, capacity, ...mount] = parts;
    return {
      device,
      mount: mount.join(' '),
      sizeBytes: num(size),
      usedBytes: num(used),
      availableBytes: num(available),
      usedPct: num(String(capacity).replace('%', '')),
    };
  }).filter(Boolean).filter((d) => d.sizeBytes > 0);
}

/* ----------------------------------------------------------- network */

const netTotals = (text) => {
  const out = new Map();
  for (const line of lines(text)) {
    const m = /^([\w.@:-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const iface = m[1];
    if (iface === 'lo') continue;
    const v = m[2].split(/\s+/).map(num);
    out.set(iface, { rx: v[0] || 0, tx: v[8] || 0 });
  }
  return out;
};

function networkDelta(before, after) {
  const first = netTotals(before);
  const interfaces = [];
  let rx = 0;
  let tx = 0;

  for (const [iface, now] of netTotals(after)) {
    const then = first.get(iface);
    if (!then) continue;
    const rxRate = Math.max(0, Math.round((now.rx - then.rx) / GAP_SECONDS));
    const txRate = Math.max(0, Math.round((now.tx - then.tx) / GAP_SECONDS));
    rx += rxRate;
    tx += txRate;
    interfaces.push({ iface, rxBytesPerSec: rxRate, txBytesPerSec: txRate, rxTotal: now.rx, txTotal: now.tx });
  }

  interfaces.sort((a, b) => (b.rxBytesPerSec + b.txBytesPerSec) - (a.rxBytesPerSec + a.txBytesPerSec));
  return { rxBytesPerSec: rx, txBytesPerSec: tx, interfaces };
}

/* ---------------------------------------------------------- disk I/O */

const SECTOR = 512;

/** A partition's bytes are its disk's bytes, so only whole disks are counted. */
function isWholeDisk(name) {
  if (/^(loop|ram|dm-|sr|md|zram|fd)/.test(name)) return false;
  if (/^(sd|vd|hd|xvd)[a-z]+\d+$/.test(name)) return false;
  if (/^nvme\d+n\d+p\d+$/.test(name)) return false;
  if (/^mmcblk\d+p\d+$/.test(name)) return false;
  return true;
}

const diskTotals = (text) => {
  const out = new Map();
  for (const line of lines(text)) {
    const p = line.split(/\s+/);
    if (p.length < 10) continue;
    const name = p[2];
    if (!isWholeDisk(name)) continue;
    out.set(name, { read: num(p[5]), written: num(p[9]) });
  }
  return out;
};

function diskDelta(before, after) {
  const first = diskTotals(before);
  let read = 0;
  let written = 0;
  for (const [name, now] of diskTotals(after)) {
    const then = first.get(name);
    if (!then) continue;
    read += Math.max(0, ((now.read - then.read) * SECTOR) / GAP_SECONDS);
    written += Math.max(0, ((now.written - then.written) * SECTOR) / GAP_SECONDS);
  }
  return { readBytesPerSec: Math.round(read), writeBytesPerSec: Math.round(written) };
}

/* --------------------------------------------------------- processes */

const processesOf = (text) => lines(text).map((line) => {
  const [pid, pcpu, pmem, user, ...command] = line.split(/\s+/);
  return { pid: num(pid), cpuPct: num(pcpu), memoryPct: num(pmem), user, command: command.join(' ') };
}).filter((p) => p.pid);

/* ------------------------------------------------------------ docker */

/** `12.5%` → 12.5, `1.2GiB / 3.8GiB` → bytes. */
const pct = (v) => num(String(v || '').replace('%', ''));

function bytesOf(text) {
  const m = /^([\d.]+)\s*([KMGT]?i?B)$/i.exec(String(text || '').trim());
  if (!m) return null;
  const scale = { b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4, kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3, tb: 1000 ** 4 };
  return Math.round(Number(m[1]) * (scale[m[2].toLowerCase()] ?? 1));
}

const pairOf = (text) => {
  const [a, b] = String(text || '').split('/').map((x) => bytesOf(x));
  return { a, b };
};

function dockerOf(s, withDocker) {
  const state = (/state=(\S+)/.exec(s.docker || '') || [])[1] || 'absent';
  const base = {
    installed: state !== 'absent',
    running: state === 'running',
    containers: [],
    counts: { running: 0, exited: 0, restarting: 0, paused: 0, created: 0, dead: 0, total: 0 },
  };
  if (!withDocker || state !== 'running') return base;

  const stats = new Map();
  for (const line of lines(s.dockerstats)) {
    const [name, cpu, mem, memPct, net, block, pids] = line.split('\t');
    const memory = pairOf(mem);
    const netIo = pairOf(net);
    const blockIo = pairOf(block);
    stats.set(name, {
      cpuPct: pct(cpu),
      memoryBytes: memory.a,
      memoryLimitBytes: memory.b,
      memoryPct: pct(memPct),
      netRxBytes: netIo.a,
      netTxBytes: netIo.b,
      blockReadBytes: blockIo.a,
      blockWriteBytes: blockIo.b,
      pids: num(pids),
    });
  }

  for (const line of lines(s.dockerps)) {
    const [name, cState, status, image, ports, since] = line.split('\t');
    if (!name) continue;
    const key = String(cState || '').toLowerCase();
    if (base.counts[key] !== undefined) base.counts[key] += 1;
    base.counts.total += 1;
    base.containers.push({
      name,
      state: key,
      status: status || '',
      image: image || '',
      ports: ports || '',
      since: since || '',
      // An unhealthy container says so inside its status text.
      health: /\(healthy\)/.test(status || '') ? 'healthy' : /\(unhealthy\)/.test(status || '') ? 'unhealthy' : null,
      ...(stats.get(name) || {}),
    });
  }

  base.containers.sort((a, b) => (b.cpuPct || 0) - (a.cpuPct || 0));
  return base;
}

/* ------------------------------------------------------------ alerts */

/**
 * What is wrong, in words, with the worst first.
 *
 * Each alert carries a stable `key` so the browser can tell a problem that is
 * still going on from a new one and only shout about the new ones.
 */
export function alertsFor(sample, t = THRESHOLDS) {
  const out = [];
  const add = (level, key, title, detail) => out.push({ level, key, title, detail });

  const cpu = sample.cpu.usedPct;
  if (cpu >= t.cpuCritical) add('critical', 'cpu', `CPU at ${cpu}%`, 'The processor is saturated — everything on this server is waiting for it.');
  else if (cpu >= t.cpuWarn) add('warning', 'cpu', `CPU at ${cpu}%`, 'Busy, with little headroom left.');

  if (sample.cpu.iowaitPct >= t.iowaitWarn) {
    add('warning', 'iowait', `${sample.cpu.iowaitPct}% of CPU time waiting on disk`,
      'The disk, not the processor, is what this server is waiting for.');
  }
  if (sample.cpu.stealPct >= 10) {
    add('warning', 'steal', `${sample.cpu.stealPct}% CPU steal`,
      'The host this VM runs on is giving its time to somebody else.');
  }

  const mem = sample.memory;
  if (mem.usedPct >= t.memoryCritical) {
    add('critical', 'memory', `Memory at ${mem.usedPct}%`,
      'Almost nothing is available — the kernel will start killing processes if this holds.');
  } else if (mem.usedPct >= t.memoryWarn) {
    add('warning', 'memory', `Memory at ${mem.usedPct}%`, 'Little memory left to hand out.');
  }
  if (mem.swapTotalBytes && mem.swapUsedPct >= t.swapWarn) {
    add('warning', 'swap', `Swap ${mem.swapUsedPct}% used`, 'The server is paging to disk, which makes everything slower.');
  }

  const perCore = sample.load.perCore;
  if (perCore >= t.loadCritical) {
    add('critical', 'load', `Load ${sample.load.one} on ${sample.load.cores} core(s)`,
      `${perCore} per core — far more work queued than this server can run.`);
  } else if (perCore >= t.loadWarn) {
    add('warning', 'load', `Load ${sample.load.one} on ${sample.load.cores} core(s)`, `${perCore} per core.`);
  }

  for (const d of sample.disks) {
    if (d.usedPct >= t.diskCritical) {
      add('critical', `disk:${d.mount}`, `${d.mount} is ${d.usedPct}% full`,
        `Only ${formatBytes(d.availableBytes)} left. A full disk stops databases and deployments dead.`);
    } else if (d.usedPct >= t.diskWarn) {
      add('warning', `disk:${d.mount}`, `${d.mount} is ${d.usedPct}% full`, `${formatBytes(d.availableBytes)} left.`);
    }
  }

  const d = sample.docker;
  if (d.installed && !d.running) {
    add('critical', 'docker', 'The Docker daemon is not running', 'Every container on this server is down with it.');
  }
  for (const c of d.containers) {
    if (c.state === 'restarting') {
      add('critical', `container:${c.name}`, `${c.name} is restarting in a loop`, c.status || 'It starts, fails and starts again.');
    } else if (c.state === 'dead') {
      add('critical', `container:${c.name}`, `${c.name} is dead`, c.status || '');
    } else if (c.health === 'unhealthy') {
      add('critical', `container:${c.name}`, `${c.name} is unhealthy`, c.status || 'Its health check is failing.');
    } else if (c.state === 'paused') {
      add('warning', `container:${c.name}`, `${c.name} is paused`, 'It is not answering anything while paused.');
    }
  }

  const order = { critical: 0, warning: 1 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

/* ------------------------------------------------------------- utils */

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

function formatBytes(n) {
  if (!n && n !== 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
