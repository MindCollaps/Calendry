import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
        // Isolation tests share one database and one server; running files in
        // parallel would let fixtures from one file race another's teardown.
        fileParallelism: false,
        hookTimeout: 60_000,
        testTimeout: 30_000,
    },
});
