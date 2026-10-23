import type { Logger } from 'pino';
import type { TaskMailbox, StoredTaskChannelFrame } from '../ports/task-channel.js';
import { createSignal } from '../types/signal.js';
import type { BusSignalStream } from './bus-stream.js';
import { StalePostgresEpochError } from '../storage/fenced-postgres.js';

/** Store commits own replay. Notifications only request a bounded pass; they do
 * not carry payloads or participate in the listener's ACK transaction.
 */
export function createTaskChannelReplay(options: {
  mailbox: Pick<TaskMailbox, 'listUnsignalled' | 'markSignalled'>;
  bus: Pick<BusSignalStream, 'appendTaskSignal'>;
  logger: Logger;
  batchSize?: number;
  retryDelayMs?: number;
  operationTimeoutMs?: number;
}) {
  const batchSize = options.batchSize ?? 100;
  const retryDelayMs = options.retryDelayMs ?? 1000;
  const operationTimeoutMs = options.operationTimeoutMs ?? 5000;
  for (const [value, maximum] of [
    [batchSize, 100],
    [retryDelayMs, 30_000],
    [operationTimeoutMs, 5000],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new Error('Invalid task channel replay bounds');
    }
  }
  const closing = new AbortController();
  let stopped = false;
  let requested = false;
  let inflight: Promise<void> | undefined;
  let pendingAppend: { key: string; promise: Promise<string> } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function schedule(delay: number): void {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void resync();
    }, delay);
    timer.unref();
  }

  async function admit(row: StoredTaskChannelFrame, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const frame = row.frame;
    const report = createSignal(
      'task_report',
      'task.channel',
      { value: 1, confidence: 1 },
      {
        priority: frame.kind === 'terminal' ? 1 : 2,
        correlationId: frame.taskId,
        data: {
          kind: 'task_report',
          taskId: frame.taskId,
          attemptId: frame.attemptId,
          messageId: frame.messageId,
          eventKind: frame.kind,
        },
      }
    );
    report.timestamp = new Date(row.ack.receivedAt);
    // Include direction rather than assuming the future steering direction can
    // share message IDs. Never use a sequence watermark: gaps are valid.
    const key = JSON.stringify([frame.taskId, frame.direction, frame.messageId]);
    // A timed-out Redis request may still be queued. Keep at most one physical
    // append pending across retries instead of accumulating abandoned commands.
    if (pendingAppend && pendingAppend.key !== key) {
      await pendingAppend.promise;
      signal.throwIfAborted();
    }
    if (!pendingAppend) {
      const append = { key, promise: options.bus.appendTaskSignal(report, key) };
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
    signal.throwIfAborted();
    await options.mailbox.markSignalled(frame.taskId, frame.direction, frame.messageId, signal);
  }

  async function pass(): Promise<void> {
    const timeout = AbortSignal.timeout(operationTimeoutMs);
    const signal = AbortSignal.any([closing.signal, timeout]);
    let removeAbort: (() => void) | undefined;
    try {
      // Race the whole pass, not just SQL. A queued Valkey request cannot be
      // withdrawn; it may append later, but the receipt makes restart safe and
      // the aborted pass can never mark its mailbox row afterwards.
      await Promise.race([
        (async () => {
          const rows = await options.mailbox.listUnsignalled(batchSize, signal);
          signal.throwIfAborted();
          for (const row of rows) await admit(row, signal);
          if (rows.length === batchSize) schedule(0);
        })(),
        new Promise<never>((_resolve, reject) => {
          const abort = () => reject(new Error('Task channel replay interrupted'));
          signal.addEventListener('abort', abort, { once: true });
          removeAbort = () => signal.removeEventListener('abort', abort);
          if (signal.aborted) abort();
        }),
      ]);
    } catch (error) {
      if (error instanceof StalePostgresEpochError) {
        stopped = true;
        closing.abort();
        clearTimeout(timer);
        timer = undefined;
      } else if (!stopped) {
        // Raw SQL/Valkey errors can contain credentials or private payloads.
        options.logger.warn(
          { code: 'task_signal_pending', count: 1 },
          'Task mailbox signal remains pending'
        );
        schedule(retryDelayMs);
      }
    } finally {
      removeAbort?.();
    }
  }

  function resync(): Promise<void> {
    if (stopped) return Promise.resolve();
    // Do not create another abandoned pass while a timed-out Redis command is
    // unresolved. Its original continuation checks abort before any SQL mark.
    if (!inflight && pendingAppend) {
      schedule(retryDelayMs);
      return Promise.resolve();
    }
    if (inflight) {
      requested = true;
      return inflight;
    }
    clearTimeout(timer);
    timer = undefined;
    inflight = pass().finally(() => {
      inflight = undefined;
      if (requested) {
        requested = false;
        schedule(0);
      }
    });
    return inflight;
  }

  async function stop(deadline: number): Promise<void> {
    stopped = true;
    requested = false;
    clearTimeout(timer);
    timer = undefined;
    closing.abort();
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        inflight,
        new Promise<void>((resolve) => {
          deadlineTimer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
        }),
      ]);
    } finally {
      clearTimeout(deadlineTimer);
    }
  }

  return { start: resync, resync, stop };
}
