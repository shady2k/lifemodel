import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { TestStoreFinalizer } from './tests/setup/test-store-finalizer.js';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./web/app/src', import.meta.url)),
      '@kit': fileURLToPath(new URL('./web/kit', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    // A suite started from a git hook inherits GIT_DIR and friends; no test may
    // act on that repository (lifemodel-q4x.4.2). A file's databases are dropped
    // by its own afterAll (test-store-cleanup.ts), a failed file's by the
    // reporter below, and the run fails if one survives the run
    // (global-test-store-audit.ts): one full-schema database left per file
    // filled the 512 MiB store volume (lifemodel-653.7.10).
    setupFiles: ['tests/setup/scrub-git-env.ts', 'tests/setup/test-store-cleanup.ts'],
    globalSetup: ['tests/setup/global-test-store-audit.ts'],
    reporters: ['default', new TestStoreFinalizer()],
    // Defense in depth (lifemodel-q4x.5.2): the isolated launcher enforces
    // --maxWorkers=2 on every suite run; this caps any suite that starts
    // without the flag. This machine has memory for at most 2 workers, and
    // only one vitest process runs at a time (docs/backlog-integration.md).
    maxWorkers: 2,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
