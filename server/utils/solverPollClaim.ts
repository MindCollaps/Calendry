import { getPrisma } from './prisma';
import { withTenant } from './tenantDb';
import type { Tx } from './tenantDb';

/**
 * Claiming runs to poll, safely across however many app instances are running.
 *
 * THE MECHANISM, AND WHY IT IS NOT THE ONE ORIGINALLY PROPOSED
 *
 * Stage 4 was proposed with a session-scoped `pg_try_advisory_lock` electing a
 * single poller. Two problems killed it before it was written:
 *
 *   1. Session-scoped locks belong to a CONNECTION, and Prisma pools
 *      connections. The lock would be held by whichever backend served that
 *      one query, while later queries ran on different connections — so the
 *      "leader" would not reliably hold anything.
 *   2. Holding it across the gRPC calls would mean keeping a database
 *      transaction open across a network call to another service, which is
 *      exactly what Stage 2 refused to do for StartRun.
 *
 * What actually guarantees exclusion is the CLAIM: a short transaction that
 * pushes `next_poll_at` into the future for the rows it takes, using
 * `FOR UPDATE SKIP LOCKED`. Two instances claiming at once take disjoint sets
 * rather than one waiting for the other, and the updated `next_poll_at` acts as
 * a lease so nothing re-claims a run while its gRPC call is in flight.
 *
 * `pg_try_advisory_xact_lock` is still used, but only around the claim itself
 * and released at COMMIT — before any network call. It is cheap protection
 * against every instance stampeding the same tenant on the same tick; the claim
 * is what makes double-polling impossible.
 */

/** Arbitrary namespace so this lock cannot collide with another feature's. */
const POLL_LOCK_NAMESPACE = 0x5031;

/**
 * How long a claimed run is left alone before another instance may retry it.
 *
 * Long enough that a slow GetStatus does not cause a double poll, short enough
 * that an instance dying mid-poll does not strand the run for long. Overwritten
 * by the real cadence as soon as the poll completes.
 */
const CLAIM_LEASE_MS = 30_000;

/**
 * How many times a missing result is asked for again before it is declared lost.
 *
 * Bounded because the solver's run registry is an in-memory map with no
 * persistence (Stage 4): once it restarts, the result is genuinely gone and no
 * number of retries invents it. Five attempts over roughly six minutes covers a
 * transient fetch failure without pretending a restarted solver might answer.
 *
 * Shared with `recoverRunResult()` so the claim's predicate and the code that
 * gives up cannot disagree about the limit.
 */
export const MAX_RECOVERY_ATTEMPTS = 5;

export interface ClaimedRun {
    id: string;
    tenantId: string;
    status: 'PENDING' | 'QUEUED' | 'RUNNING' | 'SUCCEEDED';
    externalRunId: string | null;
    startedAt: Date | null;
    createdAt: Date;
    /**
     * True when this row was claimed to RE-FETCH a missing result rather than to
     * advance a live run. The two need different handling and the claim is the
     * only place that knows which predicate matched, so it says so rather than
     * leaving the poller to re-derive it.
     */
    needsResultRecovery: boolean;
    resultRecoveryAttempts: number;
}

/**
 * Tenants with at least one run due right now.
 *
 * The ONE query the poller makes without tenant context, through the narrow
 * SECURITY DEFINER function. It returns ids only — everything afterwards runs
 * inside `withTenant()` under normal RLS.
 */
export async function tenantsWithDueRuns(): Promise<string[]> {
    const rows = await getPrisma().$queryRaw<{ tenant_id: string }[]>`
        SELECT tenant_id FROM calendry_internal.tenants_with_due_solver_runs()
    `;

    return rows.map((row) => row.tenant_id);
}

/**
 * Takes up to `limit` due runs for one tenant, marking them as taken.
 *
 * Runs inside the tenant's own RLS context, so the UPDATE physically cannot
 * touch another tenant's rows even if the query were wrong.
 */
export async function claimDueRuns(tenantId: string, limit = 20): Promise<ClaimedRun[]> {
    return withTenant({
        tenantId,
        federationId: null,
        // The poller acts as no person. Nothing it does is attributed, and
        // nothing it calls requires an actor.
        actorPersonId: null,
        accountId: '',
        sessionId: '',
    }, async (tx: Tx) => {
        const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`
            SELECT pg_try_advisory_xact_lock(${POLL_LOCK_NAMESPACE}::int, hashtext(${tenantId})) AS locked
        `;

        // Another instance is already claiming for this tenant this tick. Its
        // claim will move next_poll_at, so there is nothing useful to do here.
        if (!lock?.locked) {
            return [];
        }

        /**
         * Raw SQL because Prisma cannot express `FOR UPDATE SKIP LOCKED`, and
         * that clause is the entire point: without SKIP LOCKED two instances
         * serialize on the same rows instead of taking disjoint work.
         */
        /**
         * Two shapes are claimable, and the second is deliberately narrow.
         *
         * A run still IN FLIGHT, as before; and a SUCCEEDED run whose result was
         * never captured, which nothing previously ever looked at again. Only
         * SUCCEEDED promises a result — a CANCELLED run was stopped before
         * producing one and a FAILED run never produced one, so both correctly
         * have `result IS NULL` and must not be chased. Writing this as "terminal
         * and missing a result" would pull in five rows that are working exactly
         * as designed.
         */
        return tx.$queryRaw<ClaimedRun[]>`
            UPDATE solver_run
               SET next_poll_at = now() + (${CLAIM_LEASE_MS}::int * interval '1 millisecond')
             WHERE id IN (
                 SELECT id
                   FROM solver_run
                  WHERE (
                            status IN ('PENDING', 'QUEUED', 'RUNNING')
                        AND (next_poll_at IS NULL OR next_poll_at <= now())
                        ) OR (
                            status = 'SUCCEEDED'
                        AND result IS NULL
                        AND result_lost_at IS NULL
                        AND external_run_id IS NOT NULL
                        AND result_recovery_attempts < ${MAX_RECOVERY_ATTEMPTS}
                        AND (next_poll_at IS NULL OR next_poll_at <= now())
                        )
                  ORDER BY next_poll_at NULLS FIRST
                  LIMIT ${limit}
                  FOR UPDATE SKIP LOCKED
             )
         RETURNING id,
                   tenant_id AS "tenantId",
                   status::text AS status,
                   external_run_id AS "externalRunId",
                   started_at AS "startedAt",
                   created_at AS "createdAt",
                   (status = 'SUCCEEDED' AND result IS NULL) AS "needsResultRecovery",
                   result_recovery_attempts AS "resultRecoveryAttempts"
        `;
    });
}

/** Runs `fn` in the tenant's RLS context. Used for writing a poll's outcome. */
export function inTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant({
        tenantId,
        federationId: null,
        actorPersonId: null,
        accountId: '',
        sessionId: '',
    }, fn);
}
