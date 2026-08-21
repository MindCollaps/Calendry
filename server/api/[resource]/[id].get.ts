import { mapDbErrors } from '../../utils/dbErrors';
import { delegate, getResource } from '../../utils/resources';
import { crudPermission } from '../../utils/permissions';
import { requirePermission } from '../../utils/requirePermission';
import { withRequestTenant } from '../../utils/tenantDb';

/** Fetch one row by id, scoped to the caller's tenant. */
export default defineEventHandler(async (event) => {
    const resource = getRouterParam(event, 'resource');
    const config = getResource(resource);
    const id = getRouterParam(event, 'id');

    return withRequestTenant(event, async (tx, identity) => {
        await requirePermission(event, tx, crudPermission(resource as string, 'read'));

        // findFirst with an explicit tenant predicate rather than findUnique by
        // id: a guessed id from another tenant must read as "not found", not as
        // a permission error that confirms the row exists.
        const where: Record<string, unknown> = { id };

        if (config.federationOwnable) {
            where.OR = [
                { tenantId: identity.tenantId },
                ...(identity.federationId ? [{ federationId: identity.federationId }] : []),
            ];
        } else {
            where.tenantId = identity.tenantId;
        }

        const row = await mapDbErrors(() => delegate(tx, config.model).findFirst({ where, include: config.include }));

        if (!row) {
            throw createError({ statusCode: 404, statusMessage: 'Not found.' });
        }

        return row;
    });
});
