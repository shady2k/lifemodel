import type { Logger } from 'pino';
import type { TaskRecord, TaskRegistry } from '../ports/tasks.js';
import type { TaskMailbox } from '../ports/task-channel.js';
import { createSignal, type Signal } from '../types/signal.js';
import { StalePostgresEpochError } from '../storage/fenced-postgres.js';
import type { BusSignalStream } from './bus-stream.js';
import type { TaskExecutor, TaskLaunch } from './task-executor.js';
import { StorageControlError, type StorageControlClient } from './storage-control-client.js';
import { allocationEffectKey, TASK_WORKBENCH_REPOSITORY } from './task-launch.js';

const terminal = (task: TaskRecord) => ['done', 'failed', 'stopped'].includes(task.state);

/** SQL owns every decision and retry request. Notifications only shorten the
 * next bounded scan; they never own work. No harness-specific logic lives here. */
export function createTaskFinalizer(options: {
  registry: TaskRegistry;
  mailbox: Pick<TaskMailbox, 'readTerminal'>;
  executor: TaskExecutor;
  storage: Pick<StorageControlClient, 'allocate' | 'seal' | 'close'>;
  bus: Pick<BusSignalStream, 'appendTaskSignal'>;
  logger: Logger;
  cancelRegistry?: () => void;
  closeExecutor?: () => void;
  retryMs?: number;
}) {
  const controller = new AbortController();
  let stopped = false;
  let started = false;
  let inflight: Promise<boolean> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let cursor = '0';
  let requested = false;
  let pendingAppend: { key: string; promise: Promise<string> } | undefined;
  const active = () => {
    controller.signal.throwIfAborted();
  };
  function launch(task: TaskRecord): TaskLaunch {
    return {
      task,
      spaceId: task.allocationReceipt?.space ?? 'unallocated',
      workbenchImage: `${TASK_WORKBENCH_REPOSITORY}@${task.imageRevision}`,
    };
  }
  async function candidate(task: TaskRecord, reasonCode?: string): Promise<TaskRecord> {
    if (terminal(task) || task.terminalCandidate) return task;
    const row = await options.mailbox.readTerminal(task.id, task.attemptId, controller.signal);
    active();
    if (row?.frame.kind === 'terminal') {
      const report = row.frame.payload;
      return options.registry.beginFinalization(task.id, task.launchId, {
        state:
          report.outcome === 'succeeded'
            ? 'done'
            : report.outcome === 'aborted'
              ? 'stopped'
              : 'failed',
        reasonCode:
          report.outcome === 'failed'
            ? report.reasonCode
            : report.outcome === 'aborted'
              ? 'aborted'
              : 'completed',
        summary: report.summary,
      });
    }
    if (!reasonCode && task.jobUid && task.allocationReceipt) {
      const observed = await options.executor.observe(launch(task), controller.signal);
      active();
      reasonCode = !observed
        ? 'compute_missing'
        : observed.phase === 'failed'
          ? 'job_failed'
          : observed.phase === 'succeeded'
            ? 'semantic_report_missing'
            : undefined;
    }
    if (!reasonCode) return task;
    return options.registry.beginFinalization(task.id, task.launchId, {
      state: 'failed',
      reasonCode,
      summary: 'The task ended before a successful result was confirmed',
    });
  }
  async function finalizeRow(task: TaskRecord): Promise<void> {
    active();
    task = await candidate(task);
    if (!terminal(task) && !task.terminalCandidate) return;
    if (!task.terminationConfirmedAt || task.cleanupPending) {
      // Persist the tombstone BEFORE deletion, including retries after late CREATE.
      task = await options.registry.tombstoneLaunch(task.id, task.launchId);
      active();
      if (!task.jobUid) {
        const observed = await options.executor.observe(launch(task), controller.signal);
        active();
        if (observed)
          task = await options.registry.bindCleanupJob(
            task.id,
            task.launchId,
            observed.jobUid,
            observed.templateHash
          );
      }
      if (task.jobUid) await options.executor.deleteNow(launch(task), controller.signal);
      active();
      if (!(await options.executor.confirmTerminated(launch(task), controller.signal))) {
        await options.registry.setFinalizationPending(
          task.id,
          task.launchId,
          'compute_termination_pending'
        );
        throw new Error('Compute termination pending');
      }
      active();
      task = await options.registry.confirmComputeTerminated(task.id, task.launchId);
      active();
    }
    active();
    // Also replay a crash after confirmation but before reservation release.
    if (task.slotReserved && task.terminationConfirmedAt)
      await options.registry.releaseSlot(task.id);
    active();
    if (!task.allocationReceipt) {
      // A lost allocation response must replay the launch's original key even
      // after its tombstone. It never authorizes another Job.
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
    if (!terminal(task)) {
      if (!task.sealReceipt && task.sealRequest) {
        task = await options.registry.recoverSealReceipt(
          task.id,
          task.launchId,
          task.sealRequest.candidateRevision
        );
        active();
      }
      if (!task.sealReceipt) {
        task = await options.registry.prepareSeal(task.id, task.launchId);
        active();
        const seal = task.sealRequest;
        if (!seal) throw new Error('Seal request missing');
        try {
          const receipt = await options.storage.seal(
            {
              space: seal.space,
              effectKey: seal.effectKey,
              expectedRevision: seal.expectedRevision,
              outcome: seal.outcome,
            },
            controller.signal
          );
          active();
          task = await options.registry.recordSealReceipt(
            task.id,
            task.launchId,
            seal.candidateRevision,
            receipt
          );
        } catch (error) {
          if (
            error instanceof StorageControlError &&
            ((error.status === 409 &&
              (error.code === 'missing_result' || error.code === 'revision_conflict')) ||
              (error.status === 503 && error.code === 'checksum_mismatch'))
          ) {
            await options.registry.abandonSeal(
              task.id,
              task.launchId,
              seal.candidateRevision,
              error.code
            );
          }
          throw error;
        }
      }
      active();
      await options.registry.commitFinalization(task.id, task.launchId, task.candidateRevision);
      const committed = await options.registry.read(task.id);
      if (!committed) throw new Error('Task missing after commit');
      task = committed;
    }
    active();
    if (await options.executor.confirmCleanup(launch(task), controller.signal)) {
      active();
      await options.registry.completeLaunchCleanup(task.id, task.launchId);
    } else throw new Error('Task cleanup pending');
  }
  async function relay(): Promise<void> {
    const events = await options.registry.listOutcomeWork(100);
    if (events.length === 100) requested = true;
    for (const event of events) {
      active();
      if (pendingAppend && pendingAppend.key !== event.outcomeKey) {
        await pendingAppend.promise;
        active();
      }
      if (!pendingAppend) {
        const signal = createSignal(
          'task_outcome',
          'task.finalizer',
          { value: 1, confidence: 1 },
          {
            priority: 1,
            correlationId: event.taskId,
            data: { kind: 'task_outcome', ...event },
          }
        );
        signal.id = event.outcomeKey;
        const append = {
          key: event.outcomeKey,
          promise: options.bus.appendTaskSignal(signal, event.outcomeKey),
        };
        pendingAppend = append;
        void append.promise.then(
          () => {
            if (pendingAppend === append) pendingAppend = undefined;
          },
          () => {
            if (pendingAppend === append) pendingAppend = undefined;
          }
        );
      }
      await pendingAppend.promise;
      active();
      await options.registry.markOutcomeSignalled(event.outcomeKey);
    }
  }
  async function pass(): Promise<boolean> {
    let success = true;
    try {
      const tasks = await options.registry.listFinalizationWork(cursor, 100);
      active();
      cursor = tasks.length === 100 ? (tasks.at(-1)?.acceptedOrder ?? '0') : '0';
      if (tasks.length === 100) requested = true;
      for (const task of tasks) {
        try {
          await finalizeRow(task);
        } catch (error) {
          if (error instanceof StalePostgresEpochError) throw error;
          active();
          success = false;
          await options.registry.setFinalizationPending(
            task.id,
            task.launchId,
            error instanceof StorageControlError
              ? (error.code ?? 'storage_unavailable')
              : ((await options.registry.read(task.id))?.finalizationFailureCode ??
                  'finalization_retry')
          );
          options.logger.warn(
            { taskId: task.id, code: 'finalization_pending', count: 1 },
            'Task finalization remains pending'
          );
        }
      }
      await relay();
      return success;
    } catch (error) {
      if (error instanceof StalePostgresEpochError) void stop(Date.now());
      else if (!stopped)
        options.logger.warn(
          { code: 'finalization_retry', count: 1 },
          'Task finalization scan remains pending'
        );
      return false;
    }
  }
  function schedule(delay: number) {
    if (!started || stopped || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void runOnce();
    }, delay);
    timer.unref();
  }
  function runOnce(): Promise<boolean> {
    if (stopped) return Promise.resolve(false);
    if (inflight) {
      requested = true;
      return inflight;
    }
    inflight = pass()
      .finally(() => {
        inflight = undefined;
      })
      .then((success) => {
        failures = success ? 0 : Math.min(failures + 1, 8);
        const again = requested;
        requested = false;
        if (again || !success)
          schedule(
            again ? 0 : Math.min(30_000, (options.retryMs ?? 1000) * 2 ** Math.max(0, failures - 1))
          );
        return success;
      });
    return inflight;
  }
  function resync(): Promise<boolean> {
    cursor = '0';
    clearTimeout(timer);
    timer = undefined;
    return runOnce();
  }
  async function stop(deadline = Date.now() + 5000): Promise<void> {
    stopped = true;
    clearTimeout(timer);
    controller.abort();
    options.cancelRegistry?.();
    options.storage.close();
    options.closeExecutor?.();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        inflight,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, Math.max(0, deadline - Date.now()));
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }
  return {
    runOnce,
    resync,
    stop,
    start: () => {
      if (!started && !stopped) {
        started = true;
        return resync();
      }
      return Promise.resolve(false);
    },
    finalize: async (taskId: string, reasonCode?: string) => {
      active();
      const task = await options.registry.read(taskId);
      if (task) await candidate(task, reasonCode);
      active();
      return resync();
    },
    consumeSignal: async (signal: Signal) => {
      if (
        signal.type !== 'task_report' ||
        signal.data?.kind !== 'task_report' ||
        signal.data.eventKind !== 'terminal'
      )
        return;
      active();
      const task = await options.registry.read(signal.data.taskId);
      if (task?.attemptId === signal.data.attemptId) await candidate(task);
      active();
      void resync();
    },
  };
}
