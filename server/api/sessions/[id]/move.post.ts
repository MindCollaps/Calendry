import { z } from 'zod';
import { mapDbErrors } from '../../../utils/dbErrors';
import { appendEvent, placementOf, requireBaselineGeneration } from '../../../utils/sessionEvents';
import { requirePermission } from '../../../utils/requirePermission';
import { withRequestTenant } from '../../../utils/tenantDb';
import { refreshViolations } from '../../../utils/violations';

const bodySchema = z.object({
    termId: z.string().min(1).optional(),
    termWeek: z.number().int().min(1).optional(),
    dayOfWeek: z.number().int().min(1).max(7).optional(),
    blockIndex: z.number().int().min(0).optional(),
    durationBlocks: z.number().int().min(1).optional(),
    roomIds: z.array(z.string().min(1)).optional(),
    reason: z.string().nullish(),
});

/**
 * Re-place a Session.
 *
 * WARN AND ALLOW (TAXONOMY.md §3): a move that breaks a hard constraint is
 * carried out anyway. The violation is persisted to constraint_violation and
 * returned for immediate display, but it never blocks the edit.
 */
export default defineEventHandler(async (event) => {
    const id = getRouterParam(event, 'id');
    const body = await readValidatedBody(event, bodySchema.parse);

    return withRequestTenant(event, async (tx, identity) => {
            await requirePermission(event, tx, 'session.move');

        const session = await tx.session.findFirst({
            where: { id, tenantId: identity.tenantId },
        });

        if (!session) {
            throw createError({ statusCode: 404, statusMessage: 'Not found.' });
        }

        const generationId = await requireBaselineGeneration(tx, identity.tenantId, session.generationId);
        const before = placementOf(session);
        const beforeRooms = await tx.sessionRoom.findMany({
            where: { sessionId: session.id },
            select: { roomId: true },
        });

        const updated = await mapDbErrors(() =>
            tx.session.update({
                where: { id: session.id },
                data: {
                    termId: body.termId ?? session.termId,
                    termWeek: body.termWeek ?? session.termWeek,
                    dayOfWeek: body.dayOfWeek ?? session.dayOfWeek,
                    blockIndex: body.blockIndex ?? session.blockIndex,
                    durationBlocks: body.durationBlocks ?? session.durationBlocks,
                },
            }),
        );

        // Room reassignment is part of a move: "change term/week/timeslot/room".
        if (body.roomIds) {
            await tx.sessionRoom.deleteMany({ where: { sessionId: session.id } });

            for (const roomId of body.roomIds) {
                await mapDbErrors(() =>
                    tx.sessionRoom.create({
                        data: { sessionId: session.id, roomId, tenantId: identity.tenantId },
                    }),
                );
            }
        }

        const logged = await appendEvent(tx, identity, {
            type: 'MOVE',
            generationId,
            sessionId: session.id,
            payload: {
                from: { ...before, roomIds: beforeRooms.map((r) => r.roomId) },
                to: { ...placementOf(updated), roomIds: body.roomIds ?? beforeRooms.map((r) => r.roomId) },
            },
            reason: body.reason,
        });

        // Synchronous, same transaction: persisted violations are never stale
        // relative to the event that caused them.
        await refreshViolations(tx, {
            tenantId: identity.tenantId,
            sessionIds: [session.id],
            detectedByEventId: logged.id,
            generationId,
        });

        const violations = await tx.constraintViolation.findMany({
            where: { tenantId: identity.tenantId, sessionId: session.id },
        });

        return { session: updated, event: logged, violations };
    });
});
