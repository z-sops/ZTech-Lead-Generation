# Phase 3 — CRM and sales pipeline (P09)

Owner approval: given in conversation on 9 Nov 2026 ("Phase 3 ka kaam shuru karo").
This is the first Phase 3 feature. P10–P12 and P16–P21 are not started.

## What it does

- **Accounts:** the businesses you are selling to. Add one by hand, or from a
  finished research job ("Add to CRM", or "Add all shown to CRM"). An
  imported account takes its name, website, phone, address, source link and
  score from the **stored research result**, never from the request, so
  nothing can be invented on the way in. The same researched business is
  never added twice.
- **Pipeline:** New → Contacted → Replied → Meeting → Proposal → Won / Lost.
  "Lost" needs a reason. The pipeline bar shows the number of accounts and
  the estimated value in each stage; clicking a stage filters the list.
- **Owner, next step and date, estimated value, notes.**
- **Search and filters:** name or website, stage, owner (mine, unassigned),
  archived.
- **History:** every change is recorded with who did it and when (created,
  imported, stage changed, owner changed, fields changed, note added,
  archived, restored). A note's text is kept in the note; the history only
  records that a note was written.
- **Nothing here contacts anyone.** A stage records what a person did.

## Rules

- Viewers read. Members create, edit, move stages and write notes.
- Changing who owns an account needs a manager (owner, admin, manager),
  except taking an unowned account yourself. An owner must be a member of
  the workspace.
- Archiving and restoring need a manager. An archived account is hidden by
  default and cannot be changed until it is restored. Accounts are never
  deleted.
- Two people editing at once: each save names the version it started from;
  the second save is refused (409) and the screen reloads the account.

## Storage and isolation (migration 023)

- `li_crm_accounts`, `li_crm_notes`, `li_crm_activity`: row-level security
  enabled and forced with the same `tenant_isolation` policy as every tenant
  table; notes and history can only point at an account of the same
  workspace; they are in the startup role check (`assertRoles.js`).
- The API role may read, insert and update accounts (no delete), and may
  only read and insert notes and history: the history cannot be edited or
  deleted, even by a bug in the application.
- The worker has no access to the CRM tables.

## API

- `GET /api/workspaces/:ws/crm/accounts?q&stage&owner=me|unassigned|<id>&archived=include&limit&offset`
- `POST /api/workspaces/:ws/crm/accounts`
- `POST /api/workspaces/:ws/crm/accounts/import` `{ job_id, opportunity_ids }`
- `GET /api/workspaces/:ws/crm/accounts/:id` (account, notes, history)
- `PATCH /api/workspaces/:ws/crm/accounts/:id` `{ version, …fields, archived? }`
- `POST /api/workspaces/:ws/crm/accounts/:id/notes` `{ body }`

## Tests

- `tests/api/crm.test.js`: the whole flow over HTTP, against the in-memory
  store and against PostgreSQL 16 (roles, versions, import, isolation, and
  the database rules themselves).
- The browser end-to-end test on PostgreSQL adds the researched businesses
  to the CRM, moves one to Contacted, reloads, and checks it is still there.
