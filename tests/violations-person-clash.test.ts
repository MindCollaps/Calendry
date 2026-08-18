import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { refreshViolations } from '../server/utils/violations';

/**
 * PersonDoubleBooking — the blind spot the Group rule structurally cannot see.
 *
 * Mirrors the solver's slice-2 test: a person enrolled in two groups that are
 * UNRELATED in the nesting tree, both scheduled at the same slot. Nothing
 * connects those groups, so `conflictGroupIds()` never links them and no amount
 * of group checking will ever fire. Only resolving both sessions down to people
 * finds it.
 *
 * The two assertions are a pair, and both matter:
 *   - the Person check MUST fire (the gap this closes)
 *   - the Group check must NOT (proving the groups really are unrelated, and
 *     that this is not just the group rule firing under a new name)
 *
 * The second is the same assertion that would have caught the sibling
 * false-positive fixed earlier in this evaluator.
 */
const url = process.env.TEST_MIGRATION_DATABASE_URL ?? process.env.MIGRATION_DATABASE_URL ?? '';
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

const T = 'person-clash';
const ids = {
    tenant: `${T}-tenant`, grid: `${T}-grid`, term: `${T}-term`, kind: `${T}-kind`,
    offering: `${T}-offering`, generation: `${T}-generation`, room: `${T}-room`,
    // Two roots — deliberately NOT parent/child of each other.
    groupChoir: `${T}-group-choir`, groupLab: `${T}-group-lab`,
    dual: `${T}-person-dual`, other: `${T}-person-other`,
    cGroup: `${T}-constraint-group`, cPerson: `${T}-constraint-person`,
    a: `${T}-session-a`, b: `${T}-session-b`,
};

async function reset() {
    await db.$executeRawUnsafe('ALTER TABLE generation DISABLE TRIGGER generation_no_delete');
    await db.$executeRawUnsafe('ALTER TABLE generation DISABLE TRIGGER generation_content_immutable');
    await db.$executeRawUnsafe(`DELETE FROM tenant WHERE id = '${ids.tenant}'`);
    await db.$executeRawUnsafe('ALTER TABLE generation ENABLE TRIGGER generation_no_delete');
    await db.$executeRawUnsafe('ALTER TABLE generation ENABLE TRIGGER generation_content_immutable');
}

/** `dualEnrolled` decides whether one person sits in BOTH unrelated groups. */
async function seed(dualEnrolled: boolean) {
    await reset();

    await db.tenant.create({ data: { id: ids.tenant, slug: T, name: 'Person Clash', timezone: 'UTC' } });
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
    await db.offering.create({
        data: {
            id: ids.offering, tenantId: ids.tenant, termId: ids.term,
            kindId: ids.kind, title: 'Anything', frequency: 2,
        },
    });
    await db.generation.create({
        data: {
            id: ids.generation, tenantId: ids.tenant, version: 1,
            source: 'MANUAL_BASELINE', status: 'APPLIED', isCurrent: true,
        },
    });

    // Two independent roots. Neither is an ancestor or descendant of the other,
    // so group_closure links them in NEITHER direction.
    await db.group.create({ data: { id: ids.groupChoir, tenantId: ids.tenant, name: 'Choir' } });
    await db.group.create({ data: { id: ids.groupLab, tenantId: ids.tenant, name: 'Robotics Lab' } });

    await db.person.create({
        data: { id: ids.dual, tenantId: ids.tenant, givenName: 'Dual', familyName: 'Enrolled' },
    });
    await db.person.create({
        data: { id: ids.other, tenantId: ids.tenant, givenName: 'Only', familyName: 'Lab' },
    });

    await db.membership.create({ data: { tenantId: ids.tenant, groupId: ids.groupChoir, personId: ids.dual } });
    await db.membership.create({
        data: { tenantId: ids.tenant, groupId: ids.groupLab, personId: dualEnrolled ? ids.dual : ids.other },
    });

    for (const [id, groupId] of [[ids.a, ids.groupChoir], [ids.b, ids.groupLab]] as const) {
        await db.session.create({
            data: {
                id, tenantId: ids.tenant, offeringId: ids.offering, termId: ids.term,
                kindId: ids.kind, timeGridId: ids.grid, generationId: ids.generation,
                termWeek: 1, dayOfWeek: 2, blockIndex: 3, durationBlocks: 1,
            },
        });
        await db.sessionGroup.create({ data: { tenantId: ids.tenant, sessionId: id, groupId } });
    }

    await db.constraint.create({
        data: {
            id: ids.cGroup, tenantId: ids.tenant, name: 'No double-booked groups',
            type: 'no_double_booking_group', severity: 'HARD', isEnabled: true,
        },
    });
    await db.constraint.create({
        data: {
            id: ids.cPerson, tenantId: ids.tenant, name: 'No double-booked attendees',
            type: 'no_double_booking_person', severity: 'HARD', isEnabled: true,
        },
    });
}

async function countsByConstraint() {
    await db.$transaction((tx) => refreshViolations(tx as never, {
        tenantId: ids.tenant, sessionIds: [ids.a, ids.b],
    }));

    return {
        group: await db.constraintViolation.count({ where: { constraintId: ids.cGroup } }),
        person: await db.constraintViolation.count({ where: { constraintId: ids.cPerson } }),
    };
}

beforeAll(() => {
    if (!url) {
        throw new Error('No owner database URL; run through tests/run-integration.sh');
    }
});

afterAll(async () => {
    await reset();
    await db.$disconnect();
});

describe('person double-booking across unrelated groups', () => {
    it('flags the clash the group rule cannot see', async () => {
        await seed(true);

        const counts = await countsByConstraint();

        // The gap this closes: one person, two tree-unrelated groups, one slot.
        expect(counts.person).toBeGreaterThan(0);

        // And the proof it is a genuinely different rule: the groups share no
        // ancestor, so the group check must stay silent. If this ever fires,
        // the group rule has regressed to the sibling false positive.
        expect(counts.group).toBe(0);
    });

    it('stays silent when the two groups share nobody', async () => {
        await seed(false);

        const counts = await countsByConstraint();

        // Same placement, same unrelated groups — only the shared person is
        // gone. Without this, the test above would pass for a check that
        // flagged every concurrent pair.
        expect(counts.person).toBe(0);
        expect(counts.group).toBe(0);
    });
});
