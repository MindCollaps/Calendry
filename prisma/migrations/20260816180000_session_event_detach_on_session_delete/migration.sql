SET search_path = public;

-- ---------------------------------------------------------------------------
-- Letting a Session be deleted without letting its history be rewritten
-- ---------------------------------------------------------------------------
--
-- Two deliberate designs contradicted each other, and the contradiction made
-- deleting a Session impossible:
--
--   * `session_event.session_id` is ON DELETE SET NULL, chosen so that audit
--     rows OUTLIVE the Session they describe (TAXONOMY.md §3 rollback depends
--     on the log being complete).
--   * `session_event_append_only` denied `UPDATE OR DELETE` outright — and the
--     FK's SET NULL *is* an UPDATE.
--
-- So the FK action the schema depends on was rejected by the trigger guarding
-- the same table. Deleting a Session that had ever been created, moved, swapped
-- or locked failed with:
--
--     ERROR: session_event is append-only; UPDATE is not permitted
--     CONTEXT: SQL statement "UPDATE ONLY public.session_event
--                             SET session_id = NULL WHERE ..."
--
-- It went unnoticed because until Stage 5 NOTHING in the codebase ever deleted
-- a Session row — there is no DELETE /api/sessions/:id, and the only deletion
-- is `materializeGeneration()` removing placements the solver declined to make.
--
-- WHAT IS PERMITTED NOW, EXACTLY
--
-- One shape and no other: an UPDATE that only sets `session_id` and/or
-- `counterpart_session_id` from a value to NULL, leaving every other column
-- byte-identical. That is precisely what the FK emits. Everything else — a
-- changed `type`, `payload`, `seq`, `created_at`, an actor rewrite, or
-- REPOINTING either column at a DIFFERENT Session rather than detaching it —
-- still raises, and DELETE is still refused unconditionally.
--
-- The event's CONTENT therefore remains immutable, which is the property §3
-- actually needs. What loosens is only the pointer to a row that no longer
-- exists.
--
-- The alternatives were considered and rejected: ON DELETE CASCADE destroys the
-- audit trail the log exists for, and RESTRICT would forbid deleting a
-- solver-rejected Session at all, contradicting the Stage 5 decision that an
-- Offering's unplaceable Sessions are removed rather than left at placements
-- the solver refused.
--
-- `generation_no_delete` shares this function but is a BEFORE DELETE trigger,
-- so it never reaches the UPDATE branch and is unaffected.

CREATE OR REPLACE FUNCTION calendry_internal.deny_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    -- OLD with exactly the two FK columns NEW claims, and nothing else changed.
    -- If NEW still differs from this, some other column was touched.
    detached public.session_event;
BEGIN
    IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'session_event' THEN
        detached := OLD;
        detached.session_id := NEW.session_id;
        detached.counterpart_session_id := NEW.counterpart_session_id;

        IF NEW IS NOT DISTINCT FROM detached
           -- Neither column may be REPOINTED; only cleared.
           AND (NEW.session_id IS NULL OR NEW.session_id = OLD.session_id)
           AND (NEW.counterpart_session_id IS NULL
                OR NEW.counterpart_session_id = OLD.counterpart_session_id)
           -- And at least one of them must actually be a detach, so a no-op
           -- UPDATE is still refused rather than quietly accepted.
           AND ((OLD.session_id IS NOT NULL AND NEW.session_id IS NULL)
                OR (OLD.counterpart_session_id IS NOT NULL
                    AND NEW.counterpart_session_id IS NULL))
        THEN
            RETURN NEW;
        END IF;
    END IF;

    RAISE EXCEPTION
        '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'restrict_violation';
END $$;
