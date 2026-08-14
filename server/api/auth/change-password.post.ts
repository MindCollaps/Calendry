import { z } from 'zod';
import { hashPassword, verifyPassword } from '../../utils/auth';
import { findAccountByEmail } from '../../utils/authDb';

const bodySchema = z.object({
    email: z.string().email(),
    currentPassword: z.string().min(1),
    newPassword: z.string().min(12, 'New password must be at least 12 characters.'),
});

/**
 * Change an Account's password.
 *
 * Public by necessity: this is the only way out of a forced reset, and a
 * forced reset deliberately issues no session. It re-authenticates from the
 * credentials in the body rather than trusting a cookie.
 *
 * Doubles as the ordinary "change my password" capability, which otherwise did
 * not exist anywhere in the system.
 */
export default defineEventHandler(async (event) => {
    const body = await readValidatedBody(event, bodySchema.parse);
    const account = await findAccountByEmail(body.email);

    // Same generic 401 and same work as the login route, so this endpoint does
    // not become the account-existence oracle that login avoids being.
    const ok = account
        ? await verifyPassword(body.currentPassword, account.passwordHash)
        : await verifyPassword(body.currentPassword, 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');

    if (!account || !account.isActive || !ok) {
        throw createError({ statusCode: 401, statusMessage: 'Invalid credentials.' });
    }

    if (await verifyPassword(body.newPassword, account.passwordHash)) {
        throw createError({
            statusCode: 422,
            statusMessage: 'The new password must be different from the current one.',
        });
    }

    const passwordHash = await hashPassword(body.newPassword);
    const prisma = getPrisma();

    await prisma.$transaction(async (tx) => {
        await tx.account.update({
            where: { id: account.id },
            data: { passwordHash, mustChangePassword: false },
        });

        // A password change invalidates existing sessions, for the same reason
        // a reset does: whoever prompted the change may be locking someone out.
        await tx.authSession.updateMany({
            where: { accountId: account.id, revokedAt: null },
            data: { revokedAt: new Date() },
        });
    });

    // No auto-login. The caller signs in normally with the new password, which
    // keeps this endpoint doing exactly one thing.
    setResponseStatus(event, 204);

    return null;
});
