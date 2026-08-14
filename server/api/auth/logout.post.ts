import { SESSION_COOKIE } from '../../utils/auth';
import { resolveSessionToken, revokeSession } from '../../utils/authDb';

/**
 * End the current session.
 *
 * Revokes server-side rather than merely clearing the cookie, so a copied token
 * stops working too. Immediate revocation is the main reason sessions are
 * database-backed instead of JWTs.
 */
export default defineEventHandler(async (event) => {
    const token = getCookie(event, SESSION_COOKIE);

    if (token) {
        const session = await resolveSessionToken(token);

        if (session) {
            await revokeSession(session.session_id);
        }
    }

    deleteCookie(event, SESSION_COOKIE, { path: '/' });

    // Idempotent: logging out without a session is a success, not an error.
    setResponseStatus(event, 204);

    return null;
});
