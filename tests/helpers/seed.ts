import { randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Seeds fixtures using the OWNER connection.
 *
 * The owner is a superuser and bypasses RLS, which is what a fixture builder
 * needs — it writes into two tenants at once, something no legitimate request
 * can do. The tests themselves then go over HTTP as the app role with real
 * session cookies, where RLS and permissions are fully in force.
 */
const ownerUrl = process.env.TEST_MIGRATION_DATABASE_URL;

if (!ownerUrl) {
    throw new Error('TEST_MIGRATION_DATABASE_URL must be set for integration tests.');
}

export const ownerDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: ownerUrl }) });

const scryptAsync = promisify(scrypt) as (p: string, s: Buffer, k: number) => Promise<Buffer>;

async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const key = await scryptAsync(password, salt, 64);

    return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export const TEST_PASSWORD = 'correct-horse-battery-staple';

export const ACCOUNTS = {
    /** Full permissions in tenant A. */
    adminA: 'admin-a@test.local',
    /** Full permissions in tenant B. */
    adminB: 'admin-b@test.local',
    /** Only `session.read` in tenant A — used for permission-denial tests. */
    viewerA: 'viewer-a@test.local',
    /** A Person in BOTH tenants — used for tenant selection and switching. */
    multi: 'multi@test.local',
};

const ids = {
    federationId: 'test-fed',
    tenantA: 'test-tenant-a',
    tenantB: 'test-tenant-b',
    personA: 'test-person-a',
    personB: 'test-person-b',
    personViewerA: 'test-person-viewer-a',
    personMultiA: 'test-person-multi-a',
    personMultiB: 'test-person-multi-b',
    groupCohortA: 'test-group-cohort-a',
    groupSeminarA: 'test-group-seminar-a',
    roomSharedFederation: 'test-room-shared',
    roomPrivateA: 'test-room-private-a',
    sessionA: 'test-session-a',
    sessionB: 'test-session-b',
    generationA: 'test-generation-a',
    // Solver runs are per-Term; the permission test needs a real term id in
    // tenant A so the request reaches the permission check rather than 404ing
    // on a bad term.
    termA: 'test-term-a',
    termB: 'test-term-b',
};

export type Fixtures = typeof ids;

/** Removes every fixture row. Append-only guards are lifted for the duration. */
export async function teardown() {
    await ownerDb.$executeRawUnsafe('ALTER TABLE session_event DISABLE TRIGGER session_event_append_only');
    await ownerDb.$executeRawUnsafe('ALTER TABLE generation DISABLE TRIGGER generation_no_delete');
    await ownerDb.$executeRawUnsafe('ALTER TABLE generation DISABLE TRIGGER generation_content_immutable');

    const emails = Object.values(ACCOUNTS).map((e) => `'${e}'`).join(',');

    await ownerDb.$executeRawUnsafe(`DELETE FROM account WHERE email IN (${emails})`);
    await ownerDb.$executeRawUnsafe(`DELETE FROM tenant WHERE id IN ('${ids.tenantA}','${ids.tenantB}')`);
    await ownerDb.$executeRawUnsafe(`DELETE FROM room WHERE federation_id = '${ids.federationId}'`);
    await ownerDb.$executeRawUnsafe(`DELETE FROM federation WHERE id = '${ids.federationId}'`);

    await ownerDb.$executeRawUnsafe('ALTER TABLE session_event ENABLE TRIGGER session_event_append_only');
    await ownerDb.$executeRawUnsafe('ALTER TABLE generation ENABLE TRIGGER generation_no_delete');
    await ownerDb.$executeRawUnsafe('ALTER TABLE generation ENABLE TRIGGER generation_content_immutable');
}

export async function seed(): Promise<Fixtures> {
    await teardown();

    const passwordHash = await hashPassword(TEST_PASSWORD);

    // Read the catalogue from the database rather than importing the TypeScript
    // constant: this asserts the migration actually seeded it.
    const allPermissions = await ownerDb.permission.findMany({ select: { key: true } });

    if (allPermissions.length === 0) {
        throw new Error('Permission catalogue is empty — the migration did not seed it.');
    }

    await ownerDb.federation.create({
        data: { id: ids.federationId, slug: 'test-fed', name: 'Test Consortium' },
    });

    for (const [id, slug, name] of [
        [ids.tenantA, 'test-a', 'Tenant A'],
        [ids.tenantB, 'test-b', 'Tenant B'],
    ]) {
        await ownerDb.tenant.create({
            data: { id, federationId: ids.federationId, slug, name, timezone: 'Europe/Berlin' },
        });
    }

    await ownerDb.person.createMany({
        data: [
            { id: ids.personA, tenantId: ids.tenantA, givenName: 'Ada', familyName: 'Alpha', email: 'ada@a.test' },
            { id: ids.personB, tenantId: ids.tenantB, givenName: 'Bo', familyName: 'Beta', email: 'bo@b.test' },
            { id: ids.personViewerA, tenantId: ids.tenantA, givenName: 'Vic', familyName: 'Viewer', email: 'vic@a.test' },
            { id: ids.personMultiA, tenantId: ids.tenantA, givenName: 'Mel', familyName: 'Multi', email: 'mel@a.test' },
            { id: ids.personMultiB, tenantId: ids.tenantB, givenName: 'Mel', familyName: 'Multi', email: 'mel@b.test' },
        ],
    });

    // --- access roles -------------------------------------------------------
    for (const tenantId of [ids.tenantA, ids.tenantB]) {
        const admin = await ownerDb.accessRole.create({
            data: { tenantId, key: 'tenant-admin', name: 'Tenant Administrator', isSystem: true },
        });

        await ownerDb.accessRolePermission.createMany({
            data: allPermissions.map((p) => ({
                accessRoleId: admin.id,
                permissionKey: p.key,
                tenantId,
            })),
        });
    }

    // A deliberately under-privileged role: can read the schedule, nothing else.
    const viewerRole = await ownerDb.accessRole.create({
        data: { tenantId: ids.tenantA, key: 'viewer', name: 'Schedule Viewer' },
    });

    await ownerDb.accessRolePermission.create({
        data: { accessRoleId: viewerRole.id, permissionKey: 'session.read', tenantId: ids.tenantA },
    });

    const adminRoleA = await ownerDb.accessRole.findFirstOrThrow({
        where: { tenantId: ids.tenantA, key: 'tenant-admin' },
    });
    const adminRoleB = await ownerDb.accessRole.findFirstOrThrow({
        where: { tenantId: ids.tenantB, key: 'tenant-admin' },
    });

    await ownerDb.personAccessRole.createMany({
        data: [
            { personId: ids.personA, accessRoleId: adminRoleA.id, tenantId: ids.tenantA },
            { personId: ids.personB, accessRoleId: adminRoleB.id, tenantId: ids.tenantB },
            { personId: ids.personViewerA, accessRoleId: viewerRole.id, tenantId: ids.tenantA },
            { personId: ids.personMultiA, accessRoleId: adminRoleA.id, tenantId: ids.tenantA },
            { personId: ids.personMultiB, accessRoleId: adminRoleB.id, tenantId: ids.tenantB },
        ],
    });

    // --- accounts -----------------------------------------------------------
    const accountLinks: [string, string[]][] = [
        [ACCOUNTS.adminA, [ids.personA]],
        [ACCOUNTS.adminB, [ids.personB]],
        [ACCOUNTS.viewerA, [ids.personViewerA]],
        // One credential, two tenant identities — the federation lecturer case.
        [ACCOUNTS.multi, [ids.personMultiA, ids.personMultiB]],
    ];

    for (const [email, personIds] of accountLinks) {
        const account = await ownerDb.account.create({ data: { email, passwordHash } });

        for (const personId of personIds) {
            await ownerDb.accountPerson.create({ data: { accountId: account.id, personId } });
        }
    }

    // --- scheduling fixtures ------------------------------------------------
    await ownerDb.group.create({ data: { id: ids.groupCohortA, tenantId: ids.tenantA, name: 'Cohort A' } });
    await ownerDb.group.create({
        data: { id: ids.groupSeminarA, tenantId: ids.tenantA, parentGroupId: ids.groupCohortA, name: 'Seminar A1' },
    });
    await ownerDb.membership.create({
        data: { tenantId: ids.tenantA, personId: ids.personA, groupId: ids.groupSeminarA },
    });

    await ownerDb.room.create({
        data: { id: ids.roomSharedFederation, federationId: ids.federationId, code: 'SHARED', name: 'Shared Hall', capacity: 400 },
    });
    await ownerDb.room.create({
        data: { id: ids.roomPrivateA, tenantId: ids.tenantA, code: 'A101', name: 'Private A', capacity: 30 },
    });

    for (const [tenantId, suffix, sessionId] of [
        [ids.tenantA, 'a', ids.sessionA],
        [ids.tenantB, 'b', ids.sessionB],
    ]) {
        await ownerDb.timeGrid.create({
            data: {
                id: `test-grid-${suffix}`, tenantId, name: 'Standard',
                blockLengthMinutes: 45, blocksPerDay: 8, activeDays: [1, 2, 3, 4, 5],
            },
        });
        await ownerDb.term.create({
            data: {
                id: `test-term-${suffix}`, tenantId, name: 'WS2026',
                startDate: new Date('2026-10-01'), endDate: new Date('2027-02-28'),
                timeGridId: `test-grid-${suffix}`,
            },
        });
        await ownerDb.sessionKind.create({
            data: { id: `test-kind-${suffix}`, tenantId, key: 'lecture', name: 'Lecture' },
        });
        await ownerDb.offering.create({
            data: {
                id: `test-offering-${suffix}`, tenantId,
                termId: `test-term-${suffix}`, kindId: `test-kind-${suffix}`,
                title: 'Databases', frequency: 2,
            },
        });
        await ownerDb.generation.create({
            data: {
                id: `test-generation-${suffix}`, tenantId, version: 1,
                source: 'MANUAL_BASELINE', status: 'APPLIED', isCurrent: true,
            },
        });
        await ownerDb.session.create({
            data: {
                id: sessionId, tenantId,
                offeringId: `test-offering-${suffix}`, termId: `test-term-${suffix}`,
                kindId: `test-kind-${suffix}`, timeGridId: `test-grid-${suffix}`,
                termWeek: 1, dayOfWeek: 2, blockIndex: 0,
                generationId: `test-generation-${suffix}`,
            },
        });
    }

    await ownerDb.sessionGroup.create({
        data: { tenantId: ids.tenantA, sessionId: ids.sessionA, groupId: ids.groupSeminarA },
    });
    await ownerDb.sessionPerson.create({
        data: { tenantId: ids.tenantA, sessionId: ids.sessionA, personId: ids.personA },
    });
    await ownerDb.sessionRoom.create({
        data: { tenantId: ids.tenantA, sessionId: ids.sessionA, roomId: ids.roomPrivateA },
    });

    return { ...ids };
}
