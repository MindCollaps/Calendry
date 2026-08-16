/**
 * Adds a Person + Account to an EXISTING tenant, with an access role.
 *
 * WHY THIS EXISTS
 * ---------------
 * `provision:tenant` creates a tenant and its first admin. There was nothing to
 * add a *second* account to a tenant that already exists, so it kept being done
 * by hand-written SQL — which is exactly how `vic@demo.local` came to be a
 * tracked cleanup item in CLAUDE.md, and why verification work kept borrowing
 * (and resetting) the real admin's credential.
 *
 * WHY A CLI, NOT AN ENDPOINT
 * --------------------------
 * Same reasoning as provision:tenant, reset:password and grant:permissions: an
 * endpoint that mints accounts and grants access roles is an
 * account-creation-and-privilege-granting endpoint reachable from the internet.
 * Keeping it in a CLI means the running application cannot create accounts, no
 * matter what it is tricked into doing.
 *
 * WHY THE OWNER CONNECTION
 * ------------------------
 * `person` and `person_access_role` are tenant-scoped under RLS, and this runs
 * outside any request so there is no tenant context to set. `account` and
 * `account_person` are the pre-tenant plane with no RLS at all. The owner
 * bypasses both concerns in one transaction.
 *
 * AN EXISTING ACCOUNT IS REUSED, NOT DUPLICATED. `account.email` is globally
 * unique and one Account can act in several tenants through `account_person` —
 * that is the whole point of a tenant-independent credential. Passing an email
 * that already exists therefore ADDS a tenant to that person rather than
 * creating a second login, and the password is left untouched.
 *
 *   bun run create:account -- --tenant test --email verify@calendry.local \
 *       --name "Verify Bot" --role tenant-admin
 */
import { createInterface } from 'node:readline/promises';
import { hostname, userInfo } from 'node:os';
import { randomBytes } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
// The real hashing path, never a re-implementation — a second copy of the KDF
// drifts silently the moment the original changes.
import { hashPassword } from '../server/utils/auth';
import { describeTarget, resolveOwnerDatabaseUrl } from './lib/ownerDatabaseUrl';

function arg(name: string): string | undefined {
    const index = process.argv.indexOf(`--${name}`);

    return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
    const tenantSlug = arg('tenant');
    const email = arg('email')?.toLowerCase();
    const name = arg('name');
    const roleKey = arg('role') ?? 'tenant-admin';
    const suppliedPassword = arg('password');
    const skipConfirm = process.argv.includes('--yes');

    if (!tenantSlug || !email || !name) {
        console.error('\nUsage: bun run create:account -- --tenant <slug> --email <email> --name "Given Family" [--role <accessRoleKey>] [--password <pw>] [--yes]\n');
        process.exit(1);
    }

    const [givenName, ...rest] = name.trim().split(/\s+/);
    const familyName = rest.join(' ') || givenName;

    const connectionString = resolveOwnerDatabaseUrl();
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

    try {
        const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });

        if (!tenant) {
            console.error(`\nNo tenant with slug '${tenantSlug}'.\n`);
            process.exit(1);
        }

        const accessRole = await prisma.accessRole.findFirst({
            where: { tenantId: tenant.id, key: roleKey },
            include: { _count: { select: { permissions: true } } },
        });

        // Named explicitly rather than created: inventing an access role here
        // would mean this script decides what a role may do, which is tenant
        // configuration (and Step 14's job).
        if (!accessRole) {
            const available = await prisma.accessRole.findMany({
                where: { tenantId: tenant.id },
                select: { key: true },
            });

            console.error(`\nNo access role '${roleKey}' in tenant '${tenantSlug}'.`);
            console.error(`Available: ${available.map((r) => r.key).join(', ') || '(none)'}\n`);
            process.exit(1);
        }

        const existingAccount = await prisma.account.findUnique({ where: { email } });
        const existingPerson = await prisma.person.findFirst({
            where: { tenantId: tenant.id, email },
        });

        if (existingPerson) {
            console.error(`\nA Person with email '${email}' already exists in tenant '${tenantSlug}'.`);
            console.error('This script creates; it does not update. Use reset:password or grant:permissions.\n');
            process.exit(1);
        }

        const password = suppliedPassword ?? randomBytes(12).toString('base64url');

        console.log(`\nTenant      ${tenant.slug} (${tenant.name})`);
        console.log(`Person      ${givenName} ${familyName} <${email}>`);
        console.log(`Access role ${accessRole.key} — ${accessRole._count.permissions} permission(s)`);
        console.log(`Account     ${existingAccount
            ? 'EXISTS — this tenant is added to it; the password is NOT changed'
            : 'new'}`);
        console.log('');

        if (!skipConfirm) {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            const answer = await rl.question(`Create this account? Type the tenant slug to confirm (${tenantSlug}): `);

            rl.close();

            if (answer.trim() !== tenantSlug) {
                console.error('\nDoes not match. Nothing was created.\n');
                process.exit(1);
            }
        }

        const passwordHash = await hashPassword(password);

        // One transaction: a Person with no Account, or an Account with no
        // access role, is a half-created login that fails confusingly later.
        const created = await prisma.$transaction(async (tx) => {
            const person = await tx.person.create({
                data: { tenantId: tenant.id, givenName, familyName, email },
            });

            await tx.personAccessRole.create({
                data: { personId: person.id, accessRoleId: accessRole.id, tenantId: tenant.id },
            });

            const account = existingAccount
                ?? (await tx.account.create({ data: { email, passwordHash } }));

            await tx.accountPerson.create({ data: { accountId: account.id, personId: person.id } });

            return { person, account };
        });

        const record = {
            ts: new Date().toISOString(),
            action: 'account.created',
            tenant: tenant.slug,
            email,
            personId: created.person.id,
            accountId: created.account.id,
            accessRole: accessRole.key,
            reusedExistingAccount: Boolean(existingAccount),
            operator: `${userInfo().username}@${hostname()}`,
            via: 'cli:create-account',
        };

        console.log(`\nCreated. person=${created.person.id}`);

        if (!existingAccount) {
            console.log(`\n  Password: ${password}`);
            console.log('  Shown once. Store it somewhere, or reset it with `bun run reset:password`.\n');
        }

        // Structured line for an external log sink. Deliberately not a database
        // table: the operator running this can rewrite any table here, so a
        // local audit row is not tamper-evident against the one actor it audits.
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
