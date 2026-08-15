<template>
    <ManageShell
        :title="entity.plural"
        :description="entity.description"
    >
        <template
            v-if="canCreate"
            #actions
        >
            <common-button
                icon="material-symbols:add"
                :to="`/manage/${entity.key}/new`"
                type="primary"
            >New {{ entity.label.toLowerCase() }}</common-button>
        </template>

        <component
            :is="bespokeList ?? ManageList"
            v-model:page="list.page.value"
            v-model:search="list.search.value"
            :can-create="canCreate"
            :entity="entity"
            :list="list"
        />
    </ManageShell>
</template>

<script setup lang="ts">
import ManageList from '~/components/manage/ManageList.vue';
import ManageShell from '~/components/manage/ManageShell.vue';
import { resolveListComponent } from '~/components/manage/detailComponents';
import { useEntityList, useEntityPermissions } from '~/composables/entityList';
import { findManageEntity } from '~/utils/manageRegistry';

/**
 * One list page for every managed entity.
 *
 * `key` forces a fresh component per entity. Vue Router reuses a component
 * instance when only the params change, so without this, navigating
 * /manage/rooms → /manage/persons would keep the first entity's composable
 * state and quietly show the wrong list.
 */
definePageMeta({
    middleware: 'manage',
    key: (route) => route.path,
});

const route = useRoute();

// The middleware has already rejected an unknown section; this is the type
// narrowing, not a second guard.
const entity = findManageEntity(route.params.entity as string)!;

useHead({ title: entity.plural });

const { canCreate } = useEntityPermissions(entity);

const bespokeList = resolveListComponent(entity.listComponent);

const list = useEntityList(entity);

// Synchronous composable, single await at setup top level. SSR must resolve
// before first render or the page hydrates from an empty list.
await list.ready;
</script>
