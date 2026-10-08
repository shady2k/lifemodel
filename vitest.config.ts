import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // A suite started from a git hook inherits GIT_DIR and friends; no test may
    // act on that repository (lifemodel-q4x.4.2).
    setupFiles: ['tests/setup/scrub-git-env.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
