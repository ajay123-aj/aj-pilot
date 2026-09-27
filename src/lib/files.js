/**
 * The file manager behind a server's Storage tab.
 *
 * Everything runs as root (through rootExec), because the files worth looking
 * at — nginx sites, app folders, Docker volumes, logs — mostly belong to root.
 * That makes the guard rails matter: paths are normalised and quoted, and the
 * folders an operating system cannot live without can be browsed and edited
 * but never deleted, moved or chmod'ed recursively.
 *
 * Anything bigger than a command line (uploads, saving a file) travels over
 * SFTP to a temporary file as the login user and is then moved into place as
 * root, keeping the permissions and owner of whatever it replaces.
 */

import path from 'node:path';
import crypto from 'node:crypto';
import { rootExec } from './ssh.js';
import { splitSections } from './systemInfo.js';

const q = (v) => `'${String(v ?? '').replace(/'/g, `'\\''`)}'`;

/** Largest file the editor opens, and the largest single upload. */
export const MAX_EDIT_BYTES = 2 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Folders and files that are never deleted, moved or recursively changed. */
const PROTECTED = new Set([
  '/', '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib32', '/lib64', '/libx32', '/media', '/mnt', '/opt',
  '/proc', '/root', '/run', '/sbin', '/snap', '/srv', '/sys', '/tmp', '/usr', '/var', '/var/lib', '/var/log',
  '/var/lib/docker', '/etc/passwd', '/etc/shadow', '/etc/group', '/etc/gshadow', '/etc/sudoers', '/etc/sudoers.d',
  '/etc/fstab', '/etc/hosts', '/etc/ssh', '/etc/systemd', '/etc/nginx', '/opt/auto-deploy', '/usr/bin', '/usr/lib',
  '/usr/local', '/usr/sbin', '/var/lib/mysql', '/var/lib/postgresql',
]);
const PSEUDO = /^\/(proc|sys|dev)(\/|$)/;

/** An absolute, normalised path — or an error. Never a relative one, never one with a NUL in it. */
export function cleanPath(input) {
  const raw = String(input ?? '').trim();
  if (!raw.startsWith('/')) throw new Error('Give an absolute path, starting with /');
  if (raw.includes('\0') || raw.length > 1024) throw new Error('That is not a usable path');
  const p = path.posix.normalize(raw);
  return p.length > 1 ? p.replace(/\/+$/, '') : '/';
}

/** A single file or folder name, as typed into "New folder" or "Rename". */
export function cleanName(input) {
  const name = String(input ?? '').trim();
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0') || name.length > 255) {
    throw new Error('A name cannot be empty, "." or "..", or contain "/"');
  }
  return name;
}

function assertChangeable(p, what) {
  if (PROTECTED.has(p) || PSEUDO.test(p)) throw new Error(`${p} is part of the operating system — the panel will not ${what} it`);
}

/** Run a root script and turn a failure into a readable error. */
async function root(conn, server, script, what, timeout = 120000) {
  const r = await rootExec(conn, server, `set -uo pipefail\n${script}`, { timeout });
  if (r.code !== 0) {
    const detail = `${r.stderr}\n${r.stdout}`.trim().split('\n').filter((l) => !l.startsWith('@@@')).slice(-4).join(' ').trim();
    if (/sudo:.*(password is required|no tty|incorrect password)/i.test(detail)) {
      throw new Error(`${what} needs root on this server, but sudo asked for a password the panel does not have.`);
    }
    throw new Error(`${what} failed${detail ? `: ${detail.slice(0, 300)}` : ` (exit ${r.code})`}`);
  }
  return r;
}

/* --------------------------------------------------------------- reading */

/**
 * One folder: every entry with its size, time, mode and owner, the folder's
 * own total, and the filesystem it lives on. Folder sizes come from du, which
 * is given `sizeSeconds` — on a huge tree the slow ones are left without one.
 */
export async function listDir(conn, server, dir, { sizeSeconds = 20 } = {}) {
  const p = cleanPath(dir);
  const script = `P=${q(p)}
[ -e "$P" ] || { echo "No such folder: $P" >&2; exit 4; }
[ -d "$P" ] || { echo "$P is a file, not a folder" >&2; exit 5; }
echo '@@@entries'
find "$P" -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%m\\t%u\\t%g\\t%l\\t%f\\0' 2>/dev/null | head -c 4000000
echo
echo '@@@sizes'
timeout ${Number(sizeSeconds)} du -xb --max-depth=1 -- "$P" 2>/dev/null
echo "rc=$?" >&2
echo '@@@df'
df -B1 --output=size,used,avail,target -- "$P" 2>/dev/null | tail -n 1`;

  const r = await root(conn, server, script, `Reading ${p}`, (sizeSeconds + 40) * 1000);
  const s = splitSections(r.stdout);

  const sizes = {};
  for (const line of String(s.sizes || '').split('\n')) {
    const tab = line.indexOf('\t');
    if (tab > 0) sizes[line.slice(tab + 1)] = Number(line.slice(0, tab));
  }
  const sizesComplete = !/rc=124/.test(r.stderr);

  const entries = String(s.entries || '').split('\0').map((rec) => rec.replace(/^\n/, '')).filter(Boolean).map((rec) => {
    const [type, size, mtime, mode, owner, group, link, ...rest] = rec.split('\t');
    const name = rest.join('\t');
    const full = p === '/' ? `/${name}` : `${p}/${name}`;
    const isDir = type === 'd';
    return {
      name,
      path: full,
      type: isDir ? 'dir' : type === 'l' ? 'link' : type === 'f' ? 'file' : 'other',
      size: isDir ? (sizes[full] ?? null) : Number(size),
      modified: Math.round(Number(mtime) * 1000),
      mode,
      owner,
      group,
      target: link || null,
      protected: PROTECTED.has(full) || PSEUDO.test(full),
      archive: /\.(tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz|tar|zip)$/i.test(name),
    };
  }).sort((a, b) => {
    // Folders first, then by name.
    const da = a.type === 'dir';
    const db = b.type === 'dir';
    if (da !== db) return da ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const [dfSize, dfUsed, dfAvail, mount] = String(s.df || '').trim().split(/\s+/);
  return {
    path: p,
    parent: p === '/' ? null : path.posix.dirname(p),
    total: sizes[p] ?? null,
    sizesComplete,
    entries,
    filesystem: dfSize ? { size: Number(dfSize), used: Number(dfUsed), available: Number(dfAvail), mount } : null,
  };
}

/** A text file for the editor, or why it cannot be opened in one. */
export async function readFile(conn, server, file) {
  const p = cleanPath(file);
  const script = `P=${q(p)}
[ -f "$P" ] || { echo "Not a regular file: $P" >&2; exit 4; }
SIZE=$(stat -c %s -- "$P")
echo '@@@meta'
echo "size=$SIZE"
echo "mode=$(stat -c '%a %U %G' -- "$P")"
if [ "$SIZE" -gt ${MAX_EDIT_BYTES} ]; then echo "big=1"; exit 0; fi
if [ "$SIZE" -gt 0 ] && ! head -c 8000 -- "$P" | grep -qI .; then echo "binary=1"; exit 0; fi
echo '@@@content'
base64 -w0 -- "$P"`;
  const r = await root(conn, server, script, `Opening ${p}`);
  const s = splitSections(r.stdout);
  const meta = Object.fromEntries(String(s.meta || '').split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const [mode, owner, group] = String(meta.mode || '').split(' ');
  const out = { path: p, size: Number(meta.size || 0), mode, owner, group };
  if (meta.big) return { ...out, editable: false, reason: `It is larger than ${MAX_EDIT_BYTES / 1024 / 1024} MB — download it instead.` };
  if (meta.binary) return { ...out, editable: false, reason: 'It is a binary file — download it instead.' };
  return { ...out, editable: true, content: Buffer.from(String(s.content || ''), 'base64').toString('utf8') };
}

/* ------------------------------------------------- moving bytes over SFTP */

const sftpOf = (conn) => new Promise((resolve, reject) => conn.sftp((err, sftp) => (err
  ? reject(new Error(`SFTP is not available on this server (${err.message}) — it is needed for uploads and saving files`))
  : resolve(sftp))));

const tempName = () => `/tmp/.auto-deploy-${crypto.randomBytes(8).toString('hex')}`;

/**
 * Put bytes at `target` as root: over SFTP to a temporary file, then moved.
 * A file that already exists keeps its mode and owner; a new one takes the
 * owner of its folder, so an app's files stay the app's.
 */
async function putFile(conn, server, target, buffer, { overwrite = true } = {}) {
  const sftp = await sftpOf(conn);
  const tmp = tempName();
  try {
    await new Promise((resolve, reject) => sftp.writeFile(tmp, buffer, { mode: 0o600 }, (err) => (err ? reject(err) : resolve())));
  } finally {
    sftp.end();
  }
  await root(conn, server, `T=${q(target)}; S=${q(tmp)}
D="$(dirname -- "$T")"
[ -d "$D" ] || { rm -f -- "$S"; echo "The folder $D does not exist" >&2; exit 4; }
if [ -e "$T" ]; then
  ${overwrite ? '' : 'rm -f -- "$S"; echo "$T already exists" >&2; exit 17'}
  [ -d "$T" ] && { rm -f -- "$S"; echo "$T is a folder" >&2; exit 5; }
  chmod --reference="$T" -- "$S"; chown --reference="$T" -- "$S"
else
  chmod 644 -- "$S"; chown --reference="$D" -- "$S" 2>/dev/null || true
fi
mv -f -- "$S" "$T"`, `Writing ${target}`);
}

export async function writeFile(conn, server, file, content) {
  const p = cleanPath(file);
  const buffer = Buffer.from(String(content ?? ''), 'utf8');
  if (buffer.length > MAX_EDIT_BYTES) throw new Error('That is too much to save from the editor');
  await putFile(conn, server, p, buffer);
  return { path: p, size: buffer.length };
}

export async function uploadFile(conn, server, dir, name, base64, { overwrite = false } = {}) {
  const target = cleanPath(`${cleanPath(dir)}/${cleanName(name)}`);
  const buffer = Buffer.from(String(base64 || ''), 'base64');
  if (buffer.length > MAX_UPLOAD_BYTES) throw new Error(`Uploads are limited to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
  await putFile(conn, server, target, buffer, { overwrite });
  return { path: target, size: buffer.length };
}

/**
 * Stream a file (or a folder, packed as .tar.gz) to `out`. It is copied to a
 * temporary file the login user can read, sent over SFTP, and removed.
 */
export async function downloadTo(conn, server, target, out, { onInfo } = {}) {
  const p = cleanPath(target);
  if (PSEUDO.test(p)) throw new Error('Files under /proc, /sys and /dev cannot be downloaded');
  const tmp = tempName();
  const r = await root(conn, server, `P=${q(p)}; T=${q(tmp)}
if [ -d "$P" ]; then
  tar -czf "$T" -C "$(dirname -- "$P")" -- "$(basename -- "$P")" 2>/dev/null || { [ -s "$T" ] || { echo "Could not pack $P" >&2; exit 5; }; }
  echo "kind=dir"
elif [ -f "$P" ]; then
  cp -- "$P" "$T"; echo "kind=file"
else
  echo "Nothing to download at $P" >&2; exit 4
fi
chown ${q(server.username)} -- "$T" 2>/dev/null || chmod 644 -- "$T"
echo "size=$(stat -c %s -- "$T")"`, `Preparing ${p}`, 30 * 60 * 1000);

  const kind = /kind=dir/.test(r.stdout) ? 'dir' : 'file';
  const size = Number((/size=(\d+)/.exec(r.stdout) || [])[1] || 0);
  onInfo?.({ name: `${path.posix.basename(p) || 'root'}${kind === 'dir' ? '.tar.gz' : ''}`, size, kind });

  const sftp = await sftpOf(conn);
  try {
    await new Promise((resolve, reject) => {
      const stream = sftp.createReadStream(tmp);
      stream.on('error', reject);
      out.on('error', reject);
      stream.on('end', resolve);
      stream.pipe(out);
    });
  } finally {
    sftp.end();
    await rootExec(conn, server, `rm -f -- ${q(tmp)}`, { timeout: 30000 }).catch(() => {});
  }
}

/* -------------------------------------------------------------- changing */

export async function makeFolder(conn, server, dir, name) {
  const p = cleanPath(`${cleanPath(dir)}/${cleanName(name)}`);
  await root(conn, server, `P=${q(p)}
[ -e "$P" ] && { echo "$P already exists" >&2; exit 17; }
mkdir -- "$P" && chown --reference="$(dirname -- "$P")" -- "$P" 2>/dev/null; true`, `Creating ${p}`);
  return { path: p };
}

export async function makeFile(conn, server, dir, name) {
  const p = cleanPath(`${cleanPath(dir)}/${cleanName(name)}`);
  await root(conn, server, `P=${q(p)}
[ -e "$P" ] && { echo "$P already exists" >&2; exit 17; }
: > "$P" && chmod 644 -- "$P" && chown --reference="$(dirname -- "$P")" -- "$P" 2>/dev/null; true`, `Creating ${p}`);
  return { path: p };
}

/** Rename or move. Never over something that is already there. */
export async function move(conn, server, from, to) {
  const src = cleanPath(from);
  const dst = cleanPath(to);
  assertChangeable(src, 'move');
  if (dst === src) throw new Error('That is where it already is');
  if (dst.startsWith(`${src}/`)) throw new Error('A folder cannot be moved into itself');
  await root(conn, server, `S=${q(src)}; D=${q(dst)}
[ -e "$S" ] || [ -L "$S" ] || { echo "$S does not exist" >&2; exit 4; }
[ -e "$D" ] && { echo "$D already exists" >&2; exit 17; }
[ -d "$(dirname -- "$D")" ] || { echo "The folder $(dirname -- "$D") does not exist" >&2; exit 4; }
mv -n -- "$S" "$D"`, `Moving ${src}`);
  return { from: src, to: dst };
}

export async function copy(conn, server, from, to) {
  const src = cleanPath(from);
  const dst = cleanPath(to);
  if (PSEUDO.test(src)) throw new Error('Files under /proc, /sys and /dev cannot be copied');
  if (dst.startsWith(`${src}/`)) throw new Error('A folder cannot be copied into itself');
  await root(conn, server, `S=${q(src)}; D=${q(dst)}
[ -e "$S" ] || { echo "$S does not exist" >&2; exit 4; }
[ -e "$D" ] && { echo "$D already exists" >&2; exit 17; }
cp -a -- "$S" "$D"`, `Copying ${src}`, 30 * 60 * 1000);
  return { from: src, to: dst };
}

export async function remove(conn, server, target) {
  const p = cleanPath(target);
  assertChangeable(p, 'delete');
  await root(conn, server, `P=${q(p)}
[ -e "$P" ] || [ -L "$P" ] || { echo "$P does not exist" >&2; exit 4; }
rm -rf --one-file-system -- "$P"`, `Deleting ${p}`, 30 * 60 * 1000);
  return { path: p };
}

/** chmod and/or chown, optionally through a whole folder. */
export async function setPermissions(conn, server, target, { mode, owner, group, recursive = false }) {
  const p = cleanPath(target);
  if (PSEUDO.test(p)) throw new Error('Files under /proc, /sys and /dev cannot be changed');
  if (recursive) assertChangeable(p, 'change permissions throughout');
  const m = String(mode ?? '').trim();
  if (m && !/^[0-7]{3,4}$/.test(m)) throw new Error('The mode is three or four octal digits, like 644 or 755');
  const o = String(owner ?? '').trim();
  const g = String(group ?? '').trim();
  const NAME = /^[a-z_][a-z0-9_.-]{0,31}\$?$|^\d{1,10}$/i;
  if (o && !NAME.test(o)) throw new Error('That is not a user name');
  if (g && !NAME.test(g)) throw new Error('That is not a group name');
  if (!m && !o && !g) throw new Error('Nothing to change');
  const R = recursive ? '-R ' : '';
  await root(conn, server, `P=${q(p)}
[ -e "$P" ] || { echo "$P does not exist" >&2; exit 4; }
${m ? `chmod ${R}${m} -- "$P"` : ''}
${o || g ? `chown ${R}${q(`${o}${g ? `:${g}` : ''}`)} -- "$P"` : ''}`, `Changing ${p}`, 10 * 60 * 1000);
  return { path: p };
}

/** Unpack an archive into the folder it sits in. */
export async function extract(conn, server, target) {
  const p = cleanPath(target);
  const cmd = /\.zip$/i.test(p)
    ? 'command -v unzip >/dev/null || { echo "unzip is not installed (apt install unzip)" >&2; exit 9; }; unzip -o -q -- "$P" -d "$(dirname -- "$P")"'
    : /\.(tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz|tar)$/i.test(p) ? 'tar -xf "$P" -C "$(dirname -- "$P")"'
      : null;
  if (!cmd) throw new Error('Only .zip, .tar, .tar.gz, .tgz, .tar.bz2 and .tar.xz can be extracted');
  await root(conn, server, `P=${q(p)}
[ -f "$P" ] || { echo "$P does not exist" >&2; exit 4; }
${cmd}`, `Extracting ${p}`, 30 * 60 * 1000);
  return { path: p, into: path.posix.dirname(p) };
}
