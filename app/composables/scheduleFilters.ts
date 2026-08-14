/**
 * Filter state for the schedule view.
 *
 * OWNERSHIP BOUNDARY: this composable owns exactly the values that change the
 * API query, and nothing else. Density and the violations-panel toggle are
 * *view* state — they alter what the page looks like, never what it asks the
 * server for — so they stay page-local rather than drifting in here because it
 * would be convenient.
 */
export function useScheduleFilters() {
    const termId = ref('');
    const week = ref(1);
    const groupId = ref('');
    const roomId = ref('');
    const personId = ref('');
    const includeNested = ref(true);

    /**
     * The exact shape sent to GET /api/sessions. Optional filters are omitted
     * rather than sent empty, so the server never has to treat '' as "all".
     */
    const query = computed(() => ({
        termId: termId.value,
        termWeek: week.value,
        ...(groupId.value ? { groupId: groupId.value, includeNested: includeNested.value } : {}),
        ...(roomId.value ? { roomId: roomId.value } : {}),
        ...(personId.value ? { personId: personId.value } : {}),
    }));

    return { termId, week, groupId, roomId, personId, includeNested, query };
}
