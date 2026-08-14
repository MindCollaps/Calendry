<template>
    <div class="agenda">
        <!--
            A week grid does not survive a phone, so the mobile presentation is a
            day agenda over the same data rather than a scaled-down grid. Days
            come from the TimeGrid, so this never assumes a five-day week either.
        -->
        <div
            class="agenda_days"
            role="tablist"
            aria-label="Day"
        >
            <button
                v-for="day in grid.activeDays"
                :key="day"
                type="button"
                role="tab"
                class="agenda_day"
                :class="{ 'agenda_day--active': day === activeDay }"
                :aria-selected="day === activeDay"
                @click="activeDay = day"
            >
                <span>{{ weekdayShort(day) }}</span>
                <span
                    v-if="countFor(day)"
                    class="agenda_count"
                >{{ countFor(day) }}</span>
            </button>
        </div>

        <p
            v-if="!daySessions.length"
            class="agenda_empty"
        >Nothing scheduled on {{ weekdayName(activeDay) }}.</p>

        <ol
            v-else
            class="agenda_list"
        >
            <li
                v-for="session in daySessions"
                :key="session.id"
            >
                <span class="agenda_time">
                    {{ blockTime(grid, session.blockIndex).start }}
                    <span class="agenda_time-end">{{ blockTime(grid, session.blockIndex + session.durationBlocks - 1).end }}</span>
                </span>

                <ScheduleSessionChip
                    :session="session"
                    :violations="violations.get(session.id) ?? []"
                    :selected="session.id === selectedId"
                    :dimmed="false"
                    @select="$emit('select', session.id)"
                />
            </li>
        </ol>
    </div>
</template>

<script setup lang="ts">
import type { ScheduleSession, TimeGrid, Violation } from '~/composables/schedule';
import { blockTime, weekdayName, weekdayShort } from '~/composables/schedule';
import ScheduleSessionChip from './ScheduleSessionChip.vue';

const props = defineProps<{
    grid: TimeGrid;
    sessions: ScheduleSession[];
    violations: Map<string, Violation[]>;
    selectedId: string | null;
}>();

defineEmits<{ select: [sessionId: string] }>();

const activeDay = ref(props.grid.activeDays[0] ?? 1);

const daySessions = computed(() => props.sessions
    .filter((s) => s.dayOfWeek === activeDay.value)
    .sort((a, b) => a.blockIndex - b.blockIndex));

function countFor(day: number): number {
    return props.sessions.filter((s) => s.dayOfWeek === day).length;
}
</script>

<style scoped lang="scss">
.agenda {
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: 100%;

    &_days {
        display: flex;
        gap: 4px;
        overflow-x: auto;
        padding: 4px;
        border-radius: 8px;
        background: $surface1;
    }

    &_day {
        cursor: pointer;

        display: flex;
        flex: 1;
        gap: 5px;
        align-items: center;
        justify-content: center;

        padding: 8px 10px;
        border: 0;
        border-radius: 6px;

        font-family: inherit;
        font-size: 12.5px;
        font-weight: 600;
        color: $content6;

        background: none;

        &--active {
            color: $content2;
            background: rgba(124, 89, 188, 0.2);
        }

        &:focus-visible { outline: 2px solid $primary400; outline-offset: -2px; }
    }

    &_count {
        min-width: 17px;
        padding: 1px 4px;
        border-radius: 9px;

        font-size: 10.5px;
        font-variant-numeric: tabular-nums;
        color: $surface1;

        background: $content7;
    }

    &_empty {
        margin: 0;
        padding: 28px 0;
        font-size: 13px;
        color: $surface7;
        text-align: center;
    }

    &_list {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin: 0;
        padding: 0;
        list-style: none;

        li {
            display: grid;
            grid-template-columns: 58px 1fr;
            gap: 10px;
            align-items: stretch;
            min-height: 58px;
        }
    }

    &_time {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding-top: 7px;

        font-size: 12px;
        font-variant-numeric: tabular-nums;
        color: $content6;
        text-align: right;

        &-end {
            font-size: 11px;
            color: $surface7;
        }
    }
}
</style>
