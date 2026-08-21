/**
 * Block boundaries: the one definition of when each block starts.
 *
 * WHY `shared/` AND NOT app/ OR server/
 * -------------------------------------
 * Two consumers need identical arithmetic and must not drift:
 *
 *   app/composables/schedule.ts   `blockTime()`   — what a block is called
 *   server/utils/solverCalendar.ts `blockOfMinute()` — which block "now" is in
 *
 * They answer inverse questions about the same timeline. If they disagreed, the
 * schedule would render one time while `reference_slot` believed another, and
 * the disagreement would be invisible until the solver refused to move a
 * Session a user could plainly see was still in the future.
 *
 * WHY A WALK AND NOT A STRIDE
 * ---------------------------
 * Both sites previously divided by a constant:
 *
 *     start = dayStart + index * (blockLength + breakMinutes)
 *
 * That is exactly right while every gap is the same, and wrong the moment one
 * is not. A 45-minute lunch after block 3 shifts every later block, and no
 * single divisor expresses it. So boundaries are ACCUMULATED instead, and both
 * helpers become lookups into the result.
 *
 * The uniform case is not a special path through this code — it is what the
 * walk produces when no override applies, which is asserted directly by the
 * equivalence property in `tests/time-grid-breaks.test.ts`.
 *
 * WHAT THIS IS NOT
 * ----------------
 * None of it reaches the solver. The wire carries block INDICES, and a gap's
 * duration changes no index, no adjacency and no conflict — see
 * `toWireTimeGrid()`, which deliberately omits break data and has a test
 * asserting the omission.
 */

/** A named gap that replaces the default `breakMinutes` at one position. */
export interface TimeGridBreak {
    /** The gap FOLLOWS this 0-based block index. */
    afterBlockIndex: number;
    durationMinutes: number;
    label: string;
    /**
     * `null` applies on every active day. A row naming a specific ISO weekday
     * (1 = Monday … 7 = Sunday) beats the universal one at the SAME
     * `afterBlockIndex`, and only there — so "same lunch every day, but Friday's
     * afternoon break differs" needs one extra row, not a duplicated day.
     *
     * Same null-means-universal shape as `ConstraintScope`.
     */
    dayOfWeek: number | null;
}

/** The shape both callers already have; `breaks` is optional so a grid without
 *  overrides — every grid, before this feature — behaves exactly as before. */
export interface BlockGrid {
    blocksPerDay: number;
    blockLengthMinutes: number;
    startHour: number;
    startMinute: number;
    breakMinutes: number;
    breaks?: TimeGridBreak[];
}

/**
 * The gap after `afterBlockIndex` on `dayOfWeek`, in minutes.
 *
 * Precedence is day-specific → universal → the grid default, resolved per
 * POSITION rather than per day: a Friday override at block 6 does not displace
 * the universal lunch at block 3.
 *
 * `dayOfWeek === null` means "no particular day", and deliberately sees only
 * universal overrides — that is the honest answer for a caller that has not
 * said which day it means, and it is what keeps the pre-existing two-argument
 * callers correct.
 */
export function gapAfter(
    grid: BlockGrid,
    afterBlockIndex: number,
    dayOfWeek: number | null = null,
): number {
    const overrides = grid.breaks ?? [];
    const at = overrides.filter((b) => b.afterBlockIndex === afterBlockIndex);

    const specific = dayOfWeek === null
        ? undefined
        : at.find((b) => b.dayOfWeek === dayOfWeek);

    return (specific ?? at.find((b) => b.dayOfWeek === null))?.durationMinutes
        ?? grid.breakMinutes;
}

/**
 * Start minute of every block on `dayOfWeek`, plus one final entry: the minute
 * teaching ends.
 *
 * Length is always `blocksPerDay + 1`. The trailing entry is what lets a caller
 * say "teaching ends at" and "this time is past the last block" without
 * re-deriving the last block's length, which is the kind of duplicated
 * arithmetic this file exists to remove.
 *
 * Minutes are measured from local midnight and are NOT wrapped at 24h — a grid
 * that runs past midnight produces values above 1440, so callers can detect it
 * rather than seeing a plausible-looking early-morning time.
 */
export function blockBoundaries(grid: BlockGrid, dayOfWeek: number | null = null): number[] {
    const out: number[] = [grid.startHour * 60 + grid.startMinute];

    for (let i = 0; i < grid.blocksPerDay; i += 1) {
        const end = out[i]! + grid.blockLengthMinutes;

        // The gap AFTER the final block is never walked: there is no block for
        // it to push, and including it would overstate when teaching ends.
        out.push(i === grid.blocksPerDay - 1 ? end : end + gapAfter(grid, i, dayOfWeek));
    }

    return out;
}

/** Start and end minute of one block. */
export function blockSpan(
    grid: BlockGrid,
    blockIndex: number,
    dayOfWeek: number | null = null,
): { start: number; end: number } {
    const bounds = blockBoundaries(grid, dayOfWeek);
    const start = bounds[blockIndex] ?? bounds[bounds.length - 1] ?? 0;

    return { start, end: start + grid.blockLengthMinutes };
}

/**
 * Which block contains `minutesSinceMidnight`, or the number of blocks already
 * finished when the time falls in a gap or past the last block.
 *
 * Preserved from the stride version, and the reason this is a scan rather than
 * a division: a time inside a BREAK counts as the preceding block being
 * finished, not as the next one having started. With a uniform stride that fell
 * out of `Math.floor`; here it has to be stated, and stating it is better —
 * it was never obvious from the arithmetic.
 */
export function blockAtMinute(
    grid: BlockGrid,
    minutesSinceMidnight: number,
    dayOfWeek: number | null = null,
): number {
    const bounds = blockBoundaries(grid, dayOfWeek);

    if (minutesSinceMidnight < bounds[0]! || grid.blocksPerDay <= 0) {
        return 0;
    }

    for (let i = 0; i < grid.blocksPerDay; i += 1) {
        // Inside block i, or inside the gap that follows it: either way, i
        // blocks have started and i is the answer while the block runs.
        if (minutesSinceMidnight < bounds[i + 1]!) {
            return i;
        }
    }

    // Past the end of teaching. Clamped to blocksPerDay — the count of blocks
    // finished — rather than an index that does not exist.
    return grid.blocksPerDay;
}
