/**
 * Creates a new AccessRole in an EXISTING tenant, with an explicit permission set.
 *
 * WHY THIS EXISTS
 * ---------------
 * There was no path — CLI or otherwise — to create an AccessRole.
 * `provision:tenant` mints exactly one (`tenant-admin`, at creation time) and
 * `grant:permissions` only widens a role that already exists, so a rebuilt
 * database had ONE role and `create:account --role viewer` failed outright:
 *
 *     No access role 'viewer' in tenant 'test'.
 *     Available: tenant-admin
 *
 * The practical cost was that permission-gated regression checks — the Stage 6b
 * solver-control gate, the 6c viewer check — could not run at all, and the two
 * under-privileged accounts they depend on existed only as raw-SQL artifacts.
 *
 * This is the operator tool, not the tenant-facing role editor. Letting a tenant
 * admin compose their own AccessRoles through the UI is Step 14.
 *
 * WHY A CLI, NOT AN ENDPOINT
 * --------------------------
 * Same reasoning as provision:tenant, reset:password, grant:permissions and
 * create:account: an endpoint that mints roles bundling arbitrary permissions is
 * a privilege-escalation endpoint reachable from the internet. Keeping it in a
 * CLI means the running application cannot invent authority, however it is
 * tricked.
 *
 * WHY THE OWNER CONNECTION — AND WHY THE WRITES STILL GO THROUGH RLS
 * ------------------------------------------------------------------
 * Unlike every other operator script here, this one does NOT need ownership to
 * write. Verified against the live database rather than assumed: `access_role`,
 * `access_role_permission` and `person_access_role` are ordinary tenant-scoped
 * tables carrying `tenant_isolation` with both USING and WITH CHECK, so the app
 * role inserts into them happily once `calendry.tenant_id` is set, and is
 * refused outright without it or with a foreign `tenant_id` in the payload.
 *
 * What it cannot do is resolve `--tenant <slug>` to an id. `tenant`'s policy is
 * `id = current_tenant_id() OR federation_id = current_federation_id()`, so
 * finding a tenant by slug requires already knowing which tenant you are. A
 * SECURITY DEFINER slug lookup would fix that and is deliberately NOT added —
 * CLAUDE.md permits exactly four RLS-bypassing paths and "an operator CLI would
 * like a nicer argument" is not the comparably strong reason a fifth needs.
 *
 * So: the OWNER connection resolves the slug, and the transaction then drops to
 * `SET LOCAL ROLE calendry_app` with tenant context set before writing anything.
 * That narrows the write PATH, not the credential — an operator still needs the
 * owner URL to run this. What it actually buys is that a mismatched pair cannot
 * be written: `access_role.tenant_id` and `access_role_permission.tenant_id`
 * must both equal the context, so a bug that resolved the wrong tenant is
 * refused by the database instead of silently landing a role in it.
 *
 *   bun run create:role -- --tenant test --key viewer --name "Schedule Viewer" \
 *       --permissions session.read,group.read,room.read
 *   bun run create:role -- --tenant test --key viewer --permissions session.read --dry-run
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

async function main() {
    const tenantSlug = arg('tenant');
    const roleKey = arg('key');
    const description = arg('description');
    const permissionsArg = arg('permissions');
    const dryRun = process.argv.includes('--dry-run');
    const skipConfirm = process.argv.includes('--yes');

    if (!tenantSlug || !roleKey || !permissionsArg) {
        console.error(
            '\nUsage: bun run create:role -- --tenant <slug> --key <roleKey> \\\n'
            + '           --permissions <a.read,b.read,…> [--name "Display Name"] \\\n'
            + '           [--description "…"] [--dry-run] [--yes]\n\n'
            + 'There is deliberately no --all: provision:tenant already mints a\n'
            + 'full-catalogue tenant-admin, and a role granted "everything" once\n'
            + 'silently stops being everything the next time a permission is added.\n'
            + 'Compose it from two audited steps instead — create:role, then\n'
            + '`grant:permissions --role <key> --all-missing`.\n',
        );
        process.exit(1);
    }

    // Defaulted rather than required, but echoed in the plan below so a
    // defaulted display name is visible BEFORE the write rather than a surprise
    // discovered in the UI afterwards.
    const roleName = arg('name') ?? roleKey;

    const requested = [...new Set(permissionsArg.split(',').map((k) => k.trim()).filter(Boolean))].sort();

    if (requested.length === 0) {
        console.error('\n--permissions was empty. A role holding nothing is a role that does nothing.\n');
        process.exit(1);
    }

    // Validation pass 1: the CODE catalogue. A typo'd key would otherwise fail
    // on the foreign key with an opaque message — or, if it happened to be a
    // prefix of a real one, grant something subtly different and report success.
    const unknown = requested.filter((key) => !PERMISSION_KEYS.includes(key));

    if (unknown.length) {
        console.error(`\nNot in the permission catalogue: ${unknown.join(', ')}`);
        console.error('The catalogue is server/utils/permissions.ts. Permissions are code, not data.\n');
        process.exit(1);
    }

    const connectionString = resolveOwnerDatabaseUrl();
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

    try {
        const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });

        if (!tenant) {
            console.error(`\nNo tenant with slug '${tenantSlug}'.\n`);
            process.exit(1);
        }

        // Validation pass 2: the SEEDED catalogue. Distinct from pass 1 — the
        // code can be ahead of the database, and `db seed` is the step that
        // closes the gap. Naming it beats an FK violation on permission_key.
        const seeded = new Set((await prisma.permission.findMany({ select: { key: true } })).map((p) => p.key));
        const notSeeded = requested.filter((key) => !seeded.has(key));

        if (notSeeded.length) {
            console.error(`\n${notSeeded.length} permission(s) are in the code but not in the database:`);
            console.error(`  ${notSeeded.slice(0, 8).join(', ')}${notSeeded.length > 8 ? ' …' : ''}`);
            console.error('\nRun `bun run db-seed` first — the catalogue is seeded, not migrated.\n');
            process.exit(1);
        }

        const siblings = await prisma.accessRole.findMany({
            where: { tenantId: tenant.id },
            select: { key: true, name: true, _count: { select: { permissions: true } } },
        });

        // Fails loudly rather than upserting. A second row that looks like the
        // first is worse than an error: `type` on a Constraint is createOnly, and
        // the mislabelled duplicate that produced taught this the hard way — it
        // could never be corrected by editing, only deleted and recreated.
        const clash = siblings.find((role) => role.key === roleKey);

        if (clash) {
            console.error(`\nAccessRole '${roleKey}' already exists in tenant '${tenantSlug}'`
                + ` — ${clash._count.permissions} permission(s).`);
            console.error('This script creates; it does not update.');
            console.error(`To widen it: bun run grant:permissions -- --tenant ${tenantSlug} --role ${roleKey} --permissions …\n`);
            process.exit(1);
        }

        // `name` is not unique in the schema, so this cannot be an error — but
        // silence is exactly how a rule labelled "Cap online share per group"
        // ended up being a minimize_exam_week_sessions row.
        const nameClash = siblings.find((role) => role.name === roleName);

        console.log(`\nTenant      ${tenant.slug} (${tenant.name})`);
        console.log(`Key         ${roleKey}`);
        console.log(`Name        ${roleName}${arg('name') ? '' : '  (defaulted from --key)'}`);

        if (description) {
            console.log(`Description ${description}`);
        }

        console.log(`Permissions ${requested.length}: ${requested.join(', ')}`);
        console.log('System      no — provision:tenant owns is_system, and this role stays deletable');

        if (nameClash) {
            console.log(`\n  WARNING: '${nameClash.key}' in this tenant already displays as "${roleName}".`);
            console.log('  Not blocked (name is not unique), but two roles reading identically in a');
            console.log('  picker is how the wrong one gets assigned.');
        }

        if (dryRun) {
            console.log('\n--dry-run: nothing was written.\n');

            return;
        }

        if (!skipConfirm) {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            const answer = await rl.question(`\nCreate this role? Type the tenant slug to confirm (${tenantSlug}): `);

            rl.close();

            if (answer.trim() !== tenantSlug) {
                console.error('\nDoes not match. Nothing was created.\n');
                process.exit(1);
            }
        }

        // One transaction, and the writes run as the APP role under the tenant's
        // own RLS context — see the header. A role with no permissions, or
        // permission rows pointing at a tenant the role does not belong to, are
        // both refused by the database rather than left to be discovered later.
        const created = await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe('SET LOCAL ROLE calendry_app');
            await tx.$executeRaw`SELECT set_config('calendry.tenant_id', ${tenant.id}, true)`;

            const role = await tx.accessRole.create({
                data: {
                    tenantId: tenant.id,
                    key: roleKey,
                    name: roleName,
                    description: description ?? null,
                    isSystem: false,
                },
            });

            await tx.accessRolePermission.createMany({
                data: requested.map((permissionKey) => ({
                    accessRoleId: role.id,
                    permissionKey,
                    tenantId: tenant.id,
                })),
            });

            return role;
        });

        const record = {
            ts: new Date().toISOString(),
            action: 'access_role.created',
            tenant: tenant.slug,
            roleKey,
            roleName,
            accessRoleId: created.id,
            permissions: requested,
            permissionCount: requested.length,
            operator: `${userInfo().username}@${hostname()}`,
            via: 'cli:create-role',
        };

        console.log(`\nCreated. access_role=${created.id}`);
        console.log(`Assign it with: bun run create:account -- --tenant ${tenantSlug} --role ${roleKey} …`);
        console.log('Existing people are unaffected — this creates a role, it does not assign one.\n');

        // Structured line for an external log sink, deliberately not a database
        // table: the operator running this can rewrite any table here, so a local
        // audit row is not tamper-evident against the one actor it audits.
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
            console.error(`\nCreation failed, nothing was written: ${message}\n`);
        }

        process.exit(1);
    } finally {
        await prisma.$disconnect();
    }
}

await main();
