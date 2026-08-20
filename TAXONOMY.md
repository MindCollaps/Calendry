# Calendar/Timetabling Platform — Taxonomy & Architecture Decision Record

Status: working draft, pre-init-prompt. Captures decisions made in planning discussion, plus explicitly flagged open items. Not yet an implementation spec.

---

## 1. Guiding principle

Two layers, by design:

- **Fixed core taxonomy** ("carved in stone") — the entity types themselves and their relationships. Changing these later is a migration, not a config change.
- **Open, tenant-configurable vocabulary** — the *values* that populate the fixed entities (role names, equipment tags, session kinds, constraint parameters). Institutions extend this freely without touching the schema.

Everything below is tagged **[FIXED]** or **[OPEN]** accordingly.

---

## 2. Core entities

### Organizational hierarchy
- **`Federation`** [FIXED] — optional parent grouping of tenants that share resources (e.g. a university consortium sharing a cross-enrolled elective, a shared lecture hall). Owns resources that member tenants can reference.
- **`Tenant`** [FIXED] — a single institution (school, university). Fully data-isolated except for explicitly Federation-owned/shared resources. Multi-tenant from day one.

### People & roles
- **`Person`** [FIXED] — the only person entity. No separate Student/Lecturer/Staff tables.
- **`Role`** [OPEN, tenant-defined] — attached to a Person. `Lecturer` is the one fixed, universal role name (the person who leads a Session). All other roles (Student, Auditor, External Participant, Teaching Assistant, ...) are tenant-defined vocabulary.

### Grouping
- **`Group`** [FIXED] — a class, cohort, seminar group, etc. **Supports nesting** (parent/child hierarchy — e.g. Cohort → Class → Seminar Group).
- **`Membership`** [FIXED relation] — Person ↔ Group.
- Conflict rule: **a scheduling conflict on a parent Group propagates to block its child Groups** (and vice versa should be checked at implementation time — needs an ancestor/descendant closure structure, see §6).

### Space
- **`Room`** [FIXED] — has capacity, a ranking/desirability value (from prototype), and location.
- **`Equipment` / `Feature`** [OPEN, tenant-defined] — tags on a Room (projector, PC lab, lab bench, etc.), referenced by Offerings that require them.
- Online delivery is modeled as a **virtual Room** (per prototype's `raum_online` pattern), not a separate boolean flag — keeps room-assignment logic uniform.

### Federation-shared events — amendment (decided later, see solver decision record §10)

`Session` is now a **third federation-shareable entity**, alongside `Room`
and `Offering` — the exception is no longer limited to two tables.
Reasoning: a genuinely shared event spanning multiple tenants (e.g. a
university-wide celebration when Technology and Medicine are separate
tenants under one Federation) is one event, not a coincidence of two
identical events each tenant independently tracks. `Session` gets the
same `tenant_id`/`federation_id` nullable pair + `CHECK` exactly one is
set + RLS predicate (`tenant_id = current_tenant() OR federation_id =
current_federation()`) that `Room`/`Offering` already have.

**Implemented in Stage 7c, with one deliberate narrowing of the wording above.**

The original amendment said the relation tables (`session_group`,
`session_person`, `session_room`) would need their RLS extended to let a shared
Session reference Groups and Persons from *either* member tenant. Implemented
literally, that requires widening RLS on `group` and `person` — the two most
sensitive tenant-scoped tables in the system — so that Federation membership
would imply **roster visibility**. That is a far larger concession than sharing
one `session` row, and it is not what the use case needs.

What was built instead:

- **The Session row is shared.** `tenant_id`/`federation_id` nullable pair, a
  `CHECK` that exactly one is set, and the `tenant_or_federation_read` +
  `tenant_write` policy pair `room`/`offering` already use. Readable by every
  member tenant, writable by none of them.
- **`session_room` is widened**, following `room_equipment`'s precedent — an
  `EXISTS` against the parent Session's federation ownership. *Where* a shared
  event happens is genuinely shared information.
- **`session_group` and `session_person` stay tenant-private**, keeping their
  plain `tenant_isolation` policy. Each tenant sees the shared event and *its
  own* groups and people on it, and never the other tenant's.

A university-wide celebration is therefore one event both tenants see and attach
their own cohorts to, without either enumerating the other's people.

**The predicted notification consequence largely dissolves.** Because participant
links stay tenant-private, affected-person resolution does NOT need to walk
Membership trees across two tenants — each tenant resolves its own audience
through the existing per-tenant path, unchanged. A genuinely federation-wide
notification would need a privileged union, but that is Federation-level
permissions, which §9.4 places out of scope.

**No creation path exists yet, deliberately.** Nothing in the app can create a
federation-owned Session: doing so is a privileged action and federation-level
permissions remain out of scope (§9.4). Stage 7c makes the schema and RLS
*capable*; opening a door is a separate decision.

### Scheduling — two-level model
- **`Offering`** [FIXED] — the *demand* definition: "this needs to happen N times, needs a Lecturer with role X, a Group, a Room with equipment Y, kind Z." Roughly maps to the prototype's `lectures[lecture]` frequency concept. This is the solver's input.
- **`Session`** [FIXED] — one atomic, placed instance: a specific week/timeslot/room/lecturer(s)/group(s). This is what gets displayed, moved, swapped, locked, exported, notified-about. Solver output (and manual edits) operate at this level.
- **`kind`** [OPEN, tenant-defined, on Offering/Session] — replaces a fixed Lecture/Exam/Event split. Constraints must declare which kinds they apply to, since a tenant-defined kind (e.g. "staff_meeting") may not have a Group at all.
- **`Assignment`** [FIXED relation] — Session ↔ Group, Session ↔ Person (direct/individual), Session ↔ Room, Session ↔ Lecturer.

### Time
- **`TimeGrid`** [FIXED entity, per-tenant configured] — block length, blocks/day, active days, start hour. Not a global fixed grid (prototype's `timeslot % 3` arithmetic must NOT be hardcoded — it must resolve against each tenant's grid).
- **Academic calendar** [FIXED, core from day one] — Terms/Semesters, Holidays, Break weeks, Exam periods. Constraints like "minimize lectures in exam weeks" need this as structured data, not a magic slice of `weeks[-exam_weeks:]`.
- Internally, solving and grid logic happen in **single institution-local time**. Per-person timezone (see below) is a presentation-layer concern only — it must not leak into "same day" / "adjacent slot" constraint logic.

### Constraints
- **`Constraint`** [FIXED mechanism] — defined via a **structured rule builder**: predefined constraint types + parameters (extends the prototype's one-function-per-constraint pattern), not a free-form expression DSL.
- Each constraint type declares: hard vs. soft, which `kind`(s) it applies to, its parameters, and a penalty weight (if soft).
- Initial constraint library to port from the prototype (see §7).

---

## 3. Editing & history

- **Event-sourced-ish model**: solver runs produce an immutable, versioned **`Generation`** (snapshot). Manual edits are an **append-only event log** (`create`, `move`, `swap`, `delete`, `lock`) applied on top of a Generation to produce current state.
- **Locking**: a manually-placed/locked Session is **excluded** from the next solve — the solver only fills empty slots, never overwrites a lock.
- **Rollback**: full history via the event log; can replay to any prior point.
- **Conflict UX on manual edit**: **warn and allow** — a hard-constraint violation from a manual edit is flagged to the user but not blocked. (Implies the app needs a persistent "current violations" view, not just a one-time toast.)

---

## 4. Access control

- Permissions are **per-tenant, tenant-configured roles** — tenant admins define their own roles and what each can view/edit/lock/trigger-solve. Not a fixed global role enum.

---

## 5. Notifications

- Every Person **affected** by a Session change is notified. "Affected" resolves as: assigned Lecturer(s) + every Person with Membership in an assigned Group (walking the nested-group tree) + any directly-assigned individuals.
- This reuses the same ancestor/descendant resolution needed for conflict-checking (§6) — one resolution mechanism, two consumers (solver's double-booking check, notification fan-out).

---

## 6. Nested-group implementation note

Parent-blocks-child conflict propagation means "is Group G free at time T" requires checking G's full ancestor *and* descendant chain, not a flat lookup. This needs to be fast in two very different contexts:
- **DB queries** (UI, notifications): closure table (precomputed ancestor/descendant pairs) or recursive CTE.
- **Solver hot loop** (local search evaluates this on every candidate move, potentially millions of times): precomputed in-memory ancestor/descendant sets, not live tree walks.

Both need to stay in sync when the group tree changes — worth deciding the update strategy (recompute on write vs. background rebuild) before implementation.

---

## 7. Solver

- **Language**: leaning Rust, for GC-less predictability in the local-search hot loop and clean data-parallelism (`rayon`) for scaling from small-school to large-university instances. Go remains a valid fallback if team velocity matters more than the performance ceiling — not fully closed.
- **Algorithm**: hybrid — constructive heuristic to build an initial schedule, then local search / metaheuristic (simulated annealing or Large Neighborhood Search) to minimize soft-constraint penalties while respecting hard constraints. Optional exact-solve mode (CP-SAT-style) for small instances or small repair sub-problems.
- **Interface**: separate service, clean data contract (entities + constraints in, Session placements or infeasibility report out). Language choice must not leak into the Nuxt app.
- **Constraint library to port from prototype** (as structured rule-builder types):
  - Hard: exact frequency per Offering; no double-booking of Room+timeslot+week; no double-booking of Lecturer; no double-booking of Group (now: including nested-group propagation); Lecturer vetoes (day/slot blackout); online+on-site same-day exclusion per Group; max % online per Group (was hardcoded 30%, should become a parameter).
  - Soft: minimize first-block usage; minimize last-block usage; minimize Saturday (was hardcoded `timeslot > 14`, must resolve against TimeGrid instead); minimize high-ranking rooms; minimize sessions in exam weeks (must resolve against Academic Calendar instead of `weeks[-n:]`); minimize online sessions.

---

## 8. Data & interoperability

- **Import**: CSV/Excel import for legacy data onboarding, required for v1. Mapping mechanism (guided UI vs. fixed template) not yet decided — deferred, not urgent.
- **Export**: iCal / Google Calendar / Outlook export required for v1.
- **Timezone**: per-Person. Display/export-layer only; does not affect grid or solver logic.

---

## 9. Explicitly open items

1. Exact naming/shape confirmation for `Offering`/`Session` once real screens are designed (names are locked in principle, not yet battle-tested against UI copy).
2. Import schema-mapping UX (guided mapping vs. fixed template).
3. Ancestor/descendant sync strategy for nested Groups (write-time recompute vs. background rebuild).
4. Whether Federation-level resources need their own permission model distinct from Tenant roles.
5. Whether `kind`-scoped constraints need a validation step to prevent nonsensical combinations (e.g. a Group-based constraint applied to a groupless `kind`).

---

## 10. Reference material

- Prototype: TimeCraft (prior student project), CP-SAT-based solver using OR-Tools, in Python. Provided hard/soft constraint snippet is the basis for §7's initial constraint library.