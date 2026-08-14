/**
 * Database seeding entry point.
 *
 * MIGRATIONS ARE SCHEMA-ONLY; DATA POPULATION IS SEED-ONLY. Migrations create
 * the `permission` table; this fills it. Keeping the two apart means DDL
 * history stays a record of structure, and reference data can be corrected
 * without inventing a migration whose only job is an UPDATE.
 *
 * TWO TIERS
 *
 *   reference — required in EVERY environment, production included. Nothing
 *               here is sample content; the system is incorrect without it.
 *               Runs unconditionally.
 *
 *   fixture   — dev/test sample data. Runs only with an explicit --fixtures
 *               flag AND a non-production NODE_ENV. There are no fixtures yet;
 *               the tier exists so that adding one later cannot accidentally
 *               become part of the always-on path.
 *
 * Invoked by `prisma db seed`, and automatically by `prisma migrate reset`.
 * NOT run by `prisma migrate deploy` — production must call it explicitly, and
 * both container entrypoints do.
 *
 * Flags:
 *   --prune      delete catalogue rows no longer defined in code (see below)
 *   --fixtures   additionally run the fixture tier (non-production only)
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { describeTarget, resolveOwnerDatabaseUrl } from '../scripts/lib/ownerDatabaseUrl';
import { seedPermissions } from './seeds/reference/permissions';

const args = process.argv.slice(2);
const prune = args.includes('--prune');
const withFixtures = args.includes('--fixtures');

async function main() {
    // Two independent conditions, because either alone is too easy to satisfy
    // by accident: a stray flag in a deploy script, or an unset NODE_ENV.
    if (withFixtures && process.env.NODE_ENV === 'production') {
        console.error('\nRefusing to seed fixtures with NODE_ENV=production.\n');
        process.exit(1);
    }

    const connectionString = resolveOwnerDatabaseUrl();
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

    console.log(`Seeding ${describeTarget(connectionString)} (reference tier)...`);

    try {
        const result = await seedPermissions(prisma, { prune });

        console.log(
            `  permissions: ${result.created} created, ${result.updated} updated`,
        );

        if (result.stale.length > 0) {
            if (result.pruned > 0) {
                console.log(
                    `  pruned ${result.pruned} stale permission(s), removing `
                    + `${result.prunedGrants} access-role grant(s): ${result.stale.join(', ')}`,
                );
            } else {
                // Reported, not deleted. Removing a permission cascades into
                // tenant access roles, so it is never done implicitly.
                console.warn(
                    `\n  ${result.stale.length} permission(s) exist in the database but not in code:\n`
                    + `    ${result.stale.join(', ')}\n`
                    + '  They remain assignable. Re-run with --prune to delete them\n'
                    + '  (which will also revoke them from any access role holding them).\n',
                );
            }
        }

        if (withFixtures) {
            // Intentionally empty. The tier and its guard exist; the data does
            // not. Register fixture seeders here when they are written.
            console.log('  fixtures: none registered');
        }

        console.log('Seed complete.');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (/Unable to start a transaction|Can't reach database server|ECONNREFUSED|ENOTFOUND/i.test(message)) {
            console.error(
                `\nCould not reach the database at ${describeTarget(connectionString)}.\n`
                + '  - Running?  docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db\n'
                + '  - Reachable from here? See MIGRATION_DATABASE_URL_HOST in .env.example.\n',
            );
        } else {
            console.error(`\nSeeding failed: ${message}\n`);
        }

        process.exit(1);
    } finally {
        await prisma.$disconnect();
    }
}

await main();
