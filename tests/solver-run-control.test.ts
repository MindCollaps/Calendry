import { describe, expect, it } from 'vitest';
import { clientPollMs, deriveState, deriveTrend } from '../app/composables/solverRun';
import type { SolverRunRow } from '../app/composables/solverRun';

/**
 * Stage 6b — the toolbar control's state machine and trend derivation.
 *
 * These are the rules that decide what a person is told about a run in flight,
 * so they are pinned here rather than left to be rediscovered by clicking. Two
 * of them are precisely the states that are awkward to reproduce by hand: the
 * gap between asking to cancel and the cancellation being observed, and a
 * SUCCEEDED run whose Generation never got captured.
 */
const run = (over: Partial<SolverRunRow> = {}): SolverRunRow => ({
    id: 'r1',
    termId: 't1',
    status: 'RUNNING',
    progress: 0.34,
    bestObjective: 1000,
    movesEvaluated: '1000000',
    elapsedMillis: 12_000,
    terminationReason: null,
    errorDetail: null,
    generationId: null,
    maxMoves: '3000000',
    maxWallMillis: 60_000,
    createdAt: new Date().toISOString(),
    ...over,
});

describe('deriveState', () => {
    it('is idle with no run', () => {
        expect(deriveState({ starting: false, cancelling: false, run: null })).toBe('idle');
    });

    it('reports starting before anything is known, outranking the stale run', () => {
        // No numbers exist yet, so the control must not render a live panel over
        // whatever the previous run left behind.
        expect(deriveState({ starting: true, cancelling: false, run: run({ status: 'SUCCEEDED' }) }))
            .toBe('starting');
    });

    it('reports cancelling while the run is still RUNNING', () => {
        // The gap that makes the button look broken: the solver has acked, but
        // only a poll can observe CANCELLED.
        expect(deriveState({ starting: false, cancelling: true, run: run({ status: 'RUNNING' }) }))
            .toBe('cancelling');
    });

    it.each(['PENDING', 'QUEUED', 'RUNNING'] as const)('treats %s as running', (status) => {
        expect(deriveState({ starting: false, cancelling: false, run: run({ status }) })).toBe('running');
    });

    it('is finished only when a SUCCEEDED run actually has a Generation', () => {
        expect(deriveState({
            starting: false, cancelling: false,
            run: run({ status: 'SUCCEEDED', generationId: 'g1' }),
        })).toBe('finished');
    });

    it('reports a SUCCEEDED run with no Generation as failed, not as a proposal', () => {
        // Stage 5 guarantees a Generation for every SUCCEEDED run, so its
        // absence means the capture failed. Offering "Review" here would link
        // to nothing.
        expect(deriveState({
            starting: false, cancelling: false,
            run: run({ status: 'SUCCEEDED', generationId: null }),
        })).toBe('failed');
    });

    it.each(['FAILED', 'CANCELLED'] as const)('treats %s as failed', (status) => {
        expect(deriveState({ starting: false, cancelling: false, run: run({ status }) })).toBe('failed');
    });
});

describe('deriveTrend', () => {
    const at = (seconds: number, objective: number) => ({ at: seconds * 1000, objective });

    it('says nothing with fewer than two samples', () => {
        expect(deriveTrend([])).toBeNull();
        expect(deriveTrend([at(0, 100)])).toBeNull();
    });

    it('reports improving while the objective keeps changing', () => {
        const trend = deriveTrend([at(0, 900), at(2, 800), at(4, 700)]);

        expect(trend).toEqual({ improving: true, flatForMs: 0 });
    });

    it('reports how long a flat objective has been flat', () => {
        // Last change at 2s, latest sample at 20s → stalled for 18s.
        const trend = deriveTrend([at(0, 900), at(2, 800), at(10, 800), at(20, 800)]);

        expect(trend?.improving).toBe(false);
        expect(trend?.flatForMs).toBe(18_000);
    });

    it('still counts as improving just under the stall threshold', () => {
        const trend = deriveTrend([at(0, 900), at(2, 800), at(13, 800)], 12_000);

        expect(trend).toEqual({ improving: true, flatForMs: 11_000 });
    });

    it('treats an objective that got worse as a change, not as a stall', () => {
        // The signal is "is the search still moving", not "is it winning" —
        // local search legitimately steps uphill.
        const trend = deriveTrend([at(0, 800), at(30, 900)]);

        expect(trend?.improving).toBe(true);
    });
});

describe('clientPollMs', () => {
    it('polls fast early and backs off once the run is clearly long', () => {
        expect(clientPollMs(0)).toBe(1_000);
        expect(clientPollMs(9_999)).toBe(1_000);
        expect(clientPollMs(10_000)).toBe(2_500);
        expect(clientPollMs(600_000)).toBe(2_500);
    });
});
