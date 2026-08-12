# CLAUDE.md — Calendry

Read this file at the start of every session. It's the persistent context —
TAXONOMY.md is the taxonomy source of truth; this file is everything else you
need to work in this repo consistently across sessions.

## What this project is

Calendry is a multi-tenant calendar/timetabling platform for schools and
universities. It has two major parts, built in sequence:

1. **Calendar management app** (this repo, Nuxt) — entities, database, CRUD
   and editing routes (move/swap/lock Sessions), multi-tenant auth, import/
   export. Built first.
2. **Solver** (separate repo/service, Rust) — takes Offerings + Constraints,
   searches for a near-optimal Session placement via hybrid constructive +
   local-search optimization. Built second, called via a service contract
   from this app. **Not implemented in this repo** — only the interface
   boundary lives here.

If you're not sure whether something belongs in this repo, ask: does it
generate/optimize a schedule (solver's job, elsewhere) or manage/store/
present one (this repo's job)?

## Source of truth documents

- `TAXONOMY.md` — the fixed entity model and terminology. Authoritative.
  Do not add, rename, or restructure core entities without flagging it and
  getting explicit confirmation first — this is intentionally "carved in
  stone" and changes here are migrations, not config edits.
- This file (`CLAUDE.md`) — conventions, architecture rules, current phase.
  Update it when a real convention changes; don't let it drift from reality.

## Fixed vs. open taxonomy (quick reference)

**Fixed** (schema-level, changing = migration): Federation, Tenant, Person,
Group (nestable), Room, Offering, Session, TimeGrid, Term, Constraint,
Membership, Assignment.

**Open** (tenant-managed vocabulary, changing = data): Role names, Equipment/
Feature tags, Offering/Session `kind` values, Constraint parameter values.

Never hardcode an "open" value into application logic (e.g. never assume a
Role called "Student" exists, never assume a `kind` called "lecture" exists)
— always resolve against tenant configuration.

## Architecture rules

- **Multi-tenant, isolated by default.** Every tenant-scoped table carries
  `tenant_id`; isolation is enforced at the DB layer (row-level security),
  not just in application code. Only Federation-owned resources are
  intentionally cross-tenant — treat that as the explicit exception, not
  the norm.
- **Nested Groups propagate conflicts.** A booking conflict on a parent
  Group blocks its descendants and vice versa. Availability checks must
  walk the ancestor/descendant closure, not do a flat lookup. See
  TAXONOMY.md §6 before touching any conflict-check or notification
  fan-out code — there's a known perf trap here (don't walk the tree live
  in hot paths; use a precomputed closure structure).
- **TimeGrid is per-tenant, not global.** Never hardcode block/timeslot
  arithmetic (e.g. `timeslot % 3`, `timeslot > 14` for "Saturday"). Always
  resolve against the tenant's TimeGrid and Term/academic-calendar config.
- **History is event-sourced.** Manual edits are append-only events
  (`create`/`move`/`swap`/`delete`/`lock`) applied on top of a versioned
  Generation snapshot (solver output or manual baseline). Never mutate a
  Session in place without emitting the corresponding event — rollback and
  audit depend on the log being complete.
- **Locked Sessions are solver-exempt.** A solver re-run must skip locked
  Sessions entirely, not just deprioritize them.
- **Hard-constraint violations from manual edits: warn, don't block.** The
  UI/API must surface current violations as a queryable state, not just a
  one-time toast at edit time.
- **Timezone is per-Person and display-only.** It must never affect grid
  resolution, constraint evaluation, or "same day" logic — those all run in
  tenant-local time.

## Conventions

- **Naming**: `Offering` = recurring definition/demand; `Session` = one
  atomic placed occurrence. Don't use "Lecture," "Event," or "Class" as
  entity names in code — those are tenant-facing `kind` values, not schema
  concepts.
- **Routes**: CRUD follows standard REST conventions per entity. Editing
  operations (`move`, `swap`, `lock`, `apply-generation`) are explicit verbs
  on the Session resource, not generic PATCHes, so the event log can record
  intent, not just a diff.
- **Permissions**: per-tenant, tenant-configured roles — never a hardcoded
  global role enum in application logic.

## Current phase

- [x] Repo rebranded from template (`xxx-changeme` → `calendry`)
- [ ] TAXONOMY.md alignment confirmed
- [ ] Database schema (migrations) for core entities + join tables
- [ ] CRUD + editing API routes
- [ ] Solver interface boundary (stub, not implementation)
- [ ] Import (CSV/Excel)
- [ ] Export (iCal/Google/Outlook)
- [ ] Notifications (affected-party resolution via Membership tree)

Update the checklist above as phases complete — don't let this file go stale.

## Things to never do without asking first

- Add/rename/restructure a fixed taxonomy entity
- Hardcode a tenant-open value (role name, kind, equipment tag) into logic
- Bypass the event log for a Session mutation
- Implement solver logic in this repo
- Relax tenant isolation for anything other than declared Federation-shared
  resources