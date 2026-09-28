/**
 * Ubuntu users on a managed server: who can log in, how, and with what rights.
 *
 * Everything runs as root through rootExec, so the first question on every
 * call is whether the panel's SSH login actually has root. If it does not,
 * nothing is read or written and the caller is told plainly.
 *
 * What the panel changes, and what it leaves alone:
 *   people (uid ≥ 1000)   — add, edit, lock, delete, password, SSH keys, sudo.
 *   root                  — password and SSH keys only; never deleted or locked.
 *   system accounts       — shown, never touched: packages own them.
 *   the panel's own login — never deleted, locked or taken out of sudo, so the
 *                           panel cannot cut itself off from the server.
 */

import { rootExec } from './ssh.js';
import { splitSections } from './systemInfo.js';

const q = (v) => `'${String(v ?? '').replace(/'/g, `'\\''`)}'`;
const b64 = (text) => Buffer.from(String(text), 'utf8').toString('base64');
const lines = (t) => String(t || '').split('\n').map((l) => l.trim()).filter(Boolean);

export const NOT_PERMITTED = 'You are not permitted to manage users on this server';
const RESERVED = new Set(['root', 'daemon', 'bin', 'sys', 'sync', 'games', 'man', 'lp', 'mail', 'news', 'uucp', 'proxy',
  'www-data', 'backup', 'list', 'irc', 'gnats', 'nobody', 'systemd-network', 'systemd-resolve', 'messagebus', 'sshd',
  'syslog', 'ubuntu', 'admin', 'sudo', 'docker', 'mysql', 'postgres', 'redis', 'nginx']);

/* ---------------------------------------------------------- validation */

export function validateUsername(name, { creating = false } = {}) {
  const clean = String(name || '').trim();
  if (!clean) return { error: 'A username is required' };
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(clean)) {
    return { error: 'A username is lowercase letters, digits, "-" and "_", starts with a letter or "_", and is at most 32 characters' };
  }
  if (creating && RESERVED.has(clean)) return { error: `"${clean}" is reserved on Ubuntu — choose another name` };
  return { value: clean };
}

export function validatePassword(pw, { required = false } = {}) {
  const v = String(pw ?? '');
  if (!v) return required ? { error: 'A password is required' } : { value: '' };
  if (v.length < 8) return { error: 'The password must be at least 8 characters' };
  if (v.length > 128) return { error: 'The password is too long (128 characters at most)' };
  if (/[\r\n:]/.test(v)) return { error: 'The password cannot contain a line break or ":"' };
  return { value: v };
}

export function validateShell(shell) {
  const v = String(shell || '/bin/bash').trim();
  if (!/^\/[A-Za-z0-9_./-]{1,80}$/.test(v)) return { error: `"${v.slice(0, 40)}" is not a shell path` };
  return { value: v };
}

export function validateFullName(name) {
  const v = String(name ?? '').trim();
  if (v.length > 80) return { error: 'The full name is too long (80 characters at most)' };
  if (/[:,\r\n]/.test(v)) return { error: 'The full name cannot contain ":", "," or a line break' };
  return { value: v };
}

export function validateGroups(groups) {
  const list = (Array.isArray(groups) ? groups : String(groups || '').split(','))
    .map((g) => String(g).trim()).filter(Boolean);
  for (const g of list) {
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(g)) return { error: `"${g.slice(0, 32)}" is not a group name` };
  }
  // sudo is its own switch; it is not managed through the group list.
  return { value: [...new Set(list.filter((g) => g !== 'sudo'))] };
}

const KEY_RE = /^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) [A-Za-z0-9+/]+={0,3}( [^\r\n]{0,200})?$/;

export function validatePublicKeys(text) {
  const keys = lines(text).filter((l) => !l.startsWith('#'));
  for (const k of keys) {
    if (!KEY_RE.test(k)) return { error: `This is not an SSH public key: ${k.slice(0, 50)}…` };
  }
  return { value: keys };
}

export function validateKeyComment(c) {
  const v = String(c ?? '').trim();
  if (v && !/^[A-Za-z0-9@._ -]{1,80}$/.test(v)) return { error: 'The key label can use letters, digits, spaces and @ . _ -' };
  return { value: v };
}

/* ------------------------------------------------------------ running */

/** Run a script as root; a login that cannot become root is reported, not guessed around. */
async function asRoot(conn, row, script, what, { timeout = 60000 } = {}) {
  const result = await rootExec(conn, row, `set -euo pipefail\n[ "$(id -u)" = 0 ] || { echo "@@notroot" >&2; exit 97; }\n${script}`, { timeout });
  const output = `${result.stdout}\n${result.stderr}`.trim();
  // Newer sudo drops the "sudo:" prefix ("plain is not in the sudoers file."), so match the phrases alone.
  if (result.code === 97 || /(a password is required|no tty present|incorrect password attempt|not in the sudoers file|is not allowed to run sudo|may not run sudo|sudo: command not found)/i.test(result.stderr)) {
    const err = new Error(`${NOT_PERMITTED}. The SSH login "${row.username}" cannot become root — connect as root, give it sudo, or store its sudo password on the server.`);
    err.notPermitted = true;
    throw err;
  }
  if (result.code >= 10 && result.code < 90) {
    // Our own checks: the message is the last line the script wrote to stderr.
    throw new Error(lines(result.stderr).pop() || `${what} failed`);
  }
  if (result.code !== 0) {
    const err = new Error(`${what} failed${output ? `: ${lines(output).slice(-3).join(' · ').slice(0, 300)}` : ` (exit code ${result.code})`}`);
    err.cause = output;
    throw err;
  }
  return result;
}

/* ------------------------------------------------------------- reading */

const STATE_SCRIPT = `
echo '@@@me'
echo "login=\${SUDO_USER:-$(id -un)}"
echo '@@@passwd'
getent passwd
echo '@@@group'
getent group
echo '@@@status'
passwd -S -a 2>/dev/null || for u in $(getent passwd | cut -d: -f1); do passwd -S "$u" 2>/dev/null || true; done
echo '@@@expiry'
# Name and account-expiry day only — the password hashes never leave the server.
cut -d: -f1,8 /etc/shadow 2>/dev/null || true
echo "today=$(( $(date +%s) / 86400 ))"
echo '@@@shells'
grep -v '^#' /etc/shells 2>/dev/null | grep . || true
echo '@@@lastlog'
{ lastlog 2>/dev/null || lastlog2 2>/dev/null; } | tail -n +2 || true
echo '@@@nopasswd'
grep -lsE '^[^#]*NOPASSWD' /etc/sudoers.d/* 2>/dev/null | while read -r f; do grep -hE '^[^#]*NOPASSWD' "$f" | awk '{print $1}'; done || true
echo '@@@who'
who 2>/dev/null || true
echo '@@@keys'
getent passwd | while IFS=: read -r name _ uid _ _ home _; do
  if [ "$uid" -eq 0 ] || { [ "$uid" -ge 1000 ] && [ "$uid" -lt 60000 ]; }; then
    f="$home/.ssh/authorized_keys"
    [ -s "$f" ] || continue
    echo "===user:$name"
    { grep -vE '^\\s*(#|$)' "$f" || true; } | while IFS= read -r line || [ -n "$line" ]; do
      printf '%s\\n' "$line" | ssh-keygen -lf - 2>/dev/null || echo "? invalid-line"
    done
  fi
done || true
`;

const humanUid = (uid) => uid >= 1000 && uid < 60000;

/** Every account, its groups, whether it can log in, and its SSH keys. */
export async function usersState(conn, row) {
  const result = await asRoot(conn, row, STATE_SCRIPT, 'Reading the users');
  const s = splitSections(result.stdout);
  const login = (/login=(\S+)/.exec(s.me || '') || [])[1] || row.username;

  const groups = lines(s.group).map((l) => {
    const [name, , gid, members] = l.split(':');
    return { name, gid: Number(gid), members: (members || '').split(',').filter(Boolean) };
  });
  const status = new Map(lines(s.status).map((l) => { const p = l.split(/\s+/); return [p[0], p[1]]; }));
  const noPasswd = new Set(lines(s.nopasswd));
  const today = Number((/today=(\d+)/.exec(s.expiry || '') || [])[1] || Math.floor(Date.now() / 86400000));
  const expired = new Set(lines(s.expiry).filter((l) => !l.startsWith('today=')).map((l) => l.split(':'))
    .filter(([, day]) => day !== '' && day !== undefined && Number(day) <= today).map(([name]) => name));
  const sessions = lines(s.who).reduce((m, l) => { const u = l.split(/\s+/)[0]; m.set(u, (m.get(u) || 0) + 1); return m; }, new Map());

  const lastLogin = new Map();
  for (const l of lines(s.lastlog)) {
    const name = l.split(/\s+/)[0];
    if (/\*\*\s*never/i.test(l) || /never logged in/i.test(l)) lastLogin.set(name, null);
    else {
      const m = /([A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d+ [\d:]+ [+-]\d{4} \d{4})\s*$/.exec(l);
      lastLogin.set(name, m ? m[1] : null);
    }
  }

  const keys = new Map();
  let who = null;
  for (const l of lines(s.keys)) {
    if (l.startsWith('===user:')) { who = l.slice(8); keys.set(who, []); continue; }
    if (!who) continue;
    const m = /^(\d+) (\S+) (.*) \((\w+)\)$/.exec(l);
    keys.get(who).push(m ? { bits: Number(m[1]), fingerprint: m[2], comment: m[3] === 'no comment' ? '' : m[3], type: m[4] } : { invalid: true });
  }

  const primaryGroup = new Map(groups.map((g) => [g.gid, g.name]));
  const users = lines(s.passwd).map((l) => {
    const [name, , uid, gid, gecos, home, shell] = l.split(':');
    const u = Number(uid);
    const st = status.get(name) || '';
    const supplementary = groups.filter((g) => g.members.includes(name)).map((g) => g.name);
    const kind = u === 0 ? 'root' : humanUid(u) ? 'user' : 'system';
    return {
      name, uid: u, gid: Number(gid), group: primaryGroup.get(Number(gid)) || String(gid),
      fullName: (gecos || '').split(',')[0], home, shell, kind,
      groups: supplementary,
      sudo: u === 0 || supplementary.includes('sudo') || supplementary.includes('admin'),
      noPasswordSudo: noPasswd.has(name),
      password: st === 'P' ? 'set' : st === 'L' ? 'locked' : st === 'NP' ? 'empty' : 'unknown',
      canLogin: !/(nologin|false)$/.test(shell || ''),
      locked: expired.has(name),
      keys: keys.get(name) || [],
      sessions: sessions.get(name) || 0,
      lastLogin: lastLogin.has(name) ? lastLogin.get(name) : undefined,
      isLogin: name === login,
    };
  });

  return {
    permitted: true,
    login,
    users,
    groups: groups.map((g) => ({ name: g.name, gid: g.gid, members: g.members.length, system: g.gid < 1000 })),
    shells: [...new Set(['/bin/bash', ...lines(s.shells), '/usr/sbin/nologin'])],
  };
}

/* ------------------------------------------------------------- writing */

/** Shell that puts keys in a user's authorized_keys with the modes sshd insists on. */
const keysSnippet = (keysB64) => `
H="$(getent passwd "$U" | cut -d: -f6)"
G="$(id -gn "$U")"
mkdir -p "$H/.ssh"
touch "$H/.ssh/authorized_keys"
echo ${keysB64} | base64 -d | while IFS= read -r k || [ -n "$k" ]; do
  [ -n "$k" ] || continue
  grep -Fxq -- "$k" "$H/.ssh/authorized_keys" || printf '%s\\n' "$k" >> "$H/.ssh/authorized_keys"
done
chmod 700 "$H/.ssh"; chmod 600 "$H/.ssh/authorized_keys"
chown -R "$U:$G" "$H/.ssh"
`;

/** A fresh ed25519 pair made on the server: the public half is installed, the private half handed back once and deleted. */
const generateSnippet = (comment) => `
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
ssh-keygen -q -t ed25519 -N '' -C ${q(comment)} -f "$T/key" >/dev/null || { echo "ssh-keygen could not make a key" >&2; exit 30; }
PUB="$(cat "$T/key.pub")"
${keysSnippet('"$(printf \'%s\\n\' "$PUB" | base64 -w0)"')}
echo '@@@private'
cat "$T/key"
echo '@@@public'
cat "$T/key.pub"
echo '@@@end'
`;

const sudoSnippet = (sudo, noPasswd) => `
${sudo ? 'usermod -aG sudo "$U"' : 'gpasswd -d "$U" sudo >/dev/null 2>&1 || true'}
F="/etc/sudoers.d/90-ajpilot-$U"
${sudo && noPasswd ? `printf '%s ALL=(ALL) NOPASSWD:ALL\\n' "$U" > "$F.tmp"
chmod 440 "$F.tmp"
visudo -cf "$F.tmp" >/dev/null || { rm -f "$F.tmp"; echo "sudo refused the passwordless rule" >&2; exit 40; }
mv "$F.tmp" "$F"` : 'rm -f "$F"'}
`;

const groupsExistSnippet = (groups) => (groups.length ? `
for g in ${groups.map(q).join(' ')}; do
  getent group "$g" >/dev/null || { echo "There is no group called \\"$g\\" on this server" >&2; exit 12; }
done` : '');

function generated(stdout) {
  const s = splitSections(stdout);
  return s.private ? { privateKey: `${s.private.trim()}\n`, publicKey: (s.public || '').trim() } : null;
}

export async function createUser(conn, row, spec) {
  const script = `
U=${q(spec.username)}
id "$U" >/dev/null 2>&1 && { echo "A user called \\"$U\\" already exists on this server" >&2; exit 10; }
${groupsExistSnippet(spec.groups)}
REUSED=0
[ -d "/home/$U" ] && REUSED=1
useradd -m -s ${q(spec.shell)} -c ${q(spec.fullName)} ${spec.groups.length ? `-G ${q(spec.groups.join(','))}` : ''} "$U" 2>/dev/null || { echo "useradd could not create the user" >&2; exit 11; }
if [ $REUSED = 1 ]; then
  # A home folder left behind by an earlier user of this name: its keys must not let that person in as the new one.
  H="$(getent passwd "$U" | cut -d: -f6)"
  [ -f "$H/.ssh/authorized_keys" ] && mv "$H/.ssh/authorized_keys" "$H/.ssh/authorized_keys.disabled-$(date +%Y%m%d%H%M%S)"
  chown -R "$U:$(id -gn "$U")" "$H"
  echo '@@@reused'
  echo "$H"
fi
${spec.password ? `echo ${b64(`${spec.username}:${spec.password}`)} | base64 -d | chpasswd || { echo "The password was refused" >&2; exit 13; }` : ''}
${sudoSnippet(spec.sudo, spec.noPasswordSudo)}
${spec.keys.length ? keysSnippet(b64(spec.keys.join('\n'))) : ''}
${spec.generateKey ? generateSnippet(spec.keyComment || `${spec.username}@${row.name}`) : ''}
`;
  const result = await asRoot(conn, row, script, 'Creating the user');
  const reused = (splitSections(result.stdout).reused || '').split('\n')[0] || null;
  return { key: generated(result.stdout), reusedHome: reused };
}

/** Change what was sent; anything left out stays as it is. */
export async function updateUser(conn, row, name, spec) {
  const parts = [];
  if (spec.fullName !== undefined) parts.push(`usermod -c ${q(spec.fullName)} "$U"`);
  if (spec.shell !== undefined) parts.push(`usermod -s ${q(spec.shell)} "$U"`);
  if (spec.groups !== undefined) {
    parts.push(groupsExistSnippet(spec.groups));
    // -G replaces the list, so sudo is carried over and then set by its own switch below.
    parts.push(`KEEP="$(id -nG "$U" | tr ' ' '\\n' | grep -x sudo || true)"
usermod -G "$(printf '%s\\n' ${spec.groups.map(q).join(' ')} $KEEP | grep . | paste -sd, -)" "$U"`);
  }
  if (spec.password) parts.push(`echo ${b64(`${name}:${spec.password}`)} | base64 -d | chpasswd || { echo "The password was refused" >&2; exit 13; }`);
  if (spec.sudo !== undefined) parts.push(sudoSnippet(spec.sudo, spec.noPasswordSudo));
  if (spec.locked === true) parts.push('usermod -L "$U" && usermod -e 1 "$U"');
  if (spec.locked === false) parts.push('usermod -U "$U" 2>/dev/null || true; usermod -e "" "$U"');
  if (spec.keys?.length) parts.push(keysSnippet(b64(spec.keys.join('\n'))));
  if (spec.generateKey) parts.push(generateSnippet(spec.keyComment || `${name}@${row.name}`));
  if (!parts.length) return { key: null };

  const result = await asRoot(conn, row, `
U=${q(name)}
id "$U" >/dev/null 2>&1 || { echo "There is no user called \\"$U\\" on this server" >&2; exit 14; }
${parts.join('\n')}
`, 'Changing the user');
  return { key: generated(result.stdout) };
}

/** Take one key out of authorized_keys, found by its fingerprint. */
export async function removeKey(conn, row, name, fingerprint) {
  await asRoot(conn, row, `
U=${q(name)}
FP=${q(fingerprint)}
H="$(getent passwd "$U" | cut -d: -f6)"
F="$H/.ssh/authorized_keys"
[ -f "$F" ] || { echo "That user has no SSH keys" >&2; exit 20; }
T="$(mktemp)"
FOUND=0
while IFS= read -r line || [ -n "$line" ]; do
  fp="$(printf '%s\\n' "$line" | ssh-keygen -lf - 2>/dev/null | awk '{print $2}' || true)"
  if [ -n "$fp" ] && [ "$fp" = "$FP" ] && [ $FOUND = 0 ]; then FOUND=1; continue; fi
  printf '%s\\n' "$line"
done < "$F" > "$T"
[ $FOUND = 1 ] || { rm -f "$T"; echo "That key is no longer there — refresh the page" >&2; exit 21; }
cat "$T" > "$F"; rm -f "$T"
`, 'Removing the key');
}

export async function deleteUser(conn, row, name, { removeHome = false } = {}) {
  await asRoot(conn, row, `
U=${q(name)}
id "$U" >/dev/null 2>&1 || { echo "There is no user called \\"$U\\" on this server" >&2; exit 14; }
# A user with running processes cannot be removed; end their sessions first.
pkill -KILL -u "$U" 2>/dev/null || true
sleep 1
rm -f "/etc/sudoers.d/90-ajpilot-$U"
userdel ${removeHome ? '-r' : ''} "$U" 2>&1 | grep -v 'mail spool' >&2 || true
id "$U" >/dev/null 2>&1 && { echo "userdel could not remove \\"$U\\"" >&2; exit 15; }
exit 0
`, 'Deleting the user');
}
