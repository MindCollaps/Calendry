import type { Prisma } from '@prisma/client';
import { STRUCTURAL_CONSTRAINT_TYPES } from '../../shared/constraintTypes';
import type { StructuralConstraintType } from '../../shared/constraintTypes';
import type { Tx } from './tenantDb';
import { conflictGroupIds } from './groupClosure';

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

    const [rooms, people, groups] = await Promise.all([
        tx.sessionRoom.findMany({ where: { sessionId: { in: involvedIds } }, select: { sessionId: true, roomId: true } }),
        tx.sessionPerson.findMany({ where: { sessionId: { in: involvedIds } }, select: { sessionId: true, personId: true } }),
        tx.sessionGroup.findMany({ where: { sessionId: { in: involvedIds } }, select: { sessionId: true, groupId: true } }),
    ]);

    const byRoom = groupBy(rooms, 'sessionId', 'roomId');
    const byPerson = groupBy(people, 'sessionId', 'personId');
    const byGroup = groupBy(groups, 'sessionId', 'groupId');

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
                    { byRoom, byPerson, conflictSets },
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
        await tx.constraintViolation.upsert({
            where: { constraintId_sessionId: { constraintId: d.constraintId, sessionId: d.sessionId } },
            create: {
                tenantId,
                constraintId: d.constraintId,
                sessionId: d.sessionId,
                severity: d.severity,
                penalty: d.penalty,
                detail: d.detail,
                detectedByEventId,
                generationId,
            },
            update: {
                severity: d.severity,
                penalty: d.penalty,
                detail: d.detail,
                detectedByEventId,
                generationId,
                detectedAt: new Date(),
            },
        });
    }

    return detected.length;
}

function describeCollision(
    type: StructuralConstraintType,
    a: PlacedSession,
    b: PlacedSession,
    ctx: {
        byRoom: Map<string, string[]>;
        byPerson: Map<string, string[]>;
        conflictSets: Map<string, Set<string>>;
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
            // Nested-group propagation: two Sessions collide when their conflict
            // sets intersect, not merely when they share a directly assigned
            // Group. A Cohort lecture and a child Seminar collide.
            const setA = ctx.conflictSets.get(a.id) ?? new Set();
            const setB = ctx.conflictSets.get(b.id) ?? new Set();
            const shared = [...setA].filter((g) => setB.has(g));

            return shared.length ? { reason: 'group_double_booked', groupIds: shared } : null;
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
