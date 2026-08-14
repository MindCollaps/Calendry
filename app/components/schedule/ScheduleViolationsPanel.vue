<template>
    <section class="panel">
        <h2>Current violations</h2>

        <p
            v-if="!violations.length"
            class="panel_muted"
        >Nothing flagged in this view.</p>

        <ul v-else>
            <li
                v-for="violation in violations"
                :key="violation.id"
            >
                <button
                    type="button"
                    @click="$emit('select', violation.sessionId)"
                >
                    <Icon
                        :name="violation.severity === 'HARD'
                            ? 'material-symbols:error'
                            : 'material-symbols:warning-outline'"
                        :class="violation.severity === 'HARD' ? 'is-hard' : 'is-soft'"
                        aria-hidden="true"
                    />
                    {{ sessionTitle(violation.sessionId) }}
                </button>
                <span>{{ describeViolation(violation, lookup) }}</span>
            </li>
        </ul>
    </section>
</template>

<script setup lang="ts">
import type { Violation } from '~/composables/schedule';
import { describeViolation } from '~/composables/schedule';

/**
 * The queryable half of warn-and-allow (TAXONOMY.md §3): a violation persists
 * after the edit that caused it, so it has to be findable without clicking
 * every session in the grid.
 */
defineProps<{
    violations: Violation[];
    lookup: { room: (id: string) => string; person: (id: string) => string; group: (id: string) => string };
    sessionTitle: (id: string) => string;
}>();

defineEmits<{ select: [sessionId: string] }>();
</script>

<style scoped lang="scss">
@use '~/scss/schedule-panel' as *;

.panel {
    @include schedule-panel;

    h2 { color: $content6; }
}
</style>
