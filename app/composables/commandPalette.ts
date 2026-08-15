import type { ComputedRef, Ref } from 'vue';
import type { NavSection, ResolvedNavEntry } from '~/composables/navigation';
import { NAV_SECTION_LABELS, useNavEntries } from '~/composables/navigation';
import { useOverlay } from '~/composables/overlay';
import { fuzzyScoreEntry, highlightRuns } from '~/utils/fuzzy';

export interface PaletteResult {
    entry: ResolvedNavEntry;
    section: NavSection;
    sectionLabel: string;
    /** Label split into matched / unmatched runs, ready to render. */
    runs: { text: string; match: boolean }[];
    /** True for the first result of its section, so the list can print a header. */
    startsSection: boolean;
}

/**
 * The Ctrl+K palette's interaction machine.
 *
 * OWNERSHIP BOUNDARY: open state, the query, which result is highlighted, and
 * what activating one does. It does NOT decide what exists or who may see it —
 * that is `useNavEntries()`, whose output is already permission-filtered.
 *
 * That distinction is the security-relevant part: this file has no permission
 * logic to get wrong, because it never sees an entry the caller cannot open.
 *
 * Call once, from the single mounted CommandPalette component.
 */
export function useCommandPalette() {
    const entries = useNavEntries();
    const { claim, release } = useOverlay('command-palette');

    const open = useState('calendry.palette.open', () => false);
    const query = useState('calendry.palette.query', () => '');
    const highlighted = useState('calendry.palette.highlighted', () => 0);

    const results: ComputedRef<PaletteResult[]> = computed(() => {
        const term = query.value.trim();

        const scored = entries.value
            .map((entry) => {
                const hit = fuzzyScoreEntry(term, entry.label, entry.keywords);

                return hit ? { entry, score: hit.score, indices: hit.indices } : null;
            })
            .filter((row): row is { entry: ResolvedNavEntry; score: number; indices: number[] } => row !== null);

        // With no query the registry order is the meaningful one (Home,
        // Schedule, Manage, sections, account). Sorting by a zero score would
        // scramble it into alphabetical noise.
        const ordered = term
            ? scored.sort((a, b) => b.score - a.score || a.entry.label.localeCompare(b.entry.label))
            : scored;

        // Group headers are computed here rather than in the template so the
        // flat index used for keyboard navigation stays the rendered order.
        let previousSection: NavSection | null = null;

        return ordered.map((row) => {
            const startsSection = row.entry.section !== previousSection;

            previousSection = row.entry.section;

            return {
                entry: row.entry,
                section: row.entry.section,
                sectionLabel: NAV_SECTION_LABELS[row.entry.section],
                runs: highlightRuns(row.entry.label, row.indices),
                startsSection,
            };
        });
    });

    // A shrinking result list must never leave the highlight past the end —
    // Enter would then activate nothing and look like a dead key.
    watch(results, (rows) => {
        if (highlighted.value >= rows.length) {
            highlighted.value = Math.max(0, rows.length - 1);
        }
    });

    /**
     * The keyboard claim follows the OPEN STATE, not the function that changed
     * it. `open` is shared state, so the header's search button flips it
     * directly without going through `openPalette` — hanging claim/release off
     * the functions would leave that path unclaimed, and Escape on /schedule
     * would silently cancel a placement while the palette was open. Watching the
     * state means every opener is correct by construction.
     */
    watch(open, (isOpen) => {
        if (isOpen) {
            query.value = '';
            highlighted.value = 0;
            claim();
        } else {
            release();
        }
    }, { immediate: true });

    function openPalette() {
        open.value = true;
    }

    function closePalette() {
        open.value = false;
    }

    function toggle() {
        if (open.value) closePalette();
        else openPalette();
    }

    function move(delta: number) {
        const count = results.value.length;

        if (count === 0) {
            return;
        }

        // Wraps, so ↑ from the top lands on the last result.
        highlighted.value = (highlighted.value + delta + count) % count;
    }

    async function activate(index = highlighted.value) {
        const result = results.value[index];

        if (!result) {
            return;
        }

        // Closing first: `run` may navigate or tear down the session, and an
        // overlay still claiming the keyboard through that is how a stuck claim
        // happens.
        closePalette();

        if (result.entry.run) {
            await result.entry.run();
        } else if (result.entry.to) {
            await navigateTo(result.entry.to);
        }
    }

    function onKey(event: KeyboardEvent) {
        const isToggle = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k';

        if (isToggle) {
            event.preventDefault();
            toggle();

            return;
        }

        if (!open.value) {
            return;
        }

        switch (event.key) {
            case 'Escape':
                event.preventDefault();
                closePalette();
                break;
            case 'ArrowDown':
                event.preventDefault();
                move(1);
                break;
            case 'ArrowUp':
                event.preventDefault();
                move(-1);
                break;
            case 'Enter':
                event.preventDefault();
                void activate();
                break;
            default:
                break;
        }
    }

    onMounted(() => window.addEventListener('keydown', onKey));
    onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

    return {
        open: open as Ref<boolean>,
        query: query as Ref<string>,
        highlighted: highlighted as Ref<number>,
        results,
        openPalette,
        closePalette,
        move,
        activate,
    };
}
