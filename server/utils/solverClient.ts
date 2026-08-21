import { existsSync } from 'node:fs';
import { credentials } from '@grpc/grpc-js';
import {
    RunStatus,
    SolverServiceClient,
    type CancelRunResponse,
    type GetStatusResponse,
    type StartRunRequest,
    type StartRunResponse,
} from '@mindcollaps/calendry-proto';
import type { SolverRunStatus } from '@prisma/client';

/**
 * The gRPC boundary to calendry-solver.
 *
 * The solver is STATELESS and never touches Postgres: everything it knows, this
 * app put in the request. Nothing in this file assembles that request — see
 * `solverInput.ts` for the assembly, which builds it from tenant data.
 *
 * Unary calls only, by the contract's design: the solver owns run state while a
 * run is in flight and this app polls, rather than holding a stream open.
 */

/** Reused across requests — a channel is expensive and safely shared. */
let client: SolverServiceClient | undefined;

/**
 * Where the solver is, from wherever this process happens to be running.
 *
 * Two addresses for one service, the same shape the database already uses
 * (`MIGRATION_DATABASE_URL` / `..._HOST`): `solver:50051` resolves only on the
 * compose network, while host-run tooling — `bun run test`, which starts a Nuxt
 * server outside compose, plus the CLI scripts — needs the published port.
 * Neither value works in both places, so the environment cannot simply prefer
 * whichever is set; it is selected by asking where we are.
 *
 * `/.dockerenv` is the same probe `scripts/lib/ownerDatabaseUrl.ts` uses, for
 * the same reason.
 */
export function solverAddress(): string {
    const inContainer = existsSync('/.dockerenv');

    if (inContainer) {
        return process.env.CALENDRY_SOLVER_ADDR ?? 'solver:50051';
    }

    return process.env.CALENDRY_SOLVER_ADDR_HOST
        ?? process.env.CALENDRY_SOLVER_ADDR
        ?? '127.0.0.1:50051';
}

export function getSolverClient(): SolverServiceClient {
    if (!client) {
        // Insecure is correct for a local/compose-internal solver. TLS is a
        // deployment decision that has not been made; when it is, it belongs
        // here and nowhere else.
        client = new SolverServiceClient(solverAddress(), credentials.createInsecure());
    }

    return client;
}

/**
 * The gRPC status code carried by a solver failure, wrapped or raw.
 *
 * One extractor for both layers. `classifyPollFailure()` reads a WRAPPED error
 * (it runs in a `catch` around `getStatus`), `call()` reads a RAW one, and a
 * second copy of `?.cause?.code` in the other spelling is how the two drift
 * apart. `undefined` means the failure carried no code at all — a dead channel,
 * a DNS failure — which every caller must treat as transport.
 */
export function grpcCode(error: unknown): number | undefined {
    const e = error as { code?: number; cause?: { code?: number } } | null | undefined;

    return typeof e?.code === 'number' ? e.code : e?.cause?.code;
}

/** UNAVAILABLE. The channel never delivered the request. */
const GRPC_UNAVAILABLE = 14;
/** DEADLINE_EXCEEDED. We gave up before the solver answered. */
const GRPC_DEADLINE_EXCEEDED = 4;

/**
 * True when the failure is the TRANSPORT, not the solver.
 *
 * Deliberately a small allowlist plus the no-code case, erring toward
 * "transport" exactly as `classifyPollFailure()` errs toward `unreachable`:
 * being wrong that way produces a retry, while being wrong the other way tells
 * an operator to go and check a network that was never broken.
 */
export function isTransportFailure(error: unknown): boolean {
    const code = grpcCode(error);

    return code === undefined
        || code === GRPC_UNAVAILABLE
        || code === GRPC_DEADLINE_EXCEEDED;
}

/**
 * The solver could not be reached. The call never got an answer.
 *
 * Only for genuine transport failures — see `isTransportFailure`. A solver that
 * ANSWERS, even to reject the request, is reachable, and saying otherwise sends
 * whoever reads it to inspect ports and containers instead of the thing the
 * solver actually told them.
 */
export class SolverUnavailableError extends Error {
    constructor(override readonly cause: unknown) {
        super(`Solver unreachable at ${solverAddress()}: ${(cause as Error)?.message ?? String(cause)}`);
        this.name = 'SolverUnavailableError';
    }
}

/**
 * The solver answered and refused the request.
 *
 * WHY THIS EXISTS. Every gRPC error used to become `SolverUnavailableError`,
 * despite that class documenting the very distinction it was erasing. A real
 * INVALID_ARGUMENT — *"session '…-session-3-1' sits at week 0 day 1 block 4,
 * which is not a slot in this tenant's grid"*, precise enough to fix the data
 * from — reached the operator as "Could not reach the solver service", and cost
 * a troubleshooting session spent on container networking that was fine
 * throughout.
 *
 * The solver's own message is preserved verbatim: it is the most useful thing
 * in the failure, and this app cannot improve on it.
 */
export class SolverRejectedError extends Error {
    readonly code: number | undefined;

    constructor(override readonly cause: unknown) {
        super((cause as Error)?.message ?? String(cause));
        this.name = 'SolverRejectedError';
        this.code = grpcCode(cause);
    }
}

function call<TReq, TRes>(
    method: (request: TReq, callback: (error: unknown, response: TRes) => void) => unknown,
    request: TReq,
    target: SolverServiceClient,
): Promise<TRes> {
    return new Promise((resolve, reject) => {
        method.call(target, request, (error: unknown, response: TRes) => {
            if (error) {
                // Both set `cause` to the raw gRPC error, which is what keeps
                // `classifyPollFailure()` working: it needs the NOT_FOUND code
                // to survive, and NOT_FOUND is a solver answer, so it now
                // arrives wrapped as a rejection rather than as unavailability.
                reject(isTransportFailure(error)
                    ? new SolverUnavailableError(error)
                    : new SolverRejectedError(error));

                return;
            }

            resolve(response);
        });
    });
}

export function startRun(request: StartRunRequest): Promise<StartRunResponse> {
    const target = getSolverClient();

    return call(target.startRun, request, target);
}

export function getStatus(runId: string, includeResult = false): Promise<GetStatusResponse> {
    const target = getSolverClient();

    return call(target.getStatus, { runId, includeResult }, target);
}

export function cancelRun(runId: string): Promise<CancelRunResponse> {
    const target = getSolverClient();

    return call(target.cancelRun, { runId }, target);
}

/**
 * Wire status → the app's own enum.
 *
 * A one-to-one mapping except for UNSPECIFIED, which is treated as QUEUED: the
 * proto's zero value means "not set", and the honest local reading of a run the
 * solver has acknowledged but not classified is that it is waiting. It is
 * deliberately not mapped to FAILED — an unset field is not evidence of failure.
 */
export function toRunStatus(status: RunStatus): SolverRunStatus {
    switch (status) {
        case RunStatus.RUN_STATUS_QUEUED:
        case RunStatus.RUN_STATUS_UNSPECIFIED:
            return 'QUEUED';
        case RunStatus.RUN_STATUS_RUNNING:
            return 'RUNNING';
        case RunStatus.RUN_STATUS_SUCCEEDED:
            return 'SUCCEEDED';
        case RunStatus.RUN_STATUS_CANCELLED:
            return 'CANCELLED';
        case RunStatus.RUN_STATUS_FAILED:
            return 'FAILED';
        default:
            return 'QUEUED';
    }
}

export const TERMINAL_RUN_STATUSES: SolverRunStatus[] = ['SUCCEEDED', 'CANCELLED', 'FAILED'];

/** The statuses the one-active-run-per-term index treats as occupying a term. */
export const ACTIVE_RUN_STATUSES: SolverRunStatus[] = ['PENDING', 'QUEUED', 'RUNNING'];

export function isTerminal(status: SolverRunStatus): boolean {
    return TERMINAL_RUN_STATUSES.includes(status);
}

/**
 * ts-proto emits every `uint64` as a STRING, not a bigint — seed, the budget
 * fields, moves_evaluated and elapsed_millis are all `string` on the wire types.
 * Postgres stores them as BIGINT. These two helpers are the only place that
 * conversion happens, so nothing has to remember which side it is on.
 *
 * (The Stage 1 smoke test passed a bigint literal and worked anyway, because
 * protobufjs coerces it. It typechecked only because scripts/ is outside the
 * app's typecheck — a reminder that "it ran" is not "it is typed".)
 */
export function toWireU64(value: bigint | number): string {
    return value.toString();
}

export function fromWireU64(value: string): bigint {
    return BigInt(value || '0');
}

/**
 * BigInt does not survive JSON.stringify — the same trap `session_event.seq`
 * already hit. Converted at the route boundary, in one place.
 */
export function serializeRun<T extends Record<string, unknown>>(run: T): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(run).map(([key, value]) => [key, typeof value === 'bigint' ? value.toString() : value]),
    );
}
