import type { Prisma } from '@prisma/client';
import type { H3Event } from 'h3';
import type { RequestIdentity } from './tenantResolver';
// Explicit rather than relying on Nitro's auto-import: this module is also
// loaded by scripts/ and by the background poller's verification, where the
// auto-import does not exist and the failure is a bare "getPrisma is not
// defined" from inside a function that looks unrelated.
import { getPrisma } from './prisma';

export type Tx = Prisma.TransactionClient;

/**
 * Runs `fn` inside a transaction carrying the caller's RLS context.
 *
 * Three properties matter here, and all three are load-bearing:
 *
 *  1. `SET LOCAL` semantics (the `true` third argument to set_config) make the
 *     setting transaction-scoped, so a pooled connection cannot leak one
 *     tenant's context into the next request that borrows it.
 *
 *  2. Context and queries share one connection. Prisma only guarantees that
 *     inside an interactive transaction — issuing set_config on the base client
 *     would set it on an arbitrary pooled connection and then run the query on
 *     a different one.
 *
 *  3. `set_config()` is used rather than `SET LOCAL x = y` because SET does not
 *     accept bind parameters. Interpolating a tenant id into SQL text on the one
 *     statement that defines the security boundary would be an injection sink.
 *
 * A handler that forgets to use this sees zero rows rather than every row,
 * because the policies compare against NULL.
 */
export async function withTenant<T>(
    identity: RequestIdentity,
    fn: (tx: Tx) => Promise<T>,
    options: { timeoutMs?: number } = {},
): Promise<T> {
    const prisma = getPrisma();

    return prisma.$transaction(
        async (tx) => {
            await tx.$executeRaw`SELECT set_config('calendry.tenant_id', ${identity.tenantId}, true)`;
            await tx.$executeRaw`SELECT set_config('calendry.federation_id', ${identity.federationId ?? ''}, true)`;

            return fn(tx);
        },
        {
            // Default matches Prisma's own; apply-generation raises it explicitly
            // because it is the one bulk operation in the API.
            timeout: options.timeoutMs ?? 5_000,
            maxWait: 5_000,
        },
    );
}

/**
 * Identity for the current request, or a 401. Middleware has already run, so
 * this is a lookup rather than a re-resolution.
 */
export function requireIdentity(event: H3Event): RequestIdentity {
    const identity = event.context.identity as RequestIdentity | undefined;

    if (!identity) {
        throw createError({
            statusCode: 401,
            statusMessage: 'No tenant context on this request.',
        });
    }

    return identity;
}

/** Convenience: resolve identity and open a tenant transaction in one step. */
export async function withRequestTenant<T>(
    event: H3Event,
    fn: (tx: Tx, identity: RequestIdentity) => Promise<T>,
    options: { timeoutMs?: number } = {},
): Promise<T> {
    const identity = requireIdentity(event);

    return withTenant(identity, (tx) => fn(tx, identity), options);
}
