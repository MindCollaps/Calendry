# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Three audiences share one schedule surface, with affordances gated by per-tenant
permissions rather than by separate screens (confirmed):

- **Timetablers / administrators** — power users who spend extended sessions
  constructing and repairing a term's timetable. They make many repeated edits.
- **Department heads** — review a mostly-solved schedule and make occasional
  targeted changes. They need confidence before committing a move.
- **Lecturers** — read-mostly view of the sessions that concern them.

The same screen serves all three; what changes is which affordances appear,
driven by the caller's permissions (`session.move`, `session.lock`, …).

## Product Purpose

Calendry is a multi-tenant calendar/timetabling platform for schools and
universities. It manages, stores and presents schedules; a separate solver
service (not in this repository) generates and optimises them. Success for this
surface is a user seeing the state of a term's schedule accurately and changing
a placement without fear of breaking something silently.

## Positioning

Two mechanisms a neighbouring calendar product could not truthfully copy:

- **Warn-and-allow editing.** A manual edit that breaks a hard constraint is
  permitted, not blocked, and the resulting violation is persisted as queryable
  state rather than a transient warning (TAXONOMY.md §3).
- **Nested-group conflict propagation.** A booking on a parent Group blocks its
  descendants and vice versa, resolved through a maintained closure table
  (TAXONOMY.md §6).

## Operating Context

- **Devices: desktop plus genuine mobile support** (confirmed). A week grid does
  not fit a phone, so the compact layout is a distinct presentation of the same
  data, not a squeezed grid. This rules out drag-and-drop as the only editing
  gesture.
- Editing happens against a term that is already largely placed; the common act
  is repairing one session, not building from an empty grid.
- Every mutation is recorded in an append-only event log with an actor, so edits
  are attributable.

## Capabilities and Constraints

- **Time is per-tenant.** Block length, blocks per day, active days and start
  hour come from the tenant's TimeGrid. Nothing about grid shape may be
  hardcoded — no assumed Mon–Fri, no assumed block count (TAXONOMY.md §2).
- **Scale is adjustable and varies by tenant** (user's words). The view must not
  assume a session count; filtering is central, and view density is intended to
  be adjustable rather than fixed. *Interpretation flagged for confirmation:
  taken to mean both "tenant size varies" and "the user can adjust how much is
  shown at once".*
- **Terminology is fixed** (TAXONOMY.md): `Offering` is recurring demand;
  `Session` is one placed occurrence. "Lecture", "Event" and "Class" are
  tenant-defined `kind` values, never entity names in the UI chrome.
- `Role` (scheduling vocabulary: Lecturer, Student) and `AccessRole`
  (authorization) are different concepts sharing a word.
- Timezone is per-Person and display-only; it must never affect grid resolution
  or "same day" logic.
- Available APIs: `GET /api/sessions` (filterable by term, week, group, room,
  person, with nested-group expansion), `GET /api/violations`,
  `POST /api/sessions/:id/move|swap|lock|unlock`, CRUD for time-grids, terms,
  groups, rooms, persons.
- Enforcement is server-side. Any client-side permission check is UX only.

## Brand Commitments

Name: **Calendry**. No logo, wordmark, typeface or palette has been specified;
the incumbent styling is inherited from an unrelated Nuxt template and is not a
brand commitment.

## Evidence on Hand

`TAXONOMY.md` (authoritative entity model), `CLAUDE.md` (architecture rules and
conventions), and a working API with 36 passing integration tests.

## Open Decisions

- Whether "adjustable scale" means a user-facing density control, tenant-size
  variability, or both.
- Whether lecturers reach this surface at all in v1, or only after a
  personal-schedule view exists.
