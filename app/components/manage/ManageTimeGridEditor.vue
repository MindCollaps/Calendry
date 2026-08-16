<template>
    <ManageEntityForm
        v-model:draft="draft"
        :can-delete="canDelete"
        :can-update="canUpdate"
        :form="form"
        :mode="mode"
        @request-delete="$emit('request-delete')"
        @reset="$emit('reset')"
        @save="$emit('save')"
    >
        <template #fields="{ readonly }">
            <div class="grid-editor">
                <ManageField
                    v-for="field in scalarFields"
                    :key="field.key"
                    v-model="draft[field.key]"
                    :error="form.fieldErrors.value[field.key]"
                    :field="field"
                    :readonly="readonly"
                />

                <ManageWeekdayPicker
                    v-model="activeDaysModel"
                    :error="form.fieldErrors.value.activeDays
                        ?? (activeDays.length ? undefined : 'A grid must schedule at least one day.')"
                    label="Teaching days"
                    :readonly="readonly"
                />

                <label class="grid-editor_default">
                    <input
                        :checked="Boolean(draft.isDefault)"
                        :disabled="readonly"
                        type="checkbox"
                        @change="draft.isDefault = ($event.target as HTMLInputElement).checked"
                    >
                    <span>
                        <strong>Default grid</strong>
                        <em>
                            Used by any term that names no grid of its own. At most one
                            per institution — the database enforces it, so promoting a
                            second is refused rather than silently accepted.
                        </em>
                    </span>
                </label>

                <!--
                    The preview is computed with `blockTime()` — the SAME helper
                    the schedule renders from. Reimplementing the arithmetic here
                    would let the preview and the timetable disagree, and the
                    preview is precisely the thing meant to make that impossible.
                -->
                <section class="grid-editor_preview">
                    <h3>
                        A day on this grid
                        <span v-if="activeDays.length">· {{ activeDays.map(weekdayShort).join(' ') }}</span>
                    </h3>

                    <ol
                        v-if="previewBlocks.length"
                        class="grid-editor_blocks"
                    >
                        <li
                            v-for="block in previewBlocks"
                            :key="block.index"
                        >
                            <span class="grid-editor_block-n">{{ block.index + 1 }}</span>
                            <span class="grid-editor_block-time">{{ block.start }}–{{ block.end }}</span>
                        </li>
                    </ol>

                    <p
                        v-else
                        class="grid-editor_hint"
                    >Set a block length and a count to see the day.</p>

                    <p
                        v-if="previewBlocks.length"
                        class="grid-editor_summary"
                    >
                        Teaching ends at <strong>{{ previewBlocks[previewBlocks.length - 1]?.end }}</strong>,
                        {{ previewBlocks.length }} blocks over
                        {{ activeDays.length }} day{{ activeDays.length === 1 ? '' : 's' }} a week.
                        <span
                            v-if="rollsPastMidnight"
                            class="grid-editor_warn"
                        >The last block runs past midnight — check the start hour and block length.</span>
                    </p>
                </section>
            </div>
        </template>
    </ManageEntityForm>
</template>

<script setup lang="ts">
import type { useEntityForm } from '~/composables/entityForm';
import type { TimeGrid } from '~/composables/schedule';
import ManageEntityForm from '~/components/manage/ManageEntityForm.vue';
import ManageField from '~/components/manage/ManageField.vue';
import ManageWeekdayPicker from '~/components/manage/ManageWeekdayPicker.vue';
import { blockTime, weekdayShort } from '~/composables/schedule';

/**
 * The TimeGrid editor.
 *
 * Bespoke for two reasons the generic form genuinely cannot cover: `activeDays`
 * is an ISO-weekday array rather than a scalar, and these numbers are
 * unverifiable in isolation — "45 minutes × 8 blocks, 15 minute breaks" only
 * becomes checkable when you can see it ends at 16:00.
 *
 * This is the most consequential configuration in the system: every session
 * placement resolves against it (TAXONOMY.md §2), so being able to see the
 * consequence before saving is the whole point.
 */
const props = defineProps<{
    form: ReturnType<typeof useEntityForm>;
    mode: 'create' | 'edit';
    canUpdate: boolean;
    canDelete: boolean;
}>();

defineEmits<{ save: []; reset: []; 'request-delete': [] }>();

const draft = defineModel<Record<string, unknown>>('draft', { required: true });

// Everything except the day toggles and the default flag, which get their own
// controls below.
const scalarFields = computed(() => props.form.fields.filter(
    (field) => !['activeDays', 'isDefault'].includes(field.key),
));

const activeDays = computed<number[]>(() => {
    const value = draft.value.activeDays;

    return Array.isArray(value) ? [...value].map(Number).sort((a, b) => a - b) : [];
});

/**
 * Bridges the draft (a plain record) to the picker's model. The picker owns the
 * toggle logic and the sorting; this only decides where the value lives.
 */
const activeDaysModel = computed({
    get: () => activeDays.value,
    set: (days: number[]) => { draft.value.activeDays = days; },
});

/** A TimeGrid-shaped view of the draft, so the real helper can read it. */
const previewGrid = computed<TimeGrid>(() => ({
    id: 'preview',
    name: String(draft.value.name ?? ''),
    blockLengthMinutes: Number(draft.value.blockLengthMinutes ?? 0),
    blocksPerDay: Number(draft.value.blocksPerDay ?? 0),
    activeDays: activeDays.value,
    startHour: Number(draft.value.startHour ?? 0),
    startMinute: Number(draft.value.startMinute ?? 0),
    breakMinutes: Number(draft.value.breakMinutes ?? 0),
    isDefault: Boolean(draft.value.isDefault),
}));

const previewBlocks = computed(() => {
    const grid = previewGrid.value;

    if (grid.blockLengthMinutes < 1 || grid.blocksPerDay < 1) {
        return [];
    }

    // Capped so a mistyped 9999 renders a warning-worthy preview rather than
    // locking the browser building ten thousand list items.
    const count = Math.min(grid.blocksPerDay, 40);

    return Array.from({ length: count }, (_, index) => ({ index, ...blockTime(grid, index) }));
});

/**
 * `blockTime` wraps the clock with `% 24`, so a grid running past midnight
 * prints plausible-looking early-morning times instead of anything obviously
 * wrong. Recomputing the raw minutes is what makes it visible.
 */
const rollsPastMidnight = computed(() => {
    const grid = previewGrid.value;

    if (!previewBlocks.value.length) {
        return false;
    }

    const stride = grid.blockLengthMinutes + grid.breakMinutes;
    const endMinutes = grid.startHour * 60 + grid.startMinute
        + (previewBlocks.value.length - 1) * stride + grid.blockLengthMinutes;

    return endMinutes > 24 * 60;
});
</script>

<style scoped lang="scss">
.grid-editor {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);



    &_default {
        cursor: pointer;

        display: flex;
        gap: var(--space-4);
        align-items: flex-start;

        padding: var(--space-5);
        border-radius: var(--radius-lg);

        background: $surface2;

        input {
            margin-top: 2px;
            accent-color: $primary500;
        }

        span {
            display: flex;
            flex-direction: column;
            gap: var(--space-1);
        }

        strong {
            font-size: var(--font-size-md);
            font-weight: 650;
            color: $content3;
        }

        em {
            font-size: var(--font-size-sm);
            font-style: normal;
            line-height: 1.5;
            color: $content7;
        }
    }

    &_preview {
        padding: var(--space-5) var(--space-6);
        border-radius: var(--radius-lg);
        background: $surface2;

        h3 {
            margin: 0 0 var(--space-4);

            font-size: var(--font-size-xs);
            font-weight: 650;
            color: $surface7;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }
    }

    &_blocks {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
        gap: var(--space-2);

        margin: 0;
        padding: 0;

        list-style: none;

        li {
            display: flex;
            gap: var(--space-4);
            align-items: baseline;

            padding: var(--space-3) var(--space-4);
            border-radius: var(--radius-sm);

            background: $surface0;
        }
    }

    &_block-n {
        min-width: 1.4em;
        font-size: var(--font-size-xs);
        font-variant-numeric: tabular-nums;
        color: $surface7;
    }

    &_block-time {
        // Tabular figures so the times form a column the eye can scan.
        font-size: var(--font-size-sm);
        font-variant-numeric: tabular-nums;
        color: $content4;
    }

    &_summary {
        margin: var(--space-4) 0 0;
        font-size: var(--font-size-sm);
        line-height: 1.5;
        color: $content7;
    }

    &_warn {
        display: block;
        margin-top: var(--space-2);
        font-weight: 650;
        color: $warning700;
    }

    &_hint {
        margin: 0;
        font-size: var(--font-size-sm);
        color: $content7;
    }

    &_error {
        flex-basis: 100%;

        margin: var(--space-2) 0 0;

        font-size: var(--font-size-sm);
        font-weight: 600;
        color: $error700;
    }
}
</style>
