SET search_path = public;

-- ---------------------------------------------------------------------------
-- Recovering a SUCCEEDED run whose result was never captured
-- ---------------------------------------------------------------------------
--
-- THE BUG. `pollSolverRun()` records a terminal status even when the follow-up
-- `GetStatus(include_result=true)` throws — deliberately, because losing the
-- transition would be worse: the run would look active against a solver that had
-- already finished it, and the one-active-run index would block that term.
--
-- But nothing ever retried the missed capture. The background poller claims only
-- PENDING/QUEUED/RUNNING, and `GET /api/solver/runs/:id` short-circuits on
-- `isTerminal`, so a terminal row with no result was never looked at again. It
-- had no result, therefore no Generation, and no way to ever get one — while
-- `status = 'SUCCEEDED'` said the work had been done.
--
-- Measured in the dev database when this was written: 4 such rows.
--
-- WHAT IS AND IS NOT A TARGET. Only SUCCEEDED promises a result. A CANCELLED run
-- was stopped before producing one and a FAILED run never produced one — both
-- correctly have `result IS NULL` and must never be chased. The same database
-- held 4 CANCELLED and 1 FAILED row in exactly that shape, working as designed.
-- The predicate is therefore written narrowly and names the status explicitly
-- rather than reaching for "terminal".
--
-- WHY NOT A NEW STATUS. `SUCCEEDED` is TRUE: the solver did succeed, and this row
-- is the only record that it did. What failed is this app's capture, which is a
-- different axis. Overwriting the status would destroy the fact and make "did
-- this run succeed?" unanswerable, so the capture outcome gets its own columns.
-- "Result lost" is `status = 'SUCCEEDED' AND result_lost_at IS NOT NULL`.
--
-- NOTE ON THE ONE-ACTIVE-RUN INDEX: nothing here touches it. It is partial on
-- status IN ('PENDING','QUEUED','RUNNING'), so a SUCCEEDED run — with a result,
-- without one, recovered or lost — is already outside it and already frees its
-- term. Keeping `status` unchanged is what preserves that.

ALTER TABLE "solver_run"
    -- How many times the result has been asked for again. Bounded: the solver's
    -- run registry is in-memory with no persistence, so once it restarts the
    -- result is genuinely gone and retrying forever would be a lie told slowly.
    ADD COLUMN "result_recovery_attempts" INTEGER NOT NULL DEFAULT 0,
    -- Set when recovery gives up. Distinct from a FAILED run, and permanent.
    ADD COLUMN "result_lost_at" TIMESTAMPTZ(3);

COMMENT ON COLUMN "solver_run"."result_recovery_attempts" IS
    'Attempts made to re-fetch a SUCCEEDED run''s missing result. Bounded at 5.';
COMMENT ON COLUMN "solver_run"."result_lost_at" IS
    'Set when a SUCCEEDED run''s result could not be recovered. The run still '
    'succeeded — only the capture failed.';

-- Finding the rows quickly without scanning every finished run.
CREATE INDEX "solver_run_result_recovery_idx"
    ON "solver_run" ("next_poll_at")
    WHERE "status" = 'SUCCEEDED'
      AND "result" IS NULL
      AND "result_lost_at" IS NULL;

-- ---------------------------------------------------------------------------
-- Widening the poller's tenant discovery
-- ---------------------------------------------------------------------------
--
-- This is the third RLS-bypassing path in the system (CLAUDE.md documents the
-- other two as the auth plane and this function itself). The widening does not
-- change what makes it acceptable: it still takes NO parameters, so it cannot be
-- steered at a chosen tenant, and it still returns TENANT IDS ONLY — no run
-- rows, no scopes, no inputs, no results. Everything the poller then does
-- happens inside an ordinary withTenant() transaction under RLS.
--
-- It has to move at all because widening only the claim would achieve nothing:
-- the poller never asks about a tenant this function does not name, so a tenant
-- whose only outstanding work is a recovery would never be visited.

CREATE OR REPLACE FUNCTION calendry_internal.tenants_with_due_solver_runs()
    RETURNS TABLE(tenant_id text)
    LANGUAGE sql
    STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
AS $$
    SELECT DISTINCT sr.tenant_id
    FROM solver_run sr
    WHERE (
        -- A run still in flight.
        sr.status IN ('PENDING', 'QUEUED', 'RUNNING')
        AND (sr.next_poll_at IS NULL OR sr.next_poll_at <= now())
    ) OR (
        -- A finished run whose result never arrived.
        sr.status = 'SUCCEEDED'
        AND sr.result IS NULL
        AND sr.result_lost_at IS NULL
        AND sr.external_run_id IS NOT NULL
        AND sr.result_recovery_attempts < 5
        AND (sr.next_poll_at IS NULL OR sr.next_poll_at <= now())
    )
$$;
