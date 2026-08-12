#!/usr/bin/env bash

if [ -f .env ]; then
  echo ".env file already exists. Skipping generation."
  exit 0
fi

# generate random alphanumeric strings (32 chars)
generate_secret() {
  tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 32
}

echo "Generating new .env file with random secrets..."

# Two roles by design: the owner runs migrations, the app role serves requests
# under FORCE ROW LEVEL SECURITY. See .env.example for why.
POSTGRES_USER="calendry"
POSTGRES_DB="calendrydb"
POSTGRES_PASSWORD=$(generate_secret)

APP_DB_USER="calendry_app"
APP_DB_PASSWORD=$(generate_secret)

cat > .env <<EOF
ADMIN_USERNAME=system
ADMIN_PASSWORD=${ADMIN_PASSWORD}
ADMIN_EMAIL=john.smith@example.com

# Runtime connection — app role, RLS applies.
DATABASE_URL=postgresql://${APP_DB_USER}:${APP_DB_PASSWORD}@db:5432/${POSTGRES_DB}

# Migration connection — owner role, Prisma CLI only.
MIGRATION_DATABASE_URL=postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}

POSTGRES_USER=${POSTGRES_USER}
POSTGRES_DB=${POSTGRES_DB}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}

APP_DB_USER=${APP_DB_USER}
APP_DB_PASSWORD=${APP_DB_PASSWORD}
EOF

echo ".env file created successfully."
