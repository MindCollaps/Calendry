import type { SolverRunStatus } from '@prisma/client';
import { SolverOutput } from '@mindcollaps/calendry-proto';
import type { Tx } from './tenantDb';
import type { SolverUnavailableError } from './solverClient';
import {
    fromWireU64,
    getStatus,
    isTerminal,
    toRunStatus,
} from './solverClient';

/**
 * Stage 4 — how often a run is asked about, and what each answer means.
 *
 * Shared by the background poller (which owns correctness) and the on-demand
 * `GET /api/solver/runs/:id` (which owns latency for someone watching). One
 * implementation, so the two cannot disagree about what a status means.
 */

/**
 * Cadence, by how long the run has been going.
 *
 * A fixed interval is wrong in both directions here: a 27,000-Session instance
 * solves in ~349ms, and a hard one runs for minutes. Five seconds would miss the
 * first entirely and burn 720 polls an hour on the second.
 *
 * Age rather than per-run adaptive state, because age is already stored and
 * needs no bookkeeping that could itself go stale.
 */
export function pollIntervalMs(ageMs: number): number {
    if (ageMs < 5_000) return 500;
    if (ageMs < 30_000) return 2_000;
    if (ageMs < 300_000) return 5_000;

    return 15_000;
}

export function nextPollAt(startedAt: Date | null, createdAt: Date, now = new Date()): Date {
    const age = now.getTime() - (startedAt ?? createdAt).getTime();

    return new Date(now.getTime() + pollIntervalMs(age));
}

/**
 * What a failed GetStatus MEANS, which is the sharpest distinction in Stage 4.
 *
 *   NOT_FOUND (5)    the solver no longer knows this run. Its registry is an
 *                    in-memory map with no persistence, so this means it
 *                    restarted and the run is gone — unrecoverable, and the row
 *                    must be resolved or the one-active-run index blocks that
 *                    term forever.
 *
 *   UNAVAILABLE (14) the solver is unreachable. The run may well still be
 *                    going. Touching the row here would destroy a live run's
 *                    record on a network blip AND free the index for a second
 *                    concurrent run against the same term.
 *
 * Conflating the two breaks one direction or the other, which is why this is a
 * named function with its own test rather than an inline `catch`.
 */
export type PollFailure = 'forgotten' | 'unreachable';

const GRPC_NOT_FOUND = 5;

export function classifyPollFailure(error: unknown): PollFailure {
    const code = (error as { cause?: { code?: number } })?.cause?.code;

    if (code === GRPC_NOT_FOUND) {
        return 'forgotten';
    }

    // Anything else — UNAVAILABLE, DEADLINE_EXCEEDED, a broken channel — is
    // treated as transient. Erring toward "leave it alone" is deliberate: the
    // cost of being wrong is a stale row, not a destroyed one.
    return 'unreachable';
}

export interface PollOutcome {
    status: SolverRunStatus;
    /** True when this poll moved the run to a terminal state. */
    becameTerminal: boolean;
    /** False when the solver could not be reached; the row was left untouched. */
    polled: boolean;
    stale?: boolean;
    detail?: string;
}

interface PollableRun {
    id: string;
    status: SolverRunStatus;
    externalRunId: string | null;
    startedAt: Date | null;
    createdAt: Date;
}

/**
 * Polls one run and writes the snapshot back.
 *
 * The result is fetched in the SAME step that observes a terminal status, not
 * later: the solver holds it in memory only, so "I will come back for it" is a
 * promise a restart can break. `include_result` is otherwise left off — the
 * proto adds the flag precisely so routine polling stays cheap.
 */
export async function pollSolverRun(tx: Tx, run: PollableRun): Promise<PollOutcome> {
    if (!run.externalRunId) {
        return { status: run.status, becameTerminal: false, polled: false };
    }

    let status;

    try {
        status = await getStatus(run.externalRunId, false);
    } catch (error) {
        if (classifyPollFailure(error) === 'forgotten') {
            await tx.solverRun.update({
                where: { id: run.id },
                data: {
                    status: 'FAILED',
                    errorDetail: 'The solver no longer knows this run — it restarted and its in-memory '
                        + 'run registry was lost. The run cannot be recovered or resumed.',
                    finishedAt: new Date(),
                    lastPolledAt: new Date(),
                    nextPollAt: null,
                },
            });

            return {
                status: 'FAILED',
                becameTerminal: true,
                polled: true,
                detail: 'solver forgot this run',
            };
        }

        // Unreachable: the row is deliberately left exactly as it was.
        return {
            status: run.status,
            becameTerminal: false,
            polled: false,
            stale: true,
            detail: (error as SolverUnavailableError).message,
        };
    }

    const mapped = toRunStatus(status.status);
    const terminal = isTerminal(mapped);

    /**
     * One extra call, only at the moment of termination. Serialized to JSON via
     * the generated codec so what is stored is a faithful rendering of the
     * message rather than whatever the gRPC object happened to look like.
     */
    let result: unknown;

    if (terminal) {
        try {
            const withResult = await getStatus(run.externalRunId, true);

            result = withResult.result ? SolverOutput.toJSON(withResult.result) : undefined;
        } catch {
            // The status transition is still worth recording even if the result
            // fetch fails; `result` staying null is visible and diagnosable,
            // whereas discarding the transition would leave the run "active"
            // against a solver that has already finished it.
            result = undefined;
        }
    }

    await tx.solverRun.update({
        where: { id: run.id },
        data: {
            status: mapped,
            progress: status.progress,
            bestObjective: status.bestObjective,
            movesEvaluated: fromWireU64(status.movesEvaluated),
            elapsedMillis: Number(status.elapsedMillis),
            errorDetail: status.errorDetail || null,
            lastPolledAt: new Date(),
            ...(terminal
                ? { finishedAt: new Date(), nextPollAt: null, ...(result ? { result: result as object } : {}) }
                : { nextPollAt: nextPollAt(run.startedAt, run.createdAt) }),
        },
    });

    return { status: mapped, becameTerminal: terminal, polled: true };
}
