import { fetchSession, isSignedIn, useSession } from '~/composables/session';

/**
 * Route guard: every page needs a session except the ones listed here.
 *
 * Deny-by-default. A new page is protected the moment it is created, rather
 * than protected only once someone remembers to add middleware to it — the
 * same reasoning as the server's fail-closed RLS.
 *
 * This is a convenience, not a security boundary. The API enforces
 * authentication and permissions independently; a user who defeats this
 * middleware reaches a page whose every request still returns 401.
 */
const PUBLIC_ROUTES = ['/login', '/change-password'];

export default defineNuxtRouteMiddleware(async (to) => {
    const session = useSession();

    // Fetch once per navigation cycle; cached across subsequent route changes.
    if (session.value === null) {
        await fetchSession();
    }

    const signedIn = isSignedIn(session.value);
    const isPublic = PUBLIC_ROUTES.includes(to.path);

    if (isPublic) {
        // Already signed in and situated — nothing to do on the login page.
        // A session still awaiting tenant selection must stay, to finish.
        // `?select=1` is the exception: a signed-in user deliberately going back
        // to change institution, which is a session mutation rather than a
        // re-login.
        if (signedIn && to.query.select !== '1') {
            const redirect = typeof to.query.redirect === 'string' ? to.query.redirect : '/';

            // Only internal paths: an open redirect would let a crafted link
            // bounce a freshly authenticated user to another origin.
            return navigateTo(redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : '/');
        }

        return;
    }

    if (!signedIn) {
        return navigateTo({
            path: '/login',
            query: to.fullPath === '/' ? undefined : { redirect: to.fullPath },
        });
    }
});
