import { mapDbErrors } from '../../utils/dbErrors';
import { delegate, demoteExclusiveSiblings, getResource } from '../../utils/resources';
import { crudPermission } from '../../utils/permissions';
import { requirePermission } from '../../utils/requirePermission';
import { withRequestTenant } from '../../utils/tenantDb';

/** Update one row by id, scoped to the caller's tenant. */
export default defineEventHandler(async (event) => {
    const resource = getRouterParam(event, 'resource');
    const config = getResource(resource);
    const id = getRouterParam(event, 'id');
    const body = await readValidatedBody(event, config.update.parse);

    return withRequestTenant(event, async (tx, identity) => {
        await requirePermission(event, tx, crudPermission(resource as string, 'update'));

        // updateMany, not update: it takes a full where clause, so the tenant
        // predicate is part of the statement. A cross-tenant id updates zero
        // rows instead of throwing something that distinguishes "exists but
        // forbidden" from "does not exist".
        //
        // Reparenting a Group is permitted here; group_closure is rebuilt by the
        // database trigger from Step 3. This route must not touch it.
        const result = await mapDbErrors(async () => {
            // Same transaction as the update below, so the two-defaults state is
            // never observable and a failed update demotes nothing.
            await demoteExclusiveSiblings(
                tx,
                config,
                identity.tenantId,
                body as Record<string, unknown>,
                id,
            );

            return delegate(tx, config.model).updateMany({
                where: { id, tenantId: identity.tenantId },
                data: body as Record<string, unknown>,
            });
        });

        if (result.count === 0) {
            throw createError({ statusCode: 404, statusMessage: 'Not found.' });
        }

        return delegate(tx, config.model).findFirst({ where: { id, tenantId: identity.tenantId } });
    });
});
