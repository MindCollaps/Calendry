<template>
    <div class="picker">
        <header class="picker_head">
            <h2>{{ def.label }}</h2>
            <span
                v-if="busy"
                class="picker_state"
            >Saving…</span>
            <span
                v-else-if="saved"
                class="picker_state picker_state--ok"
            >
                <Icon
                    name="material-symbols:check-small"
                    aria-hidden="true"
                />
                Saved
            </span>
        </header>

        <p
            v-if="def.help"
            class="picker_help"
        >{{ def.help }}</p>

        <p
            v-if="error"
            class="picker_error"
            role="alert"
        >{{ error }}</p>

        <ul
            v-if="rows.length"
            class="picker_rows"
        >
            <li
                v-for="row in rows"
                :key="String(row[def.valueKey])"
                class="picker_row"
            >
                <span class="picker_row-name">{{ labelFor(String(row[def.valueKey])) }}</span>

                <label
                    v-if="def.extraReference"
                    class="picker_row-extra"
                >
                    <span class="sr-only">{{ def.label }} role</span>
                    <select
                        :disabled="readonly || busy"
                        :value="(row[def.extraReference.key] as string) ?? ''"
                        @change="$emit('set-extra', {
                            value: String(row[def.valueKey]),
                            key: def.extraReference!.key,
                            extra: ($event.target as HTMLSelectElement).value || null,
                        })"
                    >
                        <!-- `:selected` so the assigned role survives SSR; see ManageField. -->
                        <option
                            :selected="!row[def.extraReference.key]"
                            value=""
                        >{{ def.extraReference.placeholder }}</option>
                        <option
                            v-for="option in extraOptions"
                            :key="String(option.id)"
                            :selected="String(option.id) === String(row[def.extraReference.key] ?? '')"
                            :value="String(option.id)"
                        >{{ def.extraReference.label(option) }}</option>
                    </select>
                </label>

                <label
                    v-if="def.quantity"
                    class="picker_row-extra"
                >
                    <span class="picker_row-qty-label">{{ def.quantity.label }}</span>
                    <input
                        class="picker_row-qty"
                        :disabled="readonly || busy"
                        min="1"
                        type="number"
                        :value="(row[def.quantity.key] as number) ?? ''"
                        @change="$emit('set-extra', {
                            value: String(row[def.valueKey]),
                            key: def.quantity!.key,
                            extra: ($event.target as HTMLInputElement).value
                                ? Number(($event.target as HTMLInputElement).value)
                                : null,
                        })"
                    >
                </label>

                <button
                    v-if="!readonly"
                    class="picker_remove"
                    :disabled="busy"
                    type="button"
                    :aria-label="`Remove ${labelFor(String(row[def.valueKey]))}`"
                    @click="$emit('remove', String(row[def.valueKey]))"
                >
                    <Icon
                        name="material-symbols:close"
                        aria-hidden="true"
                    />
                </button>
            </li>
        </ul>

        <p
            v-else
            class="picker_empty"
        >None assigned.</p>

        <label
            v-if="!readonly"
            class="picker_add"
        >
            <span class="sr-only">Add to {{ def.label }}</span>
            <select
                :disabled="busy || !available.length"
                :value="''"
                @change="onAdd($event)"
            >
                <option value="">{{ available.length ? `Add ${def.label.toLowerCase()}…` : 'Nothing left to add' }}</option>
                <option
                    v-for="option in available"
                    :key="option.value"
                    :value="option.value"
                >{{ option.label }}</option>
            </select>
        </label>

        <!--
            An empty option list has two very different causes — the referenced
            entity has no rows at all, or everything is already assigned — and a
            select that is merely empty cannot tell them apart.
        -->
        <p
            v-if="!readonly && !options.length"
            class="picker_hint picker_hint--warn"
        >{{ def.emptyHint ?? 'Nothing to choose from yet.' }}</p>
    </div>
</template>

<script setup lang="ts">
import type { EntityRow, RelationDef } from '~/utils/manageRegistry';
import type { RelationRow } from '~/composables/entityRelations';
import { indentedOptions } from '~/utils/groupTree';

/**
 * One relation, edited as a set.
 *
 * Every change is persisted immediately by the parent composable rather than
 * being staged for a Save button — see `useEntityRelations` for why. The
 * Saving/Saved state next to the heading is what makes that visible instead of
 * magical.
 */
const props = defineProps<{
    def: RelationDef;
    rows: RelationRow[];
    options: EntityRow[];
    extraOptions: EntityRow[];
    busy?: boolean;
    saved?: boolean;
    error?: string;
    readonly?: boolean;
}>();

const emit = defineEmits<{
    add: [value: string];
    remove: [value: string];
    'set-extra': [payload: { value: string; key: string; extra: unknown }];
}>();

/** Nesting stays visible in the flat select, so picking a cohort is not a guess. */
const allOptions = computed(() => (props.def.indentTree
    ? indentedOptions(props.options)
    : props.options.map((row) => ({ value: String(row.id), label: props.def.optionLabel(row) }))));

const available = computed(() => {
    const taken = new Set(props.rows.map((row) => String(row[props.def.valueKey])));

    return allOptions.value.filter((option) => !taken.has(option.value));
});

function labelFor(value: string): string {
    const row = props.options.find((option) => String(option.id) === value);

    // Falling back to the raw id rather than an empty cell: an unresolvable
    // reference is something to see, not to hide.
    return row ? props.def.optionLabel(row) : value;
}

/**
 * The select is an action, not a value: choosing an option adds a row, then the
 * control resets to its placeholder. Leaving the choice selected would show the
 * last thing added as though it were the field's current value, which is not
 * what a set membership control means.
 */
function onAdd(event: Event) {
    const select = event.target as HTMLSelectElement;
    const value = select.value;

    select.value = '';

    if (value) {
        emit('add', value);
    }
}
</script>

<style scoped lang="scss">
.picker {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);

    padding: var(--space-6);
    border-radius: var(--radius-xl);

    background: $surface1;

    &_head {
        display: flex;
        gap: var(--space-4);
        align-items: baseline;

        h2 {
            margin: 0;
            font-size: var(--font-size-md);
            font-weight: 680;
            color: $content2;
        }
    }

    &_state {
        font-size: var(--font-size-xs);
        color: $content7;

        &--ok {
            display: inline-flex;
            gap: 2px;
            align-items: center;
            color: $success700;

            svg {
                width: 14px;
                height: 14px;
            }
        }
    }

    &_help {
        margin: 0;
        font-size: var(--font-size-sm);
        line-height: 1.5;
        color: $content7;
    }

    &_error {
        margin: 0;
        padding: var(--space-3) var(--space-5);
        border-radius: var(--radius-lg);

        font-size: var(--font-size-sm);
        font-weight: 600;
        color: $error700;

        background: vartorgba('error500', 0.14);
    }

    &_rows {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);

        margin: 0;
        padding: 0;

        list-style: none;
    }

    &_row {
        display: flex;
        gap: var(--space-4);
        align-items: center;

        padding: var(--space-3) var(--space-4);
        border-radius: var(--radius-lg);

        background: $surface0;

        &-name {
            flex: 1;
            min-width: 0;
            font-size: var(--font-size-md);
            color: $content3;
        }

        &-extra {
            display: flex;
            flex: none;
            gap: var(--space-2);
            align-items: center;

            select,
            input {
                padding: var(--space-2) var(--space-3);
                border: 1px solid $surface4;
                border-radius: var(--radius-sm);

                font-family: inherit;
                font-size: var(--font-size-sm);
                color: $content4;

                background: $surface1;
            }
        }

        &-qty {
            width: 72px;
        }

        &-qty-label {
            font-size: var(--font-size-xs);
            color: $content7;
        }
    }

    &_remove {
        cursor: pointer;

        display: flex;
        flex: none;
        align-items: center;
        justify-content: center;

        width: 24px;
        height: 24px;
        border: 0;
        border-radius: var(--radius-sm);

        color: $surface7;

        background: none;

        svg {
            width: 16px;
            height: 16px;
        }

        @include hover() {
            &:hover {
                color: $error700;
                background: vartorgba('error500', 0.14);
            }
        }
    }

    &_empty {
        margin: 0;
        font-size: var(--font-size-sm);
        font-style: italic;
        color: $content7;
    }

    &_add select {
        width: 100%;
        padding: var(--space-3) var(--space-5);
        border: 1px solid $surface4;
        border-radius: var(--radius-lg);

        font-family: inherit;
        font-size: var(--font-size-md);
        color: $content4;

        background: $surface0;
    }

    &_hint {
        margin: 0;
        font-size: var(--font-size-sm);
        color: $content7;

        &--warn { color: $warning700; }
    }
}

.sr-only {
    position: absolute;

    overflow: hidden;

    width: 1px;
    height: 1px;

    clip-path: inset(50%);
}
</style>
