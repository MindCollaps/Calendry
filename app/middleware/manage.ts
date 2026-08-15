import { entityPermission, findManageEntity } from '~/utils/manageRegistry';
import { useSession } from '~/composables/session';

/**
 * Guards the /manage/[entity] routes.
 *
 * Two different failures, kept distinguishable on purpose:
 *
 *   unknown section        → 404, because /manage/widgets is a typo, not a
 *                            permission problem, and saying "no access" would
 *                            be a lie that sends the user hunting for a
 *                            permission that does not exist.
 *   no read permission     → redirect to /manage, matching what the navigation
 *                            already shows: the section simply is not there.
 *
 * This is convenience, not enforcement. Every API route re-checks the same
 * permission inside the tenant transaction; defeating this middleware reaches a
 * page whose every request 403s.
 */
export default defineNuxtRouteMiddleware((to) => {
    const entity = findManageEntity(to.params.entity as string);

    if (!entity) {
        return abortNavigation(createError({
            statusCode: 404,
            statusMessage: 'No such management section.',
        }));
    }

    const session = useSession();
    const held = new Set(session.value?.permissions ?? []);

    if (!held.has(entityPermission(entity, 'read'))) {
        return navigateTo('/manage');
    }
});
