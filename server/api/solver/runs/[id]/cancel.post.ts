import { requirePermission } from '../../../../utils/requirePermission';
import { withRequestTenant } from '../../../../utils/tenantDb';
import {
    SolverRejectedError,
    SolverUnavailableError,
    cancelRun,
    isTerminal,
    serializeRun,
    toRunStatus,
} from '../../../../utils/solverClient';

/**
 * Cancel an in-progress run.
 *
 * Also the only way out of a stuck run in Stage 2: automatic reaping of runs
 * nothing has polled is Stage 4's problem, because "stale" is a statement about
 * polling cadence and that has not been designed yet.
 */
export default defineEventHandler(async (event) => {
    const id = getRouterParam(event, 'id');

    const run = await withRequestTenant(event, async (tx, identity) => {
        await requirePermission(event, tx, 'solver.trigger');

        return tx.solverRun.findFirst({ where: { id, tenantId: identity.tenantId } });
    });

    if (!run) {
        throw createError({ statusCode: 404, statusMessage: 'Not found.' });
    }

    // Idempotent rather than an error: "stop this" has already been achieved,
    // and a caller racing a run to its finish line should not get a 409 for it.
    if (isTerminal(run.status)) {
        return { run: serializeRun(run), cancelled: false, alreadyTerminal: true };
    }

    /**
     * A PENDING run has no external id — StartRun never acknowledged it. There
     * is nothing to cancel remotely, but the row is still occupying the term, so
     * it is resolved locally. Without this, the one escape hatch would not work
     * on the one state most likely to need it.
     */
    if (!run.externalRunId) {
        const updated = await withRequestTenant(event, (tx) => tx.solverRun.update({
            where: { id: run.id },
            data: {
                status: 'CANCELLED',
                errorDetail: 'Cancelled before the solver acknowledged the run.',
                finishedAt: new Date(),
            },
        }));

        return { run: serializeRun(updated), cancelled: true, neverStarted: true };
    }

    try {
        const response = await cancelRun(run.externalRunId);

        const updated = await withRequestTenant(event, (tx) => tx.solverRun.update({
            where: { id: run.id },
            data: {
                // The solver's own view wins: it reports the resulting status,
                // and `cancelled: false` means it had already finished.
                status: toRunStatus(response.status),
                finishedAt: new Date(),
                lastPolledAt: new Date(),
            },
        }));

        return { run: serializeRun(updated), cancelled: response.cancelled };
    } catch (error) {
        if (error instanceof SolverUnavailableError) {
            throw createError({
                statusCode: 502,
                statusMessage: 'Could not reach the solver service to cancel the run.',
                data: { detail: error.message },
            });
        }

        // The solver answered and refused. Its message says why; passing it
        // through unchanged is the whole point of the two error classes.
        if (error instanceof SolverRejectedError) {
            throw createError({
                statusCode: 422,
                statusMessage: `The solver refused to cancel this run: ${error.message}`,
                data: { grpcCode: error.code, detail: error.message },
            });
        }

        throw error;
    }
});
