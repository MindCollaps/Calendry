-- ---------------------------------------------------------------------------
-- The THIRD (and only the third) RLS-bypassing function in the system.
-- ---------------------------------------------------------------------------
--
-- WHY ANOTHER ONE EXISTS AT ALL
--
-- The background solver poller runs when nobody is logged in. There is no
-- tenant context, so `calendry_internal.current_tenant_id()` is NULL and the
-- app role sees ZERO rows in both `solver_run` and `tenant` — the fail-closed
-- design working exactly as intended. A job that must advance runs across every
-- tenant therefore cannot see the work it exists to do.
--
-- That is structurally the same class of exception as the two existing
-- functions, not a convenience: `session_identity()` and `account_identities()`
-- exist because a session must be read BEFORE the tenant is known, and this one
-- exists because a background job acts when no tenant is known at all. Both sit
-- outside the tenant-request model by nature.
--
-- WHAT KEEPS THE SURFACE SMALL
--
--   * It returns TENANT IDS ONLY. No run rows, no scopes, no results, no
--     inputs. Everything the poller then does happens inside an ordinary
--     withTenant() transaction under RLS, including the claim and every write.
--   * It takes NO PARAMETERS, so it cannot be steered at a chosen tenant or
--     coaxed into enumerating anything the caller names.
--   * It answers one narrow question — "which tenants have a solver run due
--     right now?" — and returns nothing when the answer is none.
--
-- Do not widen it to return the runs themselves. That was considered and
-- rejected: it would move the atomic claim into SQL and carry run data across
-- the boundary, for a saving of one round trip per tenant per tick.

SET search_path = public;

CREATE OR REPLACE FUNCTION calendry_internal.tenants_with_due_solver_runs()
RETURNS TABLE (tenant_id text)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $fn$
    SELECT DISTINCT sr.tenant_id
    FROM solver_run sr
    WHERE sr.status IN ('PENDING', 'QUEUED', 'RUNNING')
      AND (sr.next_poll_at IS NULL OR sr.next_poll_at <= now())
$fn$;

REVOKE ALL ON FUNCTION calendry_internal.tenants_with_due_solver_runs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION calendry_internal.tenants_with_due_solver_runs() TO calendry_app;
