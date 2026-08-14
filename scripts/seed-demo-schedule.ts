/**
 * Builds a demo week of Sessions for one tenant, so the schedule UI has real
 * data to render.
 *
 * WHY THIS IS A SCRIPT AND NOT API CALLS
 * --------------------------------------
 * The API cannot bootstrap a schedule. The CRUD registry exposes nine entities
 * and `session-kinds` is not among them, so an Offering (which requires a
 * kind_id) cannot be created over HTTP. There is no Session-create route and no
 * Generation-create route either: Sessions were always meant to arrive from a
 * solver Generation, and the solver does not exist yet. Until it does, demo
 * data has to be written directly.
 *
 * DELIBERATELY NOT IN prisma/seeds/fixtures/. That tier is guarded and empty by
 * design; it is for data every development environment wants. This is demo
 * content for one named tenant, run on request.
 *
 *   bun run seed:demo -- --tenant test [--reset]
 *
 * Runs on the APP role: everything it writes is tenant-scoped, so it goes
 * through the same RLS the application does rather than around it. That also
 * makes it a live test of those policies.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { describeTarget, resolveOwnerDatabaseUrl } from './lib/ownerDatabaseUrl';

function arg(name: string): string | undefined {
    const index = process.argv.indexOf(`--${name}`);

    return index === -1 ? undefined : process.argv[index + 1];
}

const tenantSlug = arg('tenant') ?? 'test';
const reset = process.argv.includes('--reset');

/**
 * A deliberately ordinary teaching week: five days, eight 45-minute blocks
 * from 08:00. Values live here, never in the UI — the grid reads whatever the
 * tenant configured (TAXONOMY.md §2).
 */
const GRID = {
    name: 'Standard week',
    blockLengthMinutes: 45,
    blocksPerDay: 8,
    activeDays: [1, 2, 3, 4, 5],
    startHour: 8,
    startMinute: 0,
    breakMinutes: 15,
};

const ROOMS = [
    { code: 'A101', name: 'Lecture Hall A', capacity: 180, ranking: 3 },
    { code: 'B204', name: 'Seminar Room B', capacity: 40, ranking: 1 },
    { code: 'C012', name: 'Computer Lab C', capacity: 24, ranking: 2 },
    { code: 'ONLINE', name: 'Online', capacity: 999, ranking: 0, isVirtual: true },
];

const SUBJECTS = [
    'Databases', 'Algorithms', 'Operating Systems', 'Statistics',
    'Computer Networks', 'Software Engineering', 'Linear Algebra', 'Compilers',
];

const LECTURERS = [
    ['Ada', 'Lovelace'], ['Grace', 'Hopper'], ['Edsger', 'Dijkstra'],
    ['Barbara', 'Liskov'], ['Tony', 'Hoare'],
];

async function main() {
    const connectionString = resolveOwnerDatabaseUrl();
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

    console.log(`Seeding demo schedule on ${describeTarget(connectionString)} for tenant '${tenantSlug}'...`);

    try {
        const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });

        if (!tenant) {
            throw new Error(`No tenant with slug '${tenantSlug}'. Provision one first.`);
        }

        const t = tenant.id;

        if (reset) {
            // Sessions cascade from Offering; events/generations need their
            // append-only guards lifted, which only the owner can do.
            await prisma.$executeRawUnsafe('ALTER TABLE session_event DISABLE TRIGGER session_event_append_only');
            await prisma.$executeRawUnsafe('ALTER TABLE generation DISABLE TRIGGER generation_no_delete');
            await prisma.$executeRawUnsafe(`DELETE FROM session_event WHERE tenant_id = '${t}'`);
            await prisma.$executeRawUnsafe(`DELETE FROM "session" WHERE tenant_id = '${t}'`);
            await prisma.$executeRawUnsafe(`DELETE FROM generation WHERE tenant_id = '${t}'`);
            await prisma.$executeRawUnsafe(`DELETE FROM offering WHERE tenant_id = '${t}'`);
            await prisma.$executeRawUnsafe('ALTER TABLE session_event ENABLE TRIGGER session_event_append_only');
            await prisma.$executeRawUnsafe('ALTER TABLE generation ENABLE TRIGGER generation_no_delete');
            console.log('  cleared existing sessions, offerings and generations');
        }

        const kind = await prisma.sessionKind.upsert({
            where: { tenantId_key: { tenantId: t, key: 'lecture' } },
            create: { tenantId: t, key: 'lecture', name: 'Lecture', color: '#7c59bc' },
            update: {},
        });

        const seminarKind = await prisma.sessionKind.upsert({
            where: { tenantId_key: { tenantId: t, key: 'seminar' } },
            create: { tenantId: t, key: 'seminar', name: 'Seminar', color: '#587c58' },
            update: {},
        });

        const grid = await prisma.timeGrid.upsert({
            where: { tenantId_name: { tenantId: t, name: GRID.name } },
            create: { tenantId: t, ...GRID, isDefault: true },
            update: { ...GRID, isDefault: true },
        });

        const term = await prisma.term.upsert({
            where: { tenantId_name: { tenantId: t, name: 'Winter 2026/27' } },
            create: {
                tenantId: t, name: 'Winter 2026/27',
                startDate: new Date('2026-10-05'), endDate: new Date('2027-02-12'),
                timeGridId: grid.id,
            },
            update: { timeGridId: grid.id },
        });

        // An exam period, so the academic calendar is not empty (TAXONOMY.md §2).
        await prisma.calendarPeriod.upsert({
            where: { id: `${t}-exams` },
            create: {
                id: `${t}-exams`, tenantId: t, termId: term.id, kind: 'EXAM',
                name: 'Exam weeks', startDate: new Date('2027-02-01'), endDate: new Date('2027-02-12'),
            },
            update: {},
        });

        const rooms = [];

        for (const room of ROOMS) {
            rooms.push(await prisma.room.upsert({
                where: { id: `${t}-room-${room.code}` },
                create: { id: `${t}-room-${room.code}`, tenantId: t, ...room },
                update: {},
            }));
        }

        const lecturerRole = await prisma.role.findFirst({ where: { tenantId: t, key: 'lecturer' } });

        const people = [];

        for (const [givenName, familyName] of LECTURERS) {
            const email = `${givenName.toLowerCase()}.${familyName.toLowerCase()}@demo.local`;
            const person = await prisma.person.upsert({
                where: { tenantId_email: { tenantId: t, email } },
                create: { tenantId: t, givenName, familyName, email },
                update: {},
            });

            if (lecturerRole) {
                await prisma.personRole.upsert({
                    where: { personId_roleId: { personId: person.id, roleId: lecturerRole.id } },
                    create: { tenantId: t, personId: person.id, roleId: lecturerRole.id },
                    update: {},
                });
            }

            people.push(person);
        }

        // A nested group tree, so the closure and its "include nested" filter
        // have something real to resolve.
        const cohort = await prisma.group.upsert({
            where: { id: `${t}-cohort` },
            create: { id: `${t}-cohort`, tenantId: t, name: 'Informatics 2026', expectedSize: 160 },
            update: {},
        });

        const classes = [];

        for (const name of ['Class A', 'Class B']) {
            const group = await prisma.group.upsert({
                where: { id: `${t}-class-${name.slice(-1)}` },
                create: {
                    id: `${t}-class-${name.slice(-1)}`, tenantId: t,
                    parentGroupId: cohort.id, name, expectedSize: 80,
                },
                update: {},
            });

            classes.push(group);
        }

        const seminarGroup = await prisma.group.upsert({
            where: { id: `${t}-seminar-a1` },
            create: {
                id: `${t}-seminar-a1`, tenantId: t,
                parentGroupId: classes[0]!.id, name: 'Seminar A1', expectedSize: 20,
            },
            update: {},
        });

        const generation = await prisma.generation.upsert({
            where: { tenantId_version: { tenantId: t, version: 1 } },
            create: {
                tenantId: t, version: 1, source: 'MANUAL_BASELINE',
                status: 'APPLIED', isCurrent: true,
            },
            update: {},
        });

        // --- placements ------------------------------------------------------
        // Spread across the week, then two deliberate defects so the violation
        // path is visible rather than theoretical.
        let created = 0;
        const groups = [cohort, ...classes, seminarGroup];

        for (let i = 0; i < SUBJECTS.length; i++) {
            const subject = SUBJECTS[i] as string;
            const offering = await prisma.offering.upsert({
                where: { id: `${t}-offering-${i}` },
                create: {
                    id: `${t}-offering-${i}`, tenantId: t, termId: term.id,
                    kindId: i % 3 === 0 ? seminarKind.id : kind.id,
                    code: `INF-${100 + i}`, title: subject, frequency: 2, durationBlocks: i % 4 === 0 ? 2 : 1,
                },
                update: {},
            });

            for (let occurrence = 0; occurrence < 2; occurrence++) {
                const dayOfWeek = GRID.activeDays[(i + occurrence * 2) % GRID.activeDays.length] as number;
                const blockIndex = (i + occurrence * 3) % (GRID.blocksPerDay - 1);
                const id = `${t}-session-${i}-${occurrence}`;

                await prisma.session.upsert({
                    where: { id },
                    create: {
                        id, tenantId: t, offeringId: offering.id, termId: term.id,
                        kindId: offering.kindId, timeGridId: grid.id,
                        termWeek: 1, dayOfWeek, blockIndex,
                        durationBlocks: offering.durationBlocks,
                        generationId: generation.id,
                        // One pinned session, so the locked state is visible.
                        isLocked: i === 1 && occurrence === 0,
                    },
                    update: {},
                });

                const room = rooms[i % rooms.length]!;
                const person = people[i % people.length]!;
                const group = groups[i % groups.length]!;

                await prisma.sessionRoom.upsert({
                    where: { sessionId_roomId: { sessionId: id, roomId: room.id } },
                    create: { tenantId: t, sessionId: id, roomId: room.id },
                    update: {},
                });
                await prisma.sessionPerson.upsert({
                    where: { sessionId_personId: { sessionId: id, personId: person.id } },
                    create: { tenantId: t, sessionId: id, personId: person.id, roleId: lecturerRole?.id ?? null },
                    update: {},
                });
                await prisma.sessionGroup.upsert({
                    where: { sessionId_groupId: { sessionId: id, groupId: group.id } },
                    create: { tenantId: t, sessionId: id, groupId: group.id },
                    update: {},
                });

                created++;
            }
        }

        // Defect 1: two sessions in the same room, same slot — a hard room
        // double-booking the evaluator will flag on the next edit.
        const clash = `${t}-session-clash`;

        await prisma.session.upsert({
            where: { id: clash },
            create: {
                id: clash, tenantId: t, offeringId: `${t}-offering-0`, termId: term.id,
                kindId: kind.id, timeGridId: grid.id,
                termWeek: 1, dayOfWeek: GRID.activeDays[0] as number, blockIndex: 0,
                durationBlocks: 2, generationId: generation.id,
            },
            update: {},
        });
        await prisma.sessionRoom.upsert({
            where: { sessionId_roomId: { sessionId: clash, roomId: rooms[0]!.id } },
            create: { tenantId: t, sessionId: clash, roomId: rooms[0]!.id },
            update: {},
        });
        await prisma.sessionGroup.upsert({
            where: { sessionId_groupId: { sessionId: clash, groupId: classes[1]!.id } },
            create: { tenantId: t, sessionId: clash, groupId: classes[1]!.id },
            update: {},
        });

        // Defect 2: a session placed on a day this TimeGrid does not schedule.
        // Representable in the schema (the CHECK only bounds 1-7), so the grid
        // must surface it rather than silently drop it.
        const offGrid = `${t}-session-offgrid`;

        await prisma.session.upsert({
            where: { id: offGrid },
            create: {
                id: offGrid, tenantId: t, offeringId: `${t}-offering-1`, termId: term.id,
                kindId: kind.id, timeGridId: grid.id,
                termWeek: 1, dayOfWeek: 6, blockIndex: 0,
                durationBlocks: 1, generationId: generation.id,
            },
            update: {},
        });

        console.log(`  ${created + 2} sessions across ${GRID.activeDays.length} days of week 1`);
        console.log(`  1 locked, 1 room double-booking, 1 off-grid (Saturday on a Mon-Fri grid)`);
        console.log(`  term '${term.name}', grid '${grid.name}' (${GRID.blocksPerDay} x ${GRID.blockLengthMinutes}min)`);
        console.log('Done.');
    } catch (error) {
        console.error(`\nFailed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
    } finally {
        await prisma.$disconnect();
    }
}

await main();
