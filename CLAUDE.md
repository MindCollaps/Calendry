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
   `calendry_internal.account_identities()`. Both are parameterised solely by a
   secret the caller already holds and neither accepts a tenant id, so neither
   can be coaxed into enumerating another tenant.

3. **The background solver poller.** `calendry_internal.tenants_with_due_solver_runs()`
   (Stage 4). Added under the same rule as the two above, for the same reason:
   the operation structurally sits OUTSIDE the tenant-request model rather than
   being made easier by skipping it. Auth must read a session *before the tenant
   is known*; the poller runs *when nobody is logged in at all*, so
   `current_tenant_id()` is NULL and the app role sees zero rows in both
   `solver_run` and `tenant` — fail-closed working exactly as designed, and
   leaving a cross-tenant job unable to see the work it exists to do.

   What keeps it narrow: it returns **tenant ids only** — no run rows, no
   scopes, no inputs, no results — and takes **no parameters**, so it cannot be
   steered at a chosen tenant. Everything the poller then does happens inside an
   ordinary `withTenant()` transaction under RLS, including the claim and every
   write. Widening it to return the runs themselves was considered and rejected:
   it would move the atomic claim into SQL and carry run data across the
   boundary to save one round trip per tenant per tick.

These three are the **only** RLS-bypassing code paths in the system. Do not add
a fourth without a comparably strong reason — and "the query is awkward
otherwise" is not one.
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
  - **Array truthiness (Stage 6b).** `GET /api/solver/runs` returns `active` as
    an ARRAY, and `[]` is truthy, so `list.active ?? list.runs[0]` always
    yielded the empty array. Run adoption therefore never fired and the toolbar
    reported "no run in progress" — which is exactly what it says when there
    genuinely is none. Fixed with `active?.[0]`. In JS the empty-collection case
    needs `.length` or an index, never a bare truthiness test.
  - **Absence that only proves the page failed (Stage 6b).** The first
    permission check asserted the solver control was missing for a viewer — and
    it was also missing for the admin, because of the SSR bug below. A test for
    "affordance absent" must also assert the surrounding page RENDERED, or it
    passes for the wrong reason. The fixed check reports
    `schedule rendered=True solver control=False`.

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

  **Second instance, Stage 6b — same shape, different symptom.** `filters.termId`
  is seeded by a `watchEffect` in `useScheduleData`, so during SSR it is still
  `''` while the page renders. The solver control gated on it
  (`v-if="canTriggerSolver && termIdModel"`) and was therefore absent from the
  server-rendered page for a user who had every permission for it, appearing only
  after hydration. Fixed by exposing `resolvedTermId` — which falls back to the
  term the fetch actually used — and gating on that instead.

  The generalisation, now that this has happened three times (edit forms,
  `<select>`, this): **anything a watcher seeds is `undefined` at first render on
  the server.** If a template branches on it, the server renders the wrong branch.
  Prefer a `computed` derived from the awaited data over a watcher-assigned `ref`
  whenever first render depends on the value.

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
- [ ] AccessRole / permission management UI (Step 14) — the operator CLI
      `create:role` exists; the tenant-facing UI and its API do not
- [x] **Solver integration Stages 1–7 — COMPLETE.** Start a solve, never lose
      the result, review it, apply or discard it; person-level clash detection,
      Federation-shared Rooms with real cross-tenant occupancy, and
      federation-shareable Sessions. Both remaining cross-repo items are now
      closed too: the solver's virtual-room capacity-1 bug is fixed in
      `calendry-solver`, and the AccessRole gap that blocked viewer-account
      regression checks is closed — see `create:role`.
- [ ] Import (CSV/Excel)
- [ ] Export (iCal/Google/Outlook)
- [ ] Notifications (delivery; audience resolution already exists)

Update the checklist above as phases complete — don't let this file go stale.

## Solver integration (calendry-solver)

Three repos, one system. Neither of the other two is checked out as part of
this one:

| Repo | What it is | How this app consumes it |
|---|---|---|
| `calendry` | this app — owns Postgres, all state | — |
| `calendry-solver` | Rust gRPC optimizer, **stateless** | over gRPC |
| `calendry-proto` | the shared Protobuf schema | npm package `@mindcollaps/calendry-proto` |

The solver is functionally complete: all 14 constraint types from the §7
catalogue, LNS with simulated annealing, and a `StartRun`/`GetStatus`/`CancelRun`
job API. A 27,000-Session large-university instance solves in ~349ms.

**The solver never touches Postgres.** This app assembles a complete
`SolverInput` snapshot and sends it; the solver is input/output only and
persists nothing beyond an in-flight run. Everything the solver knows, this app
put in the request — which means every gap in the snapshot is a wrong answer the
solver has no way to detect.

`calendry-proto` is consumed here as a normal npm dependency and by the Rust
side as a pinned git submodule. It is published to **GitHub Packages, not
npmjs.org**, which requires authentication to install even though it is public.

### Installing the proto package: three traps, all hit for real

The credential lives in `~/.bunfig.toml` (or the gitignored `./bunfig.toml`),
never in a committed file. `bun run check:registry-auth` diagnoses all of this
offline; `bunfig.toml.example` is the template. Each rule below cost a round
trip to discover, and all three produce the *same* opaque 401:

1. **A bunfig scope token is only sent when the SAME entry declares `url`.**
   `{ token = "…" }` alone is silently ignored — even with the scope mapped to
   the right registry in `.npmrc`. Verified against a local probe registry that
   logged the `Authorization` header.
2. **An `.npmrc` auth line OVERRIDES a bunfig scope token.** A stale, invalid
   token left in `~/.npmrc` kept beating a perfectly good `bunfig.toml` entry;
   `curl` with the same good token succeeded the whole time. If bun 401s while
   curl works, look for a second credential before doubting the first.
3. **GitHub Packages rejects fine-grained PATs for the npm registry.** A
   `github_pat_…` token authenticates fine against `api.github.com` (200) and is
   then refused by the registry with `permission_denied: does not match expected
   scopes`, and by the packages REST API with `Resource not accessible by
   personal access token`. Use a **classic** PAT (`ghp_` + 36 chars) with
   `read:packages`. The guard now catches this by prefix.

Scope entries resolve nearest-first and the nearest wins **wholesale** — a
project-level entry replaces a home entry rather than merging with it — which is
why nothing scope-related is committed.

### Decision: warn-and-allow parity for solver output

A run that reaches `RUN_STATUS_SUCCEEDED` but still carries residual hard
violations **is still offered as an applicable Generation.** Its violations are
surfaced through the same `constraint_violation` mechanism manual edits already
use. Not silently discarded, not auto-applied.

`Generation.apply` still requires an explicit human action regardless of
violation state — unchanged from existing behaviour.

**A consequence, realised in Stage 5: `GenerationStatus.INFEASIBLE` is now
effectively unused for solver output, and that is not an oversight.** Warn-and-
allow means a SUCCEEDED run carrying residual hard violations is still `READY`
and still applicable, and a run that never succeeded produces no Generation at
all (`shouldCreateGeneration()` admits only SUCCEEDED — a Generation nobody can
apply is noise in a list whose entire job is "what could I apply?", and
`solver_run` already records what happened). The status stays in the enum for
import and for a future solver that reports infeasibility as a first-class
outcome. Nothing setting it is the design working, not a missing branch.

This is parity with §3's manual-edit rule (hard-constraint violations warn, they
do not block), and it matches what the wire protocol already says: `RunStatus`
deliberately describes **the run's lifecycle, not the solution's quality**. The
solver accepts possibly-infeasible input and degrades gracefully rather than
rejecting it, exactly as `ExactFrequency` (unplaced Sessions) and
`MaxOnlineShare` (share breaches) already do. A `SUCCEEDED` run with violations
is a normal outcome, not an error case.

### Decision: single-tenant, non-federated scope for Stages 1–6

Two Federation mechanisms are decided in principle and **NOT implemented in this
app's schema or RLS**:

- **`ExternalOccupancy`** — occupancy of Federation-shared Rooms by other
  tenants. The proto message exists and is deliberately shaped to commit to
  neither of the two candidate mechanisms (cross-tenant occupancy ledger vs. a
  narrow database function).
- **`Session` becoming federation-shareable** — extending the Federation
  exception beyond `room`/`equipment`/`offering`, per the TAXONOMY.md amendment.

Do not attempt either before Stage 7. Sending an empty `external_occupancy` and
tenant-owned Sessions only is correct for a single-tenant run and wrong the
moment a shared Room is involved — so the limit is a scope boundary, not an
oversight, and the deferral is what keeps it visible.

### Determinism: only the move budget is reproducible

`Budget` carries both `max_wall_millis` and `max_moves`, and **whichever is hit
first ends the run**. The guarantee is that the same `(input, seed, move budget)`
produces byte-identical output — but that holds **only when termination was by
move budget**. A wall-clock-terminated run is not reproducible, because how many
moves fit in a second is not a property of the input.

`SolveStats.termination_reason` reports which one ended it (`"move_budget"`,
`"time_budget"`, `"converged"`, `"cancelled"`). Anything that claims to explain,
replay or diff a run must read that field first; treating a `time_budget` run as
replayable produces a different answer and blames the wrong thing.

`StartRunResponse.seed` echoes the seed actually used (0 = solver picks one), so
a run is reproducible even when the caller did not choose the seed.

### Idempotency: the key is `<inputHash>:<seed>`

`POST /api/solver/runs` sends a SHA-256 of the ENCODED `SolverInput` plus the
seed as `StartRunRequest.idempotency_key`, so **a repeated start against
unchanged data returns the SAME run rather than launching a second one.**
Observed accidentally and then confirmed deliberately: two consecutive
assemblies of the demo tenant produced an identical hash and the solver handed
back the same `run_id`.

Two things to know before changing it:

- The hash is over the encoded protobuf, not a JSON rendering. Two inputs that
  encode identically are the same problem to the solver, which is exactly the
  question being asked; a JSON hash would also move with key order and with how
  BigInt happened to stringify.
- Anything that deliberately changes the problem MUST change the key, or the
  solver returns the earlier run and the new one is never observed. This bit
  during Stage 3 verification: a stress variant reused the key and silently got
  the previous, easy run back.

### Both of the above are now CONFIRMED, not just designed

Measured in Stage 1 against a live `calendry-solver`, not inferred from the
proto:

- **Determinism.** Two runs of an identical snapshot at seed 42 produced
  byte-identical placements, objective and termination reason. Note a third
  terminal reason beyond the two in the guarantee: `converged`, when the
  constructive heuristic lands a zero-objective solution in 0 moves. It is as
  reproducible as `move_budget`; `time_budget` remains the one that is not.
- **Warn-and-allow is the solver's actual behaviour.** An over-constrained
  snapshot (60 sessions demanded into a 40-slot grid) returned
  `RUN_STATUS_SUCCEEDED`, `termination_reason=move_budget`, objective 21, **40
  placements and 2 `ExactFrequency` hard violations** — rather than failing the
  run. Stage 5 can rely on this: a SUCCEEDED run carrying violations is normal,
  and the residuals arrive in `SolverOutput.hard_violations` ready to be mapped
  onto `constraint_violation`.

### Staged plan

| Stage | Scope |
|---|---|
| ~~1~~ | **DONE.** Package wiring (`bunfig.toml` auth), `@mindcollaps/calendry-proto@0.2.0` + `@grpc/grpc-js` installed, real StartRun→GetStatus round trip proven against a live solver. `scripts/solver-smoke.ts` is the throwaway probe — delete it when Stage 2 lands a real client. |
| ~~2~~ | **DONE.** `solver_run` table + `solver_run_one_active_per_term` partial unique index; `/api/solver/runs` (POST/GET/`:id`/`:id/cancel`) replacing the deleted `/api/solver/generations` stub. Input is still the placeholder. |
| **3** | Real `SolverInput` assembly from Prisma. **3a/3c and 3b/3e DONE** — calendar, slot arithmetic, entities, wire-up, placeholder deleted, `RUNNING → CANCELLED` verified. **3d remains**: constraint mapping, the three missing parameter sets, and the `ManageWeekdayPicker` extraction. |
| ~~4~~ | **DONE.** Background poller (`server/plugins/solverPoller.ts`) owns advancing runs and capturing results; on-demand `GET /runs/:id` is latency only. Adaptive cadence, `FOR UPDATE SKIP LOCKED` claim, NOT_FOUND→FAILED. |
| ~~5~~ | **DONE.** `generationFromRun.ts` (poller creates a READY Generation on SUCCEEDED) + `generationMaterialize.ts` (create/move/unchanged/delete partition, violations onto `constraint_violation`). Verified both ways: a clean run applied end to end, and an over-constrained SUCCEEDED-with-23-violations run applied successfully. Fixed two pre-existing bugs it uncovered — see below. |
| ~~6~~ | **DONE.** 6a: plan/execute split + `GET /api/generations`, `/:id`, `/:id/preview`, `POST /:id/discard`, `termination_reason` capture. 6b: six-state solver control in the schedule toolbar, honest progress, cancel, run adoption. 6c: `/schedule/review/[id]` — two non-commensurable violation panels, change partition, diff grid, apply/discard. |
| ~~7~~ | **DONE.** 7a: `no_double_booking_person` in the manual-edit evaluator — both sides expanded to people, intersected by identity. 7b: `federation_room_occupancy()`, a parameterless SECURITY DEFINER function, feeding `externalOccupancy` and unlocking federation-owned Rooms in `SolverInput`. 7c: `session` federation-shareable — shared row, tenant-private participant links, `session_room` widened. |

### What Stage 2 established, and the one path it could not test

Three behaviours were verified against a live solver rather than reasoned about:

- **Concurrency is enforced by the database.** Three simultaneous POSTs to the
  same term returned one 201 and two 409s naming the winner. The rule is the
  partial unique index, not a `findFirst` — two parallel requests would both
  pass an application check and both insert.
- **A failed StartRun resolves its own row.** Solver down → 502, row `FAILED`,
  **zero** active runs. The row is written as `PENDING` *before* StartRun so the
  index can reject a concurrent second attempt during the call, which creates
  the obligation to resolve it; otherwise a solver outage blocks that term until
  someone edits the database by hand.
- **A poll failure is deliberately NOT a run failure.** `GET /runs/:id` with the
  solver down leaves the status untouched and returns `stale: true`. Marking it
  `FAILED` would destroy a live run's record *and* free the index for a second
  concurrent run.

Two traps found while building it, both worth not rediscovering:

- **A 23505 aborts the Postgres transaction.** Nothing may query it afterwards.
  Looking up the conflicting row inside the same transaction returned
  `500 current transaction is aborted` instead of a clean 409 — and only a
  genuinely *parallel* test surfaced it; a sequential one passed.
- **ts-proto emits `uint64` as `string`, not bigint.** `toWireU64` /
  `fromWireU64` in `solverClient.ts` are the only place that conversion happens.

**`RUNNING → CANCELLED` — RESOLVED in Stage 3b/3e.** It was tracked here through
Stage 2 because `CancelRun`'s already-terminal and never-acknowledged paths both
passed, so cancel *appeared* to work from every route tested, while the run that
matters — a genuinely in-flight one — had never been interrupted.

Now verified twice: directly against the solver, and through
`POST /api/solver/runs/:id/cancel` (`RUNNING`, 6.2M moves, objective 1095 →
`cancelled=true` → `CANCELLED`).

Note what it took, because it will recur: the demo tenant's REAL data still
converges in ZERO moves — 48 sessions into 760 slots is not a search problem —
so the transition only became observable after demand was raised far above
capacity. Anything that needs to watch a run in flight must construct that
deliberately.

### Stage 4: how polling actually works, and three things worth not relearning

**The background poller owns correctness; on-demand polling owns latency.**
`GET /api/solver/runs/:id` exists so someone watching gets a fast answer, but
nothing about a run reaching a terminal state may depend on a human keeping a
tab open. Both call the same `pollSolverRun()`, so they cannot disagree about
what a status means.

**Results are captured the moment a run goes terminal**, not when someone asks
to apply them. The solver's run registry is an in-memory map with no persistence
and no eviction, so "I'll fetch it later" is a promise a restart breaks.
`solver_run.result` makes Stage 5 a database→database transform that cannot fail
because a service bounced.

**NOT_FOUND and UNAVAILABLE mean opposite things** and the distinction is the
sharpest edge in Stage 4:

- `NOT_FOUND` (gRPC 5) — the solver restarted and lost the run. Terminal and
  unrecoverable: the row is marked `FAILED` with that reason, which also frees
  the one-active-run index for that term.
- anything else, including `UNAVAILABLE` (14) — transient. The row is left
  **completely untouched** and the caller is told `stale: true`. Marking it
  failed would destroy a live run's record on a blip *and* let a second
  concurrent run start against the same term.

`classifyPollFailure()` errs toward `unreachable` for unrecognised codes: the
cost of being wrong that way is a stale row, the other way is a destroyed one.

**Claiming is a lease, not a lock.** The original design used a session-scoped
`pg_try_advisory_lock` to elect a single poller. That was wrong twice over and
was caught before building: session locks belong to a CONNECTION and Prisma
pools connections, so the "leader" would not reliably hold anything; and holding
it across the gRPC calls would keep a transaction open across a network call —
exactly what Stage 2 refused to do for StartRun.

What actually works: a short transaction pushes `next_poll_at` into the future
for the rows it takes, using `FOR UPDATE SKIP LOCKED`, so concurrent instances
take **disjoint** sets rather than serialising. `pg_try_advisory_xact_lock`
remains, scoped tightly around the claim and released at COMMIT before any
network call, purely to stop a same-tenant stampede. Verified: four concurrent
claimers, six due runs, zero duplicate claims, and the work becomes claimable
again once the lease expires — so an instance dying mid-poll strands nothing.

**One consequence to expect:** during a solver outage the effective retry
interval is the 30s claim lease, not the adaptive cadence, because a failed poll
deliberately writes nothing at all. A run therefore takes up to ~30s after the
solver returns to resolve. That is backoff, not a bug, but it surprised me while
testing and will surprise the next person.

### Tracked gap: equipment QUANTITY cannot cross the wire

`RoomEquipment.quantity` and `OfferingEquipment.quantity` both exist — "this lab
has 24 workstations", "this offering needs 24". The proto carries
`Room.feature_tags` and `Offering.required_room_features` as plain string lists,
so both become presence-only: "has `workstation`", "needs `workstation`".

The solver therefore cannot reason about counts, and a 12-seat lab satisfies a
24-workstation requirement. `assembleSolverInput` counts the dropped quantities
and returns them in its report rather than narrowing quietly. Same shape of fix
as the multi-room gap below: either the proto grows a quantity, or the app
accepts presence-only semantics deliberately.

### Tracked gap: a Session with more than one Room cannot cross the wire

`session_room` is a join table, so the app models a Session in several Rooms at
once. The proto's `Session` and `PlacedSession` both carry a single `room_id`.
A multi-room Session therefore cannot be fully represented in either direction:
the input mapper sends the first room and reports the rest, and Stage 5 will
face the same narrowing coming back.

Not urgent — the demo tenant has none, and `multiRoomSessionIds()` in
`solverSessions.ts` reports any that appear rather than silently dropping them.
But it is a real expressiveness limit, not an implementation shortcut: closing
it means either a proto change (repeated `room_id`) or a decision that Calendry
Sessions occupy exactly one Room. Do not "fix" it by quietly picking a room.

### Cross-repo note: calendry-solver's run registry grows without bound

The solver keeps runs in an in-memory `HashMap` with **no TTL and no eviction**,
so every run ever started stays resident until the process restarts. Not urgent
at current volumes, and not this repo's code to fix — but it is an unbounded
growth path, and the same absence of persistence is why this app captures
results eagerly (above) and treats NOT_FOUND as terminal.

~~**This should also get a line in calendry-solver's own CLAUDE.md.**~~ **DONE**
— recorded there (§2, "the run registry grows without bound") alongside the two
consequences this app depends on, so the repo that can fix it now knows what
changing it would break here.

### RESOLVED (cross-repo): the solver treated a VIRTUAL room as capacity-1

Both halves are now exempt, and the two sides agree. Fixed in `calendry-solver`
at `99b41e3`; `vendor/calendry-solver` points at it.

`Occupancy` (`solution.rs`) held a binary `BitMatrix` over (rooms × slots) with
no capacity dimension, and `check_pair`'s `RoomDoubleBooking` branch reported on
`rx == ry` — neither consulting `is_virtual`. The solver's half was the damaging
one because it constrained the SEARCH: one online Session per slot, tenant-wide,
during construction and LNS both.

The fix keys on the FLAG, via a single `Room::is_exclusive()` predicate that both
layers consult, so the search cannot refuse a placement it then declines to
report. `capacity` still gates eligibility and was deliberately left alone — a
virtual room with a genuine concurrency limit still cannot be expressed, and
needs an explicit `concurrentCapacity` rather than an overload of `capacity`.

**It exposed a real gap in the solver, which is now tracked there rather than
here.** The bug had been enforcing `MaxOnlineShare` by accident: virtual rooms
are the overflow valve when physical rooms are full, and capacity-1 held that
valve nearly shut. Removing it more than doubled share violations at
large-university (180 → 455) with structural violations unchanged at exactly 80
and `unplaced` still 0 — so the model is now correct and the search is visibly
worse at respecting a cap it was never actually respecting on its own. That is
solver-side work; nothing in this app changes because of it.

What this app should expect in the meantime: a SUCCEEDED run may carry more
`MaxOnlineShare` violations than it used to. That is warn-and-allow behaving as
designed — they arrive in `SolverOutput.hard_violations` like any other residual
— but a run against a tenant with heavy online delivery will look noisier than
the Stage 5 measurements recorded above.

### Tracked gap: the manual-edit evaluator misses person clashes across groups

Found while building the solver. `server/utils/violations.ts` evaluates
`no_double_booking_lecturer` by intersecting `session_person` rows, which catches
a person assigned to two overlapping Sessions directly. It does **not** catch a
person who is clashed into two overlapping Sessions via membership of two
unrelated Groups — no ancestor/descendant relationship, so `conflictGroupIds()`
does not connect them, and nothing flags it.

A manual edit can therefore create a real person-level clash that the UI reports
as clean. Correctness gap, not performance. Scheduled for Stage 7; do not treat
the existing lecturer check as covering it.

Note this is the *under*-reporting half of a pair. The over-reporting half — the
group check flagging unrelated Groups — was found and FIXED in Stage 5, below.
They are the same function and opposite failure directions, but only this one is
still open, and it stays open because it needs new capability (resolving Group
membership down to people) rather than a correction to existing logic.

### Stage 5: two pre-existing bugs it uncovered, both fixed

Neither was introduced by Stage 5. Both had gone unnoticed for the same reason —
nothing had ever exercised the code path — and both are the kind of thing
CLAUDE.md's "guards must fail loudly or match exactly" rule exists to catch.

**1. A Session with history could not be deleted at all.**

`session_event.session_id` is `ON DELETE SET NULL`, chosen so an audit row
outlives the Session it describes (the schema says exactly that in a comment).
But `deny_mutation()` refused every `UPDATE OR DELETE` on `session_event` — and
the FK's SET NULL *is* an UPDATE. So the schema's own referential action was
rejected by the trigger guarding the same table:

    DELETE FROM session WHERE id = <a session that has any event>;
    ERROR: session_event is append-only; UPDATE is not permitted
    CONTEXT: SQL statement "UPDATE ONLY public.session_event SET session_id = NULL ..."

It survived because until Stage 5 **nothing in the codebase deleted a Session** —
there is no `DELETE /api/sessions/:id`, and `materializeGeneration()` removing
solver-rejected placements is the only such call. The first Stage 5 verification
passed only because it happened to have `deleted: 0`.

Fixed by `20260816180000_session_event_detach_on_session_delete`, which narrows
the trigger to permit **exactly one shape**: an UPDATE that sets `session_id`
and/or `counterpart_session_id` from a value to NULL with every other column
byte-identical. Repointing either column at a *different* Session, changing any
other column, a detach smuggled in alongside another column, a no-op UPDATE, and
DELETE are all still refused — pinned by 11 tests in
`tests/session-event-append-only.test.ts`. Event CONTENT stays immutable, which
is the property §3 actually needs; only the pointer to a row that no longer
exists may be cleared.

`ON DELETE CASCADE` was rejected (it destroys the audit trail the log exists
for) and so was `RESTRICT` (it contradicts the decision that unplaceable
Sessions are removed rather than left at placements the solver refused).

**2. `no_double_booking_group` flagged any two Groups under a shared root.**

`describeCollision()` intersected the EXPANDED conflict closure of *both* Sessions.
Every group expands to include its ancestors, so two groups sharing any common
ancestor always intersected at that ancestor — however unrelated they were:

    Seminar A1 → {Seminar A1, Class A, Informatics 2026}
    Class B    → {Class B,            Informatics 2026}
    ∩          = {Informatics 2026}   ← a false positive

Class B is neither an ancestor nor a descendant of Seminar A1 (0 rows in
`group_closure` either way) and no person is in both, so booking them
concurrently is legitimate. TAXONOMY.md §6 propagation is ancestors *and*
descendants — not "shares a root".

Fixed by expanding **one** side and intersecting against the other side's
DIRECTLY assigned groups by identity, mirroring the solver's own implementation.
Detection stays symmetric; only the reported ids differ, and reporting `b`'s own
Groups is what a human needs to see.

Scale of the bug, measured on the over-constrained Stage 5 schedule: the old code
would have flagged **390** sibling-only pairs on top of the 18 genuine ones. On
the ordinary 48-Session demo schedule it produced **24 phantom violations** where
the correct answer — and the solver's — is zero.

Three independent sources now agree on the same timetable: a closure query
computed directly in SQL (18 colliding pairs / 36 sessions), the app evaluator
(36 rows), and the solver (18 `GroupDoubleBooking` violations). Regression
pinned by `tests/violations-group-conflict.test.ts`, which fails 6 of its 8 cases
against the old logic.

### RESOLVED: a terminal run whose result was never captured

Found in Stage 6b verification. One run ended like this:

    status=SUCCEEDED  generation_id=NULL  termination_reason=NULL  has_result=f

A SUCCEEDED run is supposed to always produce a Generation (Stage 5). This one
produced none, because `result` was never captured — and `createGenerationForRun()`
correctly returns null when there is no result to propose.

**What happens is confirmed; the root cause is not.** It coincided with cancelling
a run that had *just* completed, so the `CancelRun` and the terminal
`GetStatus(include_result=true)` overlapped. The plausible mechanism is that the
cancel caused the solver to drop the finished run's result before the app asked
for it, but that has not been proven and should not be assumed.

**What IS proven is the recovery gap, which is the part that matters:**

- `pollSolverRun()` deliberately records the terminal status even when the result
  fetch throws (losing the transition would be worse — the run would look active
  against a solver that has finished it, and the one-active-run index would block
  that term).
- **Nothing ever retries.** The background poller claims only
  `PENDING/QUEUED/RUNNING`, and `GET /api/solver/runs/:id` short-circuits on
  `isTerminal(run.status)` before polling. So a terminal row with no result is
  never looked at again.

The run is therefore permanently unusable: no result, no Generation, no way to
get one, and the work the solver did is gone.

Stage 6b surfaces this honestly rather than making it worse — `deriveState()` maps
SUCCEEDED-without-a-Generation to the `failed` branch, so the UI says "The run
failed" instead of hanging on a spinner or offering a Review link to nothing, and
that case is unit-tested. But 6b does make the race *reachable from a button*,
since a user can now press Cancel at exactly the wrong moment.

**FIXED** by `20260817120000_solver_run_result_recovery` and `recoverRunResult()`.
Four things are worth keeping:

- **Discovery needed THREE gates widened, not one.** Besides the claim, the
  `SECURITY DEFINER` `tenants_with_due_solver_runs()` also filtered on active
  statuses — and the poller never visits a tenant that function does not name, so
  widening only the claim would have looked correct while doing nothing. Proven
  rather than assumed: with a recovery due, the widened function returns 1 tenant
  where the old active-only predicate returns 0. (`GET /runs/:id` was left
  short-circuiting on `isTerminal`, per Stage 4's on-demand-is-latency-only rule.)
- **The predicate names SUCCEEDED explicitly.** "Terminal and missing a result"
  would have chased 16 FAILED and 4 CANCELLED rows that correctly have none. Only
  SUCCEEDED promises a result.
- **`status` is never rewritten.** The run DID succeed and this row is the only
  record of it; the capture failure is a separate axis, so it gets
  `result_lost_at` and `result_recovery_attempts` rather than a new status value.
  "Result lost" is `status = 'SUCCEEDED' AND result_lost_at IS NOT NULL`. This is
  also what leaves the one-active-run index untouched — that index is partial on
  PENDING/QUEUED/RUNNING, so a SUCCEEDED run already frees its term either way.
- **NOT_FOUND short-circuits the budget.** `classifyPollFailure()` already knew
  the difference: a solver that has forgotten the run restarted, and the result is
  gone, so it is marked lost on attempt 1 rather than after five. Only
  `unreachable` consumes the 5-attempt budget (5s/15s/60s/300s backoff, written on
  the FIRST attempt — a terminal row has `next_poll_at = NULL`, which the claim
  reads as due, so without that the stuck rows would be re-claimed every tick).

Verified against a real corpus, not a fixture: the four genuinely stuck rows that
had accumulated in the dev database were all resolved to `result_lost` at exactly
attempt 5 with the specific message. A separately seeded run was recovered
end-to-end — result recaptured, `termination_reason` restored, Generation created
through the existing `createGenerationForRun()` — and a new run started normally
on a term holding four result-lost runs.

### Stage 6c: why the review screen shows two panels and no delta

The obvious design — "0 issues → 23 issues" — is wrong, and the screen
deliberately refuses to draw it.

`violations.current` comes from `constraint_violation`, which this app's
evaluator fills using **only the three structural double-booking rules**
(`violations.ts` says so). `violations.proposed` is the solver reporting on **all
14 constraint types**. They are different measurements of different things.

Measured, not assumed: on the same over-constrained timetable the solver reported
**23** hard violations, and after applying, `refreshViolations()` recorded **36
session-scoped rows plus 5 offering-scoped** — because the two evaluate different
rule sets. An arrow between those numbers would invent a comparison that does not
exist.

So the screen renders two labelled panels, each naming its own source ("checked
by Calendry — 3 structural rules" / "reported by the solver — 14 constraint
types") and an explicit line saying they are not a like-for-like difference.

**A true delta needs a dry-run evaluator** — running the app's own evaluator over
the proposed placements without writing them, so both sides are measured the same
way. That is real future scope, deliberately not built: it is a genuine feature,
not a tweak, and faking it with the numbers available would be worse than saying
so.

### Tracked gap: a page must not depend on permissions its own gate does not imply

Found in 6c verification. `/schedule/review/[id]` is gated on `session.read` (the
preview endpoint's permission), but its reference fetch called `/api/offerings`,
which requires `offering.read`. The `viewer` role has the former and not the
latter, so one 403 inside a `Promise.all` rejected the whole handler and rendered
a **completely blank page** — not an error, not a partial view, nothing.

Fixed twice over: offering names now travel with the preview response, under that
route's own gate; and the remaining reference fetches are individually tolerant,
degrading to showing ids rather than blanking the page.

The general rule, worth applying to any new page: **enumerate every endpoint a
page calls and confirm each is covered by the permission the page is gated on.**
A `Promise.all` of reference fetches turns one missing permission into a blank
screen, which is the least diagnosable failure a UI has.

### Tracked gap: solver violations naming Sessions the solver invented

`SolverOutput.hard_violations` identifies Sessions by id, but for a Session the
solver INVENTED the two id spaces in the same response do not agree:

- `PlacedSession.session_id` is **empty** (953 of 993 placements in the Stage 5
  over-constrained run).
- the violation names it with a synthetic `"<offeringId>#<index>"` key
  (`…-offering-6#19`), which appears **nowhere** in the placements.

So there is no join key. The app cannot attach such a violation to the Session
row it just created, because nothing links the synthetic id to the placement that
produced it. Measured: of 36 session references across 18 `GroupDoubleBooking`
violations, **7 resolved and 29 did not** — exactly the 29 that named invented
Sessions.

`materializeGeneration()` counts these in `violationsUnmapped` rather than
dropping them silently, which is the right behaviour but not a fix. Closing it is
a cross-repo change and belongs with the solver, which needs to give a
newly-created `PlacedSession` a **stable, joinable reference** in violation
reports — most likely its INDEX in the output `sessions` list, rather than an
empty `session_id` paired with a synthetic key that appears nowhere else.
**Do not "fix" it here by guessing a mapping from offering + slot.**

In practice the loss is currently masked — `refreshViolations()` runs after
materialize and re-derives the structural violations from the applied rows, so
the group clashes end up recorded anyway. It would NOT be masked for any
violation type the app's own evaluator cannot compute.

### `bun run create:account` — adding an account to an EXISTING tenant

`provision:tenant` creates a tenant and its first admin. Nothing could add a
SECOND account to a tenant that already exists, which is why `vic@demo.local`
became a hand-inserted SQL artifact and why verification work kept borrowing —
and resetting — the real admin's credential twice over.

    bun run create:account -- --tenant test --email someone@example.edu \
        --name "Given Family" [--role tenant-admin] [--password …]

Owner connection, audited to stdout, same CLI-not-endpoint reasoning as
`provision:tenant` and `reset:password`. An email that already has an Account is
REUSED rather than duplicated — one credential acting in several tenants through
`account_person` is the point of a tenant-independent login — and its password is
left untouched.

`verify@calendry.local` in the `test` tenant is the dedicated HTTP-verification
account. Use it for route testing rather than a human's credential. **Its current
password lives in the gitignored `.env` as `VERIFY_ACCOUNT_PASSWORD`** — recorded
there rather than here because `.env` is not committed and this file is. Assume no
fixed value: it is rotated with `bun run reset:password -- --email
verify@calendry.local`, which prints a one-time password that must then be changed
through `POST /api/auth/change-password`. Update `.env` when you rotate it, or the
next session rediscovers the same dead end.

`vic@demo.local` and `viewer6b@calendry.local` are the two **under-privileged**
accounts, both holding the `viewer` role (six read permissions, deliberately
neither `solver.trigger` nor `generation.apply`). Use one of them whenever a
check is about an affordance being ABSENT — and remember the rule that goes with
it: assert the surrounding page rendered too, or the test passes for the wrong
reason. Their passwords are in `.env` as `VIC_ACCOUNT_PASSWORD` and
`VIEWER_ACCOUNT_PASSWORD`. Recreate the whole set on a rebuilt database with
`create:role` followed by two `create:account` calls.

### Tracked gap: severity is validated too late

`shared/constraintTypes.ts` pins a fixed severity per constraint type — a
double-booked room is not a preference, and "avoid Saturdays" is not a defect.
The rule builder honours that (it renders severity as static text when pinned),
but the **generic CRUD API accepts whatever it is given**, so a row saying
`no_double_booking_room` is SOFT with a weight can be created directly through
`POST /api/constraints`.

The wire has no severity field at all — the TYPE determines hard/soft — so
Stage 3d's mapper sends the CATALOGUE's severity and reports the contradiction
in `report.severityMismatches`. That is the right behaviour at solve time, but
it is the wrong PLACE to catch it: the row should not have been storable.

The more correct fix is for the resource's zod schema to reject a severity that
contradicts the catalogue at write time, which needs `RESOURCES.constraints` to
consult `CONSTRAINT_TYPES` in a refinement. Not done — flagged so the eventual
fix lands at the write boundary rather than accumulating more downstream
compensation.

### The duplicate constraint: RESOLVED, and what it revealed

The `test` tenant had two enabled `minimize_exam_week_sessions` rows (weights 5
and 10). It was neither a deliberate duplicate nor kind-scoping: one of them was
named **"Cap online share per group"** — the catalogue label of a DIFFERENT type
— and the two were created eighteen seconds apart while exercising the Step 13
builder.

That mismatch was a real bug in `ManageConstraintBuilder.selectType()`, which
auto-filled the name only when it was blank. Choosing a type, then changing your
mind, updated the type and left the first type's label behind. Because `type` is
`createOnly`, the resulting row could never be corrected by editing — only
deleted and recreated. Fixed: the name now follows the type whenever it is still
an untouched auto-fill, and is never overwritten once someone types their own.
The mislabelled row was deleted through the API.

### `bun run create:role` — creating an AccessRole in an EXISTING tenant

Found while rebuilding the dev database after it was wiped: `provision:tenant`
mints exactly one role (`tenant-admin`, at creation) and `grant:permissions` only
widens a role that already exists, so nothing could create a new one and
`create:account --role viewer` failed outright. Permission-gated regression
checks — the 6b solver-control gate, the 6c viewer check — could not run at all.

    bun run create:role -- --tenant test --key viewer --name "Schedule Viewer" \
        --permissions session.read,group.read,room.read [--description …] \
        [--dry-run] [--yes]

**This is the one operator CLI whose writes do not need ownership**, and that was
verified against the live database rather than assumed. `access_role`,
`access_role_permission` and `person_access_role` are ordinary tenant-scoped
tables carrying `tenant_isolation` with both USING and WITH CHECK, so the app
role writes them happily once `calendry.tenant_id` is set — and is refused with a
foreign `tenant_id` in the payload, or with no context at all.

What the app role *cannot* do is resolve `--tenant <slug>` to an id: `tenant`'s
policy is `id = current_tenant_id() OR federation_id = current_federation_id()`,
so finding a tenant by slug requires already knowing which tenant you are. A
fifth `SECURITY DEFINER` lookup would fix that and was deliberately declined —
"an operator CLI would like a nicer argument" is not the comparably strong reason
the four existing exceptions each have.

So the owner connection resolves the slug, and the transaction then drops to
`SET LOCAL ROLE calendry_app` with tenant context before writing anything. That
narrows the write PATH, not the credential. What it buys is that a **mismatched
pair cannot be written**: `access_role.tenant_id` and
`access_role_permission.tenant_id` must both equal the context, so a bug
resolving the wrong tenant is refused by the database instead of quietly landing
a role in it. Pinned by `tests/access-role-writability.test.ts`, whose negative
cases are the point — a suite asserting only "the app role can write a role"
passes just as well against a build with `tenant_isolation` dropped entirely.

**There is deliberately no `--all`.** `provision:tenant` already mints a
full-catalogue `tenant-admin`, so a second one is an unaudited second superuser
role per tenant; more to the point, a role granted "everything" once silently
stops being everything the next time a permission is added — the same drift
`grant:permissions --all-missing` exists to repair. Compose it from two audited
steps instead.

Duplicates fail loudly and are never upserted (a second row that looks like the
first is worse than an error — see the mislabelled constraint below), and a role
whose *display name* collides with an existing one warns without blocking, since
`name` is not unique but silence is how "Cap online share per group" came to
label a `minimize_exam_week_sessions` row.

Assignment stays with `create:account --role <key>`; granting a role to a person
who already exists is still Step 14.

### Step 14: AccessRole management has no UI and no API

Tenant roles are editable **only by operator CLIs**: `provision:tenant` (grants
the whole catalogue to `tenant-admin` at creation), `create:role` (composes a new
role from an explicit permission list) and `grant:permissions` (backfills onto an
existing role). A tenant admin still cannot compose a role, and no route is
behind any of it:

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
- **A rebuilt dev database has one role and one account.** To restore the
  under-privileged accounts the permission-gated checks need:
  `bun run create:role -- --tenant test --key viewer --name "Schedule Viewer"
  --permissions session.read,group.read,room.read,person.read,term.read,time_grid.read`,
  then `create:account` twice against `--role viewer`.

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

### The solver runs as a compose service, and has two addresses

`docker compose up` now brings up app, database AND solver. The solver is a
vendored git submodule at `vendor/calendry-solver`, built by
`.config/Dockerfile.solver` — the Dockerfile lives HERE rather than in the solver
repo so the whole stack is described in one place, and nobody needs a second
checkout to get a working environment.

**It has its own nested submodule.** `calendry-proto` sits at
`vendor/calendry-solver/vendor/calendry-proto`, so a plain `git submodule update
--init` is not enough — it needs `--recursive`, or the Rust build fails in
`build.rs` with a (very clear) message about the proto directory being absent.

**`CALENDRY_SOLVER_ADDR` means two different things**, which is the trap to know:

- on the **solver** it is where to BIND. Its own default is `127.0.0.1:50051`,
  which inside a container is reachable by nothing, so the compose service sets
  `0.0.0.0:50051`.
- on the **app** it is where to CONNECT.

That is why a host-run solver was unreachable from the app container twice: the
address was right for a host-run app and meaningless from inside a container, and
the solver was bound to loopback so even the bridge gateway was refused.

**Two addresses, same pattern as the two database URLs.** `solver:50051` resolves
only on the compose network; `bun run test` starts a Nuxt server on the HOST,
where it does not. So `solverAddress()` picks by testing for `/.dockerenv`,
exactly as `scripts/lib/ownerDatabaseUrl.ts` does — `CALENDRY_SOLVER_ADDR` inside,
`CALENDRY_SOLVER_ADDR_HOST` outside. Port 50051 is published in the dev override
for the same reason 55432 is: host-side tooling. Production publishes neither.

**`docker compose up -d <service>` does not start what it does not name.** Bringing
up only `solver` and `calendry-app` left the database stopped and every test
failed with "Can't reach database server at 127.0.0.1:55432", which looks like a
configuration bug and is not one. Use a bare `docker compose up -d`.

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

- ~~**Raw-SQL account artifacts in the `test` tenant.**~~ **BOTH RESOLVED.** Each
  was originally written directly to the database, bypassing the paths that would
  normally create them; each now exists only through an operator CLI. Kept here
  because the reasoning is the record of why those CLIs exist at all:

  - ~~**`ntill@gmx.de`'s password was set by hand.**~~ **RESOLVED.** Replaced
    through the real path by `bun run reset:password`, which hashes via
    `hashPassword()` from `server/utils/auth.ts`, revokes every session, sets
    `must_change_password`, and emits an audit line. The password was then
    changed through `POST /api/auth/change-password`. No hand-written hash
    remains for this account. (The duplicate scrypt implementation that made
    this a risk is also gone: `provision-tenant.ts` now imports the same
    `hashPassword()` rather than carrying its own copy.)
  - ~~**`vic@demo.local`** is a hand-inserted Person + Account + `viewer`
    AccessRole.~~ **RESOLVED.** Both it and `viewer6b@calendry.local` are now
    created through `bun run create:role` + `bun run create:account`, with no raw
    SQL anywhere in the path. Their passwords live in the gitignored `.env` as
    `VIC_ACCOUNT_PASSWORD` / `VIEWER_ACCOUNT_PASSWORD`.

    **The role holds SIX permissions, not the seven previously recorded here.**
    The original raw SQL listed seven, but vic's live `GET /api/auth/session`
    reported six, and `session.get.ts` applies no filtering — it returns
    `loadPermissions()` verbatim — so one INSERT never landed. The measurement
    overrides the written record. The set is:

        group.read, person.read, room.read, session.read, term.read, time_grid.read

    `violation.read` was intended and absent. Recreated as six deliberately,
    because six is what the 6b/6c evidence was actually gathered against.

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

- **~~`CommonButton` renders a `<div>`~~ — FIXED.** It rendered a `<div>` with a
  click handler, so every action built on it — the whole schedule inspector, the
  solver control, the palette — was mouse-only: no Tab, no Enter/Space, not
  announced as a button. `getTag` now defaults to `'button'` (including the
  disabled case, so assistive tech hears "unavailable" rather than nothing).

  Two things that made this less trivial than it looks, worth not rediscovering:

  - **`type` was already taken** by the visual variant (`primary`,
    `secondary-black`…), so the native button type needed its own prop:
    `nativeType`, defaulting to `'button'`. Without that default, changing the
    tag would have turned every button inside a `<form>` into an accidental
    submit.
  - **`login.vue` and `change-password.vue` depended on native submit.** They
    passed `tag="button"` with NO `@click`, relying on the form's
    `@submit.prevent` so Enter works in either field. They now pass
    `native-type="submit"` — verified by pressing Enter in the password field and
    landing on `/`.

  A native `<button>` also inherits the UA font rather than the page's, so
  `font: inherit` was added to `.button`; computed font now matches `body` on
  every page.

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