import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { refreshViolations } from '../server/utils/violations';

/**
 * A virtual Room hosts unlimited concurrent Sessions.
 *
 * TAXONOMY.md models online delivery AS a Room rather than a flag on the
 * Session, so room-assignment logic stays uniform — but "uniform" has to stop at
 * the occupancy rule, or the one room every online session shares becomes a
 * capacity-1 resource. Two lectures streaming at the same hour are not a clash.
 *
 * The pair below is the point: the same placement is a violation in a physical
 * room and not in a virtual one. Asserting only the virtual case would pass just
 * as well against a build where room checking was broken outright.
 */
const url = process.env.TEST_MIGRATION_DATABASE_URL ?? process.env.MIGRATION_DATABASE_URL ?? '';
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

const T = 'virt-test';
const ids = {
    tenant: `${T}-tenant`,
    grid: `${T}-grid`,
    term: `${T}-term`,
    kind: `${T}-kind`,
    offering: `${T}-offering`,
    generation: `${T}-generation`,
    physical: `${T}-room-physical`,
    virtual: `${T}-room-virtual`,
    constraint: `${T}-constraint`,
    a: `${T}-session-a`,
    b: `${T}-session-b`,
};

async function reset() {
    await db.$executeRawUnsafe('ALTER TABLE generation DISABLE TRIGGER generation_no_delete');
    await db.$executeRawUnsafe('ALTER TABLE generation DISABLE TRIGGER generation_content_immutable');
    await db.$executeRawUnsafe(`DELETE FROM tenant WHERE id = '${ids.tenant}'`);
    await db.$executeRawUnsafe('ALTER TABLE generation ENABLE TRIGGER generation_no_delete');
    await db.$executeRawUnsafe('ALTER TABLE generation ENABLE TRIGGER generation_content_immutable');
}

/** Two sessions in the SAME slot, both in `roomId`. */
async function seed(roomId: string) {
    await reset();

    await db.tenant.create({ data: { id: ids.tenant, slug: T, name: 'Virtual Room Test', timezone: 'UTC' } });
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
            kindId: ids.kind, title: 'Streamed', frequency: 2,
        },
    });
    await db.generation.create({
        data: {
            id: ids.generation, tenantId: ids.tenant, version: 1,
            source: 'MANUAL_BASELINE', status: 'APPLIED', isCurrent: true,
        },
    });
    await db.room.create({
        data: { id: ids.physical, tenantId: ids.tenant, code: 'P1', name: 'Hall', capacity: 100, isVirtual: false },
    });
    await db.room.create({
        data: { id: ids.virtual, tenantId: ids.tenant, code: 'ONLINE', name: 'Online', capacity: 999, isVirtual: true },
    });
    await db.constraint.create({
        data: {
            id: ids.constraint, tenantId: ids.tenant, name: 'No room double booking',
            type: 'no_double_booking_room', severity: 'HARD', isEnabled: true,
        },
    });

    for (const id of [ids.a, ids.b]) {
        await db.session.create({
            data: {
                id, tenantId: ids.tenant, offeringId: ids.offering, termId: ids.term,
                kindId: ids.kind, timeGridId: ids.grid, generationId: ids.generation,
                termWeek: 1, dayOfWeek: 2, blockIndex: 3, durationBlocks: 1,
            },
        });
        await db.sessionRoom.create({ data: { tenantId: ids.tenant, sessionId: id, roomId } });
    }
}

async function roomViolations(): Promise<number> {
    await db.$transaction((tx) => refreshViolations(tx as never, {
        tenantId: ids.tenant,
        sessionIds: [ids.a, ids.b],
    }));

    return db.constraintViolation.count({
        where: { tenantId: ids.tenant, constraintId: ids.constraint },
    });
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

describe('room double-booking and is_virtual', () => {
    it('flags two sessions sharing a PHYSICAL room at the same slot', async () => {
        await seed(ids.physical);

        // The control. Without this, the test below could pass because room
        // checking was broken entirely rather than because virtual is exempt.
        expect(await roomViolations()).toBeGreaterThan(0);
    });

    it('does NOT flag two sessions sharing a VIRTUAL room at the same slot', async () => {
        await seed(ids.virtual);

        expect(await roomViolations()).toBe(0);
    });

    it('still flags the physical clash when a virtual room is also present', async () => {
        // A tenant that owns both kinds must not lose physical enforcement just
        // because a virtual room exists to be filtered out.
        await seed(ids.physical);

        expect(await roomViolations()).toBeGreaterThan(0);
    });
});
