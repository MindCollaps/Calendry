-- ---------------------------------------------------------------------------
-- constraint_violation: allow violations that are not about a single Session.
-- ---------------------------------------------------------------------------
--
-- WHY
--
-- Warn-and-allow says a SUCCEEDED solver run carrying residual hard violations
-- is still an applicable Generation, with the violations surfaced through this
-- table. The case that decision explicitly cited — ExactFrequency, "this
-- Offering needs 6 Sessions and only 4 were placed" — has NO session to point
-- at. Observed verbatim from the solver in Stage 1:
--
--     ExactFrequency  sessions=[]  offerings=[offering-algorithms]
--                     — requires 60 session(s), 40 placed
--
-- With session_id NOT NULL that violation simply could not be recorded, so the
-- schema quietly contradicted the decision.
--
-- TWO CHANGES, AND WHY THE SECOND IS NOT OPTIONAL
--
-- 1. session_id becomes nullable.
-- 2. offering_id is added. Without it "constraint X is violated, no session"
--    is unactionable — the whole content of an ExactFrequency breach is WHICH
--    offering is short.
--
-- THE UNIQUE INDEX NEEDS `NULLS NOT DISTINCT`
--
-- Postgres treats NULLs as distinct in a unique index by default, so
-- (constraint, NULL, offering) would not conflict with itself and every refresh
-- would append another identical row. Postgres 15+ supports NULLS NOT DISTINCT,
-- and this database is 18 — so the upsert key keeps working for both shapes.

SET search_path = public;

ALTER TABLE "constraint_violation"
    ALTER COLUMN "session_id" DROP NOT NULL,
    ADD COLUMN "offering_id" TEXT;

ALTER TABLE "constraint_violation"
    ADD CONSTRAINT "constraint_violation_offering_id_fkey"
    FOREIGN KEY ("offering_id") REFERENCES "offering"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DROP INDEX "constraint_violation_constraint_id_session_id_key";

CREATE UNIQUE INDEX "constraint_violation_constraint_id_session_id_offering_id_key"
    ON "constraint_violation" ("constraint_id", "session_id", "offering_id")
    NULLS NOT DISTINCT;

CREATE INDEX "constraint_violation_offering_id_idx" ON "constraint_violation" ("offering_id");

-- A violation must be about SOMETHING. Both null would be a row that says a
-- constraint is broken and refuses to say where.
ALTER TABLE "constraint_violation"
    ADD CONSTRAINT "constraint_violation_has_subject"
    CHECK ("session_id" IS NOT NULL OR "offering_id" IS NOT NULL);
