/**
 * Translates PostgreSQL/Prisma failures into HTTP responses.
 *
 * The database is a real participant in correctness here — RLS policies, CHECK
 * constraints and the group-cycle trigger all reject work that the application
 * layer permitted. Those rejections are expected outcomes, not crashes, so they
 * deserve meaningful status codes rather than a blanket 500.
 */
interface PgLikeError {
    code?: string;
    meta?: { code?: string; message?: string };
    message?: string;
}

/**
 * Digs the PostgreSQL SQLSTATE out of an error.
 *
 * The Prisma driver adapter wraps driver errors in its own error type, so the
 * SQLSTATE is not on the object that reaches us — it sits further down the
 * `cause` chain. Walking it is what makes constraint failures classifiable
 * rather than blanket 500s.
 */
function findPgCode(error: unknown, depth = 0): string | undefined {
    if (!error || typeof error !== 'object' || depth > 6) {
        return undefined;
    }

    const e = error as Record<string, unknown>;
    const candidates = [e.code, (e.meta as { code?: unknown } | undefined)?.code];

    for (const candidate of candidates) {
        if (typeof candidate === 'string' && /^[0-9A-Z]{5}$/.test(candidate)) {
            return candidate;
        }
    }

    return findPgCode(e.cause, depth + 1);
}

function collectMessages(error: unknown, depth = 0): string {
    if (!error || typeof error !== 'object' || depth > 6) {
        return '';
    }

    const e = error as Record<string, unknown>;
    const own = typeof e.message === 'string' ? e.message : '';

    return `${own}\n${collectMessages(e.cause, depth + 1)}`;
}

/**
 * True when an error is a unique-constraint violation.
 *
 * Exported so a caller that OWNS a specific unique index can turn it into a
 * domain answer instead of a generic 409 "Already exists." — the solver run
 * route needs to say "a run is already active for this term" and name it, which
 * only it has the context to do.
 *
 * Checks both the SQLSTATE (walking the driver adapter's `cause` chain) and
 * Prisma's own code, for the same reason `toHttpError` does: which one survives
 * depends on how the error was wrapped.
 */
export function findPgCodeIsUniqueViolation(error: unknown): boolean {
    return findPgCode(error) === '23505'
        || (error as { code?: string })?.code === 'P2002'
        || /duplicate key value/i.test(collectMessages(error));
}

export function toHttpError(error: unknown): never {
    const e = error as PgLikeError;
    const pgCode = findPgCode(error);
    const message = e?.meta?.message ?? e?.message ?? 'Database error.';
    const allMessages = collectMessages(error);

    // Prisma's own error codes, which survive when the SQLSTATE does not.
    if (e?.code === 'P2003') {
        throw createError({ statusCode: 409, statusMessage: 'Still referenced by other records.' });
    }

    if (e?.code === 'P2002') {
        throw createError({ statusCode: 409, statusMessage: 'Already exists.' });
    }

    switch (pgCode) {
        // RLS rejected the write: the row belongs to another tenant. Reported as
        // 404 rather than 403 so a caller cannot probe for existence of rows in
        // tenants it cannot see.
        case '42501':
            throw createError({ statusCode: 404, statusMessage: 'Not found.' });

        case '23505':
            throw createError({ statusCode: 409, statusMessage: 'Already exists.' });

        // FK RESTRICT — e.g. deleting a Group that still has children.
        case '23503':
            throw createError({
                statusCode: 409,
                statusMessage: 'Still referenced by other records.',
            });

        case '23514':
            throw createError({ statusCode: 422, statusMessage: `Constraint violated: ${message}` });

        // Raised by the group cycle guard and the append-only triggers.
        case '2BP01':
        case 'P0001':
            throw createError({ statusCode: 409, statusMessage: message });

        default:
            break;
    }

    // Prisma surfaces RLS-filtered updates as "record not found".
    if ((e as { code?: string })?.code === 'P2025') {
        throw createError({ statusCode: 404, statusMessage: 'Not found.' });
    }

    // Last resort: classify by message when neither a SQLSTATE nor a Prisma code
    // survived the adapter's wrapping. Message matching is fragile, so it runs
    // only after both structured paths have failed.
    if (/violates row-level security/i.test(allMessages)) {
        throw createError({ statusCode: 404, statusMessage: 'Not found.' });
    }

    if (/violates (foreign key|RESTRICT)|RESTRICT setting/i.test(allMessages)) {
        throw createError({ statusCode: 409, statusMessage: 'Still referenced by other records.' });
    }

    if (/duplicate key value/i.test(allMessages)) {
        throw createError({ statusCode: 409, statusMessage: 'Already exists.' });
    }

    if (/violates check constraint/i.test(allMessages)) {
        throw createError({ statusCode: 422, statusMessage: message });
    }

    if (/append-only|would create a cycle|is immutable/i.test(allMessages)) {
        throw createError({ statusCode: 409, statusMessage: message });
    }

    throw error;
}

export async function mapDbErrors<T>(fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (error) {
        // Already an H3 error (e.g. from validation) — pass through untouched.
        if ((error as { statusCode?: number })?.statusCode) {
            throw error;
        }

        return toHttpError(error);
    }
}
