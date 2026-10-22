import type { ChildProcess } from 'node:child_process';

/**
 * SIGKILL a child and every process it started (lifemodel-653.7.10).
 *
 * The test cores are started through `tsx`, which runs the core in a child of
 * its own: killing the `tsx` process alone leaves the core alive, holding its
 * Postgres connections, so the file's database cannot be dropped without
 * terminating sessions. The child must be spawned with `detached: true` to lead
 * its own process group.
 */
export function killProcessGroup(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (!child.pid) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}
