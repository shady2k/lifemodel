/**
 * Every test runs git in a repository of its own, never in the one whose hook
 * started the suite (lifemodel-q4x.4.2).
 *
 * A git hook runs with GIT_DIR, GIT_INDEX_FILE and (in a worktree)
 * GIT_WORK_TREE/GIT_COMMON_DIR set, and those win over the directory a command
 * runs in. A test that does `git init && git commit` in a temporary directory
 * would act on the real repository instead: on 2026-10-09 a pre-commit hook
 * that ran the suite put fixture commits on a feature branch and rewrote
 * .git/config. The setup file below removes them all before any test runs, so
 * every child process a test starts inherits a clean environment.
 */

/** The names of the git variables in an environment. */
export function gitVariables(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter((name) => name.startsWith('GIT_'));
}

/** Remove every GIT_* variable from `env`, in place; returns what was removed. */
export function scrubGitEnvironment(env: NodeJS.ProcessEnv): string[] {
  const removed = gitVariables(env);
  for (const name of removed) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the names are read from the object itself
    delete env[name];
  }
  return removed;
}
