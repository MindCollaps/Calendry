import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Fixtures, ownerDb, seed, teardown } from './helpers/seed';

/**
 * `access_role` is an ordinary tenant-scoped table, writable by the APP role.
 *
 * WHY THIS EXISTS. `bun run create:role` is the one operator CLI whose writes do
 * not need ownership: it resolves `--tenant <slug>` as the owner (the `tenant`
 * policy makes a slug lookup impossible for anyone who does not already know
 * which tenant they are), then drops to `SET LOCAL ROLE calendry_app` with
 * tenant context before inserting anything. That design rests entirely on the
 * three properties below, and until this file existed they had been verified
 * exactly once, by hand, against one developer's database.
 *
 * The negative cases are the point. A suite asserting only "the app role can
 * write a role" would pass just as well against a build where `tenant_isolation`
 * had been dropped from these tables altogether — which is precisely the failure
 * this project fails closed against everywhere else, and would mean an operator
 * CLI could quietly plant a role in somebody else's tenant.
 *
 * Note what is NOT claimed: this says nothing about the operator's credential,
 * which is still the owner. It pins the WRITE PATH, so that a bug resolving the
 * wrong tenant is refused by the database rather than landing a role in it.
 */
let f: Fixtures;

const ROLE = 'test-role-writability';

/** Runs a query as the app role with one tenant's RLS context, as the CLI does. */
function asTenant<T>(tenantId: string, fn: (tx: typeof ownerDb) => Promise<T>): Promise<T> {
    return ownerDb.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE calendry_app');
        await tx.$executeRawUnsafe(`SET LOCAL calendry.tenant_id = '${tenantId}'`);

        return fn(tx as typeof ownerDb);
    });
}

/** Same, with no tenant context at all — a script that forgot to set it. */
function asAppRoleWithoutContext<T>(fn: (tx: typeof ownerDb) => Promise<T>): Promise<T> {
    return ownerDb.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE calendry_app');

        return fn(tx as typeof ownerDb);
    });
}

beforeAll(async () => {
    f = await seed();
});

afterAll(async () => {
    await teardown();
    await ownerDb.$disconnect();
});

describe('access_role writability under RLS', () => {
    it('the app role CAN create a role and its permissions inside tenant context', async () => {
        const created = await asTenant(f.tenantA, async (tx) => {
            const role = await tx.accessRole.create({
                data: { id: ROLE, tenantId: f.tenantA, key: 'writability', name: 'Writability', isSystem: false },
            });

            await tx.accessRolePermission.createMany({
                data: [
                    { accessRoleId: role.id, permissionKey: 'session.read', tenantId: f.tenantA },
                    { accessRoleId: role.id, permissionKey: 'room.read', tenantId: f.tenantA },
                ],
            });

            return role;
        });

        expect(created.id).toBe(ROLE);

        // Read back through the same path, not the owner: a row the app role
        // wrote but cannot see would be a policy asymmetry, and the CLI would
        // report success over something the application can never use.
        const held = await asTenant(f.tenantA, (tx) => tx.accessRolePermission.findMany({
            where: { accessRoleId: ROLE },
            select: { permissionKey: true },
        }));

        expect(held.map((p) => p.permissionKey).sort()).toEqual(['room.read', 'session.read']);
    });

    it('refuses a role whose tenant_id is not the context tenant', async () => {
        // The mismatched-pair guard. Under the owner this write succeeds
        // silently; this is the whole reason the CLI drops to the app role.
        await expect(asTenant(f.tenantA, (tx) => tx.accessRole.create({
            data: { tenantId: f.tenantB, key: 'smuggled', name: 'Smuggled', isSystem: false },
        }))).rejects.toThrow(/row-level security/i);
    });

    it('refuses a permission row pointing at a different tenant than its role', async () => {
        await expect(asTenant(f.tenantA, (tx) => tx.accessRolePermission.create({
            data: { accessRoleId: ROLE, permissionKey: 'term.read', tenantId: f.tenantB },
        }))).rejects.toThrow(/row-level security/i);
    });

    it('refuses any role write with no tenant context set', async () => {
        await expect(asAppRoleWithoutContext((tx) => tx.accessRole.create({
            data: { tenantId: f.tenantA, key: 'contextless', name: 'Contextless', isSystem: false },
        }))).rejects.toThrow(/row-level security/i);
    });

    it('cannot see another tenant\'s roles', async () => {
        // Tenant B's own admin role exists (the fixture creates one per tenant),
        // so an empty result here is isolation rather than an empty table.
        const fromB = await asTenant(f.tenantB, (tx) => tx.accessRole.findMany({ select: { key: true } }));
        const fromA = await asTenant(f.tenantA, (tx) => tx.accessRole.findMany({ select: { key: true } }));

        expect(fromB.map((r) => r.key).sort()).toEqual(['tenant-admin']);
        expect(fromA.map((r) => r.key).sort()).toEqual(['tenant-admin', 'viewer', 'writability']);
    });

    it('cannot resolve a tenant by slug — why the CLI needs the owner for that', async () => {
        // Not a limitation being worked around: it is the reason `create:role`
        // opens an owner connection at all. Documented as a test so that a future
        // widening of the `tenant` read policy shows up here rather than as a
        // quietly redundant connection in a script.
        // With a tenant set (and no federation context), the app role sees only
        // its own row — so it can confirm a slug it already holds the id for, but
        // cannot go the other way.
        const found = await asTenant(f.tenantA, (tx) => tx.tenant.findMany({ select: { slug: true } }));

        expect(found.map((t) => t.slug)).toEqual(['test-a']);

        // And before any context exists — a CLI's opening move — it sees nothing
        // at all, which is why `--tenant <slug>` cannot be resolved app-side.
        const blind = await asAppRoleWithoutContext((tx) => tx.tenant.findMany({ select: { slug: true } }));

        expect(blind).toEqual([]);
    });
});
