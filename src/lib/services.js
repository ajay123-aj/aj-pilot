/**
 * systemd services on a managed server.
 *
 * The system profile only ever captured a snapshot of the units that happened
 * to be running. This module talks to systemd live instead: list everything,
 * start/stop/enable one unit, read its journal, and write a brand new unit
 * file for something you want the server to keep running.
 */

import { exec, rootExec, assertOk } from './ssh.js';
import { splitSections } from './systemInfo.js';

const ACTIONS = new Set(['start', 'stop', 'restart', 'reload', 'enable', 'disable', 'mask', 'unmask']);

/** Unit names end up in a command line, so they are checked, not escaped. */
export function validateUnit(name) {
  const unit = String(name || '').trim();
  if (!unit) return { error: 'A service name is required' };
  if (!/^[A-Za-z0-9][A-Za-z0-9@._\\:-]{0,190}$/.test(unit)) {
    return { error: 'A service name may only use letters, numbers, and @ . _ - : characters' };
  }
  return { unit: unit.endsWith('.service') ? unit : `${unit}.service` };
}

const lines = (t) => String(t || '').split('\n').map((l) => l.trim()).filter(Boolean);

/* --------------------------------------------------------------- list */

/**
 * Every service unit on the host — running, stopped, failed and the ones that
 * are only installed. Reading this needs no privileges.
 */
export async function listServices(conn) {
  const script = `export LC_ALL=C
echo '@@@units'
systemctl list-units --type=service --all --no-pager --no-legend 2>/dev/null
echo '@@@files'
systemctl list-unit-files --type=service --no-pager --no-legend 2>/dev/null
echo '@@@managed'
ls -1 /etc/systemd/system/*.service 2>/dev/null | xargs -n1 basename 2>/dev/null
echo '@@@done'
echo ok`;

  const result = await exec(conn, 'bash -s', { stdin: script, timeout: 30000 });
  const sections = splitSections(result.stdout);
  if (!sections.done) {
    throw new Error(`Could not list services: ${(result.stderr || result.stdout || '').trim().slice(0, 300)}`);
  }

  const byUnit = new Map();

  for (const line of lines(sections.units)) {
    const p = line.replace(/^●\s*/, '').split(/\s+/);
    if (!p[0] || !p[0].endsWith('.service')) continue;
    byUnit.set(p[0], {
      unit: p[0],
      load: p[1] || null,
      active: p[2] || null,
      sub: p[3] || null,
      description: p.slice(4).join(' ') || null,
      enabled: null,
      managed: false,
    });
  }

  // Unit files cover everything installed, including units that never ran.
  for (const line of lines(sections.files)) {
    const [unit, state] = line.split(/\s+/);
    if (!unit || !unit.endsWith('.service')) continue;
    const existing = byUnit.get(unit);
    if (existing) existing.enabled = state || null;
    else byUnit.set(unit, { unit, load: 'loaded', active: 'inactive', sub: 'dead', description: null, enabled: state || null, managed: false });
  }

  const local = new Set(lines(sections.managed));
  for (const svc of byUnit.values()) svc.managed = local.has(svc.unit);

  const services = [...byUnit.values()].sort((a, b) => a.unit.localeCompare(b.unit));

  return {
    services,
    totals: {
      total: services.length,
      running: services.filter((s) => s.sub === 'running').length,
      failed: services.filter((s) => s.active === 'failed').length,
      enabled: services.filter((s) => s.enabled === 'enabled').length,
      local: services.filter((s) => s.managed).length,
    },
    collectedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------- detail */

/** One unit in full: its properties, its status block and its recent journal. */
export async function describeService(conn, server, unitName) {
  const { unit, error } = validateUnit(unitName);
  if (error) throw new Error(error);

  const props = [
    'Id', 'Description', 'LoadState', 'ActiveState', 'SubState', 'UnitFileState', 'FragmentPath',
    'MainPID', 'ExecMainStartTimestamp', 'MemoryCurrent', 'TasksCurrent', 'Restart', 'RestartUSec',
    'User', 'Group', 'WorkingDirectory', 'Type', 'NRestarts',
  ].join(',');

  const script = `export LC_ALL=C
echo '@@@props'
systemctl show '${unit}' --no-pager --property=${props} 2>/dev/null
echo '@@@exec'
systemctl show '${unit}' --no-pager --property=ExecStart --value 2>/dev/null | head -n 3
echo '@@@file'
if [ -f "/etc/systemd/system/${unit}" ]; then cat "/etc/systemd/system/${unit}"; fi
echo '@@@journal'
journalctl -u '${unit}' -n 200 --no-pager --output=short-iso 2>&1 | tail -n 200
echo '@@@done'
echo ok`;

  const result = await rootExec(conn, server, script, { timeout: 45000 });
  const s = splitSections(result.stdout);
  if (!s.done) assertOk(result, `Reading ${unit}`);

  const props2 = {};
  for (const line of lines(s.props)) {
    const i = line.indexOf('=');
    if (i > 0) props2[line.slice(0, i)] = line.slice(i + 1);
  }

  return {
    unit,
    description: props2.Description || null,
    load: props2.LoadState || null,
    active: props2.ActiveState || null,
    sub: props2.SubState || null,
    enabled: props2.UnitFileState || null,
    type: props2.Type || null,
    fragmentPath: props2.FragmentPath || null,
    mainPid: Number(props2.MainPID || 0) || null,
    startedAt: props2.ExecMainStartTimestamp || null,
    memoryBytes: /^\d+$/.test(props2.MemoryCurrent || '') ? Number(props2.MemoryCurrent) : null,
    tasks: Number(props2.TasksCurrent || 0) || null,
    restart: props2.Restart || null,
    restarts: Number(props2.NRestarts || 0) || 0,
    user: props2.User || null,
    group: props2.Group || null,
    workingDirectory: props2.WorkingDirectory || null,
    execStart: readableExecStart(s.exec),
    unitFile: (s.file || '').trim() || null,
    editable: Boolean((s.file || '').trim()),
    journal: lines(s.journal).slice(-200),
  };
}

/**
 * systemd reports ExecStart as a whole record:
 *   { path=/usr/sbin/cron ; argv[]=/usr/sbin/cron -f ; ignore_errors=no ; … }
 * Only the command line is worth showing.
 */
function readableExecStart(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const m = /argv\[\]=([^;]*)/.exec(text);
  return (m ? m[1] : text).trim() || null;
}

/* ------------------------------------------------------------ control */

/** start / stop / restart / reload / enable / disable / mask / unmask. */
export async function controlService(conn, server, unitName, action) {
  const { unit, error } = validateUnit(unitName);
  if (error) throw new Error(error);
  if (!ACTIONS.has(action)) throw new Error(`Unsupported action "${action}"`);

  const script = `export LC_ALL=C
rc=0
systemctl ${action} '${unit}' 2>&1 || rc=$?
echo '@@@state'
echo "active=$(systemctl is-active '${unit}' 2>/dev/null || true)"
echo "enabled=$(systemctl is-enabled '${unit}' 2>/dev/null || true)"
echo '@@@journal'
journalctl -u '${unit}' -n 25 --no-pager --output=short-iso 2>/dev/null | tail -n 25
exit $rc`;

  const result = await rootExec(conn, server, script, { timeout: 90000 });
  const s = splitSections(result.stdout);
  const state = {};
  for (const line of lines(s.state)) {
    const i = line.indexOf('=');
    if (i > 0) state[line.slice(0, i)] = line.slice(i + 1);
  }

  if (result.code !== 0) {
    const err = new Error(failureReason(`${action} ${unit}`, result, s.journal));
    err.cause = `${result.stdout.split('@@@')[0]}\n${result.stderr}\n${s.journal || ''}`.trim();
    throw err;
  }

  return { unit, action, active: state.active || null, enabled: state.enabled || null, journal: lines(s.journal) };
}

/* ------------------------------------------------------------- create */

/** Turn the add-service form into a systemd unit file. */
export function buildUnitFile(spec) {
  const unitLines = ['[Unit]'];
  unitLines.push(`Description=${spec.description || spec.unit}`);
  unitLines.push(`After=${spec.after || 'network.target'}`);
  if (spec.requires) unitLines.push(`Requires=${spec.requires}`);

  const service = ['', '[Service]'];
  service.push(`Type=${spec.type || 'simple'}`);
  if (spec.user) service.push(`User=${spec.user}`);
  if (spec.group) service.push(`Group=${spec.group}`);
  if (spec.workingDirectory) service.push(`WorkingDirectory=${spec.workingDirectory}`);
  for (const [key, value] of spec.environment || []) service.push(`Environment="${key}=${value}"`);
  if (spec.environmentFile) service.push(`EnvironmentFile=-${spec.environmentFile}`);
  service.push(`ExecStart=${spec.execStart}`);
  if (spec.execStop) service.push(`ExecStop=${spec.execStop}`);
  if (spec.execReload) service.push(`ExecReload=${spec.execReload}`);
  service.push(`Restart=${spec.restart || 'on-failure'}`);
  service.push(`RestartSec=${spec.restartSec || 5}`);
  service.push('StandardOutput=journal');
  service.push('StandardError=journal');
  service.push(`SyslogIdentifier=${spec.unit.replace(/\.service$/, '')}`);

  const install = ['', '[Install]', `WantedBy=${spec.wantedBy || 'multi-user.target'}`, ''];

  return [...unitLines, ...service, ...install].join('\n');
}

/** Everything the form must get right before the server is touched at all. */
export function validateServiceSpec(body) {
  const { unit, error } = validateUnit(body.unit || body.name);
  if (error) return { error };

  const execStart = String(body.execStart || '').trim();
  if (!execStart) return { error: 'The start command (ExecStart) is required' };
  if (!/^[-+!@]*\//.test(execStart)) {
    return { error: 'The start command must begin with an absolute path, for example /usr/bin/node /srv/app/index.js — "npm start" will not work' };
  }
  if (/\n/.test(execStart)) return { error: 'The start command must be a single line' };

  const type = String(body.type || 'simple');
  if (!['simple', 'exec', 'forking', 'oneshot', 'notify', 'idle'].includes(type)) {
    return { error: `Unsupported service type "${type}"` };
  }

  const restart = String(body.restart || 'on-failure');
  if (!['no', 'always', 'on-success', 'on-failure', 'on-abnormal', 'on-abort', 'on-watchdog'].includes(restart)) {
    return { error: `Unsupported restart policy "${restart}"` };
  }

  const environment = [];
  for (const line of String(body.environment || '').split('\n')) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;
    const i = text.indexOf('=');
    if (i <= 0) return { error: `Environment lines must look like KEY=value — "${text.slice(0, 40)}" does not` };
    const key = text.slice(0, i).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return { error: `"${key}" is not a valid environment variable name` };
    environment.push([key, text.slice(i + 1).trim().replace(/"/g, '\\"')]);
  }

  for (const [field, value] of [['workingDirectory', body.workingDirectory], ['environmentFile', body.environmentFile]]) {
    const v = String(value || '').trim();
    if (v && !v.startsWith('/')) return { error: `${field === 'workingDirectory' ? 'The working directory' : 'The environment file'} must be an absolute path` };
  }

  for (const [field, value] of [['user', body.user], ['group', body.group]]) {
    const v = String(value || '').trim();
    if (v && !/^[A-Za-z0-9._-]{1,64}$/.test(v)) return { error: `"${v}" is not a valid ${field} name` };
  }

  return {
    spec: {
      unit,
      description: String(body.description || '').trim().replace(/\n/g, ' '),
      execStart,
      execStop: String(body.execStop || '').trim(),
      execReload: String(body.execReload || '').trim(),
      workingDirectory: String(body.workingDirectory || '').trim(),
      environmentFile: String(body.environmentFile || '').trim(),
      environment,
      user: String(body.user || '').trim(),
      group: String(body.group || '').trim(),
      type,
      restart,
      restartSec: Number(body.restartSec) > 0 ? Math.min(3600, Math.round(Number(body.restartSec))) : 5,
      after: String(body.after || '').trim() || 'network.target',
      wantedBy: String(body.wantedBy || '').trim() || 'multi-user.target',
      enable: body.enable !== false && body.enable !== 'false',
      start: body.start !== false && body.start !== 'false',
      overwrite: body.overwrite === true || body.overwrite === 'true',
    },
  };
}

/**
 * Write the unit, reload systemd, then optionally enable it for boot and
 * start it now. A unit that fails to start still leaves its journal behind,
 * which is attached to the error so the UI can show why.
 */
export async function createService(conn, server, spec) {
  const unitFile = buildUnitFile(spec);
  const path = `/etc/systemd/system/${spec.unit}`;

  const script = `set -uo pipefail
export LC_ALL=C
PATH_UNIT='${path}'

if [ -e "$PATH_UNIT" ] && [ '${spec.overwrite ? 'yes' : 'no'}' != 'yes' ]; then
  echo "EXISTS" >&2
  exit 17
fi

cat > "$PATH_UNIT" <<'AUTODEPLOY_UNIT_EOF'
${unitFile}
AUTODEPLOY_UNIT_EOF
chmod 644 "$PATH_UNIT"

systemctl daemon-reload
rc=0
${spec.enable ? `systemctl enable '${spec.unit}' 2>&1 || rc=$?` : ''}
${spec.start ? `systemctl restart '${spec.unit}' 2>&1 || rc=$?` : ''}
sleep 1

echo '@@@state'
echo "active=$(systemctl is-active '${spec.unit}' 2>/dev/null || true)"
echo "enabled=$(systemctl is-enabled '${spec.unit}' 2>/dev/null || true)"
echo '@@@journal'
journalctl -u '${spec.unit}' -n 40 --no-pager --output=short-iso 2>/dev/null | tail -n 40

# A one-shot unit that has already finished is not a failure.
if [ "$(systemctl is-active '${spec.unit}' 2>/dev/null)" = "active" ]; then rc=0; fi
exit $rc`;

  const result = await rootExec(conn, server, script, { timeout: 120000 });
  const s = splitSections(result.stdout);
  const state = {};
  for (const line of lines(s.state)) {
    const i = line.indexOf('=');
    if (i > 0) state[line.slice(0, i)] = line.slice(i + 1);
  }

  if (result.code === 17 || /EXISTS/.test(result.stderr)) {
    throw new Error(`${spec.unit} already exists on this server. Pick another name, or tick "replace it if it already exists".`);
  }
  if (result.code !== 0) {
    const err = new Error(failureReason(`Starting ${spec.unit}`, result, s.journal));
    err.cause = `${result.stderr}\n${s.journal || ''}`.trim();
    throw err;
  }

  return {
    unit: spec.unit,
    path,
    unitFile,
    active: state.active || null,
    enabled: state.enabled || null,
    journal: lines(s.journal),
  };
}

/** Stop, disable and delete a unit the panel put on this server. */
export async function deleteService(conn, server, unitName) {
  const { unit, error } = validateUnit(unitName);
  if (error) throw new Error(error);

  const script = `set -uo pipefail
export LC_ALL=C
PATH_UNIT="/etc/systemd/system/${unit}"
if [ ! -f "$PATH_UNIT" ]; then
  echo "NOT_LOCAL" >&2
  exit 18
fi
systemctl stop '${unit}'    >/dev/null 2>&1 || true
systemctl disable '${unit}' >/dev/null 2>&1 || true
rm -f "$PATH_UNIT"
systemctl daemon-reload
systemctl reset-failed '${unit}' >/dev/null 2>&1 || true
echo "removed $PATH_UNIT"`;

  const result = await rootExec(conn, server, script, { timeout: 90000 });
  if (result.code === 18 || /NOT_LOCAL/.test(result.stderr)) {
    throw new Error(`${unit} is not a unit this panel can delete — only units in /etc/systemd/system are removable.`);
  }
  assertOk(result, `Deleting ${unit}`);
  return { unit, removed: true, log: result.stdout.trim() };
}

function failureReason(what, result, journal) {
  const text = `${result.stdout}\n${result.stderr}\n${journal || ''}`;
  if (/sudo:.*(password is required|no tty|incorrect password)/i.test(text)) {
    return `${what} needs root on this server, but sudo asked for a password the panel does not have. `
      + 'Connect as root, give the SSH user passwordless sudo, or store its sudo password on the server.';
  }
  if (/Unit .* not found|not-found/i.test(text)) return `${what} failed — systemd does not know that unit.`;
  if (/Failed to (start|restart)/i.test(text)) {
    const line = lines(journal).slice(-3).join(' · ');
    return `${what} failed${line ? `: ${line.slice(0, 300)}` : '.'}`;
  }
  const tail = lines(`${result.stderr}\n${result.stdout.split('@@@')[0]}`).slice(-3).join(' · ');
  return `${what} failed${tail ? `: ${tail.slice(0, 300)}` : ` (exit code ${result.code})`}`;
}
