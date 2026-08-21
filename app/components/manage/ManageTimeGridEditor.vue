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
                    Named breaks. The default gap above still applies everywhere
                    a row does not name, so a grid with no rows behaves exactly
                    as it did before this existed.
                -->
                <section class="grid-editor_breaks">
                    <h3>Named breaks</h3>
                    <p class="grid-editor_hint">
                        A longer gap at one position — lunch, an afternoon break. Everywhere
                        else keeps the default gap above.
                    </p>

                    <ul
                        v-if="breaks.length"
                        class="grid-editor_break-list"
                    >
                        <li
                            v-for="(brk, i) in breaks"
                            :key="i"
                        >
                            <label>
                                <span>After block</span>
                                <select
                                    :disabled="readonly"
                                    @change="updateBreak(i, { afterBlockIndex: Number(($event.target as HTMLSelectElement).value) })"
                                >
                                    <!-- :selected, not :value on the select — a
                                         select's value is a property, so SSR
                                         drops it and the browser falls back to
                                         the first option. -->
                                    <option
                                        v-for="n in blockChoices"
                                        :key="n"
                                        :selected="brk.afterBlockIndex === n"
                                        :value="n"
                                    >{{ n + 1 }}</option>
                                </select>
                            </label>

                            <label>
                                <span>Minutes</span>
                                <input
                                    :disabled="readonly"
                                    min="1"
                                    type="number"
                                    :value="brk.durationMinutes"
                                    @input="updateBreak(i, { durationMinutes: Number(($event.target as HTMLInputElement).value) })"
                                >
                            </label>

                            <label class="grid-editor_break-label">
                                <span>Label</span>
                                <input
                                    :disabled="readonly"
                                    type="text"
                                    :value="brk.label"
                                    @input="updateBreak(i, { label: ($event.target as HTMLInputElement).value })"
                                >
                            </label>

                            <label>
                                <span>Days</span>
                                <!-- Bounded to the grid's own teaching days: a
                                     break on a day nothing is scheduled is
                                     configuration that can never take effect. -->
                                <select
                                    :disabled="readonly"
                                    @change="updateBreak(i, { dayOfWeek: ($event.target as HTMLSelectElement).value === ''
                                        ? null : Number(($event.target as HTMLSelectElement).value) })"
                                >
                                    <option
                                        :selected="brk.dayOfWeek === null"
                                        value=""
                                    >All days</option>
                                    <option
                                        v-for="iso in activeDays"
                                        :key="iso"
                                        :selected="brk.dayOfWeek === iso"
                                        :value="iso"
                                    >{{ weekdayName(iso) }} only</option>
                                </select>
                            </label>

                            <button
                                :disabled="readonly"
                                title="Remove this break"
                                type="button"
                                @click="removeBreak(i)"
                            >✕</button>
                        </li>
                    </ul>

                    <p
                        v-else
                        class="grid-editor_hint"
                    >No named breaks — every gap is the default.</p>

                    <CommonButton
                        v-if="!readonly"
                        type="secondary"
                        @click="addBreak"
                    >Add a break</CommonButton>
                </section>

                <!--
                    The preview is computed with `blockTime()` — the SAME helper
                    the schedule renders from. Reimplementing the arithmetic here
                    would let the preview and the timetable disagree, and the
                    preview is precisely the thing meant to make that impossible.
                -->
                <section class="grid-editor_preview">
                    <h3>
                        A day on this grid
                        <!-- One canonical day is no longer enough: a day-specific
                             break makes Friday genuinely different, so the day
                             being previewed is chosen rather than assumed. -->
                        <select
                            v-if="activeDays.length"
                            class="grid-editor_preview-day"
                            @change="previewDay = Number(($event.target as HTMLSelectElement).value)"
                        >
                            <option
                                v-for="iso in activeDays"
                                :key="iso"
                                :selected="previewDay === iso"
                                :value="iso"
                            >{{ weekdayName(iso) }}</option>
                        </select>
                    </h3>

                    <ol
                        v-if="previewBlocks.length"
                        class="grid-editor_blocks"
                    >
                        <template
                            v-for="block in previewBlocks"
                            :key="block.index"
                        >
                            <li>
                                <span class="grid-editor_block-n">{{ block.index + 1 }}</span>
                                <span class="grid-editor_block-time">{{ block.start }}–{{ block.end }}</span>
                            </li>
                            <li
                                v-if="block.breakAfter"
                                class="grid-editor_break-row"
                            >
                                <span class="grid-editor_block-n">·</span>
                                <span class="grid-editor_block-time">
                                    {{ block.breakAfter.label }} · {{ block.breakAfter.durationMinutes }} min
                                </span>
                            </li>
                        </template>
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
import CommonButton from '~/components/common/CommonButton.vue';
import type { TimeGridBreak } from '#shared/timeGrid';
import { blockBoundaries } from '#shared/timeGrid';
import { blockTime, weekdayName } from '~/composables/schedule';

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
    breaks: breaks.value,
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
    const day = previewDay.value;

    return Array.from({ length: count }, (_, index) => ({
        index,
        ...blockTime(grid, index, day),
        // The gap that FOLLOWS this block, if a named one applies on the day
        // being previewed. Never after the last block — nothing follows it.
        breakAfter: index === grid.blocksPerDay - 1
            ? null
            : breaks.value.find((b) => b.afterBlockIndex === index
                && (b.dayOfWeek === day || b.dayOfWeek === null))
                ?? null,
    }));
});

/**
 * Break overrides live in the draft under `breaks`, like any other field, so
 * they take part in dirty tracking and the single Save. They are PERSISTED as a
 * PUT-set sub-resource, which the shell handles — see RELATIONS.
 */
const breaks = computed<TimeGridBreak[]>(() => {
    const value = draft.value.breaks;

    return Array.isArray(value) ? (value as TimeGridBreak[]) : [];
});

/** Which day the preview renders. Defaults to the grid's first teaching day. */
const previewDay = ref<number>(0);

watchEffect(() => {
    if (!activeDays.value.includes(previewDay.value)) {
        previewDay.value = activeDays.value[0] ?? 1;
    }
});

/** Positions a break may follow: every block except the last. */
const blockChoices = computed(() => {
    const count = Number(draft.value.blocksPerDay ?? 0);

    return Array.from({ length: Math.max(0, Math.min(count, 40) - 1) }, (_, i) => i);
});

function writeBreaks(next: TimeGridBreak[]) {
    draft.value.breaks = next;
}

function addBreak() {
    // Defaults to the middle of the day and "all days" — the lunch case, which
    // is what someone reaching for this button almost always wants.
    const middle = Math.max(0, Math.floor(Number(draft.value.blocksPerDay ?? 2) / 2) - 1);

    writeBreaks([...breaks.value, {
        afterBlockIndex: blockChoices.value.includes(middle) ? middle : (blockChoices.value[0] ?? 0),
        durationMinutes: 45,
        label: 'Lunch',
        dayOfWeek: null,
    }]);
}

function updateBreak(index: number, patch: Partial<TimeGridBreak>) {
    writeBreaks(breaks.value.map((b, i) => (i === index ? { ...b, ...patch } : b)));
}

function removeBreak(index: number) {
    writeBreaks(breaks.value.filter((_, i) => i !== index));
}

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

    // The shared walk's trailing entry IS when teaching ends, so this no longer
    // re-derives it from a stride — which was the same arithmetic blockTime()
    // owns, written a second time, in the one component whose whole purpose is
    // to show the two agreeing.
    const bounds = blockBoundaries(grid);

    return (bounds[bounds.length - 1] ?? 0) > 24 * 60;
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
