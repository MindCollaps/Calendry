<template>
    <aside
        class="inspector"
        :class="{ 'inspector--open': !!session }"
        aria-label="Session details"
    >
        <div
            v-if="!session"
            class="inspector_empty"
        >
            <Icon
                name="material-symbols:ads-click"
                class="inspector_empty-icon"
                aria-hidden="true"
            />
            <p>Select a session to see its details and edit it.</p>
        </div>

        <template v-else>
            <header class="inspector_head">
                <h2 class="inspector_title">{{ session.offering?.title ?? 'Untitled session' }}</h2>
                <p class="inspector_sub">
                    {{ session.offering?.code ? `${session.offering.code} · ` : '' }}{{ session.kind?.name }}
                </p>
                <button
                    type="button"
                    class="inspector_close"
                    aria-label="Close details"
                    @click="$emit('close')"
                >
                    <Icon
                        name="material-symbols:close"
                        aria-hidden="true"
                    />
                </button>
            </header>

            <dl class="inspector_facts">
                <div>
                    <dt>When</dt>
                    <dd>
                        {{ weekdayName(session.dayOfWeek) }},
                        {{ blockTime(grid, session.blockIndex).start }}–{{ blockTime(grid, endBlock).end }}
                        <span class="inspector_muted">· week {{ session.termWeek }}</span>
                    </dd>
                </div>
                <div v-if="session.rooms.length">
                    <dt>{{ session.rooms.length === 1 ? 'Room' : 'Rooms' }}</dt>
                    <dd>{{ session.rooms.map(r => lookup.room(r.roomId)).join(', ') }}</dd>
                </div>
                <div v-if="session.people.length">
                    <dt>People</dt>
                    <dd>{{ session.people.map(p => lookup.person(p.personId)).join(', ') }}</dd>
                </div>
                <div v-if="session.groups.length">
                    <dt>{{ session.groups.length === 1 ? 'Group' : 'Groups' }}</dt>
                    <dd>{{ session.groups.map(g => lookup.group(g.groupId)).join(', ') }}</dd>
                </div>
            </dl>

            <section
                v-if="violations.length"
                class="inspector_violations"
                :class="`inspector_violations--${worst}`"
            >
                <h3>
                    <Icon
                        :name="worst === 'hard' ? 'material-symbols:error' : 'material-symbols:warning-outline'"
                        aria-hidden="true"
                    />
                    {{ violations.length }} violation{{ violations.length === 1 ? '' : 's' }}
                </h3>
                <ul>
                    <li
                        v-for="violation in violations"
                        :key="violation.id"
                    >
                        {{ describeViolation(violation, lookup) }}
                        <span class="inspector_muted">— {{ violation.constraint.name }}</span>
                    </li>
                </ul>
                <p class="inspector_note">
                    Recorded, not blocking. The edit that caused this was allowed.
                </p>
            </section>

            <div class="inspector_actions">
                <common-button
                    v-if="canMove"
                    :type="placing ? 'secondary-black' : 'primary'"
                    width="100%"
                    :disabled="busy || session.isLocked"
                    @click="$emit('toggle-place')"
                >{{ placing ? 'Cancel move' : 'Move…' }}</common-button>

                <p
                    v-if="canMove && session.isLocked"
                    class="inspector_hint"
                >Unlock this session before moving it.</p>

                <common-button
                    v-if="canLock"
                    type="secondary"
                    width="100%"
                    :disabled="busy"
                    @click="$emit('toggle-lock')"
                >{{ session.isLocked ? 'Unlock' : 'Lock in place' }}</common-button>

                <p
                    v-if="!canMove && !canLock"
                    class="inspector_hint"
                >You have view-only access to this schedule.</p>
            </div>
        </template>
    </aside>
</template>

<script setup lang="ts">
import type { ScheduleSession, TimeGrid, Violation } from '~/composables/schedule';
import { blockTime, describeViolation, weekdayName } from '~/composables/schedule';

const props = defineProps<{
    session: ScheduleSession | null;
    grid: TimeGrid;
    violations: Violation[];
    canMove: boolean;
    canLock: boolean;
    placing: boolean;
    busy: boolean;
    lookup: { room: (id: string) => string; person: (id: string) => string; group: (id: string) => string };
}>();

defineEmits<{ close: []; 'toggle-place': []; 'toggle-lock': [] }>();

/** Last block the session occupies, so the end time reflects its duration. */
const endBlock = computed(() => (props.session
    ? props.session.blockIndex + props.session.durationBlocks - 1
    : 0));

const worst = computed(() => (props.violations.some((v) => v.severity === 'HARD') ? 'hard' : 'soft'));
</script>

<style scoped lang="scss">
.inspector {
    display: flex;
    flex-direction: column;
    gap: 18px;

    width: 320px;
    padding: 20px;
    border-radius: 10px;

    background: $surface1;

    @include mobile() {
        width: 100%;
    }

    &_empty {
        display: flex;
        flex-direction: column;
        gap: 10px;
        align-items: center;
        justify-content: center;

        min-height: 160px;

        font-size: 13px;
        color: $surface7;
        text-align: center;

        &-icon {
            width: 22px;
            height: 22px;
            opacity: 0.7;
        }

        p { margin: 0; max-width: 24ch; }
    }

    &_head {
        position: relative;
        padding-right: 28px;
    }

    &_title {
        margin: 0;
        font-size: 17px;
        font-weight: 650;
        line-height: 1.25;
        color: $content2;
    }

    &_sub {
        margin: 4px 0 0;
        font-size: 12px;
        color: $surface7;
    }

    &_close {
        cursor: pointer;

        position: absolute;
        top: -4px;
        right: -4px;

        display: flex;
        padding: 4px;
        border: 0;
        border-radius: 6px;

        color: $surface7;

        background: none;

        @include hover() {
            &:hover { color: $content5; background: $surface3; }
        }

        &:focus-visible { outline: 2px solid $primary400; }
    }

    &_facts {
        display: flex;
        flex-direction: column;
        gap: 12px;
        margin: 0;

        dt {
            margin-bottom: 3px;
            font-size: 11px;
            font-weight: 600;
            letter-spacing: 0.05em;
            color: $surface7;
            text-transform: uppercase;
        }

        dd {
            margin: 0;
            font-size: 13px;
            line-height: 1.45;
            color: $content5;
        }
    }

    &_muted { color: $surface7; }

    &_violations {
        padding: 12px;
        border-radius: 8px;
        background: rgba(169, 125, 45, 0.14);

        h3 {
            display: flex;
            gap: 6px;
            align-items: center;

            margin: 0 0 8px;

            font-size: 12px;
            font-weight: 650;
            letter-spacing: 0.03em;
            color: $warning300;
            text-transform: uppercase;

            svg { width: 15px; height: 15px; }
        }

        ul {
            display: flex;
            flex-direction: column;
            gap: 6px;
            margin: 0;
            padding-left: 16px;

            font-size: 12.5px;
            line-height: 1.45;
            color: $content5;
        }

        &--hard {
            background: rgba(169, 45, 70, 0.16);

            h3 { color: $error300; }
        }
    }

    &_note {
        margin: 8px 0 0;
        font-size: 11.5px;
        line-height: 1.4;
        color: $surface7;
    }

    &_actions {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-top: auto;
    }

    &_hint {
        margin: 0;
        font-size: 11.5px;
        line-height: 1.4;
        color: $surface7;
    }
}
</style>
