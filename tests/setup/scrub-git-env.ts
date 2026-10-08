/**
 * Runs before every test file (vitest.config.ts setupFiles): no test may reach
 * the repository named by an inherited GIT_DIR (tests/helpers/git-isolation.ts).
 */
import { scrubGitEnvironment } from '../helpers/git-isolation.js';

scrubGitEnvironment(process.env);
