import { z } from 'zod';
import type { Tx } from './tenantDb';

/**
 * Registry for the join tables hanging off a core entity.
 *
 * WHY THESE ARE NOT IN `RESOURCES`
 * --------------------------------
 * A membership row is not an independent record. `offering_group` has no
 * identity of its own, nobody links to one, and nothing means anything about it
 * except "this Offering involves that Group". Giving it its own CRUD surface
 * would invite the UI to treat it as a thing, when what the user actually edits
 * is a SET on the parent: pick the groups this offering is for.
 *
 * SO THE VERB IS PUT-SET, NOT POST/DELETE PER ROW
 * -----------------------------------------------
 * `PUT /api/offerings/:id/groups` replaces the whole collection in one
 * transaction. This matches how a multi-select is actually used, it is
 * idempotent, and it removes an entire class of half-applied state: with
 * per-row calls, a form that adds two and removes one is three requests that
 * can partially fail, leaving a relation set nobody chose.
 *
 * PERMISSION IS THE PARENT'S `.update`
 * ------------------------------------
 * Changing which rooms an Offering needs IS editing the Offering. A separate
 * `offering_equipment.update` permission would be authority over a table rather
 * than over a decision, which is not how the catalogue is organised.
 */
export interface RelationConfig {
    /** Parent resource segment, e.g. 'offerings'. Must exist in RESOURCES. */
    parent: string;
    /** Prisma delegate for the PARENT, used to verify it exists in this tenant. */
    parentModel: string;
    /** Prisma delegate for the join table. */
    model: string;
    /** Column holding the parent's id on the join table. */
    parentKey: string;
    /**
     * Zod schema for ONE item of the replacement set, without tenant_id or the
     * parent key — both are supplied by the server.
     */
    item: z.ZodTypeAny;
    /** Columns returned on GET, in addition to the parent key. */
    select: Record<string, boolean>;
    /**
     * True when the join table has no `tenant_id` column of its own.
     * `room_equipment` is the odd one out: its tenant column is nullable because
     * a federation-owned Room has no owning tenant.
     */
    tenantColumnNullable?: boolean;
}

const id = z.string().min(1);

export const RELATIONS: Record<string, RelationConfig> = {
    'offerings/groups': {
        parent: 'offerings',
        parentModel: 'offering',
        model: 'offeringGroup',
        parentKey: 'offeringId',
        item: z.object({ groupId: id }),
        select: { groupId: true },
    },

    'offerings/lecturers': {
        parent: 'offerings',
        parentModel: 'offering',
        model: 'offeringLecturer',
        parentKey: 'offeringId',
        // roleId is the SCHEDULING role this person fills here (TAXONOMY.md §2),
        // not an access role. Nullable: many kinds do not constrain it.
        item: z.object({ personId: id, roleId: id.nullish() }),
        select: { personId: true, roleId: true },
    },

    'offerings/equipment': {
        parent: 'offerings',
        parentModel: 'offering',
        model: 'offeringEquipment',
        parentKey: 'offeringId',
        item: z.object({ equipmentId: id, quantity: z.number().int().positive().nullish() }),
        select: { equipmentId: true, quantity: true },
    },

    'rooms/equipment': {
        parent: 'rooms',
        parentModel: 'room',
        model: 'roomEquipment',
        parentKey: 'roomId',
        item: z.object({ equipmentId: id, quantity: z.number().int().positive().nullish() }),
        select: { equipmentId: true, quantity: true },
        tenantColumnNullable: true,
    },

    'persons/roles': {
        parent: 'persons',
        parentModel: 'person',
        model: 'personRole',
        parentKey: 'personId',
        item: z.object({ roleId: id }),
        select: { roleId: true },
    },

    'persons/groups': {
        parent: 'persons',
        parentModel: 'person',
        model: 'membership',
        parentKey: 'personId',
        item: z.object({ groupId: id }),
        select: { groupId: true },
    },

    'constraints/scopes': {
        parent: 'constraints',
        parentModel: 'constraint',
        model: 'constraintScope',
        parentKey: 'constraintId',
        // Either narrows the constraint; both null would mean "everything",
        // which is already what having no scope rows means.
        item: z.object({ offeringId: id.nullish(), kindId: id.nullish() })
            .refine((v) => Boolean(v.offeringId) || Boolean(v.kindId), {
                message: 'A scope must name an offering, a kind, or both.',
            }),
        select: { offeringId: true, kindId: true },
    },
};

export function getRelation(parent: string | undefined, relation: string | undefined): RelationConfig {
    const config = parent && relation ? RELATIONS[`${parent}/${relation}`] : undefined;

    if (!config) {
        throw createError({
            statusCode: 404,
            statusMessage: `Unknown relation '${parent}/${relation}'.`,
        });
    }

    return config;
}

/** Same containment reasoning as `delegate` in resources.ts. */
export function relationDelegate(tx: Tx, model: string) {
    const d = (tx as unknown as Record<string, unknown>)[model];

    if (!d) {
        throw createError({ statusCode: 500, statusMessage: `No Prisma delegate '${model}'.` });
    }

    return d as {
        findMany: (args: unknown) => Promise<unknown[]>;
        deleteMany: (args: unknown) => Promise<{ count: number }>;
        createMany: (args: unknown) => Promise<{ count: number }>;
    };
}
