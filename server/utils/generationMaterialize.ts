import type { ConstraintViolation, PlacedSession, SolverOutput } from '@mindcollaps/calendry-proto';
import type { Tx } from './tenantDb';
import { fromWireWeek } from './solverSessions';

/**
 * Stage 5 — turning a solver result into real Session rows.
 *
 * WHY THIS HAPPENS AT APPLY AND NOT AT CAPTURE
 *
 * `/api/sessions` filters by term, week, group, room and person — never by
 * generation or `is_current`. A Session row therefore appears on the live
 * schedule the moment it exists. Writing placements when the Generation is
 * created would mean "review before apply" reviews a schedule that has already
 * changed, which is the opposite of what it is for.
 *
 * So placements stay in `solver_run.result` until someone applies the
 * Generation. Nothing is copied — the payload can be megabytes — and the
 * Generation reaches its run through `solver_run.generation_id`.
 */

export interface MaterializeCounts {
    created: number;
    /** Returned with a DIFFERENT placement than it had. */
    moved: number;
    /**
     * Returned at the placement it already had.
     *
     * Separated from `moved` because the apply report is read by a human: a
     * solver that reproduces the existing timetable would otherwise say "48
     * moved" and invite someone to go looking for 48 changes that do not exist.
     */
    unchanged: number;
    deleted: number;
    skippedLocked: number;
    violationsSession: number;
    violationsOffering: number;
    violationsUnmapped: number;
}

/**
 * Replaces the in-scope Sessions of a term with the solver's placement.
 *
 * THE THREE-WAY PARTITION, and the one that is destructive:
 *
 *   session_id empty            create — the solver invented this Session
 *   session_id matches a row    move   — same Session, new placement
 *   existing in-scope, absent   DELETE — the solver chose not to place it
 *
 * That last case is deliberate and confirmed. If ExactFrequency could not place
 * all six Sessions of an Offering, the output holds four; leaving the other two
 * where they were would mean the applied schedule contains placements the
 * solver rejected while `frequency` appears satisfied. It is recoverable
 * through the event log, which is why deleting is safe to prefer over a
 * silently wrong schedule.
 *
 * LOCKED SESSIONS ARE NEVER TOUCHED. They were sent to the solver as immovable
 * fixtures (TAXONOMY.md §3), so honouring that here is not a policy choice —
 * the answer was computed on the assumption they would not move.
 */
export async function materializeGeneration(tx: Tx, options: {
    tenantId: string;
    termId: string;
    generationId: string;
    output: SolverOutput;
    /** Offerings the run was allowed to place. Anything else is out of scope. */
    scopeOfferingIds: string[];
}): Promise<MaterializeCounts> {
    const { tenantId, termId, generationId, output, scopeOfferingIds } = options;

    const inScope = new Set(scopeOfferingIds);

    const existing = await tx.session.findMany({
        where: { tenantId, termId },
        select: {
            id: true, offeringId: true, isLocked: true,
            termWeek: true, dayOfWeek: true, blockIndex: true, durationBlocks: true,
        },
    });

    const existingById = new Map(existing.map((s) => [s.id, s]));

    const skippedLocked = existing.filter((s) => s.isLocked).length;

    // Kind is per-Offering; the wire carries the kind KEY on each placement but
    // the Session column is a foreign key, so it is resolved from the Offering
    // rather than looked up by string.
    const offerings = await tx.offering.findMany({
        where: { tenantId, termId },
        select: { id: true, kindId: true, durationBlocks: true },
    });
    const offeringById = new Map(offerings.map((o) => [o.id, o]));

    const counts: MaterializeCounts = {
        created: 0,
        moved: 0,
        unchanged: 0,
        deleted: 0,
        skippedLocked,
        violationsSession: 0,
        violationsOffering: 0,
        violationsUnmapped: 0,
    };

    const keptIds = new Set<string>();

    for (const placed of output.sessions) {
        const offering = offeringById.get(placed.offeringId);

        // A placement for an Offering this term does not have cannot be written
        // — the FK would reject it. Counted as unmapped rather than throwing:
        // one bad placement should not abandon an otherwise good apply.
        if (!offering || !placed.startSlot) {
            counts.violationsUnmapped++;

            continue;
        }

        const current = placed.sessionId ? existingById.get(placed.sessionId) : undefined;

        // The solver was told this one could not move; its own output should
        // agree, but the app does not rely on that.
        if (current?.isLocked) {
            keptIds.add(current.id);

            continue;
        }

        const placement = {
            termWeek: fromWireWeek(placed.startSlot.week),
            dayOfWeek: placed.startSlot.day,
            blockIndex: placed.startSlot.block,
            durationBlocks: placed.durationBlocks || offering.durationBlocks,
            generationId,
        };

        const sessionId = current
            ? (await tx.session.update({ where: { id: current.id }, data: placement })).id
            : (await tx.session.create({
                data: {
                    tenantId,
                    termId,
                    offeringId: placed.offeringId,
                    kindId: offering.kindId,
                    ...placement,
                },
            })).id;

        if (!current) {
            counts.created++;
        } else if (
            current.termWeek === placement.termWeek
            && current.dayOfWeek === placement.dayOfWeek
            && current.blockIndex === placement.blockIndex
            && current.durationBlocks === placement.durationBlocks
        ) {
            counts.unchanged++;
        } else {
            counts.moved++;
        }

        keptIds.add(sessionId);

        // Join rows are replaced wholesale rather than diffed: the placement is
        // the authority on who and what is involved, and a diff would be three
        // code paths where this is one.
        await Promise.all([
            tx.sessionRoom.deleteMany({ where: { sessionId } }),
            tx.sessionPerson.deleteMany({ where: { sessionId } }),
            tx.sessionGroup.deleteMany({ where: { sessionId } }),
        ]);

        if (placed.roomId) {
            await tx.sessionRoom.create({ data: { sessionId, roomId: placed.roomId, tenantId } });
        }

        const lecturerRole = await tx.role.findFirst({
            where: { tenantId, key: 'lecturer' },
            select: { id: true },
        });

        for (const personId of placed.lecturerIds) {
            await tx.sessionPerson.create({
                data: { sessionId, personId, roleId: lecturerRole?.id ?? null, tenantId },
            });
        }

        for (const personId of placed.personIds) {
            await tx.sessionPerson.create({ data: { sessionId, personId, roleId: null, tenantId } });
        }

        for (const groupId of placed.groupIds) {
            await tx.sessionGroup.create({ data: { sessionId, groupId, tenantId } });
        }
    }

    /**
     * Everything in scope that the solver did not return. Locked Sessions and
     * Sessions of out-of-scope Offerings are excluded — the solver was never
     * asked about those and its silence says nothing.
     */
    const orphans = existing.filter((session) => (
        !keptIds.has(session.id)
        && !session.isLocked
        && inScope.has(session.offeringId)
    ));

    if (orphans.length) {
        const removed = await tx.session.deleteMany({ where: { id: { in: orphans.map((s) => s.id) } } });

        counts.deleted = removed.count;
    }

    Object.assign(counts, await materializeViolations(tx, {
        tenantId,
        generationId,
        violations: output.hardViolations,
    }));

    return counts;
}

/**
 * Maps the solver's residual hard violations onto `constraint_violation`.
 *
 * This is warn-and-allow made real: a SUCCEEDED run carrying violations still
 * applies, and its violations land in the same table and the same UI that
 * manual edits already use. Discarding them would make an unsatisfiable
 * timetable look clean.
 */
async function materializeViolations(tx: Tx, options: {
    tenantId: string;
    generationId: string;
    violations: ConstraintViolation[];
}): Promise<Pick<MaterializeCounts, 'violationsSession' | 'violationsOffering' | 'violationsUnmapped'>> {
    const { tenantId, generationId, violations } = options;

    const counts = { violationsSession: 0, violationsOffering: 0, violationsUnmapped: 0 };

    for (const violation of violations) {
        // `constraint_id` is the app's own Constraint row id — it was sent as
        // ConstraintConfig.id — so a miss means the constraint was deleted
        // between starting the run and applying it.
        const constraint = await tx.constraint.findFirst({
            where: { id: violation.constraintId, tenantId },
            select: { id: true, severity: true, weight: true },
        });

        if (!constraint) {
            counts.violationsUnmapped++;

            continue;
        }

        const detail = {
            reason: 'solver_hard_violation',
            constraintType: violation.constraintType,
            detail: violation.detail,
            sessionIds: violation.sessionIds,
            offeringIds: violation.offeringIds,
        };

        const base = {
            tenantId,
            constraintId: constraint.id,
            severity: constraint.severity,
            penalty: constraint.severity === 'SOFT' ? constraint.weight : null,
            detail,
            generationId,
        };

        // Session-scoped: one row per session named.
        for (const sessionId of violation.sessionIds) {
            const exists = await tx.session.findFirst({ where: { id: sessionId, tenantId }, select: { id: true } });

            if (!exists) {
                counts.violationsUnmapped++;

                continue;
            }

            // find-then-write: Prisma cannot express a compound unique key with
            // nullable columns. See the same note in violations.ts.
            await writeViolation(tx, { ...base, sessionId, offeringId: null });

            counts.violationsSession++;
        }

        /**
         * Offering-scoped: the ExactFrequency case. Recorded ONLY when the
         * violation named no sessions — otherwise a violation that names both
         * would be counted twice for the same breach.
         */
        if (violation.sessionIds.length === 0) {
            for (const offeringId of violation.offeringIds) {
                const exists = await tx.offering.findFirst({
                    where: { id: offeringId, tenantId },
                    select: { id: true },
                });

                if (!exists) {
                    counts.violationsUnmapped++;

                    continue;
                }

                await writeViolation(tx, { ...base, sessionId: null, offeringId });

                counts.violationsOffering++;
            }
        }
    }

    return counts;
}

/**
 * Insert-or-refresh one violation.
 *
 * Split out because the uniqueness it respects — (constraint, session, offering)
 * with NULLS NOT DISTINCT — is enforced by an index Prisma's type system cannot
 * describe, so `upsert` is unavailable and both call sites would otherwise
 * repeat the same eight lines.
 */
async function writeViolation(tx: Tx, row: {
    tenantId: string;
    constraintId: string;
    sessionId: string | null;
    offeringId: string | null;
    severity: 'HARD' | 'SOFT';
    penalty: number | null;
    detail: object;
    generationId: string;
}): Promise<void> {
    const existing = await tx.constraintViolation.findFirst({
        where: { constraintId: row.constraintId, sessionId: row.sessionId, offeringId: row.offeringId },
        select: { id: true },
    });

    if (existing) {
        await tx.constraintViolation.update({
            where: { id: existing.id },
            data: {
                severity: row.severity,
                penalty: row.penalty,
                detail: row.detail,
                generationId: row.generationId,
                detectedAt: new Date(),
            },
        });

        return;
    }

    await tx.constraintViolation.create({ data: row });
}

/** Placements a solver output carries, for a review screen that has not applied yet. */
export function summarizeOutput(output: SolverOutput): {
    placements: number;
    hardViolations: number;
    objective: number | undefined;
    terminationReason: string | undefined;
} {
    return {
        placements: output.sessions.length,
        hardViolations: output.hardViolations.length,
        objective: output.objective?.total,
        terminationReason: output.stats?.terminationReason,
    };
}

export type { PlacedSession };
