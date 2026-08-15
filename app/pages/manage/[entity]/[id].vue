<template>
    <ManageShell
        :back-label="entity.plural"
        :back-to="`/manage/${entity.key}`"
        :title="title"
    >
        <component
            :is="bespoke ?? ManageEntityForm"
            v-model:draft="form.draft.value"
            :can-delete="canDelete"
            :can-update="canUpdate"
            :entity="entity"
            :form="form"
            mode="edit"
            @request-delete="confirming = true"
            @reset="form.reset()"
            @save="submit"
        />

        <ManageRelationsPanel
            :can-update="canUpdate"
            :entity="entity"
            mode="edit"
            :relations="relations"
        />

        <ManageDeleteDialog
            :busy="form.busy.value"
            :entity-label="entity.label"
            :error="deleteError"
            :open="confirming"
            :subject="title"
            @cancel="confirming = false"
            @confirm="confirmDelete"
        />
    </ManageShell>
</template>

<script setup lang="ts">
import ManageDeleteDialog from '~/components/manage/ManageDeleteDialog.vue';
import ManageEntityForm from '~/components/manage/ManageEntityForm.vue';
import ManageRelationsPanel from '~/components/manage/ManageRelationsPanel.vue';
import ManageShell from '~/components/manage/ManageShell.vue';
import { resolveDetailComponent } from '~/components/manage/detailComponents';
import { useEntityForm } from '~/composables/entityForm';
import { useEntityRelations } from '~/composables/entityRelations';
import { useEntityPermissions } from '~/composables/entityList';
import { findManageEntity } from '~/utils/manageRegistry';

definePageMeta({
    middleware: 'manage',
    key: (route) => route.path,
});

const route = useRoute();
const entity = findManageEntity(route.params.entity as string)!;
const id = route.params.id as string;

const { canUpdate, canDelete } = useEntityPermissions(entity);

const bespoke = resolveDetailComponent(entity.detailComponent);

const form = useEntityForm(entity, 'edit', id);
const relations = useEntityRelations(entity, id);

// Both composables are synchronous; this is the page's single await point, and
// both resolve before the first render. Awaiting them in parallel rather than in
// sequence keeps SSR to one request wave.
await Promise.all([form.ready, relations.ready]);

const title = computed(() => (form.row.value ? entity.title(form.row.value) : entity.label));

useHead({ title: () => title.value });

const confirming = ref(false);
const deleteError = ref('');

async function submit() {
    await form.save();
}

async function confirmDelete() {
    deleteError.value = '';

    const removed = await form.remove();

    if (removed) {
        await navigateTo(`/manage/${entity.key}`);

        return;
    }

    // The dialog stays open holding the reason. A 409 here is the database
    // refusing to orphan real references — that is information the user needs,
    // not a failure to swallow.
    deleteError.value = form.formError.value || 'Could not delete.';
    confirming.value = true;
}
</script>
