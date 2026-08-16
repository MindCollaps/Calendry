/**
 * Stage 3b/3e verification — assembles a REAL SolverInput from tenant data and
 * runs it against a live calendry-solver.
 *
 * Exercises the same `assembleSolverInput()` the route uses, so what is proven
 * here is the actual production path, not a parallel implementation. What it
 * does NOT cover is the HTTP layer (auth, the one-active-run index, the
 * transport-failure trap) — all of which Stage 2 proved separately.
 *
 * `--seed-relations` first fills in offering→lecturer/group links and raises
 * frequency, because the demo tenant's offerings had none. That is
 * under-specified fixture data rather than a designed state, and without it the
 * instance is trivially satisfiable and converges in zero moves.
 *
 * `--cancel` starts a deliberately large run and cancels it mid-flight, to
 * verify the RUNNING → CANCELLED transition that Stage 2 could not reach.
 *
 * Throwaway. Delete with the other Stage 3 check scripts.
 *
 *   bun run scripts/solver-e2e-check.ts [--seed-relations] [--cancel]
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { LockPolicy, RunStatus } from '@mindcollaps/calendry-proto';
import { resolveOwnerDatabaseUrl } from './lib/ownerDatabaseUrl';
import { assembleSolverInput } from '../server/utils/solverInput';
import { cancelRun, getStatus, startRun, toWireU64 } from '../server/utils/solverClient';

const SEED_RELATIONS = process.argv.includes('--seed-relations');
const DO_CANCEL = process.argv.includes('--cancel');
/**
 * Multiplies required_session_count IN MEMORY ONLY, to make the instance hard
 * enough that the solver stays RUNNING long enough to be cancelled.
 *
 * The real data converges in zero moves — 48 sessions into 760 slots is not a
 * search problem — so without this the RUNNING state is unobservable, which is
 * exactly why Stage 2 could not test cancellation. Nothing is written to the
 * database; the demo tenant is untouched.
 */
const STRESS = Number(process.argv.find((arg) => arg.startsWith('--stress='))?.split('=')[1] ?? '0');
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: resolveOwnerDatabaseUrl() }) });

const line = (text = '') => console.log(text);
const rule = (text: string) => line(`\n${'─'.repeat(78)}\n${text}\n${'─'.repeat(78)}`);

try {
    const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: 'test' } });
    const term = await prisma.term.findFirstOrThrow({
        where: { tenantId: tenant.id },
        orderBy: { startDate: 'asc' },
    });

    if (SEED_RELATIONS) {
        rule('SEEDING OFFERING RELATIONS (fixture repair, not part of the feature)');

        const offerings = await prisma.offering.findMany({ where: { tenantId: tenant.id, termId: term.id } });
        const lecturerRole = await prisma.role.findFirstOrThrow({ where: { tenantId: tenant.id, key: 'lecturer' } });
        const lecturers = await prisma.personRole.findMany({
            where: { tenantId: tenant.id, roleId: lecturerRole.id },
        });
        const groups = await prisma.group.findMany({ where: { tenantId: tenant.id }, orderBy: { name: 'asc' } });

        for (const [index, offering] of offerings.entries()) {
            const person = lecturers[index % lecturers.length];
            const group = groups[index % groups.length];

            await prisma.offeringLecturer.deleteMany({ where: { offeringId: offering.id } });
            await prisma.offeringGroup.deleteMany({ where: { offeringId: offering.id } });

            if (person) {
                await prisma.offeringLecturer.create({
                    data: {
                        offeringId: offering.id,
                        personId: person.personId,
                        roleId: lecturerRole.id,
                        tenantId: tenant.id,
                    },
                });
            }

            if (group) {
                await prisma.offeringGroup.create({
                    data: { offeringId: offering.id, groupId: group.id, tenantId: tenant.id },
                });
            }

            await prisma.offering.update({
                where: { id: offering.id },
                // Alternating, so allowOnline is exercised in both states rather
                // than being uniformly false and therefore untested.
                data: { frequency: 6, allowOnline: index % 2 === 0 },
            });
        }

        line(`  ${offerings.length} offerings: 1 lecturer + 1 group each, frequency 6, alternating allowOnline`);
    }

    // -- Assembly -----------------------------------------------------------
    const assembled = await prisma.$transaction((tx) => assembleSolverInput(tx as never, {
        tenantId: tenant.id,
        termId: term.id,
        now: new Date(),
    }));

    const { input, report, referenceSlot, inputHash } = assembled;

    if (STRESS > 1) {
        for (const offering of input.offerings) {
            offering.requiredSessionCount *= STRESS;
        }

        line(`\n  ⚠ --stress=${STRESS}: required_session_count multiplied IN MEMORY`
            + ` → ${input.offerings.reduce((sum, o) => sum + o.requiredSessionCount, 0)} sessions demanded.`);
        line('    The database is not modified. This exists only to make the run long enough to cancel.');
    }

    rule(`ASSEMBLED SolverInput — tenant '${tenant.slug}', term '${term.name}'`);
    line(`  requestingTenantId  ${input.requestingTenantId}`);
    line(`  federationId        '${input.federationId}'  (empty by scope decision, Stages 1–6)`);
    line(`  referenceSlot       week=${referenceSlot.week} day=${referenceSlot.day} block=${referenceSlot.block}`);
    line(`  inputHash           ${inputHash}`);
    line('');
    line(`  timeGrid            ${input.timeGrid?.blocksPerDay} blocks × ${input.timeGrid?.blockLengthMinutes}min`
        + ` from minute ${input.timeGrid?.dayStartMinute}, days [${input.timeGrid?.activeDays.join(',')}], tz ${input.timeGrid?.institutionTimezone}`);
    line(`  calendar            ${input.calendar?.weeks.length} weeks, ${input.calendar?.holidays.length} holidays`);
    line(`  rooms               ${report.counts.rooms}  (${input.rooms.filter((r) => r.isVirtual).length} virtual)`);
    line(`  persons             ${report.counts.persons}`);
    line(`  groups              ${report.counts.groups}`);
    line(`  offerings           ${report.counts.offerings}`
        + `  (${input.offerings.filter((o) => o.allowOnline).length} allow online,`
        + ` ${input.offerings.reduce((sum, o) => sum + o.requiredSessionCount, 0)} sessions demanded)`);
    line(`  existingSessions    ${report.counts.existingSessions}`);
    line(`  externalOccupancy   ${input.externalOccupancy.length}  (empty by scope decision)`);
    line(`  constraints         ${report.counts.constraints} sent`);

    rule('ASSEMBLY REPORT — everything narrowed on the way to the wire');
    line(`  federation rooms excluded       ${report.excludedFederationRooms}`);
    line(`  federation offerings excluded   ${report.excludedFederationOfferings}`);
    line(`  multi-room sessions flattened   ${report.multiRoomSessions.length}`);
    line(`  equipment quantities dropped    ${report.droppedEquipmentQuantities}`);
    line(`  constraints skipped             ${report.skippedConstraints.length}`);

    for (const skipped of report.skippedConstraints) {
        line(`      ${skipped.type.padEnd(30)} ${skipped.reason}`);
    }

    // Determinism of the hash itself: same data in, same hash out.
    const again = await prisma.$transaction((tx) => assembleSolverInput(tx as never, {
        tenantId: tenant.id,
        termId: term.id,
        now: new Date(),
    }));

    line(`\n  hash stable across two assemblies: ${again.inputHash === inputHash ? 'YES ✓' : 'NO ✗'}`);

    // -- Run ----------------------------------------------------------------
    const maxMoves = DO_CANCEL ? 4_000_000_000 : 200_000;
    const maxWallMillis = DO_CANCEL ? 600_000 : 20_000;

    rule(`SOLVER RUN — maxMoves=${maxMoves.toLocaleString()} maxWallMillis=${maxWallMillis}`);

    const started = await startRun({
        input,
        scope: {
            offeringIds: input.offerings.map((o) => o.id),
            groupIds: [],
            outsideScopePolicy: LockPolicy.LOCK_POLICY_HARD,
        },
        budget: { maxWallMillis: toWireU64(maxWallMillis), maxMoves: toWireU64(maxMoves) },
        seed: toWireU64(42),
        // Stress changes the problem, so it must change the key — otherwise the
        // solver returns the earlier, easy run and the cancel test observes
        // nothing.
        idempotencyKey: `${inputHash}:42:${STRESS}:${DO_CANCEL ? 'c' : 'n'}`,
    });

    line(`  StartRun  run_id=${started.runId}  seed=${started.seed}`);

    const terminal = new Set([
        RunStatus.RUN_STATUS_SUCCEEDED,
        RunStatus.RUN_STATUS_CANCELLED,
        RunStatus.RUN_STATUS_FAILED,
    ]);

    let sawRunning = false;
    let cancelled = false;
    let status = await getStatus(started.runId, false);

    for (let attempt = 0; attempt < 200; attempt++) {
        status = await getStatus(started.runId, false);

        if (status.status === RunStatus.RUN_STATUS_RUNNING) {
            sawRunning = true;
        }

        line(`  poll ${String(attempt).padStart(2, '0')}  ${RunStatus[status.status]}`
            + `  progress=${status.progress.toFixed(3)}`
            + `  objective=${status.bestObjective}`
            + `  moves=${status.movesEvaluated}`
            + `  elapsed=${status.elapsedMillis}ms`);

        // THE TRANSITION STAGE 2 COULD NOT REACH: cancel a genuinely in-flight
        // run and watch it land on CANCELLED rather than finishing.
        if (DO_CANCEL && !cancelled && status.status === RunStatus.RUN_STATUS_RUNNING && attempt >= 2) {
            line('\n  → CancelRun while RUNNING');

            const response = await cancelRun(started.runId);

            line(`    cancelled=${response.cancelled}  status=${RunStatus[response.status]}\n`);
            cancelled = true;
        }

        if (terminal.has(status.status)) {
            break;
        }

        await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const final = await getStatus(started.runId, true);

    rule('RESULT');
    line(`  final status        ${RunStatus[final.status]}`);
    line(`  saw RUNNING         ${sawRunning ? 'YES' : 'no (converged too fast to observe)'}`);

    if (DO_CANCEL) {
        line(`  cancel issued       ${cancelled ? 'YES' : 'no (never observed RUNNING)'}`);
        line(`  RUNNING → CANCELLED ${sawRunning && cancelled && final.status === RunStatus.RUN_STATUS_CANCELLED ? 'VERIFIED ✓' : 'NOT verified ✗'}`);
    }

    const result = final.result;

    if (result) {
        line(`  termination_reason  ${result.stats?.terminationReason}`);
        line(`  objective total     ${result.objective?.total}`);
        line(`  moves               evaluated=${result.stats?.movesEvaluated} accepted=${result.stats?.movesAccepted}`);
        line(`  placements          ${result.sessions.length}`);
        line(`  hard violations     ${result.hardViolations.length}`);

        for (const violation of result.hardViolations.slice(0, 6)) {
            line(`      ${violation.constraintType}: ${violation.detail}`);
        }

        const online = result.sessions.filter((s) => {
            const room = input.rooms.find((r) => r.id === s.roomId);

            return room?.isVirtual;
        });

        line(`  placed in a virtual room  ${online.length}  (allowOnline actually exercised)`);

        for (const placed of result.sessions.slice(0, 6)) {
            line(`      ${placed.offeringId.slice(0, 14)}…  week=${placed.startSlot?.week}`
                + ` day=${placed.startSlot?.day} block=${placed.startSlot?.block}`
                + ` room=${(placed.roomId || '—').slice(-12)}`
                + ` lecturers=[${placed.lecturerIds.length}] groups=[${placed.groupIds.length}]`);
        }
    }

    line('');
} finally {
    await prisma.$disconnect();
}
