<template>
    <section class="rev">
        <!--
            TWO PANELS, NO ARROW BETWEEN THEM.

            The counts are not commensurable and must not be rendered as a
            delta: `current` comes from constraint_violation, which this app's
            evaluator fills using only the three structural double-booking
            rules, while `proposed` is the solver reporting on all 14 constraint
            types. Measured on the same timetable they disagree — the solver
            reported 23 where the app's evaluator then found 41 rows. "0 → 23"
            would be the most misleading thing this screen could say.
        -->
        <div class="rev_panels">
            <article class="rev_panel">
                <h3>Now</h3>
                <p class="rev_count">{{ violations.current.hard }}</p>
                <p class="rev_panel-note">
                    issue{{ violations.current.hard === 1 ? '' : 's' }} on the current schedule
                </p>
                <p class="rev_panel-source">checked by Calendry — 3 structural rules</p>
                <ul
                    v-if="currentTypes.length"
                    class="rev_types"
                >
                    <li
                        v-for="row in currentTypes"
                        :key="row.type"
                    >{{ row.count }} × {{ row.type }}</li>
                </ul>
            </article>

            <article class="rev_panel">
                <h3>Proposed</h3>
                <p class="rev_count">{{ violations.proposed.hard }}</p>
                <p class="rev_panel-note">
                    issue{{ violations.proposed.hard === 1 ? '' : 's' }} in this proposal
                </p>
                <p class="rev_panel-source">reported by the solver — 14 constraint types</p>
                <ul
                    v-if="proposedTypes.length"
                    class="rev_types"
                >
                    <li
                        v-for="row in proposedTypes"
                        :key="row.type"
                    >{{ row.count }} × {{ row.type }}</li>
                </ul>
                <!--
                    Reported, never netted out: these name Sessions the solver
                    invented, using a synthetic key that appears nowhere in the
                    placements, so they cannot be attached to any row.
                -->
                <p
                    v-if="violations.proposed.unmappable > 0"
                    class="rev_unmappable"
                >
                    {{ locatable }} of {{ violations.proposed.sessionReferences }} session references
                    can be located; {{ violations.proposed.unmappable }} name sessions the solver
                    created and cannot be pinned to a slot.
                </p>
            </article>
        </div>

        <p class="rev_incomparable">
            These two use different rule sets and are not a like-for-like difference.
        </p>

        <div class="rev_facts">
            <div class="rev_fact">
                <span class="rev_fact-label">Changes</span>
                <span class="rev_fact-value">
                    <strong>{{ plan.created }}</strong> added ·
                    <strong>{{ plan.moved }}</strong> moved ·
                    {{ plan.unchanged }} unchanged ·
                    <strong :class="{ 'rev_destructive': plan.deleted > 0 }">{{ plan.deleted }}</strong> removed
                </span>
            </div>

            <div
                v-if="plan.skippedLocked"
                class="rev_fact"
            >
                <span class="rev_fact-label">Locked</span>
                <span class="rev_fact-value">{{ plan.skippedLocked }} session(s) left exactly as they are</span>
            </div>

            <div
                v-if="plan.placementsUnmapped"
                class="rev_fact"
            >
                <span class="rev_fact-label">Unplaceable</span>
                <span class="rev_fact-value">{{ plan.placementsUnmapped }} placement(s) cannot be stored</span>
            </div>

            <div class="rev_fact">
                <span class="rev_fact-label">Run</span>
                <span class="rev_fact-value">
                    {{ terminationSentence(run?.terminationReason ?? null) }}
                    <template v-if="run?.objective !== null && run?.objective !== undefined">
                        Objective {{ run.objective.toLocaleString() }}.
                    </template>
                    <template v-if="run?.elapsedMillis">
                        Took {{ (run.elapsedMillis / 1000).toFixed(1) }}s.
                    </template>
                </span>
            </div>
        </div>

        <!--
            A removal means the solver REFUSED to place that Session — the one
            destructive part of applying — so it gets named, not counted.
        -->
        <details
            v-if="deletedByOffering.length"
            class="rev_deleted"
            open
        >
            <summary>{{ plan.deleted }} session(s) will be removed</summary>
            <ul>
                <li
                    v-for="row in deletedByOffering"
                    :key="row.offeringId"
                >
                    <strong>{{ row.count }}</strong> from
                    {{ row.code ? `${row.code} · ${row.title}` : row.title }}
                </li>
            </ul>
            <p class="rev_panel-note">
                The solver could not place these. Applying deletes them rather than
                leaving them where the solver rejected them.
            </p>
        </details>
    </section>
</template>

<script setup lang="ts">
import { terminationSentence } from '~/composables/generationReview';
import type { ReviewPreview } from '~/composables/generationReview';

const props = defineProps<{
    plan: NonNullable<ReviewPreview['plan']>;
    violations: ReviewPreview['violations'];
    deletedByOffering: ReviewPreview['deletedByOffering'];
    run: ReviewPreview['run'];
}>();

const toRows = (byType: Record<string, number>) => Object.entries(byType)
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);

const currentTypes = computed(() => toRows(props.violations.current.byType));
const proposedTypes = computed(() => toRows(props.violations.proposed.byType));

const locatable = computed(() => (
    props.violations.proposed.sessionReferences - props.violations.proposed.unmappable
));
</script>

<style scoped lang="scss">
.rev {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);

    &_panels {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: var(--space-5);
    }

    &_panel {
        padding: var(--space-6);
        border-radius: var(--radius-lg);
        background: $surface1;

        h3 {
            font-size: var(--font-size-xs);
            font-weight: 600;
            color: $surface7;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }
    }

    &_count {
        font-size: var(--font-size-2xl);
        font-weight: 600;
        color: $content1;
    }

    &_panel-note {
        font-size: var(--font-size-sm);
        color: $content5;
    }

    &_panel-source {
        margin-top: var(--space-2);
        font-size: var(--font-size-xs);
        color: $surface7;
    }

    &_types {
        margin-top: var(--space-4);
        font-size: var(--font-size-sm);
        color: $content2;
        list-style: none;
    }

    &_unmappable {
        margin-top: var(--space-4);
        padding-top: var(--space-4);
        border-top: 1px solid $surface4;

        font-size: var(--font-size-xs);
        color: $content5;
    }

    &_incomparable {
        font-size: var(--font-size-xs);
        font-style: italic;
        color: $surface7;
    }

    &_facts {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);

        padding: var(--space-5);
        border-radius: var(--radius-lg);

        background: $surface1;
    }

    &_fact {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-4);
        align-items: baseline;
    }

    &_fact-label {
        min-width: 92px;

        font-size: var(--font-size-xs);
        font-weight: 600;
        color: $surface7;
        text-transform: uppercase;
        letter-spacing: 0.05em;
    }

    &_fact-value {
        font-size: var(--font-size-md);
        color: $content2;
    }

    &_destructive {
        color: $content1;
    }

    &_deleted {
        padding: var(--space-5);
        border-radius: var(--radius-lg);
        background: $surface1;

        summary {
            cursor: pointer;
            font-size: var(--font-size-md);
            font-weight: 600;
            color: $content1;
        }

        ul {
            margin: var(--space-4) 0;
            font-size: var(--font-size-sm);
            color: $content2;
            list-style: none;
        }
    }
}
</style>
