import { describe, expect, it } from 'vitest';
import { blockAtMinute, blockBoundaries, blockSpan, gapAfter } from '../shared/timeGrid';
import type { BlockGrid, TimeGridBreak } from '../shared/timeGrid';
import { blockOfMinute } from '../server/utils/solverCalendar';

/**
 * The cumulative block walk that replaced a uniform stride.
 *
 * WHY THIS IS CORRECTNESS WORK AND NOT RENDERING. `blockOfMinute()` feeds
 * `computeReferenceSlot()`, and that decides which Sessions the solver may
 * move — "Sessions starting strictly before this slot are excluded from
 * recalculation, a correctness rule, not a preference". A block-from-clock that
 * is one out does not produce an ugly label; it lets the solver reschedule a
 * class that already happened, or refuse to touch one that has not.
 *
 * THE ACCEPTANCE GATE IS tests/solver-calendar.test.ts, UNMODIFIED. Its 25
 * assertions were written against the stride version and are the definition of
 * "the uniform case still works". Nothing here replaces them; this file adds
 * what they could not cover, starting with the property that makes the whole
 * rewrite safe.
 */
const UNIFORM: BlockGrid = {
    blocksPerDay: 8,
    blockLengthMinutes: 45,
    startHour: 8,
    startMinute: 0,
    breakMinutes: 15,
};

/** Lunch after block 3, universal. Friday gets a longer afternoon gap at 6. */
const LUNCH: TimeGridBreak = { afterBlockIndex: 3, durationMinutes: 45, label: 'Lunch', dayOfWeek: null };
const FRI_PM: TimeGridBreak = { afterBlockIndex: 6, durationMinutes: 30, label: 'Friday break', dayOfWeek: 5 };

const NON_UNIFORM: BlockGrid = { ...UNIFORM, breaks: [LUNCH, FRI_PM] };

/** The days a grid shaped like UNIFORM would actually teach. */
const UNIFORM_ACTIVE_DAYS = [1, 2, 3, 4, 5];

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

describe('the uniform case is unchanged — the property the rewrite rests on', () => {
    it('reproduces the old stride arithmetic at every index, across many grids', () => {
        // THE central assertion. If the walk and `dayStart + i * (len + gap)`
        // ever disagree for a grid with no overrides, the rewrite changed
        // behaviour it was supposed to preserve — and the Stage 3a suite would
        // only catch the handful of points it happens to sample.
        for (const blockLengthMinutes of [30, 45, 50, 90, 120]) {
            for (const breakMinutes of [0, 5, 10, 15, 30]) {
                for (const blocksPerDay of [1, 4, 8, 12]) {
                    const grid: BlockGrid = {
                        blocksPerDay, blockLengthMinutes, breakMinutes, startHour: 8, startMinute: 0,
                    };
                    const stride = blockLengthMinutes + breakMinutes;
                    const dayStart = 8 * 60;
                    const walked = blockBoundaries(grid);

                    for (let i = 0; i < blocksPerDay; i += 1) {
                        expect(walked[i], `len=${blockLengthMinutes} gap=${breakMinutes} i=${i}`)
                            .toBe(dayStart + i * stride);
                    }

                    // The trailing entry is when teaching ENDS, which the stride
                    // formula never expressed: it is the last block's end, not
                    // the start of a ninth block that does not exist.
                    expect(walked[blocksPerDay])
                        .toBe(dayStart + (blocksPerDay - 1) * stride + blockLengthMinutes);
                }
            }
        }
    });

    it('agrees with the old blockOfMinute at every minute of a teaching day', () => {
        // Minute-by-minute rather than at a few sample points, and deliberately
        // only up to the end of the last block — the one place the two DO differ
        // is asserted separately below, as a fix rather than as parity.
        const stride = UNIFORM.blockLengthMinutes + UNIFORM.breakMinutes;
        const dayStart = UNIFORM.startHour * 60 + UNIFORM.startMinute;
        const lastBlockEnds = dayStart + (UNIFORM.blocksPerDay - 1) * stride + UNIFORM.blockLengthMinutes;

        for (let m = 0; m < lastBlockEnds; m += 1) {
            const old = m < dayStart ? 0 : Math.min(Math.floor((m - dayStart) / stride), UNIFORM.blocksPerDay);

            expect(blockAtMinute(UNIFORM, m), `minute ${m} (${hhmm(m)})`).toBe(old);
        }
    });
});

describe('a latent off-by-one at the end of the day, now fixed', () => {
    it('counts the day finished when the LAST BLOCK ends, not a stride later', () => {
        // The stride version divided by (length + gap), so it kept reporting
        // block 7 until 16:00 — a phantom gap after the final block, during
        // which a Session at block 7 was still "not strictly before" the
        // reference slot and so still movable, though it had ended at 15:45.
        //
        // The walk has no trailing gap, so 15:45 onward reads as 8 blocks
        // finished. This CHANGES behaviour, deliberately, and it changes it in
        // the direction of the correctness rule reference_slot exists to serve.
        const stride = UNIFORM.blockLengthMinutes + UNIFORM.breakMinutes;
        const dayStart = 8 * 60;
        const lastEnds = dayStart + 7 * stride + UNIFORM.blockLengthMinutes; // 15:45

        expect(hhmm(lastEnds)).toBe('15:45');
        expect(blockAtMinute(UNIFORM, lastEnds)).toBe(8);
        expect(blockAtMinute(UNIFORM, lastEnds + 10)).toBe(8);

        // What the stride version would have said in that window.
        expect(Math.floor((lastEnds - dayStart) / stride)).toBe(7);
    });
});

describe('non-uniform breaks', () => {
    it('shifts every block after a longer gap, and none before it', () => {
        const bounds = blockBoundaries(NON_UNIFORM);

        // Blocks 0-3 are untouched: the lunch FOLLOWS block 3.
        expect(bounds.slice(0, 4).map(hhmm)).toEqual(['08:00', '09:00', '10:00', '11:00']);
        // Block 3 runs 11:00-11:45, then 45 minutes of lunch.
        expect(hhmm(bounds[4]!)).toBe('12:30');
        // And everything after is pushed by the extra 30 minutes.
        expect(bounds.slice(4, 8).map(hhmm)).toEqual(['12:30', '13:30', '14:30', '15:30']);
    });

    it('attributes a time inside a long break to the preceding block', () => {
        // 12:00 is inside lunch: block 3 has finished, block 4 has not started.
        // This is the rule the stride version got from Math.floor by accident.
        expect(blockAtMinute(NON_UNIFORM, 12 * 60)).toBe(3);
        expect(blockAtMinute(NON_UNIFORM, 12 * 60 + 29)).toBe(3);
        expect(blockAtMinute(NON_UNIFORM, 12 * 60 + 30)).toBe(4);
    });

    it('lets a day-specific override beat the universal one at that position only', () => {
        // Friday's gap after block 6 is 30 minutes, not the default 15.
        expect(gapAfter(NON_UNIFORM, 6, 5)).toBe(30);
        expect(gapAfter(NON_UNIFORM, 6, 4)).toBe(15);

        // And it does NOT displace the universal lunch at block 3.
        expect(gapAfter(NON_UNIFORM, 3, 5)).toBe(45);
        expect(gapAfter(NON_UNIFORM, 3, 4)).toBe(45);
    });

    it('diverges only on the overridden day, and only after that block', () => {
        const friday = blockBoundaries(NON_UNIFORM, 5);
        const thursday = blockBoundaries(NON_UNIFORM, 4);

        // Identical up to and including block 6's start…
        expect(friday.slice(0, 7)).toEqual(thursday.slice(0, 7));
        // …then Friday's block 7 is 15 minutes later.
        expect(hhmm(thursday[7]!)).toBe('15:30');
        expect(hhmm(friday[7]!)).toBe('15:45');
    });

    it('treats "no particular day" as seeing universal overrides only', () => {
        // The default for the two-argument callers that predate this feature.
        // Seeing a Friday-specific gap when no day was named would be inventing
        // an answer the caller did not ask for.
        expect(gapAfter(NON_UNIFORM, 6, null)).toBe(15);
        expect(gapAfter(NON_UNIFORM, 3, null)).toBe(45);
    });

    it('ignores an override for a block position that does not exist', () => {
        const grid: BlockGrid = {
            ...UNIFORM,
            breaks: [{ afterBlockIndex: 99, durationMinutes: 60, label: 'Nowhere', dayOfWeek: null }],
        };

        expect(blockBoundaries(grid)).toEqual(blockBoundaries(UNIFORM));
    });

    it('ignores an override for a day the grid does not teach', () => {
        // The third dimension an override can dangle in. Position and final-block
        // cases are above; this is the DAY one.
        //
        // It matters because the editor bounds its day picker to the grid's
        // active days, so such a row can only arrive by a grid narrowing its
        // days afterwards — and the shrink cascade that deletes those rows is
        // API-level. Between the narrowing and the next save, the walk has to be
        // right on its own.
        const grid: BlockGrid = {
            ...UNIFORM,
            breaks: [{ afterBlockIndex: 2, durationMinutes: 90, label: 'Saturday only', dayOfWeek: 6 }],
        };
        const noBreaks: BlockGrid = { ...UNIFORM, breaks: [] };

        // Every TAUGHT day is untouched — including at the override's own
        // position, which is the assertion that would fail if the day were
        // ignored and the row treated as universal.
        for (const day of UNIFORM_ACTIVE_DAYS) {
            expect(gapAfter(grid, 2, day), `day ${day}`).toBe(UNIFORM.breakMinutes);
            expect(blockBoundaries(grid, day), `day ${day}`).toEqual(blockBoundaries(noBreaks, day));
        }

        // And "no particular day" does not see it either.
        expect(gapAfter(grid, 2, null)).toBe(UNIFORM.breakMinutes);
    });

    it('never adds a gap after the final block', () => {
        // A break configured after the last block would otherwise overstate when
        // teaching ends, which is the figure the editor's preview prints.
        const grid: BlockGrid = {
            ...UNIFORM,
            breaks: [{ afterBlockIndex: 7, durationMinutes: 90, label: 'Trailing', dayOfWeek: null }],
        };

        expect(blockBoundaries(grid)).toEqual(blockBoundaries(UNIFORM));
    });
});

describe('blockSpan and the public helpers', () => {
    it('gives start and end for a block, honouring the day', () => {
        expect(blockSpan(NON_UNIFORM, 4).start).toBe(12 * 60 + 30);
        expect(blockSpan(NON_UNIFORM, 4).end).toBe(13 * 60 + 15);
        expect(blockSpan(NON_UNIFORM, 7, 5).start).toBe(15 * 60 + 45);
        expect(blockSpan(NON_UNIFORM, 7, 4).start).toBe(15 * 60 + 30);
    });

    it('keeps blockOfMinute delegating to the same walk', () => {
        // The two entry points must not drift: solverCalendar's export is now a
        // thin pass-through, and this asserts it stayed one.
        for (const m of [0, 8 * 60, 12 * 60, 15 * 60, 23 * 60]) {
            expect(blockOfMinute(NON_UNIFORM as never, m)).toBe(blockAtMinute(NON_UNIFORM, m));
        }
    });

    it('does not wrap past midnight, so a too-long day stays detectable', () => {
        const long: BlockGrid = { ...UNIFORM, blockLengthMinutes: 120, breakMinutes: 30, startHour: 8 };
        const bounds = blockBoundaries(long);

        // 8 x 150 - 30 = 1170 minutes of teaching from 08:00 → ends 03:30 next
        // day. Reported as 1650, above 1440, rather than as a plausible 03:30.
        expect(bounds[bounds.length - 1]).toBeGreaterThan(24 * 60);
    });
});
