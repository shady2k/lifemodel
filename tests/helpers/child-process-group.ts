import type { ChildProcess } from 'node:child_process';

/**
 * SIGKILL the process group of a child we spawned detached (lifemodel-653.7.10).
 *
 * The test cores are started through `tsx`, which runs the core in a child of
 * its own: killing the `tsx` process alone leaves the core alive, holding its
 * Postgres connections, so the file's database cannot be dropped without
 * terminating sessions.
 *
 * The group outlives its leader, so this signals the group even when the leader
 * has already exited - an OOM kill of the wrapper must not leave the core
 * running. The command is safe for a stale id: a process-group id cannot be
 * reused while any member of the group is alive (the kernel keeps it reserved
 * for the group), so the negative signal either reaches members of the group we
 * created or fails with ESRCH because the whole group is gone.
 */
export function killProcessGroup(child: ChildProcess): void {
  const pgid = child.pid;
  if (!pgid) return;
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

/**
 * Stops a detached child and every process it started, whether or not the
 * leader is still running. The exit of an already exited leader is not awaited
 * again; a surviving group member is still killed.
 */
export async function stopProcessGroup(child: ChildProcess): Promise<void> {
  const exited = child.exitCode !== null || child.signalCode !== null;
  const exit = exited
    ? undefined
    : new Promise<void>((resolve) => child.once('exit', () => resolve()));
  killProcessGroup(child);
  await exit;
}

/**
 * Reaps what is left of a detached child's group when its leader exits on its
 * own: a wrapper that dies unexpectedly (an OOM kill, a crash) leaves the inner
 * core running otherwise.
 */
export function reapProcessGroupOnExit(child: ChildProcess): void {
  child.once('exit', () => killProcessGroup(child));
}
