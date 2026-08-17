import type { ConstraintViolation, PlacedSession, SolverOutput } from '@mindcollaps/calendry-proto';
import type { Tx } from './tenantDb';
import { fromWireWeek } from './solverSessions';

/**
 * Stage 5 — turning a solver result into real Session rows.
 * Stage 6a — split into a PLAN (reads only) and an EXECUTE (writes).
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
 *
 * WHY THE PLAN IS A SEPARATE STEP (Stage 6a)
 *
 * The review screen has to answer "what will applying this do?" before anything
 * is written. Computing that answer with different code than the apply uses
 * would let the preview and the apply disagree — the preview would eventually
 * lie, and nothing would catch it. So `planMaterialization()` decides
 * everything and writes nothing; `executePlan()` performs exactly what the plan
 * says. Both callers consume the same object.
 *
 * Same reasoning as `pollSolverRun()` in Stage 4: one function, two callers,
 * because two implementations of one rule is one implementation too many.
 *
 * The plan is a SNAPSHOT, not a promise. A manual edit between preview and
 * apply legitimately changes the outcome; `computedAt` on the preview response
 * is what lets a UI say so.
 */

/** One placement the solver returned, resolved against what already exists. */
export interface PlannedPlacement {
    action: 'create' | 'move' | 'unchanged';
    /** Null when the solver invented this Session — there is no row yet. */
    sessionId: string | null;
    offeringId: string;
    placement: Placement;
    /** Where it currently sits. Null for a create; the diff view needs it. */
    previous: Placement | null;
    roomId: string | null;
    groupIds: string[];
    lecturerIds: string[];
    personIds: string[];
}

export interface Placement {
    termWeek: number;
    dayOfWeek: number;
    blockIndex: number;
    durationBlocks: number;
}

export interface PlannedDelete {
    sessionId: string;
    offeringId: string;
    placement: Placement;
}

export interface PlanCounts {
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
    /**
     * Placements that cannot be written at all — the Offering is not in this
     * term, or the placement carries no slot.
     *
     * Split out from `violationsUnmapped` in Stage 6a. The two were one counter
     * and have nothing in common: this is a PLACEMENT that cannot be stored,
     * that is a VIOLATION that cannot be attached to a row. Different causes,
     * different fixes, and merging them made both unreadable.
     */
    placementsUnmapped: number;
}

export interface MaterializationPlan {
    placements: PlannedPlacement[];
    deletes: PlannedDelete[];
    /** Ids of locked Sessions, which are never touched. */
    skippedLocked: string[];
    counts: PlanCounts;
}

export interface MaterializeCounts extends PlanCounts {
    violationsSession: number;
    violationsOffering: number;
    /** Violations naming a Session or Offering that could not be resolved. */
    violationsUnmapped: number;
}

function samePlacement(a: Placement, b: Placement): boolean {
    return a.termWeek === b.termWeek
        && a.dayOfWeek === b.dayOfWeek
        && a.blockIndex === b.blockIndex
        && a.durationBlocks === b.durationBlocks;
}

/**
 * Decides what applying this output would do. Reads the database; writes nothing.
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
export async function planMaterialization(tx: Tx, options: {
    tenantId: string;
    termId: string;
    output: SolverOutput;
    /** Offerings the run was allowed to place. Anything else is out of scope. */
    scopeOfferingIds: string[];
}): Promise<MaterializationPlan> {
    const { tenantId, termId, output, scopeOfferingIds } = options;

    const inScope = new Set(scopeOfferingIds);

    const existing = await tx.session.findMany({
        where: { tenantId, termId },
        select: {
            id: true, offeringId: true, isLocked: true,
            termWeek: true, dayOfWeek: true, blockIndex: true, durationBlocks: true,
        },
    });

    const existingById = new Map(existing.map((s) => [s.id, s]));

    // Kind is per-Offering; the wire carries the kind KEY on each placement but
    // the Session column is a foreign key, so it is resolved from the Offering
    // rather than looked up by string.
    const offerings = await tx.offering.findMany({
        where: { tenantId, termId },
        select: { id: true, kindId: true, durationBlocks: true },
    });
    const offeringById = new Map(offerings.map((o) => [o.id, o]));

    const placements: PlannedPlacement[] = [];
    const skippedLocked = existing.filter((s) => s.isLocked).map((s) => s.id);
    const keptIds = new Set<string>(skippedLocked);

    let placementsUnmapped = 0;

    for (const placed of output.sessions) {
        const offering = offeringById.get(placed.offeringId);

        // A placement for an Offering this term does not have cannot be written
        // — the FK would reject it. Counted rather than thrown: one bad
        // placement should not abandon an otherwise good apply.
        if (!offering || !placed.startSlot) {
            placementsUnmapped++;

            continue;
        }

        const current = placed.sessionId ? existingById.get(placed.sessionId) : undefined;

        // The solver was told this one could not move; its own output should
        // agree, but the app does not rely on that.
        if (current?.isLocked) {
            continue;
        }

        const placement: Placement = {
            termWeek: fromWireWeek(placed.startSlot.week),
            dayOfWeek: placed.startSlot.day,
            blockIndex: placed.startSlot.block,
            durationBlocks: placed.durationBlocks || offering.durationBlocks,
        };

        const previous: Placement | null = current
            ? {
                termWeek: current.termWeek,
                dayOfWeek: current.dayOfWeek,
                blockIndex: current.blockIndex,
                durationBlocks: current.durationBlocks,
            }
            : null;

        placements.push({
            action: !current
                ? 'create'
                : samePlacement(placement, previous!) ? 'unchanged' : 'move',
            sessionId: current?.id ?? null,
            offeringId: placed.offeringId,
            placement,
            previous,
            roomId: placed.roomId || null,
            groupIds: placed.groupIds,
            lecturerIds: placed.lecturerIds,
            personIds: placed.personIds,
        });

        if (current) {
            keptIds.add(current.id);
        }
    }

    /**
     * Everything in scope that the solver did not return. Locked Sessions and
     * Sessions of out-of-scope Offerings are excluded — the solver was never
     * asked about those and its silence says nothing.
     */
    const deletes: PlannedDelete[] = existing
        .filter((s) => !keptIds.has(s.id) && !s.isLocked && inScope.has(s.offeringId))
        .map((s) => ({
            sessionId: s.id,
            offeringId: s.offeringId,
            placement: {
                termWeek: s.termWeek,
                dayOfWeek: s.dayOfWeek,
                blockIndex: s.blockIndex,
                durationBlocks: s.durationBlocks,
            },
        }));

    return {
        placements,
        deletes,
        skippedLocked,
        counts: {
            created: placements.filter((p) => p.action === 'create').length,
            moved: placements.filter((p) => p.action === 'move').length,
            unchanged: placements.filter((p) => p.action === 'unchanged').length,
            deleted: deletes.length,
            skippedLocked: skippedLocked.length,
            placementsUnmapped,
        },
    };
}

export interface WeekSummaryRow {
    termWeek: number;
    created: number;
    moved: number;
    unchanged: number;
    deleted: number;
}

/**
 * The plan's changes bucketed by term week.
 *
 * A review screen renders one week at a time — the payload for a whole term can
 * be a thousand placements — which leaves a reviewer clicking through nineteen
 * weeks to find the three that changed. This is the index that makes the week
 * picker able to say where the changes are.
 *
 * Derived from the plan rather than queried: it is the same decision, counted a
 * second way, so it cannot disagree with the numbers beside it.
 */
export function summarizePlanByWeek(plan: MaterializationPlan): WeekSummaryRow[] {
    const byWeek = new Map<number, WeekSummaryRow>();

    const row = (termWeek: number) => {
        const existing = byWeek.get(termWeek)
            ?? { termWeek, created: 0, moved: 0, unchanged: 0, deleted: 0 };

        byWeek.set(termWeek, existing);

        return existing;
    };

    // The action names and the count names differ by design — `create` is what
    // happens, `created` is how many — so the mapping is explicit rather than
    // an index that happens to line up.
    const KEY = { create: 'created', move: 'moved', unchanged: 'unchanged' } as const;

    for (const placement of plan.placements) {
        row(placement.placement.termWeek)[KEY[placement.action]]++;
    }

    // A deletion belongs to the week it currently occupies — that is where a
    // reviewer will look for the session that is about to vanish.
    for (const del of plan.deletes) {
        row(del.placement.termWeek).deleted++;
    }

    return [...byWeek.values()].sort((a, b) => a.termWeek - b.termWeek);
}

/**
 * Performs exactly what the plan says, then records the run's residual
 * violations.
 *
 * Takes the plan rather than recomputing it, so that what a preview showed and
 * what an apply did are the same decision rather than two that happen to agree.
 */
export async function executePlan(tx: Tx, plan: MaterializationPlan, options: {
    tenantId: string;
    termId: string;
    generationId: string;
    violations: ConstraintViolation[];
}): Promise<MaterializeCounts> {
    const { tenantId, termId, generationId, violations } = options;

    const offerings = await tx.offering.findMany({
        where: { tenantId, termId },
        select: { id: true, kindId: true },
    });
    const kindByOffering = new Map(offerings.map((o) => [o.id, o.kindId]));

    const lecturerRole = await tx.role.findFirst({
        where: { tenantId, key: 'lecturer' },
        select: { id: true },
    });

    for (const planned of plan.placements) {
        const placement = { ...planned.placement, generationId };

        const sessionId = planned.sessionId
            ? (await tx.session.update({ where: { id: planned.sessionId }, data: placement })).id
            : (await tx.session.create({
                data: {
                    tenantId,
                    termId,
                    offeringId: planned.offeringId,
                    kindId: kindByOffering.get(planned.offeringId)!,
                    ...placement,
                },
            })).id;

        // Join rows are replaced wholesale rather than diffed: the placement is
        // the authority on who and what is involved, and a diff would be three
        // code paths where this is one.
        await Promise.all([
            tx.sessionRoom.deleteMany({ where: { sessionId } }),
            tx.sessionPerson.deleteMany({ where: { sessionId } }),
            tx.sessionGroup.deleteMany({ where: { sessionId } }),
        ]);

        if (planned.roomId) {
            await tx.sessionRoom.create({ data: { sessionId, roomId: planned.roomId, tenantId } });
        }

        for (const personId of planned.lecturerIds) {
            await tx.sessionPerson.create({
                data: { sessionId, personId, roleId: lecturerRole?.id ?? null, tenantId },
            });
        }

        for (const personId of planned.personIds) {
            await tx.sessionPerson.create({ data: { sessionId, personId, roleId: null, tenantId } });
        }

        for (const groupId of planned.groupIds) {
            await tx.sessionGroup.create({ data: { sessionId, groupId, tenantId } });
        }
    }

    if (plan.deletes.length) {
        await tx.session.deleteMany({
            where: { id: { in: plan.deletes.map((d) => d.sessionId) } },
        });
    }

    return {
        ...plan.counts,
        ...await materializeViolations(tx, { tenantId, generationId, violations }),
    };
}

/** Plan and execute in one step — the apply route's entry point. */
export async function materializeGeneration(tx: Tx, options: {
    tenantId: string;
    termId: string;
    generationId: string;
    output: SolverOutput;
    scopeOfferingIds: string[];
}): Promise<MaterializeCounts> {
    const { tenantId, termId, generationId, output, scopeOfferingIds } = options;

    const plan = await planMaterialization(tx, { tenantId, termId, output, scopeOfferingIds });

    return executePlan(tx, plan, {
        tenantId,
        termId,
        generationId,
        violations: output.hardViolations,
    });
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
 * Counts how the run's violations WOULD map, without writing anything.
 *
 * Deliberately mirrors `materializeViolations()` rather than sharing its loop:
 * that one resolves against Sessions as they exist AFTER the plan is applied,
 * this one has to answer before any of it exists. What it can say honestly is
 * how many name a Session the solver invented and therefore cannot be attached
 * to any row — the tracked cross-repo gap. Reporting that number is the point;
 * netting it out would make an unsatisfiable timetable look cleaner than it is.
 */
export function summarizeProposedViolations(violations: ConstraintViolation[]): {
    hard: number;
    byType: Record<string, number>;
    /** References naming a Session that exists nowhere in the placements. */
    unmappable: number;
    sessionReferences: number;
} {
    const byType: Record<string, number> = {};
    let unmappable = 0;
    let sessionReferences = 0;

    for (const violation of violations) {
        byType[violation.constraintType] = (byType[violation.constraintType] ?? 0) + 1;

        for (const sessionId of violation.sessionIds) {
            sessionReferences++;

            // The solver names Sessions it invented with a synthetic
            // "<offeringId>#<index>" key that appears nowhere in the placements,
            // so there is no join key back to the row the apply will create.
            if (sessionId.includes('#')) {
                unmappable++;
            }
        }
    }

    return { hard: violations.length, byType, unmappable, sessionReferences };
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
