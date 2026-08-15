<template>
    <div
        class="field"
        :class="{ 'field--invalid': !!error }"
    >
        <label
            class="field_label"
            :for="controlId"
        >
            {{ field.label }}
            <span
                v-if="field.required"
                class="field_required"
                aria-hidden="true"
            >*</span>
        </label>

        <!--
            Read-only renders as TEXT, not a disabled input. A disabled control
            reads as "unavailable right now"; static text reads as "this is the
            value, and it is not yours to change" — which is what a missing
            update permission actually means.
        -->
        <p
            v-if="readonly"
            :id="controlId"
            class="field_static"
        >{{ staticText }}</p>

        <textarea
            v-else-if="field.type === 'textarea'"
            :id="controlId"
            class="field_control field_control--area"
            :value="(model as string)"
            :placeholder="field.placeholder"
            rows="3"
            @input="emitValue(($event.target as HTMLTextAreaElement).value)"
        />

        <label
            v-else-if="field.type === 'boolean'"
            class="field_switch"
        >
            <input
                :id="controlId"
                type="checkbox"
                :checked="Boolean(model)"
                @change="emitValue(($event.target as HTMLInputElement).checked)"
            >
            <span>{{ model ? 'Yes' : 'No' }}</span>
        </label>

        <!--
            `:selected` on the options, not just `:value` on the select.

            `value` is a PROPERTY of a select element, not an attribute, so
            server rendering drops it entirely and the browser falls back to the
            first option. A term that has a time grid rendered as "— None —"
            until hydration corrected it — the page stating the opposite of the
            truth, briefly, with a hydration mismatch behind it. `selected` IS a
            real attribute and survives SSR.
        -->
        <select
            v-else-if="field.type === 'reference' || field.type === 'select'"
            :id="controlId"
            class="field_control"
            :value="(model as string) ?? ''"
            @change="emitValue(($event.target as HTMLSelectElement).value || null)"
        >
            <option
                v-if="field.type === 'reference' && field.reference?.nullable"
                :selected="model === null || model === undefined || model === ''"
                value=""
            >— None —</option>
            <option
                v-for="option in options"
                :key="String(option.value)"
                :selected="String(option.value) === String(model ?? '')"
                :value="option.value"
            >{{ option.label }}</option>
        </select>

        <!--
            Swatch plus text, not a bare colour picker. The stored value is a CSS
            colour string the schedule reads directly, so it has to stay
            readable and clearable — a native picker alone cannot express "no
            colour", and this field is nullable.
        -->
        <div
            v-else-if="field.type === 'color'"
            class="field_color"
        >
            <input
                type="color"
                :value="(model as string) || '#7c59bc'"
                :aria-label="`${field.label} picker`"
                @input="emitValue(($event.target as HTMLInputElement).value)"
            >
            <input
                :id="controlId"
                class="field_control"
                type="text"
                :value="(model as string) ?? ''"
                placeholder="#7c59bc"
                @input="emitValue(($event.target as HTMLInputElement).value)"
            >
            <common-button
                v-if="model"
                type="secondary"
                @click="emitValue(null)"
            >Clear</common-button>
        </div>

        <input
            v-else
            :id="controlId"
            class="field_control"
            :type="inputType"
            :value="(model as string | number) ?? ''"
            :placeholder="field.placeholder"
            :min="field.min"
            :max="field.max"
            @input="emitValue(($event.target as HTMLInputElement).value)"
        >

        <!--
            An empty reference select is a dead end unless it says why. Without
            this the user sees a select with nothing in it and no way to tell
            whether it failed to load or the entity genuinely has no rows.
        -->
        <p
            v-if="!readonly && field.type === 'reference' && !options.length"
            class="field_hint field_hint--warn"
        >{{ field.reference?.emptyHint ?? 'Nothing to choose from yet.' }}</p>

        <p
            v-if="error"
            class="field_error"
            role="alert"
        >{{ error }}</p>

        <p
            v-else-if="field.help"
            class="field_hint"
        >{{ field.help }}</p>
    </div>
</template>

<script setup lang="ts">
import type { EntityRow, FieldDef } from '~/utils/manageRegistry';

/**
 * One field of a management form.
 *
 * The dispatcher for the registry's field types. Every generic entity's form is
 * a list of these, which is what stops five entities growing five slightly
 * different text inputs.
 */
const props = defineProps<{
    field: FieldDef;
    /** Rows for a `reference` field's select, keyed by resource upstream. */
    referenceRows?: EntityRow[];
    error?: string;
    readonly?: boolean;
}>();

const model = defineModel<unknown>();

const controlId = useId();

const inputType = computed(() => {
    switch (props.field.type) {
        case 'email': return 'email';
        case 'number': return 'number';
        case 'date': return 'date';
        default: return 'text';
    }
});

const options = computed(() => {
    if (props.field.type === 'select') {
        return props.field.options ?? [];
    }

    const reference = props.field.reference;

    if (!reference) {
        return [];
    }

    return (props.referenceRows ?? []).map((row) => ({
        value: String(row.id),
        label: reference.label(row),
    }));
});

/** What the read-only view prints — resolved labels, not raw foreign keys. */
const staticText = computed(() => {
    if (props.field.type === 'boolean') {
        return model.value ? 'Yes' : 'No';
    }

    if (props.field.type === 'reference' || props.field.type === 'select') {
        const match = options.value.find((option) => String(option.value) === String(model.value));

        return match?.label ?? '—';
    }

    const value = model.value;

    return value === null || value === undefined || value === '' ? '—' : String(value);
});

function emitValue(value: unknown) {
    model.value = value;
}
</script>

<style scoped lang="scss">
.field {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);

    &_label {
        font-size: var(--font-size-sm);
        font-weight: 650;
        color: $content4;
    }

    &_required {
        margin-left: var(--space-1);
        color: $error500;
    }

    &_control {
        width: 100%;
        padding: 10px var(--space-5);
        border: 1px solid $surface4;
        border-radius: var(--radius-lg);

        font-family: inherit;
        font-size: var(--font-size-md);
        color: $content3;

        background: $surface0;

        transition: 0.15s;

        &--area {
            resize: vertical;
            min-height: 76px;
        }

        &:focus {
            border-color: $primary500;
            outline: none;
        }
    }

    &_color {
        display: flex;
        gap: var(--space-4);
        align-items: center;

        input[type='color'] {
            cursor: pointer;

            flex: none;

            width: 40px;
            height: 38px;
            padding: 2px;
            border: 1px solid $surface4;
            border-radius: var(--radius-lg);

            background: $surface0;
        }
    }

    &_switch {
        cursor: pointer;

        display: flex;
        gap: var(--space-4);
        align-items: center;

        font-size: var(--font-size-md);
        color: $content4;

        input {
            width: 16px;
            height: 16px;
            accent-color: $primary500;
        }
    }

    &_static {
        margin: 0;
        padding: 10px 0;
        font-size: var(--font-size-md);
        color: $content3;
    }

    &_hint {
        margin: 0;
        font-size: var(--font-size-sm);
        color: $content7;

        &--warn { color: $warning700; }
    }

    &_error {
        margin: 0;
        font-size: var(--font-size-sm);
        font-weight: 600;
        color: $error700;
    }

    &--invalid &_control { border-color: $error500; }
}
</style>
