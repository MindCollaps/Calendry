import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ACCOUNTS, TEST_PASSWORD, ownerDb, seed, teardown } from './helpers/seed';
import { api, login } from './helpers/client';

/**
 * A Session must always resolve to a real slot in its TimeGrid.
 *
 * WHY THIS IS REFUSED RATHER THAN WARNED. "Warn and allow" (TAXONOMY.md §3)
 * covers hard-CONSTRAINT violations, and its mechanism is `constraint_violation`
 * — a row keyed to a `constraint_id`. "Outside the grid" is not one of the 14
 * catalogue types and cannot become one, so there is nowhere to record such a
 * warning. It is not a worse schedule; it is a Session that resolves to no time.
 *
 * The cost of not having this guard was measured, not imagined: shrinking the
 * demo tenant's grid from 8 blocks to 4 orphaned 7 of 16 Sessions, the next
 * solver run failed 86 seconds later with INVALID_ARGUMENT, and nobody noticed
 * for two days because nothing between the edit and the solver looks at the grid.
 *
 * THE COUNTER-EXAMPLES ARE THE POINT. Three of the six cases below assert that
 * an edit SUCCEEDS. Without them this suite passes just as well against a guard
 * that refuses every TimeGrid update outright — which would look like working
 * protection and would make the grid uneditable.
 */
const GRID = 'test-grid-a';
const SESSION = 'test-session-a';

let cookie: string | null;

/** Places the fixture Session, so each case starts from a known slot. */
async function placeSession(dayOfWeek: number, blockIndex: number, durationBlocks = 1) {
    await ownerDb.session.update({
        where: { id: SESSION },
        data: { dayOfWeek, blockIndex, durationBlocks },
    });
}

async function gridNow() {
    return ownerDb.timeGrid.findFirstOrThrow({
        where: { id: GRID },
        select: { blocksPerDay: true, activeDays: true, blockLengthMinutes: true },
    });
}

beforeAll(async () => {
    await seed();
    ({ cookie } = await login(ACCOUNTS.adminA, TEST_PASSWORD));
});

beforeEach(async () => {
    // The fixture grid is 8 blocks over days 1-5. Restore it, because these
    // cases deliberately try to change it.
    await ownerDb.timeGrid.update({
        where: { id: GRID },
        data: { blocksPerDay: 8, activeDays: [1, 2, 3, 4, 5], blockLengthMinutes: 45 },
    });
    await placeSession(2, 0);
});

afterAll(async () => {
    await teardown();
    await ownerDb.$disconnect();
});

describe('narrowing a TimeGrid', () => {
    it('is refused when a Session would fall outside it, and writes nothing', async () => {
        await placeSession(2, 6);

        const res = await api(`/api/time-grids/${GRID}`, {
            method: 'PATCH',
            cookie,
            body: JSON.stringify({ blocksPerDay: 4 }),
        });

        expect(res.status).toBe(409);
        // Names the offender, so the message is actionable rather than a count.
        expect(JSON.stringify(res.body)).toContain('Databases');
        expect(JSON.stringify(res.body)).toContain('1 existing Session');

        // The refusal must leave the grid untouched — a 409 that half-applied
        // would be worse than no guard at all.
        expect((await gridNow()).blocksPerDay).toBe(8);
    });

    it('is refused when a Session sits on a day being removed', async () => {
        // The second dimension of the index space. A guard that only checked
        // blocksPerDay would pass every other case in this file.
        await placeSession(5, 0);

        const res = await api(`/api/time-grids/${GRID}`, {
            method: 'PATCH',
            cookie,
            body: JSON.stringify({ activeDays: [1, 2, 3, 4] }),
        });

        expect(res.status).toBe(409);
        expect((await gridNow()).activeDays).toEqual([1, 2, 3, 4, 5]);
    });

    it('accounts for duration, not just the start block', async () => {
        // Starts inside a 4-block day, ends outside it. Checking `blockIndex`
        // alone would wrongly allow this.
        await placeSession(2, 3, 2);

        const res = await api(`/api/time-grids/${GRID}`, {
            method: 'PATCH',
            cookie,
            body: JSON.stringify({ blocksPerDay: 4 }),
        });

        expect(res.status).toBe(409);
        expect((await gridNow()).blocksPerDay).toBe(8);
    });

    it('SUCCEEDS when no Session is affected', async () => {
        // Counter-example 1. The Session is at block 0, so a 4-block day still
        // holds it. A guard that refused every narrowing would fail here.
        await placeSession(2, 0);

        const res = await api(`/api/time-grids/${GRID}`, {
            method: 'PATCH',
            cookie,
            body: JSON.stringify({ blocksPerDay: 4 }),
        });

        expect(res.status).toBe(200);
        expect((await gridNow()).blocksPerDay).toBe(4);
    });
});

describe('edits that cannot orphan anything', () => {
    it('SUCCEEDS when widening, even with a Session at the old edge', async () => {
        // Counter-example 2. Widening is always safe and must not pay for a
        // query, let alone be refused.
        await placeSession(2, 6);

        const res = await api(`/api/time-grids/${GRID}`, {
            method: 'PATCH',
            cookie,
            body: JSON.stringify({ blocksPerDay: 12 }),
        });

        expect(res.status).toBe(200);
        expect((await gridNow()).blocksPerDay).toBe(12);
    });

    it('SUCCEEDS when changing block LENGTH with an out-of-range Session present', async () => {
        // Counter-example 3, and the sharpest one. `blockLengthMinutes` moves
        // what a block is CALLED on a clock; it cannot orphan anything, because
        // the index space is blocksPerDay x activeDays. A guard keyed on "any
        // TimeGrid edit" would reject this, and would be wrong.
        //
        // The Session is deliberately placed at block 6 — outside a 4-block day
        // — to prove the check is scoped to the index space rather than simply
        // finding nothing to complain about.
        await placeSession(2, 6);

        const res = await api(`/api/time-grids/${GRID}`, {
            method: 'PATCH',
            cookie,
            body: JSON.stringify({ blockLengthMinutes: 90 }),
        });

        expect(res.status).toBe(200);
        expect((await gridNow()).blockLengthMinutes).toBe(90);
    });
});

describe('moving a Session out of its grid', () => {
    it('is refused, and the Session does not move', async () => {
        // The other half of the same defect. zod cannot catch this: blockIndex
        // has no upper bound it could know, and dayOfWeek is 1..7 regardless of
        // which days the tenant teaches.
        const res = await api(`/api/sessions/${SESSION}/move`, {
            method: 'POST',
            cookie,
            body: JSON.stringify({ blockIndex: 9 }),
        });

        expect(res.status).toBe(409);

        const after = await ownerDb.session.findFirstOrThrow({ where: { id: SESSION } });

        expect(after.blockIndex).toBe(0);
    });

    it('is refused for a day the grid does not teach', async () => {
        const res = await api(`/api/sessions/${SESSION}/move`, {
            method: 'POST',
            cookie,
            body: JSON.stringify({ dayOfWeek: 6 }),
        });

        expect(res.status).toBe(409);
        expect((await ownerDb.session.findFirstOrThrow({ where: { id: SESSION } })).dayOfWeek).toBe(2);
    });

    it('SUCCEEDS for a slot inside the grid', async () => {
        // Counter-example 4. Without this, every assertion above passes against
        // a move route that rejects all moves.
        const res = await api(`/api/sessions/${SESSION}/move`, {
            method: 'POST',
            cookie,
            body: JSON.stringify({ dayOfWeek: 3, blockIndex: 5 }),
        });

        expect(res.status).toBe(200);

        const after = await ownerDb.session.findFirstOrThrow({ where: { id: SESSION } });

        expect([after.dayOfWeek, after.blockIndex]).toEqual([3, 5]);
    });
});
