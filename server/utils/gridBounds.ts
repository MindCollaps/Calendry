import type { Tx } from './tenantDb';

/**
 * Whether a placement resolves to a real slot in a TimeGrid.
 *
 * WHY THIS IS A HARD GUARD AND NOT A WARNING
 * ------------------------------------------
 * "Warn and allow" (TAXONOMY.md §3) covers hard-CONSTRAINT violations from
 * manual edits, and its mechanism is `constraint_violation` — a queryable row
 * keyed to a `constraint_id`. "Sits outside the grid" is not one of the 14
 * catalogue types and cannot become one: it is not a rule a tenant configures,
 * it is the precondition for the Session being expressible at all. There is
 * literally nowhere to record the warning, so warn-and-allow has no vehicle
 * here.
 *
 * The failure mode is also different in kind. A constraint violation is a
 * schedule that is worse; this is a Session that resolves to no time. `blockTime()`
 * computes a wall clock for a block that does not exist, and the solver refuses
 * the whole run:
 *
 *     INVALID_ARGUMENT: session '…-session-3-1' sits at week 0 day 1 block 4,
 *     which is not a slot in this tenant's grid
 *
 * That is not hypothetical. Shrinking the demo tenant's grid from 8 blocks to 4
 * orphaned 7 of 16 Sessions, and the next solver run failed 86 seconds later —
 * then went unnoticed for two days, because nothing between the edit and the
 * solver looks at the grid.
 *
 * WHAT IS DELIBERATELY NOT CHECKED
 * --------------------------------
 * `blockLengthMinutes`, `startHour`, `startMinute` and `breakMinutes` move what
 * a block is CALLED on a clock. They cannot orphan anything, because the index
 * space is `blocksPerDay x activeDays` and none of them touch it. Checking them
 * would reject harmless edits and teach people to distrust the guard.
 */
export interface GridBounds {
    blocksPerDay: number;
    activeDays: number[];
}

export interface Placement {
    dayOfWeek: number;
    blockIndex: number;
    durationBlocks: number;
}

/**
 * The single definition, shared by the grid editor and the move route.
 *
 * Both directions of the same defect: narrowing a grid under a Session, and
 * moving a Session outside its grid. One predicate so they cannot disagree
 * about what "outside" means — a guard that two call sites spell differently is
 * a guard that eventually only holds on one of them.
 *
 * Block indices are 0-based (`blockOfMinute()` floors from zero, and the demo
 * seed emits `% (blocksPerDay - 1)`), so a Session occupying `[b, b + d)` needs
 * `b + d <= blocksPerDay`.
 */
export function fitsGrid(placement: Placement, grid: GridBounds): boolean {
    return placement.blockIndex >= 0
        && placement.durationBlocks >= 1
        && placement.blockIndex + placement.durationBlocks <= grid.blocksPerDay
        && grid.activeDays.includes(placement.dayOfWeek);
}

/** One offending Session, with enough context to find it in the UI. */
export interface OrphanedSession {
    id: string;
    title: string | null;
    dayOfWeek: number;
    blockIndex: number;
    durationBlocks: number;
}

interface OrphanRow extends OrphanedSession {
    total: bigint;
}

/** How many offenders to name before falling back to "and N more". */
const NAMED_LIMIT = 5;

/**
 * Sessions on `gridId` that would not fit `bounds`.
 *
 * Raw SQL because the test compares two COLUMNS (`block_index + duration_blocks`
 * against a bound), which Prisma's filter language cannot express — the
 * alternative is fetching every Session for the grid and filtering in memory,
 * which is a full table read on the one path that must stay cheap enough to run
 * on every grid edit.
 *
 * `count(*) OVER ()` returns the true total alongside the capped list, so the
 * message can say "7 Sessions" while naming five. Runs inside the caller's
 * tenant transaction, so RLS scopes it.
 */
export async function sessionsOutsideGrid(
    tx: Tx,
    gridId: string,
    bounds: GridBounds,
): Promise<{ total: number; named: OrphanedSession[] }> {
    const rows = await tx.$queryRaw<OrphanRow[]>`
        SELECT s.id,
               o.title,
               s.day_of_week     AS "dayOfWeek",
               s.block_index     AS "blockIndex",
               s.duration_blocks AS "durationBlocks",
               count(*) OVER ()  AS total
          FROM session s
          LEFT JOIN offering o ON o.id = s.offering_id
         WHERE s.time_grid_id = ${gridId}
           AND (
                s.block_index + s.duration_blocks > ${bounds.blocksPerDay}
                OR NOT (s.day_of_week = ANY(${bounds.activeDays}::int[]))
               )
         ORDER BY s.day_of_week, s.block_index
         LIMIT ${NAMED_LIMIT}
    `;

    return {
        total: rows.length ? Number(rows[0]!.total) : 0,
        named: rows.map(({ total: _total, ...row }) => row),
    };
}

/**
 * Human-readable refusal, bounded so a large tenant gets a usable message
 * rather than a wall of ids.
 */
export function describeOrphans(total: number, named: OrphanedSession[]): string {
    const lines = named.map((s) => (
        `${s.title ?? 'Session'} — day ${s.dayOfWeek}, block ${s.blockIndex}`
        + (s.durationBlocks > 1 ? ` (${s.durationBlocks} blocks)` : '')
    ));

    if (total > named.length) {
        lines.push(`…and ${total - named.length} more`);
    }

    return `${total} existing Session${total === 1 ? '' : 's'} would fall outside this TimeGrid: `
        + `${lines.join('; ')}. Move or delete them first.`;
}
