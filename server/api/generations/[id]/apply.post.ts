import { z } from 'zod';
import { mapDbErrors } from '../../../utils/dbErrors';
import { appendEvent } from '../../../utils/sessionEvents';
import { requirePermission } from '../../../utils/requirePermission';
import { withRequestTenant } from '../../../utils/tenantDb';
import { refreshViolations } from '../../../utils/violations';

const bodySchema = z.object({ reason: z.string().nullish() }).optional();

/**
 * Promote a Generation to the tenant's current baseline.
 *
 * ONE batch event, not one per Session. The Generation is already the immutable
 * record of these placements (TAXONOMY.md §3), so per-Session events would store
 * the same data twice and make replay ambiguous — a replayer could not tell
 * whether to apply the snapshot, the events, or both. The event log's role is
 * manual deltas layered on a baseline; applying a Generation replaces the
 * baseline rather than being a delta on it. Volume confirms it: a large
 * university would otherwise write five figures of rows per click.
 *
 * Locked Sessions are left exactly as they are — the solver never overwrites a
 * lock, so neither does applying its output.
 */
export default defineEventHandler(async (event) => {
    const id = getRouterParam(event, 'id');
    const body = (await readValidatedBody(event, bodySchema.parse)) ?? {};

    return withRequestTenant(
        event,
        async (tx, identity) => {
            await requirePermission(event, tx, 'generation.apply');

            const generation = await tx.generation.findFirst({
                where: { id, tenantId: identity.tenantId },
            });

            if (!generation) {
                throw createError({ statusCode: 404, statusMessage: 'Not found.' });
            }

            if (generation.status === 'INFEASIBLE' || generation.status === 'FAILED') {
                throw createError({
                    statusCode: 409,
                    statusMessage: `Generation is ${generation.status} and has no placements to apply.`,
                });
            }

            if (generation.isCurrent) {
                return { generation, applied: 0, skippedLocked: 0, event: null, alreadyCurrent: true };
            }

            const previous = await tx.generation.findFirst({
                where: { tenantId: identity.tenantId, isCurrent: true },
                select: { id: true, version: true },
            });

            // Locked Sessions keep their manual placement and their old baseline.
            const lockedCount = await tx.session.count({
                where: { tenantId: identity.tenantId, isLocked: true },
            });

            // Clear the current flag before setting the new one: a partial unique
            // index permits only one current Generation per tenant, so the order
            // matters.
            await mapDbErrors(async () => {
                if (previous) {
                    await tx.generation.update({
                        where: { id: previous.id },
                        data: { isCurrent: false, status: 'SUPERSEDED' },
                    });
                }

                await tx.generation.update({
                    where: { id: generation.id },
                    data: { isCurrent: true, status: 'APPLIED', appliedAt: new Date() },
                });
            });

            const rebased = await tx.session.updateMany({
                where: { tenantId: identity.tenantId, isLocked: false },
                data: { generationId: generation.id },
            });

            const logged = await appendEvent(tx, identity, {
                type: 'APPLY_GENERATION',
                generationId: generation.id,
                payload: {
                    generationId: generation.id,
                    version: generation.version,
                    previousGenerationId: previous?.id ?? null,
                    previousVersion: previous?.version ?? null,
                    sessionsRebased: rebased.count,
                    sessionsSkippedLocked: lockedCount,
                },
                reason: body.reason,
            });

            const affected = await tx.session.findMany({
                where: { tenantId: identity.tenantId, generationId: generation.id },
                select: { id: true },
            });

            await refreshViolations(tx, {
                tenantId: identity.tenantId,
                sessionIds: affected.map((s) => s.id),
                detectedByEventId: logged.id,
                generationId: generation.id,
            });

            return {
                generation: await tx.generation.findFirst({ where: { id: generation.id } }),
                applied: rebased.count,
                skippedLocked: lockedCount,
                event: logged,
                alreadyCurrent: false,
            };
        },
        // The one bulk operation in the API: re-baselining every unlocked Session
        // and re-evaluating their violations will exceed the 5s default on a
        // large tenant.
        { timeoutMs: 120_000 },
    );
});
