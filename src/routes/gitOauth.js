import { Router } from 'express';
import { one, run, logActivity } from '../db/index.js';
import { encrypt } from '../lib/crypto.js';
import { authenticate, gitKind } from '../lib/git.js';
import { configuredProviders, beginAuthorization, takeState, exchangeCode, callbackUrl, setProviderCredentials, verifyClientCredentials } from '../lib/oauth.js';
import { setEnvValues, envFilePath } from '../lib/envFile.js';
import { config } from '../config.js';

export const gitOauthRouter = Router();

/** Which providers can be used for browser sign-in, and the callback to register. */
gitOauthRouter.get('/providers', (req, res) => {
  res.json({ callbackUrl: callbackUrl(), providers: configuredProviders() });
});

/**
 * Save an OAuth app's client ID and secret. They are written to .env and used
 * straight away, so connecting an account never needs a restart.
 */
gitOauthRouter.post("/config", async (req, res) => {
  const kind = gitKind(req.body.kind);
  const previous = { ...config.oauth[kind] };
  try {
    const { label } = setProviderCredentials(kind, req.body.clientId || '', req.body.clientSecret || '');

    // Confirm the provider actually knows this app before we save it.
    const check = await verifyClientCredentials(kind, config.oauth[kind].clientId, config.oauth[kind].clientSecret);
    if (!check.ok) {
      config.oauth[kind].clientId = previous.clientId;
      config.oauth[kind].clientSecret = previous.clientSecret;
      return res.status(400).json({
        ok: false,
        error: `${check.reason} Create an OAuth app on ${label}, then copy its Client ID and Client Secret here.`,
      });
    }

    const prefix = kind.toUpperCase();
    setEnvValues({
      [`${prefix}_CLIENT_ID`]: config.oauth[kind].clientId,
      [`${prefix}_CLIENT_SECRET`]: config.oauth[kind].clientSecret,
      OAUTH_CALLBACK_BASE: config.oauth.callbackBase,
    });
    await logActivity('oauth', null, 'configured', `Saved the ${label} OAuth app credentials`);
    res.json({ ok: true, kind, label, envFile: envFilePath() });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

/**
 * Step 1 — send the browser to the provider.
 * Opened in a popup by the UI, so we redirect rather than return JSON.
 */
gitOauthRouter.get('/start', (req, res) => {
  const kind = gitKind(req.query.kind);
  // Not set up (or the keys were taken out of .env since the page loaded): send the wizard to its setup step.
  if (!config.oauth[kind]?.clientId || !config.oauth[kind]?.clientSecret) {
    return res.status(400).send(resultPage({
      ok: false, needsSetup: true, kind,
      error: 'Browser sign-in for this provider is not set up yet. Go back to AJ Pilot to set it up — it takes a minute, once.',
    }));
  }
  try {
    const { url } = beginAuthorization(kind, { name: req.query.name });
    res.redirect(url);
  } catch (err) {
    res.status(400).send(resultPage({ ok: false, error: err.message }));
  }
});

/**
 * Step 2 — the provider sends the browser back here with a code.
 * We swap it for a token, authenticate it, and store the account.
 */
gitOauthRouter.get('/callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;

  if (error) {
    return res.status(400).send(resultPage({
      ok: false,
      error: errorDescription || (error === 'access_denied' ? 'You cancelled the sign-in.' : String(error)),
    }));
  }
  if (!code || !state) {
    return res.status(400).send(resultPage({ ok: false, error: 'The provider did not send a code. Start the connection again.' }));
  }

  const entry = takeState(String(state));
  if (!entry) {
    return res.status(400).send(resultPage({
      ok: false,
      error: 'This sign-in link has expired or was already used. Start the connection again.',
    }));
  }

  try {
    const token = await exchangeCode(entry.kind, String(code), entry.verifier);

    const settings = {
      kind: entry.kind,
      apiUrl: config.oauth[entry.kind].apiUrl,
      webUrl: config.oauth[entry.kind].webUrl,
    };
    const account = await authenticate(token.accessToken, settings);

    // OAuth reports its granted scopes even when the API response does not.
    if (!account.scopes?.length && token.scopes.length) {
      account.scopes = token.scopes;
      account.tokenStyle = 'oauth';
    } else if (token.scopes.length) {
      account.tokenStyle = 'oauth';
    }

    const name = entry.name || `${account.login}@${entry.kind}`;
    const extra = {
      ...settings,
      account,
      auth: 'oauth',
      expiresAt: token.expiresAt,
      ...(token.refreshToken ? { refreshTokenEnc: encrypt(token.refreshToken) } : {}),
    };

    // Re-connecting the same account updates it rather than failing on the unique key.
    // The account lands in the organisation the person signing in is working in.
    const existing = await one('SELECT id FROM credentials WHERE provider = ? AND name = ? AND org_id = ?', ['git', name, req.orgId]);

    let id;
    if (existing) {
      id = existing.id;
      await run(
        "UPDATE credentials SET username=?, secret_enc=?, extra=?, status='valid', last_error=NULL, verified_at=NOW() WHERE id=?",
        [account.login, encrypt(token.accessToken), JSON.stringify(extra), id]
      );
      await logActivity('credential', id, 'git_reconnected', `Re-connected ${entry.kind} account ${account.login} through the browser`);
    } else {
      ({ insertId: id } = await run(
        "INSERT INTO credentials (org_id, provider, name, username, secret_enc, extra, status, verified_at) VALUES (?,'git',?,?,?,?,'valid',NOW())",
        [req.orgId, name, account.login, encrypt(token.accessToken), JSON.stringify(extra)]
      ));
      await logActivity('credential', id, 'git_connected', `Connected ${entry.kind} account ${account.login} through the browser`);
    }

    res.send(resultPage({ ok: true, id, login: account.login, kind: entry.kind }));
  } catch (err) {
    res.status(400).send(resultPage({ ok: false, error: err.message }));
  }
});

/**
 * The page the provider redirects back to. It reports the outcome to the
 * window that opened it and closes; if it was opened directly it links home.
 */
function resultPage(result) {
  const payload = JSON.stringify({ source: 'auto-deploy-oauth', ...result });
  const safe = payload.replace(/</g, '\\u003c');
  const heading = result.ok ? 'Connected' : 'Could not connect';
  const body = result.ok
    ? `Signed in as <strong>${escapeHtml(result.login)}</strong>. You can close this window.`
    : escapeHtml(result.error || 'Something went wrong.');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${heading}</title>
<style>
  :root { color-scheme: dark; --bg:#07080c; --card:#10131b; --line:#1f2635; --text:#f3f5f9; --muted:#a0a9bb; --link:#60a5fa; --glow:#0f2150; }
  @media (prefers-color-scheme: light) {
    :root { color-scheme: light; --bg:#f6f8fc; --card:#ffffff; --line:#dfe5ef; --text:#0b1a36; --muted:#55627a; --link:#1d4ed8; --glow:#d6e2fb; }
  }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:radial-gradient(900px 500px at 50% -10%, var(--glow), transparent 70%), var(--bg);
         color:var(--text); font:15px/1.6 "Plus Jakarta Sans","Segoe UI",system-ui,sans-serif; }
  .box { max-width:460px; padding:28px 32px; background:var(--card); border:1px solid var(--line);
         border-top:3px solid ${result.ok ? '#2563eb' : '#e5484d'}; border-radius:14px; box-shadow:0 20px 50px -20px rgba(0,0,0,.45); }
  h1 { margin:0 0 8px; font-size:18px; }
  p { margin:0; color:var(--muted); }
  a { color:var(--link); font-weight:600; }
</style></head>
<body>
  <div class="box">
    <h1>${heading}</h1>
    <p>${body}</p>
    <p style="margin-top:14px"><a href="/">Back to AJ Pilot</a></p>
  </div>
  <script>
    var result = ${safe};
    try { if (window.opener) { window.opener.postMessage(result, window.location.origin); setTimeout(function(){ window.close(); }, result.ok ? 900 : 4000); } } catch (e) {}
  </script>
</body></html>`;
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
