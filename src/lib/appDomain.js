/**
 * A domain for a custom app, set up end to end once its container is running.
 *
 * Two ways in:
 *
 *   dns        Cloudflare A record → the server's public IP, then an nginx
 *              site proxying to the app, then a Let's Encrypt certificate with
 *              an HTTP → HTTPS redirect. The record starts DNS-only so the
 *              certificate challenge reaches the server; it is switched to
 *              proxied afterwards when asked and when that cannot loop.
 *
 *   zerotrust  A public hostname on a Cloudflare Tunnel pointing at the app's
 *              port. Cloudflare terminates HTTPS, so there is no nginx and no
 *              certificate. The tunnel is an existing one, or a new one whose
 *              cloudflared connector is installed on the server as a service.
 *
 * Every step is written to the app's domain log as it happens, so the card can
 * show how far it got, and every step can run again: a retry picks up records,
 * sites and certificates that are already there instead of failing on them.
 */

import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import { all, one, run, logActivity } from '../db/index.js';
import { decrypt } from './crypto.js';
import { asJson } from './gitAccounts.js';
import { connectionFromRow, withConnection, exec, rootExec } from './ssh.js';
import {
  authenticateCloudflare, zoneFor, recordsNamed, getZoneSslMode, buildDnsRecord, createDnsRecord, updateDnsRecord, deleteDnsRecord,
  createTunnel, getTunnelToken, deleteTunnel, buildHostnameRule, addPublicHostname, updatePublicHostname, deletePublicHostname,
  ensureTunnelCname,
} from './cloudflare.js';
import {
  validateDomain, validateSiteName, buildSiteConfig, readSite, writeSite, removeSite, installNginx, installCertbot,
  issueCertificate, deleteCertificate,
} from './nginx.js';

const b64 = (text) => Buffer.from(String(text), 'utf8').toString('base64');

/* ------------------------------------------------------------ the form */

/**
 * The domain part of the create-app form (or the "add a domain" form) as a
 * stored config, or { error }. Nothing here talks to Cloudflare yet.
 */
export async function domainConfigFrom(body, orgId, { domainId = null, userEmail = null } = {}) {
  const checked = validateDomain(body.domain);
  if (checked.error) return { error: checked.error };
  const domain = checked.value;
  if (domain.startsWith('*.')) return { error: 'An app needs a single hostname, not a wildcard' };
  if (!domain.includes('.')) return { error: 'Give the full hostname, like app.example.com' };

  const mode = body.domain_mode === 'zerotrust' ? 'zerotrust' : 'dns';
  const cred = await one("SELECT id, extra FROM credentials WHERE id = ? AND org_id = ? AND provider = 'cloudflare'",
    [Number(body.domain_cred_id), orgId]);
  if (!cred) return { error: 'Pick the Cloudflare account the domain is on' };

  // The domain must sit under a zone that account can see — checked against
  // what was read when the account was connected, and again when it runs.
  const zones = asJson(cred.extra)?.account?.zones || [];
  if (zones.length && !zoneFor(zones, domain)) {
    return { error: `${domain} is not under any domain on that Cloudflare account (${zones.map((z) => z.name).join(', ')}). Add the domain to Cloudflare first.` };
  }

  const taken = await one(`SELECT a.name FROM app_domains d JOIN apps a ON a.id = d.app_id
    WHERE d.org_id = ? AND d.domain = ? AND d.id <> ?`, [orgId, domain, domainId || 0]);
  if (taken) return { error: `${domain} is already a domain of "${taken.name}"` };

  // Which of the app's ports the domain sends traffic to; empty = its first one.
  const port = body.domain_port === undefined || body.domain_port === '' || body.domain_port === null ? null : Number(body.domain_port);
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) return { error: 'The port for the domain must be between 1 and 65535' };

  const tunnel = String(body.domain_tunnel || 'new');
  if (mode === 'zerotrust' && tunnel !== 'new' && !/^[0-9a-f-]{36}$/i.test(tunnel)) return { error: 'Pick a tunnel, or let the panel create one' };

  const email = String(body.domain_email || userEmail || '').trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'That certificate email does not look like an email address' };

  return {
    value: {
      domain,
      port,
      config: {
        mode,
        credentialId: cred.id,
        proxied: body.domain_proxied === true || body.domain_proxied === 'true' || body.domain_proxied === 'on',
        email: email || null,
        tunnelId: mode === 'zerotrust' ? tunnel : null,
        tunnelName: mode === 'zerotrust' && tunnel !== 'new' ? String(body.domain_tunnel_name || '').slice(0, 64) || null : null,
      },
    },
  };
}

/** What the browser may see of a stored config (it holds nothing secret, but keep it tidy). */
export function publicDomainConfig(config) {
  const c = asJson(config);
  if (!c) return null;
  return { mode: c.mode, credentialId: c.credentialId, proxied: Boolean(c.proxied), email: c.email || null, tunnelId: c.tunnelId || null, tunnelName: c.tunnelName || null };
}

/* ------------------------------------------------------------- running */

/**
 * The app as one of its domains sees it: the app's own fields, with that
 * domain's name, config and target port. The setup and teardown steps below
 * were written against a single-domain app and read exactly these fields.
 */
export function domainView(app, dom) {
  return { ...app, domain: dom.domain, domain_config: dom.config, port: dom.port || app.port, domainId: dom.id };
}

/** Set up every domain of an app that is not live yet, one after another. */
export async function setupAppDomains(appId) {
  const doms = await all("SELECT id FROM app_domains WHERE app_id = ? AND status <> 'active' ORDER BY id", [appId]);
  for (const d of doms) await setupDomain(d.id);
}

/**
 * Set up one domain. Called after a successful deploy, when a domain is added
 * to a running app, and by "Retry". Never throws: the outcome is written to
 * the domain's row.
 */
export async function setupDomain(domainId) {
  const dom = await one('SELECT * FROM app_domains WHERE id = ?', [domainId]);
  const app = dom && await one('SELECT * FROM apps WHERE id = ?', [dom.app_id]);
  if (!dom || !app) return;
  const row = domainView(app, dom);
  const appId = app.id;
  const config = asJson(dom.config) || {};
  const lines = [];

  const log = async (text) => {
    lines.push(`[${new Date().toISOString().slice(11, 19)}] ${text}`);
    await run('UPDATE app_domains SET log = ? WHERE id = ?', [lines.join('\n').slice(-60000), domainId]);
  };

  await run("UPDATE app_domains SET status = 'configuring', error = NULL, log = NULL WHERE id = ?", [domainId]);

  try {
    const server = await one('SELECT * FROM servers WHERE id = ?', [row.server_id]);
    if (!server) throw new Error('The server this app runs on no longer exists');
    const cred = await one("SELECT * FROM credentials WHERE id = ? AND provider = 'cloudflare'", [config.credentialId]);
    if (!cred) throw new Error('The Cloudflare account chosen for this domain no longer exists');
    const token = decrypt(cred.secret_enc);

    await log(`Reading the zones on Cloudflare account "${cred.name}"…`);
    const account = await authenticateCloudflare(token);
    const zone = zoneFor(account.zones, row.domain);
    if (!zone) {
      throw new Error(`${row.domain} is not under any domain on this Cloudflare account`
        + ` (${account.zones.map((z) => z.name).join(', ') || 'it has none'}). Add the domain to Cloudflare first.`);
    }
    await log(`${row.domain} is in the zone ${zone.name}.`);

    const ctx = { row, server, token, zone, zones: account.zones, config, log };
    const url = config.mode === 'zerotrust' ? await viaTunnel(ctx) : await viaDns(ctx);

    await log(`Checking ${url} through public DNS…`);
    const check = await probe(url);
    await log(check.text);
    if (check.failed) throw new Error(check.text);

    await run("UPDATE app_domains SET status = 'active', error = NULL WHERE id = ?", [domainId]);
    await log(`Done — ${row.name} answers on ${url}`);
    await logActivity('app', appId, 'domain_ready', `${row.name} is live on ${url} (${config.mode === 'zerotrust' ? 'Cloudflare Tunnel' : 'DNS + nginx + SSL'}, port ${row.port})`);
  } catch (err) {
    await log(`Failed: ${err.message}`).catch(() => {});
    if (err.cause && typeof err.cause === 'string') await log(err.cause.slice(-3000)).catch(() => {});
    await run("UPDATE app_domains SET status = 'error', error = ? WHERE id = ?", [err.message, domainId]);
    await logActivity('app', appId, 'domain_failed', `${row.name} on ${row.domain}: ${err.message}`, 'error');
  }
}

/* DNS → nginx → certificate */

async function viaDns({ row, server, token, zone, config, log }) {
  return withConnection(connectionFromRow(server), async (conn) => {
    // 1. Where the world reaches this server.
    const ip = await publicIp(conn, server);
    await log(`The server's public address is ${ip}.`);

    // 2. The A record, DNS-only for now so Let's Encrypt reaches nginx directly.
    const existing = await recordsNamed(token, zone.id, row.domain);
    let record = existing.find((r) => r.type === 'A' && r.content === ip);
    if (record) {
      await log(`Cloudflare already has ${row.domain} → ${ip}; using it.`);
    } else if (existing.length) {
      const r = existing[0];
      throw new Error(`${row.domain} already has a ${r.type} record on Cloudflare (→ ${r.content}). Delete or change it under Account management → Cloudflare → DNS, then retry.`);
    } else {
      record = await createDnsRecord(token, zone.id, buildDnsRecord({
        type: 'A', name: row.domain, content: ip, proxied: false, ttl: 1, comment: `AJ Pilot app ${row.name}`,
      }, zone.name));
      await log(`Created the DNS record ${row.domain} → ${ip} (DNS only, until the certificate is issued).`);
    }
    if (record.proxied) {
      // A retry after the switch: go back to DNS-only so the challenge can reach the server.
      await updateDnsRecord(token, zone.id, record.id, { type: 'A', name: row.domain, content: ip, proxied: false, ttl: 1, comment: record.comment || '' });
      await log('Switched the record to DNS only for the certificate challenge.');
    }

    await waitForDns(row.domain, ip, log);

    // 3. nginx in front of the app.
    const hasNginx = (await exec(conn, 'command -v nginx >/dev/null 2>&1 && echo yes || echo no')).stdout.trim() === 'yes';
    if (!hasNginx) {
      await log('nginx is not installed on this server — installing it…');
      const r = await installNginx(conn, server);
      await log(`Installed nginx ${r.version || ''}.`);
    }

    const site = validateSiteName(row.domain);
    if (site.error) throw new Error(site.error);
    const upstream = `http://127.0.0.1:${row.port}`;
    const current = await readSite(conn, server, site.value).catch(() => null);
    if (current && !current.content.includes(`proxy_pass ${upstream}`)) {
      throw new Error(`This server already has an nginx site called "${site.value}" that does not point at ${row.name}. Remove or edit it on the server's Nginx tab, then retry.`);
    }
    if (current) {
      await log(`The nginx site ${site.value} already proxies to ${upstream}; keeping it.`);
    } else {
      await writeSite(conn, server, {
        name: site.value,
        content: buildSiteConfig({ name: site.value, domains: [row.domain], kind: 'proxy', upstream, websockets: true, maxBodySize: '25m' }),
        mustBeNew: true,
      });
      await log(`Wrote the nginx site ${site.value}: ${row.domain} → ${upstream}. Configuration tested and reloaded.`);
    }

    // 4. The certificate, installed into that site with a redirect to HTTPS.
    await log('Making sure certbot is installed…');
    await installCertbot(conn, server);
    await log(`Asking Let's Encrypt for a certificate for ${row.domain}…`);
    await issueCertificate(conn, server, { domains: [row.domain], email: config.email, redirect: true });
    await log('Certificate issued and installed; HTTP now redirects to HTTPS. certbot renews it on its own.');

    // 5. Cloudflare's proxy, only where it will not loop.
    if (config.proxied) {
      const mode = await getZoneSslMode(token, zone.id).catch(() => null);
      if (mode === 'flexible' || mode === 'off') {
        await log(`Left the record DNS only: the zone's SSL mode is "${mode}", and proxying would loop against the HTTPS redirect. Set SSL/TLS to Full (strict) in Cloudflare, then retry to proxy it.`);
      } else {
        const fresh = (await recordsNamed(token, zone.id, row.domain)).find((r) => r.type === 'A' && r.content === ip);
        if (fresh) {
          await updateDnsRecord(token, zone.id, fresh.id, { type: 'A', name: row.domain, content: ip, proxied: true, ttl: 1, comment: fresh.comment || '' });
          await log(`Switched ${row.domain} to proxied through Cloudflare (zone SSL mode: ${mode || 'unknown'}).`);
        }
      }
    }

    return `https://${row.domain}`;
  });
}

/** The address a DNS record should point at: the host itself when public, otherwise what the server says it is. */
async function publicIp(conn, server) {
  if (net.isIPv4(server.host) && !isPrivate(server.host)) return server.host;
  if (!net.isIP(server.host)) {
    const found = await dns.lookup(server.host, { family: 4 }).catch(() => null);
    if (found && !isPrivate(found.address)) return found.address;
  }
  const r = await exec(conn, 'curl -4 -fsS --max-time 8 https://api.ipify.org 2>/dev/null || curl -4 -fsS --max-time 8 https://ifconfig.me 2>/dev/null || wget -4 -qO- --timeout=8 https://api.ipify.org 2>/dev/null', { timeout: 30000 });
  const ip = r.stdout.trim();
  if (!net.isIPv4(ip) || isPrivate(ip)) {
    throw new Error(`Could not find a public IPv4 address for ${server.name} (${server.host}). A DNS record needs one — use Zero Trust instead for a server behind NAT.`);
  }
  return ip;
}

function isPrivate(ip) {
  return /^(10\.|127\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip);
}

/** Wait until public resolvers return the new address, so the certificate challenge finds the server. */
async function waitForDns(domain, ip, log) {
  const resolver = new dns.Resolver({ timeout: 4000, tries: 1 });
  resolver.setServers(['1.1.1.1', '8.8.8.8']);
  await log(`Waiting for ${domain} to resolve to ${ip}…`);
  for (let i = 0; i < 24; i++) {
    const found = await resolver.resolve4(domain).catch(() => []);
    if (found.includes(ip)) {
      await log(`${domain} resolves to ${ip}.`);
      return;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  await log(`${domain} does not resolve to ${ip} yet after 2 minutes — trying the certificate anyway.`);
}

/* Cloudflare Tunnel */

async function viaTunnel({ row, server, token, zone, zones, config, log }) {
  const accountId = zone.accountId;
  if (!accountId) throw new Error(`Cloudflare did not say which account ${zone.name} belongs to`);

  let tunnelId = config.tunnelId;
  if (!tunnelId || tunnelId === 'new') {
    const name = `${row.name}-${server.name}`.replace(/[^A-Za-z0-9 _.-]/g, '-').slice(0, 64);
    await log(`Creating the Cloudflare Tunnel "${name}"…`);
    const tunnel = await createTunnel(token, accountId, name);
    tunnelId = tunnel.id;
    // Remembered at once, so a retry uses this tunnel instead of making another.
    await run('UPDATE app_domains SET config = ? WHERE id = ?', [JSON.stringify({ ...config, tunnelId, tunnelName: name, tunnelOnServer: true }), row.domainId]);
    config = { ...config, tunnelId, tunnelName: name, tunnelOnServer: true };
    await log(`Created tunnel ${tunnelId}.`);
  }

  // The app is published on every interface of the server it runs on, so its
  // address works wherever the tunnel's connector runs — on that server or on
  // another machine that can reach it.
  const target = `http://${server.host}:${row.port}`;

  if (config.tunnelOnServer) {
    await log(`Installing cloudflared on ${server.name} and running the tunnel as a service…`);
    const tunnelToken = await getTunnelToken(token, accountId, tunnelId);
    const unit = await withConnection(connectionFromRow(server), (conn) => runConnector(conn, server, config.tunnelName || tunnelId, tunnelToken));
    await log(`The connector runs as the systemd service ${unit}, starts on boot and restarts if it stops.`);
  } else {
    await log(`Using the existing tunnel ${config.tunnelName || tunnelId}. Its connector must be able to reach ${target}.`);
  }

  const rule = buildHostnameRule({ hostname: row.domain, service: target });
  try {
    await addPublicHostname(token, accountId, tunnelId, rule, zones);
    await log(`Added the public hostname ${row.domain} → ${target}, with its DNS record.`);
  } catch (err) {
    if (!/already on this tunnel/.test(err.message)) throw err;
    // Already there — possibly pointing somewhere older (localhost, another port): point it here.
    await updatePublicHostname(token, accountId, tunnelId, { hostname: row.domain, path: '' }, rule, zones);
    await log(`${row.domain} was already on this tunnel; it now points at ${target}.`);
    // The rule can outlive its DNS record (removed by hand, or with an earlier app); put it back.
    await ensureTunnelCname(token, zones, row.domain, tunnelId);
    await log(`The DNS record ${row.domain} → tunnel is in place.`);
  }
  return `https://${row.domain}`;
}

/** The systemd unit and env file a panel-made tunnel's connector uses on the server. */
function connectorSlug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'tunnel';
}

/* ------------------------------------------------------------- removing */

/**
 * Undo what setupAppDomain did, when the app is removed. Only what the panel
 * made is taken away: a DNS record it did not create, or a tunnel somebody
 * picked from their own list, stays. Never throws — returns what it did and
 * what it could not do.
 */
export async function removeAppDomain(row, server) {
  const done = [];
  const warnings = [];
  if (!row?.domain) return { done, warnings };
  const config = asJson(row.domain_config) || {};

  const cred = await one("SELECT * FROM credentials WHERE id = ? AND provider = 'cloudflare'", [config.credentialId]);
  let token = null;
  let zone = null;
  let zones = [];
  if (cred) {
    try {
      token = decrypt(cred.secret_enc);
      zones = (await authenticateCloudflare(token)).zones;
      zone = zoneFor(zones, row.domain);
    } catch (err) {
      warnings.push(`Could not reach Cloudflare to remove ${row.domain}: ${err.message}`);
    }
  } else {
    warnings.push(`The Cloudflare account for ${row.domain} no longer exists — remove its DNS record by hand.`);
  }

  if (config.mode === 'zerotrust') {
    if (token && zone?.accountId && config.tunnelId && config.tunnelId !== 'new') {
      let left = null;
      try {
        left = await deletePublicHostname(token, zone.accountId, config.tunnelId, row.domain, '', zones);
        done.push(`removed ${row.domain} from the tunnel, with its DNS record`);
      } catch (err) {
        if (/no longer on this tunnel/.test(err.message)) left = null;
        else warnings.push(`Could not remove ${row.domain} from the tunnel: ${err.message}`);
      }

      // A tunnel the panel made for this app goes too, once nothing else is on it.
      if (config.tunnelOnServer && (!left || !left.length)) {
        if (server) {
          const slug = connectorSlug(config.tunnelName || config.tunnelId);
          try {
            const r = await withConnection(connectionFromRow(server), (conn) => rootExec(conn, server, `systemctl disable --now cloudflared-${slug} >/dev/null 2>&1 || true
rm -f /etc/systemd/system/cloudflared-${slug}.service /etc/cloudflared/${slug}.env
systemctl daemon-reload
echo ok`, { timeout: 60000 }));
            if (r.code === 0) done.push(`stopped the tunnel service cloudflared-${slug} on ${server.name}`);
            else warnings.push(`Could not stop cloudflared-${slug} on ${server.name}`);
          } catch (err) {
            warnings.push(`Could not stop cloudflared-${slug} on ${server.name}: ${err.message}`);
          }
        }
        try {
          await deleteTunnel(token, zone.accountId, config.tunnelId, zones);
          done.push(`deleted the tunnel ${config.tunnelName || config.tunnelId}`);
        } catch (err) {
          warnings.push(`Could not delete the tunnel ${config.tunnelName || config.tunnelId}: ${err.message}`);
        }
      }
    }
    return { done, warnings };
  }

  // DNS mode: the nginx site and certificate on the server, then the record.
  if (server) {
    try {
      await withConnection(connectionFromRow(server), async (conn) => {
        const site = validateSiteName(row.domain).value;
        await removeSite(conn, server, site).then(
          () => done.push(`removed the nginx site ${site}`),
          (err) => { if (!/no nginx site/i.test(err.message)) warnings.push(`nginx: ${err.message}`); }
        );
        await deleteCertificate(conn, server, row.domain).then(
          () => done.push(`deleted the certificate for ${row.domain}`),
          () => { /* none issued, or already gone */ }
        );
      });
    } catch (err) {
      warnings.push(`Could not reach ${server.name} to remove the nginx site: ${err.message}`);
    }
  }
  if (token && zone) {
    try {
      const mine = (await recordsNamed(token, zone.id, row.domain)).filter((r) => /^(AJ Pilot|Auto Deploy) app/.test(String(r.comment || '')));
      for (const r of mine) await deleteDnsRecord(token, zone.id, r.id);
      if (mine.length) done.push(`deleted the DNS record ${row.domain}`);
    } catch (err) {
      warnings.push(`Could not delete the DNS record ${row.domain}: ${err.message}`);
    }
  }
  return { done, warnings };
}

/**
 * cloudflared from Cloudflare's own apt repository, and one systemd unit per
 * tunnel so it never collides with a cloudflared someone set up by hand. The
 * token sits in a root-only environment file, not in the unit.
 */
async function runConnector(conn, server, name, tunnelToken) {
  const slug = connectorSlug(name);
  const unit = `cloudflared-${slug}`;
  const script = `set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
if ! command -v cloudflared >/dev/null 2>&1; then
  mkdir -p --mode=0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg || exit 7
  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -qq 2>&1 | tail -n 2
  apt-get install -y cloudflared 2>&1 | tail -n 5
fi
CF="$(command -v cloudflared)" || { echo "cloudflared did not install" >&2; exit 9; }

mkdir -p /etc/cloudflared
( umask 077; printf 'TUNNEL_TOKEN=%s\\n' "$(echo ${b64(tunnelToken)} | base64 -d)" > /etc/cloudflared/${slug}.env )

cat > /etc/systemd/system/${unit}.service <<EOF
[Unit]
Description=Cloudflare Tunnel ${slug} (AJ Pilot)
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/cloudflared/${slug}.env
ExecStart=$CF --no-autoupdate tunnel run
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ${unit} >/dev/null 2>&1
systemctl restart ${unit}
sleep 4
systemctl is-active ${unit} >/dev/null || { journalctl -u ${unit} -n 20 --no-pager >&2; exit 5; }
echo ok`;

  const r = await rootExec(conn, server, script, { timeout: 5 * 60 * 1000 });
  if (r.code !== 0) {
    const detail = `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-12).join('\n');
    if (/sudo:.*(password is required|no tty|incorrect password)/i.test(detail)) {
      throw new Error('Installing cloudflared needs root on this server, but sudo asked for a password the panel does not have.');
    }
    const err = new Error(r.code === 5 ? `The tunnel service ${unit} would not start` : `Installing cloudflared failed (exit ${r.code})`);
    err.cause = detail;
    throw err;
  }
  return unit;
}

/* checking */

/**
 * Does the domain answer, as the world sees it? The name is looked up through
 * public resolvers, never the local network's — asking a home router about a
 * name seconds after it was created makes the router remember "no such
 * domain" for up to half an hour, which is exactly the failure to avoid.
 * Returns { failed, text }: failed only when Cloudflare says it cannot reach
 * the app; a name the world does not know yet is a warning, not a failure.
 */
async function probe(url) {
  const host = new URL(url).hostname;
  const resolver = new dns.Resolver({ timeout: 4000, tries: 2 });
  resolver.setServers(['1.1.1.1', '8.8.8.8']);

  let address = null;
  let family = 4;
  for (let i = 0; i < 12 && !address; i++) {
    const v4 = await resolver.resolve4(host).catch(() => []);
    if (v4.length) { [address] = v4; break; }
    const v6 = await resolver.resolve6(host).catch(() => []);
    if (v6.length) { [address] = v6; family = 6; break; }
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (!address) {
    return { failed: false, text: `Public DNS (1.1.1.1, 8.8.8.8) does not know ${host} yet after a minute — it usually appears within a few minutes.` };
  }

  const status = await new Promise((resolve) => {
    const req = https.request({
      host, servername: host, path: '/', method: 'GET', timeout: 15000,
      lookup: (_h, opts, cb) => (opts?.all ? cb(null, [{ address, family }]) : cb(null, address, family)),
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) => resolve(err.code || err.message));
    req.end();
  });

  const tip = ` If a computer on your own network still cannot open it, that network's DNS remembered "${host} does not exist" from before the record was created: run "ipconfig /flushdns" (Windows) or wait up to 30 minutes.`;
  if (typeof status !== 'number') {
    return { failed: false, text: `${host} resolves to ${address} publicly, but HTTPS did not answer from here (${status}).${tip}` };
  }
  // Cloudflare's own "cannot reach the origin" answers: the tunnel or the server is the problem, not DNS.
  if ([502, 504, 520, 521, 522, 523, 524, 525, 526, 530].includes(status)) {
    return { failed: true, text: `${url} answered HTTP ${status} from Cloudflare — it cannot reach the app. Check that the tunnel's connector is running and can reach the app's address, then retry.` };
  }
  return { failed: false, text: `${url} answers publicly: HTTP ${status} (via ${address}).${tip}` };
}
