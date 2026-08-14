# Design

<!-- impeccable:design-schema 1 -->

Written from the built schedule surface, not ahead of it. Calendry's visual
system is inherited from the Nuxt template it started as; this records what the
first real product screen actually established, and where the inheritance stops
being adequate.

## Mode

**Operate.** Every surface so far is a task surface: someone is reading state
and changing it. Scanability, state clarity and familiar affordances outrank
expression. Brand lives in the precision of the details, not in ornament.

## Ground and color strategy

**Restrained** — neutrals carrying the whole surface, with one accent reserved
almost entirely for a single meaning.

### Why the base is light — stated honestly

**The base palette became light in Step 11 for a data reason, not a design
one.** That is worth recording plainly rather than dressing up.

The palette had two neutral ramps and two theme entries, `light` and `dark`,
whose override objects were byte-identical. Selecting "dark" rendered light.
Fixing that meant deciding which ramp is the base, and light-as-base was the
call. No fresh argument about ambient light, session length or task ergonomics
drove it; the previous rationale below was not overturned on its merits.

The original reasoning still stands on its own terms, and is now actually
available instead of broken:

> A timetabler spends hours in this screen, indoors, often beside a second
> display. A dark ground keeps the session chips as the brightest thing in the
> field.

That argument is why **`dark` is a first-class theme rather than an
afterthought** — it is the ground this surface was originally composed for, and
under the current palette it renders exactly as it always did. If usage shows
timetablers living in dark, promoting it back to base is a one-object change
(`themesList`) and a rename, not a redesign.

What light-as-base *does* earn: it is the safer default for the audiences who
are not timetablers. Department heads and lecturers open this occasionally, in
ordinary office light, alongside documents and mail that are light. A dark
default for an occasional reader is a stronger opinion than this product has
grounds to hold.

### Ramp naming

Tokens are named by **role and distance from the ground**, never by lightness:

- `surface0…surface7` — the page ground outward
- `content0…content7` — what sits on those surfaces

This replaced `darkgray*` / `lightgray*`, which described values in one theme
and lied in the other: theming worked by swapping the two ramps, so
`$darkgray950` rendered near-white and 221 call sites read backwards. Under role
names, `surface1` is the second surface layer in every theme and only its value
changes.

| Role | Token | Use |
|---|---|---|
| Page ground | `$surface1` | Body background |
| Recessed cells | `$surface0` | Empty grid cells — one step *toward* the ground, so the grid reads as inset |
| Raised surfaces | `$surface1` | Toolbar, inspector, panels |
| Session chip | `$surface3` → `$surface4` on hover | The only routinely raised object |
| Hairlines | `$surface5` | Grid gaps, control borders |
| Primary text | `$content4` / `$content2` | Titles |
| Secondary text | `$content6` | Labels |
| Tertiary text | `$surface7` | Metadata, disabled |

**The accent is spent on one idea: where a session may land.** `$primary400/500`
appears on placement-mode cells, focus rings, selection outline, and the active
violations toggle — all of them "the system is offering you something". It is
never decorative. A surface where violet appears everywhere has lost that
signal.

State colors are separate and mean only themselves: `$error300` hard violation,
`$warning300/400` soft violation.

`color-scheme` is declared (`light` on `:root`, `dark` under `.theme-dark`) so
native surfaces we do not draw — form controls, default scrollbar rendering —
follow the palette instead of the user agent's own assumption.

## Type

Noto Sans throughout (already self-hosted via `@nuxt/fonts`). A workhorse UI
face is the right register for Operate; a display face with a point of view
would be fighting the data.

Scale is deliberately compressed — 11px labels through 17px titles — because
density is the point. Two rules matter more than the sizes:

- **Tabular numerals** (`font-variant-numeric: tabular-nums`) on every clock
  time, week number and count. Without it the time column shivers row to row.
- **Uppercase 11px + `0.05em` tracking** is the label register, used for field
  labels and section headings. Nothing else is uppercase.

## Grid geometry

The schedule grid is one CSS Grid with two layers in the same coordinate space:
a cell layer (background, hit targets) and a session layer placed by explicit
`grid-column` / `grid-row: span n`. This is what lets a multi-block session span
rows without absolute positioning or a second measurement pass.

**Every dimension is data.** Columns come from `TimeGrid.activeDays` in array
order; rows from `blocksPerDay`; row labels from `startHour`, `startMinute`,
`blockLengthMinutes` and `breakMinutes`. There is no fallback shape anywhere in
the CSS or the components — a tenant with no TimeGrid gets an empty state, not a
guessed Mon–Fri week. This is a schema-level rule (TAXONOMY.md §2), not a
preference.

Density is user-adjustable through a single `--row-height` custom property
(44 / 60 / 84px).

## Components

`Common*` components are inherited and reused as-is (`CommonButton`,
`CommonLoader`). Schedule-specific components live under
`app/components/schedule/` and are not general-purpose:

- `ScheduleGrid` — geometry and the cell/session layering
- `ScheduleSessionChip` — the one repeated object, shared by grid and agenda
- `ScheduleInspector` — details, violations, actions
- `ScheduleAgenda` — the mobile presentation

## Responsive strategy

**Not a scaled grid.** Below 1365px the week grid is replaced outright by a day
agenda with a day switcher — the same data and the same chip component, a
different structure. A seven-column grid on a phone is unreadable at any scale,
and the product must genuinely work there.

## State and feedback

- **Violations never signal by hue alone.** Every one carries an icon
  (`error` filled for hard, `warning-outline` for soft), a background tint, and
  screen-reader text. A red chip and an amber chip are distinguishable in
  greyscale.
- **Violations appear in three places on purpose**: a marker on the chip, the
  full list in the inspector, and a count in the toolbar that opens a panel.
  Warn-and-allow means a violation persists after the edit that caused it, so it
  has to be findable without hunting.
- **Permission-gated affordances**: a caller without `session.move` never sees a
  Move control. Client-side only — the server re-checks every call.
- Required states implemented: loading, error, no-TimeGrid, no-terms, nothing-on-
  this-day, nothing-selected, and the off-grid tray for sessions the grid cannot
  position.

## Motion

One authored moment: entering placement mode. Candidate cells reveal a dashed
violet target on hover/focus, and unselected sessions dim to 0.35. Everything
else is a 140ms `cubic-bezier(0.16, 1, 0.3, 1)` ease-out on hover — present, not
noticed. All of it collapses under `prefers-reduced-motion`.

## Browser surfaces

Themed rather than left to the user agent: text selection (violet at 45%),
`:focus-visible` rings, and scrollbars (`scrollbar-color`, thin).

## Theming

Runtime theming works as of Step 10. `useLayout()` emits 48 colour custom
properties on `:root` per request, read from the generated `calendryColors` /
`calendryThemes`. Sizing tokens (`--font-size-*`, `--radius-*`, `--space-*`) are
emitted statically once from `app/scss/tokens-root.scss`, because they do not
vary by theme.

Verified by parsing the served HTML at each setting: `default` and `dark` differ
on every ramp property, and `default` renders the light ground.

**Open:** most components still carry hardcoded font-size, radius and spacing
literals (~40 / ~26 / ~70). New work uses tokens; the retrofit is tracked in
CLAUDE.md as a standalone pass.
