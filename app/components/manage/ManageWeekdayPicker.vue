<template>
    <fieldset class="weekdays">
        <legend v-if="label">{{ label }}</legend>

        <!--
            Seven toggles labelled from `weekdayName()`, the same ISO-1..7 helper
            the schedule grid uses. Not a Mon–Fri row with a "weekend" extra:
            TAXONOMY.md §2 forbids assuming which days an institution teaches on,
            and a control that makes Saturday awkward is that assumption wearing
            a different hat.
        -->
        <label
            v-for="iso in ISO_WEEKDAYS"
            :key="iso"
            class="weekdays_day"
            :class="{ 'weekdays_day--on': selected.includes(iso) }"
        >
            <input
                :checked="selected.includes(iso)"
                :disabled="readonly"
                type="checkbox"
                @change="toggle(iso)"
            >
            <span>{{ weekdayName(iso) }}</span>
        </label>

        <p
            v-if="error"
            class="weekdays_error"
            role="alert"
        >{{ error }}</p>

        <p
            v-else-if="help"
            class="weekdays_help"
        >{{ help }}</p>
    </fieldset>
</template>

<script setup lang="ts">
import { weekdayName } from '~/composables/schedule';

/**
 * ISO-weekday multi-select, shared by the TimeGrid editor (which days does this
 * institution teach on?) and the constraint builder (which days should the
 * solver avoid?).
 *
 * Extracted rather than duplicated: the two had identical semantics and the
 * second copy would have been the one to drift — most likely by quietly
 * defaulting to Mon–Fri or to [6,7], which is exactly the hardcoded assumption
 * TAXONOMY.md §7 calls out by name.
 */
defineProps<{
    label?: string;
    help?: string;
    error?: string;
    readonly?: boolean;
}>();

const selected = defineModel<number[]>({ required: true });

/** 1 = Monday … 7 = Sunday. */
const ISO_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

function toggle(iso: number) {
    const next = new Set(selected.value ?? []);

    if (next.has(iso)) next.delete(iso);
    else next.add(iso);

    // Sorted so the stored value is stable regardless of click order — an
    // unsorted array makes dirty-tracking and the input hash jitter.
    selected.value = [...next].sort((a, b) => a - b);
}
</script>

<style scoped lang="scss">
.weekdays {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);

    margin: 0;
    padding: 0;
    border: 0;

    legend {
        padding: 0 0 var(--space-3);
        font-size: var(--font-size-sm);
        font-weight: 650;
        color: $content4;
    }

    &_day {
        cursor: pointer;

        display: flex;
        gap: var(--space-3);
        align-items: center;

        padding: var(--space-3) var(--space-5);
        border: 1px solid $surface4;
        border-radius: var(--radius-lg);

        font-size: var(--font-size-sm);
        font-weight: 600;
        color: $content5;

        transition: 0.12s;

        input { accent-color: $primary500; }

        &--on {
            border-color: $primary500;
            color: $primary700;
            background: vartorgba('primary500', 0.12);
        }
    }

    &_error {
        flex-basis: 100%;

        margin: var(--space-2) 0 0;

        font-size: var(--font-size-sm);
        font-weight: 600;
        color: $error700;
    }

    &_help {
        flex-basis: 100%;

        margin: var(--space-2) 0 0;

        font-size: var(--font-size-sm);
        line-height: 1.5;
        color: $content7;
    }
}
</style>
