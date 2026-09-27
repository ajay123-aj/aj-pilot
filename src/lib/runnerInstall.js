/**
 * Installing a CI runner on one of your servers.
 *
 * Everything here is a bash script that is run over the server's existing SSH
 * connection as root. The scripts are written to be re-runnable: installing a
 * runner that is already there re-registers it rather than failing.
 *
 * The one line the panel needs back out of a run is the systemd unit the
 * runner ended up as, so every script prints it as AUTODEPLOY_SERVICE=<unit>.
 */

import { rootExec } from './ssh.js';

export const RUNNER_ROOT = '/opt/auto-deploy/runners';

/** Runner names become directory and unit names, so keep them boring. */
export function validateRunnerName(name) {
  const clean = String(name || '').trim();
  if (!clean) return 'A runner name is required';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/.test(clean)) {
    return 'The runner name may only use letters, numbers, dot, dash and underscore (2–63 characters)';
  }
  return null;
}

/** Shell-safe single-quoted literal. */
const q = (v) => `'${String(v ?? '').replace(/'/g, `'\\''`)}'`;

const marker = "printf 'AUTODEPLOY_SERVICE=%s\\n'";

/** Pull the unit name the installer reported back out of its output. */
export function serviceNameFrom(output) {
  const m = /AUTODEPLOY_SERVICE=(\S+)/.exec(output || '');
  return m ? m[1] : null;
}

const lines = (t) => String(t || '').split('\n').map((l) => l.trim()).filter(Boolean);

/** A systemd unit name, before it goes anywhere near a command line. */
const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,180}$/;

/* --------------------------------------------------------- live state */

/**
 * What the runners on this server are actually doing.
 *
 * The provider's view — what GitHub or GitLab lists — is a different question
 * from whether the process is up on the machine, and the two disagree often
 * enough to be worth asking separately: a runner whose service died still sits
 * in GitHub's list as "offline", and a runner the panel never installed does
 * not appear there at all.
 *
 * `Runner.Worker` is the process GitHub's runner forks for a job, so its
 * presence is how the panel can say a runner is busy right now.
 */
export async function runnerState(conn, server, services = []) {
  const units = services.filter((s) => SERVICE_NAME.test(String(s || '')));

  const script = `export LC_ALL=C
echo '@@@units'
${units.map((s) => `printf '%s\\t%s\\t%s\\t%s\\t%s\\n' ${q(s)} \\
  "$(systemctl is-active ${q(s)} 2>/dev/null || echo unknown)" \\
  "$(systemctl is-enabled ${q(s)} 2>/dev/null || echo unknown)" \\
  "$(systemctl show ${q(s)} -p ActiveEnterTimestamp --value 2>/dev/null)" \\
  "$(systemctl show ${q(s)} -p MainPID --value 2>/dev/null)"`).join('\n')}
echo '@@@found'
# Every runner unit on the machine, including ones this panel never installed.
systemctl list-units --type=service --all --no-legend --plain 2>/dev/null \\
  | awk '$1 ~ /^(actions\\.runner\\.|gitlab-runner)/ {print $1"\\t"$3"\\t"$4}'
echo '@@@workers'
# One line per job actually executing right now.
pgrep -a -f 'Runner.Worker' 2>/dev/null | head -n 20
pgrep -a -f 'gitlab-runner-helper' 2>/dev/null | head -n 20
echo '@@@done'
echo ok`;

  const result = await rootExec(conn, server, script, { timeout: 60000 });
  const sections = {};
  let current = null;
  for (const line of result.stdout.split(/\r?\n/)) {
    const m = /^@@@(\w+)$/.exec(line.trim());
    if (m) { current = m[1]; sections[current] = []; } else if (current) sections[current].push(line);
  }
  for (const k of Object.keys(sections)) sections[k] = sections[k].join('\n').trim();

  if (!sections.done) {
    throw new Error(`Could not read the runners on this server: ${(result.stderr || '').trim().slice(0, 200)}`);
  }

  const busyCount = lines(sections.workers).length;

  return {
    // Only a unit that reports `active` is running; everything else is not.
    units: lines(sections.units).map((line) => {
      const [service, active, enabled, since, pid] = line.split('\t');
      return {
        service,
        active: active || 'unknown',
        running: active === 'active',
        enabled: enabled || 'unknown',
        since: since || null,
        pid: Number(pid) > 0 ? Number(pid) : null,
      };
    }),
    found: lines(sections.found).map((line) => {
      const [service, active, sub] = line.split('\t');
      return { service, active, sub };
    }),
    jobsRunning: busyCount,
    workers: lines(sections.workers).slice(0, 5),
  };
}

/* ------------------------------------------------------------- GitHub */

/**
 * GitHub's runner is a tarball, not a package: download it, register it
 * against the repo or org, then let its own svc.sh write the systemd unit.
 */
function githubInstallScript({ dir, url, token, name, labels, version, serviceUser }) {
  return `set -euo pipefail
DIR=${q(dir)}

case "$(uname -m)" in
  x86_64)        ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  armv7l)        ARCH=arm ;;
  *) echo "Unsupported CPU architecture: $(uname -m)" >&2; exit 2 ;;
esac

VERSION=${q(version)}
mkdir -p "$DIR"
cd "$DIR"

if [ ! -x ./config.sh ]; then
  echo "Downloading actions-runner $VERSION for linux-$ARCH…"
  curl -fsSL --retry 3 -o runner.tar.gz \\
    "https://github.com/actions/runner/releases/download/v$VERSION/actions-runner-linux-$ARCH-$VERSION.tar.gz"
  tar xzf runner.tar.gz
  rm -f runner.tar.gz
fi

# Best effort: the runner needs libicu and friends to start.
if [ -x ./bin/installdependencies.sh ]; then
  DEBIAN_FRONTEND=noninteractive ./bin/installdependencies.sh >/dev/null 2>&1 || \\
    echo "warning: installdependencies.sh failed — the runner may still start" >&2
fi

# A runner already configured here is stopped first so --replace can re-enrol it.
if [ -f .runner ] && [ -x ./svc.sh ]; then ./svc.sh stop >/dev/null 2>&1 || true; fi

export RUNNER_ALLOW_RUNASROOT=1
./config.sh --unattended --replace \\
  --url ${q(url)} \\
  --token ${q(token)} \\
  --name ${q(name)} \\
  ${labels ? `--labels ${q(labels)} \\\n  ` : ''}--work _work

SVC_USER=${q(serviceUser || 'root')}
if [ "$SVC_USER" != "root" ] && id "$SVC_USER" >/dev/null 2>&1; then
  chown -R "$SVC_USER" "$DIR"
  ./svc.sh install "$SVC_USER"
else
  ./svc.sh install
fi
./svc.sh start

UNIT="$(cat "$DIR/.service" 2>/dev/null || true)"
systemctl enable "$UNIT" >/dev/null 2>&1 || true
${marker} "$UNIT"
systemctl is-active "$UNIT" || true
`;
}

function githubRemoveScript({ dir, token }) {
  return `set -uo pipefail
DIR=${q(dir)}
[ -d "$DIR" ] || { echo "Nothing installed at $DIR"; exit 0; }
cd "$DIR"

UNIT="$(cat "$DIR/.service" 2>/dev/null || true)"
if [ -x ./svc.sh ]; then
  ./svc.sh stop      >/dev/null 2>&1 || true
  ./svc.sh uninstall >/dev/null 2>&1 || true
fi

export RUNNER_ALLOW_RUNASROOT=1
if [ -x ./config.sh ]; then
  ${token ? `./config.sh remove --token ${q(token)} >/dev/null 2>&1 || ./config.sh remove --local >/dev/null 2>&1 || true`
    : './config.sh remove --local >/dev/null 2>&1 || true'}
fi

cd /
rm -rf "$DIR"
[ -n "$UNIT" ] && systemctl reset-failed "$UNIT" >/dev/null 2>&1 || true
echo "Removed $DIR"
`;
}

/* ------------------------------------------------------------- GitLab */

/**
 * GitLab ships a .deb, so this installs the package once and then registers
 * one more runner configuration into /etc/gitlab-runner/config.toml.
 */
function gitlabInstallScript({ url, token, name, executor, dockerImage }) {
  return `set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

if ! command -v gitlab-runner >/dev/null 2>&1; then
  echo "Installing the gitlab-runner package…"
  curl -fsSL "https://packages.gitlab.com/install/repositories/runner/gitlab-runner/script.deb.sh" | bash
  apt-get install -y gitlab-runner
fi

gitlab-runner register --non-interactive \\
  --url ${q(url)} \\
  --token ${q(token)} \\
  --name ${q(name)} \\
  --executor ${q(executor)} \\
  --docker-image ${q(dockerImage || 'alpine:latest')}

systemctl enable --now gitlab-runner >/dev/null 2>&1 || gitlab-runner start >/dev/null 2>&1 || true
${marker} "gitlab-runner.service"
systemctl is-active gitlab-runner || true
`;
}

function gitlabRemoveScript({ name }) {
  return `set -uo pipefail
if command -v gitlab-runner >/dev/null 2>&1; then
  gitlab-runner unregister --name ${q(name)} >/dev/null 2>&1 || true
  echo "Unregistered ${name}"
else
  echo "gitlab-runner is not installed on this host"
fi
`;
}

/* ------------------------------------------------------------ drivers */

/**
 * Install and start a runner. Returns the combined log and the systemd unit
 * it is now running as, so the panel can start/stop it later.
 */
export async function installRunner(conn, server, spec) {
  const script = spec.kind === 'gitlab'
    ? gitlabInstallScript(spec)
    : githubInstallScript(spec);

  // A cold install downloads ~200 MB and compiles nothing, but a slow link
  // still needs far longer than an ordinary command.
  const result = await rootExec(conn, server, script, { timeout: 15 * 60 * 1000 });
  const log = `${result.stdout}\n${result.stderr}`.trim();

  if (result.code !== 0) {
    const err = new Error(explainInstallFailure(log, result));
    err.cause = log;
    throw err;
  }
  return { log, serviceName: serviceNameFrom(log) };
}

/** Take a runner back off a server. Never throws — removal is best effort. */
export async function removeRunner(conn, server, spec) {
  const script = spec.kind === 'gitlab'
    ? gitlabRemoveScript(spec)
    : githubRemoveScript(spec);
  const result = await rootExec(conn, server, script, { timeout: 5 * 60 * 1000 });
  return { log: `${result.stdout}\n${result.stderr}`.trim(), ok: result.code === 0 };
}

function explainInstallFailure(log, result) {
  if (result.timedOut) return 'The runner install timed out — the server could not download the runner in time.';
  if (/sudo:.*(password is required|no tty|incorrect password)/i.test(log)) {
    return 'Installing a runner needs root, but sudo asked for a password the panel does not have. '
      + 'Connect as root, give the SSH user passwordless sudo, or store its sudo password on the server.';
  }
  if (/Invalid configuration provided for token|Response status code does not indicate success: 404|401/i.test(log)) {
    return 'The provider refused the registration token. Re-authenticate the git account and try again.';
  }
  if (/curl:.*(Could not resolve|Failed to connect)/i.test(log)) {
    return 'The server has no outbound internet access — it could not download the runner.';
  }
  if (/Unsupported CPU architecture/i.test(log)) {
    return log.split('\n').find((l) => /Unsupported CPU/.test(l));
  }
  const tail = log.split('\n').filter(Boolean).slice(-4).join(' · ');
  return `The runner install failed (exit code ${result.code})${tail ? `: ${tail.slice(0, 400)}` : ''}`;
}
