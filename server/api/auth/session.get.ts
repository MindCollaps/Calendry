import { SESSION_COOKIE } from '../../utils/auth';
import { listAccountIdentities, resolveSessionToken } from '../../utils/authDb';
import { loadPermissions } from '../../utils/requirePermission';
import { withTenant } from '../../utils/tenantDb';

/**
 * Who am I, where am I, and what may I do.
 *
 * The permission list is what a client should drive its UI from — hiding a
 * button the caller cannot use. It is emphatically not the enforcement point:
 * every route re-checks server-side, because a client is free to ignore this.
 */
export default defineEventHandler(async (event) => {
    const token = getCookie(event, SESSION_COOKIE);

    if (!token) {
        throw createError({ statusCode: 401, statusMessage: 'Not authenticated.' });
    }

    const session = await resolveSessionToken(token);

    if (!session) {
        throw createError({ statusCode: 401, statusMessage: 'Session expired or revoked.' });
    }

    const identities = await listAccountIdentities(session.account_id);

    const availableTenants = identities.map((i) => ({
        tenantId: i.tenant_id,
        slug: i.tenant_slug,
        name: i.tenant_name,
        personId: i.person_id,
        isActive: i.person_active,
    }));

    if (!session.person_id || !session.tenant_id) {
        return {
            accountId: session.account_id,
            tenantSelectionRequired: true,
            activeTenant: null,
            permissions: [],
            availableTenants,
        };
    }

    const permissions = await withTenant(
        {
            tenantId: session.tenant_id,
            federationId: session.federation_id,
            actorPersonId: session.person_id,
            accountId: session.account_id,
            sessionId: session.session_id,
        },
        (tx) => loadPermissions(tx, session.person_id as string),
    );

    const active = identities.find((i) => i.person_id === session.person_id);

    return {
        accountId: session.account_id,
        tenantSelectionRequired: false,
        activeTenant: active
            ? { id: active.tenant_id, slug: active.tenant_slug, name: active.tenant_name }
            : null,
        activePersonId: session.person_id,
        // Display name for the UI. Comes from the identity lookup that already
        // ran, so this costs no extra query.
        activePerson: active
            ? { id: active.person_id, givenName: active.given_name, familyName: active.family_name }
            : null,
        permissions: [...permissions].sort(),
        availableTenants,
    };
});
