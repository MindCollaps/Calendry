import { describe, expect, it } from 'vitest';
import {
    TermEndedError,
    blockOfMinute,
    buildAcademicCalendar,
    computeReferenceSlot,
    isoDate,
    isoWeekday,
    localNow,
    mondayOf,
    toWireTimeGrid,
} from '../server/utils/solverCalendar';
import { fromWireWeek, toWireSession, toWireWeek } from '../server/utils/solverSessions';

/**
 * Stage 3a/3c arithmetic.
 *
 * Pure functions, no server and no database — unlike the four integration
 * suites. These are the calculations whose failure mode is a plausible-looking
 * timetable that is silently a week or a block out, so they are asserted rather
 * than eyeballed.
 *
 * The concrete dates mirror the demo tenant's real term (2026-10-05 →
 * 2027-02-12, exams 2027-02-01 → 2027-02-12) so the expectations here and the
 * output of scripts/solver-calendar-check.ts can be compared directly.
 */
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

const GRID = {
    blocksPerDay: 8,
    blockLengthMinutes: 45,
    activeDays: [1, 2, 3, 4, 5],
    startHour: 8,
    startMinute: 0,
    breakMinutes: 15,
};

const TERM_START = d('2026-10-05');
const TERM_END = d('2027-02-12');

describe('date primitives', () => {
    it('reads ISO weekdays with Monday = 1 and Sunday = 7', () => {
        expect(isoWeekday(d('2026-10-05'))).toBe(1);
        expect(isoWeekday(d('2026-10-10'))).toBe(6);
        expect(isoWeekday(d('2026-10-11'))).toBe(7);
    });

    it('anchors to the Monday on or before a date, and is idempotent', () => {
        expect(isoDate(mondayOf(d('2026-10-05')))).toBe('2026-10-05');
        expect(isoDate(mondayOf(d('2026-10-11')))).toBe('2026-10-05');
        expect(isoDate(mondayOf(mondayOf(d('2026-10-09'))))).toBe('2026-10-05');
    });

    it('anchors a term that does NOT start on a Monday to the preceding Monday', () => {
        // Week 0 then contains days before the term itself, which is correct:
        // the week index must be derivable from any date by one rule, or
        // reference_slot and Session weeks would disagree.
        expect(isoDate(mondayOf(d('2026-10-07')))).toBe('2026-10-05');
    });
});

describe('TimeGrid mapping', () => {
    it('converts start hour/minute into minutes from midnight', () => {
        expect(toWireTimeGrid(GRID, 'UTC').dayStartMinute).toBe(480);
    });

    it('does not carry breakMinutes onto the wire', () => {
        // Deliberate: the solver reasons in block indices, so a gap between
        // blocks changes no adjacency. Asserted so a well-meaning "fix" that
        // adds it has to delete this test and read why.
        expect(Object.keys(toWireTimeGrid(GRID, 'UTC'))).not.toContain('breakMinutes');
    });
});

describe('blockOfMinute', () => {
    it('places each block start on its own index, with breaks in the stride', () => {
        // stride = 45 + 15 = 60, so blocks start on the hour from 08:00.
        expect(blockOfMinute(GRID, 8 * 60)).toBe(0);
        expect(blockOfMinute(GRID, 9 * 60)).toBe(1);
        expect(blockOfMinute(GRID, 15 * 60)).toBe(7);
    });

    it('keeps a time inside a block on that block, not the next', () => {
        expect(blockOfMinute(GRID, 8 * 60 + 44)).toBe(0);
    });

    it('counts a time inside a BREAK as the preceding block being finished', () => {
        // 08:50 is between block 0 (ends 08:45) and block 1 (starts 09:00).
        expect(blockOfMinute(GRID, 8 * 60 + 50)).toBe(0);
    });

    it('returns 0 before teaching starts and clamps after it ends', () => {
        expect(blockOfMinute(GRID, 7 * 60)).toBe(0);
        expect(blockOfMinute(GRID, 23 * 60)).toBe(GRID.blocksPerDay);
    });

    it('ignores breaks only when there are none', () => {
        const noBreak = { ...GRID, breakMinutes: 0 };

        expect(blockOfMinute(noBreak, 8 * 60 + 45)).toBe(1);
        expect(blockOfMinute(GRID, 8 * 60 + 45)).toBe(0);
    });
});

describe('buildAcademicCalendar', () => {
    const calendar = buildAcademicCalendar('term-1', TERM_START, TERM_END, [
        { kind: 'EXAM', startDate: d('2027-02-01'), endDate: d('2027-02-12') },
    ]);

    it('generates one Monday-anchored week per week of the term', () => {
        expect(calendar.weeks).toHaveLength(19);
        expect(calendar.weeks[0]?.startDate).toBe('2026-10-05');
        expect(calendar.weeks[18]?.startDate).toBe('2027-02-08');
    });

    it('marks a week EXAM when any exam period touches it', () => {
        expect(calendar.weeks[17]?.kind).toBe(2);
        expect(calendar.weeks[18]?.kind).toBe(2);
        expect(calendar.weeks[16]?.kind).toBe(1);
    });

    it('marks a week BREAK only when a break period covers the WHOLE week', () => {
        const partial = buildAcademicCalendar('t', TERM_START, TERM_END, [
            { kind: 'BREAK', startDate: d('2026-10-14'), endDate: d('2026-10-15') },
        ]);
        const whole = buildAcademicCalendar('t', TERM_START, TERM_END, [
            { kind: 'BREAK', startDate: d('2026-10-12'), endDate: d('2026-10-18') },
        ]);

        expect(partial.weeks[1]?.kind).toBe(1);
        expect(whole.weeks[1]?.kind).toBe(3);
    });

    it('gives EXAM precedence over a BREAK covering the same week', () => {
        const both = buildAcademicCalendar('t', TERM_START, TERM_END, [
            { kind: 'BREAK', startDate: d('2026-10-12'), endDate: d('2026-10-18') },
            { kind: 'EXAM', startDate: d('2026-10-14'), endDate: d('2026-10-14') },
        ]);

        expect(both.weeks[1]?.kind).toBe(2);
    });

    it('lists single holiday days rather than reclassifying their week', () => {
        const withHoliday = buildAcademicCalendar('t', TERM_START, TERM_END, [
            { kind: 'HOLIDAY', startDate: d('2026-10-14'), endDate: d('2026-10-14') },
        ]);

        expect(withHoliday.weeks[1]?.kind).toBe(1);
        expect(withHoliday.holidays.map((h) => h.date)).toEqual(['2026-10-14']);
    });

    it('marks a fully-covered week HOLIDAY and does not also list its days', () => {
        const wholeWeek = buildAcademicCalendar('t', TERM_START, TERM_END, [
            { kind: 'HOLIDAY', startDate: d('2026-10-12'), endDate: d('2026-10-18') },
        ]);

        expect(wholeWeek.weeks[1]?.kind).toBe(4);
        expect(wholeWeek.holidays).toEqual([]);
    });
});

describe('computeReferenceSlot', () => {
    const base = { timeZone: 'UTC', termStart: TERM_START, termEnd: TERM_END, grid: GRID };

    it('returns the first ACTIVE day at block 0 before the term starts', () => {
        const slot = computeReferenceSlot({ ...base, now: new Date('2026-08-16T12:00:00Z') });

        expect(slot).toEqual({ week: 0, day: 1, block: 0 });
    });

    it('uses the grid\'s own first active day, not Monday', () => {
        // A grid that does not teach Monday must not be handed a Monday.
        const slot = computeReferenceSlot({
            ...base,
            grid: { ...GRID, activeDays: [3, 4, 5] },
            now: new Date('2026-08-16T12:00:00Z'),
        });

        expect(slot.day).toBe(3);
    });

    it('maps a mid-term instant onto the right week, day and block', () => {
        // 2026-12-02 is a Wednesday; its Monday is 2026-11-30, which the
        // calendar above lists as week 8.
        const slot = computeReferenceSlot({ ...base, now: new Date('2026-12-02T10:00:00Z') });

        expect(slot).toEqual({ week: 8, day: 3, block: 2 });
    });

    it('refuses a term that has already ended', () => {
        expect(() => computeReferenceSlot({ ...base, now: new Date('2027-03-01T10:00:00Z') }))
            .toThrow(TermEndedError);
    });

    it('accepts the last day of term', () => {
        const slot = computeReferenceSlot({ ...base, now: new Date('2027-02-12T10:00:00Z') });

        expect(slot).toEqual({ week: 18, day: 5, block: 2 });
    });

    it('resolves the TENANT timezone, so one instant gives different slots', () => {
        const now = new Date('2026-12-02T20:00:00Z');

        // 09:00 the NEXT day in Auckland, still the prior afternoon in LA.
        expect(computeReferenceSlot({ ...base, timeZone: 'Pacific/Auckland', now }))
            .toEqual({ week: 8, day: 4, block: 1 });
        expect(computeReferenceSlot({ ...base, timeZone: 'America/Los_Angeles', now }))
            .toEqual({ week: 8, day: 3, block: 4 });
    });

    it('puts local midnight at the start of the day, not the end', () => {
        // ICU can render midnight as hour 24 with hour12:false, which would
        // otherwise push it past the last block.
        const local = localNow(new Date('2026-12-02T00:00:00Z'), 'UTC');

        expect(local.minutes).toBe(0);
        expect(isoDate(local.date)).toBe('2026-12-02');
    });
});

describe('session week mapping', () => {
    it('shifts 1-based termWeek to a 0-based wire index', () => {
        expect(toWireWeek(1)).toBe(0);
        expect(fromWireWeek(0)).toBe(1);
        expect(fromWireWeek(toWireWeek(7))).toBe(7);
    });

    it('carries placement and lock state onto the wire session', () => {
        const wire = toWireSession({
            id: 'session-1',
            tenantId: 'tenant-1',
            offeringId: 'offering-1',
            kindId: 'kind-1',
            kindKey: 'lecture',
            termWeek: 3,
            dayOfWeek: 2,
            blockIndex: 4,
            durationBlocks: 2,
            isLocked: true,
            roomIds: ['room-1'],
            lecturerIds: ['person-1'],
            personIds: [],
            groupIds: ['group-1'],
        });

        expect(wire.startSlot).toEqual({ week: 2, day: 2, block: 4 });
        expect(wire.isLocked).toBe(true);
        expect(wire.roomId).toBe('room-1');
        expect(wire.kind).toBe('lecture');
    });
});
