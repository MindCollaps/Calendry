/**
 * Stage 3a/3c verification — proves the calendar and slot arithmetic against a
 * REAL tenant's data, not fixtures.
 *
 * Reads the tenant's actual Term, TimeGrid, CalendarPeriods and Sessions, builds
 * the wire AcademicCalendar, and computes `reference_slot` at several instants
 * including all three edge cases. Prints everything so the arithmetic can be
 * checked by eye against the database rows.
 *
 * Throwaway, like solver-smoke.ts. Delete once 3a/3c are wired into the real
 * input assembly and covered by tests.
 *
 *   bun run scripts/solver-calendar-check.ts [tenant-slug]
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { resolveOwnerDatabaseUrl } from './lib/ownerDatabaseUrl';
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
import { multiRoomSessionIds, toWireSession, toWireWeek } from '../server/utils/solverSessions';

const WEEK_KIND_NAMES = ['UNSPECIFIED', 'TEACHING', 'EXAM', 'BREAK', 'HOLIDAY'];

const slug = process.argv[2] ?? 'test';
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: resolveOwnerDatabaseUrl() }) });

function heading(text: string) {
    console.log(`\n${'─'.repeat(78)}\n${text}\n${'─'.repeat(78)}`);
}

try {
    const tenant = await prisma.tenant.findUnique({ where: { slug } });

    if (!tenant) {
        console.error(`No tenant '${slug}'.`);
        process.exit(1);
    }

    const term = await prisma.term.findFirst({
        where: { tenantId: tenant.id },
        orderBy: { startDate: 'asc' },
        include: { timeGrid: true, calendarPeriods: true },
    });

    if (!term?.timeGrid) {
        console.error('Tenant has no Term with a TimeGrid.');
        process.exit(1);
    }

    const grid = term.timeGrid;

    heading(`TENANT ${tenant.slug}  timezone=${tenant.timezone}`);
    console.log(`Term        ${term.name}`);
    console.log(`            ${isoDate(term.startDate)} → ${isoDate(term.endDate)}`);
    console.log(`            term start is a ${['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][isoWeekday(term.startDate)]}`);
    console.log(`            week 0 anchors to Monday ${isoDate(mondayOf(term.startDate))}`);
    console.log(`Grid        ${grid.blocksPerDay} blocks × ${grid.blockLengthMinutes}min,`
        + ` break ${grid.breakMinutes}min, starts ${String(grid.startHour).padStart(2, '0')}:${String(grid.startMinute).padStart(2, '0')},`
        + ` days [${grid.activeDays.join(',')}]`);
    console.log(`Periods     ${term.calendarPeriods.length}`);

    for (const period of term.calendarPeriods) {
        console.log(`            ${period.kind.padEnd(8)} ${isoDate(period.startDate)} → ${isoDate(period.endDate)}  ${period.name}`);
    }

    // -- Wire TimeGrid ------------------------------------------------------
    heading('WIRE TimeGrid');
    const wireGrid = toWireTimeGrid(grid, tenant.timezone);

    console.log(JSON.stringify(wireGrid, null, 2));
    console.log(`\nbreakMinutes=${grid.breakMinutes} is deliberately absent from the wire message`);
    console.log('(the solver reasons in block indices; breaks change no adjacency)');

    // -- Academic calendar --------------------------------------------------
    const calendar = buildAcademicCalendar(
        term.id,
        term.startDate,
        term.endDate,
        term.calendarPeriods.map((p) => ({ kind: p.kind, startDate: p.startDate, endDate: p.endDate })),
    );

    heading(`ACADEMIC CALENDAR — ${calendar.weeks.length} weeks, ${calendar.holidays.length} holiday days`);

    for (const week of calendar.weeks) {
        const kind = WEEK_KIND_NAMES[week.kind] ?? String(week.kind);
        const mark = kind === 'TEACHING' ? ' ' : '◆';

        console.log(`  ${mark} week ${String(week.index).padStart(2)}  ${week.startDate}  ${kind}`);
    }

    if (calendar.holidays.length) {
        console.log(`\n  holidays: ${calendar.holidays.map((h) => h.date).join(', ')}`);
    }

    // -- Block arithmetic ---------------------------------------------------
    heading('BLOCK ARITHMETIC (wall-clock minute → block index, breaks included)');
    const stride = grid.blockLengthMinutes + grid.breakMinutes;

    for (let block = 0; block < grid.blocksPerDay; block++) {
        const start = grid.startHour * 60 + grid.startMinute + block * stride;
        const end = start + grid.blockLengthMinutes;
        const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

        console.log(`  block ${block}  ${fmt(start)}–${fmt(end)}`
            + `   minute ${start} → ${blockOfMinute(grid, start)}`
            + `   minute ${end} → ${blockOfMinute(grid, end)}`);
    }

    console.log(`\n  07:00 (before teaching) → ${blockOfMinute(grid, 7 * 60)}`);
    console.log(`  23:00 (after teaching)  → ${blockOfMinute(grid, 23 * 60)}  (clamped to blocksPerDay)`);

    // -- reference_slot, including every edge case --------------------------
    heading('reference_slot');

    const probes: { label: string; now: Date; timeZone?: string }[] = [
        { label: 'NOW (real clock)', now: new Date() },
        { label: 'before term start', now: new Date(`${isoDate(term.startDate)}T00:00:00Z`) },
        { label: 'term start, 07:30 (pre-teaching)', now: new Date(`${isoDate(term.startDate)}T07:30:00Z`) },
        { label: 'term start, 09:00 (block 1)', now: new Date(`${isoDate(term.startDate)}T09:00:00Z`) },
        { label: 'term start, 23:00 (day over)', now: new Date(`${isoDate(term.startDate)}T23:00:00Z`) },
        { label: 'mid-term Wednesday 10:00', now: new Date('2026-12-02T10:00:00Z') },
        { label: 'inside the exam period', now: new Date('2027-02-03T10:00:00Z') },
        { label: 'last day of term', now: new Date(`${isoDate(term.endDate)}T10:00:00Z`) },
        { label: 'AFTER term end', now: new Date(`${isoDate(term.endDate)}T10:00:00Z`.replace(/^\d{4}/, String(term.endDate.getUTCFullYear() + 1))) },
        // Proves the tenant-timezone path rather than assuming UTC works for all.
        { label: 'same instant, Pacific/Auckland (next day there)', now: new Date('2026-12-02T20:00:00Z'), timeZone: 'Pacific/Auckland' },
        { label: 'same instant, America/Los_Angeles (still prior day)', now: new Date('2026-12-02T20:00:00Z'), timeZone: 'America/Los_Angeles' },
    ];

    for (const probe of probes) {
        const zone = probe.timeZone ?? tenant.timezone;
        const local = localNow(probe.now, zone);

        try {
            const slot = computeReferenceSlot({
                now: probe.now,
                timeZone: zone,
                termStart: term.startDate,
                termEnd: term.endDate,
                grid,
            });

            console.log(
                `  ${probe.label.padEnd(46)} local=${isoDate(local.date)} ${String(Math.floor(local.minutes / 60)).padStart(2, '0')}:${String(local.minutes % 60).padStart(2, '0')}`
                + `  →  week=${slot.week} day=${slot.day} block=${slot.block}`,
            );
        } catch (error) {
            if (error instanceof TermEndedError) {
                console.log(`  ${probe.label.padEnd(46)} local=${isoDate(local.date)}         →  REJECTED: ${error.message}`);
            } else {
                throw error;
            }
        }
    }

    // -- Sessions -----------------------------------------------------------
    const lecturerRole = await prisma.role.findFirst({
        where: { tenantId: tenant.id, key: 'lecturer' },
        select: { id: true },
    });

    const sessions = await prisma.session.findMany({
        where: { tenantId: tenant.id, termId: term.id },
        include: { kind: true, rooms: true, people: true, groups: true },
        orderBy: [{ termWeek: 'asc' }, { dayOfWeek: 'asc' }, { blockIndex: 'asc' }],
    });

    const rows = sessions.map((s) => ({
        id: s.id,
        tenantId: s.tenantId,
        offeringId: s.offeringId,
        kindId: s.kindId,
        termWeek: s.termWeek,
        dayOfWeek: s.dayOfWeek,
        blockIndex: s.blockIndex,
        durationBlocks: s.durationBlocks,
        isLocked: s.isLocked,
        kindKey: s.kind.key,
        roomIds: s.rooms.map((r) => r.roomId),
        lecturerIds: s.people.filter((p) => p.roleId === lecturerRole?.id).map((p) => p.personId),
        personIds: s.people.filter((p) => p.roleId !== lecturerRole?.id).map((p) => p.personId),
        groupIds: s.groups.map((g) => g.groupId),
    }));

    heading(`EXISTING SESSIONS — ${rows.length} in this term`);
    console.log('  app termWeek is 1-BASED; wire SlotRef.week is a 0-BASED index\n');

    for (const row of rows.slice(0, 12)) {
        const wire = toWireSession(row);

        console.log(
            `  ${row.id.slice(0, 12)}…  app(week=${row.termWeek} day=${row.dayOfWeek} block=${row.blockIndex})`
            + `  →  wire(week=${wire.startSlot?.week} day=${wire.startSlot?.day} block=${wire.startSlot?.block})`
            + `  kind=${wire.kind} room=${wire.roomId || '—'} locked=${wire.isLocked}`,
        );
    }

    if (rows.length > 12) {
        console.log(`  … and ${rows.length - 12} more`);
    }

    const weeks = [...new Set(rows.map((r) => r.termWeek))].sort((a, b) => a - b);

    console.log(`\n  distinct app weeks: [${weeks.join(', ')}]  →  wire weeks: [${weeks.map(toWireWeek).join(', ')}]`);

    const outOfRange = rows.filter((r) => toWireWeek(r.termWeek) < 0 || toWireWeek(r.termWeek) >= calendar.weeks.length);

    console.log(`  sessions outside the generated calendar: ${outOfRange.length}`
        + (outOfRange.length ? ` ⚠ ${outOfRange.map((r) => r.id.slice(0, 8)).join(', ')}` : ' ✓'));

    const multiRoom = multiRoomSessionIds(rows);

    console.log(`  sessions with >1 room (wire carries one): ${multiRoom.length}`
        + (multiRoom.length ? ` ⚠ ${multiRoom.map((id) => id.slice(0, 8)).join(', ')}` : ' ✓'));

    console.log('');
} finally {
    await prisma.$disconnect();
}
