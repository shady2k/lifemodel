import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // A suite started from a git hook inherits GIT_DIR and friends; no test may
    // act on that repository (lifemodel-q4x.4.2).
    setupFiles: ['tests/setup/scrub-git-env.ts'],
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
