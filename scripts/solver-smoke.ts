/**
 * THROWAWAY Stage 1 connectivity probe. Not a route, not wired to any UI, not
 * imported by anything.
 *
 * Its only job is to prove this app and calendry-solver can complete a real
 * StartRun -> GetStatus round trip over gRPC with the published contract. There
 * is deliberately NO Prisma, no tenant context, and no data conversion: every
 * value below is hand-written. Real SolverInput assembly is Stage 3, and doing
 * any of it here would make this test pass for reasons that say nothing about
 * connectivity.
 *
 * Delete this file once Stage 2 gives the app a real solver client.
 *
 *   bun run solver:smoke
 *   CALENDRY_SOLVER_ADDR=127.0.0.1:50051 bun run scripts/solver-smoke.ts
 */
import { credentials } from '@grpc/grpc-js';
import {
    LockPolicy,
    RunStatus,
    SolverServiceClient,
    type GetStatusResponse,
    type SolverInput,
    type StartRunResponse,
} from '@mindcollaps/calendry-proto';

const ADDR = process.env.CALENDRY_SOLVER_ADDR ?? '127.0.0.1:50051';

/**
 * `--infeasible` demands more sessions than the grid can hold, to check the
 * warn-and-allow decision against the real solver: a run that CANNOT satisfy
 * every hard constraint should still reach RUN_STATUS_SUCCEEDED and report the
 * residual violations, rather than failing. That behaviour is what Stage 5
 * depends on, so it is worth confirming now rather than discovering later.
 */
const INFEASIBLE = process.argv.includes('--infeasible');

/**
 * A five-day, four-block week. Small enough to read the whole answer, big
 * enough that placement is not trivially forced.
 */
function buildInput(): SolverInput {
    return {
        requestingTenantId: 'smoke-tenant',
        // Stage 1 is single-tenant by decision (see CLAUDE.md): no federation,
        // and external_occupancy stays empty. Sending anything else here would
        // be inventing a mechanism this app's schema does not have yet.
        federationId: '',

        timeGrid: {
            blocksPerDay: 4,
            blockLengthMinutes: 45,
            dayStartMinute: 8 * 60,
            activeDays: [1, 2, 3, 4, 5],
            institutionTimezone: 'Europe/Berlin',
        },

        calendar: {
            termId: 'smoke-term',
            weeks: [
                { index: 0, startDate: '2026-09-07', kind: 1 /* TEACHING */ },
                { index: 1, startDate: '2026-09-14', kind: 1 /* TEACHING */ },
            ],
            holidays: [],
        },

        rooms: [
            {
                id: 'room-a',
                tenantId: 'smoke-tenant',
                name: 'Lecture Hall A',
                capacity: 120,
                rank: 5,
                isVirtual: false,
                featureTags: ['projector'],
                location: 'Main building',
            },
            {
                id: 'room-b',
                tenantId: 'smoke-tenant',
                name: 'Seminar Room B',
                capacity: 30,
                rank: 1,
                isVirtual: false,
                featureTags: [],
                location: 'Annexe',
            },
        ],

        persons: [
            { id: 'person-lecturer', roleTags: ['lecturer'], groupIds: [], blackouts: [] },
        ],

        groups: [
            { id: 'group-cohort', parentId: '', name: 'Cohort 1', size: 25 },
        ],

        offerings: [
            {
                id: 'offering-algorithms',
                tenantId: 'smoke-tenant',
                kind: 'lecture',
                requiredSessionCount: INFEASIBLE ? 60 : 2,
                durationBlocks: 1,
                candidateLecturerIds: ['person-lecturer'],
                requiredLecturerCount: 1,
                groupIds: ['group-cohort'],
                participantPersonIds: [],
                requiredRoomFeatures: ['projector'],
                minCapacity: 25,
                allowedRoomIds: [],
                allowOnline: false,
            },
            {
                id: 'offering-seminar',
                tenantId: 'smoke-tenant',
                kind: 'seminar',
                requiredSessionCount: 1,
                durationBlocks: 1,
                candidateLecturerIds: ['person-lecturer'],
                requiredLecturerCount: 1,
                groupIds: ['group-cohort'],
                participantPersonIds: [],
                requiredRoomFeatures: [],
                minCapacity: 25,
                allowedRoomIds: [],
                allowOnline: false,
            },
        ],

        // Nothing placed yet, and no cross-tenant occupancy (single-tenant scope).
        existingSessions: [],
        externalOccupancy: [],

        constraints: [
            {
                id: 'c-room',
                enabled: true,
                appliesToKinds: [],
                weight: 0,
                roomDoubleBooking: {},
            },
            {
                id: 'c-lecturer',
                enabled: true,
                appliesToKinds: [],
                weight: 0,
                lecturerDoubleBooking: {},
            },
            {
                id: 'c-group',
                enabled: true,
                appliesToKinds: [],
                weight: 0,
                groupDoubleBooking: {},
            },
            {
                id: 'c-frequency',
                enabled: true,
                appliesToKinds: [],
                weight: 0,
                exactFrequency: {},
            },
        ],

        // "Now" as a slot, supplied by the caller rather than read from a clock
        // so the run is replayable. Week 0 / Monday / block 0 = nothing is past.
        referenceSlot: { week: 0, day: 1, block: 0 },
    };
}

function startRun(client: SolverServiceClient, input: SolverInput): Promise<StartRunResponse> {
    return new Promise((resolve, reject) => {
        client.startRun(
            {
                input,
                scope: {
                    offeringIds: ['offering-algorithms', 'offering-seminar'],
                    groupIds: [],
                    outsideScopePolicy: LockPolicy.LOCK_POLICY_HARD,
                },
                // Move budget, not wall clock. Determinism only holds when the
                // run ends by move budget (CLAUDE.md) — a time-terminated run is
                // not reproducible, so a smoke test that used one would be
                // proving something weaker than it appears to.
                budget: { maxWallMillis: '10000', maxMoves: '50000' },
                // Explicit non-zero seed, for the same reason.
                seed: '42',
                idempotencyKey: '',
            },
            (error, response) => (error ? reject(error) : resolve(response)),
        );
    });
}

function getStatus(client: SolverServiceClient, runId: string, includeResult: boolean): Promise<GetStatusResponse> {
    return new Promise((resolve, reject) => {
        client.getStatus(
            { runId, includeResult },
            (error, response) => (error ? reject(error) : resolve(response)),
        );
    });
}

const TERMINAL = new Set([
    RunStatus.RUN_STATUS_SUCCEEDED,
    RunStatus.RUN_STATUS_CANCELLED,
    RunStatus.RUN_STATUS_FAILED,
]);

async function main() {
    console.log(`\ncalendry-solver smoke test → ${ADDR}\n`);

    const client = new SolverServiceClient(ADDR, credentials.createInsecure());

    const started = await startRun(client, buildInput());

    console.log(`StartRun  run_id=${started.runId}  seed=${started.seed}`);

    let status: GetStatusResponse | undefined;

    // Bounded, so a solver that never reaches a terminal state fails loudly here
    // rather than hanging a CI job forever.
    for (let attempt = 0; attempt < 100; attempt++) {
        status = await getStatus(client, started.runId, false);

        console.log(
            `  poll ${String(attempt).padStart(2, '0')}  status=${RunStatus[status.status]}`
            + `  progress=${status.progress.toFixed(2)}`
            + `  objective=${status.bestObjective}`
            + `  moves=${status.movesEvaluated}`
            + `  elapsed=${status.elapsedMillis}ms`,
        );

        if (TERMINAL.has(status.status)) {
            break;
        }

        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (!status || !TERMINAL.has(status.status)) {
        throw new Error('Run never reached a terminal state within the poll budget.');
    }

    // Results are only returned when asked for, so the polling loop above stays
    // cheap. One final call fetches the placement.
    const final = await getStatus(client, started.runId, true);

    console.log(`\nFinal status        ${RunStatus[final.status]}`);

    if (final.errorDetail) {
        console.log(`Error detail        ${final.errorDetail}`);
    }

    const result = final.result;

    if (!result) {
        throw new Error('Terminal run returned no result even with include_result set.');
    }

    console.log(`Termination reason  ${result.stats?.terminationReason}`);
    console.log(`Objective total     ${result.objective?.total}`);
    console.log(
        `Stats               moves_evaluated=${result.stats?.movesEvaluated}`
        + ` moves_accepted=${result.stats?.movesAccepted}`
        + ` elapsed=${result.stats?.elapsedMillis}ms`,
    );

    console.log(`\nPlacements (${result.sessions.length}):`);

    for (const session of result.sessions) {
        const slot = session.startSlot;

        console.log(
            `  ${session.offeringId.padEnd(22)}`
            + ` week=${slot?.week} day=${slot?.day} block=${slot?.block}`
            + ` dur=${session.durationBlocks}`
            + ` room=${session.roomId || '—'}`
            + ` lecturers=[${session.lecturerIds.join(', ')}]`
            + ` groups=[${session.groupIds.join(', ')}]`,
        );
    }

    // A SUCCEEDED run may still carry hard violations — that is a normal
    // outcome under the warn-and-allow decision, not an error. Printed either
    // way so "none" is a statement rather than an absence.
    console.log(`\nHard violations (${result.hardViolations.length}):`);

    if (result.hardViolations.length === 0) {
        console.log('  none');
    }

    for (const violation of result.hardViolations) {
        console.log(
            `  ${violation.constraintType} (${violation.constraintId})`
            + ` sessions=[${violation.sessionIds.join(', ')}]`
            + ` offerings=[${violation.offeringIds.join(', ')}]`
            + ` — ${violation.detail}`,
        );
    }

    if (result.objective?.components?.length) {
        console.log('\nObjective components:');

        for (const component of result.objective.components) {
            console.log(
                `  ${component.constraintType.padEnd(24)} raw=${component.rawCount} weighted=${component.weighted}`,
            );
        }
    }

    client.close();
    console.log('');
}

await main();
