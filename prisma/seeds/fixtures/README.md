# Fixture seeds — dev/test only

Nothing lives here yet. The directory exists so the tier boundary is visible
before anyone needs it, rather than being invented under time pressure.

## What belongs here

Sample data that makes a development environment pleasant: demo tenants, example
Offerings, a populated timetable. Anything whose absence is an inconvenience
rather than a defect.

## What does NOT belong here

Data the system is incorrect without. The `permission` catalogue is the standing
example — tenants cannot be provisioned without it, because
`access_role_permission.permission_key` is a foreign key into it. That is
**reference** data and lives in `../reference/`, running unconditionally in every
environment.

The test suite deliberately does not use this tier either: `tests/helpers/seed.ts`
builds and tears down its own fixtures per run, so tests never depend on the
state of a shared database.

## Guard

Fixture seeding requires **both**:

- the explicit `--fixtures` flag, and
- `NODE_ENV !== 'production'`

Either alone is too easy to satisfy by accident — a stray flag copied into a
deploy script, or an environment where `NODE_ENV` was simply never set.

```sh
bun run db-seed -- --fixtures
```

Register new fixture seeders in `prisma/seed.ts`, inside the `withFixtures`
branch.
