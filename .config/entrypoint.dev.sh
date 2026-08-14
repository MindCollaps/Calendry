#!/bin/sh
set -e

echo "Running database migrations..."
bun install
bun run prisma generate
bun run prisma migrate deploy

# Schema-only migrations mean the permission catalogue arrives here, not there.
echo "Seeding reference data..."
bun run prisma db seed

echo "Starting Prisma Studio..."
bun run prisma studio --port 51212 --browser none &

echo "Starting application..."
bun dev:local
