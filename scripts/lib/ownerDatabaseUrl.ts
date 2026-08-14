import { existsSync } from 'node:fs';

/**
 * Picks the owner connection string appropriate to where this process is running.
 *
 * There are two URLs for the same database because there are two vantage points:
 *
 *   MIGRATION_DATABASE_URL       → `db:5432`, a compose-internal hostname that
 *                                  resolves only between containers.
 *   MIGRATION_DATABASE_URL_HOST  → `localhost:55432`, the port
 *                                  docker-compose.dev.yml publishes, for tools
 *                                  run from a developer's shell.
 *
 * Choosing between them cannot be left to "whichever is set": bun auto-loads
 * `.env`, and the app container bind-mounts the repo, so BOTH variables are
 * present inside the container. Preferring the host URL unconditionally makes
 * in-container runs (the entrypoints) connect to `localhost` — which inside a
 * container is the container itself.
 *
 * `/.dockerenv` is the signal: it exists in containers and not on the host.
 *
 * Owner, not the runtime role, in every case. Migrations, provisioning and
 * reference seeding all write things the app role is deliberately forbidden to
 * touch — the `permission` catalogue, for instance, carries a SELECT-only RLS
 * policy, so an app-role INSERT is rejected outright.
 */
function resolve(internalVar: string, hostVar: string, label: string): string {
    const inContainer = existsSync('/.dockerenv');
    const internal = process.env[internalVar];
    const host = process.env[hostVar];

    const chosen = inContainer ? (internal ?? host) : (host ?? internal);

    if (!chosen) {
        throw new Error(
            `No ${label} database URL. Set ${internalVar} (inside containers) or\n`
            + `${hostVar} (from your shell). See .env.example.`,
        );
    }

    return chosen;
}

export function resolveOwnerDatabaseUrl(): string {
    return resolve('MIGRATION_DATABASE_URL', 'MIGRATION_DATABASE_URL_HOST', 'owner');
}

/**
 * The RUNTIME role, for tooling that genuinely does not need ownership.
 *
 * Provisioning needs the owner because a `tenant` row cannot be inserted under
 * a policy keyed to a tenant that does not exist yet. Password reset does not:
 * `account`, `account_person` and `auth_session` are the pre-tenant plane with
 * no RLS, and the one tenant-scoped thing a reset must read — which tenants an
 * account spans — comes from `calendry_internal.account_identities()`, which
 * the app role may execute. Verified empirically, not assumed.
 *
 * Using the owner anyway would mean an operator needs credentials that can drop
 * FORCE ROW LEVEL SECURITY, just to change a password.
 */
export function resolveAppDatabaseUrl(): string {
    return resolve('DATABASE_URL', 'DATABASE_URL_HOST', 'runtime');
}

/** Host:port of a connection string, for error messages that name the target. */
export function describeTarget(connectionString: string): string {
    return connectionString.replace(/^.*@/, '').replace(/\/.*$/, '');
}
