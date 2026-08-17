import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Fixtures, ownerDb, seed, teardown } from './helpers/seed';

/**
 * The append-only history guard, and the ONE mutation it must let through.
 *
 * `session_event.session_id` is `ON DELETE SET NULL` so that an event outlives
 * the Session it describes (the schema says so in as many words: "Nullable so a
 * DELETE event survives its Session being removed"). But the FK action is an
 * UPDATE, and `deny_mutation()` used to refuse every UPDATE — so deleting a
 * Session that had ever been created, moved, swapped or locked was impossible.
 *
 * Nothing had ever deleted a Session, so nothing had ever found out. Stage 5's
 * `materializeGeneration()` removes placements the solver declined to make, and
 * hit it immediately.
 *
 * These tests pin both halves: the detach is permitted, and every other way of
 * touching the log is still refused. The second half is the one that matters —
 * a fix that merely made the error go away would also make the history
 * rewritable, and no existing test would have noticed.
 */
let f: Fixtures;
let eventId: string;
let subjectId: string;
let counterpartId: string;
let n = 0;

/**
 * A throwaway Session in tenant A, reusing the fixture's term/offering/grid.
 *
 * Each test gets its own rather than sharing `f.sessionA`: one of them deletes
 * its subject outright, which is the whole point of the suite, and a shared
 * fixture would leave every later test referencing a row that no longer exists.
 */
async function makeSession(): Promise<string> {
    const created = await ownerDb.session.create({
        data: {
            id: `test-session-ao-${n++}`,
            tenantId: f.tenantA,
            offeringId: 'test-offering-a',
            termId: f.termA,
            kindId: 'test-kind-a',
            timeGridId: 'test-grid-a',
            generationId: f.generationA,
            termWeek: 1,
            dayOfWeek: 3,
            blockIndex: 4,
        },
        select: { id: true },
    });

    return created.id;
}

/** A fresh event each time: the permitted cases mutate the row they act on. */
async function makeEvent(): Promise<string> {
    const created = await ownerDb.sessionEvent.create({
        data: {
            tenantId: f.tenantA,
            generationId: f.generationA,
            type: 'MOVE',
            sessionId: subjectId,
            counterpartSessionId: counterpartId,
            payload: { from: { blockIndex: 0 }, to: { blockIndex: 2 } },
            reason: 'fixture',
        },
        select: { id: true },
    });

    return created.id;
}

beforeAll(async () => {
    f = await seed();
}, 60_000);

beforeEach(async () => {
    subjectId = await makeSession();
    counterpartId = await makeSession();
    eventId = await makeEvent();
});

afterAll(async () => {
    await teardown();
    await ownerDb.$disconnect();
});

describe('session_event permits exactly the FK detach', () => {
    it('allows session_id to be cleared, leaving every other column identical', async () => {
        const before = await ownerDb.sessionEvent.findUniqueOrThrow({ where: { id: eventId } });

        await ownerDb.$executeRawUnsafe(
            'UPDATE session_event SET session_id = NULL WHERE id = $1', eventId,
        );

        const after = await ownerDb.sessionEvent.findUniqueOrThrow({ where: { id: eventId } });

        expect(after.sessionId).toBeNull();

        // Byte-identical everywhere else. Compared as whole records with
        // session_id normalised, so a column added later is covered without
        // anyone remembering to extend this list.
        expect({ ...after, sessionId: null }).toEqual({ ...before, sessionId: null });
    });

    it('allows the counterpart column to be cleared independently', async () => {
        await ownerDb.$executeRawUnsafe(
            'UPDATE session_event SET counterpart_session_id = NULL WHERE id = $1', eventId,
        );

        const after = await ownerDb.sessionEvent.findUniqueOrThrow({ where: { id: eventId } });

        expect(after.counterpartSessionId).toBeNull();
        // The other pointer is untouched: two FKs, two independent detaches.
        expect(after.sessionId).toBe(subjectId);
    });

    it('lets a Session with history be deleted, and the event survives it', async () => {
        // The whole point. This raised `session_event is append-only` before.
        await ownerDb.$executeRawUnsafe('DELETE FROM session WHERE id = $1', subjectId);

        const after = await ownerDb.sessionEvent.findUniqueOrThrow({ where: { id: eventId } });

        expect(after.sessionId).toBeNull();
        // Detached, not deleted — the audit trail is what the log is for.
        expect(after.type).toBe('MOVE');
        expect(after.payload).toEqual({ from: { blockIndex: 0 }, to: { blockIndex: 2 } });
    });
});

describe('session_event refuses every other mutation', () => {
    const appendOnly = /append-only/;

    it('refuses a payload rewrite', async () => {
        await expect(ownerDb.$executeRawUnsafe(
            `UPDATE session_event SET payload = '{"tampered":true}' WHERE id = $1`, eventId,
        )).rejects.toThrow(appendOnly);
    });

    it('refuses a change of event type', async () => {
        await expect(ownerDb.$executeRawUnsafe(
            `UPDATE session_event SET type = 'DELETE' WHERE id = $1`, eventId,
        )).rejects.toThrow(appendOnly);
    });

    it('refuses a change of reason or actor', async () => {
        await expect(ownerDb.$executeRawUnsafe(
            `UPDATE session_event SET reason = 'rewritten' WHERE id = $1`, eventId,
        )).rejects.toThrow(appendOnly);
    });

    it('refuses a detach smuggled in alongside another column', async () => {
        // The exact shape a narrow guard could get wrong: it IS a detach, but
        // it is not ONLY a detach.
        await expect(ownerDb.$executeRawUnsafe(
            `UPDATE session_event SET session_id = NULL, payload = '{"x":1}' WHERE id = $1`, eventId,
        )).rejects.toThrow(appendOnly);
    });

    it('refuses REPOINTING session_id at a different Session rather than clearing it', async () => {
        // Clearing a dead pointer is bookkeeping; aiming it at a live Session
        // rewrites what the event claims happened.
        await expect(ownerDb.$executeRawUnsafe(
            'UPDATE session_event SET session_id = $2 WHERE id = $1', eventId, counterpartId,
        )).rejects.toThrow(appendOnly);
    });

    it('refuses a no-op UPDATE that detaches nothing', async () => {
        await expect(ownerDb.$executeRawUnsafe(
            'UPDATE session_event SET session_id = session_id WHERE id = $1', eventId,
        )).rejects.toThrow(appendOnly);
    });

    it('refuses DELETE of an event unconditionally', async () => {
        await expect(ownerDb.$executeRawUnsafe(
            'DELETE FROM session_event WHERE id = $1', eventId,
        )).rejects.toThrow(appendOnly);
    });

    it('still refuses deleting a Generation, which shares the same function', async () => {
        await expect(ownerDb.$executeRawUnsafe(
            'DELETE FROM generation WHERE id = $1', f.generationA,
        )).rejects.toThrow(appendOnly);
    });
});
