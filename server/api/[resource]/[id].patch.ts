import { mapDbErrors } from '../../utils/dbErrors';
import { delegate, demoteExclusiveSiblings, getResource, splitChildren } from '../../utils/resources';
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
        // Entity-specific refusal, inside the same transaction, before
        // anything is written. Throwing here leaves the row untouched.
        await config.beforeUpdate?.({
            tx,
            tenantId: identity.tenantId,
            id: id as string,
            patch: body as Record<string, unknown>,
        });

        const { columns, children } = splitChildren(config, body as Record<string, unknown>);

        const result = await mapDbErrors(async () => {
            // Same transaction as the update below, so the two-defaults state is
            // never observable and a failed update demotes nothing.
            await demoteExclusiveSiblings(
                tx,
                config,
                identity.tenantId,
                columns,
                id,
            );

            const updated = await delegate(tx, config.model).updateMany({
                where: { id, tenantId: identity.tenantId },
                data: columns,
            });

            // Same transaction: a grid whose blocks moved but whose breaks did
            // not is a timetable nobody chose.
            if (updated.count > 0 && config.writeChildren && Object.keys(children).length) {
                await config.writeChildren({ tx, tenantId: identity.tenantId, id: id as string, children });
            }

            return updated;
        });

        if (result.count === 0) {
            throw createError({ statusCode: 404, statusMessage: 'Not found.' });
        }

        return delegate(tx, config.model).findFirst({ where: { id, tenantId: identity.tenantId } });
    });
});
