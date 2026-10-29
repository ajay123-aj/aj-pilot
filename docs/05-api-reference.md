# API Reference

All endpoints are JSON over HTTPS under `/api`, called by the panel's own UI with the session cookie. There is no public API key scheme. Third parties integrate only through webhooks.

> **Generated from the route files.** The tables below were produced from `src/routes/*.js`, and the *Permission* column from the rules in `src/lib/authGuard.js`. When a route is added, regenerate or update this file in the same change.

## 1. Conventions

| Topic | Rule |
|-------|------|
| Authentication | HttpOnly cookie `ad_session`, set by `/api/auth/login/verify`. Missing or expired → `401 { needsAuth: true }` |
| CSRF | Every non-GET `/api` request must be same-origin (`Sec-Fetch-Site` / `Origin` / `Referer` checked) → else `403` |
| Tenancy | Every organisation-scoped route acts on the requester's organisation only. Another organisation's id → `404` |
| Plan gate | Organisation routes (servers, apps, installs, runners, credentials, environments, connectors, git OAuth) need an active plan → else `402 { needsPlan: true, trialExpired? }` |
| Plan limits | Creating servers, apps, members, database connections or domains beyond the plan's limit → `403 { limitReached: true, limit }` (the UI shows the message instead of jumping to billing) |
| Errors | `{ error: "sentence" }` with 400 / 401 / 402 / 403 / 404 / 429 / 502 |
| Long work | Deploys and installs return immediately; poll the resource's status |

### Permission column

The permission comes from the HTTP method, applied by `guardMutations` to every signed-in route:

| Method | Needs |
|--------|-------|
| `GET` | `view` |
| `POST` | `create`, **except** read-only POSTs (testing, verifying, browsing) on an explicit allowlist, which need only `view` |
| `PUT` / `PATCH` | `edit` |
| `DELETE` | `delete` |

Some routes check more inside the handler, for example:
- `/api/team/*` and choosing or paying for a plan need `members`.
- Environment and app variable *values* need `edit`.
- `/api/platform/*` is super admin only.

## 2. Endpoints outside the routers

| Method | Path | Access | Purpose |
|--------|------|--------|---------|
| `GET` | `/api/health` | public | Panel status (database reachable, counts for the signed-in organisation) |
| `GET` | `/api/public/plans` | public | Plans for the pricing section |
| `POST` | `/api/public/leads` | public, rate-limited | Landing page "Get started" form |
| `GET` | `/api/public/docs` | public | The guide list |
| `GET` | `/api/activity` | view | Last 50 activity log entries for the organisation |
| `POST` | `/api/hooks/apps/:token` | webhook token | Git push / merge webhook → auto deploy |
| `POST` | `/api/hooks/razorpay` | HMAC signature | Razorpay payment events |
| `GET` (WS) | `/api/connectors/ws` | connector token | Connector relay channel |
| `GET` (WS) | `/api/terminal/ws?server=:id` | session + same origin + `edit` + plan | Browser terminal |
| `GET` | `/vendor/xterm/*`, `/vendor/addon-fit/*` | public | Terminal UI library files |

### WebSocket message formats

**Terminal** (`/api/terminal/ws`)

| Direction | Frame |
|-----------|-------|
| browser → panel | `{"t":"in","d":"<keystrokes>"}`, `{"t":"resize","cols":120,"rows":32}` |
| panel → browser | binary frames = terminal output; `{"t":"ready"}`, `{"t":"error","message"}`, `{"t":"exit","code"}` |
| close codes | `4000 + HTTP status` when refused (e.g. `4401` not signed in, `4403` cross-site or no permission, `4402` no plan, `4429` too many terminals) |

## 3. Endpoints by module

### Sign-in, sign-up, OTP, profile — `/api/auth` (12)

Source: [src/routes/auth.js](../src/routes/auth.js)

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET` | `/api/auth/state` | public | What the browser needs before it can draw anything |
| `POST` | `/api/auth/setup` | public | First run only |
| `POST` | `/api/auth/signup` | public | Anyone can create their own organisation, in three steps |
| `POST` | `/api/auth/signup/verify` | public | Step 2 |
| `POST` | `/api/auth/otp/resend` | public | A new code for a sign-up or sign-in that is waiting on one |
| `POST` | `/api/auth/login` | public | Sign in with an email or a mobile number and the password, then a one-time code |
| `POST` | `/api/auth/login/verify` | public | Step 2 of signing in |
| `POST` | `/api/auth/verify-email/resend` | public | Send the verification link again |
| `POST` | `/api/auth/logout` | signed in |  |
| `PUT` | `/api/auth/profile` | signed in | Change your own name, mobile number or the email you sign in with |
| `POST` | `/api/auth/password` | signed in | Change your own password |
| `POST` | `/api/auth/organisation` | signed in | A super admin opens a client organisation to work inside it, or (org_id empty) goes back to the platform |

### The organisation's plan and payments — `/api/billing` (7)

Source: [src/routes/billing.js](../src/routes/billing.js)

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET` | `/api/billing` | view |  |
| `POST` | `/api/billing/choose` | create | Pick a plan |
| `POST` | `/api/billing/checkout` | create | Open a Razorpay order for a paid plan; the browser opens Checkout on it |
| `POST` | `/api/billing/checkout/verify` | create | Checkout finished |
| `POST` | `/api/billing/checkout/recheck` | create | Checkout closed without a confirmed answer |
| `POST` | `/api/billing/checkout/failed` | create | Checkout reported a failed or abandoned payment |
| `DELETE` | `/api/billing/request` | delete | Withdraw a request that has not been switched on yet |

### Members and organisations — `/api/team` (8)

Source: [src/routes/team.js](../src/routes/team.js)

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET` | `/api/team/members` | view | Everyone in the organisation you are working in |
| `POST` | `/api/team/members` | create | Add someone to this organisation with a role |
| `PUT` | `/api/team/members/:id` | edit | Change someone's name, role, status or password |
| `DELETE` | `/api/team/members/:id` | delete |  |
| `GET` | `/api/team/organisations` | view | A super admin sees every organisation; everyone else sees only their own |
| `POST` | `/api/team/organisations` | create |  |
| `PUT` | `/api/team/organisations/:id` | edit |  |
| `DELETE` | `/api/team/organisations/:id` | delete | Deleting an organisation takes its servers, credentials and people with it, so it is refused while anything is still in there |

### Platform console — `/api/platform` (24)

Source: [src/routes/platform.js](../src/routes/platform.js)

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET` | `/api/platform/docs` | super admin | Every guide, including the ones only super admins see |
| `GET` | `/api/platform/plans` | super admin |  |
| `POST` | `/api/platform/plans` | super admin |  |
| `PUT` | `/api/platform/plans/:id` | super admin |  |
| `DELETE` | `/api/platform/plans/:id` | super admin | A plan someone is on is archived (hidden, kept); one nobody ever used is deleted |
| `GET` | `/api/platform/organisations` | super admin |  |
| `POST` | `/api/platform/organisations` | super admin | A new organisation, optionally with its first admin and a plan |
| `PUT` | `/api/platform/organisations/:id` | super admin |  |
| `PUT` | `/api/platform/organisations/:id/subscription` | super admin |  |
| `PUT` | `/api/platform/organisations/:id/subscription/expiry` | super admin | End any plan — free or paid — on a date, or now |
| `POST` | `/api/platform/organisations/:id/subscription/activate` | super admin | Switch on the plan an organisation asked for |
| `DELETE` | `/api/platform/organisations/:id/subscription/request` | super admin | Turn down a plan request; whatever the organisation is on stays as it is |
| `GET` | `/api/platform/organisations/:id` | super admin | One organisation in full |
| `POST` | `/api/platform/organisations/:id/users` | super admin | A new person in a client organisation |
| `GET` | `/api/platform/admins` | super admin |  |
| `POST` | `/api/platform/admins` | super admin |  |
| `PUT` | `/api/platform/admins/:id` | super admin |  |
| `DELETE` | `/api/platform/admins/:id` | super admin |  |
| `GET` | `/api/platform/payments` | super admin |  |
| `POST` | `/api/platform/organisations/:id/payments` | super admin |  |
| `DELETE` | `/api/platform/payments/:id` | super admin |  |
| `GET` | `/api/platform/users` | super admin |  |
| `PUT` | `/api/platform/users/:id/organisation` | super admin | Move someone to another organisation (roles, status and passwords go through /api/team) |
| `GET` | `/api/platform/dashboard` | super admin |  |

### Leads CRM — `/api/platform/leads` (11)

Source: [src/routes/leads.js](../src/routes/leads.js)

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET` | `/api/platform/leads` | super admin |  |
| `POST` | `/api/platform/leads` | super admin | A lead typed in by hand — a phone call, a referral |
| `GET` | `/api/platform/leads/analytics` | super admin |  |
| `GET` | `/api/platform/leads/summary` | super admin | How many leads are waiting — for the badge in the side menu |
| `GET` | `/api/platform/leads/:id` | super admin |  |
| `PUT` | `/api/platform/leads/:id` | super admin | Move a lead along, hand it to someone, or correct its details |
| `POST` | `/api/platform/leads/:id/locate` | super admin | Look the lead's IP address up again (or for the first time, for leads from before locations were kept) |
| `POST` | `/api/platform/leads/:id/notes` | super admin |  |
| `DELETE` | `/api/platform/leads/:id/notes/:noteId` | super admin |  |
| `POST` | `/api/platform/leads/:id/convert` | super admin | Turn a lead into a client |
| `DELETE` | `/api/platform/leads/:id` | super admin |  |

### Servers and everything on them — `/api/servers` (76)

Source: [src/routes/servers.js](../src/routes/servers.js)

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET` | `/api/servers` | view |  |
| `GET` | `/api/servers/status` | view | Just the statuses, for the list to poll |
| `POST` | `/api/servers/test` | create |  |
| `POST` | `/api/servers` | create |  |
| `GET` | `/api/servers/:id` | view |  |
| `GET` | `/api/servers/:id/history` | view | Every profile ever collected for this server, newest first |
| `GET` | `/api/servers/:id/metrics` | view | CPU, memory, disk and load over `?range=daily|weekly|monthly`, from the recorded samples; `?tz=` is the browser's `getTimezoneOffset()` |
| `PUT` | `/api/servers/:id` | edit |  |
| `DELETE` | `/api/servers/:id` | delete |  |
| `GET` | `/api/servers/:id/secrets` | view | The stored password, passphrase and sudo password, for the Show button of the edit form |
| `POST` | `/api/servers/:id/host-key/reset` | create | Forget the remembered SSH host key, after the server was rebuilt or reinstalled |
| `POST` | `/api/servers/:id/test` | view |  |
| `POST` | `/api/servers/:id/facts` | view |  |
| `GET` | `/api/servers/:id/facts` | view |  |
| `GET` | `/api/servers/:id/services` | view | Every systemd service on the host, live |
| `GET` | `/api/servers/:id/services/:unit` | view | One unit in full, with its recent journal |
| `POST` | `/api/servers/:id/services/:unit/action` | create | start / stop / restart / reload / enable / disable a unit |
| `POST` | `/api/servers/:id/services` | create | Create a new systemd service from the add-service form |
| `DELETE` | `/api/servers/:id/services/:unit` | delete | Remove a unit this panel wrote |
| `GET` | `/api/servers/:id/docker` | view | Is Docker there, its networks, and everything running on it |
| `POST` | `/api/servers/:id/docker/networks` | create | A user-defined network, so installed services can reach each other by name |
| `POST` | `/api/servers/:id/docker/login` | create | Sign this server in to a container registry, so it can pull private images |
| `POST` | `/api/servers/:id/docker/logout` | create |  |
| `DELETE` | `/api/servers/:id/docker/volumes/:name` | delete | Remove a named volume — with the data in it |
| `DELETE` | `/api/servers/:id/docker/networks/:name` | delete |  |
| `GET` | `/api/servers/:id/summary` | view | What is on this server, counted — one SSH pass for the Overview tab |
| `GET` | `/api/servers/:id/cron` | view | Everything scheduled on this server, wherever it is written down |
| `POST` | `/api/servers/:id/cron/install` | create |  |
| `POST` | `/api/servers/:id/cron/jobs` | create | Add a job to a user's crontab |
| `PUT` | `/api/servers/:id/cron/jobs` | edit | Change one job |
| `POST` | `/api/servers/:id/reboot` | create | Restart the machine |
| `GET` | `/api/servers/:id/users` | view |  |
| `POST` | `/api/servers/:id/users` | create |  |
| `PUT` | `/api/servers/:id/users/:name` | edit |  |
| `POST` | `/api/servers/:id/users/:name/keys` | create | Add public keys, or have the server make a new pair and hand back the private half once |
| `DELETE` | `/api/servers/:id/users/:name/keys` | delete |  |
| `DELETE` | `/api/servers/:id/users/:name` | delete |  |
| `DELETE` | `/api/servers/:id/cron/jobs` | delete |  |
| `GET` | `/api/servers/:id/runners` | view | The CI runners on this server, as the machine itself reports them |
| `GET` | `/api/servers/:id/stats` | view | One sample, for anything that wants a number rather than a stream |
| `GET` | `/api/servers/:id/stats/stream` | view | SSE: `sample`, `problem`, `end` events every `?every=` ms (2000–60000, default 5000) |
| `POST` | `/api/servers/:id/containers/:name/action` | create | start / stop / restart a container, whoever put it there |
| `GET` | `/api/servers/:id/containers/:name` | view | Everything about one container |
| `DELETE` | `/api/servers/:id/containers/:name` | delete | Remove a container that is not one of the panel's own |
| `GET` | `/api/servers/:id/containers/:name/logs` | view |  |
| `GET` | `/api/servers/:id/nginx` | view | nginx, its sites and its certificates — everything the tab draws |
| `POST` | `/api/servers/:id/nginx/install` | create |  |
| `POST` | `/api/servers/:id/nginx/action` | create | reload / restart / start / stop / test |
| `POST` | `/api/servers/:id/nginx/upstreams` | create | Add an upstream |
| `PUT` | `/api/servers/:id/nginx/upstreams/:name` | edit | Change an upstream — its servers, ports, weights and balancing — where it is |
| `DELETE` | `/api/servers/:id/nginx/upstreams/:name` | delete |  |
| `POST` | `/api/servers/:id/nginx/sites` | create | Add a domain |
| `GET` | `/api/servers/:id/nginx/sites/:name` | view | The file as it stands, for the edit box |
| `PUT` | `/api/servers/:id/nginx/sites/:name` | edit | Edit a domain — the whole file, or the form's fields again |
| `DELETE` | `/api/servers/:id/nginx/sites/:name` | delete | Remove a domain |
| `POST` | `/api/servers/:id/nginx/ssl` | create | Ask Let's Encrypt for a certificate and let certbot put it into the vhost |
| `POST` | `/api/servers/:id/nginx/ssl/renew` | create | Renew everything due, or one certificate |
| `GET` | `/api/servers/:id/nginx/logs` | view | The access and error logs, analysed — with findings and fixes |
| `POST` | `/api/servers/:id/nginx/logs/analyzer` | create | Add the analyzer's log format (and an empty blocklist) to nginx |
| `DELETE` | `/api/servers/:id/nginx/logs/analyzer` | delete |  |
| `POST` | `/api/servers/:id/nginx/logs/blocklist` | create |  |
| `DELETE` | `/api/servers/:id/nginx/logs/blocklist` | delete |  |
| `POST` | `/api/servers/:id/nginx/logs/fail2ban` | create | fail2ban with its nginx jails, so repeat offenders are banned without anyone watching |
| `POST` | `/api/servers/:id/exec` | create |  |
| `GET` | `/api/servers/:id/files` | view |  |
| `GET` | `/api/servers/:id/files/content` | view |  |
| `GET` | `/api/servers/:id/files/download` | view |  |
| `PUT` | `/api/servers/:id/files/content` | edit |  |
| `POST` | `/api/servers/:id/files/folder` | create |  |
| `POST` | `/api/servers/:id/files/file` | create |  |
| `POST` | `/api/servers/:id/files/upload` | create |  |
| `PUT` | `/api/servers/:id/files/move` | edit |  |
| `POST` | `/api/servers/:id/files/copy` | create |  |
| `PUT` | `/api/servers/:id/files/permissions` | edit |  |
| `POST` | `/api/servers/:id/files/extract` | create |  |
| `DELETE` | `/api/servers/:id/files` | delete |  |

### Deployed apps, auto deploy, domains, usage — `/api/apps` (27)

Source: [src/routes/apps.js](../src/routes/apps.js)

| Method | Path | Permission | Notes |
|---|---|---|---|
| `POST` | `/api/apps/folders` | create | The folders in a branch that hold a project of their own, for a repository with several apps in it |
| `POST` | `/api/apps/inspect` | create | Is this repository (or this folder of it) something the panel can deploy, and with what settings? |
| `POST` | `/api/apps/ports` | create | Body `{ server_id, ports[], app_id? }` → `{ busy: [{ port, by }], checked }`. Host ports already published by another app on that server, or listening there (`ss -ltnH` over SSH). `app_id` leaves that app's own ports out. `checked: false` when the server could not be reached (only the panel's own apps were compared) |
| `GET` | `/api/apps` | view | Each app carries `health` — its latest recorded level (`ok` / `warning` / `critical`), or null |
| `GET` | `/api/apps/stats` | view | What every app uses right now — `{ apps: { [id]: usage | { error } } }`; one SSH session per server; `?server_id=` narrows it |
| `GET` | `/api/apps/:id` | view |  |
| `GET` | `/api/apps/:id/metrics` | view | CPU and memory (as a share of the server) over `?range=daily|weekly|monthly` |
| `GET` | `/api/apps/:id/stats/stream` | view | SSE: one app's containers every `?every=` ms — `sample` = `{ at, host, containers[], usage }`; at most `APP_STATS_STREAMS_PER_ORG` open per organisation (else `429`) |
| `POST` | `/api/apps` | create | `409` when a chosen host port is already used on the server (same check as `/api/apps/ports`) |
| `GET` | `/api/apps/:id/auto-deploy` | view | The settings, with the webhook address — secret, so only for people who can edit |
| `PUT` | `/api/apps/:id/auto-deploy` | edit | Turn auto deploy on or off, choose "every push" or "merged requests only", and (re)add the webhook |
| `POST` | `/api/apps/:id/auto-deploy/check` | create | "Check now" |
| `GET` | `/api/apps/:id/deployments` | view |  |
| `GET` | `/api/apps/:id/deployments/:did` | view | One deploy with its full log — the running one reads the live log |
| `PUT` | `/api/apps/:id/settings` | edit |  |
| `POST` | `/api/apps/:id/deploy` | create | Build and run the current branch again — the same path as the first deploy |
| `POST` | `/api/apps/:id/deploy/stop` | create | Stop a deploy that is running — a manual one or an auto deploy |
| `POST` | `/api/apps/:id/deploy/restart` | create | Stop the running deploy and start a fresh one from the branch as it is now |
| `POST` | `/api/apps/:id/domains` | create | Add another domain to an app |
| `POST` | `/api/apps/:id/domains/:domainId/retry` | create | Run one domain's setup again |
| `DELETE` | `/api/apps/:id/domains/:domainId` | delete | Take one domain off an app |
| `GET` | `/api/apps/:id/env` | view | The variables as they are, so they can be edited rather than retyped |
| `PUT` | `/api/apps/:id/env` | edit | Replace the environment of a service that is already running |
| `PUT` | `/api/apps/:id/containers` | edit | Add or remove containers, and give each one the port it publishes on. `409` when a new port is already used on the server |
| `POST` | `/api/apps/:id/action` | create |  |
| `GET` | `/api/apps/:id/logs` | view |  |
| `DELETE` | `/api/apps/:id` | delete | Removing takes a while — stopping containers, deleting the image, Cloudflare, nginx and the certificate for every domain — longer than a pro |

### Catalog installations — `/api/installs` (10)

Source: [src/routes/installs.js](../src/routes/installs.js)

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET` | `/api/installs/catalog` | view | What can be installed, and the form each one needs; each entry carries `requires` — the services that must be on the server first |
| `GET` | `/api/installs/requirements` | view | `?server_id=&kind=` → `{ missing: [{ key, label, problem }] }` — the services `kind` needs (catalog `requires`: `docker`, `nginx`) that the server lacks, checked over SSH. `POST /api/installs` refuses the same cases |
| `GET` | `/api/installs` | view |  |
| `GET` | `/api/installs/:id` | view |  |
| `POST` | `/api/installs` | create |  |
| `POST` | `/api/installs/:id/refresh` | view | What Docker says about this container right now |
| `POST` | `/api/installs/:id/action` | create |  |
| `GET` | `/api/installs/:id/logs` | view |  |
| `PUT` | `/api/installs/:id/port` | edit | Change the published port |
| `DELETE` | `/api/installs/:id` | delete | Remove the container |

### CI runners — `/api/runners` (6)

Source: [src/routes/runners.js](../src/routes/runners.js)

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET` | `/api/runners` | view | Every runner, or only those for one git account (`credential_id`) or server (`server_id`) |
| `GET` | `/api/runners/:id` | view |  |
| `POST` | `/api/runners` | create |  |
| `POST` | `/api/runners/:id/refresh` | view | Ask the provider what it thinks of this runner right now |
| `POST` | `/api/runners/:id/action` | create | Start, stop or restart the runner's systemd service on its server |
| `DELETE` | `/api/runners/:id` | delete | Unregister the runner with the provider, take it off the server, and forget it here |

### Git, Docker Hub, Cloudflare, MySQL accounts — `/api/credentials` (45)

Source: [src/routes/credentials.js](../src/routes/credentials.js)

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET` | `/api/credentials` | view |  |
| `GET` | `/api/credentials/:id` | view |  |
| `POST` | `/api/credentials` | create |  |
| `PUT` | `/api/credentials/:id` | edit |  |
| `DELETE` | `/api/credentials/:id` | delete |  |
| `POST` | `/api/credentials/:id/verify` | view |  |
| `POST` | `/api/credentials/test-mysql` | view | Test MySQL details before saving them |
| `POST` | `/api/credentials/test-git` | view | Authenticate a git token before saving it |
| `POST` | `/api/credentials/:id/git/account` | view | Re-authenticate and refresh the stored account details |
| `POST` | `/api/credentials/:id/git/repositories` | view | Repositories this account can reach |
| `POST` | `/api/credentials/:id/git/branches` | view | Branches of one repository — `full` is "owner/repo" |
| `POST` | `/api/credentials/:id/git/commits` | view | Recent commits on a branch |
| `POST` | `/api/credentials/:id/git/organizations` | view | Organisations (GitHub) or groups (GitLab) a runner can be registered in |
| `POST` | `/api/credentials/:id/git/runners` | view | Runners the provider itself knows about for one repository, organisation or group — including ones this panel never installed |
| `GET` | `/api/credentials/dockerhub/token-link` | view | Where the browser flow sends the person to create a token |
| `POST` | `/api/credentials/dockerhub/connect` | create | Finish the browser flow |
| `POST` | `/api/credentials/:id/dockerhub/repositories` | view | Repositories in the account's own namespace, or one of its organisations |
| `POST` | `/api/credentials/:id/dockerhub/repositories/:ns/:repo` | view | One repository with every tag |
| `DELETE` | `/api/credentials/:id/dockerhub/repositories/:ns/:repo/tags/:tag` | delete |  |
| `GET` | `/api/credentials/cloudflare/token-link` | view | The dashboard link that opens a pre-filled "Create API token" form |
| `POST` | `/api/credentials/test-cloudflare` | view | Verify a token and show what it can see, without saving it |
| `POST` | `/api/credentials/cloudflare/connect` | create | Finish the browser flow |
| `POST` | `/api/credentials/:id/cloudflare/account` | view | Re-read the account, its accounts and zones |
| `POST` | `/api/credentials/:id/cloudflare/zones/:zoneId` | view | One zone in full |
| `DELETE` | `/api/credentials/:id/cloudflare/zones/:zoneId` | delete | Remove a domain from Cloudflare |
| `POST` | `/api/credentials/:id/cloudflare/zones/:zoneId/dns/records` | create | Add a DNS record |
| `PUT` | `/api/credentials/:id/cloudflare/zones/:zoneId/dns/records/:recordId` | edit | Change a DNS record |
| `DELETE` | `/api/credentials/:id/cloudflare/zones/:zoneId/dns/records/:recordId` | delete | Delete a DNS record |
| `POST` | `/api/credentials/:id/cloudflare/zones/:zoneId/dns` | view | DNS records of one zone this token can see |
| `POST` | `/api/credentials/:id/mysql/overview` | view |  |
| `POST` | `/api/credentials/:id/mysql/databases/:database` | view |  |
| `POST` | `/api/credentials/:id/mysql/databases/:database/tables/:table` | view |  |
| `POST` | `/api/credentials/:id/mysql/query` | view |  |
| `POST` | `/api/credentials/:id/mysql/charsets` | view |  |
| `POST` | `/api/credentials/:id/mysql/schemas` | create | Creating goes to /schemas so it never matches the read-only /databases/:db pattern.
 |
| `PUT` | `/api/credentials/:id/mysql/databases/:database` | edit |  |
| `DELETE` | `/api/credentials/:id/mysql/databases/:database` | delete |  |
| `POST` | `/api/credentials/:id/mysql/users/list` | view |  |
| `POST` | `/api/credentials/:id/mysql/users` | create |  |
| `PUT` | `/api/credentials/:id/mysql/users` | edit |  |
| `DELETE` | `/api/credentials/:id/mysql/users` | delete |  |
| `POST` | `/api/credentials/:id/mysql/users/grants` | create |  |
| `DELETE` | `/api/credentials/:id/mysql/users/grants` | delete |  |
| `POST` | `/api/credentials/:id/mysql/variables` | view |  |
| `PUT` | `/api/credentials/:id/mysql/variables` | edit |  |

### PostgreSQL, MongoDB, Redis, Elasticsearch — `/api/credentials` (22)

Source: [src/routes/dbEngines.js](../src/routes/dbEngines.js). The engine is picked from the credential's `provider`. For Elasticsearch, "database" in these paths means an **index**, `item` is a field of that index, `users` are security users, `grants` are roles, and `config` is persistent cluster settings. `POST …/db/query` takes Dev Tools syntax, for example `GET /_cat/indices` or `POST /orders/_search` followed by a JSON body. Only `GET` and search-type `POST` (`_search`, `_count`, `_msearch`, `_field_caps`, `_validate/query`, `_sql`) are allowed.

| Method | Path | Permission | Notes |
|---|---|---|---|
| `POST` | `/api/credentials/test-db` | view | Try the details on the add-connection form before saving them |
| `POST` | `/api/credentials/:id/db/overview` | view |  |
| `POST` | `/api/credentials/:id/db/databases` | view |  |
| `POST` | `/api/credentials/:id/db/database` | view |  |
| `POST` | `/api/credentials/:id/db/item` | view |  |
| `POST` | `/api/credentials/:id/db/users/list` | view |  |
| `POST` | `/api/credentials/:id/db/config` | view |  |
| `POST` | `/api/credentials/:id/db/query` | view |  |
| `POST` | `/api/credentials/:id/db/schemas` | create |  |
| `DELETE` | `/api/credentials/:id/db/databases` | delete |  |
| `POST` | `/api/credentials/:id/db/users` | create |  |
| `PUT` | `/api/credentials/:id/db/users` | edit |  |
| `DELETE` | `/api/credentials/:id/db/users` | delete |  |
| `POST` | `/api/credentials/:id/db/users/grants` | create |  |
| `DELETE` | `/api/credentials/:id/db/users/grants` | delete |  |
| `PUT` | `/api/credentials/:id/db/config` | edit |  |
| `POST` | `/api/credentials/:id/redis/scan` | view |  |
| `POST` | `/api/credentials/:id/redis/key` | view |  |
| `POST` | `/api/credentials/:id/redis/keys` | create |  |
| `PUT` | `/api/credentials/:id/redis/key` | edit |  |
| `DELETE` | `/api/credentials/:id/redis/keys` | delete |  |
| `GET` | `/api/credentials/pulse` | view |  |

### Named variable sets — `/api/environments` (6)

Source: [src/routes/environments.js](../src/routes/environments.js)

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET` | `/api/environments` | view |  |
| `GET` | `/api/environments/:id` | view |  |
| `POST` | `/api/environments` | create |  |
| `POST` | `/api/environments/:id/duplicate` | create | A copy under a new name — a staging set made from production, say |
| `PUT` | `/api/environments/:id` | edit | Change the name, description or variables |
| `DELETE` | `/api/environments/:id` | delete | Apps and services made from it keep their own copy of the variables; only the link goes |

### PC relays — `/api/connectors` (5)

Source: [src/routes/connectors.js](../src/routes/connectors.js)

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET` | `/api/connectors` | view |  |
| `POST` | `/api/connectors` | create | A new connector |
| `POST` | `/api/connectors/:id/token` | create | A new token |
| `PUT` | `/api/connectors/:id` | edit |  |
| `DELETE` | `/api/connectors/:id` | delete |  |

### Git OAuth sign-in — `/api/git/oauth` (3)

Source: [src/routes/gitOauth.js](../src/routes/gitOauth.js)

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET` | `/api/git/oauth/providers` | view | Which providers can be used for browser sign-in, and the callback to register |
| `GET` | `/api/git/oauth/start` | view | Step 1 — send the browser to the provider |
| `GET` | `/api/git/oauth/callback` | view | Step 2 — the provider sends the browser back here with a code |

