import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MANAGE_ENTITIES } from '../app/utils/manageRegistry';

/**
 * Every Iconify name the app uses must resolve in an INSTALLED collection.
 *
 * WHY THIS EXISTS. A wrong icon name is the project's favourite failure shape:
 * it renders nothing, logs nothing, throws nothing, and the only symptom is a
 * blank space somebody notices weeks later and reports as a missing feature.
 * That is exactly what happened — `material-symbols:rule-outline` does not
 * exist, so the Constraints entry in the sidebar rendered its label with no
 * glyph and was read as "the constraints section isn't there".
 *
 * Two distinct ways to be wrong, both caught here:
 *
 *   1. the name is not in the collection (`rule-outline`)
 *   2. the COLLECTION is not installed at all (`svg-spinners:ring-resize`,
 *      which shipped in the Stage 6b solver control and never rendered)
 *
 * Scanning the source rather than importing the registry is deliberate: icons
 * are also written inline in component templates, and those are where a typo is
 * least likely to be noticed. Anything matching `<collection>:<name>` inside a
 * quoted string in `app/` is checked.
 */
const APP_DIR = join(import.meta.dirname, '..', 'app');

/** Collections we can validate against, loaded from node_modules. */
function loadCollection(prefix: string): { icons: Record<string, unknown>; aliases?: Record<string, unknown> } | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require(`@iconify-json/${prefix}/icons.json`);
    } catch {
        return null;
    }
}

function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);

        if (statSync(full).isDirectory()) {
            sourceFiles(full, out);
        } else if (/\.(vue|ts)$/.test(entry)) {
            out.push(full);
        }
    }

    return out;
}

/**
 * Icon references found in source.
 *
 * The pattern is deliberately narrow — a quoted `prefix:name` where both halves
 * are lowercase-kebab — so it does not sweep up URLs, times, or CSS values.
 */
function usedIcons(): Map<string, string[]> {
    const found = new Map<string, string[]>();

    for (const file of sourceFiles(APP_DIR)) {
        const text = readFileSync(file, 'utf8');

        for (const match of text.matchAll(/["']([a-z][a-z0-9-]*:[a-z][a-z0-9-]*)["']/g)) {
            const name = match[1]!;

            // Only names whose prefix looks like an Iconify collection we could
            // plausibly have installed; this keeps `http:` style noise out.
            if (!/^(material-symbols|svg-spinners|mdi|heroicons|lucide|ph|tabler|carbon|simple-icons):/.test(name)) {
                continue;
            }

            found.set(name, [...(found.get(name) ?? []), file.replace(APP_DIR, 'app')]);
        }
    }

    return found;
}

describe('icon names', () => {
    it('finds icon references to check (the scan itself works)', () => {
        // Guard the guard: a regex that matched nothing would make every
        // assertion below pass vacuously — the exact failure this suite exists
        // to prevent.
        expect(usedIcons().size).toBeGreaterThan(20);
    });

    it('every icon used in app/ resolves in an installed collection', () => {
        const collections = new Map<string, ReturnType<typeof loadCollection>>();
        const broken: string[] = [];

        for (const [icon, files] of usedIcons()) {
            const [prefix, name] = icon.split(':') as [string, string];

            if (!collections.has(prefix)) {
                collections.set(prefix, loadCollection(prefix));
            }

            const collection = collections.get(prefix);

            if (!collection) {
                broken.push(`${icon} — @iconify-json/${prefix} is not installed (used in ${files[0]})`);

                continue;
            }

            if (!collection.icons[name] && !collection.aliases?.[name]) {
                broken.push(`${icon} — not in the collection (used in ${files[0]})`);
            }
        }

        expect(broken, `\n  ${broken.join('\n  ')}\n`).toEqual([]);
    });

    it('every MANAGE_ENTITIES icon resolves', () => {
        // The registry specifically, because these drive the sidebar, the
        // /manage index and the Ctrl+K palette from one array.
        const collection = loadCollection('material-symbols');

        expect(collection, '@iconify-json/material-symbols must be installed').not.toBeNull();

        const broken = MANAGE_ENTITIES
            .filter((entity) => {
                const [prefix, name] = entity.icon.split(':') as [string, string];

                return prefix !== 'material-symbols'
                    || (!collection!.icons[name] && !collection!.aliases?.[name]);
            })
            .map((entity) => `${entity.key} → ${entity.icon}`);

        expect(broken, `\n  ${broken.join('\n  ')}\n`).toEqual([]);
    });
});
