import type { PrismaClient } from '@prisma/client';
import { PERMISSIONS } from '../../../server/utils/permissions';

/**
 * REFERENCE seed — required in every environment, production included.
 *
 * The `permission` catalogue is the fixed set of actions the code implements.
 * Tenants bundle these into AccessRoles but can never invent one, because a
 * permission with no corresponding code path is meaningless. That makes this
 * code-derived reference data rather than sample content, which is why it
 * belongs in a seed that always runs rather than in fixtures.
 *
 * `server/utils/permissions.ts` is the single source of truth; this file only
 * transports it into the database.
 */
export interface PermissionSeedResult {
    created: number;
    updated: number;
    stale: string[];
    pruned: number;
    prunedGrants: number;
}

export async function seedPermissions(
    prisma: PrismaClient,
    options: { prune?: boolean } = {},
): Promise<PermissionSeedResult> {
    // One round trip to learn what already exists, rather than a findUnique per
    // row — this runs on every deploy.
    const existing = await prisma.permission.findMany({ select: { key: true } });
    const existingKeys = new Set(existing.map((p) => p.key));

    let created = 0;
    let updated = 0;

    for (const permission of PERMISSIONS) {
        // Upsert keyed on `key`, which IS the primary key and a genuine natural
        // key ('session.move'), so re-running cannot duplicate or mismatch rows.
        await prisma.permission.upsert({
            where: { key: permission.key },
            create: permission,
            update: { category: permission.category, description: permission.description },
        });

        if (existingKeys.has(permission.key)) {
            updated++;
        } else {
            created++;
        }
    }

    const desiredKeys = new Set(PERMISSIONS.map((p) => p.key));
    const stale = [...existingKeys].filter((key) => !desiredKeys.has(key)).sort();

    let pruned = 0;
    let prunedGrants = 0;

    if (stale.length > 0 && options.prune) {
        // Deleting a permission CASCADES into access_role_permission, silently
        // stripping it from every tenant role that had been granted it. That is
        // why pruning is opt-in and the blast radius is reported.
        prunedGrants = await prisma.accessRolePermission.count({
            where: { permissionKey: { in: stale } },
        });

        pruned = (await prisma.permission.deleteMany({ where: { key: { in: stale } } })).count;
    }

    return { created, updated, stale, pruned, prunedGrants };
}
