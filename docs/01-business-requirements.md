# Business Requirements Document (BRD)

|                    |                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------ |
| **Product**        | AJ Pilot — "Autopilot for your servers"                                              |
| **Document owner** | Product / platform owner                                                             |
| **Status**         | Living document. It describes the product as built, and marks proposals as proposals |

---

## 1. Executive summary

Small teams that run their own Linux servers spend a lot of time on manual operations. They SSH into each machine, write ad-hoc deploy scripts, set up nginx and SSL certificates by hand, and handle database credentials and `.env` files with little control. Hosted platforms (PaaS) remove that work but cost several times more than a VPS and take away control of the infrastructure.

AJ Pilot gives these teams a PaaS-like experience on their own VPS servers. A web panel connects to any Ubuntu server over SSH, with no agent to install. From there a team can deploy apps from git, auto-deploy on every push or merge, install databases with one click, and publish apps on their own domains with free SSL. Every organisation's data is kept separate from every other's.

The platform owner runs AJ Pilot as a **multi-tenant SaaS**. Organisations sign up, start a free trial, and move to paid monthly or yearly plans paid through Razorpay. The same codebase can also run as a **private, self-hosted panel** with public sign-up turned off.

## 2. Problem statement

| Pain                                                             | Who feels it            | Today's workaround                            |
| ---------------------------------------------------------------- | ----------------------- | --------------------------------------------- |
| Deploying means SSH, `git pull`, rebuild and restart, every time | Developers, freelancers | Shell scripts, manual steps, mistakes         |
| Domains, nginx and SSL are fiddly and easy to break              | Everyone                | Copying config snippets, expired certificates |
| Secrets live in `.env` files passed around by chat               | Teams, agencies         | Shared documents, Slack messages              |
| No view of what is running where across many servers             | Agencies, IT teams      | Spreadsheets, memory                          |
| Giving a client or junior developer safe access is hard          | Agencies, DevOps        | Sharing root passwords                        |
| A PaaS is easy but expensive and locks you in                    | Startups                | Paying the premium, or going back to scripts  |

## 3. Vision and objectives

**Vision:** anyone who can rent a VPS can run production apps on it with the convenience of a hosting platform.

| Objective                                       | How the product meets it                                                      |
| ----------------------------------------------- | ----------------------------------------------------------------------------- |
| O1 — Bare server to live app without a terminal | Add server → install Docker → deploy repo → attach domain (five guided steps) |
| O2 — Hands-off releases                         | Auto deploy on push or on merged pull/merge requests, by webhook or polling   |
| O3 — Safe for teams and clients                 | Organisations, four roles, activity log, encrypted secrets                    |
| O4 — Works where servers actually are           | Direct SSH, or through a _connector_ on a PC that has the VPN                 |
| O5 — A sustainable business                     | Free trial, paid plans with usage limits, online payment, lead pipeline       |

## 4. Target market and personas

| Persona              | Situation                                                 | What they value most                                                              |
| -------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Agency**           | Hosts many clients' apps on its own servers               | One organisation per client, client logins with roles, domains and SSL per client |
| **Startup**          | Wants "push to main and it is live" without PaaS prices   | Auto deploy on merge, staging and production environments, low cost               |
| **Freelancer**       | Builds and hands over client projects                     | Fast deploys, domain and SSL done, invite the client as a viewer                  |
| **IT / DevOps team** | Standardises servers and lets developers serve themselves | Permissions, audit trail, Linux user and SSH key management                       |

**Supported infrastructure:** any Ubuntu server reachable over SSH, from any provider (DigitalOcean, AWS, Hetzner, Linode, Hostinger and others) or on-premises.

## 5. Scope

### 5.1 In scope (built)

1. **Servers:** add over SSH, system profile, live statistics, health monitoring, reboot, browser terminal.
2. **Server administration:** systemd services, cron jobs, Ubuntu users and SSH keys, file manager, nginx sites and SSL, nginx log analysis with blocklist and fail2ban.
3. **Installations:** one-click Docker, Docker Compose, MySQL, PostgreSQL, MongoDB, Redis, EMQX and Elasticsearch (as containers).
4. **App deployment:** Node.js family (Next.js, NestJS, Nuxt, Angular, React/Vite/Vue, static, plain Node) built into Docker images, with one or many containers, volumes, environment variables and an optional Docker Hub push.
5. **Auto deploy:** by webhook (GitHub, GitLab, Bitbucket) or polling, triggered on every commit or only on merges.
6. **Domains:** Cloudflare DNS + nginx + Let's Encrypt, or a Cloudflare Zero Trust tunnel for servers with no open ports.
7. **Databases:** browse and manage MySQL, PostgreSQL, MongoDB, Redis and Elasticsearch (databases or indices, users, grants, settings, read-only queries).
8. **Integrations:** git accounts (OAuth or token), Docker Hub, Cloudflare, CI runners (GitHub/GitLab).
9. **Environments:** named, encrypted variable sets reused across apps and services.
10. **Organisations and people:** multi-tenancy, four roles, team management, activity log.
11. **Commercial:** public landing page, self sign-up with OTP and email verification, plans, free trial, Razorpay checkout, payment history, super-admin console (organisations, plans, payments, leads CRM).

### 5.2 Out of scope (currently)

- Operating systems other than Ubuntu/Debian-family Linux on managed servers.
- Runtimes other than Node.js for the build-and-deploy pipeline. A repository can still bring its own `Dockerfile`.
- Automatic recurring billing. A paid plan is bought one cycle at a time; see §7.
- Invoicing and tax documents (GST invoices).
- Real SMS delivery for one-time codes. A provider hook exists, but no provider is integrated yet.

## 6. Business model

### 6.1 Revenue

- **Subscriptions per organisation**, billed **monthly or yearly**. The currency is set per plan (INR by default).
- Plans are **created and priced by the super admin** in the platform console. Prices, limits, features, the "most popular" flag, visibility and order are data, not code.
- Plans are differentiated by **usage limits**:

  | Limit key   | Counts                                                                  |
  | ----------- | ----------------------------------------------------------------------- |
  | `servers`   | servers in the organisation                                             |
  | `apps`      | deployed apps                                                           |
  | `users`     | team members                                                            |
  | `databases` | database connections (MySQL, PostgreSQL, MongoDB, Redis, Elasticsearch) |
  | `domains`   | app domains                                                             |

  A missing limit means unlimited. A request that would go over a limit is refused with a clear message (HTTP 403 with `limitReached`).

### 6.2 Free trial

- A free plan (price 0) acts as a trial that lasts `FREE_TRIAL_DAYS` (default **30**). Each organisation can use it **once**.
- When the trial ends the panel is **locked, not deleted**. The user can only reach Plan & Billing until they choose a paid plan.
- The trial's progress is visible throughout: a header pill, a banner that changes to a warning tone when 5 or fewer days are left, and a progress bar on the billing page.

### 6.3 Payment

- **Online (Razorpay configured):** choosing a paid plan opens Razorpay Checkout immediately (card, UPI, netbanking, wallet). The plan **activates automatically once the server has verified the payment**, and a success confirmation is shown.
- **Offline (no Razorpay keys):** a paid plan becomes a _request_. The super admin records the payment by hand and switches the plan on.
- A paid plan chosen at sign-up opens Razorpay on the user's first sign-in.
- Every organisation sees its **payment history**: online payments, payments recorded by hand, and failed or abandoned attempts.

### 6.4 Sales pipeline (leads)

- The public "Get started" form creates a **lead**. It records UTM source, referrer, device and approximate location.
- The super admin works leads through `new → contacted → qualified → proposal → won / lost`, adds notes and an expected value, and **converts a won lead into a client organisation** with its first admin and plan.

## 7. Business rules

| ID    | Rule                                                                                                                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BR-01 | Everything an organisation owns (servers, credentials, apps, environments, connectors, payments) is visible only to that organisation, and to the super admin.                              |
| BR-02 | A client organisation must have an active (or trial / past-due) subscription before anything it owns can be used. Billing stays reachable without one.                                      |
| BR-03 | The free plan can be used once per organisation and lasts `FREE_TRIAL_DAYS`.                                                                                                                |
| BR-04 | An ended plan locks the panel; no data is deleted.                                                                                                                                          |
| BR-05 | A paid plan activates only after the payment has been verified **with Razorpay on the server** (signature, captured status, exact amount and currency). The browser's word is never enough. |
| BR-06 | A payment is applied **exactly once**, even if checkout, webhook and reconciliation all report it.                                                                                          |
| BR-07 | A payment whose confirmation was lost (tab closed, popup blocked) is recovered automatically, by webhook or by reconciliation within a minute of the next billing page visit.               |
| BR-08 | Only an organisation admin (permission `members`) can choose or pay for a plan.                                                                                                             |
| BR-09 | Creating a resource over a plan limit is refused; existing resources keep working.                                                                                                          |
| BR-10 | Only the super admin manages plans, organisations, other admins, recorded payments and leads.                                                                                               |
| BR-11 | Self sign-up requires a verified mobile OTP, a verified email link, and acceptance of the current Terms version.                                                                            |
| BR-12 | `ALLOW_SIGNUP=false` turns the product into a private panel where accounts are created only by admins.                                                                                      |

## 8. Success metrics (proposed)

The platform console already shows payments collected, this month's revenue and lead counts. The KPIs below are recommendations; they are **not yet measured by the product**.

| Area           | KPI                                                                         |
| -------------- | --------------------------------------------------------------------------- |
| Acquisition    | Leads per month by source; sign-ups per month                               |
| Activation     | % of new organisations that deploy their first app within 7 days of sign-up |
| Conversion     | Trial → paid conversion rate; lead → won rate                               |
| Revenue        | MRR / ARR, ARPA (average revenue per organisation), yearly vs monthly mix   |
| Retention      | Monthly logo churn; renewals after a plan expires                           |
| Product health | Deploy success rate; median deploy duration; servers offline per day        |

## 9. Stakeholders

| Role                                | Interest                                                     |
| ----------------------------------- | ------------------------------------------------------------ |
| Platform owner (super admin)        | Revenue, plans, clients, leads, platform health              |
| Organisation admin                  | Their team, their plan and payments, their infrastructure    |
| Editor / developer                  | Deploying and operating apps and servers                     |
| Viewer (often a client)             | Seeing status and logs without being able to change anything |
| Razorpay, Cloudflare, git providers | External services the product depends on                     |

## 10. Assumptions and constraints

- Customers already have, or can rent, Ubuntu servers, and can supply SSH credentials with root or sudo.
- The panel's own MySQL database and its **encryption key** are the business-critical assets. Losing the key makes every stored credential unreadable (see [Operations](07-deployment-and-operations.md)).
- Razorpay is the only online payment gateway, which suits an India-first market.
- The panel runs as a **single Node.js process** (see [Limitations](08-limitations-and-roadmap.md)).

## 11. Business risks

| Risk                                                                 | Impact                           | Mitigation                                                                                                                     |
| -------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| A security incident: the panel holds root access to customer servers | Severe: reputation and liability | Encryption at rest, strict tenancy, role checks on the server, origin checks, host-key pinning; see [Security](06-security.md) |
| Loss of the encryption key or database                               | All customer credentials lost    | Back up the key separately from the database; restore drills                                                                   |
| A payment taken but the plan not activated                           | Support load, refunds            | Server-side verification, webhook, automatic reconciliation                                                                    |
| Fixed OTP left on in production                                      | Account takeover                 | Set `OTP_MODE=random` and connect an SMS provider before launch                                                                |
| Dependence on a single gateway or region                             | Lost sales outside India         | Add a second gateway when expanding (roadmap)                                                                                  |
