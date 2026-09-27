/**
 * Getting at a stored git account.
 *
 * Both the credentials routes and the runner routes need the same three
 * things from a git credential row: a token that is still valid right now,
 * the host settings that go with it, and the account it belongs to.
 */

import { one, run, logActivity } from '../db/index.js';
import { encrypt, decrypt } from './crypto.js';
import { refreshAccessToken } from './oauth.js';
import { gitSettings } from './git.js';

/** MySQL hands JSON columns back parsed; be tolerant of either shape. */
export const asJson = (v) => {
  if (!v) return {};
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return {}; } }
  return v;
};

const httpError = (message, status) => Object.assign(new Error(message), { status });

/** The credential row, its settings and a usable token — or a 404/400 error. */
export async function loadGitCredential(id) {
  const row = await one('SELECT * FROM credentials WHERE id = ?', [id]);
  if (!row) throw httpError('Git account not found', 404);
  if (row.provider !== 'git') throw httpError('That credential is not a git account', 400);
  const extra = asJson(row.extra);
  return { row, extra, settings: gitSettings(extra), token: await usableGitToken(row) };
}

/**
 * An OAuth access token can expire (GitLab's last two hours). If it has, and we
 * hold a refresh token, swap it for a fresh one before the request goes out.
 */
export async function usableGitToken(row) {
  const extra = asJson(row.extra);
  const token = decrypt(row.secret_enc);

  const expiresAt = extra.expiresAt ? Date.parse(extra.expiresAt) : null;
  const expiringSoon = expiresAt && expiresAt - Date.now() < 60_000;
  if (!expiringSoon || !extra.refreshTokenEnc) return token;

  const fresh = await refreshAccessToken(extra.kind || 'github', decrypt(extra.refreshTokenEnc));
  const nextExtra = {
    ...extra,
    expiresAt: fresh.expiresAt,
    ...(fresh.refreshToken ? { refreshTokenEnc: encrypt(fresh.refreshToken) } : {}),
  };
  await run('UPDATE credentials SET secret_enc = ?, extra = ? WHERE id = ?',
    [encrypt(fresh.accessToken), JSON.stringify(nextExtra), row.id]);
  await logActivity('credential', row.id, 'git_token_refreshed', `Refreshed the ${extra.kind || 'github'} access token`);
  return fresh.accessToken;
}
