import { SolverOutput } from '@mindcollaps/calendry-proto';
import type { Tx } from './tenantDb';

/**
 * Creating the Generation a solver run proposes.
 *
 * A Generation here is a PROPOSAL, not an application: it holds no Session rows
 * and `is_current` stays false until a human applies it. That separation is the
 * whole reason placements stay in `solver_run.result` — see
 * generationMaterialize.ts.
 *
 * Only a SUCCEEDED run gets one. A FAILED or CANCELLED run has no placements to
 * apply, and a Generation that can never be applied is noise in a list whose
 * entire job is "what could I apply?". `solver_run` already records what
 * happened to those.
 *
 * A CONSEQUENCE WORTH NAMING: `GenerationStatus.INFEASIBLE` is now effectively
 * unused for solver output. Warn-and-allow means a SUCCEEDED run carrying
 * residual hard violations is still READY and still applicable, and a run that
 * never succeeded produces no Generation at all. The status remains for import
 * and for a future solver that reports infeasibility as a first-class outcome;
 * it is not an oversight that nothing sets it.
 */

/** Statuses that mean "this run produced something worth proposing". */
export function shouldCreateGeneration(status: string): boolean {
    return status === 'SUCCEEDED';
}

export async function createGenerationForRun(tx: Tx, options: {
    tenantId: string;
    runId: string;
    result: unknown;
    requestedById: string | null;
}): Promise<string | null> {
    const { tenantId, runId, result, requestedById } = options;

    if (!result) {
        return null;
    }

    let output: SolverOutput;

    try {
        output = SolverOutput.fromJSON(result);
    } catch {
        // A result we cannot decode is not a proposal. Reported by its absence
        // rather than by a Generation nobody can apply.
        return null;
    }

    /**
     * Version allocation races: `@@unique([tenantId, version])` with
     * `version = max + 1` lets two concurrent applies compute the same number.
     * A transaction-scoped advisory lock on the tenant serialises just the
     * allocation, is released at COMMIT, and involves no network call inside —
     * the same shape as the Stage 4 claim.
     */
    // $executeRaw, not $queryRaw: pg_advisory_xact_lock returns void, and
    // Prisma cannot deserialize a void column — it fails with "Failed to
    // deserialize column of type 'void'", which reads like a schema problem
    // rather than the wrong client method.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}), hashtext('generation_version'))`;

    const latest = await tx.generation.findFirst({
        where: { tenantId },
        orderBy: { version: 'desc' },
        select: { version: true },
    });

    const current = await tx.generation.findFirst({
        where: { tenantId, isCurrent: true },
        select: { id: true },
    });

    const generation = await tx.generation.create({
        data: {
            tenantId,
            version: (latest?.version ?? 0) + 1,
            // Lineage: what this proposal was computed against.
            parentGenerationId: current?.id ?? null,
            source: 'SOLVER',
            // READY even with residual hard violations — that is the
            // warn-and-allow decision, and the violations travel with the
            // result rather than blocking it.
            status: 'READY',
            isCurrent: false,
            solverMeta: {
                runId,
                objective: output.objective?.total ?? null,
                terminationReason: output.stats?.terminationReason ?? null,
                movesEvaluated: output.stats?.movesEvaluated ?? null,
                elapsedMillis: output.stats?.elapsedMillis ?? null,
                placements: output.sessions.length,
                hardViolations: output.hardViolations.length,
            },
            createdById: requestedById,
        },
    });

    await tx.solverRun.update({
        where: { id: runId },
        data: { generationId: generation.id },
    });

    return generation.id;
}
