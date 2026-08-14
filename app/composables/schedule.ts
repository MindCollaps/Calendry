/**
 * Schedule data and grid geometry.
 *
 * Every dimension of the grid is resolved from the tenant's TimeGrid at
 * runtime — active days, block count, block length, start time, breaks. There
 * is no fallback shape and no assumed Mon–Fri, because TAXONOMY.md §2 forbids
 * exactly that. A tenant with no TimeGrid renders an empty state, not a guess.
 */

export interface TimeGrid {
    id: string;
    name: string;
    blockLengthMinutes: number;
    blocksPerDay: number;
    activeDays: number[];
    startHour: number;
    startMinute: number;
    breakMinutes: number;
    isDefault: boolean;
}

export interface Term {
    id: string;
    name: string;
    startDate: string;
    endDate: string;
    timeGridId: string | null;
}

export interface ScheduleSession {
    id: string;
    offeringId: string;
    termId: string;
    kindId: string;
    termWeek: number;
    dayOfWeek: number;
    blockIndex: number;
    durationBlocks: number;
    isLocked: boolean;
    groups: { groupId: string }[];
    people: { personId: string; roleId: string | null }[];
    rooms: { roomId: string }[];
    offering: { id: string; title: string; code: string | null } | null;
    kind: { id: string; key: string; name: string; color: string | null } | null;
}

export interface Violation {
    id: string;
    sessionId: string;
    severity: 'HARD' | 'SOFT';
    detail: Record<string, unknown>;
    constraint: { id: string; type: string; name: string; severity: string };
}

export interface NamedRow { id: string; name: string }

/** ISO weekday numbers, index 1-7. Never used to decide which days exist. */
const WEEKDAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function weekdayName(iso: number): string {
    return WEEKDAY_NAMES[iso] ?? `Day ${iso}`;
}

export function weekdayShort(iso: number): string {
    return weekdayName(iso).slice(0, 3);
}

/**
 * Clock label for a block index, derived from the grid rather than assumed.
 * Blocks are laid end to end with `breakMinutes` between them.
 */
export function blockTime(grid: TimeGrid, blockIndex: number): { start: string; end: string } {
    const stride = grid.blockLengthMinutes + grid.breakMinutes;
    const startMinutes = grid.startHour * 60 + grid.startMinute + blockIndex * stride;
    const endMinutes = startMinutes + grid.blockLengthMinutes;

    const fmt = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

    return { start: fmt(startMinutes), end: fmt(endMinutes) };
}

/** Whole weeks spanned by a term, so the week stepper has real bounds. */
export function weeksInTerm(term: Term): number {
    const start = new Date(term.startDate).getTime();
    const end = new Date(term.endDate).getTime();

    return Math.max(1, Math.ceil((end - start) / (7 * 24 * 60 * 60 * 1000)));
}

/**
 * A session belongs on the grid only if its day is one the grid schedules AND
 * it fits within the day's blocks. Anything else is real data the grid cannot
 * position — it goes to the off-grid tray rather than vanishing.
 */
export function isOnGrid(grid: TimeGrid, session: ScheduleSession): boolean {
    return (
        grid.activeDays.includes(session.dayOfWeek)
        && session.blockIndex >= 0
        && session.blockIndex + session.durationBlocks <= grid.blocksPerDay
    );
}

export function offGridReason(grid: TimeGrid, session: ScheduleSession): string {
    if (!grid.activeDays.includes(session.dayOfWeek)) {
        return `${weekdayName(session.dayOfWeek)} is not a scheduled day on this grid`;
    }

    return `Runs past block ${grid.blocksPerDay} — the last block of the day`;
}

/** Sessions keyed by `${dayOfWeek}:${blockIndex}`, so a slot can hold several. */
export function groupBySlot(sessions: ScheduleSession[]): Map<string, ScheduleSession[]> {
    const map = new Map<string, ScheduleSession[]>();

    for (const session of sessions) {
        const key = `${session.dayOfWeek}:${session.blockIndex}`;
        const list = map.get(key) ?? [];

        list.push(session);
        map.set(key, list);
    }

    return map;
}

export function violationsBySession(violations: Violation[]): Map<string, Violation[]> {
    const map = new Map<string, Violation[]>();

    for (const violation of violations) {
        const list = map.get(violation.sessionId) ?? [];

        list.push(violation);
        map.set(violation.sessionId, list);
    }

    return map;
}

/** Turns a violation's structured detail into something a human can act on. */
export function describeViolation(violation: Violation, lookup: {
    room: (id: string) => string;
    person: (id: string) => string;
    group: (id: string) => string;
}): string {
    const detail = violation.detail as {
        reason?: string;
        roomIds?: string[];
        personIds?: string[];
        groupIds?: string[];
    };

    switch (detail.reason) {
        case 'room_double_booked':
            return `Room already booked at this time: ${(detail.roomIds ?? []).map(lookup.room).join(', ')}`;
        case 'person_double_booked':
            return `Already teaching at this time: ${(detail.personIds ?? []).map(lookup.person).join(', ')}`;
        case 'group_double_booked':
            return `Group already has a session: ${(detail.groupIds ?? []).map(lookup.group).join(', ')}`;
        default:
            return violation.constraint.name;
    }
}

/**
 * Side-by-side layout for sessions whose block ranges overlap.
 *
 * Grouping by identical start block is not enough: a session starting at block 1
 * overlaps one that started at block 0 and runs for two blocks, and the two land
 * in different grid areas that intersect — so they stack, and the upper chip's
 * hover lift reveals the one underneath.
 *
 * This is the ordinary calendar algorithm. Sessions that transitively overlap
 * form a cluster; within a cluster each session takes the first column free at
 * its start block, and every member is sized to 1/columns of the day's width.
 * Equal columns rather than a "+N more" affordance: in a timetabling tool an
 * overlap is usually a defect the user is trying to SEE, so hiding any of them
 * defeats the purpose.
 */
export interface SessionPlacement {
    session: ScheduleSession;
    /** 0-based column within the overlap cluster. */
    column: number;
    /** How many columns the cluster needs; 1 when nothing overlaps. */
    columns: number;
}

export function layoutDay(sessions: ScheduleSession[]): SessionPlacement[] {
    const ordered = [...sessions].sort((a, b) => (
        a.blockIndex - b.blockIndex || b.durationBlocks - a.durationBlocks || a.id.localeCompare(b.id)
    ));

    const end = (s: ScheduleSession) => s.blockIndex + s.durationBlocks;
    const out: SessionPlacement[] = [];

    let cluster: SessionPlacement[] = [];
    let clusterEnd = -1;
    // Last occupied block per column, so a column can be reused once free.
    let columnEnds: number[] = [];

    const flush = () => {
        const columns = columnEnds.length || 1;

        for (const placement of cluster) {
            placement.columns = columns;
        }

        out.push(...cluster);
        cluster = [];
        columnEnds = [];
        clusterEnd = -1;
    };

    for (const session of ordered) {
        // A gap with nothing running closes the cluster: what follows cannot
        // overlap anything in it, so it starts its own column count.
        if (cluster.length && session.blockIndex >= clusterEnd) {
            flush();
        }

        let column = columnEnds.findIndex((occupiedUntil) => occupiedUntil <= session.blockIndex);

        if (column === -1) {
            column = columnEnds.length;
        }

        columnEnds[column] = end(session);
        clusterEnd = Math.max(clusterEnd, end(session));
        cluster.push({ session, column, columns: 1 });
    }

    if (cluster.length) {
        flush();
    }

    return out;
}
