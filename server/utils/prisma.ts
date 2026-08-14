import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Prisma singleton, connected as the RUNTIME role (DATABASE_URL).
 *
 * This role owns nothing and is subject to FORCE ROW LEVEL SECURITY, so every
 * query it runs is filtered by the policies from the Step 3 migration. It is
 * deliberately NOT the role migrations run as — see prisma.config.js.
 *
 * Route handlers must never import this directly. Go through `withTenant()`,
 * which is the only place that establishes RLS context. A query issued outside
 * a tenant transaction sees zero rows, which is the intended failure mode.
 */
let client: PrismaClient | undefined;

export function getPrisma(): PrismaClient {
    if (!client) {
        const connectionString = process.env.DATABASE_URL;

        if (!connectionString) {
            throw new Error('DATABASE_URL is not set — refusing to start without a runtime database role.');
        }

        client = new PrismaClient({
            adapter: new PrismaPg({ connectionString }),
        });
    }

    return client;
}
