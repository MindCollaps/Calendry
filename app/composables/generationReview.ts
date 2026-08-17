import type { NamedRow, TimeGrid } from '~/composables/schedule';

/**
 * Everything the review screen reads and decides with.
 *
 * OWNERSHIP BOUNDARY: one proposal, under review. The preview it is judged by,
 * the week and filters currently being looked at, and the two actions that end
 * the review. It owns no live schedule state — this screen deliberately never
 * shows the applied timetable, because the whole point is that applying has not
 * happened yet.
 *
 * SYNCHRONOUS, like every composable here that calls useAsyncData: an `await`
 * before the last Nuxt-context call detaches everything after it. The page holds
 * the single top-level await.
 */

export type DiffAction = 'create' | 'move' | 'unchanged' | 'delete';

export interface Placement {
    termWeek: number;
    dayOfWeek: number;
    blockIndex: number;
    durationBlocks: number;
}

export interface ReviewPlacement {
    action: DiffAction;
    sessionId: string | null;
    offeringId: string;
    placement: Placement;
    previous: Placement | null;
    roomId: string | null;
    groupIds: string[];
    lecturerIds: string[];
    personIds: string[];
}

export interface ReviewPreview {
    generation: {
        id: string;
        version: number;
        source: string;
        status: string;
        isCurrent: boolean;
        solverMeta: Record<string, unknown> | null;
        createdAt: string;
        appliedAt: string | null;
    };
    run: {
        id: string;
        termId: string;
        status: string;
        terminationReason: string | null;
        reproducible: boolean | null;
        objective: number | null;
        movesEvaluated: string | null;
        elapsedMillis: number | null;
        seed: string | null;
    } | null;
    plan: {
        created: number;
        moved: number;
        unchanged: number;
        deleted: number;
        skippedLocked: number;
        placementsUnmapped: number;
    };
    deletedByOffering: { offeringId: string; title: string; code: string | null; count: number }[];
    violations: {
        current: { hard: number; soft: number; byType: Record<string, number> };
        proposed: {
            hard: number;
            byType: Record<string, number>;
            unmappable: number;
            sessionReferences: number;
        };
    };
    weekSummary: { termWeek: number; created: number; moved: number; unchanged: number; deleted: number }[];
    /** Names for the placements' offerings, served under this route's own gate. */
    offerings: { id: string; title: string; code: string | null }[];
    placements?: ReviewPlacement[];
    computedAt: string;
}

/**
 * Termination reason as a sentence, because the token is the single field that
 * most changes the decision and nobody should have to know what it means.
 *
 * `null` is its own case, not folded into any other: runs captured before Stage
 * 6a have no reason recorded, and claiming reproducibility there would be a
 * guess (see the no-backfill decision in CLAUDE.md).
 */
export function terminationSentence(reason: string | null): string {
    switch (reason) {
        case 'converged':
            return 'Found an optimal solution and stopped.';
        case 'move_budget':
            return 'Ran out of move budget — a longer run may do better.';
        case 'time_budget':
            return 'Ran out of time. Not reproducible — a re-run may differ.';
        case 'cancelled':
            return 'The run was cancelled.';
        default:
            return 'Unknown — this run predates termination capture.';
    }
}

export function useGenerationReview(generationId: string) {
    const request = useRequestFetch();

    const termWeek = ref(1);
    const groupId = ref('');
    const roomId = ref('');
    const personId = ref('');
    /**
     * Default ON. A proposal that moves 12 of 48 sessions renders 36 chips that
     * did not change, and the reviewer has to find the twelve that did.
     */
    const changesOnly = ref(true);

    const summary = useAsyncData(`review-${generationId}`, async () => {
        const preview = await request<ReviewPreview>(`/api/generations/${generationId}/preview`);

        /**
         * Reference data for names: placements carry ids only. Deliberately not
         * useScheduleData(), which also fetches the live sessions this screen
         * must never show.
         *
         * TOLERANT, one fetch at a time. A single 403 inside a `Promise.all`
         * rejects the whole thing and renders a BLANK page — which is exactly
         * what `/api/offerings` did to a viewer, because it requires
         * `offering.read` while this screen is gated on `session.read`. A page
         * must only depend on what its own gate guarantees.
         *
         * Offerings now travel with the preview, under that same gate. The rest
         * degrade to showing ids, which is visibly wrong rather than blank.
         */
        const optional = async <T>(path: string): Promise<T[]> => {
            try {
                return await request<T[]>(path);
            } catch {
                return [];
            }
        };

        const [terms, timeGrids, rooms, persons, groups] = await Promise.all([
            optional<{ id: string; name: string; timeGridId: string | null }>('/api/terms'),
            optional<TimeGrid>('/api/time-grids'),
            optional<{ id: string; name: string; code: string }>('/api/rooms'),
            optional<{ id: string; givenName: string; familyName: string }>('/api/persons'),
            optional<{ id: string; name: string }>('/api/groups'),
        ]);

        return {
            preview, terms, timeGrids, rooms, persons, groups,
            offerings: preview.offerings ?? [],
        };
    });

    const preview = computed(() => summary.data.value?.preview ?? null);
    const plan = computed(() => preview.value?.plan ?? null);

    const term = computed(() => {
        const termId = preview.value?.run?.termId;

        return summary.data.value?.terms.find((t) => t.id === termId) ?? null;
    });

    const grid = computed<TimeGrid | null>(() => {
        const grids = summary.data.value?.timeGrids ?? [];

        return grids.find((g) => g.id === term.value?.timeGridId)
            ?? grids.find((g) => g.isDefault)
            ?? grids[0]
            ?? null;
    });

    const offerings = computed<NamedRow[]>(() => (summary.data.value?.offerings ?? []).map((o) => ({
        id: o.id,
        name: o.code ? `${o.code} · ${o.title}` : o.title,
    })));
    const rooms = computed<NamedRow[]>(() => (summary.data.value?.rooms ?? []).map((r) => ({
        id: r.id, name: `${r.code} · ${r.name}`,
    })));
    const people = computed<NamedRow[]>(() => (summary.data.value?.persons ?? []).map((p) => ({
        id: p.id, name: `${p.givenName} ${p.familyName}`,
    })));
    const groups = computed<NamedRow[]>(() => summary.data.value?.groups ?? []);

    const lookup = {
        offering: (id: string) => offerings.value.find((o) => o.id === id)?.name ?? id,
        room: (id: string) => rooms.value.find((r) => r.id === id)?.name ?? id,
        person: (id: string) => people.value.find((p) => p.id === id)?.name ?? id,
        group: (id: string) => groups.value.find((g) => g.id === id)?.name ?? id,
    };

    /** Placements for the week and filters currently selected. Fetched per week. */
    const weekData = useAsyncData(
        `review-week-${generationId}`,
        () => {
            const query = new URLSearchParams({
                include: 'placements',
                termWeek: String(termWeek.value),
                ...(groupId.value ? { groupId: groupId.value } : {}),
                ...(roomId.value ? { roomId: roomId.value } : {}),
                ...(personId.value ? { personId: personId.value } : {}),
            });

            return request<ReviewPreview>(`/api/generations/${generationId}/preview?${query}`);
        },
        { watch: [termWeek, groupId, roomId, personId] },
    );

    const placements = computed(() => {
        const all = weekData.data.value?.placements ?? [];

        return changesOnly.value ? all.filter((p) => p.action !== 'unchanged') : all;
    });

    const applying = ref(false);
    const actionError = ref<string | null>(null);

    async function apply() {
        applying.value = true;
        actionError.value = null;

        try {
            // Materializing a thousand placements took ~2.7s in verification, so
            // this is a real wait rather than a formality.
            await $fetch(`/api/generations/${generationId}/apply`, { method: 'POST', body: {} });
            await navigateTo('/schedule');
        } catch (e) {
            actionError.value = (e as { statusMessage?: string }).statusMessage ?? 'Could not apply.';
        } finally {
            applying.value = false;
        }
    }

    async function discard() {
        applying.value = true;
        actionError.value = null;

        try {
            await $fetch(`/api/generations/${generationId}/discard`, { method: 'POST', body: {} });
            await navigateTo('/schedule');
        } catch (e) {
            actionError.value = (e as { statusMessage?: string }).statusMessage ?? 'Could not discard.';
        } finally {
            applying.value = false;
        }
    }

    return {
        summary, preview, plan, term, grid,
        offerings, rooms, people, groups, lookup,
        termWeek, groupId, roomId, personId, changesOnly,
        placements, weekPending: computed(() => weekData.pending.value),
        applying, actionError, apply, discard,
        refresh: async () => {
            await summary.refresh();
            await weekData.refresh();
        },
        /** The page awaits this — the one await, at setup top level. */
        ready: summary,
    };
}
