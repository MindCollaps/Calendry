import { z } from 'zod';
import { requirePermission } from '../../../utils/requirePermission';
import { withRequestTenant } from '../../../utils/tenantDb';
import { ACTIVE_RUN_STATUSES, serializeRun } from '../../../utils/solverClient';

const querySchema = z.object({
    termId: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * Recent runs, newest first.
 *
 * Reads only the database — no solver call. Polling one run for a fresh
 * snapshot is `GET /api/solver/runs/:id`; doing it for every row of a list
 * would fan one request out into N calls to a service that is optimising in the
 * background.
 */
export default defineEventHandler(async (event) => {
    const query = await getValidatedQuery(event, querySchema.parse);

    return withRequestTenant(event, async (tx, identity) => {
        await requirePermission(event, tx, 'solver.trigger');

        const where = {
            tenantId: identity.tenantId,
            ...(query.termId ? { termId: query.termId } : {}),
        };

        const [rows, active] = await Promise.all([
            tx.solverRun.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                take: query.limit ?? 20,
            }),
            // Surfaced separately because it is the thing a caller acts on: it
            // is what a start attempt would collide with, and the only run worth
            // cancelling. Finding it by scanning the list would mean every
            // caller reimplementing the index's definition of "active".
            tx.solverRun.findMany({
                where: { ...where, status: { in: ACTIVE_RUN_STATUSES } },
                select: { id: true, termId: true, status: true, createdAt: true },
            }),
        ]);

        return {
            runs: rows.map(serializeRun),
            active: active.map(serializeRun),
        };
    });
});
