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
                <!--
                    A session-scoped violation is a link to the chip that caused
                    it. An OFFERING-scoped one (ExactFrequency: "needs 6, placed
                    4") has no chip to select — the whole point is that the
                    sessions were never placed — so it renders as a statement
                    rather than a dead button.
                -->
                <button
                    v-if="violation.sessionId"
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

                <span
                    v-else
                    class="panel_unplaced"
                >
                    <Icon
                        :class="violation.severity === 'HARD' ? 'is-hard' : 'is-soft'"
                        name="material-symbols:event-busy-outline"
                        aria-hidden="true"
                    />
                    {{ violation.offering
                        ? [violation.offering.code, violation.offering.title].filter(Boolean).join(' · ')
                        : 'Unplaced demand' }}
                </span>

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

    // Same shape as the session button minus the affordance: there is nothing
    // to navigate to, and a button that selects nothing is worse than text.
    &_unplaced {
        display: flex;
        gap: 5px;
        align-items: center;

        font-size: var(--font-size-sm);
        font-weight: 600;
        color: $content5;

        svg {
            width: 14px;
            height: 14px;
        }
    }
}
</style>
