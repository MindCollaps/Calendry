import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Vitest runs OUTSIDE Nuxt, so Nuxt's own aliases do not exist here.
 *
 * `#shared` is the one that matters: `shared/constraintTypes.ts` is imported by
 * the app, by the Nitro server, and now by tests. Without this alias the server
 * modules under test fail to resolve it — and the failure is at import time, so
 * it reads as "cannot find module" rather than anything to do with the code
 * being tested.
 *
 * Kept minimal on purpose: the four integration suites drive a real Nuxt server
 * over HTTP and need nothing from this file.
 */
export default defineConfig({
    test: {
        /**
         * Scoped to this repo's own tests. Adding a config file changed the
         * effective include and swept in `.impeccable/` — a vendored git
         * submodule whose 93 test files are somebody else's project and which
         * promptly failed against this repo's environment.
         */
        include: ['tests/**/*.test.ts'],

        /**
         * The four integration suites share ONE set of fixture ids
         * (tests/helpers/seed.ts) and each `beforeAll` tears down and re-seeds
         * them. Run in parallel they race: two suites seed at once and the
         * second gets "Unique constraint failed on the fields: (`id`)".
         *
         * This was always true and had simply not been observed — adding this
         * config file changed the scheduling enough to surface it consistently.
         * The alternative fix is per-suite fixture ids, which is a larger change
         * to code that is currently correct; serializing is honest about what
         * the suites actually require of each other.
         *
         * The pure suites (solver-calendar, constraint-catalogue) touch no
         * database and would be safe either way.
         */
        fileParallelism: false,
    },
    resolve: {
        alias: {
            '#shared': fileURLToPath(new URL('./shared', import.meta.url)),
        },
    },
});
