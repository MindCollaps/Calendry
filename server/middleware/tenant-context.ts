import { resolveIdentity } from '../utils/tenantResolver';

/** Paths that must work without an established tenant identity. */
const PUBLIC_API_PATHS = [
    '/api/auth/login',
    '/api/auth/logout',
    '/api/auth/session',
    '/api/auth/select-tenant',
    // Must be public: a forced reset issues no session, so requiring one here
    // would make the flag unclearable and lock the account out permanently.
    // The handler re-authenticates from the credentials in the body instead.
    '/api/auth/change-password',
];

/**
 * Attaches request identity to `event.context.identity` for /api routes.
 *
 * Authentication is enforced here for everything except the auth endpoints
 * themselves, which have to be reachable before a tenant exists on the session
 * (login) or when it never will (logout). Those four handle their own checks.
 *
 * Authorization is not done here — permissions are per-route and need an open
 * tenant transaction to read, so `requirePermission` runs inside the handler.
 */
export default defineEventHandler(async (event) => {
    const path = (event.path ?? '').split('?')[0] ?? '';

    if (!path.startsWith('/api/')) {
        return;
    }

    const identity = await resolveIdentity(event);

    if (identity) {
        event.context.identity = identity;

        return;
    }

    if (!PUBLIC_API_PATHS.includes(path)) {
        throw createError({ statusCode: 401, statusMessage: 'Authentication required.' });
    }
});
