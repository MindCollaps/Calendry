import type { H3Event } from 'h3';
import { SESSION_COOKIE } from './auth';
import { resolveSessionToken } from './authDb';

/**
 * Resolved request identity. Everything downstream — RLS context, explicit
 * tenant filters, event actor attribution, permission checks — reads from this
 * and nothing else.
 */
export interface RequestIdentity {
    tenantId: string;
    federationId: string | null;
    /** Person acting, for SessionEvent attribution and permission lookup. */
    actorPersonId: string | null;
    accountId: string;
    sessionId: string;
}

/**
 * A tenant resolver turns an inbound request into a RequestIdentity, or returns
 * null when identity cannot be established.
 *
 * This indirection exists so that changing how identity works is a one-line
 * change to `activeResolver` rather than a hunt for scattered header or cookie
 * reads. Nothing outside this file may read identity off a request.
 */
export type TenantResolver = (event: H3Event) => Promise<RequestIdentity | null>;

/**
 * Session-cookie resolver.
 *
 * The tenant is derived server-side from the session's active Person — the
 * client supplies only an opaque token and cannot influence which tenant it
 * ends up in. This is what replaced the Step 4 development header resolver,
 * where any caller could assume any tenant simply by setting a header.
 *
 * A session with no active Person (an account with several tenants that has not
 * yet chosen one) resolves to null: authenticated, but not yet situated in a
 * tenant. Those requests are rejected by `requireIdentity` and must call
 * POST /api/auth/select-tenant first.
 */
const sessionCookieResolver: TenantResolver = async (event) => {
    const token = getCookie(event, SESSION_COOKIE);

    if (!token) {
        return null;
    }

    const session = await resolveSessionToken(token);

    if (!session || !session.person_id || !session.tenant_id || !session.person_active) {
        return null;
    }

    return {
        tenantId: session.tenant_id,
        federationId: session.federation_id,
        actorPersonId: session.person_id,
        accountId: session.account_id,
        sessionId: session.session_id,
    };
};

/** The single swap point. Replace this binding to change how identity works. */
const activeResolver: TenantResolver = sessionCookieResolver;

export async function resolveIdentity(event: H3Event): Promise<RequestIdentity | null> {
    return activeResolver(event);
}
