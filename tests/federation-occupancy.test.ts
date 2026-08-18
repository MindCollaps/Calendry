import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTS, type Fixtures, TEST_PASSWORD, ownerDb, seed, teardown } from './helpers/seed';
import { login } from './helpers/client';
import { assembleSolverInput } from '../server/utils/solverInput';

/**
 * Occupancy of Federation-shared Rooms by OTHER tenants.
 *
 * Two properties are under test and they pull in opposite directions:
 *
 *   1. tenant B must SEE that a shared hall is busy when tenant A books it —
 *      without this, the solver places into hours already taken, which is why
 *      Stage 3 excluded shared rooms entirely rather than send them blind.
 *   2. tenant B must see NOTHING ELSE. This is an RLS bypass, so "it returns
 *      the right rows" is only half the requirement; the other half is that no
 *      session id, tenant id, offering title or person reference rides along.
 *
 * Asserting only (1) would pass just as well for a function that returned whole
 * Session rows.
 */
let f: Fixtures;

interface OccupancyRow {
    room_id: string;
    /**
     * An absolute date, not a term-relative week. Terms are tenant-scoped, so
     * the other tenant's term id never matches ours and its "week 3" is not our
     * "week 3" — the calendar is the only frame a Federation shares.
     */
    occupied_on: Date;
    block_index: number;
    duration_blocks: number;
}

function occupancyFor(tenantId: string, federationId: string): Promise<OccupancyRow[]> {
    // One transaction so SET LOCAL applies to the function call.
    return ownerDb.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL calendry.tenant_id = '${tenantId}'`);
        await tx.$executeRawUnsafe(`SET LOCAL calendry.federation_id = '${federationId}'`);

        return tx.$queryRawUnsafe<OccupancyRow[]>(
            'SELECT * FROM calendry_internal.federation_room_occupancy()',
        );
    });
}

beforeAll(async () => {
    f = await seed();
    await login(ACCOUNTS.adminA, TEST_PASSWORD);

    // Tenant A books the FEDERATION-SHARED hall. Tenant B cannot see this
    // Session under normal RLS — that is the whole problem being solved.
    await ownerDb.sessionRoom.create({
        data: { tenantId: f.tenantA, sessionId: f.sessionA, roomId: f.roomSharedFederation },
    });
}, 60_000);

afterAll(async () => {
    await teardown();
    await ownerDb.$disconnect();
});

describe('federation_room_occupancy()', () => {
    it('shows tenant B that the shared hall is busy', async () => {
        const rows = await occupancyFor(f.tenantB, f.federationId);
        const shared = rows.filter((r) => r.room_id === f.roomSharedFederation);

        expect(shared.length).toBeGreaterThan(0);

        // And it is real placement data, not a stub.
        expect(shared[0]!.occupied_on).toBeInstanceOf(Date);
        expect(shared[0]!.duration_blocks).toBeGreaterThan(0);
    });

    it('leaks nothing beyond occupancy', async () => {
        const rows = await occupancyFor(f.tenantB, f.federationId);

        // The columns ARE the contract. A future widening that added
        // session_id or tenant_id would fail here rather than ship quietly.
        expect(Object.keys(rows[0]!).sort()).toEqual([
            'block_index', 'duration_blocks', 'occupied_on', 'room_id',
        ]);

        const serialized = JSON.stringify(rows);

        expect(serialized).not.toContain(f.sessionA);
        expect(serialized).not.toContain(f.tenantA);
        expect(serialized).not.toContain('Databases');
        expect(serialized).not.toContain(f.personA);
    });

    it('does not report the caller\'s OWN occupancy', async () => {
        // Tenant A's own booking reaches it through ordinary RLS as an
        // existingSession; counting it here too would double-book it against
        // itself.
        const rows = await occupancyFor(f.tenantA, f.federationId);

        expect(rows.filter((r) => r.room_id === f.roomSharedFederation)).toHaveLength(0);
    });

    it('shows nothing to a tenant outside the federation', async () => {
        // No parameters means the federation comes from session context, so a
        // caller cannot steer this at a federation it does not belong to.
        const rows = await occupancyFor(f.tenantB, 'some-other-federation');

        expect(rows).toHaveLength(0);
    });
});

/**
 * The other half of Stage 7b: the snapshot the solver actually receives.
 *
 * Stage 3 counted federation Rooms as EXCLUDED and sent an empty
 * externalOccupancy. Both flip here, and the pair has to move together — a
 * shared room sent without its occupancy is worse than one omitted, because the
 * solver would place into hours another tenant already holds.
 */
describe('assembleSolverInput with a federation', () => {
    it('sends the shared room, its occupancy, and the federation id', async () => {
        const out = await ownerDb.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL calendry.tenant_id = '${f.tenantB}'`);
            await tx.$executeRawUnsafe(`SET LOCAL calendry.federation_id = '${f.federationId}'`);

            return assembleSolverInput(tx as never, { tenantId: f.tenantB, termId: f.termB });
        });

        // Was hardcoded '' through Stages 1–6.
        expect(out.input.federationId).toBe(f.federationId);

        // The shared hall is now IN the snapshot rather than counted as excluded.
        const shared = out.input.rooms.filter((room) => room.federationId);

        expect(shared.length).toBeGreaterThan(0);
        expect(out.report.includedFederationRooms).toBe(shared.length);

        // Ownership reported honestly: it is not tenant B's room.
        expect(shared[0]!.tenantId).toBe('');

        // And tenant A's booking of it arrives as occupancy.
        expect(out.input.externalOccupancy.length).toBeGreaterThan(0);
        expect(out.report.externalOccupancySlots).toBe(out.input.externalOccupancy.length);

        const entry = out.input.externalOccupancy[0]!;

        expect(entry.roomId).toBe(f.roomSharedFederation);
        expect(entry.durationBlocks).toBeGreaterThan(0);
        // Opaque by design — no identifier of the owning tenant or session.
        expect(entry.sourceRef).not.toContain(f.tenantA);
        expect(entry.sourceRef).not.toContain(f.sessionA);
    });
});
