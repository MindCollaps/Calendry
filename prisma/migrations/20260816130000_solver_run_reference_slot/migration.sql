-- ---------------------------------------------------------------------------
-- solver_run: record what the run was actually asked, not just what it answered.
-- ---------------------------------------------------------------------------
--
-- reference_slot is derived from "now", so it is the one input that cannot be
-- reconstructed later. Without storing it, "same input, same seed, same move
-- budget produces byte-identical output" becomes quietly false on any replay:
-- the snapshot would be rebuilt against a different present.
--
-- input_hash is a SHA-256 over the serialized SolverInput. It does not make a
-- run replayable on its own — it makes the QUESTION answerable. "Did this run
-- see the same problem as that one?" is otherwise a guess, and two runs that
-- differ for an unnoticed data reason look exactly like solver nondeterminism.

SET search_path = public;

ALTER TABLE "solver_run"
    ADD COLUMN "reference_slot" JSONB,
    ADD COLUMN "input_hash"     TEXT;

-- Cheap way to spot runs solving an identical problem (a re-run after no data
-- change), which is what makes a determinism comparison meaningful.
CREATE INDEX "solver_run_input_hash_idx" ON "solver_run" ("tenant_id", "input_hash");
