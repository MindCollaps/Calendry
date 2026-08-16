import type { AcademicCalendar, SlotRef, TimeGrid as WireTimeGrid } from '@mindcollaps/calendry-proto';

/**
 * Stage 3a — the grid and the academic calendar, and the one genuinely hard
 * computation in the whole integration: `reference_slot`.
 *
 * Everything the solver places is addressed as (week, day, block) against the
 * calendar built here. If this is wrong, every placement is wrong in a way that
 * still looks like a valid timetable — so the arithmetic is kept in pure
 * functions over primitives, testable without a database.
 *
 * ALL DATE ARITHMETIC IS UTC-ANCHORED. `@db.Date` columns come back from Prisma
 * as UTC-midnight Dates, and doing day arithmetic in the server's local zone
 * shifts them by a day either side of midnight. The only place a real timezone
 * is consulted is `localNow`, which converts an instant into the TENANT's
 * calendar day — never the requester's (TAXONOMY.md §8).
 */

const MS_PER_DAY = 86_400_000;

/** ISO weekday, 1 = Monday … 7 = Sunday, from a UTC-anchored date. */
export function isoWeekday(date: Date): number {
    return ((date.getUTCDay() + 6) % 7) + 1;
}

/** UTC midnight of the Monday on or before `date`. */
export function mondayOf(date: Date): Date {
    const utcMidnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());

    return new Date(utcMidnight - (isoWeekday(new Date(utcMidnight)) - 1) * MS_PER_DAY);
}

/** ISO-8601 date (YYYY-MM-DD) of a UTC-anchored date. */
export function isoDate(date: Date): string {
    return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
    return new Date(date.getTime() + days * MS_PER_DAY);
}

/** Inclusive-range overlap on date-only values. */
function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
    return aStart.getTime() <= bEnd.getTime() && bStart.getTime() <= aEnd.getTime();
}

function covers(outerStart: Date, outerEnd: Date, innerStart: Date, innerEnd: Date): boolean {
    return outerStart.getTime() <= innerStart.getTime() && outerEnd.getTime() >= innerEnd.getTime();
}

// ---------------------------------------------------------------------------
// TimeGrid
// ---------------------------------------------------------------------------

export interface AppTimeGrid {
    blocksPerDay: number;
    blockLengthMinutes: number;
    activeDays: number[];
    startHour: number;
    startMinute: number;
    breakMinutes: number;
}

export function toWireTimeGrid(grid: AppTimeGrid, institutionTimezone: string): WireTimeGrid {
    return {
        blocksPerDay: grid.blocksPerDay,
        blockLengthMinutes: grid.blockLengthMinutes,
        dayStartMinute: grid.startHour * 60 + grid.startMinute,
        activeDays: [...grid.activeDays].sort((a, b) => a - b),
        institutionTimezone,
        // `breakMinutes` is DELIBERATELY NOT SENT: the wire TimeGrid has no such
        // field, and it needs none. The solver reasons in block INDICES, so a
        // gap between blocks changes no adjacency and no conflict — it only
        // changes what a block is called on a clock, which is presentation.
        // Breaks still matter locally (blockTime(), and blockOfMinute() below,
        // which maps wall-clock "now" onto an index). Do not "fix" this by
        // adding a field to the proto.
    };
}

/**
 * Block index containing `minutesSinceMidnight`, or the count of blocks already
 * finished when the time falls in a break or past the last block.
 *
 * This is the one calculation that MUST include breaks: it converts a wall-clock
 * instant into a grid index, and a 15-minute gap between blocks really does
 * shift when block 3 starts.
 */
export function blockOfMinute(grid: AppTimeGrid, minutesSinceMidnight: number): number {
    const dayStart = grid.startHour * 60 + grid.startMinute;
    const stride = grid.blockLengthMinutes + grid.breakMinutes;

    if (minutesSinceMidnight < dayStart || stride <= 0) {
        return 0;
    }

    const elapsed = minutesSinceMidnight - dayStart;
    const index = Math.floor(elapsed / stride);

    // Clamped to the day: a time after teaching ends means "the whole day is
    // past", which the caller expresses as blocksPerDay rather than an index
    // that does not exist.
    return Math.min(index, grid.blocksPerDay);
}

// ---------------------------------------------------------------------------
// Academic calendar
// ---------------------------------------------------------------------------

export type AppPeriodKind = 'HOLIDAY' | 'BREAK' | 'EXAM';

export interface AppCalendarPeriod {
    kind: AppPeriodKind;
    startDate: Date;
    endDate: Date;
}

/** Wire WeekKind values; the generated enum is numeric. */
const WEEK_KIND = { UNSPECIFIED: 0, TEACHING: 1, EXAM: 2, BREAK: 3, HOLIDAY: 4 } as const;

/**
 * Weeks are MONDAY-ANCHORED, per the proto's `start_date` = "that week's
 * Monday". A term rarely starts on a Monday, so week 0 begins at the Monday on
 * or before `term.startDate` — which means the first week may contain days
 * before the term itself. That is correct: the week index has to be derivable
 * from any date by the same rule, or `reference_slot` and Session weeks would
 * disagree.
 *
 * WEEK-KIND PRECEDENCE (policy, not derivation — confirmed before building):
 *   EXAM     if any exam period touches the week at all
 *   BREAK    if a break period covers the ENTIRE week
 *   HOLIDAY  if a holiday period covers the ENTIRE week
 *   TEACHING otherwise
 *
 * Holidays that do NOT swallow a whole week are emitted as individual dates in
 * `holidays[]`, matching the proto's "single days that are holidays inside
 * otherwise-teaching weeks". A week already marked HOLIDAY does not also list
 * its days — that would be the same fact twice.
 */
export function buildAcademicCalendar(
    termId: string,
    termStart: Date,
    termEnd: Date,
    periods: AppCalendarPeriod[],
): AcademicCalendar {
    const firstMonday = mondayOf(termStart);
    const lastMonday = mondayOf(termEnd);
    const weekCount = Math.floor((lastMonday.getTime() - firstMonday.getTime()) / (7 * MS_PER_DAY)) + 1;

    const exams = periods.filter((p) => p.kind === 'EXAM');
    const breaks = periods.filter((p) => p.kind === 'BREAK');
    const holidays = periods.filter((p) => p.kind === 'HOLIDAY');

    const weeks = [];
    const holidayDates: { date: string; label: string }[] = [];

    for (let index = 0; index < weekCount; index++) {
        const weekStart = addDays(firstMonday, index * 7);
        const weekEnd = addDays(weekStart, 6);

        let kind: number = WEEK_KIND.TEACHING;

        if (exams.some((p) => overlaps(p.startDate, p.endDate, weekStart, weekEnd))) {
            kind = WEEK_KIND.EXAM;
        } else if (breaks.some((p) => covers(p.startDate, p.endDate, weekStart, weekEnd))) {
            kind = WEEK_KIND.BREAK;
        } else if (holidays.some((p) => covers(p.startDate, p.endDate, weekStart, weekEnd))) {
            kind = WEEK_KIND.HOLIDAY;
        }

        weeks.push({ index, startDate: isoDate(weekStart), kind });

        if (kind === WEEK_KIND.HOLIDAY) {
            continue;
        }

        for (const period of holidays) {
            if (!overlaps(period.startDate, period.endDate, weekStart, weekEnd)) {
                continue;
            }

            for (let day = 0; day < 7; day++) {
                const date = addDays(weekStart, day);

                if (date >= period.startDate && date <= period.endDate) {
                    holidayDates.push({ date: isoDate(date), label: '' });
                }
            }
        }
    }

    return { termId, weeks, holidays: holidayDates };
}

// ---------------------------------------------------------------------------
// reference_slot
// ---------------------------------------------------------------------------

/**
 * Thrown when "now" is past the end of the term.
 *
 * Every Session would be excluded as past, and the solver would return an empty
 * placement that is indistinguishable from a successful solve of an empty
 * problem. Refusing is the honest answer; the route turns this into a 422.
 */
export class TermEndedError extends Error {
    constructor(readonly termEnd: string) {
        super(`The term ended on ${termEnd}; every session is in the past and there is nothing to place.`);
        this.name = 'TermEndedError';
    }
}

export interface TenantLocalNow {
    /** UTC-midnight Date of the tenant's local calendar day. */
    date: Date;
    /** Minutes since local midnight. */
    minutes: number;
}

/**
 * An instant, expressed as the TENANT's calendar day and time.
 *
 * Uses Intl rather than a date library — no new dependency, and it is the only
 * correct way to ask "what day is it in Europe/Berlin right now" without
 * reimplementing tzdata.
 */
export function localNow(now: Date, timeZone: string): TenantLocalNow {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(now);

    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0');

    // `hour: '2-digit'` with hour12:false yields 24 for midnight in some ICU
    // versions rather than 0, which would put midnight at the END of the day.
    const hour = get('hour') % 24;

    return {
        date: new Date(Date.UTC(get('year'), get('month') - 1, get('day'))),
        minutes: hour * 60 + get('minute'),
    };
}

/**
 * Maps "now" onto the tenant's academic calendar.
 *
 * Sessions starting strictly before this slot are excluded from recalculation —
 * a correctness rule, not a preference — so this decides what the solver is
 * allowed to move. It is computed ONCE per run and stored on `solver_run`,
 * because a value derived from the clock would otherwise make the "same input,
 * same seed" guarantee quietly false on a replay.
 */
export function computeReferenceSlot(options: {
    now: Date;
    timeZone: string;
    termStart: Date;
    termEnd: Date;
    grid: AppTimeGrid;
}): SlotRef {
    const { now, timeZone, termStart, termEnd, grid } = options;
    const local = localNow(now, timeZone);

    // After the term: refuse rather than return an empty timetable.
    if (local.date.getTime() > termEnd.getTime()) {
        throw new TermEndedError(isoDate(termEnd));
    }

    const firstMonday = mondayOf(termStart);

    // Before the term: nothing is past. The earliest addressable slot is the
    // grid's first active day, NOT day 1 — a grid that does not teach Monday
    // would otherwise get a reference day it never schedules.
    if (local.date.getTime() < termStart.getTime()) {
        const firstActiveDay = [...grid.activeDays].sort((a, b) => a - b)[0] ?? 1;

        return { week: 0, day: firstActiveDay, block: 0 };
    }

    const week = Math.floor((mondayOf(local.date).getTime() - firstMonday.getTime()) / (7 * MS_PER_DAY));

    return {
        week: Math.max(0, week),
        day: isoWeekday(local.date),
        block: blockOfMinute(grid, local.minutes),
    };
}
