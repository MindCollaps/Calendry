#!/usr/bin/env bash
# Runs the integration tests against a real Nuxt server and the dev database.
#
# The server is started on the HOST, so the database URLs are rewritten from the
# compose-internal `db:5432` to the published `localhost:55432`. Nothing here
# touches the committed .env.
set -euo pipefail

cd "$(dirname "$0")/.."

DB_PORT="${CALENDRY_TEST_DB_PORT:-55432}"
APP_PORT="${CALENDRY_TEST_APP_PORT:-8080}"

owner_pw=$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)
app_pw=$(grep '^APP_DB_PASSWORD=' .env | cut -d= -f2-)
db=$(grep '^POSTGRES_DB=' .env | cut -d= -f2-)

export DATABASE_URL="postgresql://calendry_app:${app_pw}@127.0.0.1:${DB_PORT}/${db}"
export TEST_MIGRATION_DATABASE_URL="postgresql://calendry:${owner_pw}@127.0.0.1:${DB_PORT}/${db}"
export MIGRATION_DATABASE_URL="$TEST_MIGRATION_DATABASE_URL"
# `localhost`, not 127.0.0.1: the Nuxt dev server binds IPv6-only ([::1]),
# so an IPv4 literal never connects.
export TEST_BASE_URL="http://localhost:${APP_PORT}"
export NODE_ENV=development
# The background solver poller must not run during the suites: it would sweep
# the fixture tenants concurrently with their own teardown/seed cycles.
export CALENDRY_SOLVER_POLL=off

echo "Starting Nuxt on ${APP_PORT}..."
./node_modules/.bin/nuxt dev --port "$APP_PORT" >/tmp/calendry-test-server.log 2>&1 &
server_pid=$!

cleanup() {
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 90); do
    if curl -fsS "${TEST_BASE_URL}/health" >/dev/null 2>&1; then
        echo "Server up."
        break
    fi
    sleep 1
done

if ! curl -fsS "${TEST_BASE_URL}/health" >/dev/null 2>&1; then
    echo "Server failed to start. Log:" >&2
    tail -40 /tmp/calendry-test-server.log >&2
    exit 1
fi

./node_modules/.bin/vitest run "$@"
