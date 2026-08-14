import { z } from 'zod';
import { SESSION_COOKIE } from '../../utils/auth';
import { listAccountIdentities, resolveSessionToken, setSessionActivePerson } from '../../utils/authDb';

const bodySchema = z.object({ tenantId: z.string().min(1) });

/**
 * Choose (or switch) which tenant this session is acting in.
 *
 * The requested tenant is validated against the identities the ACCOUNT actually
 * has — the client names a tenant, but the server decides whether a Person
 * exists there for this account. That check is why a client-supplied tenant is
 * safe here and was not safe as a header in Step 4.
 *
 * Switching is a session mutation rather than a re-login, which is one of the
 * reasons sessions are database-backed rather than JWTs.
 */
export default defineEventHandler(async (event) => {
    const body = await readValidatedBody(event, bodySchema.parse);
    const token = getCookie(event, SESSION_COOKIE);

    if (!token) {
        throw createError({ statusCode: 401, statusMessage: 'Not authenticated.' });
    }

    const session = await resolveSessionToken(token);

    if (!session) {
        throw createError({ statusCode: 401, statusMessage: 'Session expired or revoked.' });
    }

    const identities = await listAccountIdentities(session.account_id);
    const target = identities.find((i) => i.tenant_id === body.tenantId && i.person_active);

    if (!target) {
        // 403, not 404: the tenant may well exist, but this account has no
        // Person there. Reporting "not found" would be a lie.
        throw createError({ statusCode: 403, statusMessage: 'No identity in that tenant.' });
    }

    await setSessionActivePerson(session.session_id, target.person_id);

    return {
        activeTenant: { id: target.tenant_id, slug: target.tenant_slug, name: target.tenant_name },
        activePersonId: target.person_id,
    };
});
