import type { Session as WireSession } from '@mindcollaps/calendry-proto';

/**
 * Stage 3c — already-placed Sessions.
 *
 * EVERY Session in the term goes over the wire, not just the ones being
 * re-placed: locked Sessions, past Sessions and out-of-scope Sessions are all
 * occupancy the solver must respect. Sending only the in-scope ones would let
 * it place a lecture on top of a locked one and report no violation, because
 * from its side the slot was empty.
 *
 * Scope membership is NOT expressed here — it travels in `SolveScope`. The only
 * per-Session flag is `is_locked`, which the proto describes as absolute: never
 * relaxed, distinct from merely being out of scope.
 */

/** Shape this needs from Prisma. Kept explicit so the query and the mapper agree. */
export interface AppSessionRow {
    id: string;
    /**
     * Nullable since Stage 7c, like Room/Equipment/Offering: exactly one of
     * these is set, enforced by the `session_one_owner` CHECK. A
     * federation-owned Session is a shared event no member tenant owns.
     */
    tenantId: string | null;
    federationId?: string | null;
    offeringId: string;
    kindId: string;
    termWeek: number;
    dayOfWeek: number;
    blockIndex: number;
    durationBlocks: number;
    isLocked: boolean;
    /** Resolved kind KEY, not the id — the wire carries tenant vocabulary. */
    kindKey: string;
    roomIds: string[];
    /** People holding the tenant's `lecturer` role on this Session. */
    lecturerIds: string[];
    /** Everyone else directly assigned. */
    personIds: string[];
    groupIds: string[];
}

/**
 * THE OFF-BY-ONE. `Session.termWeek` is 1-BASED ("1-based week within the
 * Term", schema.prisma). The wire `SlotRef.week` is a 0-BASED INDEX into
 * `AcademicCalendar.weeks`. Every Session shifts by one, in this one place.
 *
 * Getting it wrong does not crash: it silently moves the entire timetable a
 * week, which still renders as a perfectly plausible schedule. Asserted in
 * tests rather than trusted.
 */
export function toWireWeek(termWeek: number): number {
    return termWeek - 1;
}

/** And back, for reading solver output in Stage 5. */
export function fromWireWeek(week: number): number {
    return week + 1;
}

export function toWireSession(row: AppSessionRow): WireSession {
    return {
        id: row.id,
        // The oneof owner is now a real choice: tenant-owned or shared.
        tenantId: row.tenantId ?? '',
        federationId: row.federationId ?? '',
        offeringId: row.offeringId,
        kind: row.kindKey,
        startSlot: {
            week: toWireWeek(row.termWeek),
            day: row.dayOfWeek,
            block: row.blockIndex,
        },
        durationBlocks: row.durationBlocks,
        // A Session may have several rooms in the app's join table but the wire
        // carries one. The first is sent and the rest are reported as dropped by
        // the caller rather than silently discarded here.
        roomId: row.roomIds[0] ?? '',
        lecturerIds: row.lecturerIds,
        groupIds: row.groupIds,
        personIds: row.personIds,
        /**
         * A federation-shared Session is ALWAYS immovable to a member tenant.
         *
         * The RLS write policy already refuses to let this tenant change it, so
         * a solver that "moved" one would produce a placement the app could
         * never apply — and `materializeGeneration` would then either fail or,
         * worse, silently skip it. Sending it locked makes the constraint the
         * solver reasons with match the constraint the database enforces.
         *
         * The proto anticipates exactly this: existingSessions is documented as
         * carrying "Federation-owned Sessions that act purely as occupancy".
         */
        isLocked: row.isLocked || row.tenantId === null,
    } as WireSession;
}

/** Sessions carrying more rooms than the wire can express, for honest reporting. */
export function multiRoomSessionIds(rows: AppSessionRow[]): string[] {
    return rows.filter((row) => row.roomIds.length > 1).map((row) => row.id);
}
