<template>
    <div
        class="rgrid"
        :style="gridStyle"
    >
        <div class="rgrid_corner" />
        <div
            v-for="day in grid.activeDays"
            :key="`h-${day}`"
            class="rgrid_head"
        >{{ weekdayShort(day) }}</div>

        <template
            v-for="block in grid.blocksPerDay"
            :key="`r-${block}`"
        >
            <div class="rgrid_time">
                <span>{{ blockTime(grid, block - 1).start }}</span>
                <span class="rgrid_time-end">{{ blockTime(grid, block - 1).end }}</span>
            </div>
            <div
                v-for="day in grid.activeDays"
                :key="`c-${day}-${block}`"
                class="rgrid_cell"
            />
        </template>

        <article
            v-for="item in laidOut"
            :key="item.key"
            class="rgrid_chip"
            :class="`rgrid_chip--${item.action}`"
            :style="item.style"
        >
            <span class="rgrid_chip-tag">{{ TAG[item.action] }}</span>
            <span class="rgrid_chip-title">{{ lookup.offering(item.offeringId) }}</span>
            <span
                v-if="item.roomId"
                class="rgrid_chip-meta"
            >{{ lookup.room(item.roomId) }}</span>
            <!-- A move is only legible if it says where FROM. -->
            <span
                v-if="item.action === 'move' && item.previous"
                class="rgrid_chip-meta rgrid_chip-was"
            >was {{ weekdayShort(item.previous.dayOfWeek) }}
                {{ blockTime(grid, item.previous.blockIndex).start }}
                <template v-if="item.previous.termWeek !== item.placement.termWeek">
                    (wk {{ item.previous.termWeek }})
                </template>
            </span>
        </article>

        <p
            v-if="!laidOut.length"
            class="rgrid_empty"
        >{{ emptyMessage }}</p>
    </div>
</template>

<script setup lang="ts">
import { blockTime, weekdayShort } from '~/composables/schedule';
import type { TimeGrid } from '~/composables/schedule';
import type { DiffAction, ReviewPlacement } from '~/composables/generationReview';

/**
 * The proposed timetable, rendered as a diff.
 *
 * A SEPARATE COMPONENT rather than a mode on ScheduleGrid, deliberately.
 * ScheduleGrid is already at the size threshold and carries selection and
 * placement-mode concerns; diff rendering would be a fourth responsibility on
 * it. More to the point the data genuinely differs: a CREATED placement has no
 * Session row and therefore no id, so it cannot be selected, cannot key into the
 * violations map, and does not belong in a component whose whole vocabulary is
 * session ids.
 *
 * What IS shared is the geometry — `blockTime`, `weekdayShort` and the column
 * arithmetic come from composables/schedule.ts, because duplicating grid layout
 * is the part that would actually hurt.
 */
const props = defineProps<{
    grid: TimeGrid;
    placements: ReviewPlacement[];
    rowHeight: number;
    lookup: {
        offering: (id: string) => string;
        room: (id: string) => string;
    };
    emptyMessage: string;
}>();

const TAG: Record<DiffAction, string> = {
    create: 'Added',
    move: 'Moved',
    unchanged: 'Unchanged',
    delete: 'Removed',
};

const gridStyle = computed(() => ({
    '--day-count': String(props.grid.activeDays.length),
    '--row-height': `${props.rowHeight}px`,
}));

/**
 * Position each placement, and fan out anything sharing a slot.
 *
 * Not `layoutDay()` from the schedule composable: that one takes ScheduleSession
 * and keys by session id, which a created placement does not have. The overlap
 * rule is the same — split the column evenly between everything in the slot.
 */
const laidOut = computed(() => {
    const slots = new Map<string, ReviewPlacement[]>();

    for (const placement of props.placements) {
        // A removal is shown where it currently sits, which is where a reviewer
        // will look for the session that is about to disappear.
        const at = placement.action === 'delete' && placement.previous
            ? placement.previous
            : placement.placement;

        const key = `${at.dayOfWeek}:${at.blockIndex}`;
        const list = slots.get(key) ?? [];

        list.push(placement);
        slots.set(key, list);
    }

    return [...slots.entries()].flatMap(([key, items]) => {
        const [day, block] = key.split(':').map(Number);
        const column = props.grid.activeDays.indexOf(day!);

        if (column < 0) {
            return [];
        }

        return items.map((item, index) => {
            const at = item.action === 'delete' && item.previous ? item.previous : item.placement;
            const width = 100 / items.length;

            return {
                key: `${item.sessionId ?? 'new'}-${item.offeringId}-${key}-${index}`,
                action: item.action,
                offeringId: item.offeringId,
                roomId: item.roomId,
                previous: item.previous,
                placement: item.placement,
                style: {
                    gridColumn: String(column + 2),
                    gridRow: `${block! + 2} / span ${Math.max(1, at.durationBlocks)}`,
                    width: `${width}%`,
                    marginLeft: `${width * index}%`,
                },
            };
        });
    });
});
</script>

<style scoped lang="scss">
.rgrid {
    position: relative;

    display: grid;
    grid-auto-rows: var(--row-height);
    grid-template-columns: 76px repeat(var(--day-count), 1fr);

    padding: var(--space-4);
    border-radius: var(--radius-lg);

    background: $surface1;

    &_corner,
    &_head {
        padding: var(--space-3);

        font-size: var(--font-size-xs);
        font-weight: 600;
        color: $surface7;
        text-align: center;
        text-transform: uppercase;
        letter-spacing: 0.05em;
    }

    &_time {
        display: flex;
        flex-direction: column;

        padding: var(--space-3);

        font-size: var(--font-size-xs);
        color: $surface7;
    }

    &_time-end { color: $surface6; }

    &_cell {
        border-top: 1px solid $surface3;
    }

    &_chip {
        z-index: 1;

        overflow: hidden;
        display: flex;
        flex-direction: column;
        gap: var(--space-1);

        padding: var(--space-3);
        border-left: 3px solid $content5;
        border-radius: var(--radius-sm);

        font-size: var(--font-size-xs);

        background: $surface3;

        // The four states read differently at a glance, which is the entire job
        // of this grid: added and removed must never be mistaken for each other.
        &--create {
            border-left-color: $content1;
            background: $surface4;
        }

        &--move {
            border-left-color: $content2;
            background: $surface3;
        }

        &--unchanged {
            border-left-color: $surface5;
            opacity: 0.55;
        }

        &--delete {
            border-left-color: $content5;
            opacity: 0.7;

            .rgrid_chip-title {
                text-decoration: line-through;
            }
        }
    }

    &_chip-tag {
        font-size: var(--font-size-xs);
        font-weight: 600;
        color: $surface7;
        text-transform: uppercase;
        letter-spacing: 0.05em;
    }

    &_chip-title {
        overflow: hidden;

        font-size: var(--font-size-sm);
        font-weight: 600;
        color: $content1;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    &_chip-meta {
        overflow: hidden;
        color: $content5;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    &_chip-was {
        font-style: italic;
    }

    &_empty {
        grid-column: 1 / -1;

        padding: var(--space-7);

        font-size: var(--font-size-sm);
        color: $surface7;
        text-align: center;
    }
}
</style>
