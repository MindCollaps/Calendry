<template>
    <div class="blank">
        <h2>{{ title }}</h2>
        <p><slot/></p>
    </div>
</template>

<script setup lang="ts">
/**
 * The schedule's "nothing to draw" states.
 *
 * Named rather than left inline because the two cases mean genuinely different
 * things and both are *expected*: a freshly provisioned tenant has no TimeGrid
 * (provisioning deliberately creates none, since TAXONOMY.md §2 forbids
 * assuming a grid shape) and no Term. Neither is an error, and neither should
 * be reachable by the same code path as a failed fetch — an empty state that
 * can also mean "the request broke" hides bugs.
 */
defineProps<{ title: string }>();

defineSlots<{ default: () => unknown }>();
</script>

<style scoped lang="scss">
.blank {
    max-width: 52ch;
    padding: 40px var(--space-7);
    border-radius: var(--radius-xl);
    background: $surface1;

    h2 {
        margin: 0 0 var(--space-4);
        font-size: var(--font-size-lg);
        font-weight: 650;
        color: $content2;
    }

    p {
        margin: 0;
        font-size: 13.5px;
        line-height: 1.55;
        color: $content7;
    }
}
</style>
