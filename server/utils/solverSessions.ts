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
     * NOT nullable, unlike Room/Equipment/Offering: `session` has no
     * `federation_id` column. TAXONOMY.md carries an amendment making Session a
     * third federation-shareable entity, but it is NOT implemented in this
     * schema and is deferred to Stage 7 — so the wire's `owner` oneof only ever
     * takes its tenant branch here. Typing it as optional invited exactly the
     * mistake the compiler caught: reading a column that does not exist.
     */
    tenantId: string;
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
        // The oneof owner, always the tenant branch — see the note on
        // AppSessionRow.tenantId. When Stage 7 makes Session federation-
        // shareable this becomes a real choice.
        tenantId: row.tenantId,
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
        isLocked: row.isLocked,
    } as WireSession;
}

/** Sessions carrying more rooms than the wire can express, for honest reporting. */
export function multiRoomSessionIds(rows: AppSessionRow[]): string[] {
    return rows.filter((row) => row.roomIds.length > 1).map((row) => row.id);
}
