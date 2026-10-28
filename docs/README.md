# AJ Pilot — Project Documentation

AJ Pilot is a multi-tenant control panel for Ubuntu servers. It works over SSH, so nothing is installed on the managed servers. It deploys apps from GitHub, GitLab and Bitbucket, runs Docker and databases, puts apps on custom domains with SSL, and charges organisations for plans through Razorpay.

This folder holds the project's business and technical documents. The root [README](../README.md) remains the hands-on user guide (feature walkthroughs, every setting, the full endpoint table).

| # | Document | For | What it answers |
|---|----------|-----|-----------------|
| 1 | [Business Requirements (BRD)](01-business-requirements.md) | Founders, product, sales | Why the product exists, who pays, how it makes money, business rules |
| 2 | [Product Requirements (PRD)](02-product-requirements.md) | Product, engineering, QA | What every module must do, roles, key user journeys |
| 3 | [System Design (HLD)](03-system-design.md) | Engineering | Architecture, components, request pipeline, main flows |
| 4 | [Data Model](04-data-model.md) | Engineering, DBA | Tables, relationships, tenancy and encryption of data |
| 5 | [API Reference](05-api-reference.md) | Engineering, integrators | Every endpoint by module, middleware and permission rules |
| 6 | [Security Design](06-security.md) | Engineering, security review | Threat model and the controls against each threat |
| 7 | [Deployment & Operations](07-deployment-and-operations.md) | DevOps, platform owner | Installing, configuring, running and recovering the panel |
| 8 | [Limitations & Roadmap](08-limitations-and-roadmap.md) | Product, engineering leads | Known constraints, technical debt, recommended next steps |
| 9 | [Database Design](09-database-design.md) | Engineering, DBA | Every column, type, key and index; migrations; JSON shapes; retention |

## At a glance

| | |
|---|---|
| **Runtime** | Node.js ≥ 20, Express 4, ES modules |
| **Front end** | Single-page app in plain JavaScript (`public/`), no build step |
| **Database** | MySQL 8 (the panel's own data) |
| **Server access** | SSH (`ssh2`), optionally relayed through a *connector* on a user's PC |
| **Real-time** | WebSockets (`ws`) for connectors and the browser terminal; Server-Sent Events for live stats |
| **Integrations** | GitHub / GitLab / Bitbucket (OAuth or token), Docker Hub, Cloudflare (DNS, Zero Trust tunnels), Let's Encrypt, Razorpay, SMTP |
| **Size** | ~26k lines of server code, 14 route modules, ~260 API endpoints, 25 tables |

## Keeping these documents current

**Rule: documentation first.** Every new feature or behaviour change updates the docs *before* the code, in the same change. That means three sets: the system docs (this folder), the client docs (the root [README](../README.md)), and the PDF copies in `docs/pdf/`. The full checklist of which change touches which document is in [CLAUDE.md](../CLAUDE.md).

- Facts in these documents were taken from the code. When code and document disagree, the code is right; fix the document in the same pull request.
- Update the **API Reference** when a route is added or removed. Update the **Data Model** and **Database Design** when a `CREATE TABLE` or a migration in `src/db/index.js` changes.
- Diagrams are written in Mermaid, so GitHub and most editors render them with no extra tooling.
