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
            <div class="parent">
                <label
                    class="parent_label"
                    :for="controlId"
                >Parent group</label>

                <p
                    v-if="readonly"
                    :id="controlId"
                    class="parent_static"
                >{{ currentParentLabel }}</p>

                <select
                    v-else
                    :id="controlId"
                    class="parent_control"
                    :value="(draft.parentGroupId as string) ?? ''"
                    @change="draft.parentGroupId = ($event.target as HTMLSelectElement).value || null"
                >
                    <!-- `:selected` so the current parent survives SSR; see ManageField. -->
                    <option
                        :selected="!draft.parentGroupId"
                        value=""
                    >— Top level —</option>
                    <option
                        v-for="option in parentOptions"
                        :key="option.value"
                        :selected="option.value === String(draft.parentGroupId ?? '')"
                        :value="option.value"
                    >{{ option.label }}</option>
                </select>

                <p
                    v-if="form.fieldErrors.value.parentGroupId"
                    class="parent_error"
                    role="alert"
                >{{ form.fieldErrors.value.parentGroupId }}</p>

                <p
                    v-else
                    class="parent_hint"
                >
                    Nesting propagates booking conflicts both ways: a session for
                    this group blocks its parents and its children.
                    <template v-if="mode === 'edit' && excludedCount">
                        {{ excludedCount }} group{{ excludedCount === 1 ? '' : 's' }} nested beneath this
                        one {{ excludedCount === 1 ? 'is' : 'are' }} not listed — moving a group under its own
                        descendant would create a cycle.
                    </template>
                </p>
            </div>
        </template>
    </ManageEntityForm>
</template>

<script setup lang="ts">
import type { useEntityForm } from '~/composables/entityForm';
import type { EntityRow } from '~/utils/manageRegistry';
import ManageEntityForm from '~/components/manage/ManageEntityForm.vue';
import { descendantIds, indentedOptions } from '~/utils/groupTree';

/**
 * Group's detail: the shared form plus one control it cannot express.
 *
 * The parent selector's options depend on the row being edited — self and every
 * descendant have to be excluded — which no static registry entry can describe.
 * Everything else (save, delete, dirty state, server errors, the read-only
 * rendering) is the generic scaffold, unchanged.
 *
 * This narrows the CHOICE; it does not enforce the rule. The database trigger in
 * migration 20260812000100 rejects a cycle regardless, and that rejection
 * surfaces as a 409 through the normal error path.
 */
const props = defineProps<{
    form: ReturnType<typeof useEntityForm>;
    mode: 'create' | 'edit';
    canUpdate: boolean;
    canDelete: boolean;
}>();

defineEmits<{ save: []; reset: []; 'request-delete': [] }>();

const draft = defineModel<Record<string, unknown>>('draft', { required: true });

const controlId = useId();

/** All groups, fetched by the form composable because the field declares the reference. */
const allGroups = computed<EntityRow[]>(() => props.form.references.value.groups ?? []);

const excluded = computed(() => (props.mode === 'edit' && props.form.row.value
    ? descendantIds(allGroups.value, String(props.form.row.value.id))
    : new Set<string>()));

const excludedCount = computed(() => Math.max(0, excluded.value.size - 1));

const parentOptions = computed(() => indentedOptions(allGroups.value)
    .filter((option) => !excluded.value.has(option.value)));

const currentParentLabel = computed(() => {
    const id = draft.value.parentGroupId;

    if (!id) {
        return 'Top level';
    }

    return allGroups.value.find((row) => String(row.id) === String(id))?.name as string ?? '—';
});
</script>

<style scoped lang="scss">
.parent {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);

    &_label {
        font-size: var(--font-size-sm);
        font-weight: 650;
        color: $content4;
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
        margin: 0;
        padding: 10px 0;
        font-size: var(--font-size-md);
        color: $content3;
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
