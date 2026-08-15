<template>
    <div class="list">
        <div class="list_tools">
            <label class="list_search">
                <Icon
                    name="material-symbols:search"
                    aria-hidden="true"
                />
                <input
                    v-model="search"
                    type="search"
                    :placeholder="`Search ${entity.plural.toLowerCase()}…`"
                    autocomplete="off"
                >
            </label>

            <span class="list_count">
                <template v-if="list.isFiltered.value">{{ list.total.value }} matching</template>
                <template v-else>{{ list.total.value }} total</template>
            </span>
        </div>

        <!--
            Four distinct states, rendered four ways. Collapsing "the fetch
            failed" into "there is nothing here" is the bug this codebase keeps
            re-learning: a broken request must never look like a legitimately
            empty tenant.
        -->
        <p
            v-if="list.error.value"
            class="list_blank list_blank--error"
            role="alert"
        >
            Could not load {{ entity.plural.toLowerCase() }}.
            {{ (list.error.value as { statusMessage?: string }).statusMessage ?? 'The request failed.' }}
        </p>

        <div
            v-else-if="list.pending.value && !list.rows.value.length"
            class="list_loading"
        >
            <common-loader/>
        </div>

        <p
            v-else-if="!list.rows.value.length && list.isFiltered.value"
            class="list_blank"
        >
            No {{ entity.plural.toLowerCase() }} match “{{ search }}”.
        </p>

        <p
            v-else-if="!list.rows.value.length"
            class="list_blank"
        >
            No {{ entity.plural.toLowerCase() }} yet.
            <template v-if="canCreate">Create the first one to get started.</template>
        </p>

        <div
            v-else
            class="list_scroll"
        >
            <table class="list_table">
                <thead>
                    <tr>
                        <th
                            v-for="column in entity.columns"
                            :key="column.key"
                            :class="{ 'is-secondary': column.secondary }"
                            :style="column.format === 'number' ? 'text-align:right' : undefined"
                        >{{ column.label }}</th>
                        <th class="list_chev"><span class="sr-only">Open</span></th>
                    </tr>
                </thead>
                <tbody>
                    <tr
                        v-for="row in list.rows.value"
                        :key="String(row.id)"
                        class="list_row"
                        tabindex="0"
                        @click="open(row)"
                        @keydown.enter="open(row)"
                    >
                        <td
                            v-for="column in entity.columns"
                            :key="column.key"
                            :class="[
                                { 'is-secondary': column.secondary },
                                `is-${column.format ?? 'text'}`,
                            ]"
                        >
                            <template v-if="column.format === 'boolean'">
                                <span
                                    class="list_flag"
                                    :class="{ 'list_flag--on': !!row[column.key] }"
                                >{{ row[column.key] ? 'Yes' : 'No' }}</span>
                            </template>
                            <template v-else-if="column.format === 'swatch'">
                                <span
                                    v-if="row[column.key]"
                                    class="list_swatch"
                                    :style="{ background: String(row[column.key]) }"
                                />
                                <span class="list_swatch-text">{{ row[column.key] ?? '—' }}</span>
                            </template>
                            <template v-else>{{ formatCell(row[column.key], column.format) }}</template>

                            <span
                                v-if="column.key === entity.columns[0]?.key && isShared(row)"
                                class="list_badge"
                                title="Owned by a federation — readable here, editable by its owner"
                            >shared</span>

                            <span
                                v-if="column.key === entity.columns[0]?.key && isSystem(row)"
                                class="list_badge list_badge--system"
                                title="Created by provisioning; cannot be deleted"
                            >system</span>
                        </td>
                        <td class="list_chev">
                            <Icon
                                name="material-symbols:chevron-right"
                                aria-hidden="true"
                            />
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>

        <nav
            v-if="list.pageCount.value > 1"
            class="list_pager"
            aria-label="Pages"
        >
            <common-button
                :disabled="page === 0"
                type="secondary"
                @click="page = Math.max(0, page - 1)"
            >Previous</common-button>

            <span>Page {{ page + 1 }} of {{ list.pageCount.value }}</span>

            <common-button
                :disabled="page + 1 >= list.pageCount.value"
                type="secondary"
                @click="page = Math.min(list.pageCount.value - 1, page + 1)"
            >Next</common-button>
        </nav>
    </div>
</template>

<script setup lang="ts">
import type { useEntityList } from '~/composables/entityList';
import type { ColumnDef, EntityRow, ManageEntity } from '~/utils/manageRegistry';
import { weekdayShort } from '~/composables/schedule';

/**
 * The one list implementation, for every managed entity.
 *
 * Columns, formats and the row title all come from the registry, which is what
 * stops nine entities growing nine slightly different tables that then diverge
 * on empty states, pagination and permission handling.
 */
const props = defineProps<{
    entity: ManageEntity;
    /** Read-only view of the list's server state. Writes go through the models. */
    list: ReturnType<typeof useEntityList>;
    canCreate: boolean;
}>();

/**
 * The two pieces of list state this component CHANGES are models, not fields
 * reached through the `list` prop. Writing through a prop object works at
 * runtime and is still wrong: it hides the data flow and makes the component's
 * effect on its parent invisible at the call site.
 */
const search = defineModel<string>('search', { required: true });
const page = defineModel<number>('page', { required: true });

function open(row: EntityRow) {
    return navigateTo(`/manage/${props.entity.key}/${row.id}`);
}

/** Federation-owned: readable here, not writable (TAXONOMY.md §2). */
function isShared(row: EntityRow): boolean {
    return Boolean(props.entity.federationOwnable && !row.tenantId && row.federationId);
}

function isSystem(row: EntityRow): boolean {
    return Boolean(props.entity.systemFlag && row[props.entity.systemFlag]);
}

function formatCell(value: unknown, format: ColumnDef['format']): string {
    if (value === null || value === undefined || value === '') {
        return '—';
    }

    if (format === 'weekdays') {
        // ISO 1-7 through the same helper the schedule labels its columns with,
        // so a grid's days read identically here and on the timetable.
        return Array.isArray(value) && value.length
            ? [...value].map(Number).sort((a, b) => a - b).map(weekdayShort).join(' ')
            : '—';
    }

    if (format === 'date') {
        // Tenant-local by construction: these are `@db.Date` columns with no
        // time component, so slicing the ISO string cannot shift the day the
        // way a Date parse in the viewer's timezone would.
        return String(value).slice(0, 10);
    }

    return String(value);
}
</script>

<style scoped lang="scss">
.list {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);

    &_tools {
        display: flex;
        gap: var(--space-5);
        align-items: center;
        justify-content: space-between;
    }

    &_search {
        display: flex;
        gap: var(--space-4);
        align-items: center;

        width: 100%;
        max-width: 320px;
        padding: var(--space-3) var(--space-5);
        border: 1px solid $surface4;
        border-radius: var(--radius-lg);

        background: $surface0;

        svg {
            flex: none;
            width: 16px;
            height: 16px;
            color: $surface7;
        }

        input {
            width: 100%;
            border: 0;

            font-family: inherit;
            font-size: var(--font-size-md);
            color: $content3;

            background: none;
            outline: none;
        }

        &:focus-within { border-color: $primary500; }
    }

    &_count {
        flex: none;

        // Tabular figures so the count does not jitter as it changes.
        font-size: var(--font-size-sm);
        font-variant-numeric: tabular-nums;
        color: $content7;
    }

    &_scroll {
        overflow-x: auto;
        border-radius: var(--radius-xl);
        background: $surface1;
    }

    &_table {
        border-collapse: collapse;
        width: 100%;

        th {
            padding: var(--space-5) var(--space-6);

            font-size: var(--font-size-xs);
            font-weight: 650;
            color: $surface7;
            text-align: left;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            white-space: nowrap;
        }

        td {
            padding: var(--space-5) var(--space-6);
            border-top: 1px solid $surface3;
            font-size: var(--font-size-md);
            color: $content4;
        }

        .is-number {
            font-variant-numeric: tabular-nums;
            text-align: right;
        }

        .is-code {
            font-family: monospace;
            font-size: var(--font-size-sm);
        }
        .is-date { font-variant-numeric: tabular-nums; }

        @include mobile() {
            .is-secondary { display: none; }
        }
    }

    &_row {
        cursor: pointer;
        transition: 0.12s;

        @include hover() {
            &:hover { background: $surface2; }
        }

        &:focus-visible {
            outline: 2px solid $primary400;
            outline-offset: -2px;
        }
    }

    &_chev {
        width: 40px;
        text-align: right;

        svg {
            width: 18px;
            height: 18px;
            color: $surface7;
        }
    }

    &_flag {
        font-size: var(--font-size-sm);
        font-weight: 600;
        color: $content7;

        &--on { color: $success700; }
    }

    &_swatch {
        display: inline-block;

        width: 12px;
        height: 12px;
        margin-right: var(--space-3);
        border: 1px solid $surface4;
        border-radius: var(--radius-sm);

        vertical-align: -1px;
    }

    &_swatch-text {
        font-family: monospace;
        font-size: var(--font-size-sm);
    }

    &_badge {
        margin-left: var(--space-4);
        padding: var(--space-1) var(--space-3);
        border-radius: var(--radius-sm);

        font-size: var(--font-size-xs);
        font-weight: 650;
        color: $primary700;
        text-transform: uppercase;
        letter-spacing: 0.04em;

        background: vartorgba('primary500', 0.16);

        &--system {
            color: $content7;
            background: $surface3;
        }
    }

    &_blank {
        margin: 0;
        padding: var(--space-8) var(--space-7);
        border-radius: var(--radius-xl);

        font-size: var(--font-size-md);
        color: $content7;

        background: $surface1;

        &--error {
            font-weight: 600;
            color: $error700;
            background: vartorgba('error500', 0.12);
        }
    }

    &_loading {
        display: flex;
        justify-content: center;
        padding: 60px 0;
    }

    &_pager {
        display: flex;
        gap: var(--space-5);
        align-items: center;
        justify-content: center;

        font-size: var(--font-size-sm);
        color: $content7;
    }
}

.sr-only {
    position: absolute;

    overflow: hidden;

    width: 1px;
    height: 1px;

    clip-path: inset(50%);
}
</style>
