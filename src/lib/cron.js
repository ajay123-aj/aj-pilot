/**
 * Scheduled jobs on a managed server.
 *
 * Cron keeps its jobs in several places and they are not equally safe to touch:
 *
 *   a user's crontab   — what `crontab -e` edits. The panel adds, changes and
 *                        removes jobs here, because `crontab` itself validates
 *                        the file and replaces it atomically.
 *   /etc/crontab       — the system table, with a user column.
 *   /etc/cron.d/*      — dropped in by packages.
 *   /etc/cron.daily/*  — run-parts directories, which are scripts, not jobs.
 *
 * Everything is read; only user crontabs are written. The rest belongs to the
 * distribution or to whatever package put it there, and quietly rewriting those
 * from a web panel is how a server stops doing what its owner expects.
 */

import { rootExec } from './ssh.js';
import { splitSections } from './systemInfo.js';

const q = (v) => `'${String(v ?? '').replace(/'/g, `'\\''`)}'`;
const b64 = (text) => Buffer.from(String(text), 'utf8').toString('base64');
const lines = (t) => String(t || '').split('\n').map((l) => l.trim()).filter(Boolean);

/** Users whose crontabs the panel will write. */
export const validateUser = (name) => {
  const clean = String(name || 'root').trim();
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(clean)) return { error: `"${clean.slice(0, 32)}" is not a username` };
  return { value: clean };
};

const NICKNAMES = ['@reboot', '@yearly', '@annually', '@monthly', '@weekly', '@daily', '@midnight', '@hourly'];

/**
 * A cron schedule: five fields, or one of cron's own nicknames.
 * The fields themselves are left to cron to judge — `crontab` refuses a file it
 * cannot parse, and that refusal is reported rather than guessed at here.
 */
export function validateSchedule(schedule) {
  const clean = String(schedule || '').trim().replace(/\s+/g, ' ');
  if (!clean) return { error: 'A schedule is required — five fields, or something like @daily' };

  if (clean.startsWith('@')) {
    if (!NICKNAMES.includes(clean.toLowerCase())) {
      return { error: `"${clean}" is not one of cron's names: ${NICKNAMES.join(', ')}` };
    }
    return { value: clean.toLowerCase() };
  }

  const fields = clean.split(' ');
  if (fields.length !== 5) {
    return { error: `A schedule has five fields — minute, hour, day of month, month, day of week — but this has ${fields.length}` };
  }
  for (const f of fields) {
    if (!/^[0-9*/,\-A-Za-z]+$/.test(f)) return { error: `"${f.slice(0, 20)}" is not something cron understands` };
  }
  return { value: clean };
}

/** The command half of a job. */
export function validateCommand(command) {
  const clean = String(command || '').trim();
  if (!clean) return { error: 'A command is required — it is what the job runs' };
  if (clean.length > 900) return { error: 'That command is too long for one crontab line' };
  if (/[\n\r\0]/.test(clean)) return { error: 'A cron job is one line — it cannot contain a line break' };
  // cron reads an unescaped % as "end of command, the rest is stdin".
  if (/(^|[^\\])%/.test(clean)) {
    return { error: 'An unescaped % means something else to cron — write it as \\% if the command needs one' };
  }
  return { value: clean };
}

/** One crontab line as a job, or null for a blank line or a comment. */
function parseLine(raw, { withUser = false } = {}) {
  const text = String(raw || '');
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  // MAILTO=, PATH= and friends are settings, not jobs.
  if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(trimmed)) return { setting: trimmed, raw: text };

  let schedule;
  let rest;
  if (trimmed.startsWith('@')) {
    const m = /^(@\w+)\s+(.*)$/.exec(trimmed);
    if (!m) return null;
    [, schedule, rest] = m;
  } else {
    const m = /^((?:\S+\s+){5})(.*)$/.exec(trimmed);
    if (!m) return null;
    schedule = m[1].trim().replace(/\s+/g, ' ');
    rest = m[2];
  }

  let user = null;
  let command = rest;
  if (withUser) {
    const m = /^(\S+)\s+(.*)$/.exec(rest);
    if (!m) return null;
    [, user, command] = m;
  }

  return { schedule, user, command: command.trim(), raw: text };
}

/* ------------------------------------------------------------- reading */

/** Everything scheduled on this server, wherever it lives. */
export async function cronState(conn, server) {
  const script = `export LC_ALL=C
echo '@@@cron'
if command -v crontab >/dev/null 2>&1; then
  echo "installed=yes"
  echo "crontab=$(command -v crontab)"
else
  echo "installed=no"
fi
for unit in cron crond; do
  state="$(systemctl is-active $unit 2>/dev/null || true)"
  if [ -n "$state" ] && [ "$state" != "unknown" ]; then
    echo "unit=$unit"
    echo "active=$state"
    echo "enabled=$(systemctl is-enabled $unit 2>/dev/null || echo unknown)"
    break
  fi
done
echo "users=$(ls -1 /var/spool/cron/crontabs 2>/dev/null | tr '\\n' ' ')$(ls -1 /var/spool/cron 2>/dev/null | tr '\\n' ' ')"
echo '@@@usercrontabs'
# Every user who has a crontab, and the crontab itself, framed by its name.
for u in $(ls -1 /var/spool/cron/crontabs 2>/dev/null; ls -1 /var/spool/cron 2>/dev/null); do
  id "$u" >/dev/null 2>&1 || continue
  echo "===user:$u"
  crontab -l -u "$u" 2>/dev/null
done
echo '@@@systemtab'
[ -f /etc/crontab ] && cat /etc/crontab
echo '@@@crond'
for f in /etc/cron.d/*; do
  [ -f "$f" ] || continue
  echo "===file:$f"
  cat "$f"
done
echo '@@@runparts'
for d in /etc/cron.hourly /etc/cron.daily /etc/cron.weekly /etc/cron.monthly; do
  [ -d "$d" ] || continue
  for f in "$d"/*; do
    [ -f "$f" ] || continue
    printf '%s\\t%s\\n' "$d" "$(basename "$f")"
  done
done
echo '@@@lastruns'
tail -n 40 /var/log/syslog 2>/dev/null | grep -i 'CRON' | tail -n 10
echo '@@@done'
echo ok`;

  const result = await rootExec(conn, server, script, { timeout: 60000 });
  const s = splitSections(result.stdout);
  if (!s.done) {
    throw new Error(`Could not read the scheduled jobs on this server: ${(result.stderr || '').trim().slice(0, 200)}`);
  }

  const kv = {};
  for (const line of lines(s.cron)) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
  }

  return {
    installed: kv.installed === 'yes',
    binary: kv.crontab || null,
    unit: kv.unit || null,
    active: kv.active || 'unknown',
    enabled: kv.enabled || 'unknown',
    running: kv.active === 'active',
    users: parseUserCrontabs(s.usercrontabs),
    system: parseBlock(s.systemtab, '/etc/crontab', { withUser: true }),
    dropins: parseFiles(s.crond),
    runParts: lines(s.runparts).map((line) => {
      const [directory, name] = line.split('\t');
      return { directory, name };
    }),
    recent: lines(s.lastruns).slice(-10),
  };
}

/** `===user:<name>` framed blocks into one entry per user. */
function parseUserCrontabs(text) {
  const out = [];
  let current = null;
  for (const raw of String(text || '').split('\n')) {
    const m = /^===user:(.+)$/.exec(raw.trim());
    if (m) {
      current = { user: m[1].trim(), jobs: [], settings: [], lineCount: 0 };
      out.push(current);
      continue;
    }
    if (!current) continue;
    current.lineCount += 1;
    const job = parseLine(raw);
    if (!job) continue;
    if (job.setting) current.settings.push(job.setting);
    else current.jobs.push({ ...job, user: current.user, source: 'crontab', editable: true });
  }
  return out.filter((u) => u.jobs.length || u.settings.length);
}

function parseBlock(text, source, options) {
  const jobs = [];
  const settings = [];
  for (const raw of String(text || '').split('\n')) {
    const job = parseLine(raw, options);
    if (!job) continue;
    if (job.setting) settings.push(job.setting);
    else jobs.push({ ...job, source, editable: false });
  }
  return { source, jobs, settings };
}

/** `===file:<path>` framed blocks, one per file in /etc/cron.d. */
function parseFiles(text) {
  const out = [];
  let current = null;
  for (const raw of String(text || '').split('\n')) {
    const m = /^===file:(.+)$/.exec(raw.trim());
    if (m) {
      current = { source: m[1].trim(), jobs: [], settings: [] };
      out.push(current);
      continue;
    }
    if (!current) continue;
    const job = parseLine(raw, { withUser: true });
    if (!job) continue;
    if (job.setting) current.settings.push(job.setting);
    else current.jobs.push({ ...job, source: current.source, editable: false });
  }
  return out.filter((f) => f.jobs.length);
}

/* ------------------------------------------------------------- writing */

/**
 * Add, change or remove one line of a user's crontab.
 *
 * The whole table is read, changed and handed back to `crontab`, which parses
 * it and refuses the lot if any line is wrong — so a bad edit leaves the
 * server exactly as it was. `oldLine` is matched exactly, so an edit made from
 * a stale screen fails loudly instead of overwriting somebody else's change.
 */
async function writeCrontab(conn, server, { user, oldLine = null, newLine = null }) {
  const script = `set -uo pipefail
command -v crontab >/dev/null 2>&1 || { echo "cron is not installed on this server" >&2; exit 3; }
id ${q(user)} >/dev/null 2>&1 || { echo "there is no user called ${user} on this server" >&2; exit 5; }

TMP="$(mktemp)"
NEXT="$(mktemp)"
trap 'rm -f "$TMP" "$NEXT"' EXIT
crontab -l -u ${q(user)} 2>/dev/null > "$TMP" || true

OLD="$(echo ${b64(oldLine || '')} | base64 -d)"
NEW="$(echo ${b64(newLine || '')} | base64 -d)"
# Through the environment, not -v: awk expands escape sequences in a -v value,
# which would turn the \% a command has to escape for cron back into a bare %.
export OLD NEW

${oldLine ? `grep -Fxq -- "$OLD" "$TMP" || { echo "that job is no longer in the crontab" >&2; exit 4; }
awk 'BEGIN { old = ENVIRON["OLD"]; new = ENVIRON["NEW"]; done = 0 }
  { if (!done && $0 == old) { done = 1; if (length(new)) print new } else print }' "$TMP" > "$NEXT"`
    : `cp "$TMP" "$NEXT"
printf '%s\\n' "$NEW" >> "$NEXT"`}

# crontab validates the whole table and replaces it in one go, so a rejected
# edit changes nothing at all.
crontab -u ${q(user)} "$NEXT" 2>&1 || exit 6

echo '@@@result'
crontab -l -u ${q(user)} 2>/dev/null | grep -c . || true`;

  const result = await rootExec(conn, server, script, { timeout: 60000 });
  const output = `${result.stdout.split('@@@')[0]}\n${result.stderr}`.trim();

  if (result.code === 3) throw new Error('cron is not installed on this server yet.');
  if (result.code === 4) throw new Error('That job is no longer in the crontab — reload the page and try again.');
  if (result.code === 5) throw new Error(`There is no user called "${user}" on this server.`);
  if (result.code === 6) {
    const detail = lines(output).slice(-3).join(' · ');
    const err = new Error(`cron refused the change, so nothing was altered${detail ? `: ${detail.slice(0, 250)}` : ''}`);
    err.cause = output;
    throw err;
  }
  if (result.code !== 0) {
    if (/sudo:.*(password is required|no tty)/i.test(output)) {
      throw new Error('Editing a crontab needs root on this server, but sudo asked for a password the panel does not have.');
    }
    const err = new Error(`The crontab could not be written${output ? `: ${lines(output).slice(-2).join(' · ').slice(0, 250)}` : ''}`);
    err.cause = output;
    throw err;
  }

  return { user, lines: Number((splitSections(result.stdout).result || '').trim()) || 0 };
}

/** Build the crontab line for a job. */
export const jobLine = ({ schedule, command, comment }) =>
  `${comment ? `# ${String(comment).replace(/[\r\n]+/g, ' ').slice(0, 120)}\n` : ''}${schedule} ${command}`;

export const addJob = (conn, server, { user, schedule, command }) =>
  writeCrontab(conn, server, { user, newLine: `${schedule} ${command}` });

export const updateJob = (conn, server, { user, oldLine, schedule, command }) =>
  writeCrontab(conn, server, { user, oldLine, newLine: `${schedule} ${command}` });

export const deleteJob = (conn, server, { user, oldLine }) =>
  writeCrontab(conn, server, { user, oldLine, newLine: null });

/* ---------------------------------------------------------- installing */

export async function installCron(conn, server) {
  const script = `set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
if command -v crontab >/dev/null 2>&1; then
  echo "cron is already installed."
else
  apt-get update -qq 2>&1 | tail -n 2
  apt-get install -y cron 2>&1 | tail -n 10
fi
systemctl enable --now cron 2>&1 | tail -n 3 || systemctl enable --now crond 2>&1 | tail -n 3 || true

echo '@@@state'
echo "installed=$(command -v crontab >/dev/null 2>&1 && echo yes || echo no)"
echo "active=$(systemctl is-active cron 2>/dev/null || systemctl is-active crond 2>/dev/null || echo unknown)"
command -v crontab >/dev/null 2>&1 || exit 9`;

  const result = await rootExec(conn, server, script, { timeout: 10 * 60 * 1000 });
  const log = `${result.stdout.split('@@@')[0]}\n${result.stderr}`.trim();
  if (result.code !== 0) {
    if (/Could not resolve|Temporary failure|Failed to fetch/i.test(log)) {
      throw new Error('Installing cron failed: this server has no outbound access to its package mirrors.');
    }
    const err = new Error(`Installing cron failed${log ? `: ${lines(log).slice(-2).join(' · ').slice(0, 250)}` : ''}`);
    err.cause = log;
    throw err;
  }
  return { log, active: /active=active/.test(result.stdout) };
}
