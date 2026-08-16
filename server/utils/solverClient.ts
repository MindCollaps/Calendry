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

export function solverAddress(): string {
    return process.env.CALENDRY_SOLVER_ADDR ?? '127.0.0.1:50051';
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
 * Every solver call is wrapped so a transport failure is distinguishable from a
 * solver-reported error.
 *
 * That distinction matters: "the solver said this run FAILED" is a normal
 * outcome to record, whereas "the solver is unreachable" means the run never
 * started and the row must not be left claiming otherwise.
 */
export class SolverUnavailableError extends Error {
    constructor(override readonly cause: unknown) {
        super(`Solver unreachable at ${solverAddress()}: ${(cause as Error)?.message ?? String(cause)}`);
        this.name = 'SolverUnavailableError';
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
                reject(new SolverUnavailableError(error));

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
