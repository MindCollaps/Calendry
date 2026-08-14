#!/bin/sh
set -e

echo "Running database migrations..."
prisma migrate deploy

# Migrations are schema-only, so the permission catalogue arrives here. Note
# that `migrate deploy` does NOT auto-seed (unlike reset/dev), which is why this
# is a separate, explicit step. It is idempotent: an upsert per row.
echo "Seeding reference data..."
prisma db seed

echo "Starting application..."
node .output/server/index.mjs
