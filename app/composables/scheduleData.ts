import type { ComputedRef, Ref } from 'vue';
import type { ScheduleSession, Term, TimeGrid, Violation } from '~/composables/schedule';
import { isOnGrid, weeksInTerm } from '~/composables/schedule';
import { useHasPermission } from '~/composables/session';

/**
 * Everything the schedule view reads from the server, plus what is derived from
 * it: grid geometry, the on/off-grid partition, and name lookups.
 *
 * OWNERSHIP BOUNDARY: server state and its derivations. No selection, no
 * placement mode, no view preferences.
 */
export function useScheduleData(filters: {
    termId: Ref<string>;
    query: ComputedRef<Record<string, unknown>>;
}) {
    /**
     * CRITICAL: resolved at setup time, not inside a fetch callback.
     *
     * `useRequestFetch()` needs the Nuxt request context to forward the
     * browser's cookie during SSR. Called lazily inside `useAsyncData`'s handler
     * it loses that context, every authenticated call 401s on the server, and
     * the page renders its *empty state* — indistinguishable from a tenant with
     * no data. That exact bug shipped once already; keep this line here.
     *
     * For the same reason this composable is SYNCHRONOUS. An `await` here would
     * detach every later useAsyncData/watchEffect from the Nuxt instance, which
     * fails at runtime with "a composable ... was called outside of a Vue setup
     * function". The single await belongs to the page.
     */
    const request = useRequestFetch();

    const canReadViolations = useHasPermission('violation.read');

    /**
     * One request wave, not three. Beyond being fewer round trips, it removes an
     * ordering hazard: the sessions query keys off termId, which is only known
     * after the reference data lands. Resolving both inside one handler means
     * the server never issues a sessions fetch with an empty term and renders an
     * empty grid.
     */
    const asyncData = useAsyncData('schedule', async () => {
        const [terms, timeGrids, groupRows, roomRows, personRows] = await Promise.all([
            request<Term[]>('/api/terms'),
            request<TimeGrid[]>('/api/time-grids'),
            request<{ id: string; name: string; parentGroupId: string | null }[]>('/api/groups'),
            request<{ id: string; name: string; code: string }[]>('/api/rooms'),
            request<{ id: string; givenName: string; familyName: string }[]>('/api/persons'),
        ]);

        const resolvedTermId = filters.termId.value || terms[0]?.id || '';

        const [sessions, violations] = await Promise.all([
            resolvedTermId
                ? request<ScheduleSession[]>('/api/sessions', {
                    query: { ...filters.query.value, termId: resolvedTermId },
                })
                : Promise.resolve([] as ScheduleSession[]),
            resolvedTermId && canReadViolations.value
                ? request<Violation[]>('/api/violations', { query: { termId: resolvedTermId } })
                : Promise.resolve([] as Violation[]),
        ]);

        return {
            terms,
            timeGrids,
            groups: groupRows,
            rooms: roomRows.map((r) => ({ id: r.id, name: `${r.code} · ${r.name}` })),
            people: personRows.map((p) => ({ id: p.id, name: `${p.givenName} ${p.familyName}` })),
            sessions,
            violations,
            resolvedTermId,
        };
    }, { watch: [filters.query] });

    const reference = asyncData.data;

    // Reflect the term the fetch actually used, so the toolbar shows it.
    watchEffect(() => {
        const resolved = reference.value?.resolvedTermId;

        if (resolved && !filters.termId.value) {
            filters.termId.value = resolved;
        }
    });

    /**
     * The term the fetch actually used, correct at FIRST RENDER.
     *
     * `filters.termId` is seeded by the watchEffect above, and Vue does not
     * flush watchers during SSR — so on the server it is still `''` while the
     * page renders. Anything that must be right server-side has to read this
     * instead, or it renders as though no term existed. That is what hid the
     * solver control on first paint until hydration corrected it.
     */
    const resolvedTermId = computed(() => (
        filters.termId.value || reference.value?.resolvedTermId || ''
    ));

    const terms = computed(() => reference.value?.terms ?? []);
    const groups = computed(() => reference.value?.groups ?? []);
    const rooms = computed(() => reference.value?.rooms ?? []);
    const people = computed(() => reference.value?.people ?? []);

    /**
     * Resolved through `resolvedTermId`, NOT `filters.termId`.
     *
     * `filters.termId` is seeded by the watchEffect above, which Vue never
     * flushes during SSR — so on the server it is `''`, this computed is null,
     * and `totalWeeks` below falls back to 1. That made the toolbar render
     * `Week 1 / 1` with `disabled="true"` on the week buttons.
     *
     * The text was patched on hydration; the ATTRIBUTE was not. Vue does not
     * rectify attribute mismatches ("this mismatch is check-only. The DOM will
     * not be rectified"), so the buttons stayed disabled in the DOM forever and
     * week navigation was dead on every page load — not a flash, a permanently
     * broken control.
     */
    const term = computed(() => terms.value.find((t) => t.id === resolvedTermId.value) ?? null);
    const totalWeeks = computed(() => (term.value ? weeksInTerm(term.value) : 1));

    /**
     * Grid shape follows the selected Term's TimeGrid, falling back to the
     * tenant default. Never a constant (TAXONOMY.md §2).
     */
    const grid = computed<TimeGrid | null>(() => {
        const grids = reference.value?.timeGrids ?? [];

        return grids.find((g) => g.id === term.value?.timeGridId)
            ?? grids.find((g) => g.isDefault)
            ?? grids[0]
            ?? null;
    });

    const pending = computed(() => asyncData.pending.value);
    const allSessions = computed(() => reference.value?.sessions ?? []);
    const violations = computed(() => reference.value?.violations ?? []);

    const onGridSessions = computed(() => (grid.value
        ? allSessions.value.filter((s) => isOnGrid(grid.value as TimeGrid, s))
        : []));

    /** Sessions the grid cannot position — surfaced, never silently dropped. */
    const offGridSessions = computed(() => (grid.value
        ? allSessions.value.filter((s) => !isOnGrid(grid.value as TimeGrid, s))
        : []));

    const violationsBySessionId = computed(() => {
        const map = new Map<string, Violation[]>();

        for (const violation of violations.value) {
            // Skipped, not bucketed under '': an offering-scoped violation
            // belongs to no chip on the grid.
            if (!violation.sessionId) {
                continue;
            }

            const list = map.get(violation.sessionId) ?? [];

            list.push(violation);
            map.set(violation.sessionId, list);
        }

        return map;
    });

    const lookup = {
        room: (id: string) => rooms.value.find((r) => r.id === id)?.name ?? id,
        person: (id: string) => people.value.find((p) => p.id === id)?.name ?? id,
        group: (id: string) => groups.value.find((g) => g.id === id)?.name ?? id,
        /**
         * The group's PARENT name, or null for a root.
         *
         * Group names repeat across a hierarchy — "Seminar A1" means little
         * without "under Class A" — and the nesting is load-bearing rather than
         * decorative: a Session on a cohort blocks every class beneath it, so
         * knowing where a group sits explains why a clash appears somewhere the
         * name alone would not suggest.
         *
         * ONE level only. The full ancestry is available but reads as noise in a
         * side panel, and the immediate parent is what disambiguates.
         *
         * `parentGroupId` already arrives in the /api/groups payload — the type
         * annotation was simply narrowing it away — so this costs no extra
         * request and no permission the page does not already hold.
         */
        groupParent: (id: string): string | null => {
            const parentId = groups.value.find((g) => g.id === id)?.parentGroupId;

            return parentId ? groups.value.find((g) => g.id === parentId)?.name ?? null : null;
        },
    };

    function sessionTitle(id: string): string {
        return allSessions.value.find((s) => s.id === id)?.offering?.title ?? 'Session';
    }

    async function refreshAll() {
        await asyncData.refresh();
    }

    return {
        terms, groups, rooms, people, resolvedTermId,
        term, totalWeeks, grid,
        allSessions, onGridSessions, offGridSessions,
        violations, violationsBySessionId,
        lookup, sessionTitle,
        pending, canReadViolations, refreshAll,
        /** The page awaits this — the one await, at setup top level. */
        ready: asyncData,
    };
}
