<template>
    <component
        :is="getTag"
        class="button"
        :class="[
            `button--type-${ type }`,
            `button--size-${ size }`,
            `button--orientation-${ orientation }`,
            {
                'button--disabled': disabled,
                'button--icon': !!$slots.icon && !$slots.default,
            },
        ]"
        :style="{
            '--button-width': width ?? 'auto',
            '--icon-width': iconWidth,
            '--primary-color': primaryColor ? colorsList[primaryColor] : null,
            '--link-color': linkColor ? colorsList[linkColor] : null,
            '--hover-color': hoverColor ? colorsList[hoverColor] : null,
            '--focus-color': focusColor ? colorsList[focusColor] : null,
        }"
        :target="target"
        v-bind="getAttrs"
        @click="!disabled && $emit('click', $event)"
    >
        <div
            v-if="$slots.icon"
            class="button_icon"
        >
            <slot name="icon"/>
        </div>
        <span
            v-if="$slots.default"
            class="button_content"
        >
            <slot name="default"/>
        </span>
        <div
            v-if="$slots.append"
            class="button_append"
        >
            <slot name="append"/>
        </div>
    </component>
</template>

<script setup lang="ts">
// The label wrapper was <ui-text type="2b">, but no UiText component exists in
// this repo — it was never ported from the source template, so Vue could not
// resolve it and logged a warning for every button with a label. Styling is
// keyed on the .button_content class rather than the tag, so a span is a
// drop-in replacement. Restore a typography component here if one is added.
import type { PropType } from 'vue';
import type { RouteLocationRaw } from 'vue-router';
import { NuxtLink } from '#components';
import type { ColorsList } from '~/utils/styles';
import { colorsList } from '~/utils/styles';

const props = defineProps({
    tag: {
        type: String,
    },
    /**
     * The NATIVE button type — distinct from `type`, which is this component's
     * visual variant and was already taken. Defaults to 'button' so a button
     * inside a form does not submit it by accident; the auth forms pass
     * 'submit' deliberately.
     */
    nativeType: {
        type: String as PropType<'button' | 'submit' | 'reset'>,
        default: 'button',
    },
    width: {
        type: String,
    },
    iconWidth: {
        type: String,
        default: '16px',
    },
    type: {
        // NOTE: 'secondary-875' is accepted because ViewMenu.vue passes it, but
        // this component has no styles for it — it renders with an unstyled
        // button--type-secondary-875 class. Either add the SCSS or migrate that
        // caller to an implemented variant. ('transparent' was the other half
        // of this gap and now has styles.)
        type: String as PropType<'primary' | 'secondary' | 'secondary-black' | 'secondary-875' | 'destructive' | 'link' | 'transparent'>,
        default: 'primary',
    },
    orientation: {
        type: String as PropType<'vertical' | 'horizontal'>,
        default: 'horizontal',
    },
    disabled: {
        type: Boolean,
        default: false,
    },
    size: {
        type: String as PropType<'M' | 'S'>,
        default: 'M',
    },
    href: {
        type: String,
        default: null,
    },
    target: {
        type: String,
        default: null,
    },
    to: {
        type: [String, Object] as PropType<RouteLocationRaw | string | null | undefined>,
        default: null,
    },
    primaryColor: {
        type: String as PropType<ColorsList | null>,
        default: null,
    },
    linkColor: {
        type: String as PropType<ColorsList>,
        default: 'content5',
    },
    hoverColor: {
        type: String as PropType<ColorsList | null>,
        default: null,
    },
    focusColor: {
        type: String as PropType<ColorsList | null>,
        default: null,
    },
    textAlign: {
        type: String,
        default: 'center',
    },
});

defineEmits({
    click(e: MouseEvent) {
        return true;
    },
});

defineSlots<{
    default?(): any;
    icon?(): any;
    append?(): any;
}>();

/**
 * A real <button> by default, not a <div>.
 *
 * It rendered a div until now, which meant every action built on this component
 * — the whole schedule inspector, the solver control, the command palette — was
 * mouse-only: not reachable by Tab, not activated by Enter or Space, and not
 * announced as a button by a screen reader.
 *
 * `disabled` also gets a real button rather than a div, so assistive tech hears
 * "unavailable" instead of nothing.
 */
const getTag = computed(() => {
    if (props.disabled) return props.tag ?? 'button';
    if (props.href) return 'a';
    if (props.to) return NuxtLink;
    return props.tag ?? 'button';
});

/** True only when we actually render a native <button> element. */
const isNativeButton = computed(() => getTag.value === 'button');

const getAttrs = computed(() => {
    const attrs: Record<string, any> = {};
    if (props.to) {
        attrs.to = props.to;
        attrs.noPrefetch = true;
    }
    else if (props.href) attrs.href = props.href;

    if (isNativeButton.value) {
        /**
         * `type` is already this component's VISUAL variant, so the native one
         * needs its own prop. It defaults to "button" because a <button> inside
         * a <form> is a SUBMIT button unless told otherwise — switching the
         * default tag without this would have turned every button in every form
         * into an accidental submit.
         *
         * The two auth forms opt in with `native-type="submit"`, which is what
         * makes Enter-to-submit work there.
         */
        attrs.type = props.nativeType ?? 'button';
        attrs.disabled = props.disabled || undefined;
    }

    return attrs;
});
</script>

<style scoped lang="scss">
.button {
    --text-primary-color: currentColor;
    cursor: pointer;
    user-select: none;

    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: center;

    width: var(--button-width);
    min-height: 40px;
    padding: 8px 20px;
    border: none;
    border-radius: 4px;

    /* A native <button> inherits the UA's font, not the page's — so switching
       the root element from <div> would silently restyle every button. The
       styling is otherwise keyed on classes, which is what makes the tag change
       a drop-in. */
    font: inherit;
    color: $typographyPrimary;
    text-align: v-bind(textAlign);
    text-decoration: none;

    appearance: none;
    background: var(--primary-color, $primary500);
    outline: none;
    box-shadow: none;

    &_content {
        width: 100%;
        min-width: min-content;
    }

    @include pc {
        transition: 0.3s;

        &:hover {
            background: var(--hover-color, $primary400);
        }

        &:focus, &:active {
            background: var(--focus-color, $primary600);
        }
    }

    &--type-primary {
        color: $typographyPrimaryOrig;
    }

    &_icon {
        width: var(--icon-width);
        min-width: var(--icon-width);
    }

    &--type-secondary, &--type-destructive {
        background: var(--primary-color, transparent);
    }

    &--type-secondary, &--type-destructive {
        @include hover {
            &:hover {
                background: var(--hover-color, $whiteAlpha4);
            }

            &:active, &:focus {
                background: var(--focus-color, $primary500);
            }
        }
    }

    &--type-secondary-black {
        background: var(--primary-color, $surface6);

        @include hover {
            &:hover {
                background: var(--hover-color, $surface7);
            }

            &:active, &:focus {
                background: var(--focus-color, $content7);
            }
        }
    }

    /**
     * Chrome, not a surface. `transparent` is for controls that sit ON other
     * content — a chevron over a carousel, an affordance in a header — where a
     * filled rest state would read as a panel of its own.
     *
     * WHY IT CANNOT JUST REUSE `secondary`. That variant is
     * `var(--primary-color, transparent)`, so it is only transparent until a
     * caller sets --primary-color, and its :active/:focus jumps to a solid
     * $primary500. Both are wrong here: a chevron that flashes solid purple
     * when clicked reads as a primary action rather than a nudge. The wash
     * steps $whiteAlpha4 -> $whiteAlpha8 instead, and the rest state is
     * unconditional.
     *
     * Unlike `link` it keeps padding, radius and the 40px icon box, so it stays
     * a real hit target rather than collapsing to the glyph's own bounds.
     */
    &--type-transparent {
        background: transparent;

        /* The base declares backgrounds for rest AND hover/focus/active inside
           `@include pc`, so overriding only the unmediated declaration above
           would leave this variant solid purple on wide viewports — a bug that
           survives review because nobody resizes to 1366px to check a chevron.
           Every state is therefore restated, not just the rest one. */
        @include pc {
            &, &:hover, &:focus, &:active {
                background: transparent;
            }
        }

        /* MUST STAY AFTER THE RESET ABOVE. On a wide pointer device both blocks
           match and both are (0,2,0), so source order alone decides which wins.
           Moving this above the `@include pc` block does not fail loudly — it
           silently removes the hover feedback at >=1366px only. */
        @include hover {
            &:hover {
                background: var(--hover-color, $whiteAlpha4);
            }

            &:active, &:focus {
                background: var(--focus-color, $whiteAlpha8);
            }
        }

        /* `.button` clears the outline globally. On a filled variant the
           background change carries focus on its own; with no fill at rest
           there is nothing left to see, so keyboard focus would be invisible.
           Matches the ring used across the schedule components. */
        &:focus-visible {
            outline: 2px solid $primary400;
            outline-offset: -2px;
        }
    }

    &--type-destructive .button_content {
        color: $error600;
    }

    &--orientation-vertical {
        flex-direction: column;
        text-align: center;
    }

    &--icon {
        width: 40px;
        height: 40px;
        padding: 8px;
    }

    &--size-S {
        min-height: 32px;

        &.button--icon {
            width: 32px;
            height: 32px;
        }
    }

    &--type-link {
        justify-content: flex-start;

        height: auto;
        min-height: auto;
        padding: 0;
        border-radius: 0;

        font-size: 10px;
        color: var(--link-color);
        text-align: left;
        text-decoration: underline;

        background: transparent !important;

        &.button--icon {
            width: auto;
        }

        @include hover {
            &:hover {
                color: var(--hover-color);
            }

            &:focus, &:active {
                color: var(--focus-color);
            }
        }
    }

    &--disabled {
        opacity: 0.24;

        &.button--type-primary {
            background: $whiteAlpha2;
        }

        &, &:deep(svg) {
            pointer-events: none;
            cursor: default;
        }
    }
}
</style>