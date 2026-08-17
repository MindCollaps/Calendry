import { z } from 'zod';
import { GENERATION_SELECT, runSummaryFor } from '../../utils/generationRead';
import { requirePermission } from '../../utils/requirePermission';
import { withRequestTenant } from '../../utils/tenantDb';

/**
 * The proposals a tenant could act on.
 *
 * Gated by `session.read`, not a new `generation.read`: this shows the same
 * placements the schedule already shows, and minting a permission would leave
 * every existing tenant 403ing on a visible feature until someone remembered
 * the backfill step.
 */
const querySchema = z.object({
    termId: z.string().optional(),
    status: z.enum(['PENDING', 'RUNNING', 'READY', 'APPLIED', 'FAILED', 'SUPERSEDED', 'INFEASIBLE']).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
});

export default defineEventHandler(async (event) => {
    const query = await getValidatedQuery(event, querySchema.parse);

    return withRequestTenant(event, async (tx, identity) => {
        await requirePermission(event, tx, 'session.read');

        const generations = await tx.generation.findMany({
            where: {
                tenantId: identity.tenantId,
                ...(query.status ? { status: query.status } : {}),
            },
            select: GENERATION_SELECT,
            // Newest proposal first: the list's job is "what could I apply?",
            // and that is almost always the most recent one.
            orderBy: { version: 'desc' },
            take: query.limit ?? 25,
        });

        const withRuns = await Promise.all(generations.map(async (generation) => ({
            ...generation,
            run: await runSummaryFor(tx, identity.tenantId, generation.id),
        })));

        /**
         * Term filtering happens HERE rather than in the query because a
         * Generation carries no term — only its run does, and a manual
         * Generation has no run at all. Filtering by term therefore means "runs
         * for this term", and a manual baseline is correctly excluded from that
         * question rather than silently included.
         */
        return query.termId
            ? withRuns.filter((g) => g.run?.termId === query.termId)
            : withRuns;
    });
});
