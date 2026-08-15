-- ---------------------------------------------------------------------------
-- At most one default TimeGrid per tenant.
-- ---------------------------------------------------------------------------
--
-- HAND-WRITTEN. Like 20260812000100, this cannot be produced by
-- `prisma migrate diff` — the Prisma schema language cannot express a partial
-- unique index, so a regenerated "equivalent" migration would omit it and the
-- constraint would silently disappear. Do not regenerate.
--
-- WHY THIS IS A CONSTRAINT AND NOT A UI RULE
-- ------------------------------------------
-- `time_grid.is_default` had no uniqueness of any kind, and the schedule view
-- resolves its grid with:
--
--     grids.find(g => g.id === term.timeGridId)
--       ?? grids.find(g => g.isDefault)      <-- takes the FIRST of however many
--       ?? grids[0]
--
-- With two defaults that `find` picks one arbitrarily, by whatever order the
-- API happened to return. The whole timetable would then render against a grid
-- the tenant did not choose, with nothing anywhere reporting a problem — a
-- wrong answer that looks exactly like a right one.
--
-- Step 13 adds a TimeGrid editor with an `is_default` toggle, which makes this
-- state reachable by clicking rather than only by hand-written SQL. Enforcing
-- it in the UI alone would leave the API and the import path free to create it.
--
-- FAILURE MODE IS DELIBERATE AND LOUD
-- -----------------------------------
-- If a database already holds two defaults for one tenant, this migration FAILS
-- and applies nothing, naming the duplicate. That is correct: which of the two
-- is meant is a decision only the operator can make, and silently demoting one
-- would be this file choosing a timetable on their behalf. No data is modified
-- here — that would be a seed's job, not a migration's.

SET search_path = public;

CREATE UNIQUE INDEX time_grid_one_default_per_tenant
    ON "time_grid" (tenant_id)
    WHERE is_default = true;
