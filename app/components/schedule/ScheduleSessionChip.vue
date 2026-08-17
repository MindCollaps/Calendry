<template>
    <button
        type="button"
        class="chip"
        :class="[
            `chip--${severity}`,
            { 'chip--selected': selected, 'chip--dimmed': dimmed,
            'chip--targetable': targetable, 'chip--locked': session.isLocked },
        ]"
        :style="{ '--kind-color': session.kind?.color ?? $colors.primary500 }"
        :aria-pressed="selected"
        @click="$emit('select')"
    >
        <span class="chip_title">{{ session.offering?.title ?? 'Untitled session' }}</span>

        <span class="chip_meta">
            <Icon
                v-if="session.isLocked"
                name="material-symbols:lock"
                class="chip_icon"
                aria-hidden="true"
            />
            <span
                v-if="session.isLocked"
                class="chip_sr"
            >Locked. </span>

            <Icon
                v-if="severity !== 'none'"
                :name="severity === 'hard'
                    ? 'material-symbols:error'
                    : 'material-symbols:warning-outline'"
                class="chip_icon chip_icon--violation"
                aria-hidden="true"
            />
            <span
                v-if="severity !== 'none'"
                class="chip_sr"
            >{{ violations.length }} {{ severity }} violation{{ violations.length === 1 ? '' : 's' }}. </span>

            <span
                class="chip_dot"
                aria-hidden="true"
            />
            <span class="chip_kind">{{ session.kind?.name }}</span>
        </span>
    </button>
</template>

<script setup lang="ts">
import type { ScheduleSession, Violation } from '~/composables/schedule';
import { colorsList } from '~/utils/styles';

const props = defineProps<{
    session: ScheduleSession;
    violations: Violation[];
    selected: boolean;
    dimmed: boolean;
    /** In swap mode every OTHER chip is a pick target. */
    targetable?: boolean;
}>();

defineEmits<{ select: [] }>();

const $colors = colorsList;

/**
 * Severity drives shape and icon as well as colour — a violation must not be
 * signalled by hue alone.
 */
const severity = computed<'none' | 'soft' | 'hard'>(() => {
    if (props.violations.some((v) => v.severity === 'HARD')) return 'hard';
    if (props.violations.length > 0) return 'soft';

    return 'none';
});
</script>

<style scoped lang="scss">
.chip {
    cursor: pointer;

    display: flex;
    flex: 1 1 0;
    flex-direction: column;
    gap: 2px;
    justify-content: space-between;

    overflow: hidden;

    min-width: 0;
    padding: 6px 8px;
    border: 0;
    border-radius: 6px;

    text-align: left;

    background: $surface3;

    transition:
        background 140ms cubic-bezier(0.16, 1, 0.3, 1),
        transform 140ms cubic-bezier(0.16, 1, 0.3, 1),
        opacity 140ms ease-out;

    @include hover() {
        &:hover {
            background: $surface4;
            transform: translateY(-1px);
        }
    }

    &:focus-visible {
        outline: 2px solid $primary400;
        outline-offset: 1px;
    }

    &_title {
        overflow: hidden;

        font-size: 12.5px;
        font-weight: 600;
        line-height: 1.25;
        color: $content4;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    &_meta {
        display: flex;
        gap: 4px;
        align-items: center;

        font-size: 11px;
        color: $surface7;
    }

    // Kind reads as a dot beside its name rather than a colored edge stripe:
    // the stripe is the category's most recognizable tell, and at grid density
    // a dot survives a 44px row where a 3px edge just adds noise.
    &_dot {
        flex: none;
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--kind-color);
    }

    &_kind {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    &_icon {
        flex: none;
        width: 13px;
        height: 13px;

        &--violation { color: $warning400; }
    }

    // Screen-reader-only: the icons above are decorative, so state is also
    // announced as text.
    &_sr {
        position: absolute;
        overflow: hidden;
        clip-path: inset(50%);
        width: 1px;
        height: 1px;
    }

    // Tint layered OVER an opaque base rather than replacing it: a translucent
    // background let the grid cell — and any chip behind it — show through.
    &--hard {
        background: linear-gradient(rgba(169, 45, 70, 0.22), rgba(169, 45, 70, 0.22)), $surface3;

        .chip_icon--violation { color: $error300; }

        @include hover() {
            &:hover { background: linear-gradient(rgba(169, 45, 70, 0.3), rgba(169, 45, 70, 0.3)), $surface4; }
        }
    }

    &--soft {
        background: linear-gradient(rgba(169, 125, 45, 0.18), rgba(169, 125, 45, 0.18)), $surface3;

        @include hover() {
            &:hover { background: linear-gradient(rgba(169, 125, 45, 0.26), rgba(169, 125, 45, 0.26)), $surface4; }
        }
    }

    &--selected {
        outline: 2px solid $primary400;
        outline-offset: 1px;
        background: $surface5;
    }

    &--targetable {
        outline: 2px dashed $content5;
        outline-offset: 1px;
    }

    &--dimmed {
        opacity: 0.35;
        pointer-events: none;
    }
}
</style>
