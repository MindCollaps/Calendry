<template>
    <div
        class="grid"
        :class="{ 'grid--placing': placing }"
        :style="gridStyle"
    >
        <!--
            EVERY item is placed explicitly. Session chips carry definite grid
            positions, and CSS Grid places definite items first — auto-placed
            items then skip the occupied areas. Leaving the cells to
            auto-placement therefore shifted them out from under their own
            coordinates wherever a chip sat, so clicking a slot moved the
            session somewhere else entirely.
        -->
        <div
            class="grid_corner"
            :style="{ gridColumn: 1, gridRow: 1 }"
        />

        <div
            v-for="(day, dayIndex) in grid.activeDays"
            :key="`head-${day}`"
            class="grid_day"
            :style="{ gridColumn: dayIndex + 2, gridRow: 1 }"
        >
            <span class="grid_day-long">{{ weekdayName(day) }}</span>
            <span class="grid_day-short">{{ weekdayShort(day) }}</span>
        </div>

        <template
            v-for="block in grid.blocksPerDay"
            :key="`row-${block}`"
        >
            <div
                class="grid_time"
                :style="{ gridColumn: 1, gridRow: block + 1 }"
            >
                <span class="grid_time-start">{{ blockTime(grid, block - 1).start }}</span>
                <span class="grid_time-end">{{ blockTime(grid, block - 1).end }}</span>
            </div>

            <button
                v-for="(day, dayIndex) in grid.activeDays"
                :key="`cell-${day}-${block}`"
                type="button"
                class="grid_cell"
                :class="{ 'grid_cell--target': placing }"
                :style="{ gridColumn: dayIndex + 2, gridRow: block + 1 }"
                :disabled="!placing"
                :aria-label="placing
                    ? `Move to ${weekdayName(day)} ${blockTime(grid, block - 1).start}`
                    : undefined"
                @click="placing && $emit('place', { dayOfWeek: day, blockIndex: block - 1 })"
            />
        </template>

        <!-- Sessions ride above the cell layer in the same grid, so a
             multi-block session spans rows naturally. Each one is placed
             individually and offset within its day column, so overlapping
             sessions sit beside each other instead of stacking. -->
        <div
            v-for="placement in placements"
            :key="placement.session.id"
            class="grid_slot"
            :style="slotStyle(placement)"
        >
            <ScheduleSessionChip
                :session="placement.session"
                :violations="violations.get(placement.session.id) ?? []"
                :selected="placement.session.id === selectedId"
                :dimmed="placing && placement.session.id !== selectedId"
                @select="$emit('select', placement.session.id)"
            />
        </div>
    </div>
</template>

<script setup lang="ts">
import {
    type ScheduleSession, type SessionPlacement, type TimeGrid, type Violation,
    blockTime, layoutDay, weekdayName, weekdayShort,
} from '~/composables/schedule';
import ScheduleSessionChip from './ScheduleSessionChip.vue';

const props = defineProps<{
    grid: TimeGrid;
    sessions: ScheduleSession[];
    violations: Map<string, Violation[]>;
    selectedId: string | null;
    placing: boolean;
    rowHeight: number;
}>();

defineEmits<{
    select: [sessionId: string];
    place: [target: { dayOfWeek: number; blockIndex: number }];
}>();

/**
 * Column count comes from the grid's own active days — not a constant, and not
 * `activeDays.length` assumed to be five.
 */
const gridStyle = computed(() => ({
    '--day-count': String(props.grid.activeDays.length),
    '--row-height': `${props.rowHeight}px`,
}));

const placements = computed(() => props.grid.activeDays.flatMap((day) => layoutDay(
    props.sessions.filter((s) => s.dayOfWeek === day),
)));

/**
 * A session occupies its own grid area (day column x block rows) and is then
 * inset horizontally to its share of that column. Two sessions that overlap in
 * time therefore sit side by side rather than on top of one another — which is
 * what made the upper chip's hover lift reveal the one beneath it.
 */
function slotStyle(placement: SessionPlacement) {
    const { session, column, columns } = placement;
    const dayColumn = props.grid.activeDays.indexOf(session.dayOfWeek) + 2;
    const width = 100 / columns;

    return {
        gridColumn: `${dayColumn}`,
        gridRow: `${session.blockIndex + 2} / span ${session.durationBlocks}`,
        width: `${width}%`,
        marginLeft: `${column * width}%`,
    };
}
</script>

<style scoped lang="scss">
.grid {
    display: grid;
    grid-template-columns: auto repeat(var(--day-count), minmax(0, 1fr));
    grid-auto-rows: var(--row-height);
    gap: 1px;

    padding: 1px;
    border-radius: 10px;

    background: $surface5;

    &_corner,
    &_day,
    &_time {
        background: $surface1;
    }

    &_corner {
        position: sticky;
        z-index: 3;
        top: 0;
        left: 0;

        border-radius: 9px 0 0;
    }

    &_day {
        position: sticky;
        z-index: 2;
        top: 0;

        display: flex;
        align-items: center;
        justify-content: center;

        height: 40px;

        font-size: 13px;
        font-weight: 600;
        letter-spacing: 0.02em;
        color: $content6;

        &-short { display: none; }

        @include mobile() {
            &-long { display: none; }
            &-short { display: inline; }
        }
    }

    &_time {
        position: sticky;
        z-index: 1;
        left: 0;

        display: flex;
        flex-direction: column;
        gap: 2px;
        align-items: flex-end;
        justify-content: center;

        min-width: 62px;
        padding: 0 10px;

        // Tabular figures keep the time column from shivering row to row.
        font-variant-numeric: tabular-nums;

        &-start {
            font-size: 12px;
            color: $content6;
        }

        &-end {
            font-size: 11px;
            color: $surface7;
        }
    }

    &_cell {
        appearance: none;
        border: 0;
        background: $surface0;

        &:disabled { cursor: default; }

        &--target {
            cursor: pointer;
            transition: background 160ms cubic-bezier(0.16, 1, 0.3, 1);

            &::after {
                content: '';

                display: block;
                width: 100%;
                height: 100%;
                border: 1px dashed rgba(124, 89, 188, 0.55);
                border-radius: 6px;

                opacity: 0;
                transition: opacity 160ms cubic-bezier(0.16, 1, 0.3, 1);
            }

            @include hover() {
                &:hover {
                    background: rgba(124, 89, 188, 0.14);

                    &::after { opacity: 1; }
                }
            }

            &:focus-visible {
                background: rgba(124, 89, 188, 0.14);
                outline: 2px solid $primary400;
                outline-offset: -2px;

                &::after { opacity: 1; }
            }
        }
    }

    &_slot {
        display: flex;
        min-width: 0;
        padding: 2px;
        pointer-events: none;

        > * { pointer-events: auto; }
    }
}
</style>
