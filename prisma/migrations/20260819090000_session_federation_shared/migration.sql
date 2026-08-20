SET search_path = public;

-- ---------------------------------------------------------------------------
-- Session becomes the third federation-shareable entity
-- ---------------------------------------------------------------------------
--
-- TAXONOMY.md §2 amendment: a genuinely shared event spanning member tenants (a
-- university-wide celebration when Technology and Medicine are separate tenants
-- under one Federation) is ONE event, not a coincidence of two identical events
-- each tenant tracks independently. So `session` gets the same ownership shape
-- `room`, `equipment` and `offering` already have.

ALTER TABLE "session"
    ADD COLUMN "federation_id" TEXT REFERENCES "federation"("id") ON UPDATE CASCADE ON DELETE CASCADE,
    ALTER COLUMN "tenant_id" DROP NOT NULL,
    -- Exactly one owner, enforced by the database rather than by convention —
    -- the same CHECK room/equipment/offering carry.
    ADD CONSTRAINT "session_one_owner" CHECK (num_nonnulls("tenant_id", "federation_id") = 1);

CREATE INDEX "session_federation_id_idx" ON "session" ("federation_id");

-- ---------------------------------------------------------------------------
-- RLS: readable by owner tenant OR federation, writable only by owner tenant
-- ---------------------------------------------------------------------------
--
-- WITH CHECK stays deliberately narrower than USING, matching the convention
-- established for room/offering: a member tenant may READ a shared Session but
-- may not create or edit one. Creating a federation-owned Session is a
-- privileged path, not something a member tenant does incidentally — and no such
-- path exists yet, because federation-level permissions are out of scope
-- (TAXONOMY.md §9.4). This migration makes the schema CAPABLE; it does not open
-- a route.

DROP POLICY IF EXISTS tenant_isolation ON "session";

CREATE POLICY tenant_or_federation_read ON "session" FOR SELECT
    USING (
        "tenant_id" = calendry_internal.current_tenant_id()
        OR "federation_id" = calendry_internal.current_federation_id()
    );

CREATE POLICY tenant_write ON "session" FOR ALL
    USING ("tenant_id" = calendry_internal.current_tenant_id())
    WITH CHECK ("tenant_id" = calendry_internal.current_tenant_id());

-- ---------------------------------------------------------------------------
-- session_room inherits the Session's ownership; the other two DO NOT
-- ---------------------------------------------------------------------------
--
-- THIS IS A DELIBERATE NARROWING OF THE TAXONOMY.md WORDING, and the reason is
-- worth keeping: the amendment said the relation tables should let a shared
-- Session "reference Groups/Persons from either member tenant". Implemented
-- literally that requires widening RLS on `group` and `person` — the two most
-- sensitive tenant-scoped tables in the system — so that Federation membership
-- would imply roster visibility. That is a far larger concession than sharing
-- one `session` row.
--
-- Instead: the SESSION is shared, the PARTICIPANT LINKS stay tenant-private.
-- Each tenant sees the shared event and its OWN groups and people on it, and
-- never the other tenant's. The use case — a university-wide celebration both
-- tenants attach their own cohorts to — is fully served, without either tenant
-- enumerating the other's people.
--
-- `session_room` is the one exception, because WHERE a shared event happens is
-- genuinely shared information. It follows `room_equipment`'s precedent exactly:
-- an EXISTS against the parent row's federation ownership.

DROP POLICY IF EXISTS tenant_isolation ON "session_room";

CREATE POLICY tenant_or_federation_read ON "session_room" FOR SELECT
    USING (
        "tenant_id" = calendry_internal.current_tenant_id()
        OR EXISTS (
            SELECT 1 FROM "session" s
            WHERE s."id" = "session_room"."session_id"
              AND s."federation_id" = calendry_internal.current_federation_id()
        )
    );

CREATE POLICY tenant_write ON "session_room" FOR ALL
    USING ("tenant_id" = calendry_internal.current_tenant_id())
    WITH CHECK ("tenant_id" = calendry_internal.current_tenant_id());

-- session_group and session_person are deliberately NOT touched. They keep the
-- plain `tenant_isolation` policy from 20260812000100, which is what makes the
-- narrowing above real rather than nominal.
