import { describe, expect, it } from 'vitest';
import { classifyPollFailure, nextPollAt, pollIntervalMs, RECOVERY_BACKOFF_MS } from '../server/utils/solverPolling';
import { MAX_RECOVERY_ATTEMPTS } from '../server/utils/solverPollClaim';

/**
 * Stage 4 cadence and failure classification. Pure, no server and no database.
 *
 * The classification in particular earns a test rather than an inline `catch`:
 * getting it backwards either destroys live runs on a network blip, or leaves a
 * term blocked forever after a solver restart. Neither failure announces itself.
 */
describe('pollIntervalMs', () => {
    it('polls a young run fast enough to catch a sub-second solve', () => {
        // A 27,000-Session instance solves in ~349ms. A 5s interval would miss
        // the entire run and only notice it long after it finished.
        expect(pollIntervalMs(0)).toBe(500);
        expect(pollIntervalMs(4_999)).toBe(500);
    });

    it('backs off as a run proves to be long', () => {
        expect(pollIntervalMs(5_000)).toBe(2_000);
        expect(pollIntervalMs(30_000)).toBe(5_000);
        expect(pollIntervalMs(300_000)).toBe(15_000);
    });

    it('caps, so an hour-long run costs hundreds of polls and not thousands', () => {
        const hour = 60 * 60 * 1000;

        expect(pollIntervalMs(hour)).toBe(15_000);
        // 240 polls an hour at the cap, versus 7,200 at a flat 500ms.
        expect(hour / pollIntervalMs(hour)).toBe(240);
    });

    it('is monotonic — a longer run is never polled more often', () => {
        const ages = [0, 1_000, 5_000, 20_000, 30_000, 100_000, 300_000, 1_000_000];
        const intervals = ages.map(pollIntervalMs);

        expect(intervals).toEqual([...intervals].sort((a, b) => a - b));
    });
});

describe('nextPollAt', () => {
    const now = new Date('2026-08-16T12:00:00Z');

    it('schedules from the run\'s age, measured from when it actually started', () => {
        const startedAt = new Date(now.getTime() - 60_000);
        const createdAt = new Date(now.getTime() - 3_600_000);

        // Age is 60s (from startedAt), not an hour (from createdAt): the run has
        // been SOLVING for a minute. Using createdAt would back a fresh run off
        // to the slowest cadence because its row happened to be created earlier.
        expect(nextPollAt(startedAt, createdAt, now).getTime()).toBe(now.getTime() + 5_000);
    });

    it('falls back to createdAt for a run that never started', () => {
        const createdAt = new Date(now.getTime() - 1_000);

        expect(nextPollAt(null, createdAt, now).getTime()).toBe(now.getTime() + 500);
    });
});

describe('classifyPollFailure', () => {
    it('reads gRPC NOT_FOUND as the solver having forgotten the run', () => {
        // The solver's registry is an in-memory map with no persistence, so
        // NOT_FOUND on a run we think is active means it restarted.
        expect(classifyPollFailure({ cause: { code: 5, details: "unknown run 'x'" } })).toBe('forgotten');
    });

    it('reads UNAVAILABLE as transient, leaving the run alone', () => {
        expect(classifyPollFailure({ cause: { code: 14, details: 'No connection established' } }))
            .toBe('unreachable');
    });

    it('errs toward "unreachable" for anything it does not recognise', () => {
        // Being wrong this way leaves a stale row; being wrong the other way
        // destroys a live run's record AND frees the one-active-run index for a
        // second concurrent run.
        expect(classifyPollFailure({ cause: { code: 4 } })).toBe('unreachable');
        expect(classifyPollFailure(new Error('socket hang up'))).toBe('unreachable');
        expect(classifyPollFailure(undefined)).toBe('unreachable');
    });
});

/**
 * Stage 7 prep — the bounded recovery of a missing result.
 *
 * The claim predicate and the code that gives up must agree on the limit, or one
 * of two silent failures follows: a row the claim still offers but the recovery
 * refuses to finish (re-claimed forever), or a row marked lost while the claim
 * still thinks it has attempts left.
 */
describe('result recovery bounds', () => {
    it('defines a backoff for every attempt except the last', () => {
        // Five attempts means four waits between them; the fifth gives up.
        expect(RECOVERY_BACKOFF_MS).toHaveLength(MAX_RECOVERY_ATTEMPTS - 1);
    });

    it('backs off monotonically, starting short enough to catch a blip', () => {
        expect(RECOVERY_BACKOFF_MS[0]).toBeLessThanOrEqual(5_000);

        for (let i = 1; i < RECOVERY_BACKOFF_MS.length; i++) {
            expect(RECOVERY_BACKOFF_MS[i]!).toBeGreaterThan(RECOVERY_BACKOFF_MS[i - 1]!);
        }
    });

    it('gives up inside a few minutes rather than retrying indefinitely', () => {
        // The solver's registry has no persistence: past a short window the
        // result is gone regardless of how long we keep asking.
        const total = RECOVERY_BACKOFF_MS.reduce((a, b) => a + b, 0);

        expect(total).toBeLessThanOrEqual(10 * 60_000);
    });
});
