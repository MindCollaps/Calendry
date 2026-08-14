/**
 * SOLVER SERVICE BOUNDARY — Step 5, deliberately not implemented.
 *
 * This is the seam where the external solver plugs in. The contract, per
 * TAXONOMY.md §7:
 *
 *   IN   Offerings (demand: frequency, duration, required role/equipment/
 *        capacity, groups), the tenant's TimeGrid and academic calendar, Rooms
 *        with equipment, and the enabled Constraint set with its parameters.
 *        Locked Sessions are passed as immovable fixtures — the solver fills
 *        empty slots and never overwrites a lock.
 *
 *   OUT  Either Session placements (term/week/day/block/room/lecturer/group per
 *        Offering instance), or an infeasibility report explaining which hard
 *        constraints could not be satisfied simultaneously.
 *
 * The result is written as a new Generation with status READY (or INFEASIBLE,
 * with infeasibility_report populated), which the operator then promotes via
 * POST /api/generations/:id/apply. Nothing about the solver's implementation
 * language reaches the Nuxt app: it is an HTTP contract, not a library call.
 */
import { requirePermission } from '../../utils/requirePermission';
import { withRequestTenant } from '../../utils/tenantDb';

export default defineEventHandler(async (event) => {
    // Permission is enforced even though the body is a stub, so the boundary is
    // already locked down when the solver lands behind it.
    await withRequestTenant(event, (tx) => requirePermission(event, tx, 'solver.trigger'));

    throw createError({
        statusCode: 501,
        statusMessage: 'Solver service not implemented — see the solver phase. This route is the interface boundary only.',
    });
});
