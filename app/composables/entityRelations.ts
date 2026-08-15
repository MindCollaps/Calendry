import type { EntityRow, ManageEntity, RelationDef } from '~/utils/manageRegistry';

export type RelationRow = Record<string, unknown>;

/**
 * The join-table sets on one entity's detail page.
 *
 * OWNERSHIP BOUNDARY: relation membership and the option lists it is chosen
 * from. Not the entity's own scalar fields — that is `useEntityForm`, and the
 * two write to different endpoints.
 *
 * SAVES IMMEDIATELY, one PUT per change
 * -------------------------------------
 * Not part of the form's Save button, deliberately. The entity and each
 * relation are separate endpoints with no shared transaction, so a single Save
 * spanning them could half-succeed: an offering renamed but its groups
 * unchanged, with one error message covering both and no way to tell which
 * landed. Each PUT replaces one whole set atomically, so the worst case is
 * "that one change did not apply", said plainly next to the control.
 *
 * SYNCHRONOUS, and `ready` resolves only after the drafts are seeded — the same
 * shape as useEntityForm, for the same SSR reason (watchers do not flush during
 * SSR, so seeding cannot hang off one).
 */
export function useEntityRelations(entity: ManageEntity, id: string | undefined) {
    const request = useRequestFetch();

    const defs: RelationDef[] = entity.relations ?? [];

    const asyncData = useAsyncData(`manage-relations:${entity.key}:${id ?? 'new'}`, async () => {
        if (!defs.length || !id) {
            return { sets: {} as Record<string, RelationRow[]>, options: {} as Record<string, EntityRow[]> };
        }

        const optionResources = [...new Set([
            ...defs.map((def) => def.resource),
            ...defs.flatMap((def) => (def.extraReference ? [def.extraReference.resource] : [])),
        ])];

        const [sets, options] = await Promise.all([
            Promise.all(defs.map((def) => request<RelationRow[]>(`/api/${entity.key}/${id}/${def.key}`))),
            Promise.all(optionResources.map((resource) => request<EntityRow[]>(`/api/${resource}`))),
        ]);

        return {
            sets: Object.fromEntries(defs.map((def, index) => [def.key, sets[index] ?? []])),
            options: Object.fromEntries(optionResources.map((resource, index) => [resource, options[index] ?? []])),
        };
    });

    /** Working copy per relation, so a failed PUT can be rolled back to the server's truth. */
    const drafts = ref<Record<string, RelationRow[]>>({});
    const busy = ref<Record<string, boolean>>({});
    const errors = ref<Record<string, string>>({});
    const saved = ref<Record<string, boolean>>({});

    function seed() {
        const next: Record<string, RelationRow[]> = {};

        for (const def of defs) {
            next[def.key] = [...(asyncData.data.value?.sets[def.key] ?? [])];
        }

        drafts.value = next;
    }

    const ready = (async () => {
        await asyncData;
        seed();
    })();

    watch(asyncData.data, seed);

    const options = computed(() => asyncData.data.value?.options ?? {});

    function optionsFor(def: RelationDef): EntityRow[] {
        return options.value[def.resource] ?? [];
    }

    function extraOptionsFor(def: RelationDef): EntityRow[] {
        return def.extraReference ? (options.value[def.extraReference.resource] ?? []) : [];
    }

    /** Writes the whole set. The server replaces it in one transaction. */
    async function persist(def: RelationDef, rows: RelationRow[]): Promise<void> {
        if (!id) {
            return;
        }

        const previous = [...(drafts.value[def.key] ?? [])];

        drafts.value = { ...drafts.value, [def.key]: rows };
        busy.value = { ...busy.value, [def.key]: true };
        errors.value = { ...errors.value, [def.key]: '' };
        saved.value = { ...saved.value, [def.key]: false };

        try {
            const result = await request<RelationRow[]>(`/api/${entity.key}/${id}/${def.key}`, {
                method: 'PUT',
                body: rows,
            });

            // Adopt what came BACK, not what was sent: the server is the
            // authority on the resulting set, and a silent divergence between
            // the two is exactly what an optimistic update hides.
            drafts.value = { ...drafts.value, [def.key]: result };
            saved.value = { ...saved.value, [def.key]: true };
        } catch (error) {
            // Roll back rather than leave the UI showing a membership the
            // database refused.
            drafts.value = { ...drafts.value, [def.key]: previous };
            errors.value = {
                ...errors.value,
                [def.key]: (error as { statusMessage?: string }).statusMessage ?? 'Could not save that change.',
            };
        } finally {
            busy.value = { ...busy.value, [def.key]: false };
        }
    }

    function add(def: RelationDef, value: string) {
        const rows = drafts.value[def.key] ?? [];

        if (rows.some((row) => String(row[def.valueKey]) === value)) {
            return;
        }

        void persist(def, [...rows, { [def.valueKey]: value }]);
    }

    function remove(def: RelationDef, value: string) {
        const rows = drafts.value[def.key] ?? [];

        void persist(def, rows.filter((row) => String(row[def.valueKey]) !== value));
    }

    /** Per-row extras: a quantity, or the scheduling role a lecturer fills. */
    function setExtra(def: RelationDef, value: string, key: string, extra: unknown) {
        const rows = drafts.value[def.key] ?? [];

        void persist(def, rows.map((row) => (String(row[def.valueKey]) === value
            ? { ...row, [key]: extra }
            : row)));
    }

    return {
        defs,
        drafts,
        busy,
        errors,
        saved,
        optionsFor,
        extraOptionsFor,
        add,
        remove,
        setExtra,
        pending: computed(() => asyncData.pending.value),
        ready,
    };
}
