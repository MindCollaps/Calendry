import { z } from 'zod';
import type { Tx } from './tenantDb';

/**
 * Registry driving generic CRUD for the nine tenant-scoped core entities.
 *
 * One registry rather than 45 hand-written route files: the tenant-scoping rule
 * is identical for all of them, and duplicating it nine times is nine chances to
 * forget it. The entities with domain-specific behaviour (Session, Generation)
 * are deliberately NOT here — they get explicit verb routes instead.
 */
export interface ResourceConfig {
    /** Prisma delegate name on the transaction client. */
    model: string;
    /** Zod schema for POST bodies, before tenant_id injection. */
    create: z.ZodTypeAny;
    /** Zod schema for PATCH bodies. */
    update: z.ZodTypeAny;
    /** Query-string filters permitted on list. */
    filters: z.ZodTypeAny;
    /** Default ordering for list responses. */
    orderBy: Record<string, 'asc' | 'desc'>;
    /**
     * Text columns the `q` list parameter searches, case-insensitively.
     *
     * An explicit allowlist rather than "every string column": `q` reaches the
     * database as a filter, and letting the client choose the column is how a
     * search box turns into an enumeration tool for fields no screen shows.
     */
    searchFields?: string[];
    /**
     * A boolean column of which at most one row per tenant may be true.
     *
     * Setting it demotes every sibling in the same transaction, because "make
     * this the default" means "and not the others" — that is one intent, not
     * two. Without this, the partial unique index backing the rule turns an
     * ordinary promotion into a 409 that tells the user to go and un-set the
     * other one first.
     *
     * Declared here rather than special-cased in the route so the behaviour is
     * visible next to the entity it applies to, and so the next exclusive flag
     * is a one-line change instead of a second branch.
     */
    exclusiveFlag?: string;
    /**
     * True for entities a Federation can own (TAXONOMY.md §2). Reads may return
     * federation-owned rows, so list queries must not blindly filter
     * `tenant_id = x` or shared resources vanish.
     */
    federationOwnable?: boolean;
}

const id = z.string().min(1);
const optionalId = z.string().min(1).nullish();

export const RESOURCES: Record<string, ResourceConfig> = {
    persons: {
        model: 'person',
        create: z.object({
            externalRef: z.string().nullish(),
            givenName: z.string().min(1),
            familyName: z.string().min(1),
            email: z.string().email().nullish(),
            timezone: z.string().nullish(),
            isActive: z.boolean().optional(),
        }),
        update: z.object({
            externalRef: z.string().nullish(),
            givenName: z.string().min(1).optional(),
            familyName: z.string().min(1).optional(),
            email: z.string().email().nullish(),
            timezone: z.string().nullish(),
            isActive: z.boolean().optional(),
        }),
        filters: z.object({
            isActive: z.coerce.boolean().optional(),
            email: z.string().optional(),
        }),
        orderBy: { familyName: 'asc' },
        searchFields: ['givenName', 'familyName', 'email', 'externalRef'],
    },

    roles: {
        model: 'role',
        create: z.object({
            key: z.string().min(1),
            name: z.string().min(1),
            description: z.string().nullish(),
        }),
        update: z.object({
            name: z.string().min(1).optional(),
            description: z.string().nullish(),
        }),
        filters: z.object({ key: z.string().optional() }),
        orderBy: { key: 'asc' },
        searchFields: ['key', 'name', 'description'],
    },

    groups: {
        model: 'group',
        create: z.object({
            parentGroupId: optionalId,
            name: z.string().min(1),
            description: z.string().nullish(),
            expectedSize: z.number().int().nonnegative().nullish(),
        }),
        update: z.object({
            // Reparenting is allowed; group_closure is rebuilt by the database
            // trigger from Step 3, never by this route.
            parentGroupId: optionalId,
            name: z.string().min(1).optional(),
            description: z.string().nullish(),
            expectedSize: z.number().int().nonnegative().nullish(),
        }),
        filters: z.object({ parentGroupId: z.string().optional() }),
        orderBy: { name: 'asc' },
        searchFields: ['name', 'description'],
    },

    rooms: {
        model: 'room',
        federationOwnable: true,
        create: z.object({
            code: z.string().min(1),
            name: z.string().min(1),
            capacity: z.number().int().nonnegative().optional(),
            location: z.string().nullish(),
            ranking: z.number().int().optional(),
            isVirtual: z.boolean().optional(),
            isActive: z.boolean().optional(),
        }),
        update: z.object({
            code: z.string().min(1).optional(),
            name: z.string().min(1).optional(),
            capacity: z.number().int().nonnegative().optional(),
            location: z.string().nullish(),
            ranking: z.number().int().optional(),
            isVirtual: z.boolean().optional(),
            isActive: z.boolean().optional(),
        }),
        filters: z.object({
            isVirtual: z.coerce.boolean().optional(),
            isActive: z.coerce.boolean().optional(),
            minCapacity: z.coerce.number().int().optional(),
        }),
        orderBy: { code: 'asc' },
        searchFields: ['code', 'name', 'location'],
    },

    equipment: {
        model: 'equipment',
        federationOwnable: true,
        create: z.object({
            key: z.string().min(1),
            name: z.string().min(1),
            description: z.string().nullish(),
        }),
        update: z.object({
            name: z.string().min(1).optional(),
            description: z.string().nullish(),
        }),
        filters: z.object({ key: z.string().optional() }),
        orderBy: { key: 'asc' },
        searchFields: ['key', 'name', 'description'],
    },

    offerings: {
        model: 'offering',
        federationOwnable: true,
        create: z.object({
            termId: id,
            kindId: id,
            code: z.string().nullish(),
            title: z.string().min(1),
            frequency: z.number().int().min(1).optional(),
            durationBlocks: z.number().int().min(1).optional(),
            requiredRoleId: optionalId,
            requiredCapacity: z.number().int().nonnegative().nullish(),
            isActive: z.boolean().optional(),
            notes: z.string().nullish(),
        }),
        update: z.object({
            kindId: id.optional(),
            code: z.string().nullish(),
            title: z.string().min(1).optional(),
            frequency: z.number().int().min(1).optional(),
            durationBlocks: z.number().int().min(1).optional(),
            requiredRoleId: optionalId,
            requiredCapacity: z.number().int().nonnegative().nullish(),
            isActive: z.boolean().optional(),
            notes: z.string().nullish(),
        }),
        filters: z.object({
            termId: z.string().optional(),
            kindId: z.string().optional(),
            isActive: z.coerce.boolean().optional(),
        }),
        orderBy: { title: 'asc' },
        searchFields: ['title', 'code', 'notes'],
    },

    'time-grids': {
        model: 'timeGrid',
        // Backed by the partial unique index time_grid_one_default_per_tenant
        // (migration 20260814120000). The index is the guarantee; this is what
        // makes promoting a grid an ordinary action rather than a 409.
        exclusiveFlag: 'isDefault',
        create: z.object({
            name: z.string().min(1),
            blockLengthMinutes: z.number().int().min(1),
            blocksPerDay: z.number().int().min(1),
            activeDays: z.array(z.number().int().min(1).max(7)).min(1),
            startHour: z.number().int().min(0).max(23).optional(),
            startMinute: z.number().int().min(0).max(59).optional(),
            breakMinutes: z.number().int().min(0).optional(),
            isDefault: z.boolean().optional(),
        }),
        update: z.object({
            name: z.string().min(1).optional(),
            blockLengthMinutes: z.number().int().min(1).optional(),
            blocksPerDay: z.number().int().min(1).optional(),
            activeDays: z.array(z.number().int().min(1).max(7)).min(1).optional(),
            startHour: z.number().int().min(0).max(23).optional(),
            startMinute: z.number().int().min(0).max(59).optional(),
            breakMinutes: z.number().int().min(0).optional(),
            isDefault: z.boolean().optional(),
        }),
        filters: z.object({ isDefault: z.coerce.boolean().optional() }),
        orderBy: { name: 'asc' },
        searchFields: ['name'],
    },

    terms: {
        model: 'term',
        create: z.object({
            name: z.string().min(1),
            startDate: z.coerce.date(),
            endDate: z.coerce.date(),
            timeGridId: optionalId,
        }),
        update: z.object({
            name: z.string().min(1).optional(),
            startDate: z.coerce.date().optional(),
            endDate: z.coerce.date().optional(),
            timeGridId: optionalId,
        }),
        filters: z.object({}),
        orderBy: { startDate: 'desc' },
        searchFields: ['name'],
    },

    constraints: {
        model: 'constraint',
        create: z.object({
            type: z.string().min(1),
            name: z.string().min(1),
            severity: z.enum(['HARD', 'SOFT']),
            // The DB CHECK enforces the HARD/SOFT ↔ weight pairing; this only
            // shapes the input.
            weight: z.number().int().nullish(),
            params: z.record(z.string(), z.unknown()).optional(),
            isEnabled: z.boolean().optional(),
        }),
        update: z.object({
            name: z.string().min(1).optional(),
            severity: z.enum(['HARD', 'SOFT']).optional(),
            weight: z.number().int().nullish(),
            params: z.record(z.string(), z.unknown()).optional(),
            isEnabled: z.boolean().optional(),
        }),
        filters: z.object({
            type: z.string().optional(),
            severity: z.enum(['HARD', 'SOFT']).optional(),
            isEnabled: z.coerce.boolean().optional(),
        }),
        orderBy: { type: 'asc' },
        searchFields: ['type', 'name'],
    },

    'session-kinds': {
        model: 'sessionKind',
        create: z.object({
            key: z.string().min(1),
            name: z.string().min(1),
            // Free-form so a tenant is not boxed into a palette we chose. The
            // schedule chip falls back to a neutral tint when this is null.
            color: z.string().nullish(),
            // Lets the API reject a Group-scoped constraint aimed at a kind that
            // carries no Groups (TAXONOMY.md §9.5).
            requiresGroup: z.boolean().optional(),
        }),
        update: z.object({
            name: z.string().min(1).optional(),
            color: z.string().nullish(),
            requiresGroup: z.boolean().optional(),
        }),
        filters: z.object({ key: z.string().optional() }),
        orderBy: { key: 'asc' },
        searchFields: ['key', 'name'],
    },
};

/**
 * Demotes every other row holding an exclusive flag, when the incoming body
 * sets it.
 *
 * Runs INSIDE the caller's transaction, immediately before the write, so the
 * moment where two rows hold the flag is never observable and a failed write
 * leaves nothing demoted.
 *
 * Only ever demotes — it never promotes, and it does nothing at all when the
 * body does not set the flag to true. Clearing the flag on the last remaining
 * default is therefore allowed: "no default" is a legitimate state (a Term can
 * always name its grid explicitly), and silently refusing to un-set it would be
 * this function inventing a rule the schema does not have.
 */
export async function demoteExclusiveSiblings(
    tx: Tx,
    config: ResourceConfig,
    tenantId: string,
    body: Record<string, unknown>,
    exceptId?: string,
): Promise<void> {
    const flag = config.exclusiveFlag;

    if (!flag || body[flag] !== true) {
        return;
    }

    await delegate(tx, config.model).updateMany({
        where: {
            tenantId,
            [flag]: true,
            ...(exceptId ? { NOT: { id: exceptId } } : {}),
        },
        data: { [flag]: false },
    });
}

export function getResource(name: string | undefined): ResourceConfig {
    const config = name ? RESOURCES[name] : undefined;

    if (!config) {
        throw createError({ statusCode: 404, statusMessage: `Unknown resource '${name}'.` });
    }

    return config;
}

/**
 * Prisma's delegates are a discriminated union that cannot be indexed by a
 * runtime string without losing all typing. The cast is contained here so the
 * rest of the codebase keeps its types.
 */
export function delegate(tx: Tx, model: string) {
    const d = (tx as unknown as Record<string, unknown>)[model];

    if (!d) {
        throw createError({ statusCode: 500, statusMessage: `No Prisma delegate '${model}'.` });
    }

    return d as {
        findMany: (args: unknown) => Promise<unknown[]>;
        count: (args: unknown) => Promise<number>;
        findFirst: (args: unknown) => Promise<unknown>;
        create: (args: unknown) => Promise<unknown>;
        update: (args: unknown) => Promise<unknown>;
        updateMany: (args: unknown) => Promise<{ count: number }>;
        deleteMany: (args: unknown) => Promise<{ count: number }>;
    };
}
