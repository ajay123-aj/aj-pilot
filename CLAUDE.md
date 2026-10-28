# AJ Pilot — rules for working in this repository

## Documentation first (mandatory)

Any new feature, or any change to an existing feature's behaviour, starts by updating the documentation. Do this **before** writing the code, and keep it in the same change. Code with no matching docs update is not finished.

### Order of work

1. **Docs first.** Write or update every affected document below, describing the feature as it will work.
2. **Then code.** Build the feature to match the docs.
3. **Then reconcile.** If the code ended up different from the plan, correct the docs in the same change. When docs and code disagree, the code is right and the docs are fixed.

### Which documents to update

| Set | Where | Update when |
|-----|-------|-------------|
| **System docs** (internal, technical) | `docs/01-…` to `docs/09-…` | See the checklist below |
| **Client docs** (for customers and users) | Root `README.md`, the hands-on user guide | Anything a user can see or do: screens, settings, plans, limits, steps, errors they may hit |
| **PDF docs** | `docs/pdf/` | Regenerate the PDF of every Markdown document changed in this task, so the PDFs never lag behind the Markdown |

### System docs checklist

| Change | Documents |
|--------|-----------|
| New feature or module | `02-product-requirements.md` (what it must do, roles, user journey) and `03-system-design.md` (components, flow) |
| Business rule, pricing, plan or limit | `01-business-requirements.md` |
| New or changed endpoint | `05-api-reference.md` (method, path, permission, request, response) |
| New table, column, index or migration in `src/db/index.js` | `04-data-model.md` **and** `09-database-design.md` |
| Secrets, auth, permissions, anything reachable from outside | `06-security.md` |
| New env variable, background job, dependency or install step | `07-deployment-and-operations.md` |
| Known gap, shortcut or follow-up left for later | `08-limitations-and-roadmap.md` |
| New document | Add it to the table in `docs/README.md` |

### Writing rules

- Take facts from the code, never from memory.
- Use Mermaid for diagrams.
- Client docs are written for customers: plain language, no internal file names or table names, and no secrets or internal hostnames.
- At the end of the task, list the documents you updated. If you skipped one on purpose, say which one and why.
