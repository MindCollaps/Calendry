import type { EntityRow, ManageEntity } from '~/utils/manageRegistry';
import { entityPermission } from '~/utils/manageRegistry';
import { useHasPermission } from '~/composables/session';

export const ENTITY_PAGE_SIZE = 50;

interface ListResponse {
    rows: EntityRow[];
    total: number;
}

/**
 * Server state for one management list: the current page, the search term, and
 * what came back.
 *
 * OWNERSHIP BOUNDARY: exactly what changes the API query. Column choice,
 * selection and form drafts are not here — they do not change what is fetched.
 *
 * SYNCHRONOUS BY DESIGN. `useRequestFetch()` is taken at setup so SSR forwards
 * the browser's cookie; an `await` in this function would detach everything
 * after it from the Nuxt instance. The page holds the single top-level await on
 * `ready`.
 */
export function useEntityList(entity: ManageEntity) {
    const request = useRequestFetch();

    const pageSize = entity.listPageSize ?? ENTITY_PAGE_SIZE;

    const search = ref('');
    const debouncedSearch = ref('');
    const page = ref(0);

    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    // Typing must not fire a request per keystroke, but the FIRST render has to
    // resolve immediately or SSR would render an empty list and hydrate from it.
    watch(search, (value) => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            page.value = 0;
            debouncedSearch.value = value;
        }, 250);
    });

    onBeforeUnmount(() => clearTimeout(debounceTimer));

    const asyncData = useAsyncData<ListResponse>(
        `manage:${entity.key}`,
        () => request<ListResponse>(`/api/${entity.key}`, {
            query: {
                limit: pageSize,
                offset: page.value * pageSize,
                // Omitted rather than sent empty: the server rejects a blank `q`
                // rather than treating it as "match everything".
                ...(debouncedSearch.value ? { q: debouncedSearch.value } : {}),
            },
        }),
        { watch: [page, debouncedSearch] },
    );

    const rows = computed(() => asyncData.data.value?.rows ?? []);
    const total = computed(() => asyncData.data.value?.total ?? 0);
    const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));

    /**
     * Whether this page holds the ENTIRE set. A tree view is only correct when
     * it does — assembled from a partial page it silently shows roots that are
     * really children whose parent did not come back.
     */
    const isComplete = computed(() => rows.value.length >= total.value);

    /**
     * "No rows at all" and "no rows matching your search" are different facts
     * and must not render the same way — an empty list that could equally mean
     * a broken fetch is the failure this codebase keeps re-learning.
     */
    const isFiltered = computed(() => debouncedSearch.value.length > 0);

    return {
        search,
        page,
        pageCount,
        rows,
        total,
        isFiltered,
        isComplete,
        pageSize,
        pending: computed(() => asyncData.pending.value),
        error: computed(() => asyncData.error.value),
        refresh: () => asyncData.refresh(),
        /** The page awaits this — the one await, at setup top level. */
        ready: asyncData,
    };
}

/**
 * What this caller may do with this entity.
 *
 * UX only, and re-checked server-side on every route. Read is not included:
 * without it the section is not reachable at all, so a component asking "may I
 * read?" would be asking a question that is already answered by being rendered.
 */
export function useEntityPermissions(entity: ManageEntity) {
    const canCreate = useHasPermission(entityPermission(entity, 'create'));
    const canUpdate = useHasPermission(entityPermission(entity, 'update'));
    const canDelete = useHasPermission(entityPermission(entity, 'delete'));

    return { canCreate, canUpdate, canDelete };
}
