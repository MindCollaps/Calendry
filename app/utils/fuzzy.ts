/**
 * Subsequence fuzzy matching for the command palette.
 *
 * Hand-rolled rather than pulled in: the whole job is ~60 lines, the corpus is
 * a few dozen nav entries, and a dependency here would be more code than the
 * thing it replaces.
 *
 * The scoring is what separates a useful palette from a frustrating one. Typing
 * "rm" should rank "Rooms" above "Terms" even though both contain r and m —
 * so matches at word starts and matches in contiguous runs are worth far more
 * than bare subsequence hits.
 */
export interface FuzzyResult {
    score: number;
    /** Indices in the ORIGINAL string that matched, for highlighting. */
    indices: number[];
}

const WORD_SEPARATORS = new Set([' ', '-', '_', '/', '.', ':']);

/**
 * Greedy left-to-right subsequence match. Returns null when `text` does not
 * contain `query` as a subsequence at all.
 */
export function fuzzyMatch(query: string, text: string): FuzzyResult | null {
    if (!query) {
        return { score: 0, indices: [] };
    }

    const needle = query.toLowerCase();
    const haystack = text.toLowerCase();
    const indices: number[] = [];

    let score = 0;
    let cursor = 0;
    let previousMatch = -2;

    for (const char of needle) {
        // Spaces in the query are separators, not characters to find: "man ro"
        // should match "Manage rooms" without requiring the literal space.
        if (char === ' ') {
            continue;
        }

        const found = haystack.indexOf(char, cursor);

        if (found === -1) {
            return null;
        }

        const atStart = found === 0;
        const afterSeparator = found > 0 && WORD_SEPARATORS.has(haystack[found - 1] as string);
        const contiguous = found === previousMatch + 1;

        score += 1;

        if (atStart) {
            score += 12;
        } else if (afterSeparator) {
            score += 8;
        }

        if (contiguous) {
            score += 5;
        } else if (previousMatch >= 0) {
            // A large jump means the match is scattered; mild penalty, floored
            // so a long label is not ruled out entirely.
            score -= Math.min(3, (found - previousMatch - 1) * 0.4);
        }

        indices.push(found);
        previousMatch = found;
        cursor = found + 1;
    }

    // Whole-string and prefix matches are almost always what was meant.
    if (haystack === needle) {
        score += 40;
    } else if (haystack.startsWith(needle)) {
        score += 20;
    }

    // Gentle preference for shorter targets: "Rooms" over "Meeting rooms list".
    score -= haystack.length * 0.05;

    return { score, indices };
}

/**
 * Best score for a query against a labelled item with secondary search terms.
 *
 * The label is weighted above keywords so that a hit on the visible text always
 * outranks a hit on an invisible synonym — a result whose reason for appearing
 * is not on screen reads as a bug.
 */
export function fuzzyScoreEntry(query: string, label: string, keywords: string[]): FuzzyResult | null {
    const onLabel = fuzzyMatch(query, label);

    let best: FuzzyResult | null = onLabel;

    for (const keyword of keywords) {
        const hit = fuzzyMatch(query, keyword);

        if (!hit) {
            continue;
        }

        // Keyword hits carry no highlight indices: they index into the keyword,
        // not the label, and painting them onto the label would highlight the
        // wrong characters.
        const demoted: FuzzyResult = { score: hit.score - 15, indices: onLabel?.indices ?? [] };

        if (!best || demoted.score > best.score) {
            best = demoted;
        }
    }

    return best;
}

/** Splits a label into highlighted / plain runs for rendering. */
export function highlightRuns(text: string, indices: number[]): { text: string; match: boolean }[] {
    if (!indices.length) {
        return [{ text, match: false }];
    }

    const marked = new Set(indices);
    const runs: { text: string; match: boolean }[] = [];

    for (let i = 0; i < text.length; i++) {
        const match = marked.has(i);
        const last = runs[runs.length - 1];

        if (last && last.match === match) {
            last.text += text[i];
        } else {
            runs.push({ text: text[i] as string, match });
        }
    }

    return runs;
}
