<template>
    <nav
        class="header__menu"
        aria-label="Main"
    >
        <common-button
            v-for="entry in headerNav"
            :key="entry.id"
            :icon="entry.icon"
            :to="entry.to"
            :type="entry.active ? 'primary' : 'secondary'"
            @click="entry.run?.()"
        >
            {{ entry.label }}
        </common-button>

        <button
            class="header__menu_search"
            type="button"
            aria-label="Search — Ctrl K"
            @click="openPalette()"
        >
            <Icon
                name="material-symbols:search"
                aria-hidden="true"
            />
            <kbd>{{ shortcutLabel }}</kbd>
        </button>
    </nav>
</template>

<script setup lang="ts">
import { useHeaderNav } from '~/composables/navigation';

/**
 * Top-level navigation, driven by the permission-filtered nav registry.
 *
 * The previous version gated the one non-Home item on `store.me?.isAdmin` from
 * the template's WebUser stub, and rendered a hover-dropdown for children that
 * no entry ever had. Both are gone; entries come from `useHeaderNav()`.
 *
 * Active/inactive uses `primary`/`secondary` rather than the old
 * `secondary-875`, which CommonButton accepts but has no styles for — one of
 * the two callers of that unimplemented variant is now off it.
 */
const headerNav = useHeaderNav();

// Opened by writing the shared state rather than calling into the palette
// composable: that composable owns a keydown listener and an overlay claim, and
// instantiating a second copy here would register both twice.
const paletteOpen = useState('calendry.palette.open', () => false);

function openPalette() {
    paletteOpen.value = true;
}

// Cosmetic only; the handler accepts either modifier regardless of platform.
const shortcutLabel = ref('Ctrl K');

onMounted(() => {
    if (navigator.platform.toLowerCase().includes('mac')) {
        shortcutLabel.value = '⌘ K';
    }
});
</script>

<style scoped lang="scss">
.header__menu {
    display: flex;
    gap: var(--space-6);
    align-items: center;
    justify-content: center;

    &_search {
        cursor: pointer;

        display: flex;
        gap: var(--space-3);
        align-items: center;

        padding: var(--space-3) var(--space-5);
        border: 1px solid $surface4;
        border-radius: var(--radius-lg);

        color: $content7;

        background: $surface1;

        transition: 0.2s;

        svg {
            width: 16px;
            height: 16px;
        }

        kbd {
            font-family: inherit;
            font-size: var(--font-size-xs);
            color: $surface7;
        }

        @include hover() {
            &:hover {
                border-color: $surface5;
                color: $content4;
            }
        }

        &:focus-visible {
            outline: 2px solid $primary400;
            outline-offset: var(--space-1);
        }
        @include mobile() { display: none; }
    }
}
</style>
