<template>
    <section
        v-if="relations.defs.length"
        class="relations"
    >
        <!--
            Relations need an id to hang off, so on the create page there is
            nothing to edit yet. Saying so beats rendering controls whose every
            change would 404.
        -->
        <p
            v-if="mode === 'create'"
            class="relations_pending"
        >
            <Icon
                name="material-symbols:info-outline"
                aria-hidden="true"
            />
            Save this {{ entity.label.toLowerCase() }} first — then you can assign
            {{ relations.defs.map((def) => def.label.toLowerCase()).join(', ') }}.
        </p>

        <ManageRelationPicker
            v-for="def in relations.defs"
            v-else
            :key="def.key"
            :busy="!!relations.busy.value[def.key]"
            :def="def"
            :error="relations.errors.value[def.key]"
            :extra-options="relations.extraOptionsFor(def)"
            :options="relations.optionsFor(def)"
            :readonly="!canUpdate"
            :rows="relations.drafts.value[def.key] ?? []"
            :saved="!!relations.saved.value[def.key]"
            @add="relations.add(def, $event)"
            @remove="relations.remove(def, $event)"
            @set-extra="relations.setExtra(def, $event.value, $event.key, $event.extra)"
        />
    </section>
</template>

<script setup lang="ts">
import type { useEntityRelations } from '~/composables/entityRelations';
import type { ManageEntity } from '~/utils/manageRegistry';
import ManageRelationPicker from '~/components/manage/ManageRelationPicker.vue';

/**
 * Every relation an entity declares, rendered below its form.
 *
 * Registry-driven, which is why Offering — the hub that references a Term, a
 * Kind and a Role and holds three many-to-many sets — needs no bespoke detail
 * component at all. Its complexity is a longer `relations` array, not different
 * code.
 */
defineProps<{
    entity: ManageEntity;
    relations: ReturnType<typeof useEntityRelations>;
    mode: 'create' | 'edit';
    canUpdate: boolean;
}>();
</script>

<style scoped lang="scss">
.relations {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    max-width: 620px;

    &_pending {
        display: flex;
        gap: var(--space-4);
        align-items: flex-start;

        margin: 0;
        padding: var(--space-5) var(--space-6);
        border-radius: var(--radius-xl);

        font-size: var(--font-size-sm);
        line-height: 1.5;
        color: $content7;

        background: $surface1;

        svg {
            flex: none;
            width: 16px;
            height: 16px;
        }
    }
}
</style>
