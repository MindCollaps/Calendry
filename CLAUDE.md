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
  not just in application code.
- **The runtime must connect as the non-owner role.** `DATABASE_URL` uses
  `calendry_app`, which owns nothing and is subject to `FORCE ROW LEVEL
  SECURITY`. `MIGRATION_DATABASE_URL` (the owner) is for the Prisma CLI and
  the provisioning script only. Pointing the app at the owner would silently
  disable every policy in the system — the owner is a superuser and bypasses
  RLS entirely — and *every test would still pass*. Never do it.
- **Migrations are schema-only; data population is seed-only.** A migration may
  create tables, policies, triggers and indexes — never rows. Reference data
  lives in `prisma/seeds/` and is applied by `prisma db seed`. This keeps DDL
  history a record of structure, and lets reference data be corrected without
  inventing a migration whose only content is an `UPDATE`. It also means **a
  freshly migrated database is not yet usable**: the `permission` table is
  empty, and provisioning a tenant against it fails on the
  `access_role_permission` foreign key. That failure is deliberate and loud.
- **Never regenerate `prisma/migrations/`.** The RLS/trigger migration is
  hand-written and cannot be reproduced from `schema.prisma` — the schema
  language cannot express row-level security, triggers, `SECURITY DEFINER`
  functions or partial indexes. `prisma migrate dev` will cheerfully emit an
  "equivalent" migration containing none of it, producing a database where every
  table exists and tenant isolation is silently absent, with every test still
  passing. Rebuild with `prisma migrate reset`, which *replays* the committed
  files. (`db-reset` used to `rm -rf prisma/migrations`; it no longer does.)
- **Never query outside `withTenant()`.** Route handlers go through
  `withRequestTenant`, which opens a transaction and sets
  `calendry.tenant_id`. A query issued outside it sees zero rows rather than
  all rows; that failure mode is deliberate. The sole exception is
  `server/utils/authDb.ts` — see below.

### The two deliberate exceptions to tenant isolation

Both are conscious boundaries, not oversights. Anything that looks like a
third exception is a bug.

1. **Federation-owned resources.** `room`, `equipment` and `offering` may be
   owned by a Federation instead of a Tenant (a consortium's shared lecture
   hall, a cross-enrolled elective). A CHECK constraint enforces exactly one
   owner, and the RLS read policy widens to the caller's federation while the
   write policy stays tenant-only.

2. **The pre-tenant auth plane.** `account`, `account_person` and
   `auth_session` carry **no RLS at all**. This is structural, not a
   shortcut: a session must be read *before* the tenant is known, because the
   session is what determines the tenant — any policy on these tables would
   compare against a context that does not exist yet and would reject every
   login. What replaces RLS is access shape: they are only ever read by
   primary key or unique token hash from a verified cookie, never by tenant
   filter, and no route exposes them. `server/utils/authDb.ts` is the only
   module permitted to query without tenant context.

   Where auth genuinely needs tenant-scoped data (resolving a session's
   Person to its Tenant), it goes through the two `SECURITY DEFINER`
   functions `calendry_internal.session_identity()` and
   `calendry_internal.account_identities()`. These are the **only** RLS-bypassing code
   paths in the system. Both are parameterised solely by a secret the caller
   already holds and neither accepts a tenant id, so neither can be coaxed
   into enumerating another tenant. Do not add a third without a comparably
   strong reason.
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
- **Guards and detection conditions must fail loudly or match exactly.** Never
  write a check whose failure mode is a silent no-op indistinguishable from the
  correct case. If a condition can both "correctly find nothing" *and*
  "incorrectly match nothing because of a bug", those two states must be
  distinguishable — by anchored/exact matching, by asserting the expected shape,
  or by reporting what it did.

  This has bitten repeatedly, in different disguises:

  - An unauthenticated SSR fetch rendered the schedule's *empty state*, so a
    broken request looked exactly like a legitimately unconfigured tenant.
  - `'DATABASE_URL_HOST=' in text` matched `MIGRATION_DATABASE_URL_HOST`, so an
    idempotency guard skipped the write it was protecting and reported success.
    Fixed with an anchored `^\s*DATABASE_URL_HOST=`.
  - `concept-seed.mjs` exits 0 printing nothing when its state directory is
    wrong, which reads identically to "no findings".

  The counter-example to copy: provisioning against an unseeded database fails
  on a foreign key and writes nothing. Loud, specific, unmistakable.

- **Split a component when it mixes more than ~3 distinct responsibilities, or
  exceeds ~250 lines.** Line count is the trigger to *look*, not the rule: a
  single-concern component that is large because of cohesive SCSS
  (`CommonButton`, 303 lines) is fine, while a 300-line file juggling fetching,
  filter state and four presentational blocks is not. **Pages compose; they do
  not implement.** State moves to a composable when more than one component
  needs it, or when it forms a machine with its own rules (selection and
  placement mode constrain each other, so they live together). Give each
  composable one ownership boundary and say what it is — `useScheduleFilters`
  owns exactly what changes the API query, and view state like density stays out
  of it precisely because it does not.

  One Nuxt-specific trap this ran into: **a composable that calls `useAsyncData`
  or `useRequestFetch` must stay synchronous.** An `await` inside it detaches
  everything after that point from the Nuxt instance and fails at runtime with
  "a composable ... was called outside of a Vue setup function". Return the
  async-data handle and let the page hold the single top-level `await`.

- **New style work uses design tokens, never literals.** Colour, font size,
  border radius and spacing come from CSS custom properties: colours from the
  generated `--<colorName>` set (emitted per-theme by `useLayout()`), sizing from
  `--font-size-*`, `--radius-*` and `--space-*` (declared once in
  `app/scss/tokens-root.scss`, with SCSS aliases in `app/scss/tokens.scss`).
  Either form works — `$fontSizeMd` and `var(--font-size-md)` are the same
  property. This applies to **new** components and styles from Step 10 onward;
  existing hardcoded literals are backlog and no step needs to hunt them down as
  a side effect. If a value genuinely has no token, add one to the scale
  deliberately rather than reaching for a literal.

- **SSR data fetches must use `useRequestFetch()`, never bare `$fetch`.** Inside
  `useAsyncData` (or any server-side render path), `$fetch` does not carry the
  browser's cookie, so every authenticated call 401s on the server. The damage
  is that this does not look like an error: the page renders its *empty state*
  and hydrates from that, so a broken fetch is indistinguishable from a
  legitimately unconfigured tenant. `useRequestFetch()` forwards the incoming
  request's headers. Corollary when designing empty states: if "no data" and
  "the fetch failed" render the same way, the bug is invisible — distinguish
  them.

- **`--fix` tooling can rewrite files outside the current change's scope —
  review the full diff for unexpectedly-touched files, not just the ones you
  meant to change.** `stylelint --fix` and `eslint --fix` operate on whatever
  their config globs match, which is the whole project, not your working set.

  Concrete instance, Step 13: `bun run stylelint:fix` was run to clean up new
  components and silently modified **8 files the step never touched** — five
  schedule components, `schedule.vue`, `layout.scss` and `schedule-panel.scss`.
  Most of it was harmless property reordering, but it also rewrote
  `rgba(124, 89, 188, 0.55)` → `rgb(124, 89, 188, 0.55)` in `ScheduleGrid.vue`,
  a *value* change inside the file whose grid placement had just been debugged.
  It was caught by reading `git diff --name-only`, not by any check — build,
  typecheck, eslint and all 45 tests passed with it in place.

  Practical form: scope the fixer to your own paths
  (`stylelint --fix 'app/components/manage/**/*.vue'`), and when you do run it
  project-wide, `git checkout --` the files outside your scope afterwards.
  Bulk-fixing pre-existing lint debt is a deliberate standalone task, never a
  side effect of another step.

- **Vue does not flush watchers during SSR, so nothing that must be true at
  first render may depend on one.** A `watch(data, seed, { immediate: true })`
  runs exactly once on the server — at setup, before the fetch resolves — and
  never again. In Step 13 that rendered every management edit form with *empty
  inputs* over records that had data; the client re-seeded on hydration, so it
  showed as a flash and a hydration mismatch rather than an error. Drive
  first-render state from the awaited promise instead
  (`const ready = (async () => { await asyncData; seed(); })()`), and keep the
  watcher only for later client-side refreshes.

  It survived a whole phase because the check counted `<input>` elements rather
  than reading their `value`. **Verify the content, not the presence.**

- **`<select>` needs `:selected` on its options, not just `:value` on the
  select.** `value` is a *property* of a select element, not an attribute, so
  server rendering drops it and the browser falls back to the first option. A
  Term that had a TimeGrid rendered as "— None —" until hydration corrected it:
  the page stating the opposite of the truth. Every `<select>` in
  `app/components/manage/` binds `:selected` on its `<option>`s for this reason.

- **Permissions**: per-tenant, tenant-configured roles — never a hardcoded
  global role enum in application logic.
- **`Role` and `AccessRole` are different things that share a word.** `Role`
  (TAXONOMY.md §2) is scheduling *vocabulary* — Lecturer, Student, Auditor —
  and carries domain meaning: `offering.required_role_id` means "this Offering
  needs a Lecturer". `AccessRole` (§4) is *authorization*: a tenant-defined
  bundle of fixed Permissions. Keeping them separate is what stops the schema
  accepting an Offering that requires a lecturer holding the role "Billing
  Admin". Never merge them, and never grant permissions via `Role`.
- **Permissions are fixed, roles are not.** The `permission` catalogue is code
  (`server/utils/permissions.ts`, mirrored into the table by migration).
  Tenants bundle permissions into AccessRoles; they cannot invent permissions,
  because a permission with no corresponding code path is meaningless. Adding
  one means editing both the constant and the migration.

## Current phase

- [x] Repo rebranded from template (`xxx-changeme` → `calendry`)
- [x] TAXONOMY.md alignment confirmed
- [x] Database schema (migrations) for core entities + join tables
- [x] CRUD + editing API routes
- [x] Solver interface boundary (stub, not implementation)
- [x] Tenant provisioning CLI (`bun run provision:tenant`)
- [x] Authentication (global Account, post-login tenant selection)
- [x] Per-tenant permissions (AccessRole + fixed permission catalogue)
- [x] Login/profile UI wired to the auth API
- [x] Schedule view + editor UI
- [x] Management UI for the core entities + Ctrl+K command palette
- [ ] AccessRole / permission management UI — **next (Step 14)**
- [ ] Import (CSV/Excel)
- [ ] Export (iCal/Google/Outlook)
- [ ] Notifications (delivery; audience resolution already exists)

Update the checklist above as phases complete — don't let this file go stale.

### Step 14: AccessRole management has no UI and no API

Tenant roles are currently editable **only by `provision:tenant`** (which grants
the whole catalogue to `tenant-admin` at creation) and by the Step 13 operator
CLI `bun run grant:permissions` (which backfills grants onto an existing role).
There is no way for a tenant admin to compose a role, and no route behind it:

- `access_role.manage` and `person_access_role.assign` are in the permission
  catalogue and granted to `tenant-admin`, but **no endpoint checks either** —
  they are currently unreachable code paths.
- `access_role`, `access_role_permission` and `person_access_role` are not in
  `RESOURCES` or `RELATIONS`, so the generic CRUD and relation routes do not
  serve them.

That is deliberate for Step 13 (the brief scoped it to the nine core entities)
and is the whole of Step 14. Note the shape it needs is unusual: AccessRole is
tenant data, but the permissions it bundles are *code*, so its editor is a
picker over the fixed catalogue rather than a free-form form — closer to the
constraint rule builder than to the generic scaffold.

### Open items on auth (tracked, deliberately not built)

- **`must_change_password` — BUILT (operator reset), with gaps.** An operator
  can force a reset with `bun run reset:password -- --email …`, which revokes
  every session across every tenant, sets the flag, and prints an audit line;
  login then returns `requiresPasswordChange` and issues no session until
  `POST /api/auth/change-password` clears it. What is still open: the initial
  password from `provision:tenant` is *not* flagged for rotation (it is a
  one-time stdout print that stays valid), there is no password expiry, no
  complexity rule beyond a 12-character floor, no rate limiting on the change
  endpoint, and no email delivery of reset links.
- **`WebUser` / `isAdmin` in `types/user.ts` is still the template stub** and is
  unrelated to the real auth model. It is only referenced by the navigation
  composable. Replace it with the session payload from `GET /api/auth/session`
  when the login UI is wired up.
- **Federation-level permissions** are out of scope per TAXONOMY.md §9.4.
  Permissions are per-tenant only; administering federation-owned resources has
  no model yet.
- **Session cleanup**: expired `auth_session` rows are never swept. Harmless but
  unbounded; a periodic delete should exist before production.

## The management area (Step 13)

`/manage` is one scaffold, not eleven pages. Three route files
(`[entity]/index`, `[entity]/new`, `[entity]/[id]`) render every entity from
`app/utils/manageRegistry.ts`, which is also the **navigation source** —
`useNavEntries()` projects the manage section straight out of it, so the
sidebar, the `/manage` index, the header and the Ctrl+K palette cannot drift
from each other or from the entity list.

- **Permission rule, uniform across every entity.** No `.read` → the section is
  *hidden entirely* (nav, index, palette; direct URL redirects to `/manage`).
  `.read` without `.create`/`.update`/`.delete` → *visible, read-only*, and
  read-only renders as **static text, not disabled inputs** — a disabled control
  reads as "unavailable right now" rather than "not yours". An unknown section
  is a 404, which keeps a typo distinguishable from a permission problem.
- **Bespoke means one slot, never a page.** `detailComponent` / `listComponent`
  replace the fields area or the rows; the shell, header, permission handling,
  save/error plumbing and delete confirmation stay shared. Only three qualify:
  `GroupTree` + `GroupForm` (a hierarchy, and a parent picker whose options
  depend on the row being edited), `TimeGridEditor` (an ISO-weekday array plus a
  live preview built from the schedule's own `blockTime()`), and
  `ConstraintBuilder` (type, severity, weight and params constrain each other).
  **Offering is deliberately not one** — the hub of the model renders on the
  generic scaffold because its complexity is registry data (`fields`,
  `relations`), not different code.
- **`custom: true` on a field** keeps it in the draft, dirty tracking, payload
  and error mapping while a bespoke component supplies only its control. Leaving
  a field out of the registry instead drops it from the draft and silently from
  saves.
- **Relations are PUT-set sub-resources** (`server/utils/relations.ts`), edited
  as a whole collection and saved immediately, one request per change. They are
  not part of the form's Save button: the entity and each relation are separate
  endpoints with no shared transaction, so one button spanning them could
  half-succeed with a single error message covering both.
- **The Ctrl+K palette holds no permission logic at all.** Its entire input is
  the already-filtered `useNavEntries()`, so there is no check to forget.
- **Overlays claim the keyboard through `useOverlay()`.** Page-level global
  Escape handlers (`useScheduleEditing`) stand down while a claim is held,
  which is what stops closing the palette from also cancelling a placement. The
  claim follows the open *state*, not the function that changed it — hanging it
  off `openPalette()` left the header's search button unclaimed.

## Bootstrap & deploy sequence

The order matters, and each step depends on the one before it.

```
1. migrate deploy    schema only — tables, RLS, triggers, indexes. No rows.
2. db seed           reference data (the 46-row permission catalogue).
3. provision:tenant  the first tenant, its admin, and baseline constraints.
4. start the app
```

- **Local:** `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db`,
  then `bun run db-seed`, then `bun run provision:tenant -- --slug … --name … --admin-email … --admin-name …`.
  Migrations are applied by the dev entrypoint, or run `prisma migrate deploy`
  yourself.
- **CI/CD and containers:** both `.config/entrypoint.sh` and
  `.config/entrypoint.dev.sh` run `migrate deploy` then `db seed` before
  starting the app. `migrate deploy` does **not** auto-seed — only
  `migrate reset` and `migrate dev` do — so the explicit step is required in
  production and must not be removed.
- **Rebuilding a dev database:** `bun run db-reset` (`prisma migrate reset`)
  replays the migrations *and* runs the seed automatically.
- **Adding a permission needs a fourth step.** `db seed` mirrors the catalogue
  into the `permission` table, but it deliberately does not touch
  `access_role_permission` — which permissions a tenant's roles *hold* is tenant
  configuration, and a seed that silently widened every tenant's admin role on
  each deploy would be privilege escalation with no audit trail. `provision:tenant`
  grants the full catalogue only at creation time, so **existing** tenants are
  left without the new permission and the symptom is a 403 on a feature that
  visibly exists. Backfill with
  `bun run grant:permissions -- --role tenant-admin --all-missing`
  (`--dry-run` first; owner connection, audited to stdout like `reset:password`).

### The helper schema is `calendry_internal`, never `calendry`

Helper functions (`current_tenant_id()`, the closure triggers, the two
`SECURITY DEFINER` bridges) live in a schema called **`calendry_internal`**. The
name matters: the database owner role is `calendry`, and PostgreSQL's default
`search_path` is `("$user", public)`. A schema named `calendry` would therefore
capture every unqualified `CREATE` issued by that role — including Prisma's own
`_prisma_migrations` table, which the engine creates *before* any migration SQL
runs, so no amount of `SET search_path` inside the files can prevent it.

This is not hypothetical: it silently put all 35 tables in the wrong schema and
broke `prisma migrate reset`, because reset drops only `public` and leaves the
helper schema behind, which flips the resolution order on the second run.

Both migrations also begin with `SET search_path = public;` as a second line of
defence. Note the **GUC names stay `calendry.tenant_id` / `calendry.federation_id`** —
session settings are a different namespace from schemas and were not renamed.

### Two database URLs, one database

`MIGRATION_DATABASE_URL` uses `db:5432`, which resolves only between compose
containers. `MIGRATION_DATABASE_URL_HOST` uses the port `docker-compose.dev.yml`
publishes, for anything run from a developer's shell. Both are present inside
the container (bun auto-loads `.env`, and the app container mounts the repo), so
tooling cannot simply prefer whichever is set — `scripts/lib/ownerDatabaseUrl.ts`
picks by testing for `/.dockerenv`. `prisma.config.js` repeats that logic, since
it is loaded before any TypeScript is available.

All three owner-connection consumers — the Prisma CLI, the seed, and
`provision:tenant` — go through that selection. The runtime app role never does:
it cannot write the catalogue (SELECT-only RLS policy) and cannot create tenants.

## Known issues / tech debt

- **Three hand-written indexes are MISSING from the database.** The accidental
  migration `20260813190131_init` — generated by the `db-reset` script before it
  was fixed — contains nothing but three `DROP INDEX` statements, and it **is
  applied**. Confirmed absent from the live database:

  ```
  session_room_conflict_idx     ON session_room   (room_id, session_id)
  session_person_conflict_idx   ON session_person (person_id, session_id)
  session_event_replay_idx      ON session_event  (tenant_id, generation_id, created_at, seq)
  ```

  The first two back the room/person collision lookups in `refreshViolations()`,
  which runs synchronously inside every editing route; the third backs event
  replay (TAXONOMY.md §3 rollback). This is a performance regression, not a
  correctness one — every query still returns the right answer, which is exactly
  why it went unnoticed. `migrate reset` will replay the drop, so it does not
  heal itself.

  Fix forward with a small migration recreating the three (definitions are in
  `20260812000100_rls_triggers_and_indexes` §7), rather than deleting the bad
  migration file — that history is already applied in at least one database.
  Not done as part of Step 13; flagged and left as an explicit decision.


Deliberately deferred, with the reasoning, so these are not rediscovered as
surprises. None of these block current work.

- **Design-token retrofit (deferred by decision, not oversight).** Step 10
  established the token scale and wired its emission, but did not convert
  existing components. Remaining hardcoded literals, counted at the time:
  **~40 font-size**, **~26 border-radius**, **~70 spacing** values across
  `app/components/`. New work uses tokens (see Conventions); this is a
  standalone design-system pass whenever it is worth doing.

- **Raw-SQL account artifacts in the `test` tenant — clean up before any
  staging or production exposure.** Both were written directly to the database
  during development, bypassing the paths that would normally create them:

  - ~~**`ntill@gmx.de`'s password was set by hand.**~~ **RESOLVED.** Replaced
    through the real path by `bun run reset:password`, which hashes via
    `hashPassword()` from `server/utils/auth.ts`, revokes every session, sets
    `must_change_password`, and emits an audit line. The password was then
    changed through `POST /api/auth/change-password`. No hand-written hash
    remains for this account. (The duplicate scrypt implementation that made
    this a risk is also gone: `provision-tenant.ts` now imports the same
    `hashPassword()` rather than carrying its own copy.)
  - **`vic@demo.local`** is a hand-inserted Person + Account + `viewer`
    AccessRole (7 read permissions) used to prove permission-gated affordances
    in the schedule UI. Deliberately kept: it has real regression value. It is
    demo-tenant only.

  Both should be recreated through proper channels — provisioning and the
  forced-reset CLI — once that CLI exists.

- **Impeccable's state directory collides with its own install path.** The
  skill expects `.impeccable/` at the repo root to hold *per-project* state
  (`settings.json`, `mocks/`, `live/`), but that path is the vendored skill
  submodule itself (`github.com/pbakaus/impeccable`). Consequence:
  `concept-seed.mjs` exits 0 with no output at either scope, so the
  direction/structure dice never deal, and `serve-question.mjs` has nowhere to
  write. Design work through the skill has to substitute a manual choice round
  and say so. Fix by relocating the submodule (e.g. `vendor/impeccable`) and
  repointing `.claude/skills/impeccable`, or by pointing the skill's state
  elsewhere if it supports that.

- **`CommonButton` accepts two variants it does not style.** Callers pass
  `transparent` (`CommonChevron.vue`) and `secondary-875`
  (`ViewMenu.vue`), but SCSS exists only for `primary`, `secondary`,
  `secondary-black`, `destructive`, `link`. The prop union was widened to make
  `nuxt build` typecheck pass, so these render with an unstyled
  `button--type-*` class. Fix by writing the missing SCSS *or* migrating those
  callers to an implemented variant — the type error was a real signal that has
  been silenced, not solved.

- **Pre-launch sweep for leftover template-author branding/strings.** The Step 1
  rebrand searched only for the `xxx-changeme` placeholder pattern, so anything
  the template author hardcoded under a different name survived it. `Swindler`
  (the page title and header text) was one such instance, found by accident
  while building the login UI and fixed then — there may well be others in copy,
  comments, asset names or config. Not urgent, but sweep before this goes near
  real users: the failure mode is another institution's product name appearing
  in Calendry's UI.

- **`docker-compose-next.yml` cannot start.** It declares
  `depends_on: redis: condition: service_healthy` but defines no `redis`
  service. Both compose files also declare an unused `redis_data` volume.

- **Repo hygiene.** The `Init` commit tracked `.agents/`, `.claude/` and
  `skills-lock.json`, and added `.impeccable` as a git submodule
  (`github.com/pbakaus/impeccable`). `.gitignore` now lists these, but ignore
  rules do not apply to already-tracked files — they need `git rm --cached`,
  and the submodule needs deliberate removal, before they stop travelling with
  the repo.

## Things to never do without asking first

- Add/rename/restructure a fixed taxonomy entity
- Hardcode a tenant-open value (role name, kind, equipment tag) into logic
- Bypass the event log for a Session mutation
- Implement solver logic in this repo
- Relax tenant isolation for anything other than declared Federation-shared
  resources