import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ACCOUNTS, TEST_PASSWORD, ownerDb, seed, teardown } from './helpers/seed';
import { api, login } from './helpers/client';

/**
 * Named break overrides, end to end.
 *
 * The walk itself is unit-tested in `time-grid-breaks.test.ts`; this is about
 * the plumbing around it — that breaks survive a save, come back on read,
 * cannot be duplicated at one position, and are cleaned up rather than left
 * dangling when the grid shrinks under them.
 *
 * The dangling case is the interesting one, and the asymmetry is the design:
 * an orphaned SESSION refuses the shrink (it is data that resolves to no time
 * and breaks the solver), while an orphaned BREAK is deleted and reported (it
 * is configuration describing a gap between blocks that no longer exist).
 * Testing only one of those would leave the distinction unpinned.
 */
const GRID = 'test-grid-a';
const SESSION = 'test-session-a';

let cookie: string | null;

const breaksOf = (grid: unknown) => ((grid as { breaks?: unknown[] }).breaks ?? []) as {
    afterBlockIndex: number; durationMinutes: number; label: string; dayOfWeek: number | null;
}[];

beforeAll(async () => {
    await seed();
    ({ cookie } = await login(ACCOUNTS.adminA, TEST_PASSWORD));
});

beforeEach(async () => {
    await ownerDb.timeGridBreak.deleteMany({ where: { timeGridId: GRID } });
    await ownerDb.timeGrid.update({
        where: { id: GRID },
        data: { blocksPerDay: 8, activeDays: [1, 2, 3, 4, 5], blockLengthMinutes: 45, breakMinutes: 15 },
    });
    await ownerDb.session.update({ where: { id: SESSION }, data: { dayOfWeek: 2, blockIndex: 0, durationBlocks: 1 } });
});

afterAll(async () => {
    await teardown();
    await ownerDb.$disconnect();
});

describe('saving break overrides with the grid', () => {
    it('writes them atomically with the row and reads them back', async () => {
        const res = await api(`/api/time-grids/${GRID}`, {
            method: 'PATCH',
            cookie,
            body: JSON.stringify({
                breakMinutes: 10,
                breaks: [
                    { afterBlockIndex: 3, durationMinutes: 45, label: 'Lunch', dayOfWeek: null },
                    { afterBlockIndex: 6, durationMinutes: 30, label: 'Friday break', dayOfWeek: 5 },
                ],
            }),
        });

        expect(res.status).toBe(200);

        // Read through the API, not the database: the include is part of the
        // contract, and a grid whose breaks were saved but never returned would
        // render a timetable the tenant did not configure.
        const read = await api(`/api/time-grids/${GRID}`, { cookie });
        const rows = breaksOf(read.body).sort((a, b) => a.afterBlockIndex - b.afterBlockIndex);

        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({ afterBlockIndex: 3, durationMinutes: 45, label: 'Lunch', dayOfWeek: null });
        expect(rows[1]).toMatchObject({ afterBlockIndex: 6, durationMinutes: 30, dayOfWeek: 5 });

        // The column write landed too — the two halves are one transaction.
        expect((read.body as { breakMinutes: number }).breakMinutes).toBe(10);
    });

    it('replaces the whole set, so removing one removes it', async () => {
        const put = (breaks: unknown[]) => api(`/api/time-grids/${GRID}`, {
            method: 'PATCH', cookie, body: JSON.stringify({ breaks }),
        });

        await put([
            { afterBlockIndex: 3, durationMinutes: 45, label: 'Lunch', dayOfWeek: null },
            { afterBlockIndex: 6, durationMinutes: 30, label: 'Tea', dayOfWeek: null },
        ]);
        await put([{ afterBlockIndex: 3, durationMinutes: 45, label: 'Lunch', dayOfWeek: null }]);

        const read = await api(`/api/time-grids/${GRID}`, { cookie });

        expect(breaksOf(read.body).map((b) => b.label)).toEqual(['Lunch']);
    });

    it('lists breaks on the collection endpoint too, not only on the detail', async () => {
        await api(`/api/time-grids/${GRID}`, {
            method: 'PATCH', cookie,
            body: JSON.stringify({ breaks: [{ afterBlockIndex: 2, durationMinutes: 20, label: 'Tea', dayOfWeek: null }] }),
        });

        const list = await api<unknown[]>('/api/time-grids', { cookie });
        const grid = (list.body as { id: string }[]).find((g) => g.id === GRID);

        // The schedule page reads the LIST, so a detail-only include would make
        // every rendered block time wrong while the editor looked correct.
        expect(breaksOf(grid).map((b) => b.label)).toEqual(['Tea']);
    });
});

describe('the database refuses a duplicate override', () => {
    it('rejects two rows at the same position for the same day', async () => {
        // NULLS NOT DISTINCT, so two "all days" rows at block 3 collide rather
        // than both landing and letting the resolver pick one arbitrarily.
        await expect(ownerDb.timeGridBreak.createMany({
            data: [
                { timeGridId: GRID, tenantId: 'test-tenant-a', afterBlockIndex: 3, durationMinutes: 45, label: 'A', dayOfWeek: null },
                { timeGridId: GRID, tenantId: 'test-tenant-a', afterBlockIndex: 3, durationMinutes: 30, label: 'B', dayOfWeek: null },
            ],
        })).rejects.toThrow();
    });

    it('allows the same position on DIFFERENT days', async () => {
        // The counter-example: without it the test above passes against a unique
        // index that wrongly spans every day and makes per-day overrides
        // impossible — the entire point of the feature.
        await expect(ownerDb.timeGridBreak.createMany({
            data: [
                { timeGridId: GRID, tenantId: 'test-tenant-a', afterBlockIndex: 3, durationMinutes: 45, label: 'Universal', dayOfWeek: null },
                { timeGridId: GRID, tenantId: 'test-tenant-a', afterBlockIndex: 3, durationMinutes: 30, label: 'Friday', dayOfWeek: 5 },
            ],
        })).resolves.toBeTruthy();
    });
});

describe('shrinking a grid under its breaks', () => {
    async function withBreaks() {
        await api(`/api/time-grids/${GRID}`, {
            method: 'PATCH', cookie,
            body: JSON.stringify({
                breaks: [
                    { afterBlockIndex: 1, durationMinutes: 45, label: 'Keeper', dayOfWeek: null },
                    { afterBlockIndex: 6, durationMinutes: 30, label: 'Dangling', dayOfWeek: null },
                    { afterBlockIndex: 2, durationMinutes: 20, label: 'Friday only', dayOfWeek: 5 },
                ],
            }),
        });
    }

    it('deletes only the breaks the shrink orphaned, and keeps the rest', async () => {
        await withBreaks();

        // Narrowing to 4 blocks: block 6 no longer exists, block 1 still does.
        const res = await api(`/api/time-grids/${GRID}`, {
            method: 'PATCH', cookie, body: JSON.stringify({ blocksPerDay: 4 }),
        });

        expect(res.status).toBe(200);

        const read = await api(`/api/time-grids/${GRID}`, { cookie });

        expect(breaksOf(read.body).map((b) => b.label).sort()).toEqual(['Friday only', 'Keeper']);
    });

    it('deletes a break on a day that is no longer taught', async () => {
        await withBreaks();

        const res = await api(`/api/time-grids/${GRID}`, {
            method: 'PATCH', cookie, body: JSON.stringify({ activeDays: [1, 2, 3, 4] }),
        });

        expect(res.status).toBe(200);

        const read = await api(`/api/time-grids/${GRID}`, { cookie });

        expect(breaksOf(read.body).map((b) => b.label)).not.toContain('Friday only');
        expect(breaksOf(read.body).map((b) => b.label)).toContain('Keeper');
    });

    it('deletes NOTHING when the shrink is refused for orphaning a Session', async () => {
        // The two rules meet here. A Session at block 6 refuses the shrink, and
        // because the cascade runs in the SAME transaction, the break at block 6
        // must survive — a refusal that still destroyed configuration would be
        // the worst of both behaviours.
        await withBreaks();
        await ownerDb.session.update({ where: { id: SESSION }, data: { blockIndex: 6 } });

        const res = await api(`/api/time-grids/${GRID}`, {
            method: 'PATCH', cookie, body: JSON.stringify({ blocksPerDay: 4 }),
        });

        expect(res.status).toBe(409);

        const read = await api(`/api/time-grids/${GRID}`, { cookie });

        expect(breaksOf(read.body).map((b) => b.label).sort())
            .toEqual(['Dangling', 'Friday only', 'Keeper']);
        expect((read.body as { blocksPerDay: number }).blocksPerDay).toBe(8);
    });

    it('keeps every break when the grid WIDENS', async () => {
        await withBreaks();

        const res = await api(`/api/time-grids/${GRID}`, {
            method: 'PATCH', cookie, body: JSON.stringify({ blocksPerDay: 12 }),
        });

        expect(res.status).toBe(200);
        expect(breaksOf((await api(`/api/time-grids/${GRID}`, { cookie })).body)).toHaveLength(3);
    });
});
