/**
 * Getting a Node repository onto a server as a running container.
 *
 * One script does the whole thing over the existing SSH connection: clone the
 * branch, write a Dockerfile if the repository has none, build the image,
 * optionally push it to a registry, then replace the running container. The
 * previous release is kept until the new container is up, so a build that
 * fails leaves the site as it was.
 */

import { rootExec } from './ssh.js';
import { splitSections } from './systemInfo.js';
import { buildDockerfile, NGINX_CONF } from './nodeApp.js';

export const APP_ROOT = '/opt/auto-deploy/apps';

const q = (v) => `'${String(v ?? '').replace(/'/g, `'\\''`)}'`;
const lines = (t) => String(t || '').split('\n').map((l) => l.trim()).filter(Boolean);

/** Base64 so a token, a password or an odd character never sits on a command line. */
const b64 = (text) => Buffer.from(String(text), 'utf8').toString('base64');

/**
 * The containers one app becomes. A single instance keeps the app's own name;
 * several are numbered, each on its own port.
 *
 * `spec.ports` is the list the person typed, one port per container. Rows saved
 * before ports could be chosen have none, so those still count up from the
 * first port, which is exactly where they were left.
 */
export function plannedContainers(spec) {
  const chosen = Array.isArray(spec.ports) ? spec.ports.map(Number).filter(Number.isInteger) : [];
  const count = chosen.length || Math.max(1, Number(spec.instances || 1));
  return Array.from({ length: count }, (_, i) => ({
    name: count === 1 ? spec.name : `${spec.name}-${i + 1}`,
    port: chosen[i] ?? Number(spec.port) + i,
    index: i + 1,
  }));
}

/**
 * The `docker run` for one container of an app.
 *
 * Environment comes last so a variable the person set wins over nothing else
 * we pass, and the labels are what lets a later change find these containers
 * again even after the app was renamed or resized.
 */
function runCommand(spec, c, image) {
  return [
    'docker', 'run', '-d',
    '--name', q(c.name),
    '--restart', q(spec.restart),
    '--label', q('auto-deploy=1'),
    '--label', q('auto-deploy.kind=app'),
    '--label', q(`auto-deploy.app=${spec.name}`),
    '-p', q(`0.0.0.0:${c.port}:${spec.containerPort}`),
    '-e', q(`PORT=${spec.containerPort}`),
    '-e', q(`INSTANCE=${c.index}`),
    ...(spec.network ? ['--network', q(spec.network)] : []),
    // Named volumes: Docker creates one the first time it is mounted and finds
    // the same one on every deploy after, which is what makes data survive.
    ...(spec.volumes || []).flatMap((v) => ['-v', q(`${v.name}:${v.path}${v.readOnly ? ':ro' : ''}`)]),
    ...(spec.env || []).flatMap(([k, v]) => ['-e', q(`${k}=${v}`)]),
    q(image),
  ].join(' ');
}

/** Containers this app owns that are not in the wanted list any more. */
const pruneBlock = (spec, containers) => `for old in $(docker ps -aq --filter ${q(`label=auto-deploy.app=${spec.name}`)}); do
  keep=no
  for want in ${containers.map((c) => q(c.name)).join(' ')}; do
    [ "$(docker inspect -f '{{.Name}}' "$old" 2>/dev/null | sed 's#^/##')" = "$want" ] && keep=yes
  done
  [ "$keep" = "no" ] && docker rm -f "$old" >/dev/null 2>&1 || true
done`;

/** `name|port|status|id` for every container, for the row and the card. */
const reportBlock = (containers) => `echo '@@@containers'
${containers.map((c) => `echo "${c.name}|${c.port}|$(docker inspect -f '{{.State.Status}}' ${q(c.name)} 2>/dev/null || echo missing)|$(docker inspect -f '{{.Id}}' ${q(c.name)} 2>/dev/null | cut -c1-12)"`).join('\n')}`;

const parseContainers = (text) => lines(text).map((line) => {
  const [name, port, status, id] = line.split('|');
  return { name, port: Number(port), status, id: id || null };
});

/**
 * Build and run one app.
 *
 * `cloneUrl` carries the git token, so every line of output is filtered before
 * it is stored or shown.
 */
export async function deployApp(conn, server, spec) {
  const dir = `${APP_ROOT}/${spec.name}`;
  const image = `${spec.image}:${spec.tag}`;
  const containers = plannedContainers(spec);

  const dockerfile = spec.useRepoDockerfile ? null : buildDockerfile({
    runtime: spec.runtime,
    nodeVersion: spec.nodeVersion,
    install: spec.install,
    build: spec.build,
    start: spec.start,
    outputDir: spec.outputDir,
    port: spec.containerPort,
  });

  const runArgs = containers.map((c) => `echo "  ${c.name} on port ${c.port}"
docker rm -f ${q(c.name)} >/dev/null 2>&1 || true
${runCommand(spec, c, image)} >/dev/null 2>&1 || { echo "${c.name} did not start" >&2; cd /; exit 7; }`).join('\n');

  // "::step::key::label::<unix time>" lines mark where the deploy is and when
  // each step began; the progress view builds its timeline from them.
  const step = (key, label) => `echo ${q(`::step::${key}::${label}::`)}"$(date +%s)"`;

  const script = `set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
DIR=${q(dir)}
NEW="$DIR.new"
OLD_IMAGE="$(docker inspect -f '{{.Image}}' ${q(containers[0].name)} 2>/dev/null || true)"

${step('prepare', 'Checking the server (git, Docker)')}
echo "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?') on $(hostname)"
command -v git >/dev/null 2>&1 || { echo "Installing git…"; apt-get update -qq 2>&1 | tail -n 2; apt-get install -y git 2>&1 | tail -n 3; }
command -v git >/dev/null 2>&1 || { echo "git could not be installed on this server" >&2; exit 3; }
echo "$(git --version)"

rm -rf "$NEW"
mkdir -p "$NEW"

${step('clone', `Cloning ${spec.repo} (${spec.branch})`)}
echo "Cloning ${spec.repo} (${spec.branch})…"
CLONE_URL="$(echo ${b64(spec.cloneUrl)} | base64 -d)"
git clone --depth 1 --single-branch --branch ${q(spec.branch)} "$CLONE_URL" "$NEW" 2>&1 | sed 's#//[^@/]*@#//***@#g'
[ -d "$NEW/.git" ] || { echo "The repository could not be cloned" >&2; rm -rf "$NEW"; exit 4; }
# The exact commit being built, for the panel to remember (auto deploy compares against it).
echo "::commit::$(git -C "$NEW" rev-parse HEAD 2>/dev/null)::$(git -C "$NEW" log -1 --format=%s 2>/dev/null | head -c 200)"
rm -rf "$NEW/.git"
echo "Cloned: $(ls -1A "$NEW" | wc -l) entries at the top level."
# The project may live in a folder of the repository (apps/api, apps/web, …); that folder is what gets built.
CTX="$NEW"${spec.rootDir ? `/${q(spec.rootDir)}` : ''}
${spec.rootDir ? `[ -d "$CTX" ] || { echo "The folder ${spec.rootDir} is not in ${spec.repo} on ${spec.branch}" >&2; rm -rf "$NEW"; exit 4; }
echo "Building the project in ${spec.rootDir}/ ($(ls -1A "$CTX" | wc -l) entries)."` : ''}

${step('dockerfile', dockerfile ? 'Writing the Dockerfile' : "Using the repository's own Dockerfile")}
${dockerfile ? `echo "Generated Dockerfile:"; echo ${b64(dockerfile)} | base64 -d | sed 's/^/  /'` : ''}
${dockerfile ? `echo ${b64(dockerfile)} | base64 -d > "$CTX/Dockerfile.autodeploy"
${spec.runtime === 'static' ? `echo ${b64(NGINX_CONF)} | base64 -d > "$CTX/nginx.autodeploy.conf"` : ''}
DOCKERFILE=Dockerfile.autodeploy` : `[ -f "$CTX/Dockerfile" ] || { echo "${spec.rootDir ? `The folder ${spec.rootDir}` : 'This repository'} has no Dockerfile" >&2; rm -rf "$NEW"; exit 5; }
DOCKERFILE=Dockerfile`}

${step('build', `Building the image ${image}`)}
echo "Building ${image}…"
cd "$CTX"
# Every line, as it happens — pulling the base image, installing packages, the build itself.
# BUILDKIT_PROGRESS=plain makes BuildKit print text instead of redrawing a terminal.
BUILDKIT_PROGRESS=plain docker build --pull -f "$DOCKERFILE" -t ${q(image)} . 2>&1
[ "\${PIPESTATUS[0]}" = "0" ] || { echo "The image did not build" >&2; cd /; rm -rf "$NEW"; exit 6; }

${spec.push ? `${step('push', 'Pushing the image to Docker Hub')}\n${pushBlock(spec)}` : ''}

${step('start', `Starting ${containers.length} container(s)`)}
echo "Starting ${containers.length} container(s)…"
# A previous deploy may have run more instances than this one does.
${pruneBlock(spec, containers)}

${runArgs}

${step('verify', 'Checking the container stays up')}
echo "Waiting a few seconds to see that it keeps running…"
sleep 4
STATE="$(docker inspect -f '{{.State.Status}}' ${q(containers[0].name)} 2>/dev/null || echo missing)"
if [ "$STATE" != "running" ]; then
  echo "@@@logs"
  docker logs --tail 40 ${q(containers[0].name)} 2>&1 | tail -n 40
  echo "@@@state"
  echo "state=$STATE"
  exit 8
fi

cd /
rm -rf "$DIR"
mv "$NEW" "$DIR"

# The image the previous release ran is no longer referenced by anything.
[ -n "$OLD_IMAGE" ] && docker image rm "$OLD_IMAGE" >/dev/null 2>&1 || true

echo '@@@state'
echo "state=$STATE"
echo "id=$(docker inspect -f '{{.Id}}' ${q(containers[0].name)} 2>/dev/null | cut -c1-12)"
echo "image_id=$(docker inspect -f '{{.Id}}' ${q(image)} 2>/dev/null | cut -c1-19)"
echo "size=$(docker image inspect -f '{{.Size}}' ${q(image)} 2>/dev/null)"
${reportBlock(containers)}
echo '@@@logs'
docker logs --tail 30 ${q(containers[0].name)} 2>&1 | tail -n 30`;

  // Output before the first "@@@" section is the human log; stream only that part.
  let streaming = true;
  const onOutput = spec.onProgress ? (text) => {
    if (!streaming) return;
    const cut = text.indexOf('@@@');
    if (cut >= 0) { streaming = false; text = text.slice(0, cut); }
    if (text) spec.onProgress(scrub(text));
  } : null;

  const result = await rootExec(conn, server, script, { timeout: 25 * 60 * 1000, onOutput });
  const sections = splitSections(result.stdout);
  const log = scrub(`${result.stdout.split('@@@')[0]}\n${result.stderr}`).trim();
  const logs = lines(sections.logs).map(scrub);

  const state = {};
  for (const line of lines(sections.state)) {
    const i = line.indexOf('=');
    if (i > 0) state[line.slice(0, i)] = line.slice(i + 1);
  }

  if (result.code !== 0) {
    const err = new Error(explainDeployFailure(spec, result, log, logs));
    err.cause = [log, logs.join('\n')].filter(Boolean).join('\n');
    throw err;
  }

  return {
    log,
    logs,
    containerId: state.id || null,
    image,
    imageId: state.image_id || null,
    imageBytes: Number(state.size || 0) || null,
    state: state.state || 'running',
    containers: parseContainers(sections.containers),
  };
}

/**
 * Apply a change that does not need a rebuild — different environment
 * variables, a different set of containers or different ports.
 *
 * Docker cannot change either on a running container, so each one is recreated
 * from the image already on the server. Nothing is cloned and nothing is built,
 * which is why this takes seconds where a redeploy takes minutes.
 */
export async function applyContainers(conn, server, spec) {
  const image = `${spec.image}:${spec.tag}`;
  const containers = plannedContainers(spec);

  const script = `set -uo pipefail
docker image inspect ${q(image)} >/dev/null 2>&1 || { echo "The image ${image} is not on this server — deploy the service again" >&2; exit 2; }

# Containers this app no longer has.
${pruneBlock(spec, containers)}

${containers.map((c) => `docker rm -f ${q(c.name)} >/dev/null 2>&1 || true
${runCommand(spec, c, image)} >/dev/null 2>&1 || { echo "${c.name} could not be started on port ${c.port}" >&2; exit 7; }`).join('\n')}

${spec.stopped
    // A service that was deliberately stopped is left stopped — it now simply
    // has the new environment and ports waiting for whenever it is started.
    ? containers.map((c) => `docker stop ${q(c.name)} >/dev/null 2>&1 || true`).join('\n')
    : 'sleep 2'}
${reportBlock(containers)}`;

  const result = await rootExec(conn, server, script, { timeout: 180000 });
  const list = parseContainers(splitSections(result.stdout).containers);

  if (result.code !== 0) {
    const detail = lines(result.stderr).slice(-3).join(' · ');
    if (/port is already allocated|address already in use/i.test(detail)) {
      throw new Error(`One of those ports is already in use on ${server.name}: ${detail.slice(0, 200)}`);
    }
    const err = new Error(detail ? detail.slice(0, 300) : `The containers could not be recreated (exit code ${result.code})`);
    err.cause = `${result.stdout}\n${result.stderr}`.trim();
    throw err;
  }

  return {
    containers: list,
    containerId: list[0]?.id || null,
    state: list.every((c) => c.status === 'running')
      ? 'running'
      : (spec.stopped ? 'exited' : (list[0]?.status || 'unknown')),
  };
}

/**
 * Push the freshly built image to a registry, logging in first if needed.
 *
 * The sign-in is checked on its own: a rejected token and a rejected push are
 * different problems, and saying "push denied" for a bad password sends people
 * looking in the wrong place.
 */
function pushBlock(spec) {
  return `echo "Pushing ${spec.image}:${spec.tag}…"
${spec.registryPassword ? `printf '%s' "$(echo ${b64(spec.registryPassword)} | base64 -d)" \\
  | docker login --username ${q(spec.registryUsername)} --password-stdin ${spec.registryHost ? q(spec.registryHost) : ''} 2>&1 | tail -n 3
[ "\${PIPESTATUS[1]}" = "0" ] || { echo "docker login was refused for ${spec.registryUsername}" >&2; cd /; exit 10; }` : ''}
docker push ${q(`${spec.image}:${spec.tag}`)} 2>&1 | tail -n 12
[ "\${PIPESTATUS[0]}" = "0" ] || { echo "The image built but could not be pushed" >&2; cd /; exit 9; }`;
}

/**
 * Stop, remove and forget every container this app runs as.
 *
 * Its volumes are kept unless asked for: they are the one part of a service
 * that cannot be rebuilt from the repository.
 */
export async function removeApp(conn, server, spec, { keepImage = true, keepVolumes = true } = {}) {
  const names = plannedContainers(spec).map((c) => c.name);
  const volumes = keepVolumes ? [] : (spec.volumes || []);

  const script = `set -uo pipefail
${names.map((n) => `docker rm -f ${q(n)} >/dev/null 2>&1 || true`).join('\n')}
# Anything labelled for this app, in case the instance count changed.
docker ps -aq --filter ${q(`label=auto-deploy.app=${spec.name}`)} | xargs -r docker rm -f >/dev/null 2>&1 || true
${keepImage ? '' : `docker image rm ${q(`${spec.image}:${spec.tag}`)} >/dev/null 2>&1 || true`}
${volumes.map((v) => `docker volume rm ${q(v.name)} >/dev/null 2>&1 || echo "note: the volume ${v.name} could not be removed" >&2`).join('\n')}
rm -rf ${q(`${APP_ROOT}/${spec.name}`)}
echo "removed ${spec.name} (${names.length} container(s)${volumes.length ? `, ${volumes.length} volume(s)` : ''})"`;

  const result = await rootExec(conn, server, script, { timeout: 120000 });
  return { ok: result.code === 0, log: `${result.stdout}\n${result.stderr}`.trim() };
}

/** start / stop / restart every container of one app. */
export async function appAction(conn, server, spec, action) {
  if (!['start', 'stop', 'restart'].includes(action)) throw new Error(`Unsupported action "${action}"`);
  const containers = plannedContainers(spec);

  const script = `set -uo pipefail
rc=0
${containers.map((c) => `docker ${action} ${q(c.name)} >/dev/null 2>&1 || rc=$?`).join('\n')}
echo '@@@containers'
${containers.map((c) => `echo "${c.name}|${c.port}|$(docker inspect -f '{{.State.Status}}' ${q(c.name)} 2>/dev/null || echo missing)|"`).join('\n')}
exit $rc`;

  const result = await rootExec(conn, server, script, { timeout: 180000 });
  const list = parseContainers(splitSections(result.stdout).containers);

  if (result.code !== 0 && !list.some((c) => c.status === 'running')) {
    throw new Error(`Could not ${action} ${spec.name}: ${lines(result.stderr).slice(-2).join(' · ').slice(0, 200) || 'docker refused'}`);
  }
  return { containers: list, state: list.every((c) => c.status === 'running') ? 'running' : (list[0]?.status || 'unknown') };
}

/** Never let a clone URL's token reach the database or the screen. */
const scrub = (text) => String(text || '')
  .replace(/\/\/[^@\s/]*@/g, '//***@')
  .replace(/(gh[pousr]_|glpat-|dckr_pat_)[A-Za-z0-9_-]+/g, '$1***');

function explainDeployFailure(spec, result, log, logs) {
  const text = `${log}\n${logs.join('\n')}`;

  if (result.timedOut) return 'The deployment timed out — the build took longer than 25 minutes.';
  if (result.code === 3) return 'This server has no git and the panel could not install it.';
  if (result.code === 4) {
    if (/Authentication failed|could not read Username|invalid credentials/i.test(text)) {
      return 'The git account could not clone that repository — re-authenticate it and try again.';
    }
    if (/Remote branch .* not found|couldn't find remote ref/i.test(text)) {
      return `The branch "${spec.branch}" does not exist in ${spec.repo}.`;
    }
    return `The repository could not be cloned onto the server. ${lines(text).slice(-2).join(' · ').slice(0, 200)}`;
  }
  if (result.code === 5) return 'You chose to use the repository\'s own Dockerfile, but there is none at its root.';
  if (result.code === 6) {
    const tail = lines(text).filter((l) => !/^\s*$/.test(l)).slice(-4).join(' · ');
    return `The image failed to build${tail ? `: ${tail.slice(0, 350)}` : '. The full build log is below.'}`;
  }
  if (result.code === 7) {
    if (/port is already allocated|address already in use/i.test(text)) {
      return `Port ${spec.port} is already in use on this server. Pick a different one.`;
    }
    return 'The container could not be started. The log below has the detail.';
  }
  if (result.code === 8) {
    const tail = logs.slice(-4).join(' · ');
    return `${spec.name} built and started, then stopped${tail ? `: ${tail.slice(0, 300)}` : '. Check its logs — the start command is the usual cause.'}`;
  }
  if (result.code === 9) {
    if (/denied|unauthorized/i.test(text)) {
      return `Docker Hub refused the push of ${spec.image}. The account must own that namespace and its access token needs `
        + 'Read & Write — a read-only token can pull but never push.';
    }
    if (/name unknown|repository does not exist/i.test(text)) {
      return `Docker Hub has no repository called ${spec.image}, and the account may not create one. `
        + 'Create it on Docker Hub first, or use an account whose username matches the image namespace.';
    }
    return `The image built but could not be pushed to Docker Hub${lines(text).slice(-2).join(' · ').slice(0, 200)}`;
  }
  if (result.code === 10) {
    return `Docker Hub rejected the sign-in for "${spec.registryUsername}". Check the username and use an access token `
      + '(Docker Hub → Account settings → Personal access tokens) rather than the account password.';
  }
  if (/no space left on device/i.test(text)) return 'The server has run out of disk space.';
  if (/sudo:.*(password is required|no tty)/i.test(text)) {
    return 'Deploying needs root on this server, but sudo asked for a password the panel does not have.';
  }
  const tail = lines(text).slice(-3).join(' · ');
  return `The deployment failed${tail ? `: ${tail.slice(0, 300)}` : ` (exit code ${result.code})`}`;
}
