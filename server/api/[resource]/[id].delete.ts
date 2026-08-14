import { mapDbErrors } from '../../utils/dbErrors';
import { delegate, getResource } from '../../utils/resources';
import { crudPermission } from '../../utils/permissions';
import { requirePermission } from '../../utils/requirePermission';
import { withRequestTenant } from '../../utils/tenantDb';

/**
 * Delete one row by id, scoped to the caller's tenant.
 *
 * Deleting a Group that still has children is refused by the database
 * (parent_group_id is ON DELETE RESTRICT), which surfaces as 409. group_closure
 * rows are removed by FK cascade — this route never maintains the closure.
 */
export default defineEventHandler(async (event) => {
    const resource = getRouterParam(event, 'resource');
    const config = getResource(resource);
    const id = getRouterParam(event, 'id');

    return withRequestTenant(event, async (tx, identity) => {
        await requirePermission(event, tx, crudPermission(resource as string, 'delete'));

        const result = await mapDbErrors(() =>
            delegate(tx, config.model).deleteMany({ where: { id, tenantId: identity.tenantId } }),
        );

        if (result.count === 0) {
            throw createError({ statusCode: 404, statusMessage: 'Not found.' });
        }

        setResponseStatus(event, 204);

        return null;
    });
});
