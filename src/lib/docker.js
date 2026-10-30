/**
 * Docker on a managed server.
 *
 * Every command runs as root over the server's SSH connection, so it works
 * whether or not the login user is in the `docker` group. Nothing here
 * installs software onto the host except installEngine/installCompose —
 * everything else the panel offers runs as a container.
 */

import { rootExec } from './ssh.js';
import { splitSections } from './systemInfo.js';

/** Shell-safe single-quoted literal. */
const q = (v) => `'${String(v ?? '').replace(/'/g, `'\\''`)}'`;

const lines = (t) => String(t || '').split('\n').map((l) => l.trim()).filter(Boolean);

/** Container and network names go into a command line, so they are checked, not escaped. */
export function validateName(name, what = 'name') {
  const clean = String(name || '').trim();
  if (!clean) return { error: `A ${what} is required` };
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,62}$/.test(clean)) {
    return { error: `A ${what} may only use letters, numbers, dot, dash and underscore (2–63 characters)` };
  }
  return { value: clean };
}

export function validatePort(port, what = 'port') {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return { error: `The ${what} must be a number between 1 and 65535` };
  return { value: n };
}

/** Raised when the server has no usable Docker — the UI turns this into its own message. */
export class DockerMissingError extends Error {
  constructor(state) {
    super(state.installed
      ? 'Docker is installed on this server but the daemon is not running or cannot be reached. Start it, then try again.'
      : 'Docker is not installed on this server. Install Docker first from the Installations page, then come back.');
    this.name = 'DockerMissingError';
    this.state = state;
  }
}

/* ------------------------------------------------------------ registry */

export const DOCKER_HUB = 'https://index.docker.io/v1/';

/** A registry's address as a person would recognise it. */
export const registryLabel = (registry) =>
  (!registry || registry === DOCKER_HUB || /(^|\/\/)(index\.)?docker\.io/.test(registry) ? 'Docker Hub' : registry);

/**
 * Who this server is signed in to a registry as.
 *
 * Docker keeps that in config.json next to a base64 of "user:password", so
 * only the username is decoded here — the password is left on the server
 * where docker put it and never travels back.
 */
function registryProbe(server) {
  const home = server.username && server.username !== 'root'
    ? `$(getent passwd ${q(server.username)} 2>/dev/null | cut -d: -f6)`
    : '';

  return `info_user="$(docker info 2>/dev/null | sed -n 's/^ *Username: *//p' | head -n1)"
[ -n "$info_user" ] && echo "info_username=$info_user"
for home in /root ${home}; do
  cfg="$home/.docker/config.json"
  [ -f "$cfg" ] || continue
  echo "config=$cfg"
  store="$(tr -d ' \\n' < "$cfg" | grep -o '"credsStore":"[^"]*"' | cut -d'"' -f4)"
  [ -n "$store" ] && echo "creds_store=$store"
  tr -d ' \\n' < "$cfg" | sed 's/},/}\\n/g' | grep -o '"[^"]*":{"auth":"[^"]*"' | while IFS= read -r line; do
    reg="$(printf '%s' "$line" | cut -d'"' -f2)"
    who="$(printf '%s' "$line" | cut -d'"' -f6 | base64 -d 2>/dev/null | cut -d: -f1)"
    [ -n "$who" ] && echo "login=$home|$reg|$who"
  done
done`;
}

/** Turn the probe's lines into one list of registry sign-ins. */
function parseRegistry(text) {
  const logins = [];
  const meta = { infoUsername: null, credsStore: null, configs: [] };

  for (const line of lines(text)) {
    const i = line.indexOf('=');
    if (i < 0) continue;
    const key = line.slice(0, i);
    const value = line.slice(i + 1);

    if (key === 'info_username') meta.infoUsername = value;
    else if (key === 'creds_store') meta.credsStore = value;
    else if (key === 'config') meta.configs.push(value);
    else if (key === 'login') {
      const [home, registry, username] = value.split('|');
      if (!username) continue;
      logins.push({
        home,
        registry: registry || DOCKER_HUB,
        label: registryLabel(registry),
        username,
        isHub: registryLabel(registry) === 'Docker Hub',
      });
    }
  }

  // The CLI reports a Docker Hub username even when a credential helper hides
  // the auth entry from config.json; keep it rather than claiming nobody is in.
  if (meta.infoUsername && !logins.some((l) => l.username === meta.infoUsername)) {
    logins.push({
      home: null,
      registry: DOCKER_HUB,
      label: 'Docker Hub',
      username: meta.infoUsername,
      isHub: true,
      viaHelper: Boolean(meta.credsStore),
    });
  }

  return { logins, credsStore: meta.credsStore, configs: meta.configs };
}

/* ------------------------------------------------------- sign in / out */

/**
 * `docker login` on the server.
 *
 * The password goes into the script rather than onto the command line, and
 * docker then stores it where it always does — in config.json on that host.
 */
export async function registryLogin(conn, server, { username, password, registry }) {
  const target = registry && registry !== DOCKER_HUB ? registry : '';
  const secret = Buffer.from(String(password), 'utf8').toString('base64');

  const script = `set -uo pipefail
printf '%s' "$(echo ${secret} | base64 -d)" \\
  | docker login --username ${q(username)} --password-stdin ${target ? q(target) : ''} 2>&1
rc=$?
echo '@@@who'
docker info 2>/dev/null | sed -n 's/^ *Username: *//p' | head -n1
exit $rc`;

  const result = await rootExec(conn, server, script, { timeout: 90000 });
  const output = `${result.stdout.split('@@@')[0]}\n${result.stderr}`.trim();

  if (result.code !== 0) throw new Error(explainLoginFailure(output, result, registryLabel(registry)));
  return { username, registry: registry || DOCKER_HUB, label: registryLabel(registry), output };
}

export async function registryLogout(conn, server, registry) {
  const target = registry && registry !== DOCKER_HUB ? registry : '';
  const result = await rootExec(conn, server, `docker logout ${target ? q(target) : ''} 2>&1`, { timeout: 60000 });
  if (result.code !== 0) throw dockerError(`Signing out of ${registryLabel(registry)}`, result);
  return { registry: registry || DOCKER_HUB, label: registryLabel(registry), output: result.stdout.trim() };
}

function explainLoginFailure(output, result, label) {
  if (/unauthorized|incorrect username or password|401/i.test(output)) {
    return `${label} rejected those credentials. For Docker Hub use an access token from Account Settings → Security, not your password.`;
  }
  if (/sudo:.*(password is required|no tty|incorrect password)/i.test(output)) {
    return 'Signing in to a registry needs root on this server, but sudo asked for a password the panel does not have.';
  }
  if (/Cannot connect to the Docker daemon/i.test(output)) return 'The Docker daemon is not running on this server.';
  if (/no such host|Temporary failure|timeout|dial tcp/i.test(output)) {
    return `The server could not reach ${label}. Check its outbound network access and the registry address.`;
  }
  const tail = lines(output).slice(-2).join(' · ');
  return `Signing in to ${label} failed${tail ? `: ${tail.slice(0, 300)}` : ` (exit code ${result.code})`}`;
}

/* --------------------------------------------------------------- state */

/** Is Docker there, does it run, what is on it. */
export async function dockerState(conn, server) {
  const script = `export LC_ALL=C
echo '@@@state'
if command -v docker >/dev/null 2>&1; then
  echo "installed=yes"
  echo "cli_version=$(docker --version 2>/dev/null)"
  if docker info >/dev/null 2>&1; then
    echo "running=yes"
    echo "server_version=$(docker info --format '{{.ServerVersion}}' 2>/dev/null)"
    echo "containers_running=$(docker info --format '{{.ContainersRunning}}' 2>/dev/null)"
    echo "containers_total=$(docker info --format '{{.Containers}}' 2>/dev/null)"
    echo "images=$(docker info --format '{{.Images}}' 2>/dev/null)"
    echo "root_dir=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null)"
  else
    echo "running=no"
  fi
else
  echo "installed=no"
fi
echo "compose=$(docker compose version --short 2>/dev/null)"
echo '@@@networks'
docker network ls --format '{{.ID}}\\t{{.Name}}\\t{{.Driver}}\\t{{.Scope}}' 2>/dev/null
echo '@@@containers'
docker ps -a --format '{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.State}}\\t{{.Status}}\\t{{.Ports}}\\t{{.Label "auto-deploy.kind"}}\\t{{.Label "auto-deploy.app"}}\\t{{.RunningFor}}' 2>/dev/null
echo '@@@volumes'
docker volume ls --format '{{.Name}}\\t{{.Driver}}\\t{{.Scope}}\\t{{.Mountpoint}}' 2>/dev/null
echo '@@@volumesizes'
# Sizes come from a separate call because listing volumes does not carry them.
docker system df -v --format '{{json .Volumes}}' 2>/dev/null
echo '@@@mounts'
# One inspect for every container, so each volume can say what is using it.
docker ps -aq 2>/dev/null | xargs -r docker inspect \\
  --format '{{.Name}}{{"\\t"}}{{.State.Status}}{{"\\t"}}{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}' 2>/dev/null
echo '@@@registry'
${registryProbe(server)}
echo '@@@done'
echo ok`;

  const result = await rootExec(conn, server, script, { timeout: 60000 });
  const s = splitSections(result.stdout);
  if (!s.done) {
    throw new Error(`Could not read Docker on this server: ${(result.stderr || result.stdout || '').trim().slice(0, 300)}`);
  }

  const kv = {};
  for (const line of lines(s.state)) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
  }

  const installed = kv.installed === 'yes';
  const running = kv.running === 'yes';

  return {
    installed,
    running,
    cliVersion: kv.cli_version || null,
    serverVersion: kv.server_version || null,
    composeVersion: kv.compose || null,
    composeInstalled: Boolean(kv.compose),
    containersRunning: Number(kv.containers_running || 0),
    containersTotal: Number(kv.containers_total || 0),
    images: Number(kv.images || 0),
    rootDir: kv.root_dir || null,
    networks: lines(s.networks).map((l) => {
      const [id, name, driver, scope] = l.split('\t');
      return { id, name, driver, scope };
    }),
    containers: lines(s.containers).map((l) => {
      const [id, name, image, state, status, ports, kind, app, age] = l.split('\t');
      // Containers the panel made carry auto-deploy.* labels: an app's, or an installed service's.
      return { id, name, image, state, status, ports: ports || '', managedKind: kind || null, managedApp: app || null, created: age || null };
    }),
    volumes: parseVolumes(s),
    registry: parseRegistry(s.registry),
  };
}

/**
 * Every named volume, with its size and what is using it.
 *
 * Three readings are folded together: the list itself, `system df` for sizes,
 * and one inspect per container for the mounts — because a volume nothing uses
 * any more is the thing worth spotting, and neither call says so alone.
 */
function parseVolumes(s) {
  const sizes = new Map();
  try {
    // `docker system df -v` reports null rather than [] on an empty daemon.
    for (const v of JSON.parse(s.volumesizes || '[]') || []) {
      sizes.set(v.Name, { size: v.Size ?? null, links: Number(v.Links ?? 0) });
    }
  } catch { /* an older daemon without --format leaves sizes unknown */ }

  // container → volumes becomes volume → containers.
  const users = new Map();
  for (const line of lines(s.mounts)) {
    const [rawName, state, volumes] = line.split('\t');
    const container = String(rawName || '').replace(/^\//, '');
    if (!container || !volumes) continue;
    for (const volume of volumes.trim().split(/\s+/).filter(Boolean)) {
      if (!users.has(volume)) users.set(volume, []);
      users.get(volume).push({ container, state });
    }
  }

  return lines(s.volumes).map((line) => {
    const [name, driver, scope, mountpoint] = line.split('\t');
    const usedBy = users.get(name) || [];
    const known = sizes.get(name);
    return {
      name,
      driver: driver || 'local',
      scope: scope || 'local',
      mountpoint: mountpoint || null,
      // "20.5MB" as docker printed it, or null when the daemon would not say.
      size: known?.size ?? null,
      usedBy,
      inUse: usedBy.length > 0,
      // A volume with no container attached is what `docker volume prune` takes.
      dangling: usedBy.length === 0,
    };
  });
}

/** Read the state and refuse to go further if Docker cannot run containers. */
export async function requireDocker(conn, server) {
  const state = await dockerState(conn, server);
  if (!state.installed || !state.running) throw new DockerMissingError(state);
  return state;
}

/* ------------------------------------------------------------ networks */

/** A user-defined bridge network, so containers can find each other by name. */
export async function createNetwork(conn, server, name, driver = 'bridge') {
  const script = `set -uo pipefail
if docker network inspect ${q(name)} >/dev/null 2>&1; then
  echo "EXISTS" >&2
  exit 17
fi
docker network create --driver ${q(driver)} ${q(name)} 2>&1`;

  const result = await rootExec(conn, server, script, { timeout: 60000 });
  if (result.code === 17) throw new Error(`A Docker network named "${name}" already exists on this server`);
  if (result.code !== 0) throw dockerError(`Creating the network "${name}"`, result);
  return { name, id: result.stdout.trim().split('\n').pop() };
}

/* ------------------------------------------------------------- volumes */

/**
 * Remove a named volume.
 *
 * Docker refuses while a container still references it, which is the safety
 * net here — the panel does not force it, and says who is holding it instead.
 */
export async function removeVolume(conn, server, name) {
  const result = await rootExec(conn, server, `docker volume rm ${q(name)} 2>&1`, { timeout: 60000 });
  if (result.code !== 0) {
    const text = `${result.stdout}${result.stderr}`;
    if (/volume is in use/i.test(text)) {
      const ids = (/\[([^\]]+)\]/.exec(text) || [])[1];
      throw new Error(`"${name}" is still attached to a container${ids ? ` (${ids.slice(0, 120)})` : ''}. `
        + 'Remove that container first — deleting the volume would take its data with it.');
    }
    if (/no such volume/i.test(text)) throw new Error(`This server has no volume called "${name}".`);
    throw dockerError(`Removing the volume "${name}"`, result);
  }
  return { name, removed: true };
}

export async function removeNetwork(conn, server, name) {
  const result = await rootExec(conn, server, `docker network rm ${q(name)} 2>&1`, { timeout: 60000 });
  if (result.code !== 0) {
    const text = `${result.stdout}${result.stderr}`;
    if (/has active endpoints/i.test(text)) {
      throw new Error(`"${name}" still has containers attached. Remove or disconnect them first.`);
    }
    if (/predefined network|is a pre-defined network/i.test(text)) {
      throw new Error(`"${name}" is one of Docker's built-in networks and cannot be removed.`);
    }
    throw dockerError(`Removing the network "${name}"`, result);
  }
  return { name, removed: true };
}

/* ---------------------------------------------------------- containers */

/**
 * Run a container. Everything the panel installs goes through here, so the
 * flags — restart policy, named volume, published port, network — are the
 * same for every service.
 */
export async function runContainer(conn, server, spec) {
  const script = `set -uo pipefail
if docker ps -a --format '{{.Names}}' | grep -qx ${q(spec.name)}; then
  echo "EXISTS" >&2
  exit 17
fi

${spec.prepare ? `# Host settings this image cannot make for itself.
${spec.prepare}
` : ''}

echo "Pulling ${spec.image}:${spec.tag}…"
docker pull ${q(`${spec.image}:${spec.tag}`)} 2>&1 | tail -n 3

${dockerRunLine(spec)} 2>&1

sleep 3
echo '@@@state'
echo "id=$(docker inspect -f '{{.Id}}' ${q(spec.name)} 2>/dev/null | cut -c1-12)"
echo "state=$(docker inspect -f '{{.State.Status}}' ${q(spec.name)} 2>/dev/null)"
echo "exit_code=$(docker inspect -f '{{.State.ExitCode}}' ${q(spec.name)} 2>/dev/null)"
echo '@@@logs'
docker logs --tail 40 ${q(spec.name)} 2>&1 | tail -n 40

# A container that died on startup is a failed install, not a successful one.
[ "$(docker inspect -f '{{.State.Status}}' ${q(spec.name)} 2>/dev/null)" = "running" ] || exit 9`;

  const result = await rootExec(conn, server, script, { timeout: 15 * 60 * 1000 });
  const s = splitSections(result.stdout);
  const state = {};
  for (const line of lines(s.state)) {
    const i = line.indexOf('=');
    if (i > 0) state[line.slice(0, i)] = line.slice(i + 1);
  }
  const logs = lines(s.logs);

  if (result.code === 17) {
    throw new Error(`A container named "${spec.name}" already exists on this server. Pick another name, or remove that container first.`);
  }
  if (result.code !== 0) {
    const err = new Error(explainRunFailure(spec, result, logs));
    err.cause = `${result.stdout.split('@@@')[0]}\n${result.stderr}\n${logs.join('\n')}`.trim();
    throw err;
  }

  return { name: spec.name, containerId: state.id || null, state: state.state || null, logs };
}

export const CONTAINER_ACTIONS = ['start', 'stop', 'restart', 'pause', 'unpause'];

/** start / stop / restart / pause / unpause a container. */
export async function containerAction(conn, server, name, action) {
  if (!CONTAINER_ACTIONS.includes(action)) throw new Error(`Unsupported action "${action}"`);
  const script = `set -uo pipefail
rc=0
docker ${action} ${q(name)} >/dev/null 2>&1 || rc=$?
echo '@@@state'
echo "state=$(docker inspect -f '{{.State.Status}}' ${q(name)} 2>/dev/null)"
echo '@@@logs'
docker logs --tail 20 ${q(name)} 2>&1 | tail -n 20
exit $rc`;

  const result = await rootExec(conn, server, script, { timeout: 120000 });
  const s = splitSections(result.stdout);
  const state = (/state=(\S*)/.exec(s.state || '') || [])[1] || null;
  if (result.code !== 0) throw dockerError(`${action} ${name}`, result, lines(s.logs));
  return { name, action, state, logs: lines(s.logs) };
}

export async function containerLogs(conn, server, name, tail = 200) {
  // Capped so one request cannot pull a container's whole history through the panel.
  const n = Math.min(Math.max(1, (Number(tail) | 0) || 200), 5000);
  const result = await rootExec(conn, server,
    `docker logs --tail ${n} ${q(name)} 2>&1 | tail -n ${n}`,
    { timeout: 60000 });
  if (result.code !== 0 && !result.stdout.trim()) throw dockerError(`Reading the logs of ${name}`, result);
  return lines(result.stdout);
}

/**
 * Everything worth knowing about one container, in one SSH round trip:
 * inspect, a one-shot stats sample, its processes, its size and recent logs.
 * Environment values stay on the server — only the variable names come back.
 */
export async function containerDetails(conn, server, name) {
  const script = `N=${q(name)}
docker inspect --type container "$N" >/dev/null 2>&1 || { echo "There is no container called $N" >&2; exit 4; }
echo '@@@inspect'
docker inspect --type container "$N"
echo '@@@stats'
docker stats --no-stream --format '{{json .}}' "$N" 2>/dev/null
echo '@@@size'
docker ps -a --size --filter "id=$(docker inspect -f '{{.Id}}' "$N")" --format '{{.Size}}' 2>/dev/null
echo '@@@top'
docker top "$N" -eo pid,user,pcpu,pmem,etime,args 2>/dev/null | head -n 60
echo '@@@volumes'
docker inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}{{"\\n"}}{{end}}{{end}}' "$N" 2>/dev/null | while read -r v; do
  [ -n "$v" ] || continue
  M="$(docker volume inspect -f '{{.Mountpoint}}' "$v" 2>/dev/null)"
  S="$([ -d "$M" ] && timeout 10 du -sb "$M" 2>/dev/null | cut -f1)"
  U="$(docker ps -a --filter "volume=$v" --format '{{.Names}}' 2>/dev/null | tr '\\n' ' ')"
  printf '%s\\t%s\\t%s\\t%s\\n' "$v" "$M" "$S" "$U"
done
echo '@@@logs'
docker logs --tail 150 --timestamps "$N" 2>&1 | tail -n 150`;

  const result = await rootExec(conn, server, script, { timeout: 90000 });
  if (result.code === 4) throw new Error(`There is no container called ${name} on this server`);
  const s = splitSections(result.stdout);
  let c;
  try {
    [c] = JSON.parse(s.inspect || '[]');
  } catch {
    throw dockerError(`Inspecting ${name}`, result);
  }
  if (!c) throw new Error(`There is no container called ${name} on this server`);

  let stats = null;
  try { stats = s.stats ? JSON.parse(s.stats.split('\n')[0]) : null; } catch { /* stopped containers have none */ }

  const st = c.State || {};
  const cfg = c.Config || {};
  const host = c.HostConfig || {};
  const ports = [];
  for (const [inside, bindings] of Object.entries(c.NetworkSettings?.Ports || {})) {
    if (!bindings) ports.push({ inside, host: null });
    else for (const b of bindings) ports.push({ inside, host: `${b.HostIp || '0.0.0.0'}:${b.HostPort}` });
  }
  const topLines = lines(s.top);
  const volumes = new Map(lines(s.volumes).map((l) => {
    const [vol, mountpoint, size, users] = l.split('\t');
    return [vol, { mountpoint: mountpoint || null, sizeBytes: size ? Number(size) : null, usedBy: String(users || '').split(' ').filter(Boolean) }];
  }));

  return {
    id: String(c.Id || '').slice(0, 12),
    name: String(c.Name || name).replace(/^\//, ''),
    image: cfg.Image || c.Image,
    imageId: String(c.Image || '').replace(/^sha256:/, '').slice(0, 12),
    created: c.Created || null,
    state: {
      status: st.Status || null,
      running: Boolean(st.Running),
      paused: Boolean(st.Paused),
      restarting: Boolean(st.Restarting),
      oomKilled: Boolean(st.OOMKilled),
      exitCode: st.ExitCode ?? null,
      error: st.Error || null,
      startedAt: st.StartedAt && !st.StartedAt.startsWith('0001') ? st.StartedAt : null,
      finishedAt: st.FinishedAt && !st.FinishedAt.startsWith('0001') ? st.FinishedAt : null,
      health: st.Health ? { status: st.Health.Status, failingStreak: st.Health.FailingStreak, last: (st.Health.Log || []).slice(-1)[0]?.Output?.trim()?.slice(0, 300) || null } : null,
    },
    restartCount: c.RestartCount ?? 0,
    restartPolicy: host.RestartPolicy?.Name ? `${host.RestartPolicy.Name}${host.RestartPolicy.MaximumRetryCount ? ` (max ${host.RestartPolicy.MaximumRetryCount})` : ''}` : 'no',
    command: [...(cfg.Entrypoint || []), ...(cfg.Cmd || [])].join(' ') || null,
    workingDir: cfg.WorkingDir || null,
    user: cfg.User || null,
    hostname: cfg.Hostname || null,
    limits: {
      memory: host.Memory || 0,
      cpus: host.NanoCpus ? host.NanoCpus / 1e9 : null,
      privileged: Boolean(host.Privileged),
      networkMode: host.NetworkMode || null,
    },
    ports,
    mounts: (c.Mounts || []).map((m) => {
      const v = m.Type === 'volume' ? volumes.get(m.Name) : null;
      return {
        type: m.Type,
        source: m.Name || m.Source,
        destination: m.Destination,
        readOnly: m.RW === false,
        // A volume Docker named itself (64 hex characters) belongs to this container alone.
        anonymous: m.Type === 'volume' && /^[0-9a-f]{64}$/.test(m.Name || ''),
        mountpoint: v?.mountpoint || (m.Type === 'volume' ? m.Source : null),
        sizeBytes: v?.sizeBytes ?? null,
        // Other containers that have the same volume.
        sharedWith: (v?.usedBy || []).filter((u) => u !== String(c.Name || '').replace(/^\//, '')),
      };
    }),
    networks: Object.entries(c.NetworkSettings?.Networks || {}).map(([net, n]) => ({ name: net, ip: n.IPAddress || null, gateway: n.Gateway || null, aliases: n.Aliases || [] })),
    env: (cfg.Env || []).map((e) => e.split('=')[0]).filter(Boolean).sort(),
    labels: cfg.Labels || {},
    managedKind: cfg.Labels?.['auto-deploy.kind'] || null,
    size: (s.size || '').trim() || null,
    stats: stats ? {
      cpu: stats.CPUPerc, memory: stats.MemUsage, memoryPct: stats.MemPerc, net: stats.NetIO, block: stats.BlockIO, pids: stats.PIDs,
    } : null,
    processes: topLines.length > 1 ? { header: topLines[0].split(/\s+/), rows: topLines.slice(1).map((l) => l.split(/\s+/)) } : null,
    logs: lines(s.logs),
  };
}

/* ------------------------------------------------- live logs, downloads */

/**
 * Volume names Docker accepts. Anonymous volumes are 64 hex characters, one
 * longer than a container name may be, so they get their own check.
 */
export function validateVolumeName(name) {
  const clean = String(name || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(clean)) {
    return { error: 'A volume name may only use letters, numbers, dot, dash and underscore' };
  }
  return { value: clean };
}

/**
 * Follow a container's output: the last `tail` lines (or everything after
 * `since`, a timestamp from an earlier line), then each new one as it is
 * written, handed to `onLines` in whole lines. Each line starts with Docker's
 * RFC 3339 timestamp. Returns when the container stops, `signal` aborts or
 * `seconds` pass — `timeout` on the server makes sure `docker logs -f` cannot
 * outlive the panel's side of it, since closing an SSH channel does not always
 * stop the command at the other end.
 */
export async function followLogs(conn, server, name, { tail = 200, since = null, seconds = 900, signal, onLines }) {
  const n = Math.min(Math.max(1, (Number(tail) | 0) || 200), 2000);
  const from = since && /^[\d\-T:.Z+]+$/.test(since) ? `--since ${q(since)}` : `--tail ${n}`;
  const limit = Math.max(10, Math.round(seconds));
  let partial = '';
  const result = await rootExec(conn, server,
    `exec timeout ${limit} docker logs -f ${from} --timestamps ${q(name)} 2>&1`, {
      timeout: (limit + 30) * 1000,
      signal,
      onOutput: (text) => {
        const parts = (partial + text).split('\n');
        partial = parts.pop();
        const whole = parts.map((l) => l.replace(/\r$/, '')).filter((l) => l !== '');
        if (whole.length) onLines(whole);
      },
    });
  if (partial.trim()) onLines([partial]);
  // 124 is `timeout` ending it on purpose; anything else with no output is a real failure.
  if (result.code !== 0 && result.code !== 124 && !signal?.aborted && !result.stdout.trim()) {
    throw dockerError(`Following the logs of ${name}`, result);
  }
}

/** The container's `docker inspect`, and its image's — the image's defaults are left out of a compose file. */
async function inspectWithImage(conn, server, name) {
  const script = `N=${q(name)}
docker inspect --type container "$N" >/dev/null 2>&1 || { echo "There is no container called $N" >&2; exit 4; }
echo '@@@container'
docker inspect --type container "$N"
echo '@@@image'
docker image inspect "$(docker inspect -f '{{.Image}}' "$N")" 2>/dev/null || echo '[]'
echo '@@@done'`;
  const result = await rootExec(conn, server, script, { timeout: 60000 });
  if (result.code === 4) throw new Error(`There is no container called ${name} on this server`);
  const s = splitSections(result.stdout);
  let container;
  try { [container] = JSON.parse(s.container || '[]'); } catch { /* reported below */ }
  if (!container) throw dockerError(`Inspecting ${name}`, result);
  let image = null;
  try { [image] = JSON.parse(s.image || '[]'); } catch { /* an image deleted since: no defaults to leave out */ }
  return { container, image };
}

/* A small YAML writer — enough for a compose file. Every string is double-quoted
   (JSON strings are valid YAML) and `$` is doubled, because compose would
   otherwise read `$VAR` in a value as a variable to fill in. */
const yStr = (v) => JSON.stringify(String(v).replace(/\$/g, '$$$$'));
const yKey = (k) => (/^[A-Za-z0-9_.-]+$/.test(k) ? k : JSON.stringify(k));
const yScalar = (v) => (typeof v === 'number' || typeof v === 'boolean' ? String(v) : yStr(v));

function toYaml(value, indent = 0) {
  const pad = ' '.repeat(indent);
  const out = [];
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      if (!v.length) continue;
      out.push(`${pad}${yKey(k)}:`);
      for (const item of v) out.push(`${pad}  - ${yScalar(item)}`);
    } else if (typeof v === 'object') {
      const inner = toYaml(v, indent + 2);
      out.push(inner ? `${pad}${yKey(k)}:\n${inner}` : `${pad}${yKey(k)}: {}`);
    } else {
      out.push(`${pad}${yKey(k)}: ${yScalar(v)}`);
    }
  }
  return out.join('\n');
}

/** Docker's nanoseconds as a compose duration. */
const dur = (ns) => (ns ? `${Math.round(ns / 1e6)}ms` : undefined);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const isAnonymous = (volume) => /^[0-9a-f]{64}$/.test(volume || '');

/**
 * A docker-compose.yml that recreates this container. Built from inspect, so it
 * is what the container *is*, whoever made it and however. Settings that are
 * only the image's defaults — its environment, command, labels — are left out
 * to keep the file readable.
 */
export function composeFromInspect(c, image = null, { at = new Date() } = {}) {
  const cfg = c.Config || {};
  const host = c.HostConfig || {};
  const img = image?.Config || {};
  const name = String(c.Name || '').replace(/^\//, '');

  const imageEnv = new Set(img.Env || []);
  const environment = (cfg.Env || []).filter((e) => !imageEnv.has(e));

  const imageLabels = img.Labels || {};
  const labels = Object.fromEntries(Object.entries(cfg.Labels || {})
    // Compose writes its own labels on `up`; old ones would point at a project that is not this one.
    .filter(([k, v]) => !k.startsWith('com.docker.compose.') && imageLabels[k] !== v));

  const ports = [];
  for (const [inside, bindings] of Object.entries(host.PortBindings || {})) {
    const [port, proto] = inside.split('/');
    for (const b of bindings || []) {
      const ip = b.HostIp && !['0.0.0.0', '::'].includes(b.HostIp) ? `${b.HostIp}:` : '';
      ports.push(`${ip}${b.HostPort ? `${b.HostPort}:` : ''}${port}${proto && proto !== 'tcp' ? `/${proto}` : ''}`);
    }
  }

  const volumes = [];
  const namedVolumes = {};
  for (const m of c.Mounts || []) {
    const ro = m.RW === false ? ':ro' : '';
    if (m.Type === 'volume') {
      if (isAnonymous(m.Name)) volumes.push(m.Destination);
      else {
        volumes.push(`${m.Name}:${m.Destination}${ro}`);
        namedVolumes[m.Name] = { name: m.Name };
      }
    } else if (m.Type === 'bind') {
      volumes.push(`${m.Source}:${m.Destination}${ro}`);
    }
  }

  const mode = host.NetworkMode || 'default';
  const nets = Object.keys(c.NetworkSettings?.Networks || {});
  let networkMode;
  let networks;
  const topNetworks = {};
  if (['host', 'none'].includes(mode) || mode.startsWith('container:')) networkMode = mode;
  else if (!nets.length || (nets.length === 1 && ['bridge', 'default'].includes(nets[0]))) networkMode = 'bridge';
  else {
    networks = nets;
    for (const n of nets) topNetworks[n] = { name: n };
  }

  const policy = host.RestartPolicy || {};
  const restart = policy.Name && policy.Name !== 'no'
    ? (policy.Name === 'on-failure' && policy.MaximumRetryCount ? `on-failure:${policy.MaximumRetryCount}` : policy.Name)
    : undefined;

  const hc = cfg.Healthcheck;
  const healthcheck = hc?.Test?.length && !same(hc, img.Healthcheck)
    ? (hc.Test[0] === 'NONE' ? { disable: true } : {
      test: hc.Test, interval: dur(hc.Interval), timeout: dur(hc.Timeout), retries: hc.Retries || undefined, start_period: dur(hc.StartPeriod),
    })
    : undefined;

  const service = {
    image: cfg.Image || c.Image,
    container_name: name,
    entrypoint: cfg.Entrypoint && !same(cfg.Entrypoint, img.Entrypoint) ? cfg.Entrypoint : undefined,
    command: cfg.Cmd && !same(cfg.Cmd, img.Cmd) ? cfg.Cmd : undefined,
    user: cfg.User && cfg.User !== img.User ? cfg.User : undefined,
    working_dir: cfg.WorkingDir && cfg.WorkingDir !== img.WorkingDir ? cfg.WorkingDir : undefined,
    // Docker names a container's host after its id unless told otherwise.
    hostname: cfg.Hostname && !String(c.Id || '').startsWith(cfg.Hostname) ? cfg.Hostname : undefined,
    restart,
    environment,
    ports,
    volumes,
    tmpfs: Object.keys(host.Tmpfs || {}),
    network_mode: networkMode,
    networks,
    privileged: host.Privileged || undefined,
    cap_add: host.CapAdd || undefined,
    cap_drop: host.CapDrop || undefined,
    extra_hosts: host.ExtraHosts || undefined,
    mem_limit: host.Memory || undefined,
    cpus: host.NanoCpus ? host.NanoCpus / 1e9 : undefined,
    shm_size: host.ShmSize && host.ShmSize !== 64 * 1024 * 1024 ? host.ShmSize : undefined,
    healthcheck,
    labels: Object.keys(labels).length ? labels : undefined,
  };

  const doc = { services: { [name]: service } };
  if (Object.keys(namedVolumes).length) doc.volumes = namedVolumes;
  if (Object.keys(topNetworks).length) doc.networks = topNetworks;

  return `# ${name} — rebuilt by AJ Pilot from \`docker inspect\` on ${at.toISOString()}
# Recreate it with: docker compose up -d
# This file holds the container's environment variables, passwords included. Keep it private.
${toYaml(doc)}
`;
}

/** The compose file for one container, ready to download. */
export async function containerCompose(conn, server, name) {
  const { container, image } = await inspectWithImage(conn, server, name);
  return composeFromInspect(container, image);
}

/** The `tmp=` and `size=` lines a packing script ends with. */
const packedFile = (stdout) => ({
  tmp: (/^tmp=(\S+)$/m.exec(stdout) || [])[1] || null,
  size: Number((/^size=(\d+)$/m.exec(stdout) || [])[1] || 0),
});

/**
 * Pack one container into a .tar.gz on the server and say where it is:
 * its compose file, its full inspect, a README, and a tar of every volume
 * mounted, named or anonymous. `pause` freezes a running container while the volumes are copied,
 * so a database's files are not caught half-written; a trap unpauses it on
 * any way out. The caller streams the file back and deletes it.
 */
export async function prepareContainerBackup(conn, server, name, { pause = false } = {}) {
  const { container, image } = await inspectWithImage(conn, server, name);
  const at = new Date();
  const compose = composeFromInspect(container, image, { at });
  const top = `${name}-backup-${at.toISOString().slice(0, 10)}`;
  const named = (container.Mounts || []).filter((m) => m.Type === 'volume' && m.Name).map((m) => m.Name);
  const binds = (container.Mounts || []).filter((m) => m.Type === 'bind');
  const readme = [
    `Backup of the container ${name}, made by AJ Pilot on ${at.toISOString()}.`,
    '',
    'docker-compose.yml       recreates the container (docker compose up -d)',
    'inspect.json             Docker\'s full description of it, as it was',
    `volumes/<name>.tar.gz    the contents of each volume it uses${named.length ? ':' : ' (it has none)'}`,
    ...named.map((v) => `  - ${v}`),
    '',
    ...(pause ? ['The container was paused while its volumes were copied.', ''] : []),
    ...(binds.length ? ['Folders mounted from the server are NOT in this backup — copy them separately:',
      ...binds.map((b) => `  - ${b.Source} -> ${b.Destination}`), ''] : []),
    'To restore a volume, create it and unpack into it:',
    '  docker volume create <name>',
    '  docker run --rm -v <name>:/v -v "$PWD/volumes":/b alpine tar -xzf /b/<name>.tar.gz -C /v',
    'then start the container with: docker compose up -d',
    '',
  ].join('\n');
  const b64 = (t) => Buffer.from(t, 'utf8').toString('base64');

  const script = `set -uo pipefail
N=${q(name)}
D="$(mktemp -d /tmp/.auto-deploy-bk-XXXXXXXX)"
T="$(mktemp /tmp/.auto-deploy-XXXXXXXXXXXX)"
paused=0
trap '[ "$paused" = 1 ] && docker unpause "$N" >/dev/null 2>&1; rm -rf "$D"' EXIT
fail() { echo "$1" >&2; rm -f "$T"; exit "$2"; }
B="$D/${top}"
mkdir -p "$B/volumes"
echo ${b64(compose)} | base64 -d > "$B/docker-compose.yml"
echo ${b64(readme)} | base64 -d > "$B/README.txt"
docker inspect --type container "$N" > "$B/inspect.json" || fail "Could not inspect $N" 4
${pause ? `if [ "$(docker inspect -f '{{.State.Running}} {{.State.Paused}}' "$N")" = "true false" ]; then
  docker pause "$N" >/dev/null && paused=1
fi` : ''}
for v in ${named.map(q).join(' ')}; do
  M="$(docker volume inspect -f '{{.Mountpoint}}' "$v" 2>/dev/null)" || fail "The volume $v is gone" 5
  # tar exits 1 when a file changed while it was read: still a usable copy.
  tar -czf "$B/volumes/$v.tar.gz" -C "$M" . 2>/dev/null; rc=$?
  [ $rc -le 1 ] || fail "Could not copy the volume $v (tar exit $rc)" 6
done
if [ "$paused" = 1 ]; then docker unpause "$N" >/dev/null 2>&1; paused=0; fi
tar -czf "$T" -C "$D" ${q(top)} || fail "Could not pack the backup" 7
chown ${q(server.username)} -- "$T" 2>/dev/null || chmod 644 -- "$T"
echo "tmp=$T"
echo "size=$(stat -c %s -- "$T")"`;

  const result = await rootExec(conn, server, script, { timeout: 60 * 60 * 1000 });
  const file = packedFile(result.stdout);
  if (result.code !== 0 || !file.tmp) throw dockerError(`Backing up ${name}`, result);
  return { ...file, fileName: `${top}.tar.gz`, volumes: named };
}

/** Pack one named volume's contents into a .tar.gz on the server and say where it is. */
export async function prepareVolumeArchive(conn, server, volume) {
  const script = `set -uo pipefail
V=${q(volume)}
M="$(docker volume inspect -f '{{.Mountpoint}}' "$V" 2>/dev/null)" || { echo "This server has no volume called $V" >&2; exit 4; }
[ -d "$M" ] || { echo "The volume $V is not a folder on this server (driver $(docker volume inspect -f '{{.Driver}}' "$V"))" >&2; exit 5; }
T="$(mktemp /tmp/.auto-deploy-XXXXXXXXXXXX)"
tar -czf "$T" -C "$M" . 2>/dev/null; rc=$?
[ $rc -le 1 ] || { rm -f "$T"; echo "Could not pack the volume (tar exit $rc)" >&2; exit 6; }
chown ${q(server.username)} -- "$T" 2>/dev/null || chmod 644 -- "$T"
echo "tmp=$T"
echo "size=$(stat -c %s -- "$T")"`;
  const result = await rootExec(conn, server, script, { timeout: 60 * 60 * 1000 });
  if (result.code === 4) throw new Error(`This server has no volume called "${volume}"`);
  const file = packedFile(result.stdout);
  if (result.code !== 0 || !file.tmp) throw dockerError(`Packing the volume "${volume}"`, result);
  return { ...file, fileName: `${volume}.tar.gz` };
}

/**
 * Remove any container. The panel's own (an app's, an installed service's)
 * are refused here — removing those belongs to their own pages, so the panel
 * forgets them too and keeps their volumes.
 */
export async function removeAnyContainer(conn, server, name, { volumes = false } = {}) {
  const script = `N=${q(name)}
docker inspect --type container "$N" >/dev/null 2>&1 || { echo "There is no container called $N" >&2; exit 4; }
KIND="$(docker inspect -f '{{index .Config.Labels "auto-deploy.kind"}}' "$N" 2>/dev/null)"
[ -n "$KIND" ] && [ "$KIND" != "<no value>" ] && { echo "managed=$KIND"; exit 17; }
docker rm -f ${volumes ? '-v ' : ''}"$N" 2>&1`;
  const result = await rootExec(conn, server, script, { timeout: 120000 });
  if (result.code === 17) {
    const kind = (/managed=(\S+)/.exec(result.stdout) || [])[1];
    throw new Error(kind === 'app'
      ? `${name} belongs to a custom service — remove it from the Apps page so the panel forgets it too.`
      : `${name} is a ${kind} the panel installed — remove it from Installations so the panel forgets it too.`);
  }
  if (result.code === 4) throw new Error(`There is no container called ${name} on this server`);
  if (result.code !== 0) throw dockerError(`Removing ${name}`, result);
  return { name, removed: true };
}

/** Remove a container, and its data volume only when asked. */
export async function removeContainer(conn, server, name, { volume = null, keepData = true } = {}) {
  const script = `set -uo pipefail
docker rm -f ${q(name)} >/dev/null 2>&1 || true
${volume && !keepData ? `docker volume rm ${q(volume)} >/dev/null 2>&1 || echo "note: the volume ${volume} could not be removed" >&2` : ''}
echo "removed ${name}"`;

  const result = await rootExec(conn, server, script, { timeout: 120000 });
  return { name, removed: true, log: `${result.stdout}\n${result.stderr}`.trim() };
}

/**
 * Change the published port.
 *
 * Docker cannot re-publish a port on a running container, so this recreates it
 * from the same image, volume and settings. The named volume is untouched, so
 * the data comes back with it.
 */
export async function recreateContainer(conn, server, spec) {
  const backup = `${spec.name}-auto-deploy-old`;
  const script = `set -uo pipefail
${spec.prepare ? `${spec.prepare}\n` : ''}docker rm -f ${q(backup)} >/dev/null 2>&1 || true
if docker ps -a --format '{{.Names}}' | grep -qx ${q(spec.name)}; then
  docker stop ${q(spec.name)} >/dev/null 2>&1 || true
  # Keep the old container until the new one is up, so nothing is lost on failure.
  docker rename ${q(spec.name)} ${q(backup)} 2>&1
fi

rc=0
${dockerRunLine(spec)} 2>&1 && sleep 3 && [ "$(docker inspect -f '{{.State.Status}}' ${q(spec.name)} 2>/dev/null)" = "running" ] || rc=$?

if [ $rc -ne 0 ]; then
  echo "The new container did not start — putting the previous one back." >&2
  docker rm -f ${q(spec.name)} >/dev/null 2>&1 || true
  docker rename ${q(backup)} ${q(spec.name)} >/dev/null 2>&1 || true
  docker start ${q(spec.name)} >/dev/null 2>&1 || true
  exit $rc
fi

docker rm -f ${q(backup)} >/dev/null 2>&1 || true
echo '@@@state'
echo "id=$(docker inspect -f '{{.Id}}' ${q(spec.name)} 2>/dev/null | cut -c1-12)"
echo "state=$(docker inspect -f '{{.State.Status}}' ${q(spec.name)} 2>/dev/null)"
echo '@@@logs'
docker logs --tail 30 ${q(spec.name)} 2>&1 | tail -n 30`;

  const result = await rootExec(conn, server, script, { timeout: 10 * 60 * 1000 });
  const s = splitSections(result.stdout);
  const state = {};
  for (const line of lines(s.state)) {
    const i = line.indexOf('=');
    if (i > 0) state[line.slice(0, i)] = line.slice(i + 1);
  }

  if (result.code !== 0) {
    const err = new Error(explainRunFailure(spec, result, lines(s.logs)));
    err.cause = `${result.stdout.split('@@@')[0]}\n${result.stderr}`.trim();
    throw err;
  }
  return { name: spec.name, containerId: state.id || null, state: state.state || null, logs: lines(s.logs) };
}

/** The `docker run` invocation itself — one definition, used by install and recreate. */
function dockerRunLine(spec) {
  const args = [
    'docker', 'run', '-d',
    '--name', q(spec.name),
    '--restart', q(spec.restart || 'unless-stopped'),
    '--label', q('auto-deploy=1'),
    '--label', q(`auto-deploy.kind=${spec.kind}`),
  ];
  if (spec.network) args.push('--network', q(spec.network));
  if (spec.port && spec.containerPort) args.push('-p', q(`${spec.bind || '0.0.0.0'}:${spec.port}:${spec.containerPort}`));
  // A service that answers on more than one port — a broker's dashboard, a
  // search engine's transport port — publishes the rest here.
  for (const extra of spec.extraPorts || []) {
    if (extra.port && extra.containerPort) args.push('-p', q(`${spec.bind || '0.0.0.0'}:${extra.port}:${extra.containerPort}`));
  }
  // Fixed flags from the catalog itself, never anything a person typed.
  for (const arg of spec.runArgs || []) args.push(q(arg));
  if (spec.volume && spec.volumePath) args.push('-v', q(`${spec.volume}:${spec.volumePath}`));
  for (const [key, value] of Object.entries(spec.env || {})) args.push('-e', q(`${key}=${value}`));
  args.push(q(`${spec.image}:${spec.tag}`));
  for (const part of spec.command || []) args.push(q(part));
  return args.join(' ');
}

/* --------------------------------------------------- installing docker */

/** Docker itself cannot be a container — this is the one real host install. */
export async function installEngine(conn, server) {
  const script = `set -uo pipefail
export DEBIAN_FRONTEND=noninteractive

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo "Docker is already installed and running."
else
  if ! command -v docker >/dev/null 2>&1; then
    echo "Installing Docker CE from get.docker.com…"
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
    sh /tmp/get-docker.sh 2>&1 | tail -n 15
    rm -f /tmp/get-docker.sh
  fi
  systemctl enable --now docker 2>&1 || true
fi

# So the login user can run docker directly as well.
if id ${q(server.username)} >/dev/null 2>&1 && [ ${q(server.username)} != "root" ]; then
  usermod -aG docker ${q(server.username)} 2>/dev/null || true
fi

echo '@@@state'
echo "version=$(docker --version 2>/dev/null)"
echo "running=$(docker info >/dev/null 2>&1 && echo yes || echo no)"
docker info >/dev/null 2>&1 || exit 9`;

  const result = await rootExec(conn, server, script, { timeout: 15 * 60 * 1000 });
  const log = `${result.stdout.split('@@@')[0]}\n${result.stderr}`.trim();
  if (result.code !== 0) {
    const err = new Error(explainHostInstall('Docker', result, log));
    err.cause = log;
    throw err;
  }
  return { log, version: (/version=(.*)/.exec(result.stdout) || [])[1]?.trim() || null };
}

/** The compose v2 plugin, so `docker compose` works. */
export async function installCompose(conn, server) {
  const script = `set -uo pipefail
export DEBIAN_FRONTEND=noninteractive

if docker compose version >/dev/null 2>&1; then
  echo "The compose plugin is already installed."
else
  apt-get update -qq 2>&1 | tail -n 2
  apt-get install -y docker-compose-plugin 2>&1 | tail -n 10 || {
    echo "The package was not available — installing the plugin binary instead."
    ARCH=$(uname -m); case "$ARCH" in x86_64) A=x86_64 ;; aarch64|arm64) A=aarch64 ;; *) A="$ARCH" ;; esac
    mkdir -p /usr/local/lib/docker/cli-plugins
    curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$A" \\
      -o /usr/local/lib/docker/cli-plugins/docker-compose
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
  }
fi

echo '@@@state'
echo "version=$(docker compose version --short 2>/dev/null)"
docker compose version >/dev/null 2>&1 || exit 9`;

  const result = await rootExec(conn, server, script, { timeout: 10 * 60 * 1000 });
  const log = `${result.stdout.split('@@@')[0]}\n${result.stderr}`.trim();
  if (result.code !== 0) {
    const err = new Error(explainHostInstall('Docker Compose', result, log));
    err.cause = log;
    throw err;
  }
  return { log, version: (/version=(.*)/.exec(result.stdout) || [])[1]?.trim() || null };
}

/* ----------------------------------------------------------- failures */

function dockerError(what, result, extra = []) {
  const text = `${result.stdout}\n${result.stderr}\n${extra.join('\n')}`;
  if (/sudo:.*(password is required|no tty|incorrect password)/i.test(text)) {
    return new Error(`${what} needs root on this server, but sudo asked for a password the panel does not have. `
      + 'Connect as root, give the SSH user passwordless sudo, or store its sudo password on the server.');
  }
  if (/Cannot connect to the Docker daemon/i.test(text)) {
    return new Error('The Docker daemon is not running on this server.');
  }
  const tail = lines(text).slice(-3).join(' · ');
  const err = new Error(`${what} failed${tail ? `: ${tail.slice(0, 300)}` : ` (exit code ${result.code})`}`);
  err.cause = text.trim().slice(-4000);
  return err;
}

function explainRunFailure(spec, result, logs) {
  const text = `${result.stdout}\n${result.stderr}\n${logs.join('\n')}`;
  if (result.timedOut) return `Starting ${spec.name} timed out — the image was still downloading.`;
  if (/port is already allocated|address already in use/i.test(text)) {
    return `Port ${spec.port} is already in use on this server. Pick a different port.`;
  }
  if (/pull access denied|manifest unknown|not found: manifest/i.test(text)) {
    return `Docker could not find the image ${spec.image}:${spec.tag}. Check the version you picked.`;
  }
  if (/no space left on device/i.test(text)) return 'The server has run out of disk space.';
  if (/Cannot connect to the Docker daemon/i.test(text)) return 'The Docker daemon is not running on this server.';
  if (result.code === 9) {
    const tail = logs.slice(-4).join(' · ');
    return `${spec.name} started and then stopped${tail ? `: ${tail.slice(0, 300)}` : '. Check its logs.'}`;
  }
  const tail = lines(text).slice(-3).join(' · ');
  return `Installing ${spec.name} failed${tail ? `: ${tail.slice(0, 300)}` : ` (exit code ${result.code})`}`;
}

function explainHostInstall(what, result, log) {
  if (result.timedOut) return `Installing ${what} timed out.`;
  if (/sudo:.*(password is required|no tty|incorrect password)/i.test(log)) {
    return `Installing ${what} needs root, but sudo asked for a password the panel does not have. `
      + 'Connect as root, give the SSH user passwordless sudo, or store its sudo password on the server.';
  }
  if (/Could not resolve|Failed to connect|Temporary failure/i.test(log)) {
    return `The server has no outbound internet access, so ${what} could not be downloaded.`;
  }
  if (/Unable to locate package|E: Package/i.test(log)) {
    return `The package manager could not find ${what}. The log below has the detail.`;
  }
  const tail = lines(log).slice(-3).join(' · ');
  return `Installing ${what} failed${tail ? `: ${tail.slice(0, 300)}` : ` (exit code ${result.code})`}`;
}
