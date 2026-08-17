import type { SolverRunStatus } from '@prisma/client';
import { SolverOutput } from '@mindcollaps/calendry-proto';
import type { Tx } from './tenantDb';
import { createGenerationForRun, shouldCreateGeneration } from './generationFromRun';
import { MAX_RECOVERY_ATTEMPTS } from './solverPollClaim';
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
    /** Set when this poll also created the run's proposed Generation. */
    generationId?: string | null;
    /** False when the solver could not be reached; the row was left untouched. */
    polled: boolean;
    stale?: boolean;
    detail?: string;
}

interface PollableRun {
    id: string;
    tenantId: string;
    status: SolverRunStatus;
    externalRunId: string | null;
    startedAt: Date | null;
    createdAt: Date;
}

/**
 * Backoff between attempts to re-fetch a missing result, by attempt number.
 *
 * Written on the FIRST attempt, not after several: a terminal row has
 * `next_poll_at = NULL`, and the claim treats NULL as due, so without this the
 * four already-stuck rows would be re-claimed on every 500ms tick forever.
 */
export const RECOVERY_BACKOFF_MS = [5_000, 15_000, 60_000, 300_000];

export interface RecoveryOutcome {
    recovered: boolean;
    lost: boolean;
    attempts: number;
    generationId?: string | null;
    detail?: string;
}

/**
 * Asks again for the result of a run that succeeded but whose result never
 * arrived.
 *
 * WHY THIS EXISTS. `pollSolverRun()` records a terminal status even when the
 * result fetch throws — losing the transition would be worse, because the run
 * would look active against a solver that had finished it and the one-active-run
 * index would block that term. But nothing then retried, and the poller claims
 * only active statuses, so such a row was never looked at again: no result, no
 * Generation, and no way to ever get one.
 *
 * WHAT IT WILL NOT DO. Only a SUCCEEDED run is a candidate. CANCELLED and FAILED
 * runs correctly have no result and are never touched — see the claim predicate.
 *
 * The run's `status` is never rewritten. It succeeded; that remains true and
 * remains recorded. Only the CAPTURE outcome is written here.
 */
export async function recoverRunResult(tx: Tx, run: {
    id: string;
    tenantId: string;
    externalRunId: string | null;
    resultRecoveryAttempts: number;
}): Promise<RecoveryOutcome> {
    const attempts = run.resultRecoveryAttempts + 1;

    if (!run.externalRunId) {
        return { recovered: false, lost: false, attempts: run.resultRecoveryAttempts };
    }

    const giveUp = async (detail: string): Promise<RecoveryOutcome> => {
        await tx.solverRun.update({
            where: { id: run.id },
            data: {
                resultRecoveryAttempts: attempts,
                resultLostAt: new Date(),
                errorDetail: detail,
                nextPollAt: null,
                lastPolledAt: new Date(),
            },
        });

        return { recovered: false, lost: true, attempts, detail };
    };

    let status;

    try {
        status = await getStatus(run.externalRunId, true);
    } catch (error) {
        /**
         * NOT_FOUND is definitive, so it does not burn the remaining attempts.
         * The solver's registry has no persistence: if it no longer knows the
         * run, it restarted, and the result is gone for good. Retrying four more
         * times would only delay the same answer by six minutes.
         */
        if (classifyPollFailure(error) === 'forgotten') {
            return giveUp('The solver no longer holds this run\'s result — it restarted and its '
                + 'in-memory registry was lost. The run succeeded, but its output cannot be recovered.');
        }

        if (attempts >= MAX_RECOVERY_ATTEMPTS) {
            return giveUp(`The solver could not be reached to recover this run's result after `
                + `${attempts} attempts. The run succeeded, but its output cannot be recovered.`);
        }

        // Transient. Space the next attempt out rather than hammering.
        await tx.solverRun.update({
            where: { id: run.id },
            data: {
                resultRecoveryAttempts: attempts,
                lastPolledAt: new Date(),
                nextPollAt: new Date(Date.now() + (RECOVERY_BACKOFF_MS[attempts - 1] ?? 300_000)),
            },
        });

        return { recovered: false, lost: false, attempts, detail: 'solver unreachable' };
    }

    /**
     * The solver answered but no longer calls this run succeeded — its registry
     * recycled the id, or it disagrees with what was recorded. Attaching a
     * result under those circumstances would be worse than admitting the loss.
     */
    if (toRunStatus(status.status) !== 'SUCCEEDED' || !status.result) {
        return giveUp('The solver no longer reports a result for this run. It succeeded, '
            + 'but its output cannot be recovered.');
    }

    await tx.solverRun.update({
        where: { id: run.id },
        data: {
            result: SolverOutput.toJSON(status.result) as object,
            terminationReason: status.result.stats?.terminationReason || null,
            resultRecoveryAttempts: attempts,
            nextPollAt: null,
            lastPolledAt: new Date(),
        },
    });

    /**
     * Same shared path a first-time capture uses. Not a second implementation:
     * Stage 4 already learned what happens when two callers each create the
     * Generation their own way.
     */
    const fresh = await tx.solverRun.findFirstOrThrow({ where: { id: run.id } });

    const generationId = fresh.generationId
        ? null
        : await createGenerationForRun(tx, {
            tenantId: run.tenantId,
            runId: run.id,
            result: fresh.result,
            requestedById: fresh.requestedById,
        });

    return { recovered: true, lost: false, attempts, generationId };
}

/**
 * Polls one run and writes the snapshot back.
 *
 * The result is fetched in the SAME step that observes a terminal status, not
 * later: the solver holds it in memory only, so "I will come back for it" is a
 * promise a restart can break. `include_result` is otherwise left off — the
 * proto adds the flag precisely so routine polling stays cheap.
 *
 * When that fetch DOES fail, `recoverRunResult()` above is what asks again.
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
    /**
     * Why this is captured into its own column rather than only living inside
     * `result`: the column's whole purpose is to be QUERYABLE — "which runs are
     * not reproducible?" is a filter, not a JSON traversal. It went unwritten
     * until Stage 6a, so it was NULL on every row while its own schema comment
     * told readers to consult it, and a filter on it returned nothing that read
     * exactly like "no such runs".
     *
     * Rows captured before the fix stay NULL. Nothing backfills them (migrations
     * here are schema-only), so every reader must treat NULL as UNKNOWN rather
     * than as "reproducible".
     */
    let terminationReason: string | undefined;

    if (terminal) {
        try {
            const withResult = await getStatus(run.externalRunId, true);

            result = withResult.result ? SolverOutput.toJSON(withResult.result) : undefined;
            terminationReason = withResult.result?.stats?.terminationReason || undefined;
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
                ? {
                    finishedAt: new Date(),
                    nextPollAt: null,
                    ...(result ? { result: result as object } : {}),
                    ...(terminationReason ? { terminationReason } : {}),
                }
                : { nextPollAt: nextPollAt(run.startedAt, run.createdAt) }),
        },
    });

    /**
     * The Generation is created HERE, by whichever path observed the terminal
     * transition — not in the poller.
     *
     * It lived in the poller first, and the on-demand route silently stole the
     * transition: a user who opened the run's page before the next tick moved
     * it to SUCCEEDED, the poller then had nothing left to observe, and NO
     * Generation was ever created. The result sat captured and unusable. Both
     * callers share this function precisely so a terminal transition means the
     * same thing either way.
     */
    let generationId: string | null = null;

    if (terminal && shouldCreateGeneration(mapped)) {
        const fresh = await tx.solverRun.findFirstOrThrow({ where: { id: run.id } });

        generationId = fresh.generationId
            ? null
            : await createGenerationForRun(tx, {
                tenantId: run.tenantId,
                runId: run.id,
                result: fresh.result,
                requestedById: fresh.requestedById,
            });
    }

    return { status: mapped, becameTerminal: terminal, polled: true, generationId };
}
