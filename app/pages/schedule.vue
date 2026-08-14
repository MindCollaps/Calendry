<!--
    THESIS: the schedule is a place, not a list of records — one week held still
    so a timetabler can see where a session sits and put it somewhere better. It
    refuses the admin-CRUD-table arrangement this category defaults to.
    OWN-WORLD: a restrained neutral ground (surface0-5) with the violet primary
    reserved almost entirely for one thing — where a session may land. Density
    and rhythm carry the design; colour is spent on state, not decoration. Built
    against a near-black ground, rebased to light in Step 11 for a data reason
    (see DESIGN.md); the composition is ground-agnostic and both themes render it.
    STORY: the visitor sees the week, spots what is wrong by its shape and icon
    rather than its hue, selects it, and moves it knowing the consequence.
    FIRST VIEWPORT: filter bar across the top; time column left; the week filling
    the remaining width; inspector docked right, empty until something is chosen.
    The primary action lives in the inspector, next to the thing it acts on.
    FORM: week grid with docked inspector — composition A of three offered; the
    dice script that would have dealt these produced no output (see CLAUDE.md),
    so the choice was made explicitly with the user instead.
    FINISH: unreviewed and undocumented is unfinished; this build ends with the
    finish review, the verdict, and DESIGN.md.
-->
<template>
    <div class="schedule">
        <ScheduleToolbar
            v-model:term-id="filters.termId.value"
            v-model:week="filters.week.value"
            v-model:group-id="filters.groupId.value"
            v-model:room-id="filters.roomId.value"
            v-model:person-id="filters.personId.value"
            v-model:include-nested="filters.includeNested.value"
            v-model:row-height="rowHeight"
            v-model:show-violations="showViolations"
            :terms="data.terms.value"
            :groups="data.groups.value"
            :rooms="data.rooms.value"
            :people="data.people.value"
            :total-weeks="data.totalWeeks.value"
            :violation-count="data.violations.value.length"
            :can-read-violations="data.canReadViolations.value"
        />

        <p
            v-if="editing.placing.value"
            class="schedule_placing"
            role="status"
        >
            <Icon
                name="material-symbols:touch-app-outline"
                aria-hidden="true"
            />
            Pick a slot for <strong>{{ editing.selected.value?.offering?.title }}</strong>. Press Escape to cancel.
        </p>

        <p
            v-if="editing.error.value"
            class="schedule_error"
            role="alert"
        >{{ editing.error.value }}</p>

        <ScheduleEmptyState
            v-if="!data.pending.value && !data.grid.value"
            title="No time grid configured"
        >
            A schedule needs a TimeGrid — how long a block is, how many run per day,
            and which days this institution teaches on. Nothing is assumed on your behalf.
        </ScheduleEmptyState>

        <ScheduleEmptyState
            v-else-if="!data.pending.value && !data.terms.value.length"
            title="No terms yet"
        >
            Create a term to place sessions into.
        </ScheduleEmptyState>

        <div
            v-else-if="data.pending.value"
            class="schedule_loading"
        >
            <common-loader/>
        </div>

        <div
            v-else-if="data.grid.value"
            class="schedule_body"
        >
            <div class="schedule_main">
                <ScheduleGrid
                    class="schedule_grid"
                    :grid="data.grid.value"
                    :sessions="data.onGridSessions.value"
                    :violations="data.violationsBySessionId.value"
                    :selected-id="editing.selectedId.value"
                    :placing="editing.placing.value"
                    :row-height="rowHeight"
                    @select="editing.select"
                    @place="editing.move"
                />

                <ScheduleAgenda
                    class="schedule_agenda"
                    :grid="data.grid.value"
                    :sessions="data.onGridSessions.value"
                    :violations="data.violationsBySessionId.value"
                    :selected-id="editing.selectedId.value"
                    @select="editing.select"
                />

                <ScheduleOffGridTray
                    v-if="data.offGridSessions.value.length"
                    :sessions="data.offGridSessions.value"
                    :grid="data.grid.value"
                    @select="editing.select"
                />

                <ScheduleViolationsPanel
                    v-if="showViolations && data.canReadViolations.value"
                    :violations="data.violations.value"
                    :lookup="data.lookup"
                    :session-title="data.sessionTitle"
                    @select="editing.select"
                />
            </div>

            <ScheduleInspector
                :session="editing.selected.value"
                :grid="data.grid.value"
                :violations="editing.selected.value
                    ? (data.violationsBySessionId.value.get(editing.selected.value.id) ?? [])
                    : []"
                :can-move="canMove"
                :can-lock="canLock"
                :placing="editing.placing.value"
                :busy="editing.busy.value"
                :lookup="data.lookup"
                @close="editing.clearSelection"
                @toggle-place="editing.togglePlacing"
                @toggle-lock="editing.toggleLock"
            />
        </div>
    </div>
</template>

<script setup lang="ts">
import ScheduleAgenda from '~/components/schedule/ScheduleAgenda.vue';
import ScheduleEmptyState from '~/components/schedule/ScheduleEmptyState.vue';
import ScheduleGrid from '~/components/schedule/ScheduleGrid.vue';
import ScheduleInspector from '~/components/schedule/ScheduleInspector.vue';
import ScheduleOffGridTray from '~/components/schedule/ScheduleOffGridTray.vue';
import ScheduleToolbar from '~/components/schedule/ScheduleToolbar.vue';
import ScheduleViolationsPanel from '~/components/schedule/ScheduleViolationsPanel.vue';
import { useScheduleData } from '~/composables/scheduleData';
import { useScheduleEditing } from '~/composables/scheduleEditing';
import { useScheduleFilters } from '~/composables/scheduleFilters';
import { useHasPermission } from '~/composables/session';

/**
 * Composition only. Three composables own the state, seven components own the
 * rendering; this file decides what sits next to what.
 *
 *   useScheduleFilters  — what changes the API query
 *   useScheduleData     — server state and everything derived from it
 *   useScheduleEditing  — selection, placement mode, mutations
 */
useHead({ title: 'Schedule' });

// UX only. Every one of these is re-checked server-side; a client that forges
// them reaches an endpoint that returns 403.
const canMove = useHasPermission('session.move');
const canLock = useHasPermission('session.lock');

const filters = useScheduleFilters();

// The composable is synchronous by design; this is the single await, at setup
// top level where Nuxt keeps its instance context. SSR must resolve before the
// first render — a page that hydrates from an empty render is indistinguishable
// from a tenant with no schedule.
const data = useScheduleData(filters);

await data.ready;

const editing = useScheduleEditing({
    sessions: data.allSessions,
    onMutated: data.refreshAll,
});

/**
 * View state, deliberately page-local: neither value reaches the API query, so
 * neither belongs in useScheduleFilters.
 */
const rowHeight = ref(60);
const showViolations = ref(false);
</script>

<style scoped lang="scss">
.schedule {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: var(--space-7) 24px var(--space-8);

    @include mobile() { padding: 14px; }

    &_placing {
        display: flex;
        gap: var(--space-4);
        align-items: center;

        margin: 0;
        padding: 10px 14px;
        border-radius: var(--radius-lg);

        font-size: var(--font-size-md);
        color: $content4;

        background: rgba(124, 89, 188, 0.16);

        svg { width: var(--space-6); height: var(--space-6); flex: none; }

        strong { font-weight: 650; }
    }

    &_error {
        margin: 0;
        padding: 10px 14px;
        border-radius: var(--radius-lg);

        font-size: var(--font-size-md);
        color: $error300;

        background: rgba(169, 45, 70, 0.16);
    }

    &_body {
        display: flex;
        gap: 14px;
        align-items: flex-start;

        @include mobile() { flex-direction: column; }
    }

    &_main {
        display: flex;
        flex: 1;
        flex-direction: column;
        gap: 14px;
        min-width: 0;
    }

    &_grid {
        @include mobile() { display: none; }
    }

    &_agenda {
        display: none;

        @include mobile() { display: flex; }
    }

    &_loading {
        display: flex;
        justify-content: center;
        padding: 60px 0;
    }
}
</style>
