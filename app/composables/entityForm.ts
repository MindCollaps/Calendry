import type { EntityRow, FieldDef, ManageEntity } from '~/utils/manageRegistry';
import { fieldsFor, referencedResources } from '~/utils/manageRegistry';

export type FormMode = 'create' | 'edit';

/**
 * A management form's draft, its validation feedback, and the two writes.
 *
 * OWNERSHIP BOUNDARY: one row being edited. Not the list it came from, not
 * permissions (the page decides which affordances to render), not navigation.
 *
 * SYNCHRONOUS, for the same reason as every other data composable here — the
 * page holds the await. See CLAUDE.md.
 */
export function useEntityForm(entity: ManageEntity, mode: FormMode, id?: string) {
    const request = useRequestFetch();

    /**
     * Two different lists, and conflating them was a bug.
     *
     * `fields`   — what this mode may EDIT and SEND. Drops `createOnly` fields
     *              on edit, because the server's update schema omits them.
     * `seeded`   — what the draft HOLDS. Everything, including `createOnly`,
     *              because a bespoke detail component still has to display
     *              them: the constraint builder shows which rule a constraint
     *              is, and with `type` missing from the draft it rendered "—"
     *              for a row that plainly has one.
     *
     * Sending is filtered, not seeding. The reverse loses data on screen.
     */
    const fields = fieldsFor(entity, mode);
    const seeded = entity.fields;

    /**
     * The row plus every reference list the form's selects need, in one wave.
     * Fetching references separately would let the form render a select whose
     * options have not arrived, which reads as "there are none".
     */
    const asyncData = useAsyncData(`manage-form:${entity.key}:${id ?? 'new'}`, async () => {
        const resources = referencedResources(entity);

        const [row, ...referenceLists] = await Promise.all([
            mode === 'edit' && id
                ? request<EntityRow>(`/api/${entity.key}/${id}`)
                : Promise.resolve(null),
            ...resources.map((resource) => request<EntityRow[]>(`/api/${resource}`)),
        ]);

        const references: Record<string, EntityRow[]> = {};

        resources.forEach((resource, index) => {
            references[resource] = (referenceLists[index] ?? []) as EntityRow[];
        });

        return { row: row as EntityRow | null, references };
    });

    const row = computed(() => asyncData.data.value?.row ?? null);
    const references = computed(() => asyncData.data.value?.references ?? {});

    const draft = ref<Record<string, unknown>>({});
    const fieldErrors = ref<Record<string, string>>({});
    const formError = ref('');
    const busy = ref(false);

    /** Snapshot taken when the draft is seeded, so "dirty" is a real comparison. */
    const pristine = ref('');

    function seed() {
        const next: Record<string, unknown> = {};

        for (const field of seeded) {
            next[field.key] = toInputValue(field, row.value?.[field.key]);
        }

        draft.value = next;
        pristine.value = JSON.stringify(next);
        fieldErrors.value = {};
        formError.value = '';
    }

    /**
     * Seeding is driven by the PROMISE, not by a watcher.
     *
     * Vue does not flush watchers during SSR. A `watch(data, seed, { immediate:
     * true })` therefore ran exactly once on the server — at setup, when the
     * fetch had not resolved and `row` was still null — and never again. The
     * server rendered every edit form with empty controls, the client re-seeded
     * on hydration, and the result was a hydration mismatch plus a visible flash
     * of a blank form over a record that has data.
     *
     * That failure was invisible to a check that counts inputs rather than
     * reading their values, which is how it survived a phase.
     *
     * Awaiting the handle and seeding after it resolves works identically on
     * both sides. The watcher is kept for CLIENT-side refreshes, where a
     * re-fetch should replace the draft with the server's normalised values.
     */
    const ready = (async () => {
        await asyncData;
        seed();
    })();

    watch(asyncData.data, seed);

    const isDirty = computed(() => JSON.stringify(draft.value) !== pristine.value);

    /**
     * Federation-owned rows are readable but never writable: the RLS write
     * policy is tenant-only, so a save would fail at the database no matter what
     * the UI allowed. Better to not offer it.
     */
    const isForeignOwned = computed(() => Boolean(
        entity.federationOwnable && row.value && !row.value.tenantId && row.value.federationId,
    ));

    const isSystemRow = computed(() => Boolean(
        entity.systemFlag && row.value?.[entity.systemFlag],
    ));

    async function save(): Promise<string | null> {
        if (busy.value) {
            return null;
        }

        busy.value = true;
        fieldErrors.value = {};
        formError.value = '';

        try {
            const body: Record<string, unknown> = {};

            for (const field of fields) {
                body[field.key] = toPayloadValue(field, draft.value[field.key]);
            }

            const saved = mode === 'create'
                ? await request<EntityRow>(`/api/${entity.key}`, { method: 'POST', body })
                : await request<EntityRow>(`/api/${entity.key}/${id}`, { method: 'PATCH', body });

            pristine.value = JSON.stringify(draft.value);

            return String(saved.id ?? id ?? '');
        } catch (error) {
            applyError(error);

            return null;
        } finally {
            busy.value = false;
        }
    }

    async function remove(): Promise<boolean> {
        if (busy.value || !id) {
            return false;
        }

        busy.value = true;
        formError.value = '';

        try {
            await request(`/api/${entity.key}/${id}`, { method: 'DELETE' });

            return true;
        } catch (error) {
            applyError(error);

            return false;
        } finally {
            busy.value = false;
        }
    }

    /**
     * Turns a server rejection into something attached to the field that caused
     * it. A 400 from `readValidatedBody` carries the zod issues; a 409 from a
     * unique index or an FK RESTRICT carries only a sentence, and that belongs
     * at the top of the form rather than guessed onto a field.
     */
    function applyError(error: unknown) {
        const e = error as {
            statusMessage?: string;
            statusCode?: number;
            data?: {
                name?: string;
                message?: string;
                statusMessage?: string;
                data?: { issues?: unknown };
                issues?: unknown;
            };
        };

        const issues = extractIssues(e.data);

        if (issues.length) {
            const mapped: Record<string, string> = {};

            for (const issue of issues) {
                const key = String(issue.path[0] ?? '');

                if (key && !mapped[key]) {
                    mapped[key] = issue.message;
                }
            }

            fieldErrors.value = mapped;

            // An issue on a field this form does not render would otherwise be
            // invisible — the user would see a failed save with nothing marked.
            const orphaned = issues.filter((issue) => !fields.some((f) => f.key === issue.path[0]));

            if (orphaned.length) {
                formError.value = orphaned.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
            } else {
                formError.value = 'Some fields need attention.';
            }

            return;
        }

        formError.value = e.data?.statusMessage
            ?? e.statusMessage
            ?? e.data?.message
            ?? 'Could not save. Please try again.';
    }

    return {
        fields,
        draft,
        row,
        references,
        fieldErrors,
        formError,
        busy,
        isDirty,
        isForeignOwned,
        isSystemRow,
        save,
        remove,
        reset: seed,
        pending: computed(() => asyncData.pending.value),
        /**
         * The page awaits this — the one await, at setup top level. Resolves
         * only once the draft has been seeded, so the first render already has
         * the record's values.
         */
        ready,
    };
}

interface Issue { path: (string | number)[]; message: string }

/**
 * Pulls zod issues out of an h3 validation error.
 *
 * The shape is not obvious and was verified against a live 400 rather than
 * assumed: `readValidatedBody` puts the ZodError in `data`, and serialising it
 * across the wire flattens it to `{ name: 'ZodError', message: '<JSON array>' }`
 * — the issues survive only as a JSON *string* inside `message`. Reading
 * `data.issues` (the shape it has server-side) finds nothing, and the form
 * silently degrades to "Some fields need attention" with no field marked.
 *
 * Both shapes are accepted so this keeps working if h3 or zod stops flattening.
 */
function extractIssues(data: unknown): Issue[] {
    if (!data || typeof data !== 'object') {
        return [];
    }

    const container = data as { name?: string; message?: unknown; issues?: unknown; data?: { issues?: unknown } };

    const candidates: unknown[] = [container.issues, container.data?.issues];

    if (container.name === 'ZodError' && typeof container.message === 'string') {
        try {
            candidates.push(JSON.parse(container.message));
        } catch {
            // Not JSON after all — fall through to the generic message.
        }
    }

    const raw = candidates.find(Array.isArray);

    if (!Array.isArray(raw)) {
        return [];
    }

    return raw
        .filter((issue): issue is Issue => Boolean(
            issue && typeof issue === 'object' && Array.isArray((issue as Issue).path),
        ))
        .map((issue) => ({ path: issue.path, message: String(issue.message ?? 'Invalid value') }));
}

/** Server value → what the control binds to. */
function toInputValue(field: FieldDef, value: unknown): unknown {
    if (field.type === 'boolean') {
        return value ?? false;
    }

    if (field.type === 'date') {
        // `<input type="date">` accepts only yyyy-mm-dd; the API returns a full
        // ISO timestamp, which the control silently refuses to display.
        return typeof value === 'string' ? value.slice(0, 10) : '';
    }

    if (field.type === 'number') {
        return value ?? null;
    }

    // A structured value is never coerced to a string. Falling through to
    // `value ?? ''` turned an absent `params` into '', which the API then
    // rejected as "expected object, received null" — an error about a field the
    // user never touched.
    if (field.type === 'json') {
        return value ?? {};
    }

    return value ?? '';
}

/** Control value → what the API receives. */
function toPayloadValue(field: FieldDef, value: unknown): unknown {
    if (field.type === 'boolean') {
        return Boolean(value);
    }

    if (field.type === 'json') {
        return value && typeof value === 'object' ? value : {};
    }

    if (field.type === 'number') {
        if (value === '' || value === null || value === undefined) {
            return null;
        }

        return Number(value);
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();

        // Empty means "unset", not "the empty string" — sending '' to a nullable
        // email column fails its format check instead of clearing it.
        if (trimmed === '') {
            return field.required ? '' : null;
        }

        return trimmed;
    }

    return value ?? null;
}
