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
    },

    'time-grids': {
        model: 'timeGrid',
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
    },
};

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
        findFirst: (args: unknown) => Promise<unknown>;
        create: (args: unknown) => Promise<unknown>;
        update: (args: unknown) => Promise<unknown>;
        updateMany: (args: unknown) => Promise<{ count: number }>;
        deleteMany: (args: unknown) => Promise<{ count: number }>;
    };
}
