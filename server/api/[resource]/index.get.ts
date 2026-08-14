import { mapDbErrors } from '../../utils/dbErrors';
import { delegate, getResource } from '../../utils/resources';
import { crudPermission } from '../../utils/permissions';
import { requirePermission } from '../../utils/requirePermission';
import { withRequestTenant } from '../../utils/tenantDb';

/** List rows of a core entity within the caller's tenant. */
export default defineEventHandler(async (event) => {
    const resource = getRouterParam(event, 'resource');
    const config = getResource(resource);
    const query = await getValidatedQuery(event, config.filters.parse);

    return withRequestTenant(event, async (tx, identity) => {
        await requirePermission(event, tx, crudPermission(resource as string, 'read'));

        const where: Record<string, unknown> = { ...(query as Record<string, unknown>) };

        // minCapacity is a range filter, not an equality one.
        if (where.minCapacity !== undefined) {
            where.capacity = { gte: where.minCapacity };
            delete where.minCapacity;
        }

        // Explicit tenant filter in addition to RLS. RLS makes a mistake here
        // harmless, but defence in depth means not relying on that alone.
        // Federation-ownable entities must also surface shared rows, otherwise a
        // consortium's shared lecture hall would be invisible to its members.
        if (config.federationOwnable) {
            where.OR = [
                { tenantId: identity.tenantId },
                ...(identity.federationId ? [{ federationId: identity.federationId }] : []),
            ];
        } else {
            where.tenantId = identity.tenantId;
        }

        return mapDbErrors(() =>
            delegate(tx, config.model).findMany({ where, orderBy: config.orderBy }),
        );
    });
});
