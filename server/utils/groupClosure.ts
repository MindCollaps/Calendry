import type { Tx } from './tenantDb';

/**
 * Nested-group resolution (TAXONOMY.md §6).
 *
 * Both helpers read the `group_closure` table maintained by the Step 3 trigger.
 * Neither walks the tree, and neither maintains the closure.
 *
 * The two directions are genuinely different questions, and conflating them is
 * the easy mistake here:
 *
 *  - CONFLICT checking needs ancestors AND descendants. A Session booked for a
 *    Cohort blocks its child Seminar groups, and a Session booked for a Seminar
 *    blocks the parent Cohort — §2 says propagation runs both ways.
 *
 *  - NOTIFICATION fan-out needs self AND descendants only. Everyone in a child
 *    Seminar is affected by a Cohort-wide lecture, but a member of the Cohort
 *    who is not in that Seminar is not affected by the Seminar's session.
 */

/** Groups whose availability collides with any of `groupIds` (both directions). */
export async function conflictGroupIds(tx: Tx, groupIds: string[]): Promise<string[]> {
    if (groupIds.length === 0) {
        return [];
    }

    const rows = await tx.groupClosure.findMany({
        where: {
            OR: [{ ancestorId: { in: groupIds } }, { descendantId: { in: groupIds } }],
        },
        select: { ancestorId: true, descendantId: true },
    });

    const out = new Set<string>(groupIds);

    for (const row of rows) {
        out.add(row.ancestorId);
        out.add(row.descendantId);
    }

    return [...out];
}

/** `groupIds` plus everything nested beneath them. Used for notification audience. */
export async function descendantGroupIds(tx: Tx, groupIds: string[]): Promise<string[]> {
    if (groupIds.length === 0) {
        return [];
    }

    const rows = await tx.groupClosure.findMany({
        where: { ancestorId: { in: groupIds } },
        select: { descendantId: true },
    });

    const out = new Set<string>(groupIds);

    for (const row of rows) {
        out.add(row.descendantId);
    }

    return [...out];
}
