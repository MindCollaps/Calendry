import type { Prisma } from '@prisma/client';
import { STRUCTURAL_CONSTRAINT_TYPES } from '../../shared/constraintTypes';
import type { StructuralConstraintType } from '../../shared/constraintTypes';
import type { Tx } from './tenantDb';
import { conflictGroupIds, descendantGroupIds } from './groupClosure';

/**
 * Constraint evaluation for manual edits — the warn-and-allow half of
 * TAXONOMY.md §3.
 *
 * SCOPE: this evaluates only the *structural* hard constraints that a manual
 * edit can break — the three double-booking rules, which are decidable from
 * placement data alone. It is not a solver and never will be. Everything
 * parameterised (online ratios, lecturer vetoes) or preference-shaped (all the
 * soft penalties in §7) belongs to the Rust solver service and is registered
 * below as an explicit TODO rather than silently omitted.
 *
 * A violation row can only be written against a Constraint the tenant has
 * actually configured, because constraint_violation.constraint_id is a NOT NULL
 * FK. That is the correct behaviour under §1's two-layer principle — constraints
 * are tenant vocabulary — but it means a tenant with no configured
 * `no_double_booking_room` constraint gets no room-collision warnings. Tenant
 * provisioning is responsible for creating the baseline hard constraints.
 */

/**
 * The two type lists moved to `shared/constraintTypes.ts` in Step 13, so the
 * rule-builder UI and this evaluator read ONE declaration. A type the builder
 * offered but this file did not know would be a constraint a tenant can enable,
 * that reports nothing, and that means nothing.
 *
 * Re-exported here so every existing importer keeps working unchanged.
 */
// Relative, not `#shared`: this module is loaded OUTSIDE Nuxt too — by
// scripts/ and by vitest — where Nuxt's aliases do not exist. App code under
// app/ can use `#shared` freely because it only ever runs inside Nuxt.
export {
    STRUCTURAL_CONSTRAINT_TYPES,
    SOLVER_OWNED_CONSTRAINT_TYPES,
} from '../../shared/constraintTypes';
export type { StructuralConstraintType } from '../../shared/constraintTypes';

interface PlacedSession {
    id: string;
    tenantId: string;
    termId: string;
    kindId: string;
    offeringId: string;
    termWeek: number;
    dayOfWeek: number;
    blockIndex: number;
    durationBlocks: number;
}

/** Half-open block ranges [start, start+duration) overlap. */
function blocksOverlap(a: PlacedSession, b: PlacedSession): boolean {
    return (
        a.termId === b.termId
        && a.termWeek === b.termWeek
        && a.dayOfWeek === b.dayOfWeek
        && a.blockIndex < b.blockIndex + b.durationBlocks
        && b.blockIndex < a.blockIndex + a.durationBlocks
    );
}

interface RefreshOptions {
    tenantId: string;
    sessionIds: string[];
    detectedByEventId?: string | null;
    generationId?: string | null;
}

/**
 * Recomputes constraint_violation rows for the given Sessions and every Session
 * they collide with, in the caller's transaction.
 *
 * Called synchronously by every editing route, so the persisted violation state
 * is never stale relative to the event that caused it.
 */
export async function refreshViolations(tx: Tx, options: RefreshOptions): Promise<number> {
    const { tenantId, sessionIds, detectedByEventId = null, generationId = null } = options;

    if (sessionIds.length === 0) {
        return 0;
    }

    const enabled = await tx.constraint.findMany({
        where: {
            tenantId,
            isEnabled: true,
            type: { in: [...STRUCTURAL_CONSTRAINT_TYPES] },
        },
        select: { id: true, type: true, severity: true, weight: true },
    });

    // Nothing configured means nothing to record. Collisions still happen; the
    // tenant simply has not asked to be warned about them.
    if (enabled.length === 0) {
        await clearViolations(tx, tenantId, sessionIds, []);

        return 0;
    }

    const seeds = (await tx.session.findMany({
        where: { tenantId, id: { in: sessionIds } },
        select: {
            id: true, tenantId: true, termId: true, kindId: true, offeringId: true,
            termWeek: true, dayOfWeek: true, blockIndex: true, durationBlocks: true,
        },
    })) as PlacedSession[];

    if (seeds.length === 0) {
        return 0;
    }

    // Candidate collision set: every Session sharing a term/week/day with a seed.
    // Narrowing by week and day first keeps this bounded — the alternative is
    // scanning the term.
    const candidates = (await tx.session.findMany({
        where: {
            tenantId,
            OR: seeds.map((s) => ({
                termId: s.termId,
                termWeek: s.termWeek,
                dayOfWeek: s.dayOfWeek,
            })),
        },
        select: {
            id: true, tenantId: true, termId: true, kindId: true, offeringId: true,
            termWeek: true, dayOfWeek: true, blockIndex: true, durationBlocks: true,
        },
    })) as PlacedSession[];

    const involvedIds = [...new Set([...seeds.map((s) => s.id), ...candidates.map((c) => c.id)])];

    const [rooms, people, groups, virtualRooms] = await Promise.all([
        tx.sessionRoom.findMany({ where: { sessionId: { in: involvedIds } }, select: { sessionId: true, roomId: true } }),
        tx.sessionPerson.findMany({ where: { sessionId: { in: involvedIds } }, select: { sessionId: true, personId: true } }),
        tx.sessionGroup.findMany({ where: { sessionId: { in: involvedIds } }, select: { sessionId: true, groupId: true } }),
        tx.room.findMany({ where: { isVirtual: true }, select: { id: true } }),
    ]);

    const virtualRoomIds = new Set(virtualRooms.map((room) => room.id));

    /**
     * Virtual rooms host unlimited concurrent sessions — that is what "online"
     * means, and TAXONOMY.md models online delivery AS a room precisely so
     * room-assignment logic stays uniform. Two lectures streaming at the same
     * hour are not a collision.
     *
     * Excluded HERE, at the construction site, rather than inside
     * `describeCollision`: `byRoom` is the only input the room check has, so a
     * future check that reads it cannot forget the exemption. Keyed on the
     * `is_virtual` FLAG rather than on a well-known "online" room, because
     * nothing restricts a tenant to a single virtual room.
     *
     * NOTE the solver does NOT yet make this exemption — see the tracked
     * cross-repo item in CLAUDE.md. Until it does, the two disagree, and the
     * solver's is the more damaging half.
     */
    const byRoom = groupBy(
        rooms.filter((row) => !virtualRoomIds.has(row.roomId)),
        'sessionId',
        'roomId',
    );
    const byPerson = groupBy(people, 'sessionId', 'personId');
    const byGroup = groupBy(groups, 'sessionId', 'groupId');

    /**
     * Who actually ATTENDS each Session — direct participants plus the members
     * of every group beneath the ones assigned to it.
     *
     * DESCENDANTS ONLY, not the conflict closure. Membership flows downward:
     * being in Seminar A1 makes you part of Class A's cohort, but being in
     * Class A does not put you in Seminar A1. This is the same direction
     * `descendantGroupIds` already serves for notification fan-out, and the same
     * one the solver uses (`expand_subtree`) to build its attendee sets.
     *
     * Resolved ONCE for all involved sessions, and the membership rows fetched
     * in a single query — doing either inside the pair loop would be O(n²)
     * round trips.
     */
    const attendeeSets = new Map<string, Set<string>>();

    {
        const groupsPerSession = new Map<string, string[]>();

        for (const sessionId of involvedIds) {
            groupsPerSession.set(sessionId, await descendantGroupIds(tx, byGroup.get(sessionId) ?? []));
        }

        const allGroupIds = [...new Set([...groupsPerSession.values()].flat())];

        const memberships = allGroupIds.length
            ? await tx.membership.findMany({
                where: { groupId: { in: allGroupIds } },
                select: { groupId: true, personId: true },
            })
            : [];

        const membersByGroup = groupBy(memberships, 'groupId', 'personId');

        for (const sessionId of involvedIds) {
            const people = new Set(byPerson.get(sessionId) ?? []);

            for (const groupId of groupsPerSession.get(sessionId) ?? []) {
                for (const personId of membersByGroup.get(groupId) ?? []) {
                    people.add(personId);
                }
            }

            attendeeSets.set(sessionId, people);
        }
    }

    // Expand each Session's groups to its full conflict set once, up front.
    // Doing this inside the pair loop would re-query the closure O(n²) times.
    const conflictSets = new Map<string, Set<string>>();

    for (const sessionId of involvedIds) {
        const direct = byGroup.get(sessionId) ?? [];
        conflictSets.set(sessionId, new Set(await conflictGroupIds(tx, direct)));
    }

    interface Detected {
        constraintId: string;
        sessionId: string;
        severity: 'HARD' | 'SOFT';
        penalty: number | null;
        detail: Prisma.InputJsonObject;
    }

    const detected: Detected[] = [];

    for (const constraint of enabled) {
        for (const seed of seeds) {
            for (const other of candidates) {
                if (other.id === seed.id || !blocksOverlap(seed, other)) {
                    continue;
                }

                const collision = describeCollision(
                    constraint.type as StructuralConstraintType,
                    seed,
                    other,
                    { byRoom, byPerson, byGroup, conflictSets, attendeeSets },
                );

                if (!collision) {
                    continue;
                }

                detected.push({
                    constraintId: constraint.id,
                    sessionId: seed.id,
                    severity: constraint.severity as 'HARD' | 'SOFT',
                    penalty: constraint.severity === 'SOFT' ? constraint.weight : null,
                    detail: { ...collision, collidesWithSessionId: other.id },
                });
            }
        }
    }

    await clearViolations(tx, tenantId, involvedIds, enabled.map((c) => c.id));

    for (const d of detected) {
        /**
         * find-then-write rather than `upsert`. Prisma cannot express a
         * compound unique key containing NULLABLE columns, and this one is
         * (constraint_id, session_id, offering_id) with NULLS NOT DISTINCT —
         * a shape the schema language has no way to describe. The index still
         * enforces uniqueness in the database; this is only how it is reached.
         */
        const existing = await tx.constraintViolation.findFirst({
            where: { constraintId: d.constraintId, sessionId: d.sessionId, offeringId: null },
            select: { id: true },
        });

        if (existing) {
            await tx.constraintViolation.update({
                where: { id: existing.id },
                data: {
                    severity: d.severity,
                    penalty: d.penalty,
                    detail: d.detail,
                    detectedByEventId,
                    generationId,
                    detectedAt: new Date(),
                },
            });
        } else {
            await tx.constraintViolation.create({
                data: {
                    tenantId,
                    constraintId: d.constraintId,
                    sessionId: d.sessionId,
                    offeringId: null,
                    severity: d.severity,
                    penalty: d.penalty,
                    detail: d.detail,
                    detectedByEventId,
                    generationId,
                },
            });
        }
    }

    return detected.length;
}

export function describeCollision(
    type: StructuralConstraintType,
    a: PlacedSession,
    b: PlacedSession,
    ctx: {
        byRoom: Map<string, string[]>;
        byPerson: Map<string, string[]>;
        /** Each Session's DIRECTLY assigned Groups — never the closure. */
        byGroup: Map<string, string[]>;
        conflictSets: Map<string, Set<string>>;
        /** Everyone attending each Session: direct participants + group members. */
        attendeeSets: Map<string, Set<string>>;
    },
): Prisma.InputJsonObject | null {
    switch (type) {
        case 'no_double_booking_room': {
            const shared = intersect(ctx.byRoom.get(a.id) ?? [], ctx.byRoom.get(b.id) ?? []);

            return shared.length ? { reason: 'room_double_booked', roomIds: shared } : null;
        }

        case 'no_double_booking_lecturer': {
            const shared = intersect(ctx.byPerson.get(a.id) ?? [], ctx.byPerson.get(b.id) ?? []);

            return shared.length ? { reason: 'person_double_booked', personIds: shared } : null;
        }

        case 'no_double_booking_group': {
            /**
             * Nested-group propagation, expanded on ONE side only.
             *
             * A Session booked for a Cohort blocks its child Seminars and vice
             * versa (TAXONOMY.md §6), so one side must be widened to its
             * ancestors and descendants. But the other side must be matched by
             * IDENTITY, against the Groups actually assigned to it.
             *
             * Intersecting two EXPANDED sets — which this did until it was
             * caught during Stage 5 — makes any two Groups sharing a common
             * ancestor collide, however distantly related. Sibling subtrees each
             * expand to include their shared root, so the intersection is
             * non-empty even though neither is an ancestor or descendant of the
             * other and no person is in both:
             *
             *     Seminar A1 → {Seminar A1, Class A, Informatics 2026}
             *     Class B    → {Class B,            Informatics 2026}
             *     ∩          = {Informatics 2026}   ← a false positive
             *
             * Against real demo data that produced 24 phantom violations on a
             * schedule the solver — which gets this right — reported as clean.
             *
             * The test is symmetric in outcome despite looking one-sided: some
             * Group of `a` is related to some Group of `b` exactly when the
             * reverse holds. The reported ids are `b`'s own Groups, which is
             * what a human needs to see rather than an inferred ancestor.
             */
            const closureA = ctx.conflictSets.get(a.id) ?? new Set<string>();
            const directB = ctx.byGroup.get(b.id) ?? [];
            const shared = [...new Set(directB)].filter((g) => closureA.has(g));

            return shared.length ? { reason: 'group_double_booked', groupIds: shared } : null;
        }

        case 'no_double_booking_person': {
            /**
             * Catches what the group rule structurally CANNOT: a person in two
             * groups unrelated in the nesting tree, both scheduled at once.
             * `conflictGroupIds` never connects those groups, so no amount of
             * group checking will ever see it.
             *
             * Both sides are expanded all the way down to PEOPLE and then
             * intersected by identity. Symmetric expansion is safe here — and
             * would not be for groups — because people are leaves: two people
             * are the same person or they are not, so the "shares an ancestor"
             * false positive that broke the group check cannot arise.
             *
             * Mirrors the solver's own implementation, which resolves each
             * session to an attendee set the same way.
             */
            const setA = ctx.attendeeSets.get(a.id) ?? new Set<string>();
            const setB = ctx.attendeeSets.get(b.id) ?? new Set<string>();
            const shared = [...setA].filter((personId) => setB.has(personId));

            return shared.length ? { reason: 'person_double_booked', personIds: shared } : null;
        }

        default:
            return null;
    }
}

async function clearViolations(tx: Tx, tenantId: string, sessionIds: string[], constraintIds: string[]) {
    await tx.constraintViolation.deleteMany({
        where: {
            tenantId,
            sessionId: { in: sessionIds },
            // Scoped to session-shaped rows on purpose. `sessionId IN (...)`
            // already excludes NULLs, so a solver-produced offering-scoped
            // violation survives a manual-edit refresh — this evaluator has no
            // opinion about those and must not silently clear them.
            offeringId: null,
            ...(constraintIds.length ? { constraintId: { in: constraintIds } } : {}),
        },
    });
}

function groupBy<T extends Record<string, string>>(rows: T[], keyField: keyof T, valueField: keyof T) {
    const map = new Map<string, string[]>();

    for (const row of rows) {
        const key = row[keyField] as string;
        const list = map.get(key) ?? [];

        list.push(row[valueField] as string);
        map.set(key, list);
    }

    return map;
}

function intersect(a: string[], b: string[]): string[] {
    const set = new Set(b);

    return a.filter((x) => set.has(x));
}
