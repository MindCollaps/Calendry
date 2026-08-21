import { createHash } from 'node:crypto';
import { SolverInput } from '@mindcollaps/calendry-proto';
import type {
    ConstraintConfig, ExternalOccupancy, Offering, Person, Room, SlotRef,
} from '@mindcollaps/calendry-proto';
import type { Tx } from './tenantDb';
import {
    TermEndedError,
    buildAcademicCalendar,
    computeReferenceSlot,
    isoWeekday,
    mondayOf,
    toWireTimeGrid,
} from './solverCalendar';
import { multiRoomSessionIds, toWireSession } from './solverSessions';
// Relative, not `#shared`: this module is loaded OUTSIDE Nuxt too — by
// scripts/ and by vitest — where Nuxt's aliases do not exist. App code under
// app/ can use `#shared` freely because it only ever runs inside Nuxt.
import {
    findConstraintType,
    missingConstraintParams,
    severityMismatch,
} from '../../shared/constraintTypes';

/**
 * Stage 3b/3e — the real SolverInput, assembled from tenant data.
 *
 * THE SOLVER KNOWS ONLY WHAT IS IN HERE. It never touches Postgres, so every
 * omission below is a wrong answer it has no way to detect: a Room left out is
 * a Room it will never use, a Session left out is a slot it thinks is free.
 * That is why the narrowings are counted and returned rather than being quiet.
 *
 * SCOPE (CLAUDE.md, Stages 1–6): single-tenant, non-federated. Federation-owned
 * Rooms and Offerings are EXCLUDED, not included-and-hoped-for — including a
 * shared Room while sending an empty `external_occupancy` is precisely the case
 * that silently double-books across a tenant boundary.
 */

/** Everything narrowed or dropped on the way to the wire. Returned, never swallowed. */
export interface AssemblyReport {
    /** Federation-shared Rooms now sent to the solver (Stage 7b). */
    includedFederationRooms: number;
    /** Slots other tenants already occupy on those shared Rooms. */
    externalOccupancySlots: number;
    excludedFederationOfferings: number;
    /** Sessions whose extra Rooms the wire cannot carry (see CLAUDE.md). */
    multiRoomSessions: string[];
    /** Equipment requirements whose quantity the wire cannot carry. */
    droppedEquipmentQuantities: number;
    /** Constraints not sent, with the reason. Never sent with invented defaults. */
    skippedConstraints: { id: string; type: string; reason: string }[];
    /**
     * Rows whose stored severity contradicts the catalogue's fixed severity for
     * that type. Sent using the CATALOGUE's severity — the wire has no severity
     * field, the type determines it — with any weight on a HARD type ignored.
     */
    severityMismatches: { id: string; type: string; stored: string; expected: string }[];
    counts: {
        rooms: number;
        persons: number;
        groups: number;
        offerings: number;
        existingSessions: number;
        constraints: number;
        weeks: number;
    };
}

export interface AssembledInput {
    input: SolverInput;
    referenceSlot: SlotRef;
    /** SHA-256 over the serialized input — makes "same problem?" answerable. */
    inputHash: string;
    report: AssemblyReport;
}

/**
 * Turns one stored Constraint row into a wire `ConstraintConfig`, or explains
 * why it cannot be sent.
 *
 * SKIP-AND-REPORT, never defaults. A constraint missing a required parameter is
 * withheld with a reason rather than transmitted with a guess: a rule the tenant
 * never chose, enforced by a solver and reported to nobody, is worse than one
 * that visibly did not run.
 *
 * The type → wire-field mapping is DATA (`wireField` on the catalogue), not a
 * switch here, so the catalogue stays the one place a type's identity lives.
 */
export function toWireConstraint(row: {
    id: string;
    type: string;
    severity: string;
    weight: number | null;
    params: unknown;
    scopes: { offeringId: string | null; kindId: string | null }[];
}, kindKeyById: Map<string, string>): { config: ConstraintConfig } | { skip: string } {
    const type = findConstraintType(row.type);

    if (!type) {
        return { skip: `'${row.type}' is not in the constraint catalogue (shared/constraintTypes.ts).` };
    }

    const params = (row.params && typeof row.params === 'object' ? row.params : {}) as Record<string, unknown>;
    const missing = missingConstraintParams(type, params);

    if (missing.length) {
        return { skip: `Required parameter(s) not set: ${missing.join(', ')}.` };
    }

    /**
     * `ConstraintScope` can name an Offering, but the wire's ConstraintConfig
     * has only `applies_to_kinds` — there is no offering-scoped equivalent.
     * Skipped rather than degraded to unscoped, which would silently WIDEN the
     * rule to every offering: the opposite of what was configured.
     */
    if (row.scopes.some((scope) => scope.offeringId)) {
        return {
            skip: 'Scoped to specific offerings, which the wire cannot express '
                + '(ConstraintConfig carries applies_to_kinds only). Sending it unscoped '
                + 'would widen the rule rather than narrow it.',
        };
    }

    const appliesToKinds = row.scopes
        .map((scope) => (scope.kindId ? kindKeyById.get(scope.kindId) : undefined))
        .filter((key): key is string => Boolean(key));

    const config = {
        id: row.id,
        enabled: true,
        appliesToKinds,
        // Meaningful for SOFT only; the solver ignores it for a HARD type. Read
        // from the catalogue's severity, not the row's — see severityMismatch.
        weight: type.severity === 'SOFT' ? (row.weight ?? 0) : 0,
        [type.wireField]: buildVariant(type.key, params),
    } as ConstraintConfig;

    return { config };
}

/**
 * The per-type payload. Most variants are empty messages — the type IS the
 * rule — and only three carry parameters.
 *
 * `percent` is converted here: tenants think in 0–100, the wire wants 0.0–1.0,
 * and doing it at this single boundary keeps the STORED value the one the user
 * typed.
 */
function buildVariant(typeKey: string, params: Record<string, unknown>): Record<string, unknown> {
    switch (typeKey) {
        case 'max_online_ratio_per_group':
            return {
                maxRatio: Number(params.maxRatio) / 100,
                window: params.window === 'SHARE_WINDOW_PER_WEEK' ? 2 : 1,
            };

        case 'minimize_specifc_day':
            return { days: (params.days as number[]).map(Number).sort((a, b) => a - b) };

        case 'minimize_high_ranking_rooms':
            return { rankThreshold: Number(params.rankThreshold) };

        default:
            return {};
    }
}

export async function assembleSolverInput(
    tx: Tx,
    options: { tenantId: string; termId: string; now: Date },
): Promise<AssembledInput> {
    const tenant = await tx.tenant.findFirstOrThrow({
        where: { id: options.tenantId },
        select: { id: true, timezone: true, federationId: true },
    });

    const term = await tx.term.findFirst({
        where: { id: options.termId, tenantId: options.tenantId },
        // `breaks` travels with the grid: computeReferenceSlot() resolves a
        // block from the wall clock, and a day-specific break changes which
        // block that is. The breaks themselves are NOT forwarded to the solver
        // — see toWireTimeGrid().
        include: { timeGrid: { include: { breaks: true } }, calendarPeriods: true },
    });

    if (!term) {
        throw createError({ statusCode: 404, statusMessage: 'Term not found.' });
    }

    // A grid is not optional: every placement is addressed against it, and
    // TAXONOMY.md §2 forbids assuming a shape when one is missing.
    const grid = term.timeGrid
        ?? await tx.timeGrid.findFirst({
            where: { tenantId: options.tenantId, isDefault: true },
            include: { breaks: true },
        });

    if (!grid) {
        throw createError({
            statusCode: 422,
            statusMessage: 'This term has no TimeGrid and the tenant has no default. Nothing can be placed.',
        });
    }

    // Throws TermEndedError, which the route turns into a 422 rather than
    // returning a confidently empty timetable.
    const referenceSlot = computeReferenceSlot({
        now: options.now,
        timeZone: tenant.timezone,
        termStart: term.startDate,
        termEnd: term.endDate,
        grid,
    });

    const [roomRows, personRows, groupRows, offeringRows, sessionRows, constraintRows, lecturerRole] =
        await Promise.all([
            tx.room.findMany({
                /**
                 * Federation-owned Rooms are included alongside the tenant's own
                 * (Stage 7b). RLS already narrows `federationId IS NOT NULL` to
                 * the caller's OWN federation, so this cannot widen past it.
                 */
                where: {
                    isActive: true,
                    OR: [
                        { tenantId: options.tenantId },
                        { tenantId: null, federationId: { not: null } },
                    ],
                },
                include: { roomEquipment: { include: { equipment: true } } },
            }),
            tx.person.findMany({
                where: { tenantId: options.tenantId, isActive: true },
                include: { personRoles: { include: { role: true } }, memberships: true },
            }),
            tx.group.findMany({ where: { tenantId: options.tenantId } }),
            tx.offering.findMany({
                where: { tenantId: options.tenantId, termId: term.id, isActive: true },
                include: {
                    kind: true,
                    groups: true,
                    lecturers: true,
                    equipment: { include: { equipment: true } },
                },
            }),
            tx.session.findMany({
                /**
                 * Own Sessions plus Federation-shared ones (Stage 7c). A shared
                 * event occupies a room and a slot the solver must respect; it
                 * is sent as immovable occupancy, which `toWireSession` enforces
                 * by forcing isLocked when the Session has no owning tenant.
                 */
                where: {
                    termId: term.id,
                    OR: [
                        { tenantId: options.tenantId },
                        ...(tenant.federationId ? [{ federationId: tenant.federationId }] : []),
                    ],
                },
                include: { kind: true, rooms: true, people: true, groups: true },
            }),
            tx.constraint.findMany({
                where: { tenantId: options.tenantId, isEnabled: true },
                include: { scopes: true },
            }),
            tx.role.findFirst({ where: { tenantId: options.tenantId, key: 'lecturer' }, select: { id: true } }),
        ]);

    /**
     * Federation-owned ROOMS are now included (Stage 7b) — they arrive through
     * the widened RLS read policy and are sent with the other tenants' occupancy
     * of them, so the solver can place into a shared hall without overlapping
     * somebody else's event.
     *
     * Federation-owned OFFERINGS remain excluded, deliberately and separately:
     * placing one raises "which tenant owns the resulting Session?", which is a
     * placement-ownership question rather than an occupancy one and deserves its
     * own decision.
     */
    const includedFederationRooms = roomRows.filter((room) => room.federationId !== null).length;
    const federationOfferings = await tx.offering.count({
        where: { federationId: { not: null }, tenantId: null, termId: term.id, isActive: true },
    });

    const rooms: Room[] = roomRows.map((room) => ({
        id: room.id,
        // Ownership reported honestly: a shared hall belongs to the federation,
        // not to the requesting tenant, and the solver distinguishes the two.
        tenantId: room.tenantId ?? '',
        federationId: room.federationId ?? '',
        name: `${room.code} · ${room.name}`,
        capacity: room.capacity,
        // Same direction on both sides: HIGHER = more premium/scarce.
        rank: Math.max(0, room.ranking),
        isVirtual: room.isVirtual,
        // Presence only — RoomEquipment.quantity has nowhere to go on the wire.
        featureTags: room.roomEquipment.map((link) => link.equipment.key),
        location: room.location ?? '',
    } as Room));

    const persons: Person[] = personRows.map((person) => ({
        id: person.id,
        roleTags: person.personRoles.map((link) => link.role.key),
        groupIds: person.memberships.map((link) => link.groupId),
        // The app models no unavailability at all, so this is empty and
        // LecturerVeto is unsendable. Tracked; see the Stage 3d follow-up.
        blackouts: [],
    }));

    const groups = groupRows.map((group) => ({
        id: group.id,
        parentId: group.parentGroupId ?? '',
        name: group.name,
        size: group.expectedSize ?? 0,
        // group_closure is deliberately NOT transmitted: the solver derives the
        // ancestor/descendant closure from parent_id, and shipping ours would
        // create a second source of truth that can drift undetectably.
    }));

    let droppedEquipmentQuantities = 0;

    const offerings: Offering[] = offeringRows.map((offering) => {
        droppedEquipmentQuantities += offering.equipment.filter((link) => link.quantity !== null).length;

        return {
            id: offering.id,
            tenantId: options.tenantId,
            kind: offering.kind.key,
            requiredSessionCount: offering.frequency,
            durationBlocks: offering.durationBlocks,
            candidateLecturerIds: offering.lecturers.map((link) => link.personId),
            // The app has no separate count: OfferingLecturer IS the assignment
            // ("Who leads it" in the management UI), so the pool equals the
            // requirement and the solver does not choose. Tracked as a modelling
            // limit rather than papered over with a guess.
            requiredLecturerCount: offering.lecturers.length,
            groupIds: offering.groups.map((link) => link.groupId),
            // The app models no direct per-Offering participants beyond groups.
            participantPersonIds: [],
            requiredRoomFeatures: offering.equipment.map((link) => link.equipment.key),
            minCapacity: offering.requiredCapacity ?? 0,
            // Empty = any eligible Room. The app has no allow-list.
            allowedRoomIds: [],
            allowOnline: offering.allowOnline,
        } as Offering;
    });

    const sessionInputs = sessionRows.map((session) => ({
        id: session.id,
        tenantId: session.tenantId,
        offeringId: session.offeringId,
        kindId: session.kindId,
        kindKey: session.kind.key,
        termWeek: session.termWeek,
        dayOfWeek: session.dayOfWeek,
        blockIndex: session.blockIndex,
        durationBlocks: session.durationBlocks,
        isLocked: session.isLocked,
        roomIds: session.rooms.map((link) => link.roomId),
        lecturerIds: session.people.filter((p) => p.roleId === lecturerRole?.id).map((p) => p.personId),
        personIds: session.people.filter((p) => p.roleId !== lecturerRole?.id).map((p) => p.personId),
        groupIds: session.groups.map((link) => link.groupId),
    }));

    const kindKeyById = new Map(
        (await tx.sessionKind.findMany({ where: { tenantId: options.tenantId } }))
            .map((kind) => [kind.id, kind.key]),
    );

    const skippedConstraints: AssemblyReport['skippedConstraints'] = [];
    const severityMismatches: AssemblyReport['severityMismatches'] = [];
    const constraints: ConstraintConfig[] = [];

    for (const row of constraintRows) {
        const type = findConstraintType(row.type);
        const mismatch = type ? severityMismatch(type, row.severity) : null;

        if (type && mismatch) {
            // Reported, not refused and not normalised in the database. The row
            // is the tenant's; the wire simply has no severity field to carry
            // the contradiction, so the catalogue's severity wins on the wire.
            severityMismatches.push({
                id: row.id,
                type: row.type,
                stored: mismatch.stored,
                expected: mismatch.expected,
            });
        }

        const mapped = toWireConstraint(row, kindKeyById);

        if ('skip' in mapped) {
            skippedConstraints.push({ id: row.id, type: row.type, reason: mapped.skip });

            continue;
        }

        constraints.push(mapped.config);
    }

    const calendar = buildAcademicCalendar(
        term.id,
        term.startDate,
        term.endDate,
        term.calendarPeriods.map((p) => ({ kind: p.kind, startDate: p.startDate, endDate: p.endDate })),
    );

    /**
     * Other tenants' use of Federation-shared Rooms.
     *
     * Read through the parameterless SECURITY DEFINER function, because those
     * Sessions belong to sibling tenants and are invisible under normal RLS —
     * which is the whole reason shared rooms were excluded until now. What comes
     * back is occupancy and nothing else: no session ids, no tenant ids, no
     * titles.
     */
    const occupancyRows = tenant.federationId
        ? await tx.$queryRaw<{
            room_id: string;
            occupied_on: Date;
            block_index: number;
            duration_blocks: number;
        }[]>`SELECT * FROM calendry_internal.federation_room_occupancy()`
        : [];

    /**
     * Map each occupied DATE into this tenant's own week numbering.
     *
     * The function returns absolute dates because term-relative weeks are not a
     * shared frame: terms are tenant-scoped rows, so the other tenant's term id
     * never matches ours and its "week 3" is not our "week 3". The calendar is
     * the one frame a Federation agrees on, so the conversion happens here,
     * anchored on the same Monday `buildAcademicCalendar` uses.
     */
    const firstMonday = mondayOf(term.startDate);

    const externalOccupancy: ExternalOccupancy[] = occupancyRows
        .map((row) => {
            const date = new Date(row.occupied_on);
            const week = Math.floor(
                (mondayOf(date).getTime() - firstMonday.getTime()) / (7 * 24 * 60 * 60 * 1000),
            );

            return { row, date, week };
        })
        // Occupancy outside this term's span tells the solver nothing — it can
        // only place within the weeks the calendar declares.
        .filter(({ week }) => week >= 0 && week < (calendar.weeks?.length ?? 0))
        .map(({ row, date, week }) => ({
            roomId: row.room_id,
            // Already 0-based: `week` counts from the term's first Monday, which
            // is exactly what SlotRef.week means on the wire.
            startSlot: { week, day: isoWeekday(date), block: row.block_index },
            durationBlocks: row.duration_blocks,
            // Documented as "opaque; diagnostics only" — deliberately carries no
            // identifier, so nothing about the owning tenant leaks through it.
            sourceRef: 'federation-shared',
        } as ExternalOccupancy));

    const input: SolverInput = {
        requestingTenantId: options.tenantId,
        // Now real: the snapshot carries federation-shared rooms and the
        // occupancy that makes them safe to place into.
        federationId: tenant.federationId ?? '',
        timeGrid: toWireTimeGrid(grid, tenant.timezone),
        calendar,
        rooms,
        persons,
        groups,
        offerings,
        existingSessions: sessionInputs.map(toWireSession),
        externalOccupancy,
        constraints,
        referenceSlot,
    };

    return {
        input,
        referenceSlot,
        inputHash: hashInput(input),
        report: {
            includedFederationRooms,
            externalOccupancySlots: externalOccupancy.length,
            excludedFederationOfferings: federationOfferings,
            multiRoomSessions: multiRoomSessionIds(sessionInputs),
            droppedEquipmentQuantities,
            skippedConstraints,
            severityMismatches,
            counts: {
                rooms: rooms.length,
                persons: persons.length,
                groups: groups.length,
                offerings: offerings.length,
                existingSessions: input.existingSessions.length,
                constraints: constraints.length,
                weeks: calendar.weeks.length,
            },
        },
    };
}

/**
 * Hash of the ENCODED protobuf, not of a JSON rendering.
 *
 * Two inputs that encode identically are the same problem to the solver, which
 * is exactly the question this answers. A JSON hash would also change with key
 * order and with how BigInt happened to stringify.
 */
export function hashInput(input: SolverInput): string {
    return createHash('sha256').update(SolverInput.encode(input).finish()).digest('hex');
}

export { TermEndedError };
