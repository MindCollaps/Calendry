import type { H3Event } from 'h3';
import type { Tx } from './tenantDb';

/**
 * Permission enforcement (TAXONOMY.md §4).
 *
 * A Person's permissions are the union of the Permissions carried by every
 * AccessRole assigned to them in the current tenant. Both `person_access_role`
 * and `access_role_permission` are tenant-scoped and behind RLS, so this query
 * runs inside the caller's tenant transaction — a Person cannot pick up an
 * access role belonging to another institution even if the ids were guessed.
 *
 * Deliberately NOT derived from the domain `Role` entity (Lecturer, Student).
 * Those describe what a Person IS for scheduling purposes; these describe what
 * they may DO in the software. See the AccessRole model comment.
 */

/** Permissions held by a Person in the tenant of the current transaction. */
export async function loadPermissions(tx: Tx, personId: string): Promise<Set<string>> {
    const rows = await tx.personAccessRole.findMany({
        where: { personId },
        select: { accessRole: { select: { permissions: { select: { permissionKey: true } } } } },
    });

    const permissions = new Set<string>();

    for (const row of rows) {
        for (const p of row.accessRole.permissions) {
            permissions.add(p.permissionKey);
        }
    }

    return permissions;
}

/**
 * Asserts the caller holds `permission`, throwing 403 otherwise.
 *
 * Cached on the event for the duration of the request: a single handler may
 * check several permissions, and re-querying per check would multiply round
 * trips inside an already-open transaction.
 */
export async function requirePermission(event: H3Event, tx: Tx, permission: string): Promise<void> {
    const identity = requireIdentity(event);

    if (!identity.actorPersonId) {
        throw createError({ statusCode: 403, statusMessage: 'No acting Person on this session.' });
    }

    let held = event.context.permissions as Set<string> | undefined;

    if (!held) {
        held = await loadPermissions(tx, identity.actorPersonId);
        event.context.permissions = held;
    }

    if (!held.has(permission)) {
        // 403 rather than 404: the caller is legitimately inside this tenant, so
        // hiding the existence of the action buys nothing and makes the API
        // hard to use. Cross-TENANT access still reports 404 (see dbErrors).
        throw createError({
            statusCode: 403,
            statusMessage: `Missing permission '${permission}'.`,
        });
    }
}
