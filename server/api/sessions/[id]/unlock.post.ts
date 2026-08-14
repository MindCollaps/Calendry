import { z } from 'zod';
import { appendEvent, requireBaselineGeneration } from '../../../utils/sessionEvents';
import { requirePermission } from '../../../utils/requirePermission';
import { withRequestTenant } from '../../../utils/tenantDb';

const bodySchema = z.object({ reason: z.string().nullish() }).optional();

/** Release a lock, returning the Session to the solver's candidate set. */
export default defineEventHandler(async (event) => {
    const id = getRouterParam(event, 'id');
    const body = (await readValidatedBody(event, bodySchema.parse)) ?? {};

    return withRequestTenant(event, async (tx, identity) => {
            await requirePermission(event, tx, 'session.lock');

        const session = await tx.session.findFirst({ where: { id, tenantId: identity.tenantId } });

        if (!session) {
            throw createError({ statusCode: 404, statusMessage: 'Not found.' });
        }

        if (!session.isLocked) {
            return { session, event: null, alreadyUnlocked: true };
        }

        const generationId = await requireBaselineGeneration(tx, identity.tenantId, session.generationId);
        const updated = await tx.session.update({ where: { id: session.id }, data: { isLocked: false } });

        const logged = await appendEvent(tx, identity, {
            type: 'UNLOCK',
            generationId,
            sessionId: session.id,
            payload: { isLocked: { from: true, to: false } },
            reason: body.reason,
        });

        return { session: updated, event: logged, alreadyUnlocked: false };
    });
});
