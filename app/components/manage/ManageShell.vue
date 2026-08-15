<template>
    <div class="shell">
        <nav
            class="shell_nav"
            aria-label="Management sections"
        >
            <NuxtLink
                class="shell_nav-link"
                :class="{ 'shell_nav-link--active': $route.path === '/manage' }"
                to="/manage"
            >
                <Icon
                    name="material-symbols:grid-view-outline"
                    aria-hidden="true"
                />
                <span>Overview</span>
            </NuxtLink>

            <NuxtLink
                v-for="section in sections"
                :key="section.id"
                class="shell_nav-link"
                :class="{ 'shell_nav-link--active': section.active }"
                :to="section.to!"
            >
                <Icon
                    :name="section.icon"
                    aria-hidden="true"
                />
                <span>{{ section.label }}</span>
            </NuxtLink>
        </nav>

        <section class="shell_body">
            <header class="shell_head">
                <div class="shell_head-text">
                    <NuxtLink
                        v-if="backTo"
                        class="shell_back"
                        :to="backTo"
                    >
                        <Icon
                            name="material-symbols:arrow-back"
                            aria-hidden="true"
                        />
                        {{ backLabel }}
                    </NuxtLink>
                    <h1>{{ title }}</h1>
                    <p v-if="description">{{ description }}</p>
                </div>

                <div
                    v-if="$slots.actions"
                    class="shell_head-actions"
                >
                    <slot name="actions"/>
                </div>
            </header>

            <slot/>
        </section>
    </div>
</template>

<script setup lang="ts">
import { useManageSections } from '~/composables/navigation';

/**
 * The /manage area's frame: a persistent section list beside the content.
 *
 * A component rather than a Nuxt layout on purpose. A layout REPLACES the
 * default one, so a `manage` layout would have to restate the app header, the
 * toast container and the command palette — three things that would then exist
 * in two places and drift. The sidebar is derived from a registry with no
 * fetching, so re-rendering it per navigation costs nothing.
 *
 * The section list is `useManageSections()`, already permission-filtered: a
 * caller without `room.read` has no Rooms link here, in the header, or in Ctrl+K,
 * because all three read that one function.
 */
defineProps<{
    title: string;
    description?: string;
    /** Renders a back link. Set on detail pages, absent on lists. */
    backTo?: string;
    backLabel?: string;
}>();

defineSlots<{ default: () => unknown; actions?: () => unknown }>();

const sections = useManageSections();
</script>

<style scoped lang="scss">
.shell {
    display: flex;
    gap: var(--space-7);
    align-items: flex-start;
    padding: var(--space-7) var(--space-7) var(--space-8);

    @include mobile() {
        flex-direction: column;
        gap: var(--space-6);
        padding: var(--space-5);
    }

    &_nav {
        position: sticky;
        top: var(--space-7);

        display: flex;
        flex: none;
        flex-direction: column;
        gap: var(--space-1);

        width: 210px;
        padding: var(--space-4);
        border-radius: var(--radius-xl);

        background: $surface1;

        @include mobile() {
            position: static;
            overflow-x: auto;
            flex-direction: row;
            width: 100%;

            span { white-space: nowrap; }
        }

        &-link {
            display: flex;
            gap: var(--space-4);
            align-items: center;

            padding: var(--space-4) var(--space-5);
            border-radius: var(--radius-lg);

            font-size: var(--font-size-md);
            font-weight: 600;
            color: $content5;
            text-decoration: none;

            transition: 0.15s;

            svg {
                flex: none;
                width: 17px;
                height: 17px;
                color: $surface7;
            }
            @include hover() {
                &:hover {
                    color: $content2;
                    background: $surface2;
                }
            }

            &:focus-visible {
                outline: 2px solid $primary400;
                outline-offset: var(--space-1);
            }

            &--active {
                color: $surface0;
                background: $primary500;

                svg { color: $surface0; }

                @include hover() {
                    &:hover {
                        color: $surface0;
                        background: $primary500;
                    }
                }
            }
        }
    }

    &_body {
        display: flex;
        flex: 1;
        flex-direction: column;
        gap: var(--space-6);

        min-width: 0;
    }

    &_head {
        display: flex;
        gap: var(--space-6);
        align-items: flex-end;
        justify-content: space-between;

        @include mobile() {
            flex-direction: column;
            align-items: stretch;
        }

        &-text {
            display: flex;
            flex-direction: column;
            gap: var(--space-2);
        }

        &-actions {
            display: flex;
            flex: none;
            gap: var(--space-4);
        }

        h1 {
            margin: 0;
            font-size: var(--font-size-xl);
            font-weight: 680;
            color: $content1;
        }

        p {
            margin: 0;
            font-size: var(--font-size-md);
            color: $content7;
        }
    }

    &_back {
        display: flex;
        gap: var(--space-2);
        align-items: center;

        margin-bottom: var(--space-2);

        font-size: var(--font-size-sm);
        font-weight: 600;
        color: $content7;
        text-decoration: none;

        svg {
            width: 14px;
            height: 14px;
        }
        @include hover() {
            &:hover { color: $primary600; }
        }
    }
}
</style>
