import { claimDueRuns, inTenant, tenantsWithDueRuns } from '../utils/solverPollClaim';
import { pollSolverRun } from '../utils/solverPolling';

/**
 * Stage 4 — the background solver poller.
 *
 * WHY THIS EXISTS AND ON-DEMAND POLLING IS NOT ENOUGH
 *
 * The solver keeps runs in an in-memory registry with no persistence and no
 * eviction. If nobody opens a run's page, the run finishes, the app never
 * learns, and the result is never captured — and if the solver then restarts,
 * the answer is gone for good while the row still says RUNNING. The
 * one-active-run-per-term index would leave that term blocked indefinitely.
 *
 * So correctness lives here, and `GET /api/solver/runs/:id` exists only to give
 * someone who IS watching a faster answer. Both call the same `pollSolverRun`,
 * so they cannot disagree about what a status means.
 *
 * WHERE IT RUNS
 *
 * In-process, rather than an external cron hitting an endpoint: a cron needs
 * authentication, deployment coordination, and is one more thing to forget to
 * set up. The trade is that every app instance would poll, which the claim in
 * `solverPollClaim.ts` handles.
 */

/** Between sweeps. Individual runs have their own cadence via `next_poll_at`. */
const TICK_MS = 500;

/** After a sweep throws — usually the database being briefly unavailable. */
const ERROR_BACKOFF_MS = 5_000;

function isEnabled(): boolean {
    // Explicit opt-out rather than opt-in: a poller that is off by default is a
    // poller someone forgets to turn on, and the symptom is runs that silently
    // never finish. `tests/run-integration.sh` sets this to `off` so the suites
    // are not racing a background job against their own fixtures.
    return process.env.CALENDRY_SOLVER_POLL !== 'off';
}

export default defineNitroPlugin(() => {
    if (!isEnabled()) {
        console.log('[solver-poller] disabled (CALENDRY_SOLVER_POLL=off)');

        return;
    }

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function sweep(): Promise<void> {
        const tenantIds = await tenantsWithDueRuns();

        for (const tenantId of tenantIds) {
            const claimed = await claimDueRuns(tenantId);

            for (const run of claimed) {
                /**
                 * One failing run must never stop the sweep. A solver that is
                 * unreachable for one run is unreachable for all of them, but a
                 * malformed row or an unexpected error is local to itself.
                 */
                try {
                    // The gRPC call happens HERE, outside the claim transaction
                    // — the advisory lock was released at its commit.
                    const outcome = await inTenant(tenantId, (tx) => pollSolverRun(tx, run));

                    if (outcome.becameTerminal) {
                        console.log(`[solver-poller] run ${run.id} → ${outcome.status}`
                            + (outcome.detail ? ` (${outcome.detail})` : ''));

                        if (outcome.generationId) {
                            console.log(`[solver-poller] run ${run.id} → generation ${outcome.generationId} (READY)`);
                        }
                    }
                } catch (error) {
                    console.error(`[solver-poller] run ${run.id} failed to poll:`, error);
                }
            }
        }
    }

    async function tick(): Promise<void> {
        if (stopped) {
            return;
        }

        let delay = TICK_MS;

        try {
            await sweep();
        } catch (error) {
            // Reaching here means the sweep itself broke — most likely the
            // database. Backing off rather than hammering it every 500ms.
            console.error('[solver-poller] sweep failed:', error);
            delay = ERROR_BACKOFF_MS;
        }

        if (!stopped) {
            // setTimeout chained rather than setInterval: a slow sweep must not
            // overlap the next one, which would double-poll the same claims.
            timer = setTimeout(() => void tick(), delay);
        }
    }

    console.log(`[solver-poller] started (tick ${TICK_MS}ms)`);
    timer = setTimeout(() => void tick(), TICK_MS);

    return () => {
        stopped = true;
        clearTimeout(timer);
    };
});
