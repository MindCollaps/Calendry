<template>
    <section class="tray">
        <h2>
            <Icon
                name="material-symbols:report-outline"
                aria-hidden="true"
            />
            {{ sessions.length }} session{{ sessions.length === 1 ? '' : 's' }} cannot be placed on this grid
        </h2>

        <ul>
            <li
                v-for="session in sessions"
                :key="session.id"
            >
                <button
                    type="button"
                    @click="$emit('select', session.id)"
                >{{ session.offering?.title ?? 'Untitled session' }}</button>
                <span>{{ offGridReason(grid, session) }}</span>
            </li>
        </ul>
    </section>
</template>

<script setup lang="ts">
import type { ScheduleSession, TimeGrid } from '~/composables/schedule';
import { offGridReason } from '~/composables/schedule';

/**
 * Sessions the grid cannot position — a day the TimeGrid does not schedule, or
 * a block range running past the end of the day. Both are representable in the
 * schema (the CHECK only bounds 1-7 and >= 0), so a grid that positions by
 * index would drop them invisibly. They surface here instead.
 */
defineProps<{
    sessions: ScheduleSession[];
    grid: TimeGrid;
}>();

defineEmits<{ select: [sessionId: string] }>();
</script>

<style scoped lang="scss">
@use '~/scss/schedule-panel' as *;

.tray {
    @include schedule-panel;
}
</style>
