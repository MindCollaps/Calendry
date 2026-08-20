import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Fixtures, ownerDb, seed, teardown } from './helpers/seed';

/**
 * A Federation-shared Session, and the line RLS draws around it.
 *
 * TAXONOMY.md §2's amendment makes Session a third federation-shareable entity.
 * Its literal wording also said the relation tables should let a shared Session
 * reference Groups and Persons from either member tenant — which, implemented
 * literally, means widening RLS on `group` and `person`, so Federation
 * membership would imply roster visibility.
 *
 * This suite pins the NARROWER design that was chosen instead:
 *
 *   the SESSION is shared          → both tenants read the row
 *   session_room is shared         → where a shared event happens is shared info
 *   session_group / session_person → tenant-private, in BOTH directions
 *
 * The last one is the whole point. Tenant B can legitimately read the shared
 * Session; it must still not learn which of tenant A's groups or people are on
 * it. Testing only "B can see the Session" would pass just as well for a design
 * that leaked the entire roster with it.
 */
let f: Fixtures;

const SHARED = 'fed-shared-session';

/** Runs a query with one tenant's RLS context, as a request would. */
function asTenant<T>(tenantId: string, federationId: string, fn: (tx: typeof ownerDb) => Promise<T>): Promise<T> {
    return ownerDb.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE calendry_app`);
        await tx.$executeRawUnsafe(`SET LOCAL calendry.tenant_id = '${tenantId}'`);
        await tx.$executeRawUnsafe(`SET LOCAL calendry.federation_id = '${federationId}'`);

        return fn(tx as typeof ownerDb);
    });
}

beforeAll(async () => {
    f = await seed();

    // A shared Session, created through the OWNER connection: no route does
    // this, because creating one is a privileged path and federation-level
    // permissions are out of scope (TAXONOMY.md §9.4). 7c makes the schema
    // CAPABLE; it deliberately does not open a door.
    await ownerDb.$executeRawUnsafe(`
        INSERT INTO session (id, tenant_id, federation_id, offering_id, term_id, kind_id,
                             time_grid_id, generation_id, term_week, day_of_week,
                             block_index, duration_blocks, is_locked, created_at, updated_at)
        VALUES ('${SHARED}', NULL, '${f.federationId}', 'test-offering-a', 'test-term-a',
                'test-kind-a', 'test-grid-a', 'test-generation-a', 1, 4, 2, 1, false,
                now(), now())
    `);

    // Tenant A attaches ITS OWN group, person and the shared room.
    await ownerDb.$executeRawUnsafe(
        `INSERT INTO session_group (tenant_id, session_id, group_id)
         VALUES ('${f.tenantA}', '${SHARED}', '${f.groupCohortA}')`);
    await ownerDb.$executeRawUnsafe(
        `INSERT INTO session_person (tenant_id, session_id, person_id)
         VALUES ('${f.tenantA}', '${SHARED}', '${f.personA}')`);
    await ownerDb.$executeRawUnsafe(
        `INSERT INTO session_room (tenant_id, session_id, room_id)
         VALUES ('${f.tenantA}', '${SHARED}', '${f.roomSharedFederation}')`);
}, 60_000);

afterAll(async () => {
    await ownerDb.$executeRawUnsafe(`DELETE FROM session WHERE id = '${SHARED}'`).catch(() => {});
    await teardown();
    await ownerDb.$disconnect();
});

describe('the shared Session row', () => {
    it('is readable by BOTH member tenants', async () => {
        for (const tenantId of [f.tenantA, f.tenantB]) {
            const rows = await asTenant(tenantId, f.federationId, (tx) =>
                tx.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM session WHERE id = '${SHARED}'`));

            expect(rows, `tenant ${tenantId} should see the shared session`).toHaveLength(1);
        }
    });

    it('is not readable by a tenant outside the federation', async () => {
        const rows = await asTenant(f.tenantB, 'some-other-federation', (tx) =>
            tx.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM session WHERE id = '${SHARED}'`));

        expect(rows).toHaveLength(0);
    });

    it('cannot be written by a member tenant', async () => {
        /**
         * WITH CHECK is narrower than USING: readable, not writable.
         *
         * Note HOW that manifests. An UPDATE whose rows are filtered out by the
         * write policy's USING clause affects ZERO ROWS — it does not raise.
         * Asserting a throw would be testing the wrong mechanism entirely, so
         * this asserts the thing that actually protects the data: nothing
         * changed.
         */
        const affected = await asTenant(f.tenantB, f.federationId, (tx) =>
            tx.$executeRawUnsafe(`UPDATE session SET block_index = 7 WHERE id = '${SHARED}'`));

        expect(affected).toBe(0);

        const [row] = await ownerDb.$queryRawUnsafe<{ block_index: number }[]>(
            `SELECT block_index FROM session WHERE id = '${SHARED}'`);

        expect(row!.block_index).toBe(2);
    });
});

describe('participant links stay tenant-private', () => {
    it('does NOT expose tenant A\'s groups on the shared Session to tenant B', async () => {
        // The property the whole divergence exists for.
        const rows = await asTenant(f.tenantB, f.federationId, (tx) =>
            tx.$queryRawUnsafe<{ id: string }[]>(
                `SELECT session_id FROM session_group WHERE session_id = '${SHARED}'`));

        expect(rows).toHaveLength(0);
    });

    it('does NOT expose tenant A\'s people on the shared Session to tenant B', async () => {
        const rows = await asTenant(f.tenantB, f.federationId, (tx) =>
            tx.$queryRawUnsafe<{ id: string }[]>(
                `SELECT session_id FROM session_person WHERE session_id = '${SHARED}'`));

        expect(rows).toHaveLength(0);
    });

    it('still shows tenant A its OWN links — the isolation is not just blanket denial', async () => {
        // Without this, the two assertions above would pass for a policy that
        // hid the rows from everybody, which would be a different bug.
        const groups = await asTenant(f.tenantA, f.federationId, (tx) =>
            tx.$queryRawUnsafe<{ id: string }[]>(
                `SELECT session_id FROM session_group WHERE session_id = '${SHARED}'`));
        const people = await asTenant(f.tenantA, f.federationId, (tx) =>
            tx.$queryRawUnsafe<{ id: string }[]>(
                `SELECT session_id FROM session_person WHERE session_id = '${SHARED}'`));

        expect(groups).toHaveLength(1);
        expect(people).toHaveLength(1);
    });
});

describe('session_room IS widened', () => {
    it('lets tenant B see where the shared Session happens', async () => {
        // Where a shared event takes place is genuinely shared information —
        // the one relation table that follows room_equipment's precedent.
        const rows = await asTenant(f.tenantB, f.federationId, (tx) =>
            tx.$queryRawUnsafe<{ room_id: string }[]>(
                `SELECT room_id FROM session_room WHERE session_id = '${SHARED}'`));

        expect(rows).toHaveLength(1);
        expect(rows[0]!.room_id).toBe(f.roomSharedFederation);
    });

    it('still refuses tenant B a WRITE to that link', async () => {
        // Readable through the widened SELECT policy, untouchable through the
        // tenant-only write policy — and again, silently, by affecting nothing.
        const affected = await asTenant(f.tenantB, f.federationId, (tx) =>
            tx.$executeRawUnsafe(`DELETE FROM session_room WHERE session_id = '${SHARED}'`));

        expect(affected).toBe(0);

        const rows = await ownerDb.$queryRawUnsafe<{ room_id: string }[]>(
            `SELECT room_id FROM session_room WHERE session_id = '${SHARED}'`);

        expect(rows).toHaveLength(1);
    });
});

describe('ordinary tenant-only Sessions are unaffected', () => {
    it('keeps tenant B out of tenant A\'s own Session entirely', async () => {
        const rows = await asTenant(f.tenantB, f.federationId, (tx) =>
            tx.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM session WHERE id = '${f.sessionA}'`));

        expect(rows).toHaveLength(0);
    });
});
