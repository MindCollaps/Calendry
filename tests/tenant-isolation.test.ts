import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, login } from './helpers/client';
import { ACCOUNTS, type Fixtures, TEST_PASSWORD, ownerDb, seed, teardown } from './helpers/seed';

/**
 * Tenant isolation, over real HTTP with real session cookies.
 *
 * These go through the whole stack — middleware, session resolver, withTenant,
 * PostgreSQL RLS — because the guarantee lives in the interaction between those
 * layers, not in any one of them.
 *
 * The central case is ID GUESSING: tenant B holds a valid session and asks for
 * tenant A's rows by their real ids. Nothing may come back.
 */
let f: Fixtures;
let cookieA: string;
let cookieB: string;

beforeAll(async () => {
    f = await seed();
    cookieA = (await login(ACCOUNTS.adminA, TEST_PASSWORD)).cookie;
    cookieB = (await login(ACCOUNTS.adminB, TEST_PASSWORD)).cookie;
}, 60_000);

afterAll(async () => {
    await teardown();
    await ownerDb.$disconnect();
});

describe('tenant isolation on reads', () => {
    it('lists only the calling tenant\'s people', async () => {
        const a = await api<{ id: string }[]>('/api/persons', { cookie: cookieA });
        const b = await api<{ id: string }[]>('/api/persons', { cookie: cookieB });

        expect(a.status).toBe(200);
        expect(b.status).toBe(200);

        const idsA = a.body.map((p) => p.id);
        const idsB = b.body.map((p) => p.id);

        expect(idsA).toContain(f.personA);
        expect(idsA).not.toContain(f.personB);
        expect(idsB).toContain(f.personB);
        expect(idsB).not.toContain(f.personA);
    });

    it('refuses a direct fetch of another tenant\'s row by guessed id', async () => {
        const stolen = await api(`/api/persons/${f.personA}`, { cookie: cookieB });

        expect(stolen.status).toBe(404);

        // Same id, correct tenant: proves the 404 is isolation, not a bad fixture.
        expect((await api(`/api/persons/${f.personA}`, { cookie: cookieA })).status).toBe(200);
    });

    it('hides another tenant\'s sessions but shares federation-owned rooms', async () => {
        const sessions = await api<{ id: string }[]>('/api/sessions', { cookie: cookieB });

        expect(sessions.body.map((s) => s.id)).toContain(f.sessionB);
        expect(sessions.body.map((s) => s.id)).not.toContain(f.sessionA);

        const rooms = await api<{ id: string }[]>('/api/rooms', { cookie: cookieB });

        expect(rooms.body.map((r) => r.id)).toContain(f.roomSharedFederation);
        expect(rooms.body.map((r) => r.id)).not.toContain(f.roomPrivateA);
    });

    it('rejects requests with no session', async () => {
        expect((await api('/api/persons')).status).toBe(401);
    });

    it('rejects a forged session token', async () => {
        const res = await api('/api/persons', { cookie: 'calendry_session=not-a-real-token' });

        expect(res.status).toBe(401);
    });
});

describe('tenant isolation on writes', () => {
    it('ignores a tenant_id in the request body and uses the session\'s tenant', async () => {
        const res = await api<{ tenantId: string }>('/api/persons', {
            method: 'POST',
            cookie: cookieB,
            body: JSON.stringify({
                givenName: 'Smuggled',
                familyName: 'Person',
                tenantId: f.tenantA, // attempted injection
            }),
        });

        expect(res.status).toBe(201);
        expect(res.body.tenantId).toBe(f.tenantB);

        await ownerDb.person.deleteMany({ where: { givenName: 'Smuggled' } });
    });

    it('cannot patch another tenant\'s row by guessed id', async () => {
        const res = await api(`/api/persons/${f.personA}`, {
            method: 'PATCH',
            cookie: cookieB,
            body: JSON.stringify({ familyName: 'Overwritten' }),
        });

        expect(res.status).toBe(404);
        expect((await ownerDb.person.findUnique({ where: { id: f.personA } }))?.familyName).toBe('Alpha');
    });

    it('cannot delete another tenant\'s row by guessed id', async () => {
        expect((await api(`/api/persons/${f.personA}`, { method: 'DELETE', cookie: cookieB })).status).toBe(404);
        expect(await ownerDb.person.findUnique({ where: { id: f.personA } })).not.toBeNull();
    });

    it('cannot move another tenant\'s session by guessed id', async () => {
        const res = await api(`/api/sessions/${f.sessionA}/move`, {
            method: 'POST',
            cookie: cookieB,
            body: JSON.stringify({ blockIndex: 5 }),
        });

        expect(res.status).toBe(404);
        expect((await ownerDb.session.findUnique({ where: { id: f.sessionA } }))?.blockIndex).toBe(0);
        // And no event was forged into tenant A's log.
        expect(await ownerDb.sessionEvent.count({ where: { sessionId: f.sessionA } })).toBe(0);
    });

    it('cannot swap across a tenant boundary', async () => {
        const res = await api(`/api/sessions/${f.sessionB}/swap`, {
            method: 'POST',
            cookie: cookieB,
            body: JSON.stringify({ withSessionId: f.sessionA }),
        });

        expect(res.status).toBe(404);

        const [a, b] = await Promise.all([
            ownerDb.session.findUnique({ where: { id: f.sessionA } }),
            ownerDb.session.findUnique({ where: { id: f.sessionB } }),
        ]);

        expect(a?.blockIndex).toBe(0);
        expect(b?.blockIndex).toBe(0);
    });
});

describe('domain behaviour within a tenant', () => {
    it('moves a session, appends exactly one event, and keeps it queryable', async () => {
        const res = await api<{ session: { blockIndex: number }; event: { type: string } }>(
            `/api/sessions/${f.sessionA}/move`,
            { method: 'POST', cookie: cookieA, body: JSON.stringify({ blockIndex: 3, reason: 'test move' }) },
        );

        expect(res.status).toBe(200);
        expect(res.body.session.blockIndex).toBe(3);
        expect(res.body.event.type).toBe('MOVE');

        const events = await ownerDb.sessionEvent.findMany({ where: { sessionId: f.sessionA } });

        expect(events).toHaveLength(1);
        expect(events[0]?.payload).toMatchObject({ from: { blockIndex: 0 }, to: { blockIndex: 3 } });
        // The acting Person is recorded from the session, not from the request.
        expect(events[0]?.actorPersonId).toBe(f.personA);
    });

    it('resolves the notification audience through the nested group tree', async () => {
        const res = await api<{ persons: { id: string }[]; resolvedGroupIds: string[] }>(
            `/api/schedule/affected-persons?session_id=${f.sessionA}`,
            { cookie: cookieA },
        );

        expect(res.status).toBe(200);
        expect(res.body.persons.map((p) => p.id)).toContain(f.personA);
        expect(res.body.resolvedGroupIds).toContain(f.groupSeminarA);
        // Descendants only — a seminar's session must not notify the whole cohort.
        expect(res.body.resolvedGroupIds).not.toContain(f.groupCohortA);
    });

    it('refuses to delete a group that still has children', async () => {
        const res = await api(`/api/groups/${f.groupCohortA}`, { method: 'DELETE', cookie: cookieA });

        expect(res.status).toBe(409);
        expect(await ownerDb.group.findUnique({ where: { id: f.groupCohortA } })).not.toBeNull();
    });

    it('rebuilds group_closure on reparent without the route touching it', async () => {
        const res = await api(`/api/groups/${f.groupSeminarA}`, {
            method: 'PATCH',
            cookie: cookieA,
            body: JSON.stringify({ parentGroupId: null }),
        });

        expect(res.status).toBe(200);

        const pairs = await ownerDb.groupClosure.findMany({ where: { descendantId: f.groupSeminarA } });

        expect(pairs).toHaveLength(1);
        expect(pairs[0]?.depth).toBe(0);
    });
});
