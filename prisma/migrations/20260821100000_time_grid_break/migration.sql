SET search_path = public;

-- ---------------------------------------------------------------------------
-- Named, non-uniform breaks on a TimeGrid
-- ---------------------------------------------------------------------------
--
-- `time_grid.break_minutes` stays exactly as it was: the DEFAULT gap between
-- consecutive blocks, and still the whole story for most grids. This table adds
-- sparse overrides — "45 minutes for lunch after block 3", "Friday's afternoon
-- break is longer" — so a real teaching day can be expressed without inventing
-- a second grid.
--
-- WHY A TABLE AND NOT A JSON COLUMN ON time_grid
--
--  1. The unique index below is the only way to make "one override per
--     (position, day)" a database guarantee. A JSON array can hold two
--     conflicting lunches at block 3 and nothing notices until the timetable
--     renders one of them arbitrarily.
--  2. `day_of_week NULL = every active day` is the same scoping shape
--     `constraint_scope` already uses, and that is a table for the same reason.
--  3. Every tenant-scoped table here carries `tenant_id` under
--     `tenant_isolation`. Tenant data inside a JSON column is data RLS cannot
--     see into, and isolation in this system is enforced at the database layer
--     rather than by application care.
--
-- NOTHING HERE REACHES THE SOLVER. The wire carries block INDICES; a gap's
-- duration changes no index, no adjacency and no conflict. `toWireTimeGrid()`
-- omits break data deliberately and has a test asserting the omission.

CREATE TABLE "time_grid_break" (
    "id"                TEXT NOT NULL,
    "tenant_id"         TEXT NOT NULL,
    "time_grid_id"      TEXT NOT NULL,

    -- The gap FOLLOWS this 0-based block index. A row naming the final block is
    -- inert by design: there is no later block for it to push, and honouring it
    -- would overstate when teaching ends.
    "after_block_index" INTEGER NOT NULL,
    "duration_minutes"  INTEGER NOT NULL,
    "label"             TEXT NOT NULL,

    -- NULL = applies on every active day, unless a day-specific row exists for
    -- the SAME after_block_index. Precedence is resolved per position, so
    -- "same lunch every day, but Friday's afternoon break differs" is one extra
    -- row rather than a duplicated day.
    "day_of_week"       INTEGER,

    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "time_grid_break_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "time_grid_break" ADD CONSTRAINT "time_grid_break_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "time_grid_break" ADD CONSTRAINT "time_grid_break_time_grid_id_fkey"
    FOREIGN KEY ("time_grid_id") REFERENCES "time_grid"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A positive gap only. Zero is spelled by having no row at all, and a negative
-- one would walk blocks backwards.
ALTER TABLE "time_grid_break" ADD CONSTRAINT "time_grid_break_duration_positive"
    CHECK ("duration_minutes" > 0);

-- ISO-8601 weekday, or NULL for universal. Not a free integer: `day_of_week = 0`
-- would silently never match a Session, since sessions use 1..7.
ALTER TABLE "time_grid_break" ADD CONSTRAINT "time_grid_break_day_of_week_iso"
    CHECK ("day_of_week" IS NULL OR ("day_of_week" BETWEEN 1 AND 7));

ALTER TABLE "time_grid_break" ADD CONSTRAINT "time_grid_break_after_block_index_nonneg"
    CHECK ("after_block_index" >= 0);

-- One override per position per day. NULLS NOT DISTINCT so the universal row is
-- itself unique — without it, a grid could hold two "every day" lunches at
-- block 3 and the resolver would pick whichever the planner returned first.
CREATE UNIQUE INDEX "time_grid_break_position_day_key"
    ON "time_grid_break" ("time_grid_id", "after_block_index", "day_of_week") NULLS NOT DISTINCT;

CREATE INDEX "time_grid_break_tenant_id_idx" ON "time_grid_break" ("tenant_id");
CREATE INDEX "time_grid_break_time_grid_id_idx" ON "time_grid_break" ("time_grid_id");

-- Ordinary tenant-scoped isolation, identical to every other tenant table.
ALTER TABLE "time_grid_break" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "time_grid_break" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "time_grid_break"
    USING (tenant_id = calendry_internal.current_tenant_id())
    WITH CHECK (tenant_id = calendry_internal.current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "time_grid_break" TO calendry_app;
