import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, login } from './helpers/client';
import { ACCOUNTS, type Fixtures, TEST_PASSWORD, ownerDb, seed, teardown } from './helpers/seed';

/**
 * Forced password reset and the change-password round trip.
 *
 * The case worth the most here is SESSION REVOCATION. Setting a new password
 * while old sessions stay valid is the failure this feature exists to prevent:
 * the account holder believes they have locked someone out, and has not. It is
 * asserted across tenants, because sessions hang off account_id rather than
 * person_id and a per-tenant revocation would silently miss the others.
 */
let f: Fixtures;

const NEW_PASSWORD = 'a-brand-new-password-99';

beforeAll(async () => {
    f = await seed();
}, 60_000);

afterAll(async () => {
    await teardown();
    await ownerDb.$disconnect();
});

/** What the reset CLI does, exercised through the same data path it uses. */
async function forceReset(email: string) {
    const account = await ownerDb.account.findUniqueOrThrow({ where: { email } });

    return ownerDb.$transaction(async (tx) => {
        await tx.account.update({
            where: { id: account.id },
            data: { mustChangePassword: true },
        });

        return (await tx.authSession.updateMany({
            where: { accountId: account.id, revokedAt: null },
            data: { revokedAt: new Date() },
        })).count;
    });
}

describe('session revocation on reset', () => {
    it('kills every live session for the account, in every tenant', async () => {
        // The multi-tenant account signs in twice, landing in different tenants.
        const inA = await login(ACCOUNTS.multi, TEST_PASSWORD, 'test-a');
        const inB = await login(ACCOUNTS.multi, TEST_PASSWORD, 'test-b');

        expect((await api('/api/persons', { cookie: inA.cookie })).status).toBe(200);
        expect((await api('/api/persons', { cookie: inB.cookie })).status).toBe(200);

        const revoked = await forceReset(ACCOUNTS.multi);

        expect(revoked).toBeGreaterThanOrEqual(2);

        // Both die, not just the one that happened to be most recent.
        expect((await api('/api/persons', { cookie: inA.cookie })).status).toBe(401);
        expect((await api('/api/persons', { cookie: inB.cookie })).status).toBe(401);

        // And no live rows are left behind for that account.
        const account = await ownerDb.account.findUniqueOrThrow({ where: { email: ACCOUNTS.multi } });
        const live = await ownerDb.authSession.count({
            where: { accountId: account.id, revokedAt: null },
        });

        expect(live).toBe(0);
    });

    it('leaves other accounts\' sessions untouched', async () => {
        const other = await login(ACCOUNTS.adminA, TEST_PASSWORD);

        await forceReset(ACCOUNTS.viewerA);

        expect((await api('/api/persons', { cookie: other.cookie })).status).toBe(200);
    });
});

describe('forced password change', () => {
    it('authenticates but issues no session while the flag is set', async () => {
        await forceReset(ACCOUNTS.adminB);

        const res = await api<{ requiresPasswordChange: boolean }>('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email: ACCOUNTS.adminB, password: TEST_PASSWORD }),
        });

        expect(res.status).toBe(200);
        expect(res.body.requiresPasswordChange).toBe(true);

        // Correct credentials, but deliberately no usable cookie: a "restricted
        // session" would be a state every route has to know about.
        const cookie = res.setCookie?.split(';')[0];

        expect(cookie ? (await api('/api/persons', { cookie })).status : 401).toBe(401);
    });

    it('clears the flag and lets the account back in', async () => {
        await forceReset(ACCOUNTS.adminA);

        const change = await api('/api/auth/change-password', {
            method: 'POST',
            body: JSON.stringify({
                email: ACCOUNTS.adminA,
                currentPassword: TEST_PASSWORD,
                newPassword: NEW_PASSWORD,
            }),
        });

        expect(change.status).toBe(204);

        const account = await ownerDb.account.findUniqueOrThrow({ where: { email: ACCOUNTS.adminA } });

        expect(account.mustChangePassword).toBe(false);

        // The old password is genuinely gone, and the new one works.
        const stale = await api('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email: ACCOUNTS.adminA, password: TEST_PASSWORD }),
        });

        expect(stale.status).toBe(401);

        const fresh = await login(ACCOUNTS.adminA, NEW_PASSWORD);

        expect((await api('/api/persons', { cookie: fresh.cookie })).status).toBe(200);
    });

    it('revokes sessions on an ordinary password change too', async () => {
        const before = await login(ACCOUNTS.adminA, NEW_PASSWORD);

        expect((await api('/api/persons', { cookie: before.cookie })).status).toBe(200);

        await api('/api/auth/change-password', {
            method: 'POST',
            body: JSON.stringify({
                email: ACCOUNTS.adminA,
                currentPassword: NEW_PASSWORD,
                newPassword: TEST_PASSWORD,
            }),
        });

        expect((await api('/api/persons', { cookie: before.cookie })).status).toBe(401);
    });
});

describe('change-password refuses bad input', () => {
    it('rejects a wrong current password with the generic 401', async () => {
        const res = await api('/api/auth/change-password', {
            method: 'POST',
            body: JSON.stringify({
                email: ACCOUNTS.adminB,
                currentPassword: 'not-the-password',
                newPassword: 'something-long-enough',
            }),
        });

        expect(res.status).toBe(401);
    });

    it('does not distinguish an unknown account from a wrong password', async () => {
        const unknown = await api('/api/auth/change-password', {
            method: 'POST',
            body: JSON.stringify({
                email: 'nobody@test.local',
                currentPassword: 'whatever',
                newPassword: 'something-long-enough',
            }),
        });

        expect(unknown.status).toBe(401);
    });

    it('refuses to reuse the current password', async () => {
        const res = await api('/api/auth/change-password', {
            method: 'POST',
            body: JSON.stringify({
                email: ACCOUNTS.viewerA,
                currentPassword: TEST_PASSWORD,
                newPassword: TEST_PASSWORD,
            }),
        });

        expect(res.status).toBe(422);
    });

    it('enforces a minimum length', async () => {
        const res = await api('/api/auth/change-password', {
            method: 'POST',
            body: JSON.stringify({
                email: ACCOUNTS.viewerA,
                currentPassword: TEST_PASSWORD,
                newPassword: 'short',
            }),
        });

        expect(res.status).toBe(400);
    });
});
