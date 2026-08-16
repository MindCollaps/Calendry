-- ---------------------------------------------------------------------------
-- solver_run — the app's record of one request to calendry-solver.
-- ---------------------------------------------------------------------------
--
-- HAND-WRITTEN. Prisma can generate the table, but not the RLS policy and not
-- the partial unique index that enforces the concurrency rule. A regenerated
-- "equivalent" migration would emit a table with neither, producing a database
-- where the solver surface exists, tenant isolation is silently absent, and two
-- concurrent runs per term are permitted — with every test still passing.
-- Do not regenerate.

SET search_path = public;

-- ---------------------------------------------------------------------------
-- 1. Type and table
-- ---------------------------------------------------------------------------

-- Mirrors calendry.solver.v1.RunStatus plus PENDING, the window between writing
-- the row and StartRun being acknowledged. Deliberately NO
-- "succeeded_with_violations": RunStatus describes the run's lifecycle, not the
-- solution's quality (TAXONOMY.md §3 warn-and-allow, and the proto's own
-- comment). Residual violations belong to the result, not to this column.
CREATE TYPE "solver_run_status" AS ENUM (
    'PENDING', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'CANCELLED', 'FAILED'
);

CREATE TABLE "solver_run" (
    "id"                 TEXT NOT NULL,
    "tenant_id"          TEXT NOT NULL,
    "term_id"            TEXT NOT NULL,

    "external_run_id"    TEXT,
    "status"             "solver_run_status" NOT NULL DEFAULT 'PENDING',
    "scope"              JSONB NOT NULL DEFAULT '{}',

    -- Reproducibility inputs. seed is what the solver reported USING.
    "seed"               BIGINT,
    "max_wall_millis"    INTEGER,
    "max_moves"          BIGINT,

    -- Last GetStatus snapshot; overwritten per poll.
    "progress"           DOUBLE PRECISION NOT NULL DEFAULT 0,
    "best_objective"     DOUBLE PRECISION,
    "moves_evaluated"    BIGINT,
    "elapsed_millis"     INTEGER,
    "termination_reason" TEXT,

    "error_detail"       TEXT,

    -- Stage 5 fills this. Nullable and unused until then.
    "generation_id"      TEXT,

    "meta"               JSONB NOT NULL DEFAULT '{}',

    "requested_by_id"    TEXT,
    "created_at"         TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at"         TIMESTAMPTZ(3),
    "finished_at"        TIMESTAMPTZ(3),
    "last_polled_at"     TIMESTAMPTZ(3),

    CONSTRAINT "solver_run_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "solver_run"
    ADD CONSTRAINT "solver_run_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "solver_run"
    ADD CONSTRAINT "solver_run_term_id_fkey"
    FOREIGN KEY ("term_id") REFERENCES "term"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "solver_run"
    ADD CONSTRAINT "solver_run_generation_id_fkey"
    FOREIGN KEY ("generation_id") REFERENCES "generation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "solver_run"
    ADD CONSTRAINT "solver_run_requested_by_id_fkey"
    FOREIGN KEY ("requested_by_id") REFERENCES "person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "solver_run_tenant_id_idx"         ON "solver_run" ("tenant_id");
CREATE INDEX "solver_run_tenant_id_term_id_idx" ON "solver_run" ("tenant_id", "term_id");
CREATE INDEX "solver_run_generation_id_idx"     ON "solver_run" ("generation_id");

-- ---------------------------------------------------------------------------
-- 2. THE CONCURRENCY RULE: one active run per term per tenant
-- ---------------------------------------------------------------------------
--
-- An index rather than an application check, because the alternative is a
-- TOCTOU race: two simultaneous requests both run `findFirst`, both see no
-- active run, and both insert. Here the second INSERT fails with 23505 and the
-- route turns that into a 409 naming the run already in flight.
--
-- PENDING is included on purpose. The row is written BEFORE StartRun is called,
-- precisely so this index can reject a concurrent second attempt during the
-- call — leaving PENDING out would reopen the window it exists to close.
--
-- The corollary the API must honour: a StartRun that fails at the transport
-- level has to resolve its PENDING row to FAILED, or a solver outage would
-- block that term until someone edited the database by hand.
CREATE UNIQUE INDEX "solver_run_one_active_per_term"
    ON "solver_run" ("tenant_id", "term_id")
    WHERE "status" IN ('PENDING', 'QUEUED', 'RUNNING');

-- ---------------------------------------------------------------------------
-- 3. Tenant isolation
-- ---------------------------------------------------------------------------
--
-- Same policy shape as every other tenant-scoped table. Written out rather than
-- added to the array in 20260812000100 because that migration is already
-- applied — this table did not exist when that loop ran.
ALTER TABLE "solver_run" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "solver_run" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "solver_run"
    USING (tenant_id = calendry_internal.current_tenant_id())
    WITH CHECK (tenant_id = calendry_internal.current_tenant_id());

-- The blanket GRANT in 20260812000100 applied to tables existing at that time.
GRANT SELECT, INSERT, UPDATE, DELETE ON "solver_run" TO calendry_app;
