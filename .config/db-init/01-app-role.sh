#!/bin/sh
# Provisions the runtime database role at cluster init.
#
# Calendry uses two roles by design (see the RLS migration):
#   $POSTGRES_USER  — owner. Owns the schema, runs migrations, never used at runtime.
#   $APP_DB_USER    — runtime. DML only, no ownership, subject to FORCE ROW LEVEL SECURITY.
#
# An owning role bypasses RLS unless FORCE is set, and can always drop FORCE.
# Keeping the runtime connection on a non-owner role is what makes tenant
# isolation a database guarantee rather than an application convention.
#
# This runs only on first initialisation of an empty data directory. The
# migration creates the same role NOLOGIN if it is missing, so migrating a
# database that never ran this script still succeeds — it just has no password
# until one is set here or by hand.

set -e

: "${APP_DB_USER:?APP_DB_USER must be set}"
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD must be set}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    DO \$\$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_DB_USER}') THEN
            CREATE ROLE ${APP_DB_USER} LOGIN PASSWORD '${APP_DB_PASSWORD}';
        ELSE
            ALTER ROLE ${APP_DB_USER} LOGIN PASSWORD '${APP_DB_PASSWORD}';
        END IF;
    END
    \$\$;

    GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO ${APP_DB_USER};

    -- No CREATE on public: the runtime role must never own an object.
    REVOKE CREATE ON SCHEMA public FROM ${APP_DB_USER};
EOSQL

echo "Provisioned runtime role ${APP_DB_USER}."
