<template>
    <header class="bar">
        <div class="bar_group">
            <label class="bar_field">
                <span>Term</span>
                <select
                    v-model="termIdModel"
                    class="bar_select"
                >
                    <option
                        v-for="term in terms"
                        :key="term.id"
                        :value="term.id"
                    >{{ term.name }}</option>
                </select>
            </label>

            <div
                class="bar_week"
                role="group"
                aria-label="Week"
            >
                <button
                    type="button"
                    :disabled="weekModel <= 1"
                    aria-label="Previous week"
                    @click="weekModel = Math.max(1, weekModel - 1)"
                >
                    <Icon
                        name="material-symbols:chevron-left"
                        aria-hidden="true"
                    />
                </button>
                <span class="bar_week-label">Week {{ weekModel }}<span class="bar_muted"> / {{ totalWeeks }}</span></span>
                <button
                    type="button"
                    :disabled="weekModel >= totalWeeks"
                    aria-label="Next week"
                    @click="weekModel = Math.min(totalWeeks, weekModel + 1)"
                >
                    <Icon
                        name="material-symbols:chevron-right"
                        aria-hidden="true"
                    />
                </button>
            </div>
        </div>

        <div class="bar_group">
            <label class="bar_field">
                <span>Group</span>
                <select
                    v-model="groupIdModel"
                    class="bar_select"
                >
                    <option value="">All groups</option>
                    <option
                        v-for="group in groups"
                        :key="group.id"
                        :value="group.id"
                    >{{ group.name }}</option>
                </select>
            </label>

            <label
                v-if="groupIdModel"
                class="bar_check"
            >
                <input
                    v-model="includeNestedModel"
                    type="checkbox"
                >
                <span>Include nested</span>
            </label>

            <label class="bar_field">
                <span>Room</span>
                <select
                    v-model="roomIdModel"
                    class="bar_select"
                >
                    <option value="">All rooms</option>
                    <option
                        v-for="room in rooms"
                        :key="room.id"
                        :value="room.id"
                    >{{ room.name }}</option>
                </select>
            </label>

            <label class="bar_field">
                <span>Person</span>
                <select
                    v-model="personIdModel"
                    class="bar_select"
                >
                    <option value="">Anyone</option>
                    <option
                        v-for="person in people"
                        :key="person.id"
                        :value="person.id"
                    >{{ person.name }}</option>
                </select>
            </label>
        </div>

        <div class="bar_group bar_group--end">
            <label class="bar_field">
                <span>Density</span>
                <select
                    v-model.number="rowHeightModel"
                    class="bar_select"
                >
                    <option :value="44">Compact</option>
                    <option :value="60">Comfortable</option>
                    <option :value="84">Spacious</option>
                </select>
            </label>

            <!-- Permission-gated: a caller without violation.read gets no
                 affordance for data the API would refuse them anyway. -->
            <button
                v-if="canReadViolations"
                type="button"
                class="bar_violations-toggle"
                :class="{ 'bar_violations-toggle--active': showViolationsModel }"
                :aria-pressed="showViolationsModel"
                @click="showViolationsModel = !showViolationsModel"
            >
                <Icon
                    name="material-symbols:error-outline"
                    aria-hidden="true"
                />
                {{ violationCount }} violation{{ violationCount === 1 ? '' : 's' }}
            </button>
        </div>
    </header>
</template>

<script setup lang="ts">
import type { NamedRow, Term } from '~/composables/schedule';

defineProps<{
    terms: Term[];
    groups: NamedRow[];
    rooms: NamedRow[];
    people: NamedRow[];
    totalWeeks: number;
    violationCount: number;
    canReadViolations: boolean;
}>();

// Filter values are owned by useScheduleFilters() and reach this component as
// models — the toolbar renders and edits them, it does not own them.
const termIdModel = defineModel<string>('termId', { required: true });
const weekModel = defineModel<number>('week', { required: true });
const groupIdModel = defineModel<string>('groupId', { required: true });
const roomIdModel = defineModel<string>('roomId', { required: true });
const personIdModel = defineModel<string>('personId', { required: true });
const includeNestedModel = defineModel<boolean>('includeNested', { required: true });

// View state, owned by the page: neither affects the API query.
const rowHeightModel = defineModel<number>('rowHeight', { required: true });
const showViolationsModel = defineModel<boolean>('showViolations', { required: true });
</script>

<style scoped lang="scss">
.bar {
    display: flex;
    flex-wrap: wrap;
    gap: 10px 20px;
    align-items: flex-end;

    padding: 14px 16px;
    border-radius: var(--radius-xl);

    background: $surface1;

    &_group {
        display: flex;
        flex-wrap: wrap;
        gap: 10px 14px;
        align-items: flex-end;

        &--end { margin-left: auto; }
    }

    &_field {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);

        > span {
            font-size: var(--font-size-xs);
            font-weight: 600;
            letter-spacing: 0.05em;
            color: $surface7;
            text-transform: uppercase;
        }
    }

    &_select {
        cursor: pointer;

        min-width: 120px;
        padding: var(--space-3) var(--space-4);
        border: 1px solid $surface5;
        border-radius: var(--radius-md);

        font-family: inherit;
        font-size: var(--font-size-md);
        color: $content5;

        background: $surface0;

        &:focus-visible { outline: 2px solid $primary400; outline-offset: 1px; }
    }

    &_check {
        display: flex;
        gap: var(--space-3);
        align-items: center;

        padding-bottom: 7px;

        font-size: var(--font-size-sm);
        color: $content6;

        input { accent-color: $primary500; }
    }

    &_week {
        display: flex;
        gap: var(--space-1);
        align-items: center;

        padding: var(--space-1);
        border: 1px solid $surface5;
        border-radius: var(--radius-md);

        background: $surface0;

        button {
            cursor: pointer;

            display: flex;
            padding: var(--space-2);
            border: 0;
            border-radius: var(--radius-sm);

            color: $content6;

            background: none;

            &:disabled { cursor: default; color: $surface6; }

            @include hover() {
                &:not(:disabled):hover { background: $surface3; }
            }

            &:focus-visible { outline: 2px solid $primary400; }
        }

        &-label {
            padding: 0 var(--space-3);
            font-size: var(--font-size-md);
            font-variant-numeric: tabular-nums;
            color: $content5;
        }
    }

    &_muted { color: $surface7; }

    &_violations-toggle {
        cursor: pointer;

        display: flex;
        gap: var(--space-3);
        align-items: center;

        padding: 7px var(--space-5);
        border: 1px solid $surface5;
        border-radius: var(--radius-md);

        font-family: inherit;
        font-size: var(--font-size-sm);
        color: $content6;

        background: $surface0;

        svg { width: 15px; height: 15px; }

        @include hover() {
            &:hover { border-color: $surface6; color: $content4; }
        }

        &:focus-visible { outline: 2px solid $primary400; outline-offset: 1px; }

        &--active {
            border-color: $primary500;
            color: $content2;
            background: rgba(124, 89, 188, 0.16);
        }
    }
}
</style>
