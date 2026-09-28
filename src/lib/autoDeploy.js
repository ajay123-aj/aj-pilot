/**
 * Auto deploy: an app redeploys by itself when the branch it runs changes.
 *
 * Two ways in, both ending in the same check:
 *  - a webhook — GitHub, GitLab or Bitbucket calls /api/hooks/apps/<token> the
 *    moment something is pushed or a pull / merge request is merged. Instant,
 *    but only when the panel can be reached from the internet;
 *  - a poll — every minute each auto-deploy app's branch is read through the
 *    provider's API. Always works, including on a panel behind a firewall.
 *
 * An app deploys either on every new commit ("push") or only when the new
 * commit came from a merged pull / merge request ("merge"). The commit a
 * deploy built is remembered, so the same commit is never deployed twice and
 * a failed one is not retried in a loop.
 */

import crypto from 'node:crypto';
import { all, one, run, logActivity } from '../db/index.js';
import { runWithContext } from './context.js';
import { loadGitCredential } from './gitAccounts.js';
import { branchHead, mergedRequestFor } from './git.js';

const INTERVAL = Math.max(20, Number(process.env.AUTO_DEPLOY_INTERVAL || 60)) * 1000;
// A push that is not a merge is looked at again for a while (the provider can
// take a moment to link a commit to its request), then left alone.
const MERGE_GRACE_MS = 10 * 60 * 1000;

let deployFn = null;

/** Wired from the apps router, which owns how a deploy runs. */
export function configureAutoDeploy({ deploy }) {
  deployFn = deploy;
}

export const newWebhookToken = () => crypto.randomBytes(24).toString('hex');
export const webhookUrl = (base, token) => `${String(base).replace(/\/+$/, '')}/api/hooks/apps/${token}`;

/** Can GitHub and friends reach this address? localhost and private networks cannot. */
export function isPublicUrl(url) {
  try {
    const { hostname, protocol } = new URL(url);
    if (!/^https?:$/.test(protocol)) return false;
    if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal') || !hostname.includes('.')) return false;
    if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(hostname)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

const short = (sha) => String(sha || '').slice(0, 7);

/**
 * Deploy `head` if it is new and the app's trigger allows it. `merged` comes
 * from a webhook that already knows the commit is a merged request.
 */
export async function considerHead(app, head, { source, merged = null, account = null }) {
  if (!head?.sha || !deployFn) return { skipped: 'nothing to compare' };
  if (head.sha === app.deployed_sha || head.sha === app.auto_seen_sha) return { skipped: 'already deployed' };
  // Busy now: the next poll picks the commit up once this deploy has finished.
  if (app.status === 'deploying') return { skipped: 'a deploy is running' };

  let merge = merged;
  if (app.auto_deploy_trigger === 'merge' && !merge) {
    const acc = account || await loadGitCredential(app.credential_id);
    merge = await mergedRequestFor(acc.token, acc.extra, app.repo, head.sha, app.branch);
    if (!merge && head.parents >= 2) merge = { title: head.message };
    if (!merge) {
      // A plain push onto a "merge only" branch: noted, and after a while no longer looked at.
      const age = head.date ? Date.now() - Date.parse(head.date) : Infinity;
      if (age > MERGE_GRACE_MS) await run('UPDATE apps SET auto_seen_sha = ? WHERE id = ?', [head.sha, app.id]);
      return { skipped: 'not a merged pull / merge request' };
    }
  }

  await run('UPDATE apps SET auto_seen_sha = ? WHERE id = ?', [head.sha, app.id]);
  const what = merge
    ? `merged ${merge.number ? `#${merge.number} ` : ''}"${merge.title || head.message || ''}"${merge.from ? ` from ${merge.from}` : ''}`
    : `new commit ${short(head.sha)} "${head.message || ''}"${head.author ? ` by ${head.author}` : ''}`;
  const reason = `Auto deploy (${source}): ${what} on ${app.branch}`;
  await logActivity('app', app.id, 'auto_deploy', `${app.name}: ${reason}`);
  await deployFn(app.id, { reason });
  return { deployed: true, sha: head.sha };
}

/** Read the branch and deploy if it moved — the poll, and "Check now". */
export async function checkApp(app, { source = 'check' } = {}) {
  let account;
  try {
    account = await loadGitCredential(app.credential_id);
    const head = await branchHead(account.token, account.extra, app.repo, app.branch);
    await run('UPDATE apps SET auto_checked_at = NOW(), auto_error = NULL WHERE id = ?', [app.id]);
    const result = await considerHead(app, head, { source, account });
    return { ...result, head };
  } catch (err) {
    await run('UPDATE apps SET auto_checked_at = NOW(), auto_error = ? WHERE id = ?', [String(err.message).slice(0, 500), app.id]);
    return { error: err.message };
  }
}

/* ------------------------------------------------------------ the poll */

let polling = false;

async function pollOnce() {
  if (polling) return;
  polling = true;
  try {
    const apps = await all("SELECT * FROM apps WHERE auto_deploy = 1 AND status <> 'deploying'");
    for (const app of apps) {
      // Every change it makes is recorded against the app's own organisation.
      await runWithContext({ orgId: app.org_id, user: null }, () => checkApp(app, { source: 'branch check' }));
    }
  } catch (err) {
    console.error('[auto deploy] poll failed:', err.message);
  } finally {
    polling = false;
  }
}

export function startAutoDeployPoller() {
  setTimeout(pollOnce, 15000);
  setInterval(pollOnce, INTERVAL).unref();
}

/* ------------------------------------------------------------ webhooks */

/**
 * What a provider's delivery says: the branch, the new head and whether it is
 * a merged request. `null` for anything that is not a push or a merge.
 */
function readDelivery(req) {
  const b = req.body || {};
  const gh = req.get('x-github-event');
  const gl = req.get('x-gitlab-event');
  const bb = req.get('x-event-key');

  if (gh === 'ping' || bb === 'diagnostics:ping') return { ping: true };
  if (gh === 'push' && !b.deleted) {
    const c = b.head_commit || {};
    return { branch: String(b.ref || '').replace(/^refs\/heads\//, ''), head: { sha: b.after, message: String(c.message || '').split('\n')[0], author: c.author?.name } };
  }
  if (gh === 'pull_request' && b.action === 'closed' && b.pull_request?.merged) {
    const pr = b.pull_request;
    return { branch: pr.base?.ref, head: { sha: pr.merge_commit_sha, message: pr.title, author: pr.merged_by?.login }, merged: { number: pr.number, title: pr.title, from: pr.head?.ref } };
  }
  if (gl === 'Push Hook') {
    const c = (b.commits || []).find((x) => x.id === b.checkout_sha) || (b.commits || []).slice(-1)[0] || {};
    return { branch: String(b.ref || '').replace(/^refs\/heads\//, ''), head: { sha: b.checkout_sha || b.after, message: String(c.title || c.message || '').split('\n')[0], author: c.author?.name } };
  }
  if (gl === 'Merge Request Hook' && b.object_attributes?.action === 'merge') {
    const mr = b.object_attributes;
    return { branch: mr.target_branch, head: { sha: mr.merge_commit_sha || mr.last_commit?.id, message: mr.title, author: b.user?.name }, merged: { number: mr.iid, title: mr.title, from: mr.source_branch } };
  }
  if (bb === 'repo:push') {
    const change = (b.push?.changes || []).find((c) => c.new?.type === 'branch');
    if (!change) return null;
    return { branch: change.new.name, head: { sha: change.new.target?.hash, message: String(change.new.target?.message || '').split('\n')[0], author: change.new.target?.author?.user?.display_name } };
  }
  if (bb === 'pullrequest:fulfilled') {
    const pr = b.pullrequest || {};
    return { branch: pr.destination?.branch?.name, head: { sha: pr.merge_commit?.hash, message: pr.title }, merged: { number: pr.id, title: pr.title, from: pr.source?.branch?.name } };
  }
  return null;
}

/**
 * POST /api/hooks/apps/:token — public; the unguessable token in the address
 * is what proves the call comes from the repository's own webhook. GitLab also
 * repeats it in X-Gitlab-Token, which is checked when present.
 */
export async function handleAppWebhook(req, res) {
  try {
    const token = String(req.params.token || '');
    if (!/^[0-9a-f]{48}$/.test(token)) return res.status(404).json({ error: 'Unknown hook' });
    const app = await one('SELECT * FROM apps WHERE webhook_token = ?', [token]);
    if (!app) return res.status(404).json({ error: 'Unknown hook' });
    const glToken = req.get('x-gitlab-token');
    if (glToken && glToken !== token) return res.status(403).json({ error: 'Wrong token' });

    const d = readDelivery(req);
    if (d?.ping) return res.json({ ok: true, app: app.name, message: 'Webhook reached AJ Pilot' });
    if (!d || !d.head?.sha) return res.json({ ok: true, ignored: 'not a push or a merged request' });
    if (!app.auto_deploy) return res.json({ ok: true, ignored: 'auto deploy is off for this app' });
    if (d.branch !== app.branch) return res.json({ ok: true, ignored: `branch ${d.branch} is not ${app.branch}` });

    // Answer straight away — providers give up after ten seconds — and deploy behind it.
    res.status(202).json({ ok: true, accepted: true, sha: d.head.sha });
    runWithContext({ orgId: app.org_id, user: null }, () => considerHead(app, d.head, { source: 'webhook', merged: d.merged || null }))
      .catch((err) => console.error('[auto deploy] webhook deploy failed:', err.message));
  } catch (err) {
    console.error('[auto deploy] webhook failed:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Could not handle the delivery' });
  }
}
