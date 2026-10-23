import type { Logger } from 'pino';
import type { TaskRegistry, TaskRecord } from '../ports/tasks.js';
import { StalePostgresEpochError } from '../storage/fenced-postgres.js';
import { TaskRegistryError } from '../ports/tasks.js';
import { TaskExecutorError } from './task-executor.js';
import type { StorageControlClient } from './storage-control-client.js';
import type { TaskExecutor, TaskLaunch } from './task-executor.js';

export const TASK_WORKBENCH_REPOSITORY = 'ghcr.io/shady2k/lifemodel-workbench';
export function taskWorkbenchImage(value: string | undefined): string {
  if (!value || !/^ghcr\.io\/shady2k\/lifemodel-workbench@sha256:[0-9a-f]{64}$/.test(value))
    throw new Error('Invalid task workbench image configuration');
  return value;
}
export function allocationEffectKey(task: TaskRecord): string {
  return `allocate_${task.launchId}`;
}
const terminal = (task: TaskRecord) => ['done', 'failed', 'stopped'].includes(task.state);

/** Infrastructure only. Registry and storage receipts, not this worker's memory,
 * own replay. Each pass is finite; resync is also the watch reconnect boundary.
 * A stopped/old holder never dispatches new work. Late Kubernetes creates stay
 * inert under the gateway's canonical access/start fence and are cleaned later.
 */
export function createTaskLaunchReconciler(options: {
  registry: TaskRegistry;
  executor: TaskExecutor;
  storage: Pick<StorageControlClient, 'allocate' | 'close'>;
  logger: Logger;
  resyncMs?: number;
  retryMs?: number;
  scanJobs?: (signal: AbortSignal) => Promise<
    readonly {
      name: string;
      uid: string;
      launchLabel: string;
      remove: (signal: AbortSignal) => Promise<void>;
    }[]
  >;
  closeExecutor?: () => void;
  waitForChange?: (signal: AbortSignal) => Promise<void>;
}) {
  const controller = new AbortController();
  let stopped = false;
  let inflight: Promise<boolean> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  let failures = 0;
  let workCursor = '0';
  let moreWork = false;
  let watchController: AbortController | undefined;
  let wakeRevision = 0;
  function active() {
    controller.signal.throwIfAborted();
  }
  async function current(id: string, launchId: string) {
    active();
    const task = await options.registry.read(id);
    active();
    if (task?.launchId !== launchId) throw new Error('Task launch identity conflict');
    return task;
  }
  function launch(task: TaskRecord): TaskLaunch {
    if (!task.allocationReceipt) throw new Error('Task allocation missing');
    return {
      task,
      spaceId: task.allocationReceipt.space,
      workbenchImage: `${TASK_WORKBENCH_REPOSITORY}@${task.imageRevision}`,
    };
  }
  async function cleanup(task: TaskRecord) {
    // Intent precedes every delete, including re-arming cleanup for late create.
    task = await options.registry.tombstoneLaunch(task.id, task.launchId);
    active();
    if (task.jobUid && task.allocationReceipt) {
      await options.executor.deleteNow(launch(task), controller.signal);
      active();
    }
    // .9 confirms Pod termination before releaseSlot; Job disappearance alone
    // cannot release a reservation or imply a retained task outcome.
  }
  async function ensure(task: TaskRecord) {
    task = await current(task.id, task.launchId);
    if (
      task.tombstonedAt ||
      terminal(task) ||
      task.terminalCandidate ||
      (task.state === 'starting' && task.softStopRequestedAt)
    ) {
      await cleanup(task);
      return;
    }
    if (task.state === 'queued') return;
    if (task.state !== 'starting' || task.terminalCandidate || task.softStopRequestedAt) {
      if (task.allocationReceipt && task.jobUid) {
        const observed = await options.executor.observe(launch(task), controller.signal);
        active();
        if (!observed) throw new Error('Bound task compute missing');
      }
      return;
    }
    if (!task.slotReserved) return;
    if (!task.allocationReceipt) {
      const receipt = await options.storage.allocate(
        {
          taskId: task.id,
          launchId: task.launchId,
          effectKey: allocationEffectKey(task),
          retentionRevision: String(task.settingsRevision),
        },
        controller.signal
      );
      active();
      task = await options.registry.recordAllocation(task.id, task.launchId, receipt);
    }
    // Re-read the durable fence immediately before external creation. There is
    // no cross-store transaction: delayed old-epoch CREATE can only stay inert.
    task = await current(task.id, task.launchId);
    if (
      task.tombstonedAt ||
      terminal(task) ||
      task.terminalCandidate ||
      (task.state === 'starting' && task.softStopRequestedAt)
    ) {
      await cleanup(task);
      return;
    }
    if (task.state !== 'starting' || !task.slotReserved) return;
    const observed = await options.executor.ensureStarted(launch(task), controller.signal);
    active();
    task = await options.registry.bindJob(
      task.id,
      task.launchId,
      observed.jobUid,
      observed.templateHash
    );
    active();
    if (observed.startedAt)
      await options.registry.initializeAccessIntent(task.id, observed.startedAt);
  }
  async function pass(): Promise<boolean> {
    if (stopped) return false;
    try {
      // Takeover reconciles existing reservations before admitting more work.
      // Capture the watch resourceVersion BEFORE per-task GETs. A later Job
      // change remains a watch event even if a GET observes the older object.
      const jobs = options.scanJobs ? await options.scanJobs(controller.signal) : [];
      active();
      const tasks = await options.registry.listLaunchWork(workCursor, 100);
      active();
      moreWork = tasks.length === 100;
      workCursor = moreWork ? (tasks.at(-1)?.acceptedOrder ?? '0') : '0';
      let success = true;
      for (const task of tasks) {
        if (stopped) return false;
        if (terminal(task) && !task.cleanupPending) continue;
        try {
          await ensure(task);
        } catch (error) {
          if (error instanceof StalePostgresEpochError) throw error;
          success = false;
          options.logger.warn(
            {
              taskId: task.id,
              launchId: task.launchId,
              count: 1,
              code:
                error instanceof TaskRegistryError || error instanceof TaskExecutorError
                  ? error.code
                  : 'launch_error',
            },
            'Task launch remains pending'
          );
        }
      }
      if (options.scanJobs) {
        for (const job of jobs) {
          active();
          // The lookup itself is fenced and exact; a paged registry snapshot
          // cannot classify a launch on a different page as an orphan.
          const fresh = await options.registry.readByJobName(job.name);
          active();
          if (
            !fresh ||
            fresh.tombstonedAt ||
            terminal(fresh) ||
            fresh.terminalCandidate ||
            (fresh.state === 'starting' && fresh.softStopRequestedAt)
          ) {
            if (fresh) await options.registry.tombstoneLaunch(fresh.id, fresh.launchId);
            active();
            await job.remove(controller.signal);
          }
        }
      }
      if (success) {
        // Platform cap is at most eight. Bound dispatch even if policy changes.
        for (let count = 0; count < 8 && !stopped; count++) {
          const next = await options.registry.admitNext();
          if (!next) break;
          await ensure(next);
        }
      }
      return success;
    } catch (error) {
      if (error instanceof StalePostgresEpochError) {
        stop();
        return false;
      }
      if (!stopped) options.logger.warn({ count: 1 }, 'Task reconciliation remains pending');
      return false;
    }
  }
  function runOnce(): Promise<boolean> {
    if (stopped) return Promise.resolve(false);
    if (inflight) return inflight;
    inflight = pass().finally(() => {
      inflight = undefined;
    });
    return inflight;
  }
  const waiters: ((success: boolean) => void)[] = [];
  async function drive() {
    while (!stopped) {
      const revision = wakeRevision;
      const pending = waiters.splice(0);
      const success = await runOnce();
      for (const resolve of pending) resolve(success);
      if (stopped) break;
      failures = success ? 0 : Math.min(10, failures + 1);
      if ((success && moreWork) || revision !== wakeRevision) continue;
      watchController = new AbortController();
      const signal = AbortSignal.any([controller.signal, watchController.signal]);
      try {
        if (success && options.waitForChange) await options.waitForChange(signal);
        else if (success) {
          // No event source in a caller-contract fixture: wait for explicit resync.
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                resolve();
              },
              { once: true }
            );
            if (signal.aborted) resolve();
          });
        } else await retry(signal);
      } catch {
        if (!signal.aborted && !stopped) await retry(signal);
      }
    }
  }
  function retry(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      signal.addEventListener('abort', done, { once: true });
      timer = setTimeout(
        done,
        Math.min(
          options.resyncMs ?? 30_000,
          (options.retryMs ?? 1000) * 2 ** Math.max(0, failures - 1)
        )
      );
      timer.unref();
      if (signal.aborted) done();
    });
  }
  function stop() {
    stopped = true;
    clearTimeout(timer);
    controller.abort();
    for (const resolve of waiters.splice(0)) resolve(false);
    options.storage.close();
    options.closeExecutor?.();
  }
  async function resync(): Promise<boolean> {
    wakeRevision++;
    workCursor = '0';
    watchController?.abort();
    if (stopped) return false;
    if (started)
      return new Promise<boolean>((resolve) => {
        waiters.push(resolve);
      });
    if (inflight) await inflight;
    return runOnce();
  }
  return {
    runOnce,
    resync,
    start: () => {
      if (!started && !stopped) {
        started = true;
        void drive();
      }
    },
    stop,
    requestSoftStop: async (taskId: string) => {
      const task = await options.registry.read(taskId);
      if (!task) throw new Error('Task not found');
      await options.registry.recordSoftStop(task.id, task.launchId);
      if (task.allocationReceipt)
        await options.executor.requestSoftStop(launch(task), controller.signal);
    },
    deleteNow: async (taskId: string) => {
      const task = await options.registry.read(taskId);
      if (!task) throw new Error('Task not found');
      await cleanup(task);
    },
  };
}
