import type { ComputedRef } from 'vue';
import type { ScheduleSession } from '~/composables/schedule';
import { useOverlayActive } from '~/composables/overlay';

/**
 * The editing interaction: what is selected, whether we are placing it, and the
 * two mutations the API exposes.
 *
 * OWNERSHIP BOUNDARY: this is one state machine, not a bag of flags — selection
 * and placement mode constrain each other, and Escape unwinds them in order.
 * Splitting them across components is how that ordering gets lost.
 *
 * Enforcement stays server-side. Nothing here is a permission check; the page
 * decides which affordances to render.
 */
/**
 * What a click on the grid means right now.
 *
 * `idle`  — selects a session
 * `place` — a slot is a destination for the selected session
 * `swap`  — a session is the partner to exchange placements with
 */
export type EditMode = 'idle' | 'place' | 'swap';

export function useScheduleEditing(options: {
    sessions: ComputedRef<ScheduleSession[]>;
    onMutated: () => Promise<void>;
}) {
    const selectedId = ref<string | null>(null);
    /**
     * What a click on the GRID currently means.
     *
     * A mode exists only when it changes that — which is the whole test for
     * whether something belongs here. `place` turns a slot into a destination,
     * `swap` turns a session into a partner. Editing the room changes nothing
     * about the grid, so it is a control in the inspector rather than a fourth
     * value here.
     *
     * One enum rather than two booleans: `placing` + `swapping` would describe
     * four states, three of which are meaningless, and would need a guard
     * somewhere to keep them apart. Mutual exclusion by construction instead.
     */
    const mode = ref<EditMode>('idle');
    const busy = ref(false);
    const error = ref('');

    /** Kept so existing callers (`ScheduleGrid`, the page) read unchanged. */
    const placing = computed(() => mode.value === 'place');
    const swapping = computed(() => mode.value === 'swap');

    /**
     * The session most recently selected, kept even if it leaves the view.
     *
     * `sessions` holds only the week currently on screen. Deriving `selected`
     * from it alone means navigating to another week silently drops the
     * selection — which is fatal for a cross-week move, because the whole
     * interaction is "select here, navigate there, place". The mode survived
     * that transition; the subject did not, so `move()` early-returned on a
     * null selection and the click did nothing at all.
     *
     * The snapshot is the fallback, never the primary: while the session IS in
     * view, the live row wins so edits and violations stay current.
     */
    const snapshot = ref<ScheduleSession | null>(null);

    const selected = computed(() => (
        options.sessions.value.find((s) => s.id === selectedId.value)
        ?? (snapshot.value?.id === selectedId.value ? snapshot.value : null)
    ));

    /**
     * Clicking a session.
     *
     * In `swap` this IS the action — the second session is the partner — which
     * is the one place the two grid modes genuinely differ. In `place`, picking
     * a different session cancels the mode rather than silently retargeting a
     * placement the user set up for something else.
     */
    function select(id: string) {
        if (mode.value === 'swap' && selectedId.value && id !== selectedId.value) {
            void swapWith(id);

            return;
        }

        selectedId.value = id;
        snapshot.value = options.sessions.value.find((s) => s.id === id) ?? null;
        mode.value = 'idle';
    }

    function clearSelection() {
        selectedId.value = null;
        snapshot.value = null;
        mode.value = 'idle';
    }

    /** Entering either grid mode leaves the other; they cannot both be on. */
    function setMode(next: EditMode) {
        mode.value = selectedId.value && mode.value !== next ? next : 'idle';
    }

    function togglePlacing() {
        setMode('place');
    }

    function toggleSwapping() {
        setMode('swap');
    }

    async function move(target: { dayOfWeek: number; blockIndex: number; termWeek?: number }) {
        if (!selected.value || busy.value) {
            return;
        }

        busy.value = true;
        error.value = '';

        try {
            await $fetch(`/api/sessions/${selected.value.id}/move`, {
                method: 'POST',
                /**
                 * `termWeek` travels with every placement. The grid shows one
                 * week at a time, so the displayed week IS the destination —
                 * omitting it (as this did until now) left the server keeping
                 * the session's existing week, which made cross-week moves
                 * impossible through the UI even though /move has always
                 * accepted the field.
                 */
                body: {
                    dayOfWeek: target.dayOfWeek,
                    blockIndex: target.blockIndex,
                    ...(target.termWeek === undefined ? {} : { termWeek: target.termWeek }),
                },
            });

            mode.value = 'idle';
            // Violations are recomputed server-side in the same transaction as
            // the move, so refreshing both reflects one consistent state.
            await options.onMutated();
        } catch (e) {
            error.value = (e as { statusMessage?: string }).statusMessage ?? 'Could not move that session.';
        } finally {
            busy.value = false;
        }
    }

    /**
     * Exchange the selected Session's placement with another's.
     *
     * Distinct from `move` on purpose: a swap is one atomic server operation
     * that repositions BOTH sessions, and the event log records it as a swap
     * rather than as two unrelated moves.
     */
    async function swapWith(otherId: string) {
        if (!selected.value || busy.value || otherId === selected.value.id) {
            return;
        }

        busy.value = true;
        error.value = '';

        try {
            await $fetch(`/api/sessions/${selected.value.id}/swap`, {
                method: 'POST',
                body: { withSessionId: otherId },
            });

            mode.value = 'idle';
            await options.onMutated();
        } catch (e) {
            error.value = (e as { statusMessage?: string }).statusMessage ?? 'Could not swap those sessions.';
        } finally {
            busy.value = false;
        }
    }

    /**
     * Replace the Session's Rooms.
     *
     * `/move` sets `roomIds` WHOLESALE, so this must always send the complete
     * desired set — sending one id would delete every other room the session
     * has. That is why the inspector edits the whole collection rather than
     * offering an "add room" action.
     */
    async function setRooms(roomIds: string[]) {
        if (!selected.value || busy.value) {
            return;
        }

        busy.value = true;
        error.value = '';

        try {
            await $fetch(`/api/sessions/${selected.value.id}/move`, {
                method: 'POST',
                body: { roomIds },
            });
            await options.onMutated();
        } catch (e) {
            error.value = (e as { statusMessage?: string }).statusMessage ?? 'Could not change the room.';
        } finally {
            busy.value = false;
        }
    }

    async function toggleLock() {
        if (!selected.value || busy.value) {
            return;
        }

        busy.value = true;
        error.value = '';

        try {
            await $fetch(`/api/sessions/${selected.value.id}/${selected.value.isLocked ? 'unlock' : 'lock'}`, {
                method: 'POST',
                body: {},
            });
            await options.onMutated();
        } catch (e) {
            error.value = (e as { statusMessage?: string }).statusMessage ?? 'Could not change the lock.';
        } finally {
            busy.value = false;
        }
    }

    const overlayActive = useOverlayActive();

    // Escape leaves placement mode before it clears the selection, so one key
    // unwinds the interaction one step at a time.
    //
    // While an overlay owns the keyboard (the command palette, a dialog),
    // Escape belongs to it and this handler stands down — otherwise closing the
    // palette would also cancel a placement the user is still in the middle of.
    function onKey(event: KeyboardEvent) {
        if (event.key !== 'Escape' || overlayActive.value) return;

        // Either grid mode first, then the selection — one key, one step.
        // Neither mode is an overlay (nothing traps focus), so neither
        // claims the keyboard; a claim here would suppress the very Escape
        // that leaves the mode.
        if (mode.value !== 'idle') mode.value = 'idle';
        else clearSelection();
    }

    onMounted(() => window.addEventListener('keydown', onKey));
    onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

    return {
        selectedId, selected, mode, placing, swapping, busy, error,
        select, clearSelection, setMode, togglePlacing, toggleSwapping,
        move, swapWith, setRooms, toggleLock,
    };
}
