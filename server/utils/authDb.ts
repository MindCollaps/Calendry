import { hashToken } from './auth';

/**
 * Queries against the PRE-TENANT data plane.
 *
 * Everything here runs on the base Prisma client, deliberately NOT inside
 * `withTenant()`, because these reads happen before the tenant is known. That
 * makes this the one module allowed to touch the database without RLS context —
 * every other server module must go through `withTenant`.
 *
 * The two lookups that need to cross into tenant-scoped tables (`person`,
 * `tenant`) go through the narrow SECURITY DEFINER functions defined in the RLS
 * migration, which are keyed only by a secret the caller already holds.
 */

export interface SessionIdentityRow {
    session_id: string;
    account_id: string;
    person_id: string | null;
    tenant_id: string | null;
    federation_id: string | null;
    expires_at: Date;
    revoked_at: Date | null;
    account_active: boolean;
    person_active: boolean;
}

export interface AccountIdentityRow {
    person_id: string;
    given_name: string;
    family_name: string;
    person_active: boolean;
    tenant_id: string;
    tenant_slug: string;
    tenant_name: string;
    federation_id: string | null;
}

/** Resolves a raw bearer token to its session, or null if it is not usable. */
export async function resolveSessionToken(token: string): Promise<SessionIdentityRow | null> {
    const prisma = getPrisma();
    const rows = await prisma.$queryRaw<SessionIdentityRow[]>`
        SELECT * FROM calendry_internal.session_identity(${hashToken(token)})
    `;

    const row = rows[0];

    if (!row) {
        return null;
    }

    // Expiry, revocation and account deactivation are all checked here rather
    // than in SQL so that a disabled account's session dies on its next request
    // instead of lingering until it expires.
    if (row.revoked_at !== null || row.expires_at.getTime() <= Date.now() || !row.account_active) {
        return null;
    }

    return row;
}

/** The tenants this account can act in. */
export async function listAccountIdentities(accountId: string): Promise<AccountIdentityRow[]> {
    const prisma = getPrisma();

    return prisma.$queryRaw<AccountIdentityRow[]>`
        SELECT * FROM calendry_internal.account_identities(${accountId})
    `;
}

export async function findAccountByEmail(email: string) {
    return getPrisma().account.findUnique({ where: { email: email.toLowerCase() } });
}

export async function createSession(input: {
    accountId: string;
    activePersonId: string | null;
    tokenHash: string;
    expiresAt: Date;
    userAgent?: string | null;
    ipAddress?: string | null;
}) {
    return getPrisma().authSession.create({ data: input });
}

export async function setSessionActivePerson(sessionId: string, personId: string) {
    return getPrisma().authSession.update({
        where: { id: sessionId },
        data: { activePersonId: personId },
    });
}

export async function revokeSession(sessionId: string) {
    return getPrisma().authSession.update({
        where: { id: sessionId },
        data: { revokedAt: new Date() },
    });
}

export async function touchAccountLogin(accountId: string) {
    return getPrisma().account.update({
        where: { id: accountId },
        data: { lastLoginAt: new Date() },
    });
}
