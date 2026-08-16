/**
 * Stage 4 verification — that the claim mechanism cannot double-poll a run.
 *
 * A genuine multi-instance test is not feasible here (one container), so this
 * drives the REAL `claimDueRuns()` from several concurrent callers against the
 * real database. That exercises exactly what matters — the advisory lock, the
 * `FOR UPDATE SKIP LOCKED` claim and the `next_poll_at` lease — because the
 * mechanism lives in Postgres, not in the process. Two app instances would hit
 * the same rows the same way.
 *
 * Throwaway, like the other Stage 3/4 check scripts.
 *
 *   bun run scripts/solver-claim-check.ts
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { resolveOwnerDatabaseUrl } from './lib/ownerDatabaseUrl';
import { claimDueRuns } from '../server/utils/solverPollClaim';

const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: resolveOwnerDatabaseUrl() }) });

const line = (t = '') => console.log(t);
const rule = (t: string) => line(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`);

const CONCURRENCY = 4;
const RUN_COUNT = 6;
const MARKER = 'claim-check';

try {
    const tenant = await owner.tenant.findFirstOrThrow({ where: { slug: 'test' } });
    const term = await owner.term.findFirstOrThrow({ where: { tenantId: tenant.id } });

    // Clear any leftovers, then plant runs that are already due.
    await owner.solverRun.deleteMany({ where: { meta: { path: ['marker'], equals: MARKER } } });

    /**
     * Each planted run needs its OWN term: `solver_run_one_active_per_term` is a
     * partial unique index over (tenant_id, term_id) for active statuses, so six
     * RUNNING rows on one term is exactly what Stage 2 made impossible. (The
     * first draft of this script tried, and got the 23505 — the guarantee
     * demonstrating itself.)
     *
     * They carry no externalRunId, so an actual poll would be a no-op. The
     * subject under test is the CLAIM, not the polling.
     */
    const plantedTerms: string[] = [];
    const planted: string[] = [];

    for (let i = 0; i < RUN_COUNT; i++) {
        const tempTerm = await owner.term.create({
            data: {
                tenantId: tenant.id,
                name: `${MARKER}-term-${i}-${Date.now()}`,
                startDate: term.startDate,
                endDate: term.endDate,
            },
        });

        plantedTerms.push(tempTerm.id);

        const run = await owner.$queryRaw<{ id: string }[]>`
            INSERT INTO solver_run (id, tenant_id, term_id, status, next_poll_at, meta, scope, created_at)
            VALUES (gen_random_uuid()::text, ${tenant.id}, ${tempTerm.id}, 'RUNNING',
                    now() - interval '1 minute', ${JSON.stringify({ marker: MARKER })}::jsonb, '{}'::jsonb, now())
            RETURNING id
        `;

        planted.push(run[0]!.id);
    }

    rule(`PLANTED ${RUN_COUNT} runs, all already due`);
    line(`  tenant ${tenant.slug}`);

    // -- 1. Concurrent claims -------------------------------------------------
    rule(`${CONCURRENCY} CONCURRENT claimDueRuns() calls for the same tenant`);

    const results = await Promise.all(
        Array.from({ length: CONCURRENCY }, () => claimDueRuns(tenant.id)),
    );

    results.forEach((claimed, index) => {
        line(`  caller ${index}: claimed ${claimed.length}`
            + (claimed.length ? ` → ${claimed.map((r) => r.id.slice(0, 8)).join(', ')}` : ''));
    });

    const all = results.flat().map((r) => r.id);
    const duplicates = all.filter((id, i) => all.indexOf(id) !== i);
    const nonEmpty = results.filter((r) => r.length > 0).length;

    line('');
    line(`  total claims issued        ${all.length}`);
    line(`  DUPLICATE claims           ${duplicates.length}  ${duplicates.length === 0 ? '✓' : '✗ ' + duplicates.join(', ')}`);
    line(`  callers that got work      ${nonEmpty} of ${CONCURRENCY}`);
    line('    (the advisory lock serialises same-tenant claiming, so the others');
    line('     correctly get nothing rather than racing for the same rows)');

    // -- 2. The lease ---------------------------------------------------------
    rule('IMMEDIATE re-claim — the lease must hide the rows just taken');

    const second = await claimDueRuns(tenant.id);

    line(`  claimed on retry: ${second.length}  ${second.length === 0 ? '✓ (all leased)' : '✗'}`);

    const leases = await owner.solverRun.findMany({
        where: { id: { in: planted } },
        select: { id: true, nextPollAt: true },
    });
    const future = leases.filter((r) => r.nextPollAt && r.nextPollAt.getTime() > Date.now());

    line(`  runs whose next_poll_at moved into the future: ${future.length} of ${planted.length}`
        + `  ${future.length === planted.length ? '✓' : '✗'}`);

    // -- 3. After the lease expires ------------------------------------------
    rule('AFTER the lease is manually expired, the work becomes claimable again');

    await owner.solverRun.updateMany({
        where: { id: { in: planted } },
        data: { nextPollAt: new Date(Date.now() - 1000) },
    });

    const third = await claimDueRuns(tenant.id);

    line(`  claimed: ${third.length} of ${planted.length}  ${third.length === planted.length ? '✓' : '✗'}`);
    line('    (nothing is lost if an instance dies mid-poll — the lease simply expires)');

    // -- verdict --------------------------------------------------------------
    const ok = duplicates.length === 0
        && all.length === RUN_COUNT
        && second.length === 0
        && future.length === planted.length
        && third.length === planted.length;

    rule(ok ? 'CLAIM MECHANISM: CORRECT ✓' : 'CLAIM MECHANISM: FAILED ✗');

    await owner.solverRun.deleteMany({ where: { id: { in: planted } } });
    await owner.term.deleteMany({ where: { id: { in: plantedTerms } } });
    line('  planted runs and temporary terms removed\n');

    process.exitCode = ok ? 0 : 1;
} finally {
    await owner.$disconnect();
}
