<template>
    <ManageShell
        :back-label="entity.plural"
        :back-to="`/manage/${entity.key}`"
        :description="`Create a new ${entity.label.toLowerCase()} in this institution.`"
        :title="`New ${entity.label.toLowerCase()}`"
    >
        <component
            :is="bespoke ?? ManageEntityForm"
            v-model:draft="form.draft.value"
            :can-delete="false"
            :can-update="true"
            :entity="entity"
            :form="form"
            mode="create"
            @reset="form.reset()"
            @save="submit"
        />

        <ManageRelationsPanel
            :can-update="true"
            :entity="entity"
            mode="create"
            :relations="relations"
        />
    </ManageShell>
</template>

<script setup lang="ts">
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

useHead({ title: `New ${entity.label}` });

const { canCreate } = useEntityPermissions(entity);

// Read permission got us here; create is a separate grant. Redirecting rather
// than rendering a form whose save is guaranteed to 403.
if (!canCreate.value) {
    await navigateTo(`/manage/${entity.key}`);
}

const bespoke = resolveDetailComponent(entity.detailComponent);

const form = useEntityForm(entity, 'create');

// No id yet, so this fetches nothing and only supplies the "save first" notice.
// Instantiated anyway so the panel's shape is identical on both pages.
const relations = useEntityRelations(entity, undefined);

await Promise.all([form.ready, relations.ready]);

async function submit() {
    const id = await form.save();

    if (id) {
        await navigateTo(`/manage/${entity.key}/${id}`);
    }
}
</script>
