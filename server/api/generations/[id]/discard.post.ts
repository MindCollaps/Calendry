import { z } from 'zod';
import { GENERATION_SELECT } from '../../../utils/generationRead';
import { requirePermission } from '../../../utils/requirePermission';
import { withRequestTenant } from '../../../utils/tenantDb';

/**
 * Reject a proposal without applying it.
 *
 * WHY THIS EXISTS AT ALL. Before Stage 6a a READY Generation had no ending: it
 * sat in the list forever, and the only thing that ever moved it was being
 * superseded implicitly by the next apply. That makes the list — whose entire
 * job is "what could I apply?" — accumulate proposals nobody will ever act on,
 * with no way to tell a live candidate from an abandoned one.
 *
 * WHY `generation.apply` GUARDS IT. Discarding is not a lesser action than
 * applying; both decide the fate of a proposal, and someone who may not apply
 * should not be able to throw away the one their colleague is reviewing. Adding
 * a `generation.discard` permission would also leave every existing tenant
 * unable to use it until the catalogue backfill was remembered.
 *
 * NOTHING IS DELETED. The Generation, its `solver_meta` and its run all remain;
 * only the status changes, so "what was proposed and rejected, and when" stays
 * answerable. SUPERSEDED is the existing terminal status for a proposal that
 * will not be applied — the same one an implicit supersede uses.
 */
const bodySchema = z.object({ reason: z.string().nullish() }).optional();

export default defineEventHandler(async (event) => {
    const id = getRouterParam(event, 'id');

    await readValidatedBody(event, bodySchema.parse);

    return withRequestTenant(event, async (tx, identity) => {
        await requirePermission(event, tx, 'generation.apply');

        const generation = await tx.generation.findFirst({
            where: { id, tenantId: identity.tenantId },
            select: { id: true, status: true, isCurrent: true },
        });

        if (!generation) {
            throw createError({ statusCode: 404, statusMessage: 'Not found.' });
        }

        // Discarding the live baseline would leave the tenant with a schedule
        // whose Generation says it was rejected.
        if (generation.isCurrent) {
            throw createError({
                statusCode: 409,
                statusMessage: 'Generation is the current baseline and cannot be discarded.',
            });
        }

        if (generation.status !== 'READY') {
            throw createError({
                statusCode: 409,
                statusMessage: `Generation is ${generation.status} and is not awaiting a decision.`,
            });
        }

        return {
            generation: await tx.generation.update({
                where: { id: generation.id },
                data: { status: 'SUPERSEDED' },
                select: GENERATION_SELECT,
            }),
            discarded: true,
        };
    });
});
