<template>
    <form
        class="entity-form"
        @submit.prevent="$emit('save')"
    >
        <p
            v-if="readonlyReason"
            class="entity-form_banner"
        >
            <Icon
                name="material-symbols:lock-outline"
                aria-hidden="true"
            />
            {{ readonlyReason }}
        </p>

        <p
            v-if="form.formError.value"
            class="entity-form_error"
            role="alert"
        >{{ form.formError.value }}</p>

        <div class="entity-form_fields">
            <!--
                Bespoke fields go here, above the generic ones, because they are
                always the defining part of the record (a group's parent, a
                grid's shape) and burying them under boilerplate inverts that.
            -->
            <slot
                name="fields"
                :readonly="readonly"
            />

            <ManageField
                v-for="field in genericFields"
                :key="field.key"
                v-model="draft[field.key]"
                :error="form.fieldErrors.value[field.key]"
                :field="field"
                :readonly="readonly"
                :reference-rows="field.reference ? form.references.value[field.reference.resource] : undefined"
            />
        </div>

        <footer
            v-if="!readonly"
            class="entity-form_actions"
        >
            <common-button
                :disabled="form.busy.value || !form.isDirty.value"
                type="primary"
                @click="$emit('save')"
            >{{ form.busy.value ? 'Saving…' : saveLabel }}</common-button>

            <common-button
                v-if="form.isDirty.value"
                :disabled="form.busy.value"
                type="secondary"
                @click="$emit('reset')"
            >Discard changes</common-button>

            <span class="entity-form_spacer"/>

            <common-button
                v-if="canDelete && mode === 'edit' && !form.isSystemRow.value"
                :disabled="form.busy.value"
                type="destructive"
                @click="$emit('request-delete')"
            >Delete</common-button>
        </footer>

        <p
            v-if="mode === 'edit' && form.isSystemRow.value"
            class="entity-form_hint"
        >
            Created by tenant provisioning and required by the system — it can be
            renamed but not deleted.
        </p>
    </form>
</template>

<script setup lang="ts">
import type { useEntityForm } from '~/composables/entityForm';
import ManageField from '~/components/manage/ManageField.vue';

/**
 * The generic form body: registry fields in, one row edited out.
 *
 * The form composable is created by the PAGE, not here, because the page holds
 * the single top-level `await` on its data. This component renders what it is
 * given and emits intent.
 */
const props = defineProps<{
    /** Read-only view of the form's state. The draft is a model, not a prop. */
    form: ReturnType<typeof useEntityForm>;
    mode: 'create' | 'edit';
    canUpdate: boolean;
    canDelete: boolean;
}>();

defineEmits<{ save: []; reset: []; 'request-delete': [] }>();

defineSlots<{ fields?: (props: { readonly: boolean }) => unknown }>();

/**
 * Fields this component renders. `custom` ones are part of the record — draft,
 * dirty tracking, payload, error mapping — but their control is supplied by the
 * bespoke detail component through the `fields` slot.
 */
const genericFields = computed(() => props.form.fields.filter((field) => !field.custom));

/**
 * The draft is the one thing this component writes, so it travels as a model.
 * Reaching into `form.draft` through the prop would work and would also make
 * the page unable to see, at the call site, that its state is being edited here.
 */
const draft = defineModel<Record<string, unknown>>('draft', { required: true });

/**
 * Two independent reasons a row cannot be edited, and they are not the same
 * fact, so they do not share a sentence: one is about this caller, the other is
 * about who owns the row.
 */
const readonly = computed(() => !props.canUpdate || props.form.isForeignOwned.value);

const readonlyReason = computed(() => {
    if (props.form.isForeignOwned.value) {
        return 'Shared by a federation. Visible to this tenant, editable only by its owner.';
    }

    if (!props.canUpdate) {
        return 'You have read access to this section. Editing needs an additional permission.';
    }

    return '';
});

const saveLabel = computed(() => (props.mode === 'create' ? 'Create' : 'Save changes'));
</script>

<style scoped lang="scss">
.entity-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);

    max-width: 620px;
    padding: var(--space-7);
    border-radius: var(--radius-xl);

    background: $surface1;

    &_fields {
        display: flex;
        flex-direction: column;
        gap: var(--space-6);
    }

    &_banner {
        display: flex;
        gap: var(--space-4);
        align-items: center;

        margin: 0;
        padding: 10px var(--space-5);
        border-radius: var(--radius-lg);

        font-size: var(--font-size-sm);
        color: $content5;

        background: $surface3;

        svg {
            flex: none;
            width: 16px;
            height: 16px;
        }
    }

    &_error {
        margin: 0;
        padding: 10px var(--space-5);
        border-radius: var(--radius-lg);

        font-size: var(--font-size-md);
        font-weight: 600;
        color: $error700;

        background: vartorgba('error500', 0.14);
    }

    &_actions {
        display: flex;
        gap: var(--space-4);
        align-items: center;

        padding-top: var(--space-5);
        border-top: 1px solid $surface3;
    }

    &_spacer { flex: 1; }

    &_hint {
        margin: 0;
        font-size: var(--font-size-sm);
        color: $content7;
    }
}
</style>
