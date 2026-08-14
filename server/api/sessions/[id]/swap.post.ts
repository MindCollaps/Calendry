import { z } from 'zod';
import { mapDbErrors } from '../../../utils/dbErrors';
import { appendEvent, placementOf, requireBaselineGeneration } from '../../../utils/sessionEvents';
import { requirePermission } from '../../../utils/requirePermission';
import { withRequestTenant } from '../../../utils/tenantDb';
import { refreshViolations } from '../../../utils/violations';

const bodySchema = z.object({
    withSessionId: z.string().min(1),
    reason: z.string().nullish(),
});

/**
 * Exchange two Sessions' placements.
 *
 * Emits ONE SWAP event referencing both Sessions rather than two MOVEs: a swap
 * is atomic, and splitting it would let a replay stop between the halves in a
 * state where both Sessions occupy the same slot.
 */
export default defineEventHandler(async (event) => {
    const id = getRouterParam(event, 'id');
    const body = await readValidatedBody(event, bodySchema.parse);

    if (id === body.withSessionId) {
        throw createError({ statusCode: 422, statusMessage: 'Cannot swap a Session with itself.' });
    }

    return withRequestTenant(event, async (tx, identity) => {
            await requirePermission(event, tx, 'session.swap');

        // Both fetched under the tenant predicate, so swapping with a Session
        // from another tenant reads as "not found" rather than partially
        // succeeding.
        const [a, b] = await Promise.all([
            tx.session.findFirst({ where: { id, tenantId: identity.tenantId } }),
            tx.session.findFirst({ where: { id: body.withSessionId, tenantId: identity.tenantId } }),
        ]);

        if (!a || !b) {
            throw createError({ statusCode: 404, statusMessage: 'Not found.' });
        }

        const generationId = await requireBaselineGeneration(tx, identity.tenantId, a.generationId ?? b.generationId);
        const placementA = placementOf(a);
        const placementB = placementOf(b);

        await mapDbErrors(async () => {
            await tx.session.update({ where: { id: a.id }, data: placementB });
            await tx.session.update({ where: { id: b.id }, data: placementA });
        });

        const logged = await appendEvent(tx, identity, {
            type: 'SWAP',
            generationId,
            sessionId: a.id,
            counterpartSessionId: b.id,
            payload: {
                a: { sessionId: a.id, from: placementA, to: placementB },
                b: { sessionId: b.id, from: placementB, to: placementA },
            },
            reason: body.reason,
        });

        await refreshViolations(tx, {
            tenantId: identity.tenantId,
            sessionIds: [a.id, b.id],
            detectedByEventId: logged.id,
            generationId,
        });

        const [sessionA, sessionB, violations] = await Promise.all([
            tx.session.findFirst({ where: { id: a.id } }),
            tx.session.findFirst({ where: { id: b.id } }),
            tx.constraintViolation.findMany({
                where: { tenantId: identity.tenantId, sessionId: { in: [a.id, b.id] } },
            }),
        ]);

        return { sessions: [sessionA, sessionB], event: logged, violations };
    });
});
