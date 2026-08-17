<template>
    <div class="solver">
        <!-- IDLE -->
        <template v-if="state === 'idle'">
            <CommonButton
                type="secondary"
                @click="startRun"
            >
                <Icon
                    name="material-symbols:auto-awesome-outline"
                    aria-hidden="true"
                />
                Generate schedule
            </CommonButton>

            <button
                type="button"
                class="solver_advanced-toggle"
                :aria-expanded="showAdvanced"
                @click="showAdvanced = !showAdvanced"
            >{{ showAdvanced ? 'Hide' : 'Advanced' }}</button>

            <!--
                Budget is here rather than hidden behind a default because the
                feedback loop needs it: a run that ends on `move_budget` is
                telling you it had more to do, and without this there is no way
                to act on that.
            -->
            <div
                v-if="showAdvanced"
                class="solver_advanced"
            >
                <label class="solver_field">
                    <span>Move budget</span>
                    <input
                        v-model.number="maxMoves"
                        type="number"
                        min="1"
                        max="100000000"
                        step="50000"
                    >
                </label>
                <label class="solver_field">
                    <span>Time budget (s)</span>
                    <input
                        v-model.number="maxWallSeconds"
                        type="number"
                        min="1"
                        max="600"
                    >
                </label>
                <p class="solver_hint">Whichever is reached first ends the run.</p>
            </div>
        </template>

        <!-- STARTING: nothing is known yet, so nothing is claimed. -->
        <p
            v-else-if="state === 'starting'"
            class="solver_status"
        >
            <Icon
                name="svg-spinners:ring-resize"
                aria-hidden="true"
            />
            Starting…
        </p>

        <!-- RUNNING / CANCELLING -->
        <div
            v-else-if="state === 'running' || state === 'cancelling'"
            class="solver_live"
        >
            <div class="solver_live-head">
                <span class="solver_status">
                    <Icon
                        name="svg-spinners:ring-resize"
                        aria-hidden="true"
                    />
                    {{ state === 'cancelling' ? 'Cancelling…' : 'Solving' }}
                </span>

                <CommonButton
                    v-if="state === 'running'"
                    type="secondary-black"
                    @click="confirmCancel = true"
                >Cancel</CommonButton>
            </div>

            <p
                v-if="adopted"
                class="solver_hint"
            >A run was already in progress for this term.</p>

            <!-- The headline number: whether waiting longer buys anything. -->
            <p class="solver_objective">
                <span class="solver_objective-value">{{ objectiveLabel }}</span>
                <span
                    v-if="trendLabel"
                    class="solver_trend"
                    :class="{ 'solver_trend--stalled': trend && !trend.improving }"
                >{{ trendLabel }}</span>
            </p>

            <p class="solver_counters">{{ movesLabel }} · {{ elapsedLabel }}</p>

            <!--
                Labelled "move budget", NOT "complete". `progress` is
                movesEvaluated / maxMoves — budget consumed, not closeness to an
                answer. A converged run finishes at 3%, and the wall clock can
                end it first, so a "% complete" bar would be wrong routinely.
            -->
            <div
                class="solver_budget"
                role="progressbar"
                :aria-valuenow="Math.round(budgetFraction * 100)"
                aria-valuemin="0"
                aria-valuemax="100"
                aria-label="Move budget used"
            >
                <span
                    class="solver_budget-fill"
                    :style="{ width: `${Math.min(100, budgetFraction * 100)}%` }"
                />
            </div>
            <p class="solver_hint">move budget {{ Math.round(budgetFraction * 100) }}% used — {{ budgetCaption }}</p>

            <div
                v-if="confirmCancel"
                class="solver_confirm"
            >
                <span>Cancel this run? Its work is discarded and no proposal is produced.</span>
                <CommonButton
                    type="destructive"
                    @click="doCancel"
                >Cancel run</CommonButton>
                <CommonButton
                    type="link"
                    @click="confirmCancel = false"
                >Keep solving</CommonButton>
            </div>
        </div>

        <!-- FINISHED: a handoff, not a completion notice. -->
        <div
            v-else-if="state === 'finished'"
            class="solver_done"
        >
            <p class="solver_status solver_status--done">
                <Icon
                    name="material-symbols:check-circle-outline"
                    aria-hidden="true"
                />
                {{ doneSummary }}
            </p>

            <CommonButton
                v-if="generationStatus === 'READY'"
                type="primary"
                @click="openReview"
            >Review</CommonButton>
            <span
                v-else
                class="solver_hint"
            >{{ generationStatus === 'APPLIED' ? 'Applied.' : 'Discarded.' }}</span>

            <CommonButton
                type="link"
                @click="dismiss"
            >Dismiss</CommonButton>
        </div>

        <!-- FAILED / CANCELLED -->
        <div
            v-else
            class="solver_done"
        >
            <p class="solver_status solver_status--failed">
                <Icon
                    name="material-symbols:error-outline"
                    aria-hidden="true"
                />
                {{ failedSummary }}
            </p>
            <CommonButton
                type="secondary"
                @click="dismiss"
            >Try again</CommonButton>
        </div>

        <p
            v-if="error"
            class="solver_error"
        >{{ error }}</p>
    </div>
</template>

<script setup lang="ts">
import CommonButton from '~/components/common/CommonButton.vue';
import { useSolverRun } from '~/composables/solverRun';

const props = defineProps<{ termId: string }>();

const termId = computed(() => props.termId);
const { run, state, trend, error, adopted, start, cancel, dismiss } = useSolverRun(termId);

const showAdvanced = ref(false);
const confirmCancel = ref(false);

// Seeded from the route's own defaults so the disclosure shows what a plain
// click would have done, rather than blank inputs.
const maxMoves = ref(50_000);
const maxWallSeconds = ref(10);

/** The Generation's CURRENT status — an applied proposal must stop inviting a decision. */
const generationStatus = ref<string | null>(null);
const doneMeta = ref<{ placements?: number; hardViolations?: number } | null>(null);

async function startRun() {
    confirmCancel.value = false;
    await start({ maxMoves: maxMoves.value, maxWallMillis: maxWallSeconds.value * 1000 });
}

async function doCancel() {
    confirmCancel.value = false;
    await cancel();
}

function openReview() {
    if (run.value?.generationId) {
        navigateTo(`/schedule/review/${run.value.generationId}`);
    }
}

/**
 * Read the proposal's own status once the run lands, and again whenever it
 * changes. "Review" on a Generation somebody already applied would invite a
 * decision that no longer exists.
 */
watch(() => run.value?.generationId, async (generationId) => {
    generationStatus.value = null;
    doneMeta.value = null;

    if (!generationId) {
        return;
    }

    try {
        const generation = await $fetch<{
            status: string;
            solverMeta: { placements?: number; hardViolations?: number } | null;
        }>(`/api/generations/${generationId}`);

        generationStatus.value = generation.status;
        doneMeta.value = generation.solverMeta;
    } catch {
        generationStatus.value = null;
    }
});

const objectiveLabel = computed(() => (
    run.value?.bestObjective === null || run.value?.bestObjective === undefined
        ? 'objective —'
        : `objective ${run.value.bestObjective.toLocaleString()}`
));

const trendLabel = computed(() => {
    if (!trend.value) {
        return '';
    }

    return trend.value.improving
        ? '↓ improving'
        : `no improvement for ${Math.round(trend.value.flatForMs / 1000)}s`;
});

function compact(n: number): string {
    if (n >= 1_000_000) {
        return `${(n / 1_000_000).toFixed(1)}M`;
    }

    if (n >= 1_000) {
        return `${(n / 1_000).toFixed(0)}k`;
    }

    return String(n);
}

const movesLabel = computed(() => `${compact(Number(run.value?.movesEvaluated ?? 0))} moves`);

const elapsedLabel = computed(() => `${Math.round((run.value?.elapsedMillis ?? 0) / 1000)}s`);

const budgetFraction = computed(() => run.value?.progress ?? 0);

/** Names BOTH budgets, because either one can be what ends the run. */
const budgetCaption = computed(() => {
    const moves = run.value?.maxMoves ? compact(Number(run.value.maxMoves)) : '—';
    const seconds = run.value?.maxWallMillis ? Math.round(run.value.maxWallMillis / 1000) : '—';

    return `ends at ${moves} moves or ${seconds}s, whichever first`;
});

const doneSummary = computed(() => {
    const parts = ['Proposal ready'];

    if (doneMeta.value?.placements !== undefined) {
        parts.push(`${doneMeta.value.placements} placements`);
    }

    if (doneMeta.value?.hardViolations !== undefined) {
        const n = doneMeta.value.hardViolations;

        parts.push(`${n} issue${n === 1 ? '' : 's'}`);
    }

    return parts.join(' · ');
});

const failedSummary = computed(() => {
    if (run.value?.status === 'CANCELLED') {
        return 'Run cancelled — no proposal was produced.';
    }

    /**
     * A lost result is NOT a failed run, and saying "the run failed" would be
     * false: the solver succeeded and this app could not retrieve the answer.
     * The distinction matters to whoever reads it — the fix is to run it again,
     * not to look for what went wrong with the search.
     */
    if (run.value?.status === 'SUCCEEDED') {
        return 'The run succeeded, but its result could not be retrieved from the solver. '
            + 'Nothing was lost from the schedule — run it again to get a proposal.';
    }

    return run.value?.errorDetail || 'The run failed.';
});
</script>

<style scoped lang="scss">
.solver {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-5);
    align-items: center;

    &_advanced-toggle {
        cursor: pointer;

        border: 0;

        font-size: var(--font-size-xs);
        color: $content5;
        text-decoration: underline;

        background: none;
    }

    &_advanced {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-5);
        align-items: flex-end;

        width: 100%;
        padding: var(--space-5);
        border-radius: var(--radius-md);

        background: $surface2;
    }

    &_field {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);

        font-size: var(--font-size-xs);
        color: $content5;

        input {
            width: 130px;
            padding: var(--space-2) var(--space-3);
            border: 1px solid $surface4;
            border-radius: var(--radius-sm);

            font-size: var(--font-size-sm);
            color: $content1;

            background: $surface1;
        }
    }

    &_live {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);

        min-width: 280px;
        padding: var(--space-5);
        border-radius: var(--radius-md);

        background: $surface2;
    }

    &_live-head {
        display: flex;
        gap: var(--space-5);
        align-items: center;
        justify-content: space-between;
    }

    &_status {
        display: flex;
        gap: var(--space-2);
        align-items: center;

        font-size: var(--font-size-sm);
        font-weight: 600;
        color: $content2;

        &--done {
            color: $content1;
        }

        &--failed {
            color: $content5;
        }
    }

    &_objective {
        display: flex;
        gap: var(--space-3);
        align-items: baseline;
    }

    &_objective-value {
        font-size: var(--font-size-md);
        font-weight: 600;
        color: $content1;
    }

    &_trend {
        font-size: var(--font-size-xs);
        color: $content5;

        &--stalled {
            font-weight: 600;
            color: $content2;
        }
    }

    &_counters {
        font-size: var(--font-size-xs);
        color: $content5;
    }

    &_budget {
        overflow: hidden;

        width: 100%;
        height: 6px;
        border-radius: var(--radius-sm);

        background: $surface4;
    }

    &_budget-fill {
        display: block;
        height: 100%;
        background: $content5;
        transition: width 0.4s ease;
    }

    &_hint {
        font-size: var(--font-size-xs);
        color: $content5;
    }

    &_confirm {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-3);
        align-items: center;

        margin-top: var(--space-2);

        font-size: var(--font-size-xs);
        color: $content2;
    }

    &_done {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-5);
        align-items: center;
    }

    &_error {
        width: 100%;
        font-size: var(--font-size-xs);
        color: $content2;
    }
}
</style>
