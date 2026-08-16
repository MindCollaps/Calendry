-- ---------------------------------------------------------------------------
-- solver_run: polling schedule and captured result.
-- ---------------------------------------------------------------------------
--
-- next_poll_at makes the CADENCE DATA rather than code. It survives a restart,
-- it is queryable when a run looks stuck, and it turns the poller into a
-- "find runs due now" query instead of per-run timers held in memory.
--
-- result captures the solver's SolverOutput the moment a run reaches a terminal
-- state. This is not premature: the solver's run registry is an in-memory map
-- with NO persistence and NO eviction, so a restart loses every result it still
-- holds. If the app waits until someone asks to apply a Generation (Stage 5),
-- the answer may simply be gone. Capturing here makes Stage 5 a pure
-- database→database transform with no solver dependency and no time pressure on
-- human review.

SET search_path = public;

ALTER TABLE "solver_run"
    ADD COLUMN "next_poll_at" TIMESTAMPTZ(3),
    ADD COLUMN "result"       JSONB;

-- The poller's only hot query: active runs whose next poll is due. Partial, so
-- the index stays the size of the in-flight set rather than of all history.
CREATE INDEX "solver_run_due_idx"
    ON "solver_run" ("next_poll_at")
    WHERE "status" IN ('PENDING', 'QUEUED', 'RUNNING');
