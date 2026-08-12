import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Migrations run as the OWNER role, not the runtime role. The runtime role
    // (DATABASE_URL) is deliberately powerless to create or alter tables, and
    // is subject to FORCE ROW LEVEL SECURITY — see the RLS migration.
    url: env("MIGRATION_DATABASE_URL"),
  },
});