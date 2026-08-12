-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "calendar_period_kind" AS ENUM ('HOLIDAY', 'BREAK', 'EXAM');

-- CreateEnum
CREATE TYPE "generation_source" AS ENUM ('SOLVER', 'MANUAL_BASELINE', 'IMPORT');

-- CreateEnum
CREATE TYPE "generation_status" AS ENUM ('PENDING', 'RUNNING', 'READY', 'APPLIED', 'FAILED', 'SUPERSEDED', 'INFEASIBLE');

-- CreateEnum
CREATE TYPE "session_event_type" AS ENUM ('CREATE', 'MOVE', 'SWAP', 'DELETE', 'LOCK', 'UNLOCK');

-- CreateEnum
CREATE TYPE "constraint_severity" AS ENUM ('HARD', 'SOFT');

-- CreateTable
CREATE TABLE "federation" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "federation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant" (
    "id" TEXT NOT NULL,
    "federation_id" TEXT,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "person" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "external_ref" TEXT,
    "given_name" TEXT NOT NULL,
    "family_name" TEXT NOT NULL,
    "email" TEXT,
    "timezone" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "person_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "person_role" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "person_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "parent_group_id" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "expected_size" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_closure" (
    "ancestor_id" TEXT NOT NULL,
    "descendant_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "depth" INTEGER NOT NULL,

    CONSTRAINT "group_closure_pkey" PRIMARY KEY ("ancestor_id","descendant_id")
);

-- CreateTable
CREATE TABLE "membership" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "federation_id" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 0,
    "location" TEXT,
    "ranking" INTEGER NOT NULL DEFAULT 0,
    "is_virtual" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "room_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "equipment" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "federation_id" TEXT,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "equipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_equipment" (
    "room_id" TEXT NOT NULL,
    "equipment_id" TEXT NOT NULL,
    "quantity" INTEGER,
    "tenant_id" TEXT,

    CONSTRAINT "room_equipment_pkey" PRIMARY KEY ("room_id","equipment_id")
);

-- CreateTable
CREATE TABLE "time_grid" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "block_length_minutes" INTEGER NOT NULL,
    "blocks_per_day" INTEGER NOT NULL,
    "active_days" INTEGER[],
    "start_hour" INTEGER NOT NULL DEFAULT 8,
    "start_minute" INTEGER NOT NULL DEFAULT 0,
    "break_minutes" INTEGER NOT NULL DEFAULT 0,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "time_grid_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "term" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "time_grid_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "term_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_period" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "term_id" TEXT NOT NULL,
    "kind" "calendar_period_kind" NOT NULL,
    "name" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "calendar_period_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_kind" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "requires_group" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "session_kind_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offering" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "federation_id" TEXT,
    "term_id" TEXT NOT NULL,
    "kind_id" TEXT NOT NULL,
    "code" TEXT,
    "title" TEXT NOT NULL,
    "frequency" INTEGER NOT NULL DEFAULT 1,
    "duration_blocks" INTEGER NOT NULL DEFAULT 1,
    "required_role_id" TEXT,
    "required_capacity" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "offering_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offering_group" (
    "offering_id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,

    CONSTRAINT "offering_group_pkey" PRIMARY KEY ("offering_id","group_id")
);

-- CreateTable
CREATE TABLE "offering_lecturer" (
    "offering_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "role_id" TEXT,

    CONSTRAINT "offering_lecturer_pkey" PRIMARY KEY ("offering_id","person_id")
);

-- CreateTable
CREATE TABLE "offering_equipment" (
    "offering_id" TEXT NOT NULL,
    "equipment_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "quantity" INTEGER,

    CONSTRAINT "offering_equipment_pkey" PRIMARY KEY ("offering_id","equipment_id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "offering_id" TEXT NOT NULL,
    "term_id" TEXT NOT NULL,
    "kind_id" TEXT NOT NULL,
    "time_grid_id" TEXT,
    "term_week" INTEGER NOT NULL,
    "day_of_week" INTEGER NOT NULL,
    "block_index" INTEGER NOT NULL,
    "duration_blocks" INTEGER NOT NULL DEFAULT 1,
    "is_locked" BOOLEAN NOT NULL DEFAULT false,
    "generation_id" TEXT,
    "starts_at" TIMESTAMPTZ(3),
    "ends_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_group" (
    "session_id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,

    CONSTRAINT "session_group_pkey" PRIMARY KEY ("session_id","group_id")
);

-- CreateTable
CREATE TABLE "session_person" (
    "session_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "role_id" TEXT,

    CONSTRAINT "session_person_pkey" PRIMARY KEY ("session_id","person_id")
);

-- CreateTable
CREATE TABLE "session_room" (
    "session_id" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,

    CONSTRAINT "session_room_pkey" PRIMARY KEY ("session_id","room_id")
);

-- CreateTable
CREATE TABLE "constraint_def" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "severity" "constraint_severity" NOT NULL,
    "weight" INTEGER,
    "params" JSONB NOT NULL DEFAULT '{}',
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "constraint_def_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "constraint_scope" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "constraint_id" TEXT NOT NULL,
    "offering_id" TEXT,
    "kind_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "constraint_scope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "parent_generation_id" TEXT,
    "source" "generation_source" NOT NULL,
    "status" "generation_status" NOT NULL DEFAULT 'PENDING',
    "is_current" BOOLEAN NOT NULL DEFAULT false,
    "solver_meta" JSONB,
    "infeasibility_report" JSONB,
    "created_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied_at" TIMESTAMPTZ(3),

    CONSTRAINT "generation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_event" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "generation_id" TEXT NOT NULL,
    "type" "session_event_type" NOT NULL,
    "session_id" TEXT,
    "counterpart_session_id" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "actor_person_id" TEXT,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "constraint_violation" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "constraint_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "severity" "constraint_severity" NOT NULL,
    "penalty" INTEGER,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "detected_by_event_id" TEXT,
    "generation_id" TEXT,
    "detected_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "constraint_violation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "federation_slug_key" ON "federation"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_slug_key" ON "tenant"("slug");

-- CreateIndex
CREATE INDEX "tenant_federation_id_idx" ON "tenant"("federation_id");

-- CreateIndex
CREATE INDEX "person_tenant_id_idx" ON "person"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "person_tenant_id_email_key" ON "person"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "person_tenant_id_external_ref_key" ON "person"("tenant_id", "external_ref");

-- CreateIndex
CREATE INDEX "role_tenant_id_idx" ON "role"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "role_tenant_id_key_key" ON "role"("tenant_id", "key");

-- CreateIndex
CREATE INDEX "person_role_tenant_id_idx" ON "person_role"("tenant_id");

-- CreateIndex
CREATE INDEX "person_role_role_id_idx" ON "person_role"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "person_role_person_id_role_id_key" ON "person_role"("person_id", "role_id");

-- CreateIndex
CREATE INDEX "group_tenant_id_idx" ON "group"("tenant_id");

-- CreateIndex
CREATE INDEX "group_parent_group_id_idx" ON "group"("parent_group_id");

-- CreateIndex
CREATE INDEX "group_closure_descendant_id_idx" ON "group_closure"("descendant_id");

-- CreateIndex
CREATE INDEX "group_closure_tenant_id_idx" ON "group_closure"("tenant_id");

-- CreateIndex
CREATE INDEX "membership_tenant_id_idx" ON "membership"("tenant_id");

-- CreateIndex
CREATE INDEX "membership_group_id_idx" ON "membership"("group_id");

-- CreateIndex
CREATE UNIQUE INDEX "membership_person_id_group_id_key" ON "membership"("person_id", "group_id");

-- CreateIndex
CREATE INDEX "room_tenant_id_idx" ON "room"("tenant_id");

-- CreateIndex
CREATE INDEX "room_federation_id_idx" ON "room"("federation_id");

-- CreateIndex
CREATE INDEX "equipment_tenant_id_idx" ON "equipment"("tenant_id");

-- CreateIndex
CREATE INDEX "equipment_federation_id_idx" ON "equipment"("federation_id");

-- CreateIndex
CREATE INDEX "room_equipment_equipment_id_idx" ON "room_equipment"("equipment_id");

-- CreateIndex
CREATE INDEX "room_equipment_tenant_id_idx" ON "room_equipment"("tenant_id");

-- CreateIndex
CREATE INDEX "time_grid_tenant_id_idx" ON "time_grid"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "time_grid_tenant_id_name_key" ON "time_grid"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "term_tenant_id_idx" ON "term"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "term_tenant_id_name_key" ON "term"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "calendar_period_tenant_id_idx" ON "calendar_period"("tenant_id");

-- CreateIndex
CREATE INDEX "calendar_period_term_id_kind_idx" ON "calendar_period"("term_id", "kind");

-- CreateIndex
CREATE INDEX "session_kind_tenant_id_idx" ON "session_kind"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "session_kind_tenant_id_key_key" ON "session_kind"("tenant_id", "key");

-- CreateIndex
CREATE INDEX "offering_tenant_id_idx" ON "offering"("tenant_id");

-- CreateIndex
CREATE INDEX "offering_federation_id_idx" ON "offering"("federation_id");

-- CreateIndex
CREATE INDEX "offering_term_id_idx" ON "offering"("term_id");

-- CreateIndex
CREATE INDEX "offering_group_group_id_idx" ON "offering_group"("group_id");

-- CreateIndex
CREATE INDEX "offering_group_tenant_id_idx" ON "offering_group"("tenant_id");

-- CreateIndex
CREATE INDEX "offering_lecturer_person_id_idx" ON "offering_lecturer"("person_id");

-- CreateIndex
CREATE INDEX "offering_lecturer_tenant_id_idx" ON "offering_lecturer"("tenant_id");

-- CreateIndex
CREATE INDEX "offering_equipment_equipment_id_idx" ON "offering_equipment"("equipment_id");

-- CreateIndex
CREATE INDEX "offering_equipment_tenant_id_idx" ON "offering_equipment"("tenant_id");

-- CreateIndex
CREATE INDEX "session_tenant_id_idx" ON "session"("tenant_id");

-- CreateIndex
CREATE INDEX "session_offering_id_idx" ON "session"("offering_id");

-- CreateIndex
CREATE INDEX "session_generation_id_idx" ON "session"("generation_id");

-- CreateIndex
CREATE INDEX "session_tenant_id_term_id_term_week_day_of_week_block_index_idx" ON "session"("tenant_id", "term_id", "term_week", "day_of_week", "block_index");

-- CreateIndex
CREATE INDEX "session_group_group_id_idx" ON "session_group"("group_id");

-- CreateIndex
CREATE INDEX "session_group_tenant_id_idx" ON "session_group"("tenant_id");

-- CreateIndex
CREATE INDEX "session_person_person_id_idx" ON "session_person"("person_id");

-- CreateIndex
CREATE INDEX "session_person_tenant_id_idx" ON "session_person"("tenant_id");

-- CreateIndex
CREATE INDEX "session_person_role_id_idx" ON "session_person"("role_id");

-- CreateIndex
CREATE INDEX "session_room_room_id_idx" ON "session_room"("room_id");

-- CreateIndex
CREATE INDEX "session_room_tenant_id_idx" ON "session_room"("tenant_id");

-- CreateIndex
CREATE INDEX "constraint_def_tenant_id_idx" ON "constraint_def"("tenant_id");

-- CreateIndex
CREATE INDEX "constraint_def_tenant_id_is_enabled_idx" ON "constraint_def"("tenant_id", "is_enabled");

-- CreateIndex
CREATE INDEX "constraint_scope_tenant_id_idx" ON "constraint_scope"("tenant_id");

-- CreateIndex
CREATE INDEX "constraint_scope_offering_id_idx" ON "constraint_scope"("offering_id");

-- CreateIndex
CREATE INDEX "constraint_scope_kind_id_idx" ON "constraint_scope"("kind_id");

-- CreateIndex
CREATE UNIQUE INDEX "constraint_scope_constraint_id_offering_id_kind_id_key" ON "constraint_scope"("constraint_id", "offering_id", "kind_id");

-- CreateIndex
CREATE INDEX "generation_tenant_id_idx" ON "generation"("tenant_id");

-- CreateIndex
CREATE INDEX "generation_parent_generation_id_idx" ON "generation"("parent_generation_id");

-- CreateIndex
CREATE UNIQUE INDEX "generation_tenant_id_version_key" ON "generation"("tenant_id", "version");

-- CreateIndex
CREATE INDEX "session_event_tenant_id_seq_idx" ON "session_event"("tenant_id", "seq");

-- CreateIndex
CREATE INDEX "session_event_generation_id_idx" ON "session_event"("generation_id");

-- CreateIndex
CREATE INDEX "session_event_session_id_idx" ON "session_event"("session_id");

-- CreateIndex
CREATE INDEX "constraint_violation_tenant_id_severity_idx" ON "constraint_violation"("tenant_id", "severity");

-- CreateIndex
CREATE INDEX "constraint_violation_session_id_idx" ON "constraint_violation"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "constraint_violation_constraint_id_session_id_key" ON "constraint_violation"("constraint_id", "session_id");

-- AddForeignKey
ALTER TABLE "tenant" ADD CONSTRAINT "tenant_federation_id_fkey" FOREIGN KEY ("federation_id") REFERENCES "federation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person" ADD CONSTRAINT "person_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role" ADD CONSTRAINT "role_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person_role" ADD CONSTRAINT "person_role_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person_role" ADD CONSTRAINT "person_role_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person_role" ADD CONSTRAINT "person_role_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group" ADD CONSTRAINT "group_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group" ADD CONSTRAINT "group_parent_group_id_fkey" FOREIGN KEY ("parent_group_id") REFERENCES "group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_closure" ADD CONSTRAINT "group_closure_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_closure" ADD CONSTRAINT "group_closure_ancestor_id_fkey" FOREIGN KEY ("ancestor_id") REFERENCES "group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_closure" ADD CONSTRAINT "group_closure_descendant_id_fkey" FOREIGN KEY ("descendant_id") REFERENCES "group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room" ADD CONSTRAINT "room_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room" ADD CONSTRAINT "room_federation_id_fkey" FOREIGN KEY ("federation_id") REFERENCES "federation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_federation_id_fkey" FOREIGN KEY ("federation_id") REFERENCES "federation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_equipment" ADD CONSTRAINT "room_equipment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_equipment" ADD CONSTRAINT "room_equipment_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_equipment" ADD CONSTRAINT "room_equipment_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "equipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_grid" ADD CONSTRAINT "time_grid_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "term" ADD CONSTRAINT "term_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "term" ADD CONSTRAINT "term_time_grid_id_fkey" FOREIGN KEY ("time_grid_id") REFERENCES "time_grid"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_period" ADD CONSTRAINT "calendar_period_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_period" ADD CONSTRAINT "calendar_period_term_id_fkey" FOREIGN KEY ("term_id") REFERENCES "term"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_kind" ADD CONSTRAINT "session_kind_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offering" ADD CONSTRAINT "offering_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offering" ADD CONSTRAINT "offering_federation_id_fkey" FOREIGN KEY ("federation_id") REFERENCES "federation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offering" ADD CONSTRAINT "offering_term_id_fkey" FOREIGN KEY ("term_id") REFERENCES "term"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offering" ADD CONSTRAINT "offering_kind_id_fkey" FOREIGN KEY ("kind_id") REFERENCES "session_kind"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offering" ADD CONSTRAINT "offering_required_role_id_fkey" FOREIGN KEY ("required_role_id") REFERENCES "role"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offering_group" ADD CONSTRAINT "offering_group_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offering_group" ADD CONSTRAINT "offering_group_offering_id_fkey" FOREIGN KEY ("offering_id") REFERENCES "offering"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offering_group" ADD CONSTRAINT "offering_group_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offering_lecturer" ADD CONSTRAINT "offering_lecturer_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offering_lecturer" ADD CONSTRAINT "offering_lecturer_offering_id_fkey" FOREIGN KEY ("offering_id") REFERENCES "offering"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offering_lecturer" ADD CONSTRAINT "offering_lecturer_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offering_lecturer" ADD CONSTRAINT "offering_lecturer_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offering_equipment" ADD CONSTRAINT "offering_equipment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offering_equipment" ADD CONSTRAINT "offering_equipment_offering_id_fkey" FOREIGN KEY ("offering_id") REFERENCES "offering"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offering_equipment" ADD CONSTRAINT "offering_equipment_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "equipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_offering_id_fkey" FOREIGN KEY ("offering_id") REFERENCES "offering"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_term_id_fkey" FOREIGN KEY ("term_id") REFERENCES "term"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_kind_id_fkey" FOREIGN KEY ("kind_id") REFERENCES "session_kind"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_time_grid_id_fkey" FOREIGN KEY ("time_grid_id") REFERENCES "time_grid"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_generation_id_fkey" FOREIGN KEY ("generation_id") REFERENCES "generation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_group" ADD CONSTRAINT "session_group_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_group" ADD CONSTRAINT "session_group_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_group" ADD CONSTRAINT "session_group_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_person" ADD CONSTRAINT "session_person_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_person" ADD CONSTRAINT "session_person_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_person" ADD CONSTRAINT "session_person_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_person" ADD CONSTRAINT "session_person_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_room" ADD CONSTRAINT "session_room_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_room" ADD CONSTRAINT "session_room_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_room" ADD CONSTRAINT "session_room_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "constraint_def" ADD CONSTRAINT "constraint_def_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "constraint_scope" ADD CONSTRAINT "constraint_scope_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "constraint_scope" ADD CONSTRAINT "constraint_scope_constraint_id_fkey" FOREIGN KEY ("constraint_id") REFERENCES "constraint_def"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "constraint_scope" ADD CONSTRAINT "constraint_scope_offering_id_fkey" FOREIGN KEY ("offering_id") REFERENCES "offering"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "constraint_scope" ADD CONSTRAINT "constraint_scope_kind_id_fkey" FOREIGN KEY ("kind_id") REFERENCES "session_kind"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation" ADD CONSTRAINT "generation_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation" ADD CONSTRAINT "generation_parent_generation_id_fkey" FOREIGN KEY ("parent_generation_id") REFERENCES "generation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation" ADD CONSTRAINT "generation_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_event" ADD CONSTRAINT "session_event_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_event" ADD CONSTRAINT "session_event_generation_id_fkey" FOREIGN KEY ("generation_id") REFERENCES "generation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_event" ADD CONSTRAINT "session_event_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_event" ADD CONSTRAINT "session_event_counterpart_session_id_fkey" FOREIGN KEY ("counterpart_session_id") REFERENCES "session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_event" ADD CONSTRAINT "session_event_actor_person_id_fkey" FOREIGN KEY ("actor_person_id") REFERENCES "person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "constraint_violation" ADD CONSTRAINT "constraint_violation_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "constraint_violation" ADD CONSTRAINT "constraint_violation_constraint_id_fkey" FOREIGN KEY ("constraint_id") REFERENCES "constraint_def"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "constraint_violation" ADD CONSTRAINT "constraint_violation_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "constraint_violation" ADD CONSTRAINT "constraint_violation_detected_by_event_id_fkey" FOREIGN KEY ("detected_by_event_id") REFERENCES "session_event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "constraint_violation" ADD CONSTRAINT "constraint_violation_generation_id_fkey" FOREIGN KEY ("generation_id") REFERENCES "generation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

