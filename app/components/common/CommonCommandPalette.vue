<template>
    <Teleport to="body">
        <div
            v-if="palette.open.value"
            class="palette"
            @mousedown.self="palette.closePalette()"
        >
            <div
                class="palette_dialog"
                role="dialog"
                aria-modal="true"
                aria-label="Command palette"
                @keydown.tab="trapFocus"
            >
                <div class="palette_search">
                    <Icon
                        class="palette_search-icon"
                        name="material-symbols:search"
                        aria-hidden="true"
                    />
                    <input
                        ref="inputRef"
                        v-model="palette.query.value"
                        class="palette_input"
                        type="text"
                        placeholder="Go to…"
                        autocomplete="off"
                        spellcheck="false"
                        role="combobox"
                        aria-expanded="true"
                        aria-controls="palette-results"
                        :aria-activedescendant="activeId"
                    >
                    <kbd class="palette_kbd">Esc</kbd>
                </div>

                <ul
                    v-if="palette.results.value.length"
                    id="palette-results"
                    class="palette_results"
                    role="listbox"
                >
                    <template
                        v-for="(result, index) in palette.results.value"
                        :key="result.entry.id"
                    >
                        <li
                            v-if="result.startsSection"
                            class="palette_section"
                            role="presentation"
                        >{{ result.sectionLabel }}</li>

                        <li
                            :id="`palette-result-${index}`"
                            class="palette_result"
                            :class="{ 'palette_result--active': index === palette.highlighted.value }"
                            role="option"
                            :aria-selected="index === palette.highlighted.value"
                            @click="palette.activate(index)"
                            @mousemove="palette.highlighted.value = index"
                        >
                            <Icon
                                class="palette_result-icon"
                                :name="result.entry.icon"
                                aria-hidden="true"
                            />
                            <span class="palette_result-body">
                                <span class="palette_result-label">
                                    <span
                                        v-for="(run, runIndex) in result.runs"
                                        :key="runIndex"
                                        :class="{ 'palette_hit': run.match }"
                                    >{{ run.text }}</span>
                                </span>
                                <span
                                    v-if="result.entry.description"
                                    class="palette_result-hint"
                                >{{ result.entry.description }}</span>
                            </span>
                            <Icon
                                v-if="result.entry.run"
                                class="palette_result-kind"
                                name="material-symbols:bolt-outline"
                                aria-label="Action"
                            />
                        </li>
                    </template>
                </ul>

                <p
                    v-else
                    class="palette_empty"
                >No match for “{{ palette.query.value }}”.</p>

                <footer class="palette_footer">
                    <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
                    <span><kbd>↵</kbd> open</span>
                    <span><kbd>Esc</kbd> close</span>
                </footer>
            </div>
        </div>
    </Teleport>
</template>

<script setup lang="ts">
import { useCommandPalette } from '~/composables/commandPalette';

/**
 * Ctrl+K / ⌘K navigation.
 *
 * Mounted once, in the default layout, so it is reachable from every page
 * including the schedule. It renders nothing until opened.
 *
 * PERMISSIONS: this component never filters. Its entire input is
 * `useNavEntries()`, which has already removed anything the caller lacks the
 * permission to open — so there is no code path here that could surface a
 * hidden section by forgetting a check.
 */
const palette = useCommandPalette();

const inputRef = ref<HTMLInputElement | null>(null);

const activeId = computed(() => (palette.results.value.length
    ? `palette-result-${palette.highlighted.value}`
    : undefined));

// Focus follows opening, not mounting: the dialog is v-if'd, so the input does
// not exist until the palette opens.
watch(palette.open, async (isOpen) => {
    if (!isOpen) return;

    await nextTick();
    inputRef.value?.focus();
});

/**
 * The dialog holds exactly one focusable element, so trapping is simply
 * refusing to leave it. A general focus trap would be more machinery than this
 * needs, and Escape is always available as the way out.
 */
function trapFocus(event: KeyboardEvent) {
    event.preventDefault();
    inputRef.value?.focus();
}
</script>

<style scoped lang="scss">
.palette {
    position: fixed;
    z-index: 200;
    inset: 0;

    display: flex;
    justify-content: center;

    padding: 12vh var(--space-6) var(--space-6);

    background: vartorgba('content0', 0.45);

    &_dialog {
        display: flex;
        flex-direction: column;

        width: 100%;
        max-width: 560px;
        max-height: 60vh;
        border: 1px solid $surface4;
        border-radius: var(--radius-xl);

        background: $surface1;
        box-shadow: 0 24px 60px vartorgba('content0', 0.28);
    }

    &_search {
        display: flex;
        gap: var(--space-5);
        align-items: center;

        padding: var(--space-5) var(--space-6);
        border-bottom: 1px solid $surface3;

        &-icon {
            flex: none;
            width: 18px;
            height: 18px;
            color: $surface7;
        }
    }

    &_input {
        width: 100%;
        border: 0;

        font-family: inherit;
        font-size: var(--font-size-lg);
        color: $content2;

        background: none;
        outline: none;

        &::placeholder { color: $surface7; }
    }

    &_kbd,
    kbd {
        padding: var(--space-1) var(--space-3);
        border: 1px solid $surface4;
        border-radius: var(--radius-sm);

        font-family: inherit;
        font-size: var(--font-size-xs);
        color: $surface7;
    }

    &_results {
        overflow-y: auto;
        flex: 1;

        margin: 0;
        padding: var(--space-3);

        list-style: none;
    }

    &_section {
        padding: var(--space-4) var(--space-4) var(--space-2);

        font-size: var(--font-size-xs);
        font-weight: 650;
        color: $surface7;
        text-transform: uppercase;
        letter-spacing: 0.06em;
    }

    &_result {
        cursor: pointer;

        display: flex;
        gap: var(--space-5);
        align-items: center;

        padding: var(--space-4) var(--space-4);
        border-radius: var(--radius-lg);

        &-icon {
            flex: none;
            width: 18px;
            height: 18px;
            color: $surface7;
        }

        &-body {
            display: flex;
            flex-direction: column;
            gap: var(--space-1);
            min-width: 0;
        }

        &-label {
            font-size: var(--font-size-md);
            font-weight: 600;
            color: $content2;
        }

        &-hint {
            overflow: hidden;

            font-size: var(--font-size-sm);
            color: $content7;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        &-kind {
            flex: none;

            width: 14px;
            height: 14px;
            margin-left: auto;

            color: $surface7;
        }

        // Highlight rather than :hover — the pointer and the keyboard drive the
        // same single highlight, so hover styling would produce two.
        &--active {
            background: $primary500;

            .palette_result-icon,
            .palette_result-kind { color: $surface0; }

            .palette_result-label { color: $surface0; }

            .palette_result-hint { color: vartorgba('surface0', 0.75); }

            .palette_hit { color: $surface0; }
        }
    }

    &_hit {
        font-weight: 800;
        color: $primary600;
    }

    &_empty {
        margin: 0;
        padding: var(--space-8) var(--space-6);

        font-size: var(--font-size-md);
        color: $content7;
        text-align: center;
    }

    &_footer {
        display: flex;
        gap: var(--space-6);

        padding: var(--space-4) var(--space-6);
        border-top: 1px solid $surface3;

        font-size: var(--font-size-xs);
        color: $surface7;

        span {
            display: flex;
            gap: var(--space-2);
            align-items: center;
        }
    }

    @include mobile() {
        padding: var(--space-6) var(--space-4);

        &_dialog { max-height: 80vh; }
    }
}
</style>
