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

/** The units svc.sh creates; nothing else is stopped or removed on a runner's behalf. */
const unitPattern = `RUNNER_UNIT='^actions\\.runner\\.[A-Za-z0-9._@:-]{1,180}\\.service$'`;

/**
 * GitHub's runner is a tarball, not a package: download it, register it
 * against the repo or org, then let its own svc.sh write the systemd unit.
 *
 * CI jobs run as the service user, and root later runs this directory's own
 * scripts again on a reinstall. So the directory and everything in it that is
 * code stays root-owned; the service user only gets the few things the runner
 * writes while it runs — its work and log directories and its registration
 * files. Anything an older install handed to the service user is thrown away
 * and downloaded afresh before root runs any of it.
 */
function githubInstallScript({ dir, url, token, name, labels, version, serviceUser }) {
  return `set -euo pipefail
umask 022
DIR=${q(dir)}
SVC_USER=${q(serviceUser || 'root')}
if [ "$SVC_USER" != "root" ] && ! id "$SVC_USER" >/dev/null 2>&1; then SVC_USER=root; fi

# What the runner itself writes while it runs; everything else is root's.
WRITABLE_DIRS="_work _diag"
STATE_FILES=".runner .credentials .credentials_rsaparams"
${unitPattern}

case "$(uname -m)" in
  x86_64)        ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  armv7l)        ARCH=arm ;;
  *) echo "Unsupported CPU architecture: $(uname -m)" >&2; exit 2 ;;
esac

VERSION=${q(version)}
mkdir -p "$DIR"
chown root:root "$DIR"
chmod 755 "$DIR"
cd "$DIR"

# A runner already configured here is stopped first so --replace can re-enrol it.
# This goes through systemd rather than the directory's own svc.sh.
OLD_UNIT="$(cat .service 2>/dev/null || true)"
if printf '%s' "$OLD_UNIT" | grep -Eq "$RUNNER_UNIT"; then
  systemctl stop "$OLD_UNIT" >/dev/null 2>&1 || true
fi

# Anything outside the work/log directories and registration files that root
# did not write could have been changed by a CI job, so none of it is trusted.
TAINTED="$(find "$DIR" -mindepth 1 \\( -path "$DIR/_work" -o -path "$DIR/_diag" \\) -prune -o \\
  ! -path "$DIR/.runner" ! -path "$DIR/.credentials" ! -path "$DIR/.credentials_rsaparams" \\
  ! -user root -print -quit 2>/dev/null || true)"
if [ -n "$TAINTED" ]; then
  echo "Files in $DIR are not owned by root (e.g. $TAINTED) — downloading the runner again."
  find "$DIR" -mindepth 1 -maxdepth 1 ! -name _work ! -name _diag -exec rm -rf {} +
fi

# The old registration is replaced below; removing it first also means root
# never writes through a link the service user left in its place.
for f in $STATE_FILES; do rm -f "$DIR/$f"; done

if [ ! -x ./config.sh ]; then
  echo "Downloading actions-runner $VERSION for linux-$ARCH…"
  curl -fsSL --retry 3 -o runner.tar.gz \\
    "https://github.com/actions/runner/releases/download/v$VERSION/actions-runner-linux-$ARCH-$VERSION.tar.gz"
  # The archive's own owners and modes are not kept: the files must be root's.
  tar xzf runner.tar.gz --no-same-owner --no-same-permissions
  rm -f runner.tar.gz
  find "$DIR" -mindepth 1 \\( -path "$DIR/_work" -o -path "$DIR/_diag" \\) -prune -o -exec chown -h root:root {} +
fi

# Best effort: the runner needs libicu and friends to start.
if [ -x ./bin/installdependencies.sh ]; then
  DEBIAN_FRONTEND=noninteractive ./bin/installdependencies.sh >/dev/null 2>&1 || \\
    echo "warning: installdependencies.sh failed — the runner may still start" >&2
fi

# The runner cannot update itself in a directory it may not write to, so it is
# told not to try; reinstall it from the panel to move to a newer version.
EXTRA=()
if [ "$SVC_USER" != "root" ]; then EXTRA+=(--disableupdate); fi

export RUNNER_ALLOW_RUNASROOT=1
./config.sh --unattended --replace \\
  --url ${q(url)} \\
  --token ${q(token)} \\
  --name ${q(name)} \\
  ${labels ? `--labels ${q(labels)} \\\n  ` : ''}--work _work \${EXTRA[@]+"\${EXTRA[@]}"}

if [ "$SVC_USER" != "root" ]; then
  # Only what the runner writes is handed over — never the directory itself.
  for d in $WRITABLE_DIRS; do
    mkdir -p "$DIR/$d"
    chown -h "$SVC_USER" "$DIR/$d"
  done
  for f in $STATE_FILES; do
    if [ -f "$DIR/$f" ] && [ ! -L "$DIR/$f" ]; then chown -h "$SVC_USER" "$DIR/$f"; fi
  done
  ./svc.sh install "$SVC_USER"
  # svc.sh hands its .service note to the service user; root reads it later.
  chown -h root:root "$DIR/.service" 2>/dev/null || true
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

/**
 * Nothing in the runner directory is run as root here: the service is taken
 * down through systemd, and the runner's own "remove" (which tells GitHub it
 * is gone) runs as the service user it already belonged to.
 */
function githubRemoveScript({ dir, token, serviceUser }) {
  return `set -uo pipefail
DIR=${q(dir)}
SVC_USER=${q(serviceUser || 'root')}
${unitPattern}
[ -d "$DIR" ] || { echo "Nothing installed at $DIR"; exit 0; }
cd "$DIR"

UNIT="$(cat "$DIR/.service" 2>/dev/null || true)"
# Only ever a runner's own unit, whatever the .service note says.
if printf '%s' "$UNIT" | grep -Eq "$RUNNER_UNIT"; then
  systemctl disable --now "$UNIT" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/$UNIT"
  systemctl daemon-reload >/dev/null 2>&1 || true
else
  UNIT=""
fi

if [ -x ./config.sh ]; then
  if [ "$SVC_USER" != "root" ] && id "$SVC_USER" >/dev/null 2>&1; then
    AS=(runuser -u "$SVC_USER" --)
  else
    # A runner that already ran as root: nobody else could have written its files.
    export RUNNER_ALLOW_RUNASROOT=1
    AS=()
  fi
  ${token ? `\${AS[@]+"\${AS[@]}"} ./config.sh remove --token ${q(token)} >/dev/null 2>&1 || \${AS[@]+"\${AS[@]}"} ./config.sh remove --local >/dev/null 2>&1 || true`
    : '${AS[@]+"${AS[@]}"} ./config.sh remove --local >/dev/null 2>&1 || true'}
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
