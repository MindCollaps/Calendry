<template>
    <div class="review">
        <header class="review_head">
            <div>
                <NuxtLink
                    to="/schedule"
                    class="review_back"
                >← Schedule</NuxtLink>
                <h1>Review proposal v{{ preview?.generation.version }}</h1>
                <p class="review_sub">
                    {{ preview?.generation.source === 'SOLVER' ? 'Solver proposal' : preview?.generation.source }}
                    · computed {{ computedAgo }}
                    <button
                        type="button"
                        class="review_refresh"
                        @click="refresh"
                    >Refresh</button>
                </p>
            </div>

            <!-- Only a READY proposal is awaiting a decision. -->
            <div
                v-if="isDecidable"
                class="review_actions"
            >
                <template v-if="canApply">
                    <CommonButton
                        type="primary"
                        :disabled="applying"
                        @click="apply"
                    >{{ applying ? 'Applying…' : 'Apply' }}</CommonButton>
                    <CommonButton
                        type="secondary-black"
                        :disabled="applying"
                        @click="confirmDiscard = true"
                    >Discard</CommonButton>
                </template>
                <!-- Static text, not disabled buttons: a disabled control reads
                     as "unavailable right now" rather than "not yours". -->
                <p
                    v-else
                    class="review_readonly"
                >You can review this proposal but not apply it.</p>
            </div>

            <p
                v-else
                class="review_state"
            >{{ terminalMessage }}</p>
        </header>

        <p
            v-if="applying"
            class="review_note"
        >
            Writing placements — a large proposal takes a few seconds.
        </p>

        <p
            v-if="actionError"
            class="review_error"
        >{{ actionError }}</p>

        <div
            v-if="confirmDiscard"
            class="review_confirm"
        >
            <span>Discard this proposal? It stays on record but can no longer be applied.</span>
            <CommonButton
                type="destructive"
                @click="doDiscard"
            >Discard</CommonButton>
            <CommonButton
                type="link"
                @click="confirmDiscard = false"
            >Keep it</CommonButton>
        </div>

        <!-- A Generation with no run proposes nothing; an empty grid would
             suggest it proposed an empty timetable. -->
        <p
            v-if="!preview?.run"
            class="review_empty"
        >
            Nothing to review — this Generation was not produced by a solver run.
        </p>

        <template v-else>
            <ScheduleReviewSummary
                :plan="preview.plan"
                :violations="preview.violations"
                :deleted-by-offering="preview.deletedByOffering"
                :run="preview.run"
            />

            <section class="review_grid-section">
                <div class="review_controls">
                    <label class="review_field">
                        <span>Week</span>
                        <select
                            v-model.number="termWeek"
                            class="review_select"
                        >
                            <option
                                v-for="week in weekOptions"
                                :key="week.termWeek"
                                :value="week.termWeek"
                                :selected="week.termWeek === termWeek"
                            >Week {{ week.termWeek }}{{ week.label }}</option>
                        </select>
                    </label>

                    <label class="review_field">
                        <span>Group</span>
                        <select
                            v-model="groupId"
                            class="review_select"
                        >
                            <option value="">All groups</option>
                            <option
                                v-for="group in groups"
                                :key="group.id"
                                :value="group.id"
                                :selected="group.id === groupId"
                            >{{ group.name }}</option>
                        </select>
                    </label>

                    <label class="review_field">
                        <span>Room</span>
                        <select
                            v-model="roomId"
                            class="review_select"
                        >
                            <option value="">All rooms</option>
                            <option
                                v-for="room in rooms"
                                :key="room.id"
                                :value="room.id"
                                :selected="room.id === roomId"
                            >{{ room.name }}</option>
                        </select>
                    </label>

                    <label class="review_check">
                        <input
                            v-model="changesOnly"
                            type="checkbox"
                        >
                        <span>Changes only</span>
                    </label>
                </div>

                <ScheduleReviewGrid
                    v-if="grid"
                    :grid="grid"
                    :placements="placements"
                    :row-height="60"
                    :lookup="lookup"
                    :empty-message="changesOnly
                        ? 'Nothing changes in this week.'
                        : 'No placements in this week.'"
                />
            </section>
        </template>
    </div>
</template>

<script setup lang="ts">
import CommonButton from '~/components/common/CommonButton.vue';
import ScheduleReviewGrid from '~/components/schedule/ScheduleReviewGrid.vue';
import ScheduleReviewSummary from '~/components/schedule/ScheduleReviewSummary.vue';
import { useGenerationReview } from '~/composables/generationReview';
import { useHasPermission } from '~/composables/session';

const route = useRoute();
const generationId = String(route.params.id);

const {
    preview, grid, groups, rooms, lookup,
    termWeek, groupId, roomId, changesOnly, placements,
    applying, actionError, apply, discard, refresh, ready,
} = useGenerationReview(generationId);

const canApply = useHasPermission('generation.apply');
const confirmDiscard = ref(false);

// The single top-level await, per the composable convention.
await ready;

const isDecidable = computed(() => preview.value?.generation.status === 'READY');

const terminalMessage = computed(() => {
    const status = preview.value?.generation.status;

    if (status === 'APPLIED') {
        return preview.value?.generation.isCurrent
            ? 'Applied — this is the current schedule.'
            : 'Applied, and since superseded.';
    }

    if (status === 'SUPERSEDED') {
        return 'Discarded or superseded — no longer applicable.';
    }

    return `This proposal is ${status} and is not awaiting a decision.`;
});

/** Weeks that actually contain changes are worth finding without clicking each. */
const weekOptions = computed(() => {
    const summary = preview.value?.weekSummary ?? [];

    if (!summary.length) {
        return [{ termWeek: 1, label: '' }];
    }

    return summary.map((week) => {
        const changed = week.created + week.moved + week.deleted;

        return {
            termWeek: week.termWeek,
            label: changed ? ` — ${changed} change${changed === 1 ? '' : 's'}` : ' — no changes',
        };
    });
});

const computedAgo = computed(() => {
    const at = preview.value?.computedAt;

    if (!at) {
        return 'just now';
    }

    const minutes = Math.floor((Date.now() - new Date(at).getTime()) / 60_000);

    return minutes < 1 ? 'just now' : `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
});

async function doDiscard() {
    confirmDiscard.value = false;
    await discard();
}

// Land on the first week that actually changed, rather than week 1 by default.
watch(preview, (value) => {
    const first = value?.weekSummary?.find((w) => w.created + w.moved + w.deleted > 0);

    if (first) {
        termWeek.value = first.termWeek;
    }
}, { immediate: true });
</script>

<style scoped lang="scss">
.review {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
    padding: var(--space-6);

    &_head {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-5);
        align-items: flex-start;
        justify-content: space-between;

        h1 {
            font-size: var(--font-size-xl);
            color: $content1;
        }
    }

    &_back {
        font-size: var(--font-size-sm);
        color: $content5;
        text-decoration: none;
    }

    &_sub {
        display: flex;
        gap: var(--space-4);
        align-items: center;

        font-size: var(--font-size-sm);
        color: $content5;
    }

    &_refresh {
        cursor: pointer;

        border: 0;

        font-size: var(--font-size-xs);
        color: $content5;
        text-decoration: underline;

        background: none;
    }

    &_actions {
        display: flex;
        gap: var(--space-4);
        align-items: center;
    }

    &_readonly,
    &_state,
    &_note,
    &_empty {
        font-size: var(--font-size-sm);
        color: $content5;
    }

    &_empty {
        padding: var(--space-8);
        border-radius: var(--radius-lg);
        text-align: center;
        background: $surface1;
    }

    &_error {
        font-size: var(--font-size-sm);
        color: $content2;
    }

    &_confirm {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-4);
        align-items: center;

        padding: var(--space-5);
        border-radius: var(--radius-lg);

        font-size: var(--font-size-sm);
        color: $content2;

        background: $surface1;
    }

    &_grid-section {
        display: flex;
        flex-direction: column;
        gap: var(--space-5);
    }

    &_controls {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-5);
        align-items: flex-end;
    }

    &_field {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);

        > span {
            font-size: var(--font-size-xs);
            font-weight: 600;
            color: $surface7;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }
    }

    &_select {
        cursor: pointer;

        min-width: 140px;
        padding: var(--space-3) var(--space-4);
        border: 1px solid $surface5;
        border-radius: var(--radius-md);

        font-family: inherit;
        font-size: var(--font-size-md);
        color: $content5;

        background: $surface0;
    }

    &_check {
        display: flex;
        gap: var(--space-3);
        align-items: center;

        font-size: var(--font-size-sm);
        color: $content5;
    }
}
</style>
