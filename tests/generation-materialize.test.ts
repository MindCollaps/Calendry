import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { SolverOutput } from '@mindcollaps/calendry-proto';
import {
    executePlan, materializeGeneration, planMaterialization,
    summarizePlanByWeek, summarizeProposedViolations,
} from '../server/utils/generationMaterialize';

/**
 * Stage 5 — materializing a solver result into real Session rows.
 *
 * These need a database (they write Sessions, join rows and violations) but not
 * a server, so they run against the owner connection with their own fixtures
 * rather than through HTTP.
 *
 * The partition under test is create / move / DELETE, and the delete is the one
 * that matters: an in-scope Session the solver did not return must go, or the
 * applied schedule keeps a placement the solver rejected while `frequency`
 * appears satisfied.
 */
const url = process.env.TEST_MIGRATION_DATABASE_URL ?? process.env.MIGRATION_DATABASE_URL ?? '';
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

const T = 'mat-test';
const ids = {
    tenant: `${T}-tenant`,
    term: `${T}-term`,
    grid: `${T}-grid`,
    kind: `${T}-kind`,
    role: `${T}-role`,
    room: `${T}-room`,
    person: `${T}-person`,
    group: `${T}-group`,
    offeringA: `${T}-offering-a`,
    offeringB: `${T}-offering-b`,
    constraint: `${T}-constraint`,
    generation: `${T}-generation`,
    keepSession: `${T}-session-keep`,
    moveSession: `${T}-session-move`,
    dropSession: `${T}-session-drop`,
    lockedSession: `${T}-session-locked`,
};

async function reset() {
    await db.$executeRawUnsafe('ALTER TABLE generation DISABLE TRIGGER generation_no_delete');
    await db.$executeRawUnsafe('ALTER TABLE generation DISABLE TRIGGER generation_content_immutable');
    await db.$executeRawUnsafe(`DELETE FROM tenant WHERE id = '${ids.tenant}'`);
    await db.$executeRawUnsafe('ALTER TABLE generation ENABLE TRIGGER generation_no_delete');
    await db.$executeRawUnsafe('ALTER TABLE generation ENABLE TRIGGER generation_content_immutable');
}

async function seed() {
    await reset();

    await db.tenant.create({ data: { id: ids.tenant, slug: T, name: 'Materialize Test', timezone: 'UTC' } });
    await db.timeGrid.create({
        data: {
            id: ids.grid, tenantId: ids.tenant, name: 'Grid',
            blockLengthMinutes: 45, blocksPerDay: 8, activeDays: [1, 2, 3, 4, 5],
        },
    });
    await db.term.create({
        data: {
            id: ids.term, tenantId: ids.tenant, name: 'Term',
            startDate: new Date('2026-10-05'), endDate: new Date('2027-02-12'), timeGridId: ids.grid,
        },
    });
    await db.sessionKind.create({ data: { id: ids.kind, tenantId: ids.tenant, key: 'lecture', name: 'Lecture' } });
    await db.role.create({ data: { id: ids.role, tenantId: ids.tenant, key: 'lecturer', name: 'Lecturer' } });
    await db.room.create({ data: { id: ids.room, tenantId: ids.tenant, code: 'R1', name: 'Room 1', capacity: 40 } });
    await db.person.create({ data: { id: ids.person, tenantId: ids.tenant, givenName: 'A', familyName: 'B' } });
    await db.group.create({ data: { id: ids.group, tenantId: ids.tenant, name: 'G' } });

    for (const id of [ids.offeringA, ids.offeringB]) {
        await db.offering.create({
            data: {
                id, tenantId: ids.tenant, termId: ids.term, kindId: ids.kind,
                title: id, frequency: 2, durationBlocks: 1,
            },
        });
    }

    await db.constraint.create({
        data: {
            id: ids.constraint, tenantId: ids.tenant, type: 'exact_frequency_per_offering',
            name: 'Exact frequency', severity: 'HARD', isEnabled: true,
        },
    });

    await db.generation.create({
        data: { id: ids.generation, tenantId: ids.tenant, version: 1, source: 'SOLVER', status: 'READY' },
    });

    const base = { tenantId: ids.tenant, termId: ids.term, kindId: ids.kind, durationBlocks: 1 };

    // In scope, returned unchanged by the solver.
    await db.session.create({
        data: { ...base, id: ids.keepSession, offeringId: ids.offeringA, termWeek: 1, dayOfWeek: 1, blockIndex: 0 },
    });
    // In scope, returned at a different slot.
    await db.session.create({
        data: { ...base, id: ids.moveSession, offeringId: ids.offeringA, termWeek: 1, dayOfWeek: 1, blockIndex: 1 },
    });
    // In scope, NOT returned — must be deleted.
    await db.session.create({
        data: { ...base, id: ids.dropSession, offeringId: ids.offeringA, termWeek: 1, dayOfWeek: 1, blockIndex: 2 },
    });
    // Locked — must survive untouched even though it is in scope.
    await db.session.create({
        data: {
            ...base, id: ids.lockedSession, offeringId: ids.offeringA,
            termWeek: 1, dayOfWeek: 2, blockIndex: 0, isLocked: true,
        },
    });
}

const output = (over: Partial<Parameters<typeof SolverOutput.fromJSON>[0]> = {}) => SolverOutput.fromJSON({
    sessions: [
        // move: same session, new slot
        {
            sessionId: ids.moveSession, offeringId: ids.offeringA,
            startSlot: { week: 2, day: 4, block: 5 }, durationBlocks: 1,
            roomId: ids.room, lecturerIds: [ids.person], groupIds: [ids.group], personIds: [],
        },
        // create: no session id
        {
            sessionId: '', offeringId: ids.offeringB,
            startSlot: { week: 0, day: 3, block: 2 }, durationBlocks: 1,
            roomId: ids.room, lecturerIds: [], groupIds: [], personIds: [],
        },
        // keep
        {
            sessionId: ids.keepSession, offeringId: ids.offeringA,
            startSlot: { week: 0, day: 1, block: 0 }, durationBlocks: 1,
            roomId: ids.room, lecturerIds: [], groupIds: [], personIds: [],
        },
    ],
    hardViolations: [],
    ...over,
});

describe('materializeGeneration', () => {
    beforeAll(async () => {
        if (!url) {
            throw new Error('No owner database URL; run through tests/run-integration.sh');
        }

        await seed();
    });

    it('creates, moves and deletes in one pass, and never touches a lock', async () => {
        const counts = await db.$transaction((tx) => materializeGeneration(tx as never, {
            tenantId: ids.tenant,
            termId: ids.term,
            generationId: ids.generation,
            output: output(),
            scopeOfferingIds: [ids.offeringA, ids.offeringB],
        }));

        expect(counts.created).toBe(1);
        expect(counts.moved).toBe(1);
        // Returned at the slot it already had — reported separately so an apply
        // that changes nothing does not claim to have moved everything.
        expect(counts.unchanged).toBe(1);
        // The in-scope session the solver did not return.
        expect(counts.deleted).toBe(1);
        expect(counts.skippedLocked).toBe(1);

        expect(await db.session.findUnique({ where: { id: ids.dropSession } })).toBeNull();

        const locked = await db.session.findUniqueOrThrow({ where: { id: ids.lockedSession } });

        expect(locked.dayOfWeek).toBe(2);
        expect(locked.blockIndex).toBe(0);
        expect(locked.generationId).toBeNull();
    });

    it('applies the 0-based → 1-based week shift', async () => {
        const moved = await db.session.findUniqueOrThrow({ where: { id: ids.moveSession } });

        // Wire week 2 is the third week, which is termWeek 3.
        expect(moved.termWeek).toBe(3);
        expect(moved.dayOfWeek).toBe(4);
        expect(moved.blockIndex).toBe(5);
    });

    it('replaces join rows from the placement', async () => {
        const rooms = await db.sessionRoom.findMany({ where: { sessionId: ids.moveSession } });
        const people = await db.sessionPerson.findMany({ where: { sessionId: ids.moveSession } });
        const groups = await db.sessionGroup.findMany({ where: { sessionId: ids.moveSession } });

        expect(rooms.map((r) => r.roomId)).toEqual([ids.room]);
        expect(people.map((p) => p.personId)).toEqual([ids.person]);
        // Lecturers are attributed to the tenant's `lecturer` role.
        expect(people[0]?.roleId).toBe(ids.role);
        expect(groups.map((g) => g.groupId)).toEqual([ids.group]);
    });

    it('leaves out-of-scope sessions alone even when absent from the output', async () => {
        await seed();

        const counts = await db.$transaction((tx) => materializeGeneration(tx as never, {
            tenantId: ids.tenant,
            termId: ids.term,
            generationId: ids.generation,
            // Offering A is NOT in scope this time.
            output: SolverOutput.fromJSON({ sessions: [], hardViolations: [] }),
            scopeOfferingIds: [ids.offeringB],
        }));

        // Nothing deleted: the solver was never asked about offering A, so its
        // silence says nothing about those sessions.
        expect(counts.deleted).toBe(0);
        expect(await db.session.count({ where: { termId: ids.term } })).toBe(4);
    });
});

describe('violation materialization', () => {
    beforeAll(seed);

    it('records a SESSION-scoped violation against its session', async () => {
        await db.$transaction((tx) => materializeGeneration(tx as never, {
            tenantId: ids.tenant,
            termId: ids.term,
            generationId: ids.generation,
            output: output({
                hardViolations: [{
                    constraintId: ids.constraint,
                    constraintType: 'RoomDoubleBooking',
                    sessionIds: [ids.keepSession],
                    offeringIds: [],
                    detail: 'two sessions in one room',
                }],
            }),
            scopeOfferingIds: [ids.offeringA, ids.offeringB],
        }));

        const rows = await db.constraintViolation.findMany({ where: { tenantId: ids.tenant } });

        expect(rows).toHaveLength(1);
        expect(rows[0]?.sessionId).toBe(ids.keepSession);
        expect(rows[0]?.offeringId).toBeNull();
    });

    it('records an OFFERING-scoped violation with a NULL session', async () => {
        await seed();

        // This is the ExactFrequency case the whole nullable-session migration
        // exists for: demand that was never placed has no session to point at.
        await db.$transaction((tx) => materializeGeneration(tx as never, {
            tenantId: ids.tenant,
            termId: ids.term,
            generationId: ids.generation,
            output: output({
                hardViolations: [{
                    constraintId: ids.constraint,
                    constraintType: 'ExactFrequency',
                    sessionIds: [],
                    offeringIds: [ids.offeringB],
                    detail: "offering requires 6 session(s), 4 placed",
                }],
            }),
            scopeOfferingIds: [ids.offeringA, ids.offeringB],
        }));

        const rows = await db.constraintViolation.findMany({ where: { tenantId: ids.tenant } });

        expect(rows).toHaveLength(1);
        expect(rows[0]?.sessionId).toBeNull();
        expect(rows[0]?.offeringId).toBe(ids.offeringB);
        expect(rows[0]?.generationId).toBe(ids.generation);
    });

    it('does not duplicate an offering-scoped violation on a second apply', async () => {
        // NULLS NOT DISTINCT: without it Postgres would treat every
        // (constraint, NULL, offering) row as unique against itself.
        await db.$transaction((tx) => materializeGeneration(tx as never, {
            tenantId: ids.tenant,
            termId: ids.term,
            generationId: ids.generation,
            output: output({
                hardViolations: [{
                    constraintId: ids.constraint,
                    constraintType: 'ExactFrequency',
                    sessionIds: [],
                    offeringIds: [ids.offeringB],
                    detail: 'again',
                }],
            }),
            scopeOfferingIds: [ids.offeringA, ids.offeringB],
        }));

        expect(await db.constraintViolation.count({ where: { tenantId: ids.tenant } })).toBe(1);
    });

    it('counts a violation naming an unknown constraint as unmapped', async () => {
        await seed();

        const counts = await db.$transaction((tx) => materializeGeneration(tx as never, {
            tenantId: ids.tenant,
            termId: ids.term,
            generationId: ids.generation,
            output: output({
                hardViolations: [{
                    constraintId: 'deleted-between-run-and-apply',
                    constraintType: 'RoomDoubleBooking',
                    sessionIds: [ids.keepSession],
                    offeringIds: [],
                    detail: '',
                }],
            }),
            scopeOfferingIds: [ids.offeringA, ids.offeringB],
        }));

        expect(counts.violationsUnmapped).toBe(1);
        expect(await db.constraintViolation.count({ where: { tenantId: ids.tenant } })).toBe(0);

        await reset();
        await db.$disconnect();
    });
});

/**
 * Stage 6a — the plan/execute split.
 *
 * The property under test is not that planning produces plausible numbers, but
 * that the plan a PREVIEW shows is the decision an APPLY carries out. Two
 * implementations of one rule would drift apart silently, and the drift would
 * surface as a review screen that quietly lies about what a button does.
 */
describe('planMaterialization', () => {
    beforeAll(async () => {
        await seed();
    });

    it('classifies every placement without writing anything', async () => {
        const before = await db.session.count({ where: { tenantId: ids.tenant } });

        const plan = await db.$transaction((tx) => planMaterialization(tx as never, {
            tenantId: ids.tenant,
            termId: ids.term,
            output: output(),
            scopeOfferingIds: [ids.offeringA, ids.offeringB],
        }));

        expect(plan.counts).toEqual({
            created: 1, moved: 1, unchanged: 1, deleted: 1,
            skippedLocked: 1, placementsUnmapped: 0,
        });

        // The point of a plan: the database is untouched.
        expect(await db.session.count({ where: { tenantId: ids.tenant } })).toBe(before);
        expect(await db.session.findUnique({ where: { id: ids.dropSession } })).not.toBeNull();
    });

    it('carries the previous placement on a move, so a diff can be rendered', async () => {
        const plan = await db.$transaction((tx) => planMaterialization(tx as never, {
            tenantId: ids.tenant, termId: ids.term, output: output(),
            scopeOfferingIds: [ids.offeringA, ids.offeringB],
        }));

        const move = plan.placements.find((p) => p.action === 'move');

        expect(move?.sessionId).toBe(ids.moveSession);
        expect(move?.previous).not.toBeNull();
        // Wire week 2 → termWeek 3, and the row it moves from is week 1.
        expect(move?.placement.termWeek).toBe(3);
        expect(move?.previous?.termWeek).toBe(1);

        const create = plan.placements.find((p) => p.action === 'create');

        expect(create?.sessionId).toBeNull();
        expect(create?.previous).toBeNull();
    });

    it('is stable: planning twice against unchanged data gives the same plan', async () => {
        const args = {
            tenantId: ids.tenant, termId: ids.term, output: output(),
            scopeOfferingIds: [ids.offeringA, ids.offeringB],
        };

        const first = await db.$transaction((tx) => planMaterialization(tx as never, args));
        const second = await db.$transaction((tx) => planMaterialization(tx as never, args));

        expect(second).toEqual(first);
    });

    it('counts an unwritable placement as placementsUnmapped, not as a violation', async () => {
        // The split this test exists for: a placement naming an Offering that is
        // not in this term cannot be stored, and that is a different failure
        // from a violation that cannot be attached to a row.
        const plan = await db.$transaction((tx) => planMaterialization(tx as never, {
            tenantId: ids.tenant,
            termId: ids.term,
            output: output({
                sessions: [{
                    sessionId: '', offeringId: 'no-such-offering',
                    startSlot: { week: 0, day: 1, block: 0 }, durationBlocks: 1,
                    roomId: '', lecturerIds: [], groupIds: [], personIds: [],
                }],
            }),
            scopeOfferingIds: [ids.offeringA, ids.offeringB],
        }));

        expect(plan.counts.placementsUnmapped).toBe(1);
        expect(plan.counts.created).toBe(0);
    });

    it('executing a plan produces exactly the plan\'s own counts', async () => {
        await seed();

        const plan = await db.$transaction((tx) => planMaterialization(tx as never, {
            tenantId: ids.tenant, termId: ids.term, output: output(),
            scopeOfferingIds: [ids.offeringA, ids.offeringB],
        }));

        const counts = await db.$transaction((tx) => executePlan(tx as never, plan, {
            tenantId: ids.tenant,
            termId: ids.term,
            generationId: ids.generation,
            violations: [],
        }));

        // Field for field. This is the invariant the preview route depends on.
        expect(counts).toMatchObject(plan.counts);
    });

    it('matches materializeGeneration, which is the same two steps in one call', async () => {
        await seed();

        const plan = await db.$transaction((tx) => planMaterialization(tx as never, {
            tenantId: ids.tenant, termId: ids.term, output: output(),
            scopeOfferingIds: [ids.offeringA, ids.offeringB],
        }));

        await seed();

        const counts = await db.$transaction((tx) => materializeGeneration(tx as never, {
            tenantId: ids.tenant, termId: ids.term, generationId: ids.generation,
            output: output(), scopeOfferingIds: [ids.offeringA, ids.offeringB],
        }));

        expect(counts).toMatchObject(plan.counts);
    });
});

describe('summarizePlanByWeek', () => {
    it('buckets each action into the week it lands in', async () => {
        await seed();

        const plan = await db.$transaction((tx) => planMaterialization(tx as never, {
            tenantId: ids.tenant, termId: ids.term, output: output(),
            scopeOfferingIds: [ids.offeringA, ids.offeringB],
        }));

        const weeks = summarizePlanByWeek(plan);
        const total = weeks.reduce((sum, w) => ({
            created: sum.created + w.created,
            moved: sum.moved + w.moved,
            unchanged: sum.unchanged + w.unchanged,
            deleted: sum.deleted + w.deleted,
        }), { created: 0, moved: 0, unchanged: 0, deleted: 0 });

        // The index must agree with the headline counts beside it, or the week
        // picker sends someone to a week where nothing happened.
        expect(total).toEqual({
            created: plan.counts.created,
            moved: plan.counts.moved,
            unchanged: plan.counts.unchanged,
            deleted: plan.counts.deleted,
        });
    });

    it('is sorted by week and counts a deletion in the week it currently occupies', async () => {
        await seed();

        const plan = await db.$transaction((tx) => planMaterialization(tx as never, {
            tenantId: ids.tenant, termId: ids.term, output: output(),
            scopeOfferingIds: [ids.offeringA, ids.offeringB],
        }));

        const weeks = summarizePlanByWeek(plan);

        expect(weeks.map((w) => w.termWeek)).toEqual([...weeks.map((w) => w.termWeek)].sort((a, b) => a - b));

        // The dropped session sits in week 1, so that is where a reviewer looks
        // for it — not in whatever week the solver's output happened to mention.
        const deleted = weeks.find((w) => w.deleted > 0);

        expect(deleted?.termWeek).toBe(1);
    });

    it('returns nothing for a plan with no placements at all', () => {
        expect(summarizePlanByWeek({
            placements: [], deletes: [], skippedLocked: [],
            counts: { created: 0, moved: 0, unchanged: 0, deleted: 0, skippedLocked: 0, placementsUnmapped: 0 },
        })).toEqual([]);
    });
});

describe('summarizeProposedViolations', () => {
    it('reports references to Sessions the solver invented as unmappable', async () => {
        const out = output({
            hardViolations: [
                {
                    constraintId: ids.constraint, constraintType: 'GroupDoubleBooking',
                    // One real Session id, one synthetic "<offering>#<index>" key
                    // that appears nowhere in the placements.
                    sessionIds: [ids.keepSession, `${ids.offeringA}#19`],
                    offeringIds: [], detail: 'nested groups',
                },
            ],
        });

        const summary = summarizeProposedViolations(out.hardViolations);

        expect(summary.hard).toBe(1);
        expect(summary.sessionReferences).toBe(2);
        // Reported, never netted out — a review screen that shows 1 clash when
        // there are 2 is worse than one that admits it cannot locate one.
        expect(summary.unmappable).toBe(1);
        expect(summary.byType).toEqual({ GroupDoubleBooking: 1 });
    });

    it('reports nothing unmappable for an all-real violation set', async () => {
        const out = output({
            hardViolations: [{
                constraintId: ids.constraint, constraintType: 'RoomDoubleBooking',
                sessionIds: [ids.keepSession, ids.moveSession], offeringIds: [], detail: 'room',
            }],
        });

        expect(summarizeProposedViolations(out.hardViolations).unmappable).toBe(0);
    });
});

afterAll(async () => {
    await reset();
    await db.$disconnect();
});
