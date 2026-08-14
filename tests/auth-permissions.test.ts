import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, cookieFrom, login } from './helpers/client';
import { ACCOUNTS, type Fixtures, TEST_PASSWORD, ownerDb, seed, teardown } from './helpers/seed';

/**
 * Authentication and permission enforcement.
 *
 * The two cases that matter most here:
 *
 *  - PERMISSION DENIAL — a legitimately authenticated member of a tenant is
 *    still refused the actions their access roles do not grant.
 *  - CROSS-TENANT SESSION REUSE — a valid session for tenant A cannot be turned
 *    into access to tenant B, by any route, including tenant switching.
 */
let f: Fixtures;

beforeAll(async () => {
    f = await seed();
}, 60_000);

afterAll(async () => {
    await teardown();
    await ownerDb.$disconnect();
});

describe('authentication', () => {
    it('rejects a wrong password and an unknown account identically', async () => {
        const wrongPassword = await api('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email: ACCOUNTS.adminA, password: 'not-the-password' }),
        });
        const unknownAccount = await api('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email: 'nobody@test.local', password: TEST_PASSWORD }),
        });

        // Same status and message, so the endpoint is not an account-existence
        // oracle.
        expect(wrongPassword.status).toBe(401);
        expect(unknownAccount.status).toBe(401);
        expect(JSON.stringify(unknownAccount.body)).toEqual(JSON.stringify(wrongPassword.body));
    });

    it('issues an httpOnly cookie and reports the active tenant', async () => {
        const res = await api('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email: ACCOUNTS.adminA, password: TEST_PASSWORD }),
        });

        expect(res.status).toBe(200);
        expect(res.setCookie).toMatch(/HttpOnly/i);
        expect((res.body as { activeTenant: { id: string } }).activeTenant.id).toBe(f.tenantA);
    });

    it('never stores the session token itself, only its hash', async () => {
        const { cookie } = await login(ACCOUNTS.adminA, TEST_PASSWORD);
        const token = cookie.split('=')[1] as string;

        const stored = await ownerDb.authSession.findMany({ select: { tokenHash: true } });

        expect(stored.length).toBeGreaterThan(0);
        expect(stored.map((s) => s.tokenHash)).not.toContain(token);
    });

    it('requires tenant selection when an account has several identities', async () => {
        const res = await api<{ tenantSelectionRequired: boolean; availableTenants: unknown[] }>(
            '/api/auth/login',
            { method: 'POST', body: JSON.stringify({ email: ACCOUNTS.multi, password: TEST_PASSWORD }) },
        );

        expect(res.status).toBe(200);
        expect(res.body.tenantSelectionRequired).toBe(true);
        expect(res.body.availableTenants).toHaveLength(2);

        const cookie = cookieFrom(res.setCookie);

        // Authenticated but not situated: API calls are refused until a tenant
        // is chosen, because there is no Person to derive a tenant from.
        expect((await api('/api/persons', { cookie })).status).toBe(401);

        const selected = await api('/api/auth/select-tenant', {
            method: 'POST',
            cookie,
            body: JSON.stringify({ tenantId: f.tenantB }),
        });

        expect(selected.status).toBe(200);

        const after = await api<{ id: string }[]>('/api/persons', { cookie });

        expect(after.status).toBe(200);
        expect(after.body.map((p) => p.id)).toContain(f.personMultiB);
        expect(after.body.map((p) => p.id)).not.toContain(f.personA);
    });

    it('revokes the session server-side on logout', async () => {
        const { cookie } = await login(ACCOUNTS.adminA, TEST_PASSWORD);

        expect((await api('/api/persons', { cookie })).status).toBe(200);
        expect((await api('/api/auth/logout', { method: 'POST', cookie })).status).toBe(204);

        // The cookie value still exists client-side; it is dead server-side.
        expect((await api('/api/persons', { cookie })).status).toBe(401);
    });

    it('stops honouring a session whose Person has been deactivated', async () => {
        const { cookie } = await login(ACCOUNTS.viewerA, TEST_PASSWORD);

        expect((await api('/api/sessions', { cookie })).status).toBe(200);

        await ownerDb.person.update({ where: { id: f.personViewerA }, data: { isActive: false } });

        expect((await api('/api/sessions', { cookie })).status).toBe(401);

        await ownerDb.person.update({ where: { id: f.personViewerA }, data: { isActive: true } });
    });
});

describe('permission enforcement', () => {
    it('allows what the access role grants', async () => {
        const { cookie } = await login(ACCOUNTS.viewerA, TEST_PASSWORD);

        // The viewer role holds exactly one permission: session.read.
        expect((await api('/api/sessions', { cookie })).status).toBe(200);
    });

    it('denies every action the access role does not grant', async () => {
        const { cookie } = await login(ACCOUNTS.viewerA, TEST_PASSWORD);

        const denied = await Promise.all([
            api(`/api/sessions/${f.sessionA}/move`, {
                method: 'POST', cookie, body: JSON.stringify({ blockIndex: 6 }),
            }),
            api(`/api/sessions/${f.sessionA}/lock`, { method: 'POST', cookie, body: JSON.stringify({}) }),
            api('/api/persons', { cookie }),
            api('/api/persons', {
                method: 'POST', cookie,
                body: JSON.stringify({ givenName: 'X', familyName: 'Y' }),
            }),
            api('/api/violations', { cookie }),
            api('/api/solver/generations', { method: 'POST', cookie, body: JSON.stringify({}) }),
        ]);

        for (const res of denied) {
            expect(res.status).toBe(403);
        }

        // 403 not 404: the caller is legitimately inside this tenant.
        expect(JSON.stringify(denied[0]?.body)).toContain('session.move');

        // And the denied move genuinely did not happen.
        expect((await ownerDb.session.findUnique({ where: { id: f.sessionA } }))?.blockIndex).toBe(0);
    });

    it('reports the caller\'s permissions for UI gating', async () => {
        const viewer = await login(ACCOUNTS.viewerA, TEST_PASSWORD);
        const admin = await login(ACCOUNTS.adminA, TEST_PASSWORD);

        const viewerSession = await api<{ permissions: string[] }>('/api/auth/session', { cookie: viewer.cookie });
        const adminSession = await api<{ permissions: string[] }>('/api/auth/session', { cookie: admin.cookie });

        expect(viewerSession.body.permissions).toEqual(['session.read']);
        expect(adminSession.body.permissions.length).toBeGreaterThan(40);
        expect(adminSession.body.permissions).toContain('session.move');
    });

    it('does not leak access roles across tenants', async () => {
        const { cookie } = await login(ACCOUNTS.adminB, TEST_PASSWORD);
        const res = await api<{ permissions: string[] }>('/api/auth/session', { cookie });

        // Tenant B's admin gets B's role, not A's — even though both are keyed
        // 'tenant-admin'. person_access_role is behind RLS.
        //
        // Scoped to the fixture tenants on purpose: an unscoped count would also
        // pick up any tenant provisioned outside the tests and fail for reasons
        // that have nothing to do with isolation.
        const roles = await ownerDb.accessRole.findMany({
            where: { key: 'tenant-admin', tenantId: { in: [f.tenantA, f.tenantB] } },
        });

        expect(roles).toHaveLength(2);
        expect(roles.map((r) => r.tenantId).sort()).toEqual([f.tenantA, f.tenantB].sort());
        expect(res.body.permissions.length).toBeGreaterThan(40);
    });
});

describe('cross-tenant session reuse', () => {
    it('cannot switch a session into a tenant the account has no Person in', async () => {
        const { cookie } = await login(ACCOUNTS.adminA, TEST_PASSWORD);

        const res = await api('/api/auth/select-tenant', {
            method: 'POST',
            cookie,
            body: JSON.stringify({ tenantId: f.tenantB }),
        });

        // 403, not 404: tenant B exists, this account simply has no identity there.
        expect(res.status).toBe(403);

        // The session is unchanged and still scoped to tenant A.
        const after = await api<{ id: string }[]>('/api/persons', { cookie });

        expect(after.body.map((p) => p.id)).toContain(f.personA);
        expect(after.body.map((p) => p.id)).not.toContain(f.personB);
    });

    it('cannot reach tenant B\'s data by replaying tenant A\'s cookie against guessed ids', async () => {
        const { cookie } = await login(ACCOUNTS.adminA, TEST_PASSWORD);

        const attempts = await Promise.all([
            api(`/api/persons/${f.personB}`, { cookie }),
            api(`/api/sessions/${f.sessionB}/move`, {
                method: 'POST', cookie, body: JSON.stringify({ blockIndex: 4 }),
            }),
            api(`/api/sessions/${f.sessionB}/lock`, { method: 'POST', cookie, body: JSON.stringify({}) }),
            api(`/api/generations/${f.generationA.replace('-a', '-b')}/apply`, {
                method: 'POST', cookie, body: JSON.stringify({}),
            }),
        ]);

        for (const res of attempts) {
            expect(res.status).toBe(404);
        }

        // Tenant B's session was not touched.
        expect((await ownerDb.session.findUnique({ where: { id: f.sessionB } }))?.blockIndex).toBe(0);
        expect((await ownerDb.session.findUnique({ where: { id: f.sessionB } }))?.isLocked).toBe(false);
    });

    it('a multi-tenant account sees only the tenant it is currently switched into', async () => {
        const first = await login(ACCOUNTS.multi, TEST_PASSWORD, 'test-a');

        const inA = await api<{ id: string }[]>('/api/persons', { cookie: first.cookie });

        expect(inA.body.map((p) => p.id)).toContain(f.personMultiA);
        expect(inA.body.map((p) => p.id)).not.toContain(f.personMultiB);

        await api('/api/auth/select-tenant', {
            method: 'POST',
            cookie: first.cookie,
            body: JSON.stringify({ tenantId: f.tenantB }),
        });

        const inB = await api<{ id: string }[]>('/api/persons', { cookie: first.cookie });

        // Same cookie, different tenant — and crucially no leakage of A's rows.
        expect(inB.body.map((p) => p.id)).toContain(f.personMultiB);
        expect(inB.body.map((p) => p.id)).not.toContain(f.personMultiA);
        expect(inB.body.map((p) => p.id)).not.toContain(f.personA);
    });
});
