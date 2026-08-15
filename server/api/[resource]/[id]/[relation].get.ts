import { mapDbErrors } from '../../../utils/dbErrors';
import { getRelation, relationDelegate } from '../../../utils/relations';
import { crudPermission } from '../../../utils/permissions';
import { requirePermission } from '../../../utils/requirePermission';
import { withRequestTenant } from '../../../utils/tenantDb';

/** The current membership set of one relation, e.g. an Offering's Groups. */
export default defineEventHandler(async (event) => {
    const resource = getRouterParam(event, 'resource');
    const id = getRouterParam(event, 'id');
    const relation = getRouterParam(event, 'relation');
    const config = getRelation(resource, relation);

    return withRequestTenant(event, async (tx, identity) => {
        // Reading a relation is reading the parent. Nothing here needs authority
        // the parent's own list page does not already require.
        await requirePermission(event, tx, crudPermission(config.parent, 'read'));

        return mapDbErrors(() => relationDelegate(tx, config.model).findMany({
            where: {
                [config.parentKey]: id,
                // Redundant with RLS, kept for the same defence-in-depth reason
                // as the list route. Skipped where the column is nullable,
                // because a federation-owned parent's rows carry a NULL tenant
                // and filtering on it would hide them.
                ...(config.tenantColumnNullable ? {} : { tenantId: identity.tenantId }),
            },
            select: config.select,
        }));
    });
});
