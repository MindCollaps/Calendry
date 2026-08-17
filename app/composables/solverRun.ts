import type { Ref } from 'vue';

/**
 * The solver run in flight, for one Term.
 *
 * OWNERSHIP BOUNDARY: everything about *a run happening right now* — its status,
 * its live numbers, whether it is improving, and the two actions that change it.
 * It does not own the Generation the run produces; the moment a run goes
 * terminal this hands off to the review route and stops caring.
 *
 * WHY THE OBJECTIVE SERIES LIVES HERE AND NOT IN THE DATABASE
 *
 * `solver_run` deliberately stores only the latest snapshot — its schema says
 * "Overwritten per poll, not appended — the run's history is not something
 * anything needs." That stays true. A trend is only meaningful while somebody is
 * watching, which is exactly when a client-side series exists; persisting a
 * sample per poll per run would add write volume to serve a sparkline nobody is
 * looking at. The cost is that reloading the page restarts the series, which is
 * a fair trade and stated rather than hidden.
 *
 * POLLING IS THE LATENCY PATH, NOT THE CORRECTNESS PATH. The background poller
 * (Stage 4) is what guarantees a run reaches a terminal state and its result is
 * captured. Nothing here is load-bearing for that, which is why it can back off
 * and pause freely.
 *
 * NOTE the Nuxt trap this must not fall into: no top-level `await`. An `await`
 * before a `useState`/`useRequestFetch` call detaches everything after it from
 * the Nuxt instance and fails at runtime.
 */

export type RunStatus = 'PENDING' | 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

export interface SolverRunRow {
    id: string;
    termId: string;
    status: RunStatus;
    progress: number;
    bestObjective: number | null;
    movesEvaluated: string | null;
    elapsedMillis: number | null;
    terminationReason: string | null;
    errorDetail: string | null;
    /** Set when a SUCCEEDED run's result could not be recovered. */
    resultLostAt?: string | null;
    generationId: string | null;
    maxMoves: string | null;
    maxWallMillis: number | null;
    createdAt: string;
}

/** The six states the control renders. Derived, never stored. */
export type ControlState =
    | 'idle'
    | 'starting'
    | 'running'
    | 'cancelling'
    | 'finished'
    | 'failed';

const ACTIVE: RunStatus[] = ['PENDING', 'QUEUED', 'RUNNING'];

/** How long a flat objective counts as "still working" before it reads as stalled. */
const STALL_AFTER_MS = 12_000;

/**
 * Fast while the interesting part happens, slower once it is clearly a long run.
 *
 * Mirrors the server's adaptive cadence in spirit without duplicating its table:
 * this one only decides how often a watching human's numbers refresh.
 */
export function clientPollMs(ageMs: number): number {
    return ageMs < 10_000 ? 1_000 : 2_500;
}

/**
 * The six states, derived from the run and the two in-flight flags.
 *
 * Pure and exported so the machine can be tested without a browser: every
 * transition below is a rule someone will otherwise have to rediscover by
 * clicking, and two of them (`cancelling`, and SUCCEEDED-without-a-Generation)
 * are exactly the ones that are hard to reproduce by hand.
 */
export function deriveState(input: {
    starting: boolean;
    cancelling: boolean;
    run: Pick<SolverRunRow, 'status' | 'generationId'> | null;
}): ControlState {
    if (input.starting) {
        return 'starting';
    }

    if (input.cancelling) {
        return 'cancelling';
    }

    if (!input.run) {
        return 'idle';
    }

    if (ACTIVE.includes(input.run.status)) {
        return 'running';
    }

    // A SUCCEEDED run always produces a Generation (Stage 5), so its absence
    // means the capture failed — a failure to report, not a proposal to review.
    if (input.run.status === 'SUCCEEDED' && input.run.generationId) {
        return 'finished';
    }

    return 'failed';
}

/**
 * Whether the objective is still improving, and for how long it has not been.
 *
 * The one number on screen that says whether waiting longer buys anything: a
 * flat objective is precisely when to cancel. Derived explicitly rather than
 * left for a human to infer from a twitching counter.
 */
export function deriveTrend(
    series: { at: number; objective: number }[],
    stallAfterMs = STALL_AFTER_MS,
): { improving: boolean; flatForMs: number } | null {
    if (series.length < 2) {
        return null;
    }

    const latest = series[series.length - 1]!;
    let lastChangeAt = series[0]!.at;

    for (let i = 1; i < series.length; i++) {
        if (series[i]!.objective !== series[i - 1]!.objective) {
            lastChangeAt = series[i]!.at;
        }
    }

    const flatForMs = latest.at - lastChangeAt;

    return { improving: flatForMs < stallAfterMs, flatForMs };
}

export interface StartOptions {
    maxMoves?: number;
    maxWallMillis?: number;
}

export function useSolverRun(termId: Ref<string>) {
    const run = ref<SolverRunRow | null>(null);
    const starting = ref(false);
    const cancelling = ref(false);
    const error = ref<string | null>(null);
    /** Set when a POST loses the one-active-run race and we adopt the winner. */
    const adopted = ref(false);

    /** (timestamp, objective) samples for this run only. Reset when the run changes. */
    const series = ref<{ at: number; objective: number }[]>([]);
    const watchedRunId = ref<string | null>(null);

    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const isActive = computed(() => Boolean(run.value && ACTIVE.includes(run.value.status)));

    const state = computed<ControlState>(() => deriveState({
        starting: starting.value,
        cancelling: cancelling.value,
        run: run.value,
    }));

    const trend = computed(() => deriveTrend(series.value));

    function record(row: SolverRunRow) {
        // A different run means a different series; carrying samples across would
        // invent a trend out of two unrelated searches.
        if (watchedRunId.value !== row.id) {
            watchedRunId.value = row.id;
            series.value = [];
        }

        // `typeof`, not `!== null`: the active-run rows from the list endpoint
        // are a partial select and carry no objective at all, and `undefined`
        // would otherwise be recorded as a sample and poison the trend.
        if (typeof row.bestObjective === 'number') {
            series.value = [...series.value.slice(-119), { at: Date.now(), objective: row.bestObjective }];
        }
    }

    function schedule(delay: number) {
        clearTimeout(timer);

        if (stopped) {
            return;
        }

        timer = setTimeout(() => void poll(), delay);
    }

    async function poll() {
        const current = run.value;

        if (!current || !ACTIVE.includes(current.status)) {
            return;
        }

        // Nothing on screen to update, so nothing worth asking for. The
        // background poller keeps the run correct meanwhile.
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
            schedule(2_000);

            return;
        }

        try {
            const fresh = await $fetch<{ run: SolverRunRow }>(`/api/solver/runs/${current.id}`);

            run.value = fresh.run;
            record(fresh.run);

            if (ACTIVE.includes(fresh.run.status)) {
                schedule(clientPollMs(Date.now() - new Date(fresh.run.createdAt).getTime()));
            } else {
                cancelling.value = false;
            }
        } catch {
            // A failed poll is not a failed run — Stage 4's rule. Keep the last
            // known state and try again rather than inventing a failure.
            schedule(3_000);
        }
    }

    /**
     * Pick up whatever is already running for this term, started by anyone.
     *
     * Solving is a TENANT activity, not a per-user one: a run someone else
     * launched changes the schedule this browser is looking at, so it belongs in
     * this toolbar even though this browser did not start it.
     */
    async function adopt() {
        clearTimeout(timer);
        run.value = null;
        series.value = [];
        watchedRunId.value = null;
        error.value = null;
        adopted.value = false;

        if (!termId.value) {
            return;
        }

        try {
            const list = await $fetch<{ runs: SolverRunRow[]; active: SolverRunRow[] }>(
                `/api/solver/runs?termId=${encodeURIComponent(termId.value)}&limit=1`,
            );

            /**
             * `active` is an ARRAY, and an empty one is truthy — reading it as a
             * single row made adoption silently never fire, which looks exactly
             * like "there is no run in progress". Take its first element, and
             * only ever adopt from `active`: `runs[0]` is merely the newest run,
             * which is usually a finished one.
             */
            const found = list.active?.[0] ?? null;

            if (found && ACTIVE.includes(found.status)) {
                run.value = found;
                record(found);
                adopted.value = true;
                schedule(500);
            }
        } catch {
            // No permission, or the list is unavailable. Either way the control
            // simply shows nothing rather than an error nobody can act on.
        }
    }

    async function start(options: StartOptions = {}) {
        starting.value = true;
        error.value = null;
        adopted.value = false;

        try {
            const created = await $fetch<{ run: SolverRunRow }>('/api/solver/runs', {
                method: 'POST',
                body: { termId: termId.value, ...options },
            });

            run.value = created.run;
            record(created.run);
            schedule(500);
        } catch (e) {
            const status = (e as { statusCode?: number }).statusCode;

            /**
             * 409 means the one-active-run index rejected this because a run
             * started between the click and the request. That is not an error
             * state — the thing the user wanted is already happening — so adopt
             * the winner and say so.
             */
            if (status === 409) {
                await adopt();
                adopted.value = true;
            } else {
                error.value = (e as { statusMessage?: string }).statusMessage ?? 'Could not start a run.';
            }
        } finally {
            starting.value = false;
        }
    }

    async function cancel() {
        if (!run.value) {
            return;
        }

        // Cancellation is acknowledged by the solver but only OBSERVED by a
        // poll, so there is a real gap where the run is still RUNNING. Without
        // this state the button looks broken and gets pressed again.
        cancelling.value = true;

        try {
            await $fetch(`/api/solver/runs/${run.value.id}/cancel`, { method: 'POST' });
            schedule(500);
        } catch (e) {
            cancelling.value = false;
            error.value = (e as { statusMessage?: string }).statusMessage ?? 'Could not cancel the run.';
        }
    }

    /** Back to idle after a terminal run, so the control offers a fresh start. */
    function dismiss() {
        run.value = null;
        series.value = [];
        watchedRunId.value = null;
        error.value = null;
        adopted.value = false;
    }

    /**
     * Client-only, deliberately. An `immediate: true` watcher would run during
     * SSR, where a bare `$fetch` carries no cookie and 401s — and the catch in
     * `adopt()` would render "no run in progress", which is indistinguishable
     * from the truth. Live run state is not first-render state: idle is the
     * correct thing to show until the browser has actually asked.
     */
    onMounted(() => void adopt());
    watch(termId, () => void adopt());

    onBeforeUnmount(() => {
        stopped = true;
        clearTimeout(timer);
    });

    return {
        run, state, trend, error, adopted, isActive,
        start, cancel, dismiss,
    };
}
