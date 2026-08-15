<template>
    <ManageShell
        title="Manage"
        description="The entities the timetable is built from."
    >
        <div
            v-if="sections.length"
            class="cards"
        >
            <NuxtLink
                v-for="section in sections"
                :key="section.id"
                class="cards_card"
                :to="section.to!"
            >
                <Icon
                    class="cards_icon"
                    :name="section.icon"
                    aria-hidden="true"
                />
                <span class="cards_label">{{ section.label }}</span>
                <span class="cards_hint">{{ section.description }}</span>
            </NuxtLink>
        </div>

        <!--
            Reachable state, not a dead end: a person with a session but no
            management read permission lands here, and is told which fact is
            true rather than shown an empty grid that could equally mean the
            page failed to load.
        -->
        <p
            v-else
            class="empty"
        >
            You do not have read access to any management section in this
            institution. An administrator can grant it through your access role.
        </p>
    </ManageShell>
</template>

<script setup lang="ts">
import ManageShell from '~/components/manage/ManageShell.vue';
import { useManageSections } from '~/composables/navigation';

useHead({ title: 'Manage' });

const sections = useManageSections();
</script>

<style scoped lang="scss">
.cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: var(--space-5);

    &_card {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);

        padding: var(--space-6);
        border: 1px solid transparent;
        border-radius: var(--radius-xl);

        text-decoration: none;

        background: $surface1;

        transition: 0.15s;

        @include hover() {
            &:hover {
                border-color: $primary400;
                background: $surface2;
            }
        }

        &:focus-visible {
            outline: 2px solid $primary400;
            outline-offset: var(--space-1);
        }
    }

    &_icon {
        width: 22px;
        height: 22px;
        margin-bottom: var(--space-3);
        color: $primary600;
    }

    &_label {
        font-size: var(--font-size-md);
        font-weight: 680;
        color: $content1;
    }

    &_hint {
        font-size: var(--font-size-sm);
        line-height: 1.45;
        color: $content7;
    }
}

.empty {
    max-width: 52ch;
    margin: 0;
    padding: var(--space-8) var(--space-7);
    border-radius: var(--radius-xl);

    font-size: var(--font-size-md);
    line-height: 1.55;
    color: $content7;

    background: $surface1;
}
</style>
