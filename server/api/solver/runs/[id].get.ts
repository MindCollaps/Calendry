import { requirePermission } from '../../../utils/requirePermission';
import { withRequestTenant } from '../../../utils/tenantDb';
import {
    SolverUnavailableError,
    fromWireU64,
    getStatus,
    isTerminal,
    serializeRun,
    toRunStatus,
} from '../../../utils/solverClient';

/**
 * Status of one run.
 *
 * PULL-ONLY: this calls the solver when asked and writes the snapshot back.
 * There is no background poller — cadence is Stage 4 by the staged plan, and
 * inventing one here would prejudge it.
 *
 * A terminal run is answered from the database without touching the solver: its
 * state cannot change again, and the solver is not required to remember a run
 * forever.
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

    if (isTerminal(run.status) || !run.externalRunId) {
        return { run: serializeRun(run), polled: false, placeholderInput: true };
    }

    try {
        const status = await getStatus(run.externalRunId, false);
        const mapped = toRunStatus(status.status);

        const updated = await withRequestTenant(event, (tx) => tx.solverRun.update({
            where: { id: run.id },
            data: {
                status: mapped,
                progress: status.progress,
                bestObjective: status.bestObjective,
                movesEvaluated: fromWireU64(status.movesEvaluated),
                elapsedMillis: Number(status.elapsedMillis),
                errorDetail: status.errorDetail || null,
                lastPolledAt: new Date(),
                ...(isTerminal(mapped) ? { finishedAt: new Date() } : {}),
            },
        }));

        return { run: serializeRun(updated), polled: true, placeholderInput: true };
    } catch (error) {
        /**
         * A poll failure is NOT a run failure — the run may well still be going.
         * Marking it FAILED here would destroy a live run's record on a blip,
         * and the one-active-run index would then let a second run start
         * alongside it. So the stored status is left alone and the caller is
         * told the snapshot is stale.
         *
         * This is the deliberate asymmetry with StartRun, where a transport
         * failure DOES mean the run never began.
         */
        if (error instanceof SolverUnavailableError) {
            return {
                run: serializeRun(run),
                polled: false,
                stale: true,
                solverUnreachable: error.message,
                placeholderInput: true,
            };
        }

        throw error;
    }
});
