import { GENERATION_SELECT, runSummaryFor } from '../../utils/generationRead';
import { requirePermission } from '../../utils/requirePermission';
import { withRequestTenant } from '../../utils/tenantDb';

/** One proposal, without its placements. See `[id]/preview.get.ts` for those. */
export default defineEventHandler(async (event) => {
    const id = getRouterParam(event, 'id');

    return withRequestTenant(event, async (tx, identity) => {
        await requirePermission(event, tx, 'session.read');

        const generation = await tx.generation.findFirst({
            where: { id, tenantId: identity.tenantId },
            select: GENERATION_SELECT,
        });

        if (!generation) {
            throw createError({ statusCode: 404, statusMessage: 'Not found.' });
        }

        return {
            ...generation,
            run: await runSummaryFor(tx, identity.tenantId, generation.id),
        };
    });
});
