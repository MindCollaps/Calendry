import { z } from 'zod';
import { SolverOutput } from '@mindcollaps/calendry-proto';
import {
    planMaterialization, summarizePlanByWeek, summarizeProposedViolations,
} from '../../../utils/generationMaterialize';
import type { MaterializationPlan } from '../../../utils/generationMaterialize';
import { GENERATION_SELECT, runSummaryFor } from '../../../utils/generationRead';
import { requirePermission } from '../../../utils/requirePermission';
import { withRequestTenant } from '../../../utils/tenantDb';
import type { Tx } from '../../../utils/tenantDb';

/**
 * What applying this Generation would do — computed, never written.
 *
 * THE POINT OF THIS ROUTE is that it does not compute its own answer. It calls
 * `planMaterialization()`, the same function the apply then executes, so the
 * numbers shown here are the decision the apply carries out rather than a
 * second opinion that happens to agree today.
 *
 * IT IS A SNAPSHOT, NOT A PROMISE. A manual edit between preview and apply
 * legitimately changes the outcome, which is what `computedAt` is for.
 *
 * Gated by `session.read` — see index.get.ts.
 */
const querySchema = z.object({
    include: z.enum(['placements']).optional(),
    termWeek: z.coerce.number().int().optional(),
    groupId: z.string().optional(),
    roomId: z.string().optional(),
    personId: z.string().optional(),
});

export default defineEventHandler(async (event) => {
    const id = getRouterParam(event, 'id');
    const query = await getValidatedQuery(event, querySchema.parse);

    return withRequestTenant(
        event,
        async (tx, identity) => {
            await requirePermission(event, tx, 'session.read');

            const generation = await tx.generation.findFirst({
                where: { id, tenantId: identity.tenantId },
                select: GENERATION_SELECT,
            });

            if (!generation) {
                throw createError({ statusCode: 404, statusMessage: 'Not found.' });
            }

            const run = await runSummaryFor(tx, identity.tenantId, generation.id);

            const stored = run
                ? await tx.solverRun.findFirst({
                    where: { tenantId: identity.tenantId, generationId: generation.id },
                    select: { termId: true, result: true, scope: true },
                })
                : null;

            /**
             * A Generation with no run, or a run whose result was never
             * captured, has nothing to preview. Returned as an empty plan with
             * `run: null` rather than a 404 or an error: a manual baseline is a
             * real Generation that simply proposes no changes, and the review
             * screen should say so plainly.
             */
            if (!stored?.result) {
                return {
                    generation,
                    run,
                    plan: emptyCounts(),
                    deletedByOffering: [],
                    violations: {
                        current: await summarizeCurrentViolations(tx, identity.tenantId, stored?.termId),
                        proposed: { hard: 0, byType: {}, unmappable: 0, sessionReferences: 0 },
                    },
                    weekSummary: [],
                    offerings: [],
                    placements: query.include === 'placements' ? [] : undefined,
                    computedAt: new Date().toISOString(),
                };
            }

            const output = SolverOutput.fromJSON(stored.result);
            const scope = (stored.scope ?? {}) as { offeringIds?: string[] };

            const plan = await planMaterialization(tx, {
                tenantId: identity.tenantId,
                termId: stored.termId,
                output,
                scopeOfferingIds: scope.offeringIds ?? [],
            });

            return {
                generation,
                run,
                plan: plan.counts,
                // The destructive change gets a name, not just a number: a
                // deletion means the solver REFUSED to place that Session, and
                // "8 deleted" is not something a human can act on.
                deletedByOffering: await deletedByOffering(tx, identity.tenantId, plan),
                violations: {
                    current: await summarizeCurrentViolations(tx, identity.tenantId, stored.termId),
                    proposed: summarizeProposedViolations(output.hardViolations),
                },
                // Where the changes are, so a nineteen-week term does not have
                // to be clicked through week by week to find the three that moved.
                weekSummary: summarizePlanByWeek(plan),
                /**
                 * Offering names travel WITH the preview rather than being
                 * fetched separately from /api/offerings.
                 *
                 * That endpoint requires `offering.read`, which this route's
                 * own gate (`session.read`) does not imply — a viewer with
                 * session.read got a 403 that rejected the page's whole
                 * reference fetch and rendered a blank screen. A page must
                 * only depend on what its own permission gate guarantees.
                 */
                offerings: await tx.offering.findMany({
                    where: { tenantId: identity.tenantId, termId: stored.termId },
                    select: { id: true, title: true, code: true },
                }),
                placements: query.include === 'placements'
                    ? filterPlacements(plan, query)
                    : undefined,
                computedAt: new Date().toISOString(),
            };
        },
        // Planning reads every Session and Offering in the term; a large tenant
        // will exceed the 5s default exactly as the apply does.
        { timeoutMs: 120_000 },
    );
});

function emptyCounts() {
    return {
        created: 0, moved: 0, unchanged: 0, deleted: 0,
        skippedLocked: 0, placementsUnmapped: 0,
    };
}

/**
 * Violations on the schedule as it stands, so the review screen can show a
 * DELTA rather than an absolute the reader has no baseline for.
 *
 * Computed here rather than left to a second client fetch: two independently
 * scoped requests would silently compare different populations, and a delta
 * between mismatched populations is worse than no delta.
 */
async function summarizeCurrentViolations(tx: Tx, tenantId: string, termId: string | undefined) {
    const rows = await tx.constraintViolation.findMany({
        where: {
            tenantId,
            ...(termId
                ? {
                    OR: [
                        { session: { termId } },
                        { offering: { termId } },
                    ],
                }
                : {}),
        },
        select: { severity: true, detail: true },
    });

    const byType: Record<string, number> = {};
    let hard = 0;
    let soft = 0;

    for (const row of rows) {
        if (row.severity === 'HARD') {
            hard++;
        } else {
            soft++;
        }

        const detail = (row.detail ?? {}) as { constraintType?: string; reason?: string };
        const key = detail.constraintType ?? detail.reason ?? 'unknown';

        byType[key] = (byType[key] ?? 0) + 1;
    }

    return { hard, soft, byType };
}

/** Which Offerings lose Sessions, and how many each. */
async function deletedByOffering(tx: Tx, tenantId: string, plan: MaterializationPlan) {
    if (!plan.deletes.length) {
        return [];
    }

    const counts = new Map<string, number>();

    for (const del of plan.deletes) {
        counts.set(del.offeringId, (counts.get(del.offeringId) ?? 0) + 1);
    }

    const offerings = await tx.offering.findMany({
        where: { tenantId, id: { in: [...counts.keys()] } },
        select: { id: true, title: true, code: true },
    });

    return offerings
        .map((offering) => ({
            offeringId: offering.id,
            title: offering.title,
            code: offering.code,
            count: counts.get(offering.id) ?? 0,
        }))
        .sort((a, b) => b.count - a.count);
}

/**
 * Placements for one week, filtered like `/api/sessions` is.
 *
 * The grid renders a week at a time, and the full output can be ~1000
 * placements, so the header must not pay for the grid's payload.
 *
 * Group/room/person filters match the placement's OWN ids rather than resolving
 * nested groups: a proposal's placements are not rows yet, so there is nothing
 * to join against. Nested-group filtering is a 6c concern if it proves needed.
 */
function filterPlacements(plan: MaterializationPlan, query: {
    termWeek?: number;
    groupId?: string;
    roomId?: string;
    personId?: string;
}) {
    const matches = (ids: string[], wanted: string | undefined) => !wanted || ids.includes(wanted);

    const placements = plan.placements.filter((p) => (
        (query.termWeek === undefined || p.placement.termWeek === query.termWeek)
        && matches(p.groupIds, query.groupId)
        && (!query.roomId || p.roomId === query.roomId)
        && matches([...p.lecturerIds, ...p.personIds], query.personId)
    ));

    // Deletions belong in the same view — a Session vanishing from Monday is a
    // change the reviewer needs to see, and it has a placement to show it at.
    const deletes = plan.deletes.filter((d) => (
        query.termWeek === undefined || d.placement.termWeek === query.termWeek
    ));

    return [
        ...placements,
        ...deletes.map((d) => ({
            action: 'delete' as const,
            sessionId: d.sessionId,
            offeringId: d.offeringId,
            placement: d.placement,
            previous: d.placement,
            roomId: null,
            groupIds: [],
            lecturerIds: [],
            personIds: [],
        })),
    ];
}
