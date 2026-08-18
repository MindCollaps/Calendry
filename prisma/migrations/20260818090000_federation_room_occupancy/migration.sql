SET search_path = public;

-- ---------------------------------------------------------------------------
-- Occupancy of Federation-shared Rooms by OTHER tenants
-- ---------------------------------------------------------------------------
--
-- Stage 3 deliberately excluded federation-owned Rooms from SolverInput because
-- this was unresolved: a member tenant can SEE a shared lecture hall (the RLS
-- read policy widens to the federation) but cannot see the other tenant's
-- Sessions occupying it, because those Sessions are tenant-owned and invisible.
-- Sending the room without its occupancy would be worse than omitting it — the
-- solver would place into hours already taken.
--
-- WHY A FUNCTION AND NOT A LEDGER TABLE
--
-- Occupancy is DERIVABLE from session rows. A ledger duplicates it, and every
-- write path would have to maintain it: move, swap, lock, apply-generation,
-- materializeGeneration's create/move/delete partition, and orphan deletion —
-- six call sites today and more later. This repo already has the evidence for
-- how that ends: `session_event`'s ON DELETE SET NULL was broken for months
-- purely because nothing had ever deleted a Session, so an unexercised path
-- stayed wrong invisibly. A ledger's drift would be exactly that shape, and its
-- symptom would be a subtly wrong solver answer.
--
-- The read happens ONCE per solver-run assembly, not per request, so
-- precomputation buys almost nothing.
--
-- WHY THIS IS AN ACCEPTABLE FOURTH RLS BYPASS
--
-- CLAUDE.md's rule is "not without a comparably strong reason". This keeps every
-- property that made the third one acceptable:
--
--   * NO PARAMETERS. The federation comes from the caller's own session context
--     via current_federation_id(), so it cannot be steered at another
--     federation — the same reasoning that made tenants_with_due_solver_runs()
--     safe.
--   * OCCUPANCY ONLY. No session ids, no tenant ids, no titles, no offering or
--     person references. A member tenant learns WHEN a shared hall is busy,
--     which is exactly what it needs to schedule against it, and nothing about
--     whose event it is.
--   * The caller's own rows are excluded, because those arrive through ordinary
--     RLS already and would otherwise be counted twice.

-- WHY AN ABSOLUTE DATE AND NOT (term_week, day)
--
-- `term_week` is relative to each tenant's OWN term start, and terms are
-- tenant-scoped rows — so tenant A's "week 3" is not tenant B's "week 3", and
-- A's term id never matches B's. Term-relative coordinates are not a shared
-- frame across a Federation. The one frame both tenants agree on is the
-- calendar, so occupancy crosses the boundary as a DATE and each tenant maps it
-- into its own week numbering on arrival.

-- DROP first: `prisma migrate reset` drops only the `public` schema and leaves
-- `calendry_internal` standing, so on a replay this function still exists and a
-- bare CREATE fails with 42723. CREATE OR REPLACE would not help either, since
-- the return type changed during development and that cannot be replaced in
-- place.
DROP FUNCTION IF EXISTS calendry_internal.federation_room_occupancy();

CREATE FUNCTION calendry_internal.federation_room_occupancy()
    RETURNS TABLE(
        room_id text,
        occupied_on date,
        block_index integer,
        duration_blocks integer
    )
    LANGUAGE sql
    STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
AS $$
    SELECT sr.room_id,
           -- Monday of the session's term, plus its week and weekday offsets.
           -- date_trunc('week', ...) is ISO Monday, matching mondayOf() in
           -- solverCalendar.ts, so both sides anchor identically.
           (date_trunc('week', t.start_date::timestamp)::date
                + ((s.term_week - 1) * 7 + (s.day_of_week - 1)) * interval '1 day')::date,
           s.block_index,
           s.duration_blocks
      FROM session s
      JOIN session_room sr ON sr.session_id = s.id
      JOIN room r ON r.id = sr.room_id
      JOIN term t ON t.id = s.term_id
     WHERE r.federation_id IS NOT NULL
       AND r.federation_id = calendry_internal.current_federation_id()
       -- Not the caller's own occupancy: those Sessions are already visible
       -- through normal RLS and are sent as `existingSessions`.
       AND s.tenant_id IS DISTINCT FROM calendry_internal.current_tenant_id()
$$;

COMMENT ON FUNCTION calendry_internal.federation_room_occupancy() IS
    'Occupancy of Federation-shared Rooms by other tenants. Parameterless and '
    'occupancy-only by design: see the migration for why this is an acceptable '
    'RLS bypass.';
