import { describe, expect, it } from 'vitest';
import {
    SolverRejectedError,
    SolverUnavailableError,
    grpcCode,
    isTransportFailure,
} from '../server/utils/solverClient';
import { classifyPollFailure } from '../server/utils/solverPolling';

/**
 * A solver that ANSWERS is reachable, even when the answer is a refusal.
 *
 * WHY THIS EXISTS. `call()` wrapped every gRPC failure in
 * `SolverUnavailableError` — including `INVALID_ARGUMENT`, which is the solver
 * replying. The class documented the very distinction it was erasing ("the
 * solver said this run FAILED is a normal outcome, whereas the solver is
 * unreachable means the run never started"), and the implementation made none.
 *
 * The cost was measured, not hypothetical. A run failed with:
 *
 *     Solver unreachable at solver:50051: 3 INVALID_ARGUMENT: session
 *     '…-session-3-1' sits at week 0 day 1 block 4, which is not a slot in
 *     this tenant's grid
 *
 * — a message precise enough to fix the data from, delivered under a headline
 * that sent a whole troubleshooting session to inspect container networking
 * that was healthy throughout.
 *
 * The assertions below are paired on purpose. Testing only that
 * INVALID_ARGUMENT passes through would also pass against a build that stopped
 * classifying anything at all and reported a genuine outage as a data problem —
 * which is the same defect pointing the other way, and just as misleading.
 */

/** Shaped like a real @grpc/grpc-js ServiceError: numeric `code`, plus details. */
function grpcError(code: number, message: string) {
    return Object.assign(new Error(`${code} ${message}`), { code, details: message });
}

const UNAVAILABLE = 14;
const DEADLINE_EXCEEDED = 4;
const INVALID_ARGUMENT = 3;
const NOT_FOUND = 5;
const INTERNAL = 13;

describe('grpcCode', () => {
    it('reads the code from a raw error and from a wrapped one', () => {
        // The single extractor both layers share. `call()` sees raw errors;
        // `classifyPollFailure()` sees wrapped ones. A second copy in the other
        // spelling is exactly how they would drift.
        const raw = grpcError(NOT_FOUND, 'no such run');

        expect(grpcCode(raw)).toBe(NOT_FOUND);
        expect(grpcCode(new SolverRejectedError(raw))).toBe(NOT_FOUND);
        expect(grpcCode(new SolverUnavailableError(raw))).toBe(NOT_FOUND);
    });

    it('returns undefined when the failure carries no code at all', () => {
        // A dead channel or a DNS failure. Callers must read this as transport.
        expect(grpcCode(new Error('socket hang up'))).toBeUndefined();
        expect(grpcCode(null)).toBeUndefined();
        expect(grpcCode(undefined)).toBeUndefined();
    });
});

describe('SolverRejectedError', () => {
    it('preserves the solver\'s message verbatim', () => {
        // The real message from the failure this fix came from. It is the most
        // useful thing in the error and this app cannot improve on it.
        const detail = "session '…-session-3-1' sits at week 0 day 1 block 4, "
            + "which is not a slot in this tenant's grid";
        const rejected = new SolverRejectedError(grpcError(INVALID_ARGUMENT, detail));

        expect(rejected.message).toContain(detail);
        expect(rejected.code).toBe(INVALID_ARGUMENT);

        // And specifically NOT relabelled. This is the regression: the old
        // behaviour prefixed "Solver unreachable at …" onto exactly this text.
        expect(rejected.message).not.toContain('unreachable');
        expect(rejected).not.toBeInstanceOf(SolverUnavailableError);
    });

    it('is what an INVALID_ARGUMENT becomes, while a real outage stays unavailable', () => {
        // The discrimination, asserted against the PRODUCTION predicate — the
        // one `call()` actually branches on. Re-implementing the rule here
        // would test this file against itself and pass against any build.
        const classify = (error: unknown) => (isTransportFailure(error) ? 'unavailable' : 'rejected');

        expect(classify(grpcError(INVALID_ARGUMENT, 'not a slot in this grid'))).toBe('rejected');
        expect(classify(grpcError(NOT_FOUND, 'no such run'))).toBe('rejected');
        expect(classify(grpcError(INTERNAL, 'solver panicked'))).toBe('rejected');

        expect(classify(grpcError(UNAVAILABLE, 'no connection established'))).toBe('unavailable');
        expect(classify(grpcError(DEADLINE_EXCEEDED, 'deadline exceeded'))).toBe('unavailable');
        expect(classify(new Error('socket hang up'))).toBe('unavailable');
    });
});

describe('classifyPollFailure still sees through the new wrapper', () => {
    /**
     * The second-order risk in this change, pinned.
     *
     * NOT_FOUND is a solver ANSWER, so it now arrives as `SolverRejectedError`
     * rather than `SolverUnavailableError`. `classifyPollFailure()` reads the
     * code to decide `forgotten` vs `unreachable`, and `forgotten` is
     * load-bearing: it marks a run FAILED, frees the one-active-run index, and
     * short-circuits the result-recovery budget. Had the reclassification
     * broken that read, every forgotten run would silently become "transient"
     * and retry forever against a solver that has no idea what it is.
     */
    it('still calls a NOT_FOUND forgotten, wrapped either way', () => {
        const notFound = grpcError(NOT_FOUND, 'run 123 is not in the registry');

        expect(classifyPollFailure(new SolverRejectedError(notFound))).toBe('forgotten');
        expect(classifyPollFailure(new SolverUnavailableError(notFound))).toBe('forgotten');
        expect(classifyPollFailure(notFound)).toBe('forgotten');
    });

    it('still errs toward unreachable for everything else', () => {
        // Erring this way costs a stale row; erring the other way destroys a
        // live run's record. Unchanged by this fix, and asserted so.
        expect(classifyPollFailure(new SolverUnavailableError(grpcError(UNAVAILABLE, 'down')))).toBe('unreachable');
        expect(classifyPollFailure(new SolverRejectedError(grpcError(INTERNAL, 'panic')))).toBe('unreachable');
        expect(classifyPollFailure(new Error('socket hang up'))).toBe('unreachable');
    });
});
