import { z } from 'zod';
import { SESSION_COOKIE, SESSION_TTL_MS, generateSessionToken, hashToken, verifyPassword } from '../../utils/auth';
import { createSession, findAccountByEmail, listAccountIdentities, touchAccountLogin } from '../../utils/authDb';

const bodySchema = z.object({
    email: z.string().email(),
    password: z.string().min(1),
    /** Optional: skip tenant selection when the caller already knows the slug. */
    tenantSlug: z.string().optional(),
});

/**
 * Authenticate an Account and open a session.
 *
 * Login is global, not tenant-scoped: `person.tenant_id` is NOT NULL, so a
 * human working at two institutions has two Person rows, and making Person the
 * credential holder would give them two passwords. The Account owns both; the
 * tenant is chosen afterwards.
 *
 * If the Account maps to exactly one Person the tenant is selected implicitly.
 * Otherwise the session opens with no active Person and the caller must call
 * /api/auth/select-tenant — authenticated, but not yet situated.
 */
export default defineEventHandler(async (event) => {
    const body = await readValidatedBody(event, bodySchema.parse);
    const account = await findAccountByEmail(body.email);

    // Same response shape and roughly the same work for "no such account" and
    // "wrong password", so the endpoint does not become an account-existence
    // oracle. The dummy verify keeps the timing comparable.
    const passwordOk = account
        ? await verifyPassword(body.password, account.passwordHash)
        : await verifyPassword(body.password, 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');

    if (!account || !account.isActive || !passwordOk) {
        throw createError({ statusCode: 401, statusMessage: 'Invalid credentials.' });
    }

    // A forced reset authenticates but issues NO session and NO cookie. The
    // account must clear the flag through /api/auth/change-password first.
    // Deliberately not a "restricted session": every route would then have to
    // know about a half-privileged state, and one that forgot would be a hole.
    if (account.mustChangePassword) {
        return {
            requiresPasswordChange: true,
            tenantSelectionRequired: false,
            activeTenant: null,
            availableTenants: [],
        };
    }

    const identities = (await listAccountIdentities(account.id)).filter((i) => i.person_active);

    if (identities.length === 0) {
        throw createError({
            statusCode: 403,
            statusMessage: 'This account is not active in any tenant.',
        });
    }

    const selected = body.tenantSlug
        ? identities.find((i) => i.tenant_slug === body.tenantSlug)
        : identities.length === 1
            ? identities[0]
            : undefined;

    if (body.tenantSlug && !selected) {
        throw createError({ statusCode: 403, statusMessage: 'No identity in that tenant.' });
    }

    const token = generateSessionToken();

    const session = await createSession({
        accountId: account.id,
        activePersonId: selected?.person_id ?? null,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
        userAgent: getRequestHeader(event, 'user-agent') ?? null,
        ipAddress: getRequestIP(event, { xForwardedFor: true }) ?? null,
    });

    await touchAccountLogin(account.id);

    setCookie(event, SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });

    return {
        sessionId: session.id,
        tenantSelectionRequired: selected === undefined,
        activeTenant: selected
            ? { id: selected.tenant_id, slug: selected.tenant_slug, name: selected.tenant_name }
            : null,
        availableTenants: identities.map((i) => ({
            tenantId: i.tenant_id,
            slug: i.tenant_slug,
            name: i.tenant_name,
        })),
    };
});
