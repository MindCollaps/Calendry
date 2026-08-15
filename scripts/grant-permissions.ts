/**
 * Grants catalogue permissions to existing tenants' AccessRoles.
 *
 * WHY THIS EXISTS
 * ---------------
 * `prisma db seed` keeps the `permission` catalogue in step with
 * `server/utils/permissions.ts`, but it deliberately does not touch
 * `access_role_permission` — which permissions a tenant's roles *hold* is
 * tenant configuration, not reference data, and a seed that silently widened
 * every tenant's admin role on every deploy would be a privilege escalation
 * with no audit trail.
 *
 * `provision:tenant` grants the whole catalogue, but only at creation time. So
 * adding a permission leaves every EXISTING tenant's admin role missing it, and
 * the symptom is a 403 on a feature that visibly exists. This is the backfill.
 *
 * WHY THE OWNER CONNECTION
 * ------------------------
 * Unlike reset:password, this writes `access_role_permission`, which carries a
 * tenant-scoped RLS policy keyed to `calendry_internal.current_tenant_id()`.
 * Operating across several tenants in one run would mean re-entering tenant
 * context per tenant as the app role; the owner bypasses RLS and can do it in
 * one transaction. That is the same authority `provision:tenant` already needs,
 * and it is why this is a CLI rather than an endpoint — see below.
 *
 * WHY A CLI, NOT AN ENDPOINT
 * --------------------------
 * Same reasoning as provision:tenant and reset:password. An endpoint that can
 * add permissions to an access role is a privilege-escalation endpoint reachable
 * from the internet. Keeping it out of the app means the running application
 * cannot widen anyone's authority, however it is tricked.
 *
 * Note this is an OPERATOR backfill, not the tenant-facing role editor. Letting
 * a tenant admin compose their own AccessRoles is Step 14.
 *
 *   bun run grant:permissions -- --role tenant-admin --permissions session_kind.read,session_kind.create
 *   bun run grant:permissions -- --role tenant-admin --all-missing            # whole catalogue
 *   bun run grant:permissions -- --role tenant-admin --all-missing --tenant test
 *   bun run grant:permissions -- --role tenant-admin --all-missing --dry-run
 */
import { createInterface } from 'node:readline/promises';
import { hostname, userInfo } from 'node:os';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { PERMISSION_KEYS } from '../server/utils/permissions';
import { describeTarget, resolveOwnerDatabaseUrl } from './lib/ownerDatabaseUrl';

function arg(name: string): string | undefined {
    const index = process.argv.indexOf(`--${name}`);

    return index === -1 ? undefined : process.argv[index + 1];
}

interface PlannedGrant {
    tenantSlug: string;
    accessRoleId: string;
    accessRoleKey: string;
    tenantId: string;
    missing: string[];
}

async function main() {
    const roleKey = arg('role');
    const permissionsArg = arg('permissions');
    const allMissing = process.argv.includes('--all-missing');
    const tenantSlug = arg('tenant');
    const dryRun = process.argv.includes('--dry-run');
    const skipConfirm = process.argv.includes('--yes');

    if (!roleKey) {
        console.error('\nMissing required --role (the AccessRole key, e.g. tenant-admin)\n');
        process.exit(1);
    }

    // Exactly one source of truth for what to grant. Accepting both would leave
    // the precedence ambiguous, and "it silently ignored my --permissions" is
    // precisely the failure this codebase keeps designing against.
    if (Boolean(permissionsArg) === allMissing) {
        console.error('\nSpecify exactly one of --permissions <a,b,c> or --all-missing.\n');
        process.exit(1);
    }

    let requested: string[];

    if (allMissing) {
        requested = [...PERMISSION_KEYS];
    } else {
        requested = (permissionsArg as string).split(',').map((k) => k.trim()).filter(Boolean);

        // A typo'd permission key would otherwise fail on the foreign key with
        // an opaque message, or — worse, if it happened to be a prefix of a real
        // one — grant nothing and report success.
        const unknown = requested.filter((key) => !PERMISSION_KEYS.includes(key));

        if (unknown.length) {
            console.error(`\nNot in the permission catalogue: ${unknown.join(', ')}`);
            console.error('The catalogue is server/utils/permissions.ts. Permissions are code, not data.\n');
            process.exit(1);
        }
    }

    const connectionString = resolveOwnerDatabaseUrl();
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

    try {
        // The catalogue must already be in the database, or the FK below fails.
        // Checking first turns "constraint violation on permission_key" into a
        // sentence naming the missing step.
        const catalogue = new Set((await prisma.permission.findMany({ select: { key: true } })).map((p) => p.key));
        const notSeeded = requested.filter((key) => !catalogue.has(key));

        if (notSeeded.length) {
            console.error(`\n${notSeeded.length} permission(s) are in the code but not in the database:`);
            console.error(`  ${notSeeded.slice(0, 8).join(', ')}${notSeeded.length > 8 ? ' …' : ''}`);
            console.error('\nRun `bun run db-seed` first — the catalogue is seeded, not migrated.\n');
            process.exit(1);
        }

        const roles = await prisma.accessRole.findMany({
            where: {
                key: roleKey,
                ...(tenantSlug ? { tenant: { slug: tenantSlug } } : {}),
            },
            select: {
                id: true,
                key: true,
                tenantId: true,
                tenant: { select: { slug: true } },
                permissions: { select: { permissionKey: true } },
            },
        });

        if (roles.length === 0) {
            console.error(
                `\nNo AccessRole with key '${roleKey}'`
                + `${tenantSlug ? ` in tenant '${tenantSlug}'` : ' in any tenant'}.\n`,
            );
            process.exit(1);
        }

        const planned: PlannedGrant[] = roles.map((role) => {
            const held = new Set(role.permissions.map((p) => p.permissionKey));

            return {
                tenantSlug: role.tenant.slug,
                tenantId: role.tenantId,
                accessRoleId: role.id,
                accessRoleKey: role.key,
                missing: requested.filter((key) => !held.has(key)),
            };
        });

        const totalMissing = planned.reduce((sum, p) => sum + p.missing.length, 0);

        console.log(`\nRole      ${roleKey}`);
        console.log(`Tenants   ${planned.length} (${planned.map((p) => p.tenantSlug).join(', ')})`);
        console.log(`Requested ${requested.length} permission(s)`);
        console.log(`To grant  ${totalMissing} missing grant(s)\n`);

        for (const plan of planned) {
            if (plan.missing.length === 0) {
                console.log(`  ${plan.tenantSlug}: already complete`);
            } else {
                console.log(`  ${plan.tenantSlug}: +${plan.missing.length} → ${plan.missing.join(', ')}`);
            }
        }

        // "Nothing to do" is reported as itself and exits 0 — distinguishable
        // from a run that matched no roles (which exits 1 above).
        if (totalMissing === 0) {
            console.log('\nNothing to grant. Every listed role already holds every requested permission.\n');

            return;
        }

        if (dryRun) {
            console.log('\n--dry-run: nothing was written.\n');

            return;
        }

        if (!skipConfirm) {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            const answer = await rl.question(`\nGrant ${totalMissing} permission(s)? Type the role key to confirm (${roleKey}): `);

            rl.close();

            if (answer.trim() !== roleKey) {
                console.error('\nDoes not match. Nothing was changed.\n');
                process.exit(1);
            }
        }

        // One transaction across every tenant: a partial backfill leaves some
        // tenants able to use a feature and others 403ing on it, which is harder
        // to diagnose than a clean failure.
        const written = await prisma.$transaction(async (tx) => {
            let count = 0;

            for (const plan of planned) {
                if (plan.missing.length === 0) {
                    continue;
                }

                const result = await tx.accessRolePermission.createMany({
                    data: plan.missing.map((permissionKey) => ({
                        accessRoleId: plan.accessRoleId,
                        permissionKey,
                        tenantId: plan.tenantId,
                    })),
                    // Belt and braces against a concurrent run; `missing` was
                    // already computed against what is held.
                    skipDuplicates: true,
                });

                count += result.count;
            }

            return count;
        });

        const record = {
            ts: new Date().toISOString(),
            action: 'access_role.permissions_granted',
            roleKey,
            tenants: planned.filter((p) => p.missing.length).map((p) => p.tenantSlug),
            granted: written,
            permissions: [...new Set(planned.flatMap((p) => p.missing))].sort(),
            operator: `${userInfo().username}@${hostname()}`,
            via: 'cli:grant-permissions',
        };

        console.log(`\nGranted ${written} permission(s).`);
        console.log('Sessions are NOT revoked: permissions are read per request, so');
        console.log('signed-in users pick this up on their next call.\n');

        // Same reasoning as reset:password — stdout to an external collector,
        // not a table the operator running this could rewrite.
        console.log(`AUDIT ${JSON.stringify(record)}`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (/Unable to start a transaction|Can't reach database server|ECONNREFUSED|ENOTFOUND/i.test(message)) {
            console.error(
                `\nCould not reach the database at ${describeTarget(connectionString)}.\n`
                + '  - Running?  docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db\n'
                + '  - Reachable from here? See MIGRATION_DATABASE_URL_HOST in .env.example.\n',
            );
        } else {
            console.error(`\nGrant failed, nothing was changed: ${message}\n`);
        }

        process.exit(1);
    } finally {
        await prisma.$disconnect();
    }
}

await main();
