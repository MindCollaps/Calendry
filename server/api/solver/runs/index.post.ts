import { z } from 'zod';
import { LockPolicy } from '@mindcollaps/calendry-proto';
import { findPgCodeIsUniqueViolation } from '../../../utils/dbErrors';
import { requirePermission } from '../../../utils/requirePermission';
import { withRequestTenant } from '../../../utils/tenantDb';
import { ACTIVE_RUN_STATUSES, fromWireU64, serializeRun, startRun, toWireU64 } from '../../../utils/solverClient';
import {
    PLACEHOLDER_INPUT_SOURCE,
    PLACEHOLDER_OFFERING_IDS,
    buildPlaceholderInput,
} from '../../../utils/solverPlaceholderInput';

/**
 * Sentinel for "the one-active-run index rejected this insert".
 *
 * A bare marker rather than an H3 error because it has to escape the aborted
 * transaction before anything can look up what it collided with — see the catch
 * block below.
 */
class ActiveRunConflict extends Error {}

const bodySchema = z.object({
    termId: z.string().min(1),
    /**
     * Budget. Defaults favour the reproducible path: a move budget large enough
     * to matter, and a wall clock only as a backstop. A run that ends on wall
     * clock is NOT replayable (CLAUDE.md), so it should be the exception.
     */
    maxMoves: z.coerce.number().int().min(1).max(100_000_000).optional(),
    maxWallMillis: z.coerce.number().int().min(1).max(600_000).optional(),
    /** 0 = let the solver choose; whatever it picks is echoed back and stored. */
    seed: z.coerce.number().int().min(0).optional(),
});

/**
 * Start a solver run for one Term.
 *
 * ⚠ STAGE 2: the SolverInput is a hand-written placeholder, not this tenant's
 * data — see solverPlaceholderInput.ts. The run is real, the answer is not
 * about your timetable. Both the stored row and this response say so.
 */
export default defineEventHandler(async (event) => {
    const body = await readValidatedBody(event, bodySchema.parse);

    const seed = BigInt(body.seed ?? 42);
    const maxMoves = body.maxMoves ?? 50_000;
    const maxWallMillis = body.maxWallMillis ?? 10_000;

    /**
     * Written BEFORE StartRun, so the partial unique index rejects a concurrent
     * second attempt while the call is in flight. The cost of that ordering is
     * the PENDING row below, which must be resolved whatever happens next.
     */
    const created = await withRequestTenant(event, async (tx, identity) => {
        await requirePermission(event, tx, 'solver.trigger');

        const term = await tx.term.findFirst({
            where: { id: body.termId, tenantId: identity.tenantId },
            select: { id: true },
        });

        // Checked explicitly so a bad term id is a 404 rather than a foreign-key
        // 500, and so it cannot be used to probe another tenant's term ids.
        if (!term) {
            throw createError({ statusCode: 404, statusMessage: 'Term not found.' });
        }

        try {
            return await tx.solverRun.create({
                data: {
                    tenantId: identity.tenantId,
                    termId: term.id,
                    status: 'PENDING',
                    scope: {
                        offeringIds: PLACEHOLDER_OFFERING_IDS,
                        groupIds: [],
                        outsideScopePolicy: 'LOCK_POLICY_HARD',
                    },
                    seed,
                    maxMoves: BigInt(maxMoves),
                    maxWallMillis,
                    meta: { inputSource: PLACEHOLDER_INPUT_SOURCE },
                    requestedById: identity.actorPersonId,
                },
            });
        } catch (error) {
            /**
             * 23505 here can only be solver_run_one_active_per_term: it is the
             * sole unique constraint on this table beyond the primary key.
             *
             * NOTHING MAY QUERY THIS TRANSACTION AFTER THIS POINT. A failed
             * statement aborts the whole Postgres transaction, and every
             * subsequent command returns `25P02 current transaction is aborted`.
             * Looking up the conflicting run here — the obvious thing to do —
             * turned a clean 409 into a 500, and only a genuinely concurrent
             * test surfaced it. The lookup happens outside, below.
             */
            if (findPgCodeIsUniqueViolation(error)) {
                throw new ActiveRunConflict();
            }

            throw error;
        }
    }).catch(async (error) => {
        if (!(error instanceof ActiveRunConflict)) {
            throw error;
        }

        // Fresh transaction: the one above is unusable.
        const active = await withRequestTenant(event, (tx, identity) => tx.solverRun.findFirst({
            where: {
                tenantId: identity.tenantId,
                termId: body.termId,
                status: { in: ACTIVE_RUN_STATUSES },
            },
            select: { id: true, status: true, createdAt: true },
        }));

        throw createError({
            statusCode: 409,
            statusMessage: 'A solver run is already active for this term.',
            data: { activeRun: active },
        });
    });

    /**
     * StartRun is called OUTSIDE the transaction above.
     *
     * Holding a database transaction open across a network call to another
     * service is how connection pools get exhausted by one slow dependency —
     * and the transaction has already done its job (claiming the term).
     */
    try {
        const response = await startRun({
            input: buildPlaceholderInput(created.tenantId, created.termId),
            scope: {
                offeringIds: PLACEHOLDER_OFFERING_IDS,
                groupIds: [],
                outsideScopePolicy: LockPolicy.LOCK_POLICY_HARD,
            },
            budget: { maxWallMillis: toWireU64(maxWallMillis), maxMoves: toWireU64(maxMoves) },
            seed: toWireU64(seed),
            // Stage 2 sends none. Idempotency needs a key derived from the real
            // input snapshot to mean anything, and there is no real snapshot yet.
            idempotencyKey: '',
        });

        const updated = await withRequestTenant(event, (tx) => tx.solverRun.update({
            where: { id: created.id },
            data: {
                externalRunId: response.runId,
                // The solver has accepted it; QUEUED is the honest state until a
                // GetStatus says otherwise.
                status: 'QUEUED',
                // What the solver ACTUALLY used, which differs from the request
                // when the request was 0.
                seed: fromWireU64(response.seed),
                startedAt: new Date(),
            },
        }));

        setResponseStatus(event, 201);

        return { run: serializeRun(updated), placeholderInput: true };
    } catch (error) {
        /**
         * THE TRAP THIS EXISTS FOR: the row is PENDING, which the one-active-run
         * index counts as occupying the term. Left alone, a solver outage would
         * block that term forever and need manual database surgery to clear.
         *
         * So a transport failure resolves the row to FAILED before returning.
         * The run genuinely never started, and the record says exactly that.
         */
        await withRequestTenant(event, (tx) => tx.solverRun.update({
            where: { id: created.id },
            data: {
                status: 'FAILED',
                errorDetail: (error as Error).message.slice(0, 2000),
                finishedAt: new Date(),
            },
        }));

        throw createError({
            statusCode: 502,
            statusMessage: 'Could not reach the solver service. The run was not started.',
            data: { runId: created.id, detail: (error as Error).message },
        });
    }
});
