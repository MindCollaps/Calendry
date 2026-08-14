/**
 * The fixed permission catalogue (TAXONOMY.md §4).
 *
 * Tenants configure ROLES — named bundles of these — but never the permissions
 * themselves, because each one corresponds to a code path and tenants do not
 * write code. This list is mirrored into the `permission` table by migration so
 * that `access_role_permission` can hold a real foreign key.
 *
 * Adding a permission means: add it here, add it to the migration's catalogue
 * INSERT, and grant it to whichever access roles should have it. Removing one
 * is a breaking change for every tenant that assigned it.
 */
export interface PermissionDef {
    key: string;
    category: string;
    description: string;
}

/** Entities served by the generic CRUD routes, and their permission prefix. */
export const CRUD_RESOURCES = {
    persons: 'person',
    roles: 'role',
    groups: 'group',
    rooms: 'room',
    equipment: 'equipment',
    offerings: 'offering',
    'time-grids': 'time_grid',
    terms: 'term',
    constraints: 'constraint',
} as const;

export type CrudAction = 'read' | 'create' | 'update' | 'delete';

function crudPermissions(): PermissionDef[] {
    const out: PermissionDef[] = [];

    for (const prefix of Object.values(CRUD_RESOURCES)) {
        for (const action of ['read', 'create', 'update', 'delete'] as CrudAction[]) {
            out.push({
                key: `${prefix}.${action}`,
                category: prefix,
                description: `${action} ${prefix.replace('_', ' ')} records`,
            });
        }
    }

    return out;
}

export const PERMISSIONS: PermissionDef[] = [
    ...crudPermissions(),

    // Session editing — explicit verbs, mirroring the routes (TAXONOMY.md §3).
    { key: 'session.read', category: 'session', description: 'View the schedule' },
    { key: 'session.move', category: 'session', description: 'Re-place a Session' },
    { key: 'session.swap', category: 'session', description: 'Swap two Sessions' },
    { key: 'session.lock', category: 'session', description: 'Lock or unlock a Session' },

    // Operations
    { key: 'generation.apply', category: 'generation', description: 'Promote a Generation to the current baseline' },
    { key: 'solver.trigger', category: 'solver', description: 'Request a solver run' },
    { key: 'violation.read', category: 'violation', description: 'View current constraint violations' },
    { key: 'notification.preview', category: 'notification', description: 'Resolve who a Session change affects' },

    // Administration
    { key: 'access_role.manage', category: 'administration', description: 'Create and edit access roles' },
    { key: 'person_access_role.assign', category: 'administration', description: 'Grant or revoke access roles' },
];

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

/** Permission required for a generic CRUD route. */
export function crudPermission(resource: string, action: CrudAction): string {
    const prefix = CRUD_RESOURCES[resource as keyof typeof CRUD_RESOURCES];

    if (!prefix) {
        throw createError({ statusCode: 404, statusMessage: `Unknown resource '${resource}'.` });
    }

    return `${prefix}.${action}`;
}
