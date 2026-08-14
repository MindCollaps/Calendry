import type { ComputedRef } from 'vue';
import type { ScheduleSession } from '~/composables/schedule';

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
export function useScheduleEditing(options: {
    sessions: ComputedRef<ScheduleSession[]>;
    onMutated: () => Promise<void>;
}) {
    const selectedId = ref<string | null>(null);
    const placing = ref(false);
    const busy = ref(false);
    const error = ref('');

    const selected = computed(() => options.sessions.value.find((s) => s.id === selectedId.value) ?? null);

    function select(id: string) {
        selectedId.value = id;

        // Selecting a different session cancels a placement in progress rather
        // than silently retargeting it.
        if (placing.value) {
            placing.value = false;
        }
    }

    function clearSelection() {
        selectedId.value = null;
        placing.value = false;
    }

    function togglePlacing() {
        placing.value = !placing.value;
    }

    async function move(target: { dayOfWeek: number; blockIndex: number }) {
        if (!selected.value || busy.value) {
            return;
        }

        busy.value = true;
        error.value = '';

        try {
            await $fetch(`/api/sessions/${selected.value.id}/move`, {
                method: 'POST',
                body: { dayOfWeek: target.dayOfWeek, blockIndex: target.blockIndex },
            });

            placing.value = false;
            // Violations are recomputed server-side in the same transaction as
            // the move, so refreshing both reflects one consistent state.
            await options.onMutated();
        } catch (e) {
            error.value = (e as { statusMessage?: string }).statusMessage ?? 'Could not move that session.';
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

    // Escape leaves placement mode before it clears the selection, so one key
    // unwinds the interaction one step at a time.
    function onKey(event: KeyboardEvent) {
        if (event.key !== 'Escape') return;

        if (placing.value) placing.value = false;
        else clearSelection();
    }

    onMounted(() => window.addEventListener('keydown', onKey));
    onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

    return { selectedId, selected, placing, busy, error, select, clearSelection, togglePlacing, move, toggleLock };
}
