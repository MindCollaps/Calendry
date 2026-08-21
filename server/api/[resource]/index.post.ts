import { mapDbErrors } from '../../utils/dbErrors';
import { delegate, demoteExclusiveSiblings, getResource, splitChildren } from '../../utils/resources';
import { crudPermission } from '../../utils/permissions';
import { requirePermission } from '../../utils/requirePermission';
import { withRequestTenant } from '../../utils/tenantDb';

/** Create a row owned by the caller's tenant. */
export default defineEventHandler(async (event) => {
    const resource = getRouterParam(event, 'resource');
    const config = getResource(resource);
    const body = await readValidatedBody(event, config.create.parse);

    return withRequestTenant(event, async (tx, identity) => {
        await requirePermission(event, tx, crudPermission(resource as string, 'create'));

        // tenant_id comes from resolved identity, never from the request body —
        // otherwise a caller could mint rows into another tenant. The RLS WITH
        // CHECK clause would reject that anyway; this makes it unrepresentable.
        //
        // Federation-owned rows are deliberately NOT creatable here: TAXONOMY.md
        // §2 treats shared resources as a privileged path, and the RLS write
        // policy only permits tenant-owned writes.
        const { columns, children } = splitChildren(config, body as Record<string, unknown>);
        const data = { ...columns, tenantId: identity.tenantId };

        const created = await mapDbErrors(async () => {
            // Creating a row that claims an exclusive flag demotes the incumbent,
            // in this transaction. Without it, "create this as the default" is a
            // 409 telling the user to go and edit a different row first.
            await demoteExclusiveSiblings(tx, config, identity.tenantId, data);

            const row = await delegate(tx, config.model).create({ data }) as { id: string };

            if (config.writeChildren && Object.keys(children).length) {
                await config.writeChildren({ tx, tenantId: identity.tenantId, id: row.id, children });
            }

            return row;
        });

        setResponseStatus(event, 201);

        return created;
    });
});
