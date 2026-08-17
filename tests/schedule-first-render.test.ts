import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTS, type Fixtures, TEST_PASSWORD, ownerDb, seed, teardown } from './helpers/seed';
import { login } from './helpers/client';

/**
 * What the SERVER actually renders for /schedule.
 *
 * WHY THIS SUITE EXISTS. This project has now been bitten four times by the same
 * shape: state seeded by a watcher is `undefined` at first render on the server,
 * because Vue does not flush watchers during SSR. Each time the symptom differed
 * — empty management forms, a `<select>` showing the wrong option, a hidden
 * solver control — and each time it survived review because the check asked
 * whether something EXISTED rather than what it SAID.
 *
 * The fourth was the worst: `totalWeeks` fell back to 1 on the server, so the
 * week stepper rendered `disabled="true"`. Vue patches mismatched TEXT on
 * hydration but explicitly refuses to patch mismatched ATTRIBUTES — "this
 * mismatch is check-only. The DOM will not be rectified" — so the buttons stayed
 * disabled in the live DOM and week navigation was dead on every load, while the
 * label beside them correctly read "Week 1 / 19".
 *
 * So these assertions read the markup's CONTENT: the number in the label, and
 * the absence of an attribute. A test that only checked the buttons were present
 * would have passed throughout.
 */
let f: Fixtures;
let cookie: string;

const BASE = process.env.TEST_BASE_URL ?? 'http://localhost:8080';

async function renderSchedule(): Promise<string> {
    const res = await fetch(`${BASE}/schedule`, { headers: { cookie } });

    expect(res.status).toBe(200);

    return res.text();
}

/** The `<button …>` open tag carrying this aria-label, attributes included. */
function buttonTag(html: string, ariaLabel: string): string {
    const match = html.match(new RegExp(`<button[^>]*aria-label="${ariaLabel}"[^>]*>`))
        ?? html.match(new RegExp(`<button[^>]*aria-label='${ariaLabel}'[^>]*>`));

    expect(match, `no <button> with aria-label="${ariaLabel}" in the rendered page`).not.toBeNull();

    return match![0];
}

beforeAll(async () => {
    f = await seed();
    cookie = (await login(ACCOUNTS.adminA, TEST_PASSWORD)).cookie;
}, 60_000);

afterAll(async () => {
    await teardown();
    await ownerDb.$disconnect();
});

describe('/schedule first render', () => {
    it('renders the real week count, not the fallback of 1', async () => {
        const html = await renderSchedule();

        // The fixture term spans October to February — many weeks, never one.
        const label = html.match(/Week\s*1<[^>]*>\s*\/\s*(\d+)/)
            ?? html.match(/\/\s*(\d+)\s*<\/span>/);

        expect(label, 'no "Week 1 / N" label in the rendered page').not.toBeNull();

        const totalWeeks = Number(label![1]);

        // The assertion that matters: 1 is what a null term falls back to, and
        // it is what made the stepper render itself disabled.
        expect(totalWeeks).toBeGreaterThan(1);
    });

    it('does NOT render the next-week button as disabled', async () => {
        const html = await renderSchedule();

        // Vue will not rectify this attribute on hydration, so whatever the
        // server writes here is what the user is stuck with.
        expect(buttonTag(html, 'Next week')).not.toContain('disabled');
    });

    it('does render the previous-week button as disabled on week 1', async () => {
        const html = await renderSchedule();

        // The counter-example, so the test above cannot pass by the buttons
        // simply never being disabled: at week 1, going back IS unavailable.
        expect(buttonTag(html, 'Previous week')).toContain('disabled');
    });

    it('names the selected term in the toolbar rather than falling back', async () => {
        const html = await renderSchedule();

        // Same class of bug, different symptom: `<select>` needs :selected on
        // its options because `value` is a property SSR drops.
        expect(html).toContain('selected');
        expect(html).toContain(f.termA);
    });
});
