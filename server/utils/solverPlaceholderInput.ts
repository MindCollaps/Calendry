import type { SolverInput } from '@mindcollaps/calendry-proto';

/**
 * ⚠ STAGE 2 PLACEHOLDER — NOT REAL TENANT DATA. Replaced wholesale in Stage 3.
 *
 * Stage 2's job is the run lifecycle: schema, the one-active-run rule, and the
 * StartRun/GetStatus/CancelRun surface. Assembling a genuine `SolverInput` from
 * Prisma — including computing `reference_slot` against the tenant's academic
 * calendar so past Sessions are excluded — is Stage 3, and doing a rushed
 * version of it here would make the lifecycle appear to work for reasons that
 * say nothing about whether the data is right.
 *
 * So the routes send this: a fixed, hand-written snapshot that has nothing to
 * do with the requesting tenant. It exercises the wire and produces a real run.
 *
 * WHY THIS IS SHOUTED ABOUT RATHER THAN QUIETLY TEMPORARY: a route that starts
 * real solver runs against fake data looks exactly like a working feature. Every
 * run records `meta.inputSource = 'stage-2-placeholder'` and every response
 * carries `placeholderInput: true`, so a result can never be mistaken for a
 * timetable anyone asked for. Stage 3 removes this file and both markers
 * together; if you find one without the other, something is half-migrated.
 */
export const PLACEHOLDER_INPUT_SOURCE = 'stage-2-placeholder';

export function buildPlaceholderInput(tenantId: string, termId: string): SolverInput {
    return {
        // The only two values taken from the caller — enough that the run is
        // traceable to the request, not enough to make it meaningful.
        requestingTenantId: tenantId,
        federationId: '',

        timeGrid: {
            blocksPerDay: 4,
            blockLengthMinutes: 45,
            dayStartMinute: 8 * 60,
            activeDays: [1, 2, 3, 4, 5],
            institutionTimezone: 'Europe/Berlin',
        },

        calendar: {
            termId,
            weeks: [
                { index: 0, startDate: '2026-09-07', kind: 1 },
                { index: 1, startDate: '2026-09-14', kind: 1 },
            ],
            holidays: [],
        },

        rooms: [
            {
                id: 'placeholder-room-a',
                tenantId,
                name: 'Placeholder Hall A',
                capacity: 120,
                rank: 5,
                isVirtual: false,
                featureTags: ['projector'],
                location: '',
            },
            {
                id: 'placeholder-room-b',
                tenantId,
                name: 'Placeholder Room B',
                capacity: 30,
                rank: 1,
                isVirtual: false,
                featureTags: [],
                location: '',
            },
        ],

        persons: [{ id: 'placeholder-lecturer', roleTags: ['lecturer'], groupIds: [], blackouts: [] }],
        groups: [{ id: 'placeholder-group', parentId: '', name: 'Placeholder Cohort', size: 25 }],

        offerings: [
            {
                id: 'placeholder-offering-1',
                tenantId,
                kind: 'lecture',
                requiredSessionCount: 2,
                durationBlocks: 1,
                candidateLecturerIds: ['placeholder-lecturer'],
                requiredLecturerCount: 1,
                groupIds: ['placeholder-group'],
                participantPersonIds: [],
                requiredRoomFeatures: ['projector'],
                minCapacity: 25,
                allowedRoomIds: [],
                allowOnline: false,
            },
            {
                id: 'placeholder-offering-2',
                tenantId,
                kind: 'seminar',
                requiredSessionCount: 1,
                durationBlocks: 1,
                candidateLecturerIds: ['placeholder-lecturer'],
                requiredLecturerCount: 1,
                groupIds: ['placeholder-group'],
                participantPersonIds: [],
                requiredRoomFeatures: [],
                minCapacity: 25,
                allowedRoomIds: [],
                allowOnline: false,
            },
        ],

        // Single-tenant, non-federated scope for Stages 1–6 (CLAUDE.md). Sending
        // anything in external_occupancy would mean inventing a mechanism this
        // app's schema does not have.
        existingSessions: [],
        externalOccupancy: [],

        constraints: [
            { id: 'placeholder-c-room', enabled: true, appliesToKinds: [], weight: 0, roomDoubleBooking: {} },
            { id: 'placeholder-c-lecturer', enabled: true, appliesToKinds: [], weight: 0, lecturerDoubleBooking: {} },
            { id: 'placeholder-c-group', enabled: true, appliesToKinds: [], weight: 0, groupDoubleBooking: {} },
            { id: 'placeholder-c-frequency', enabled: true, appliesToKinds: [], weight: 0, exactFrequency: {} },
        ],

        // Caller-supplied "now", so a run is replayable rather than dependent on
        // a server clock. Computing this properly against the tenant's calendar
        // is explicitly Stage 3's hardest piece.
        referenceSlot: { week: 0, day: 1, block: 0 },
    };
}

/** The offering ids the placeholder input defines, for a default SolveScope. */
export const PLACEHOLDER_OFFERING_IDS = ['placeholder-offering-1', 'placeholder-offering-2'];
