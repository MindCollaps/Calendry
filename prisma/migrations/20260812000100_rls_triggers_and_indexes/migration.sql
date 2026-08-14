-- Pin the target schema before anything else: this file CREATEs the `calendry`
-- schema, which collides with the owner role name in the default search_path.
-- Without this, LANGUAGE sql function bodies (parsed at CREATE time) resolve
-- table names against the wrong schema.
SET search_path = public;

-- Calendry — database-layer invariants that Prisma's schema language cannot express.
--
-- ############################################################################
-- DO NOT REGENERATE THIS FILE. It is hand-written and CANNOT be recreated from
-- prisma/schema.prisma — the schema language cannot express RLS, triggers,
-- SECURITY DEFINER functions or partial indexes. `prisma migrate dev` will
-- happily produce an "equivalent" migration without any of it, leaving a
-- database with every table present and tenant isolation silently absent.
-- To rebuild a dev database, use `prisma migrate reset` (which REPLAYS these
-- files); never delete prisma/migrations and regenerate.
-- ############################################################################
--
-- Everything here is enforced by PostgreSQL, not by application code:
--   1. helper functions for request-scoped tenant context
--   2. the runtime app role (no ownership, DML only)
--   3. row-level security: tenant isolation + the narrow Federation exception
--   4. CHECK constraints, including exactly-one-owner on shared resources
--   5. group_closure maintenance trigger (TAXONOMY.md §6)
--   6. append-only enforcement on generation / session_event (TAXONOMY.md §3)
--   7. partial indexes on the solver's hot paths
--
-- The runtime connection MUST set tenant context per transaction:
--     SET LOCAL calendry.tenant_id = '<tenant uuid>';
--     SET LOCAL calendry.federation_id = '<federation uuid or empty>';
-- With no context set, every policy below evaluates to NULL and the session
-- sees zero rows. Failing closed is deliberate: a forgotten SET LOCAL must
-- leak nothing, not everything.

-- ---------------------------------------------------------------------------
-- 1. Tenant context helpers
-- ---------------------------------------------------------------------------

-- NOT named `calendry`: the database owner role is called `calendry`, and the
-- default search_path is ("$user", public). A schema sharing the role name
-- silently captures every unqualified CREATE — including Prisma's own
-- _prisma_migrations table, which is created before any migration SQL runs.
CREATE SCHEMA IF NOT EXISTS calendry_internal;

-- Ids are TEXT (Prisma uuid(7) maps to TEXT), so these return text, not uuid.
CREATE OR REPLACE FUNCTION calendry_internal.current_tenant_id() RETURNS text
    LANGUAGE sql STABLE
    AS $$ SELECT NULLIF(current_setting('calendry.tenant_id', true), '') $$;

CREATE OR REPLACE FUNCTION calendry_internal.current_federation_id() RETURNS text
    LANGUAGE sql STABLE
    AS $$ SELECT NULLIF(current_setting('calendry.federation_id', true), '') $$;

COMMENT ON FUNCTION calendry_internal.current_tenant_id() IS
    'Request-scoped tenant. NULL when unset, which makes every RLS policy fail closed.';

-- ---------------------------------------------------------------------------
-- 2. Runtime role
-- ---------------------------------------------------------------------------
-- Created NOLOGIN here so the migration is idempotent and password-free on any
-- database. The compose stack grants LOGIN + password via
-- .config/db-init/01-app-role.sh at cluster init.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'calendry_app') THEN
        CREATE ROLE calendry_app NOLOGIN;
    END IF;
END $$;

GRANT USAGE ON SCHEMA public, calendry_internal TO calendry_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO calendry_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO calendry_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA calendry_internal TO calendry_app;

-- The app role must never gain DDL rights, and never own a table — an owner
-- without FORCE would bypass RLS entirely.
REVOKE CREATE ON SCHEMA public FROM calendry_app;

-- History tables are append-only at the privilege level as well as by trigger.
REVOKE UPDATE, DELETE ON TABLE "session_event" FROM calendry_app;
REVOKE DELETE ON TABLE "generation" FROM calendry_app;

-- ---------------------------------------------------------------------------
-- 3. Row-level security
-- ---------------------------------------------------------------------------

-- 3a. Straightforward tenant-scoped tables: tenant_id IS NOT NULL, isolation is
--     a plain equality check. FORCE so that even the table owner obeys.
DO $$
DECLARE
    t text;
    tenant_scoped text[] := ARRAY[
        'person', 'role', 'person_role',
        'group', 'group_closure', 'membership',
        'time_grid', 'term', 'calendar_period', 'session_kind',
        'offering_group', 'offering_lecturer', 'offering_equipment',
        'session', 'session_group', 'session_person', 'session_room',
        'constraint_def', 'constraint_scope',
        'generation', 'session_event', 'constraint_violation',
        -- Authorization is tenant-scoped: an access role belongs to exactly one
        -- institution and must never be visible or assignable across tenants.
        'access_role', 'access_role_permission', 'person_access_role'
    ];
BEGIN
    FOREACH t IN ARRAY tenant_scoped LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I '
            'USING (tenant_id = calendry_internal.current_tenant_id()) '
            'WITH CHECK (tenant_id = calendry_internal.current_tenant_id())', t);
    END LOOP;
END $$;

-- 3b. Federation-ownable resources — the ONE deliberate exception to isolation
--     (TAXONOMY.md §2: a consortium's shared lecture hall, a cross-enrolled
--     elective). Readable when owned by your tenant OR by your federation.
--
--     WITH CHECK is deliberately narrower than USING: a tenant may only write
--     rows it owns outright. Creating or editing federation-owned resources is
--     a privileged path, not something a member tenant does incidentally.
DO $$
DECLARE
    t text;
    shared text[] := ARRAY['room', 'equipment', 'offering'];
BEGIN
    FOREACH t IN ARRAY shared LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY tenant_or_federation_read ON %I FOR SELECT '
            'USING (tenant_id = calendry_internal.current_tenant_id() '
            '       OR federation_id = calendry_internal.current_federation_id())', t);
        EXECUTE format(
            'CREATE POLICY tenant_write ON %I FOR ALL '
            'USING (tenant_id = calendry_internal.current_tenant_id()) '
            'WITH CHECK (tenant_id = calendry_internal.current_tenant_id())', t);
    END LOOP;
END $$;

-- 3c. room_equipment inherits its room's ownership: tenant_id is NULL for tags
--     on a federation-owned room.
ALTER TABLE "room_equipment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "room_equipment" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_or_federation_read ON "room_equipment" FOR SELECT
    USING (
        tenant_id = calendry_internal.current_tenant_id()
        OR EXISTS (
            SELECT 1 FROM "room" r
            WHERE r.id = "room_equipment".room_id
              AND r.federation_id = calendry_internal.current_federation_id()
        )
    );

CREATE POLICY tenant_write ON "room_equipment" FOR ALL
    USING (tenant_id = calendry_internal.current_tenant_id())
    WITH CHECK (tenant_id = calendry_internal.current_tenant_id());

-- 3d. The organizational tables themselves.
ALTER TABLE "tenant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_self_or_sibling ON "tenant" FOR SELECT
    USING (
        id = calendry_internal.current_tenant_id()
        OR federation_id = calendry_internal.current_federation_id()
    );

CREATE POLICY tenant_self_write ON "tenant" FOR ALL
    USING (id = calendry_internal.current_tenant_id())
    WITH CHECK (id = calendry_internal.current_tenant_id());

ALTER TABLE "federation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "federation" FORCE ROW LEVEL SECURITY;

-- Read-only to member tenants; federation administration is a privileged path.
CREATE POLICY federation_member_read ON "federation" FOR SELECT
    USING (id = calendry_internal.current_federation_id());

-- ---------------------------------------------------------------------------
-- 4. CHECK constraints
-- ---------------------------------------------------------------------------

-- Exactly one owner on shared resources. This is what makes the Federation
-- exception narrow and explicit rather than "tenant_id is nullable everywhere".
ALTER TABLE "room" ADD CONSTRAINT room_single_owner
    CHECK ((tenant_id IS NULL) <> (federation_id IS NULL));
ALTER TABLE "equipment" ADD CONSTRAINT equipment_single_owner
    CHECK ((tenant_id IS NULL) <> (federation_id IS NULL));
ALTER TABLE "offering" ADD CONSTRAINT offering_single_owner
    CHECK ((tenant_id IS NULL) <> (federation_id IS NULL));

-- A soft constraint must carry a penalty weight; a hard one must not.
ALTER TABLE "constraint_def" ADD CONSTRAINT constraint_weight_matches_severity
    CHECK (
        (severity = 'HARD' AND weight IS NULL)
        OR (severity = 'SOFT' AND weight IS NOT NULL)
    );

-- An all-NULL scope row would silently read as "applies to everything", which
-- is already expressed by having no scope rows at all.
ALTER TABLE "constraint_scope" ADD CONSTRAINT constraint_scope_not_empty
    CHECK (offering_id IS NOT NULL OR kind_id IS NOT NULL);

-- A group cannot be its own parent. Deeper cycles are caught by trigger.
ALTER TABLE "group" ADD CONSTRAINT group_no_self_parent
    CHECK (parent_group_id IS DISTINCT FROM id);

-- Placement coordinates are grid-relative and must stay in range. Actual
-- bounds resolve against the tenant's TimeGrid; these are the absolute floors.
ALTER TABLE "session" ADD CONSTRAINT session_placement_sane
    CHECK (
        term_week >= 1
        AND day_of_week BETWEEN 1 AND 7
        AND block_index >= 0
        AND duration_blocks >= 1
    );

ALTER TABLE "time_grid" ADD CONSTRAINT time_grid_shape_sane
    CHECK (
        block_length_minutes > 0
        AND blocks_per_day > 0
        AND start_hour BETWEEN 0 AND 23
        AND start_minute BETWEEN 0 AND 59
        AND break_minutes >= 0
    );

ALTER TABLE "term" ADD CONSTRAINT term_dates_ordered
    CHECK (end_date >= start_date);
ALTER TABLE "calendar_period" ADD CONSTRAINT calendar_period_dates_ordered
    CHECK (end_date >= start_date);

ALTER TABLE "offering" ADD CONSTRAINT offering_frequency_positive
    CHECK (frequency >= 1 AND duration_blocks >= 1);

ALTER TABLE "room" ADD CONSTRAINT room_capacity_non_negative
    CHECK (capacity >= 0);

-- ---------------------------------------------------------------------------
-- 5. Nested groups: closure table maintenance (TAXONOMY.md §6, §9.3)
-- ---------------------------------------------------------------------------
-- Write-time recompute. Conflict checks and notification fan-out are
-- read-heavy and both need the full ancestor+descendant set; group trees change
-- rarely. Maintained by trigger so the closure cannot drift when rows are
-- touched outside Prisma.

CREATE OR REPLACE FUNCTION calendry_internal.group_closure_after_insert() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    -- Self-pair at depth 0, so "G and everything conflicting with G" is one lookup.
    INSERT INTO "group_closure" (ancestor_id, descendant_id, tenant_id, depth)
    VALUES (NEW.id, NEW.id, NEW.tenant_id, 0);

    IF NEW.parent_group_id IS NOT NULL THEN
        INSERT INTO "group_closure" (ancestor_id, descendant_id, tenant_id, depth)
        SELECT c.ancestor_id, NEW.id, NEW.tenant_id, c.depth + 1
        FROM "group_closure" c
        WHERE c.descendant_id = NEW.parent_group_id;
    END IF;

    RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION calendry_internal.group_closure_before_reparent() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    -- Reject cycles: the new parent must not already be a descendant.
    IF NEW.parent_group_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM "group_closure"
        WHERE ancestor_id = NEW.id
          AND descendant_id = NEW.parent_group_id
    ) THEN
        RAISE EXCEPTION
            'group % cannot be reparented under %: that would create a cycle',
            NEW.id, NEW.parent_group_id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION calendry_internal.group_closure_after_reparent() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    -- Detach the moved subtree from its former ancestors, keeping the pairs
    -- that live entirely inside the subtree.
    DELETE FROM "group_closure"
    WHERE descendant_id IN (
              SELECT descendant_id FROM "group_closure" WHERE ancestor_id = NEW.id
          )
      AND ancestor_id NOT IN (
              SELECT descendant_id FROM "group_closure" WHERE ancestor_id = NEW.id
          );

    -- Reattach: every new ancestor × every node of the moved subtree.
    IF NEW.parent_group_id IS NOT NULL THEN
        INSERT INTO "group_closure" (ancestor_id, descendant_id, tenant_id, depth)
        SELECT sup.ancestor_id, sub.descendant_id, NEW.tenant_id, sup.depth + sub.depth + 1
        FROM "group_closure" sup
        CROSS JOIN "group_closure" sub
        WHERE sup.descendant_id = NEW.parent_group_id
          AND sub.ancestor_id = NEW.id
        ON CONFLICT (ancestor_id, descendant_id) DO NOTHING;
    END IF;

    RETURN NULL;
END $$;

CREATE TRIGGER group_closure_insert
    AFTER INSERT ON "group"
    FOR EACH ROW EXECUTE FUNCTION calendry_internal.group_closure_after_insert();

CREATE TRIGGER group_closure_reparent_guard
    BEFORE UPDATE OF parent_group_id ON "group"
    FOR EACH ROW
    WHEN (NEW.parent_group_id IS DISTINCT FROM OLD.parent_group_id)
    EXECUTE FUNCTION calendry_internal.group_closure_before_reparent();

CREATE TRIGGER group_closure_reparent
    AFTER UPDATE OF parent_group_id ON "group"
    FOR EACH ROW
    WHEN (NEW.parent_group_id IS DISTINCT FROM OLD.parent_group_id)
    EXECUTE FUNCTION calendry_internal.group_closure_after_reparent();

-- ---------------------------------------------------------------------------
-- 6. Append-only history (TAXONOMY.md §3)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION calendry_internal.deny_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION
        '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER session_event_append_only
    BEFORE UPDATE OR DELETE ON "session_event"
    FOR EACH ROW EXECUTE FUNCTION calendry_internal.deny_mutation();

CREATE TRIGGER generation_no_delete
    BEFORE DELETE ON "generation"
    FOR EACH ROW EXECUTE FUNCTION calendry_internal.deny_mutation();

-- A Generation's CONTENT is immutable; its lifecycle is not. status,
-- is_current, applied_at and infeasibility_report legitimately change as a
-- solver run progresses (PENDING → RUNNING → READY → APPLIED). Everything that
-- defines what the snapshot *is* stays frozen.
CREATE OR REPLACE FUNCTION calendry_internal.generation_content_immutable() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.parent_generation_id IS DISTINCT FROM OLD.parent_generation_id
       OR NEW.source IS DISTINCT FROM OLD.source
       OR NEW.solver_meta IS DISTINCT FROM OLD.solver_meta
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.created_by_id IS DISTINCT FROM OLD.created_by_id
    THEN
        RAISE EXCEPTION
            'generation % is immutable: only status, is_current, applied_at and infeasibility_report may change',
            OLD.id
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END $$;

CREATE TRIGGER generation_content_immutable
    BEFORE UPDATE ON "generation"
    FOR EACH ROW EXECUTE FUNCTION calendry_internal.generation_content_immutable();

-- ---------------------------------------------------------------------------
-- 7. Partial indexes on hot paths
-- ---------------------------------------------------------------------------

-- The solver's exclusion query: "give me the unlocked sessions to re-place".
-- A locked Session is never overwritten (TAXONOMY.md §3), so the index only
-- carries the rows the solver can actually touch.
CREATE INDEX session_unlocked_placement_idx
    ON "session" (tenant_id, term_id, term_week, day_of_week, block_index)
    WHERE is_locked = false;

-- Complement: the UI's "what is pinned here" lookup.
CREATE INDEX session_locked_idx
    ON "session" (tenant_id, term_id)
    WHERE is_locked = true;

-- Exactly one current Generation per tenant.
CREATE UNIQUE INDEX generation_one_current_per_tenant
    ON "generation" (tenant_id)
    WHERE is_current = true;

-- The "current violations" view is almost always filtered to unresolved hard
-- breaches first (TAXONOMY.md §3 warn-and-allow).
CREATE INDEX constraint_violation_hard_idx
    ON "constraint_violation" (tenant_id, detected_at DESC)
    WHERE severity = 'HARD';

-- Double-booking checks resolve room/person collisions per placement slot.
CREATE INDEX session_room_conflict_idx ON "session_room" (room_id, session_id);
CREATE INDEX session_person_conflict_idx ON "session_person" (person_id, session_id);

-- Event replay ordering (TAXONOMY.md §3 rollback).
CREATE INDEX session_event_replay_idx
    ON "session_event" (tenant_id, generation_id, created_at, seq);

-- ---------------------------------------------------------------------------
-- 8. Authentication: the pre-tenant data plane (DELIBERATELY WITHOUT RLS)
-- ---------------------------------------------------------------------------
--
-- account, account_person and auth_session carry NO row-level security, and
-- that is the second documented exception to tenant isolation in this system
-- (the first being Federation-owned resources).
--
-- It is structural, not a shortcut: a session must be read BEFORE the tenant is
-- known, because the session is what DETERMINES the tenant. Any policy on these
-- tables would compare against a context that does not exist yet and would
-- therefore reject every login attempt.
--
-- The safety property that replaces RLS here is access shape: these tables are
-- only ever read by primary key or by unique token hash taken from a verified
-- cookie, never by tenant filter, and no route exposes them directly. The token
-- itself is never stored — only its SHA-256 — so read access to this table does
-- not confer the ability to impersonate a session.
--
-- auth_session.active_person_id is what binds a session to a tenant. Everything
-- downstream derives calendry.tenant_id from that Person server-side; the
-- client never supplies a tenant.

COMMENT ON TABLE "account" IS
    'Pre-tenant plane: no RLS by design. Tenant-independent login identity.';
COMMENT ON TABLE "account_person" IS
    'Pre-tenant plane: no RLS by design. Maps one login to its per-tenant Person rows.';
COMMENT ON TABLE "auth_session" IS
    'Pre-tenant plane: no RLS by design. Read before tenant context exists.';

-- Sessions are looked up on every request by token hash, and expired ones are
-- swept in the background.
CREATE INDEX auth_session_active_idx
    ON "auth_session" (expires_at)
    WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- 9. Permission catalogue table (STRUCTURE ONLY — no rows)
-- ---------------------------------------------------------------------------
--
-- Migrations are schema-only. The 46 catalogue rows are reference data and are
-- populated by `prisma db seed` (prisma/seeds/reference/permissions.ts), which
-- both container entrypoints run immediately after `migrate deploy`.
--
-- A freshly migrated database therefore has an EMPTY permission table, and
-- provisioning a tenant against it fails on the access_role_permission foreign
-- key. That is intentional and loud: the alternative is a half-configured
-- system that looks fine until someone is denied an action they should have.

ALTER TABLE "permission" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "permission" FORCE ROW LEVEL SECURITY;

-- Readable by everyone, writable by no one at runtime. The seed writes it on
-- the OWNER connection, which bypasses RLS as a superuser; the app role is
-- refused by this policy, which is the intended protection — the runtime must
-- never mutate the set of actions it is authorized against.
CREATE POLICY permission_read_only ON "permission" FOR SELECT USING (true);


-- ---------------------------------------------------------------------------
-- 10. Bridging the two planes: narrow SECURITY DEFINER lookups
-- ---------------------------------------------------------------------------
--
-- Login has a genuine chicken-and-egg problem. Resolving a session requires
-- reading `person` (to learn the tenant), but `person` is behind RLS and RLS
-- needs the tenant that the read is trying to discover. Without a bridge,
-- authentication can never succeed.
--
-- These two functions are that bridge, and they are deliberately the ONLY
-- RLS-bypassing path in the system. Both are SECURITY DEFINER (so they execute
-- as the owner and are not filtered), and both are parameterised solely by a
-- secret the caller must already possess — an account id obtained from a
-- verified session, or a session token hash. Neither accepts a tenant id, so
-- neither can be coaxed into enumerating another tenant's rows.
--
-- search_path is pinned so a malicious schema earlier on the path cannot
-- shadow the tables these functions read.

CREATE OR REPLACE FUNCTION calendry_internal.session_identity(p_token_hash text)
RETURNS TABLE (
    session_id      text,
    account_id      text,
    person_id       text,
    tenant_id       text,
    federation_id   text,
    expires_at      timestamptz,
    revoked_at      timestamptz,
    account_active  boolean,
    person_active   boolean
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $fn$
    SELECT
        s.id, s.account_id, s.active_person_id,
        p.tenant_id, t.federation_id,
        s.expires_at, s.revoked_at,
        a.is_active, COALESCE(p.is_active, false)
    FROM auth_session s
    JOIN account a ON a.id = s.account_id
    LEFT JOIN person p ON p.id = s.active_person_id
    LEFT JOIN tenant t ON t.id = p.tenant_id
    WHERE s.token_hash = p_token_hash
$fn$;

CREATE OR REPLACE FUNCTION calendry_internal.account_identities(p_account_id text)
RETURNS TABLE (
    person_id     text,
    given_name    text,
    family_name   text,
    person_active boolean,
    tenant_id     text,
    tenant_slug   text,
    tenant_name   text,
    federation_id text
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $fn$
    SELECT
        p.id, p.given_name, p.family_name, p.is_active,
        t.id, t.slug, t.name, t.federation_id
    FROM account_person ap
    JOIN person p ON p.id = ap.person_id
    JOIN tenant t ON t.id = p.tenant_id
    WHERE ap.account_id = p_account_id
    ORDER BY t.name
$fn$;

-- Not executable by the world; only the runtime role may call them.
REVOKE EXECUTE ON FUNCTION calendry_internal.session_identity(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION calendry_internal.account_identities(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION calendry_internal.session_identity(text) TO calendry_app;
GRANT EXECUTE ON FUNCTION calendry_internal.account_identities(text) TO calendry_app;
