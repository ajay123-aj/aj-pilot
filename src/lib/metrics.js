/**
 * Statistics over time, for servers and the apps on them.
 *
 * The live view only ever holds the last few minutes, in the browser. This
 * keeps a sample every few minutes in the database instead — one SSH session
 * per server reads the machine and every container on it in the same pass —
 * so a day, a week or a month can be drawn later, and the cards can say
 * whether something is critical without opening a session of their own.
 *
 * Rows older than the retention window are dropped as the recorder goes.
 */

import { all, run } from '../db/index.js';
import { connectionFromRow, withConnection } from './ssh.js';
import { collectLiveStats, appUsage, THRESHOLDS } from './liveStats.js';
import { plannedContainers } from './deploy.js';

const EVERY_MINUTES = Math.max(1, Number(process.env.METRICS_EVERY_MINUTES || 5));
const KEEP_DAYS = Math.max(7, Number(process.env.METRICS_KEEP_DAYS || 35));
const CONCURRENCY = Math.max(1, Number(process.env.METRICS_CONCURRENCY || 4));
const ENABLED = String(process.env.METRICS_ENABLED ?? 'true').toLowerCase() !== 'false';

/** Each range: how far back, and how wide one point on the chart is. */
export const RANGES = {
  daily: { label: 'Last 24 hours', seconds: 86400, bucket: 3600 },
  weekly: { label: 'Last 7 days', seconds: 7 * 86400, bucket: 6 * 3600 },
  monthly: { label: 'Last 30 days', seconds: 30 * 86400, bucket: 86400 },
};

let timer = null;
let recording = false;
let lastPrune = 0;

const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const asJson = (v) => {
  if (!v) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
  return v;
};

/* ----------------------------------------------------------- levels */

/** An app is critical when it is down or pinning the server, warning when it is close. */
export function appLevel(usage) {
  if (!usage.total || usage.running < usage.total) return 'critical';
  if (usage.cpuOfHostPct >= THRESHOLDS.cpuCritical || usage.memoryOfHostPct >= THRESHOLDS.memoryCritical) return 'critical';
  if (usage.unhealthy || usage.restarting) return 'critical';
  if (usage.cpuOfHostPct >= THRESHOLDS.cpuWarn || usage.memoryOfHostPct >= THRESHOLDS.memoryWarn) return 'warning';
  return 'ok';
}

/* --------------------------------------------------------- recording */

const containerNames = (app) => plannedContainers({
  name: app.name,
  port: app.port,
  instances: app.instances,
  ports: asJson(app.container_ports) || null,
}).map((c) => c.name);

/** The disk the system lives on, or the fullest one when "/" is not listed. */
const rootDisk = (disks) => disks.find((d) => d.mount === '/') || [...disks].sort((a, b) => b.usedPct - a.usedPct)[0] || null;

async function recordServer(server, apps) {
  const sample = await withConnection(connectionFromRow(server), (conn) => collectLiveStats(conn, server, { withDocker: apps.length > 0 }));
  const at = sample.at.slice(0, 19).replace('T', ' ');
  const disk = rootDisk(sample.disks || []);

  const rows = [[
    server.org_id, 'server', server.id, at,
    round1(sample.cpu.usedPct), round1(sample.memory.usedPct), disk ? round1(disk.usedPct) : null,
    round1(sample.load.perCore * 100),
    Math.round(sample.network.rxBytesPerSec || 0), Math.round(sample.network.txBytesPerSec || 0),
    sample.worst,
  ]];

  const host = { cores: sample.load.cores || 1, memoryBytes: sample.memory.totalBytes || 0 };
  for (const app of apps) {
    const names = containerNames(app);
    const mine = sample.docker.containers.filter((c) => names.includes(c.name));
    const usage = {
      ...appUsage(mine, host),
      total: names.length,
      unhealthy: mine.some((c) => c.health === 'unhealthy'),
      restarting: mine.some((c) => c.state === 'restarting'),
    };
    rows.push([
      app.org_id, 'app', app.id, at,
      usage.cpuOfHostPct, usage.memoryOfHostPct, null, null,
      null, null,
      app.status === 'stopped' ? 'ok' : appLevel(usage),
    ]);
  }

  await run(`INSERT INTO metric_samples
    (org_id, kind, target_id, at, cpu_pct, memory_pct, disk_pct, load_pct, net_rx_bps, net_tx_bps, level) VALUES ?`, [rows]);
}

/** One pass over every reachable server. */
export async function recordMetrics() {
  if (recording) return;
  recording = true;
  try {
    const servers = await all("SELECT * FROM servers WHERE status = 'online'");
    const apps = await all(`SELECT id, org_id, server_id, name, port, instances, container_ports, status FROM apps
      WHERE server_id IS NOT NULL AND status NOT IN ('deploying', 'removing', 'pending', 'remove_failed')`);
    const appsOn = new Map();
    for (const a of apps) appsOn.set(a.server_id, [...(appsOn.get(a.server_id) || []), a]);

    let next = 0;
    const worker = async () => {
      while (next < servers.length) {
        const server = servers[next++];
        try {
          await recordServer(server, appsOn.get(server.id) || []);
        } catch (err) {
          console.error(`[metrics] ${server.name}: ${err.message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, servers.length) }, worker));

    if (Date.now() - lastPrune > 3600000) {
      lastPrune = Date.now();
      await run('DELETE FROM metric_samples WHERE at < UTC_TIMESTAMP() - INTERVAL ? DAY', [KEEP_DAYS]);
    }
  } finally {
    recording = false;
  }
}

export function startMetricsRecorder() {
  if (timer || !ENABLED) {
    if (!ENABLED) console.log('  Statistics history: disabled (METRICS_ENABLED=false)');
    return;
  }
  console.log(`  Statistics history: a sample every ${EVERY_MINUTES}m, kept ${KEEP_DAYS} days`);
  const tick = async () => {
    try {
      await recordMetrics();
    } catch (err) {
      console.error('[metrics] pass failed:', err.message);
    }
    timer = setTimeout(tick, EVERY_MINUTES * 60000);
    timer.unref?.();
  };
  // Let the health monitor mark servers online first.
  timer = setTimeout(tick, 20000);
  timer.unref?.();
}

/* ----------------------------------------------------------- reading */

/**
 * One server's or app's history over a range, one point per bucket. Buckets
 * with no samples come back with nulls so the chart shows the gap.
 * `tzOffsetMinutes` is the browser's getTimezoneOffset(), so a day starts at
 * the viewer's midnight rather than UTC's.
 */
export async function metricSeries(kind, targetId, orgId, rangeKey = 'daily', tzOffsetMinutes = 0) {
  const range = RANGES[rangeKey] || RANGES.daily;
  const { bucket, seconds } = range;
  const shift = -Math.max(-840, Math.min(840, Math.round(Number(tzOffsetMinutes) || 0))) * 60;
  const now = Math.floor(Date.now() / 1000);
  const end = Math.floor((now + shift) / bucket) * bucket - shift;
  const start = end - seconds + bucket;

  const rows = await all(`
    SELECT FLOOR((UNIX_TIMESTAMP(at) + ?) / ?) * ? - ? AS t,
           AVG(cpu_pct) AS cpu, MAX(cpu_pct) AS cpu_max,
           AVG(memory_pct) AS memory, MAX(memory_pct) AS memory_max,
           AVG(disk_pct) AS disk, MAX(disk_pct) AS disk_max,
           AVG(load_pct) AS load_avg, AVG(net_rx_bps) AS rx, AVG(net_tx_bps) AS tx,
           SUM(level = 'critical') AS critical, SUM(level = 'warning') AS warning, COUNT(*) AS samples
      FROM metric_samples
     WHERE kind = ? AND target_id = ? AND org_id = ? AND at >= FROM_UNIXTIME(?)
     GROUP BY t ORDER BY t`, [shift, bucket, bucket, shift, kind, targetId, orgId, start]);
  const byT = new Map(rows.map((r) => [Number(r.t), r]));
  const n = (v) => (v === null || v === undefined ? null : round1(v));

  const points = [];
  for (let t = start; t <= end; t += bucket) {
    const r = byT.get(t);
    points.push({
      at: new Date(t * 1000).toISOString(),
      cpu: n(r?.cpu), cpuMax: n(r?.cpu_max),
      memory: n(r?.memory), memoryMax: n(r?.memory_max),
      disk: n(r?.disk), diskMax: n(r?.disk_max),
      load: n(r?.load_avg),
      rx: r ? Math.round(Number(r.rx) || 0) : null,
      tx: r ? Math.round(Number(r.tx) || 0) : null,
      level: !r ? null : Number(r.critical) ? 'critical' : Number(r.warning) ? 'warning' : 'ok',
    });
  }

  const tally = rows.reduce((t, r) => ({
    critical: t.critical + Number(r.critical),
    warning: t.warning + Number(r.warning),
    samples: t.samples + Number(r.samples),
  }), { critical: 0, warning: 0, samples: 0 });

  return {
    range: rangeKey in RANGES ? rangeKey : 'daily',
    label: range.label,
    bucketSeconds: bucket,
    everyMinutes: EVERY_MINUTES,
    points,
    counts: { ...tally, ok: tally.samples - tally.critical - tally.warning },
  };
}

/** The newest sample for each of these targets: id → { level, at, cpu, memory, disk }. */
export async function latestLevels(kind, ids) {
  if (!ids.length) return new Map();
  const rows = await all(`
    SELECT m.target_id, m.level, m.at, m.cpu_pct, m.memory_pct, m.disk_pct
      FROM metric_samples m
      JOIN (SELECT target_id, MAX(at) AS at FROM metric_samples
             WHERE kind = ? AND target_id IN (${ids.map(() => '?').join(',')})
               AND at >= UTC_TIMESTAMP() - INTERVAL 1 HOUR
             GROUP BY target_id) last
        ON last.target_id = m.target_id AND last.at = m.at
     WHERE m.kind = ?`, [kind, ...ids, kind]);
  return new Map(rows.map((r) => [r.target_id, {
    level: r.level, at: r.at, cpu: r.cpu_pct, memory: r.memory_pct, disk: r.disk_pct,
  }]));
}
