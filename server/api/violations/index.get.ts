import { z } from 'zod';
import { requirePermission } from '../../utils/requirePermission';
import { withRequestTenant } from '../../utils/tenantDb';

const querySchema = z.object({
    severity: z.enum(['HARD', 'SOFT']).optional(),
    sessionId: z.string().optional(),
    constraintId: z.string().optional(),
    termId: z.string().optional(),
});

/**
 * Current constraint violations.
 *
 * Reads persisted constraint_violation rows — these are refreshed synchronously
 * by the editing routes, never computed here. That is what makes warn-and-allow
 * workable: a hard-constraint breach introduced by a manual edit stays visible
 * in a queryable list instead of living only in the response that created it.
 */
export default defineEventHandler(async (event) => {
    const query = await getValidatedQuery(event, querySchema.parse);

    return withRequestTenant(event, async (tx, identity) => {
            await requirePermission(event, tx, 'violation.read');

        const where: Record<string, unknown> = { tenantId: identity.tenantId };

        if (query.severity) where.severity = query.severity;
        if (query.sessionId) where.sessionId = query.sessionId;
        if (query.constraintId) where.constraintId = query.constraintId;
        /**
         * A violation reaches a Term through EITHER its Session or its
         * Offering. Filtering on `session` alone would silently drop every
         * offering-scoped violation — which is precisely the ExactFrequency
         * case the whole nullable-session change exists for.
         */
        if (query.termId) {
            where.OR = [
                { session: { termId: query.termId } },
                { offering: { termId: query.termId } },
            ];
        }

        return tx.constraintViolation.findMany({
            where,
            orderBy: [{ severity: 'asc' }, { detectedAt: 'desc' }],
            include: {
                constraint: { select: { id: true, type: true, name: true, severity: true } },
                session: {
                    select: {
                        id: true, termId: true, termWeek: true,
                        dayOfWeek: true, blockIndex: true, isLocked: true,
                    },
                },
                offering: { select: { id: true, code: true, title: true, frequency: true } },
            },
        });
    });
});
