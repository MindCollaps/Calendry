import { z } from 'zod';
import { conflictGroupIds } from '../../utils/groupClosure';
import { requirePermission } from '../../utils/requirePermission';
import { withRequestTenant } from '../../utils/tenantDb';

const querySchema = z.object({
    termId: z.string().optional(),
    termWeek: z.coerce.number().int().optional(),
    groupId: z.string().optional(),
    roomId: z.string().optional(),
    personId: z.string().optional(),
    offeringId: z.string().optional(),
    isLocked: z.coerce.boolean().optional(),
    includeNested: z.coerce.boolean().optional(),
});

/**
 * Current schedule state.
 *
 * Reads the materialized `session` table directly rather than replaying the
 * event log. Sessions ARE current state — editing routes write them in the same
 * transaction that appends the event — so replaying on every read would be
 * O(events) per request for an answer already stored. The log exists for audit
 * and rollback, which is a separate (future) endpoint.
 */
export default defineEventHandler(async (event) => {
    const query = await getValidatedQuery(event, querySchema.parse);

    return withRequestTenant(event, async (tx, identity) => {
            await requirePermission(event, tx, 'session.read');

        /**
         * Own Sessions plus Federation-shared ones (Stage 7c).
         *
         * A shared event must appear on every member tenant's timetable — that
         * is the entire point of making Session federation-ownable. RLS would
         * permit the read either way; this is what actually ASKS for them.
         */
        const where: Record<string, unknown> = {
            OR: [
                { tenantId: identity.tenantId },
                ...(identity.federationId ? [{ federationId: identity.federationId }] : []),
            ],
        };

        if (query.termId) where.termId = query.termId;
        if (query.termWeek !== undefined) where.termWeek = query.termWeek;
        if (query.offeringId) where.offeringId = query.offeringId;
        if (query.isLocked !== undefined) where.isLocked = query.isLocked;

        if (query.groupId) {
            // Filtering by a Cohort should surface its Seminars' sessions too, so
            // includeNested resolves through the closure rather than matching only
            // directly assigned groups.
            const groupIds = query.includeNested
                ? await conflictGroupIds(tx, [query.groupId])
                : [query.groupId];

            where.groups = { some: { groupId: { in: groupIds } } };
        }

        if (query.roomId) where.rooms = { some: { roomId: query.roomId } };
        if (query.personId) where.people = { some: { personId: query.personId } };

        return tx.session.findMany({
            where,
            orderBy: [{ termWeek: 'asc' }, { dayOfWeek: 'asc' }, { blockIndex: 'asc' }],
            include: {
                groups: { select: { groupId: true } },
                people: { select: { personId: true, roleId: true } },
                rooms: { select: { roomId: true } },
                // A Session's own columns carry no human-readable label, so a
                // client would otherwise need a second round trip per view just
                // to name what it is drawing. Both are read-only and already
                // tenant-scoped by the same transaction.
                offering: { select: { id: true, title: true, code: true } },
                kind: { select: { id: true, key: true, name: true, color: true } },
            },
        });
    });
});
