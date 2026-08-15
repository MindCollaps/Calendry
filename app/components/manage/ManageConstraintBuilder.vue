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
            <div class="builder">
                <!--
                    A fixed catalogue, not a free-form expression editor.
                    TAXONOMY.md §2: "predefined constraint types + parameters,
                    not a free-form expression DSL". The list comes from
                    shared/constraintTypes.ts, which the evaluator reads too — a
                    rule this offered but nothing evaluated would be a constraint
                    that is enabled, reports nothing, and means nothing.
                -->
                <div class="builder_field">
                    <label
                        class="builder_label"
                        :for="typeId"
                    >Rule<span class="builder_req">*</span></label>

                    <p
                        v-if="readonly || mode === 'edit'"
                        :id="typeId"
                        class="builder_static"
                    >
                        {{ selectedType?.label ?? draft.type ?? '—' }}
                        <em v-if="mode === 'edit' && !readonly">Cannot be changed — create a new constraint instead.</em>
                    </p>

                    <select
                        v-else
                        :id="typeId"
                        class="builder_control"
                        :value="(draft.type as string) ?? ''"
                        @change="selectType(($event.target as HTMLSelectElement).value)"
                    >
                        <option
                            disabled
                            value=""
                        >Choose a rule…</option>
                        <!-- `:selected` for the same SSR reason as everywhere else. -->
                        <optgroup label="Checked as you edit">
                            <option
                                v-for="type in appTypes"
                                :key="type.key"
                                :selected="type.key === draft.type"
                                :value="type.key"
                            >{{ type.label }}</option>
                        </optgroup>
                        <optgroup label="Solver — not yet enforced">
                            <option
                                v-for="type in solverTypes"
                                :key="type.key"
                                :selected="type.key === draft.type"
                                :value="type.key"
                            >{{ type.label }}</option>
                        </optgroup>
                    </select>

                    <p
                        v-if="form.fieldErrors.value.type"
                        class="builder_error"
                        role="alert"
                    >{{ form.fieldErrors.value.type }}</p>
                    <p
                        v-else-if="selectedType"
                        class="builder_hint"
                    >{{ selectedType.description }}</p>
                </div>

                <!--
                    The honest part. Ten of the thirteen types belong to a solver
                    service that does not exist in this repo. They are storable
                    and configurable — the tenant's policy is real data — but
                    nothing evaluates them yet, and a UI that let you enable
                    "cap online share at 30%" without saying so would be
                    promising enforcement it does not do.
                -->
                <p
                    v-if="selectedType?.evaluator === 'solver'"
                    class="builder_deferred"
                >
                    <Icon
                        name="material-symbols:hourglass-empty"
                        aria-hidden="true"
                    />
                    <span>
                        <strong>Enforced by the solver — not yet implemented.</strong>
                        This rule is saved and will be handed to the solver service when it
                        exists. Until then it produces no warnings, and manual edits are not
                        checked against it.
                    </span>
                </p>

                <div
                    v-if="selectedType"
                    class="builder_field"
                >
                    <span class="builder_label">Severity</span>

                    <p
                        v-if="selectedType.severity"
                        class="builder_static"
                    >
                        <span
                            class="builder_sev"
                            :class="`builder_sev--${selectedType.severity.toLowerCase()}`"
                        >{{ selectedType.severity }}</span>
                        <em>{{ selectedType.severity === 'HARD'
                            ? 'A breach is a defect. Surfaced as a violation; manual edits are warned, never blocked.'
                            : 'A preference. The solver weighs it against the others rather than refusing.' }}</em>
                    </p>

                    <select
                        v-else
                        class="builder_control"
                        :disabled="readonly"
                        :value="(draft.severity as string) ?? 'HARD'"
                        @change="setSeverity(($event.target as HTMLSelectElement).value)"
                    >
                        <!-- `:selected` so the stored severity survives SSR; see ManageField. -->
                        <option
                            :selected="draft.severity !== 'SOFT'"
                            value="HARD"
                        >Hard — a breach is a defect</option>
                        <option
                            :selected="draft.severity === 'SOFT'"
                            value="SOFT"
                        >Soft — a weighted preference</option>
                    </select>
                </div>

                <!--
                    Weight exists only for SOFT. The database CHECK enforces the
                    pairing (HARD ⇒ null, SOFT ⇒ set), so rendering it
                    unconditionally would let the form compose a row the server
                    rejects with a constraint-violation message nobody can act on.
                -->
                <ManageField
                    v-if="draft.severity === 'SOFT'"
                    v-model="draft.weight"
                    :error="form.fieldErrors.value.weight"
                    :field="weightField"
                    :readonly="readonly"
                />

                <fieldset
                    v-if="selectedType?.params.length"
                    class="builder_params"
                >
                    <legend>Parameters</legend>

                    <ManageField
                        v-for="param in selectedType.params"
                        :key="param.key"
                        :field="paramField(param)"
                        :model-value="paramValue(param.key)"
                        :readonly="readonly"
                        @update:model-value="setParam(param.key, $event)"
                    />
                </fieldset>

                <p
                    v-else-if="selectedType"
                    class="builder_hint"
                >This rule takes no parameters.</p>
            </div>
        </template>
    </ManageEntityForm>
</template>

<script setup lang="ts">
import type { useEntityForm } from '~/composables/entityForm';
import type { ConstraintParamDef } from '#shared/constraintTypes';
import type { FieldDef } from '~/utils/manageRegistry';
import ManageEntityForm from '~/components/manage/ManageEntityForm.vue';
import ManageField from '~/components/manage/ManageField.vue';
import { CONSTRAINT_TYPES, findConstraintType } from '#shared/constraintTypes';

/**
 * The constraint rule builder.
 *
 * Bespoke because these four fields CONSTRAIN EACH OTHER: the chosen type fixes
 * the severity and dictates which parameters exist, and `weight` is meaningful
 * only when severity is SOFT — a pairing the database enforces with a CHECK.
 * Rendered as four independent generic controls they would happily compose
 * states the server rejects.
 *
 * Scope: the thirteen types already in the system. Not a dynamic rule builder —
 * see the file comment in shared/constraintTypes.ts.
 */
const props = defineProps<{
    form: ReturnType<typeof useEntityForm>;
    mode: 'create' | 'edit';
    canUpdate: boolean;
    canDelete: boolean;
}>();

defineEmits<{ save: []; reset: []; 'request-delete': [] }>();

const draft = defineModel<Record<string, unknown>>('draft', { required: true });

const typeId = useId();

const appTypes = CONSTRAINT_TYPES.filter((type) => type.evaluator === 'app');
const solverTypes = CONSTRAINT_TYPES.filter((type) => type.evaluator === 'solver');

const selectedType = computed(() => findConstraintType(draft.value.type as string | undefined));

const weightField: FieldDef = {
    key: 'weight',
    label: 'Penalty weight',
    type: 'number',
    min: 1,
    help: 'How heavily the solver weighs a breach against competing preferences. Higher matters more.',
};

/**
 * Choosing a type resets everything downstream of it: a severity and parameters
 * left over from the previous choice would be silently wrong rather than
 * visibly empty.
 */
function selectType(key: string) {
    const type = findConstraintType(key);

    draft.value.type = key;
    draft.value.severity = type?.severity ?? 'HARD';
    draft.value.weight = draft.value.severity === 'SOFT' ? (draft.value.weight ?? 1) : null;
    draft.value.params = Object.fromEntries(
        (type?.params ?? [])
            .filter((param) => param.default !== undefined)
            .map((param) => [param.key, param.default]),
    );

    // Naming the constraint after the rule is almost always what was meant, and
    // it is still editable. Only filled when blank, so it never overwrites a
    // name someone chose.
    if (!draft.value.name && type) {
        draft.value.name = type.label;
    }
}

function setSeverity(value: string) {
    draft.value.severity = value;
    draft.value.weight = value === 'SOFT' ? (draft.value.weight ?? 1) : null;
}

const params = computed<Record<string, unknown>>(() => {
    const value = draft.value.params;

    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
});

function paramValue(key: string): unknown {
    return params.value[key] ?? null;
}

function setParam(key: string, value: unknown) {
    // Replaced rather than mutated in place, so the draft's dirty comparison
    // (a JSON snapshot) actually notices.
    draft.value.params = { ...params.value, [key]: value };
}

/** A catalogue parameter, expressed as a field the generic renderer understands. */
function paramField(param: ConstraintParamDef): FieldDef {
    return {
        key: param.key,
        label: param.type === 'percent' ? `${param.label} (%)` : param.label,
        type: param.type === 'percent' ? 'number' : param.type,
        help: param.help,
        required: param.required,
        min: param.min,
        max: param.max,
    };
}

// Creating from scratch: seed a sensible severity so the weight control's
// visibility is decided rather than undefined.
onMounted(() => {
    if (props.mode === 'create' && !draft.value.severity) {
        draft.value.severity = 'HARD';
    }
});
</script>

<style scoped lang="scss">
.builder {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);

    &_field {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
    }

    &_label {
        font-size: var(--font-size-sm);
        font-weight: 650;
        color: $content4;
    }

    &_req {
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

        &:focus {
            border-color: $primary500;
            outline: none;
        }
    }

    &_static {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);

        margin: 0;
        padding: var(--space-2) 0;

        font-size: var(--font-size-md);
        color: $content3;

        em {
            font-size: var(--font-size-sm);
            font-style: normal;
            line-height: 1.5;
            color: $content7;
        }
    }

    &_sev {
        align-self: flex-start;

        padding: var(--space-1) var(--space-4);
        border-radius: var(--radius-sm);

        font-size: var(--font-size-xs);
        font-weight: 700;
        letter-spacing: 0.05em;

        &--hard {
            color: $error700;
            background: vartorgba('error500', 0.16);
        }

        &--soft {
            color: $warning700;
            background: vartorgba('warning500', 0.2);
        }
    }

    &_deferred {
        display: flex;
        gap: var(--space-4);
        align-items: flex-start;

        margin: 0;
        padding: var(--space-5);
        border-radius: var(--radius-lg);

        font-size: var(--font-size-sm);
        line-height: 1.55;
        color: $content5;

        background: $surface3;

        svg {
            flex: none;
            width: 17px;
            height: 17px;
            margin-top: 1px;
        }

        strong {
            display: block;
            color: $content2;
        }
    }

    &_params {
        display: flex;
        flex-direction: column;
        gap: var(--space-5);

        margin: 0;
        padding: var(--space-5);
        border: 1px solid $surface4;
        border-radius: var(--radius-lg);

        legend {
            padding: 0 var(--space-3);
            font-size: var(--font-size-sm);
            font-weight: 650;
            color: $content4;
        }
    }

    &_hint {
        margin: 0;
        font-size: var(--font-size-sm);
        line-height: 1.5;
        color: $content7;
    }

    &_error {
        margin: 0;
        font-size: var(--font-size-sm);
        font-weight: 600;
        color: $error700;
    }
}
</style>
