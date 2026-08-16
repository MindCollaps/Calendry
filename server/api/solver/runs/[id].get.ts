import { requirePermission } from '../../../utils/requirePermission';
import { withRequestTenant } from '../../../utils/tenantDb';
import { isTerminal, serializeRun } from '../../../utils/solverClient';
import { pollSolverRun } from '../../../utils/solverPolling';

/**
 * Status of one run.
 *
 * ON-DEMAND polling, for latency: someone watching a run gets a fresh answer
 * immediately rather than waiting for the background poller's next tick. It is
 * NOT the mechanism that guarantees a run reaches a terminal state — that is
 * `server/plugins/solverPoller.ts`, because nothing about correctness may
 * depend on a human keeping a tab open.
 *
 * Both paths go through `pollSolverRun`, so the meaning of a status, of a
 * NOT_FOUND, and of an unreachable solver cannot drift between them.
 *
 * A terminal run is answered from the database without touching the solver: its
 * state cannot change again, and the solver is not required to remember it.
 */
export default defineEventHandler(async (event) => {
    const id = getRouterParam(event, 'id');

    return withRequestTenant(event, async (tx, identity) => {
        await requirePermission(event, tx, 'solver.trigger');

        const run = await tx.solverRun.findFirst({ where: { id, tenantId: identity.tenantId } });

        if (!run) {
            throw createError({ statusCode: 404, statusMessage: 'Not found.' });
        }

        if (isTerminal(run.status) || !run.externalRunId) {
            return { run: serializeRun(run), polled: false };
        }

        const outcome = await pollSolverRun(tx, run);
        const fresh = await tx.solverRun.findFirstOrThrow({ where: { id: run.id } });

        return {
            run: serializeRun(fresh),
            polled: outcome.polled,
            ...(outcome.stale ? { stale: true, solverUnreachable: outcome.detail } : {}),
        };
    });
});
