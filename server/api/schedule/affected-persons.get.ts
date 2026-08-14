import { z } from 'zod';
import { descendantGroupIds } from '../../utils/groupClosure';
import { requirePermission } from '../../utils/requirePermission';
import { withRequestTenant } from '../../utils/tenantDb';

const querySchema = z.object({ session_id: z.string().min(1) });

/**
 * Resolves the notification audience for a Session (TAXONOMY.md §5).
 *
 * "Affected" = assigned Lecturer(s) + every Person with Membership in an
 * assigned Group, walking the nested tree + any directly assigned individuals.
 *
 * Uses `descendantGroupIds`, NOT the conflict set. The two questions differ:
 * conflict-checking propagates in both directions, but notification only flows
 * downward. A member of a child Seminar is affected by a Cohort-wide lecture; a
 * Cohort member who is not in that Seminar is not affected by the Seminar's
 * session. Using the conflict set here would over-notify.
 *
 * Delivery (email/push) is out of scope — this returns the resolved list only.
 */
export default defineEventHandler(async (event) => {
    const query = await getValidatedQuery(event, querySchema.parse);

    return withRequestTenant(event, async (tx, identity) => {
            await requirePermission(event, tx, 'notification.preview');

        const session = await tx.session.findFirst({
            where: { id: query.session_id, tenantId: identity.tenantId },
            select: { id: true },
        });

        if (!session) {
            throw createError({ statusCode: 404, statusMessage: 'Not found.' });
        }

        const [assignedPeople, assignedGroups] = await Promise.all([
            tx.sessionPerson.findMany({
                where: { sessionId: session.id },
                select: { personId: true, roleId: true, role: { select: { key: true } } },
            }),
            tx.sessionGroup.findMany({
                where: { sessionId: session.id },
                select: { groupId: true },
            }),
        ]);

        const groupIds = await descendantGroupIds(tx, assignedGroups.map((g) => g.groupId));

        const memberships = groupIds.length
            ? await tx.membership.findMany({
                where: { tenantId: identity.tenantId, groupId: { in: groupIds } },
                select: { personId: true, groupId: true },
            })
            : [];

        // Deduplicate: one person reachable via several groups is one recipient,
        // and a lecturer who is also a group member must not be notified twice.
        const audience = new Map<string, { personId: string; reasons: string[] }>();

        const add = (personId: string, reason: string) => {
            const entry = audience.get(personId) ?? { personId, reasons: [] };

            if (!entry.reasons.includes(reason)) {
                entry.reasons.push(reason);
            }

            audience.set(personId, entry);
        };

        for (const p of assignedPeople) {
            add(p.personId, p.role?.key === 'lecturer' ? 'lecturer' : 'directly_assigned');
        }

        for (const m of memberships) {
            add(m.personId, `group:${m.groupId}`);
        }

        const personIds = [...audience.keys()];
        const people = personIds.length
            ? await tx.person.findMany({
                where: { tenantId: identity.tenantId, id: { in: personIds } },
                select: { id: true, givenName: true, familyName: true, email: true, timezone: true },
            })
            : [];

        return {
            sessionId: session.id,
            resolvedGroupIds: groupIds,
            count: people.length,
            persons: people.map((person) => ({
                ...person,
                reasons: audience.get(person.id)?.reasons ?? [],
            })),
        };
    });
});
