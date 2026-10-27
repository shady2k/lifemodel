/** Dial out only. A failed ACK replays the same command through the harness journal. */
import { createHash } from 'node:crypto';
import { TaskJsonClient, LauncherError, type TaskEndpoint } from './task-launcher-http.js';
import type { TaskHarness, TaskHarnessEvent } from './task-harness.js';

interface Identity {
  taskId: string;
  attemptId: string;
  launchId: string;
}
interface Command {
  taskId: string;
  attemptId: string;
  commandId: string;
  direction: 'core_to_task';
  sequence: number;
  kind: 'steer' | 'answer';
  text: string;
  questionId?: string;
}
export function createTaskCommandIntake(options: {
  endpoint: TaskEndpoint;
  identity: Identity;
  harness: Pick<TaskHarness, 'steer'>;
  hardStopAt: number;
  onAnswerAdmitted?: (questionId: string) => void;
}) {
  // Separate sockets: a held poll never blocks ACKs, receipts or progress.
  const poll = new TaskJsonClient(options.endpoint, 30_000);
  const writes = new TaskJsonClient(options.endpoint, 10_000);
  const receiptClient = new TaskJsonClient(options.endpoint, 10_000);
  poll.hardStopAt = writes.hardStopAt = receiptClient.hardStopAt = options.hardStopAt;
  const closing = new AbortController();
  const pollClosing = new AbortController();
  const receipts = new Map<string, Record<string, unknown>>();
  let running: Promise<void> | undefined;
  let stopped = false;
  let stopping: Promise<void> | undefined;
  const receiptClosing = new AbortController();
  let receiptFlight: Promise<void> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  function flushReceipts(): void {
    if (receiptFlight || receiptClosing.signal.aborted || !receipts.size) return;
    clearTimeout(retryTimer);
    receiptFlight = (async () => {
      for (const [id, receipt] of receipts) {
        const stored = await receiptClient.call(
          '/task/commands/receipt',
          receipt,
          receiptClosing.signal
        );
        if (stored['stored'] !== true) throw new LauncherError('command_ack_invalid');
        receipts.delete(id);
      }
    })()
      .catch(() => {
        if (!stopped) retryTimer = setTimeout(flushReceipts, 250);
      })
      .finally(() => {
        receiptFlight = undefined;
      });
  }
  async function post(path: string, body: unknown) {
    const stored = await writes.call(path, body, closing.signal);
    if (stored['stored'] !== true) throw new LauncherError('command_ack_invalid');
  }
  function command(value: unknown): Command {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new LauncherError('command_invalid');
    const c = value as Record<string, unknown>;
    if (
      c['taskId'] !== options.identity.taskId ||
      c['attemptId'] !== options.identity.attemptId ||
      c['direction'] !== 'core_to_task' ||
      typeof c['commandId'] !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(c['commandId']) ||
      !Number.isSafeInteger(c['sequence']) ||
      (c['sequence'] as number) < 1 ||
      !['steer', 'answer'].includes(c['kind'] as string) ||
      typeof c['text'] !== 'string' ||
      !c['text'].trim() ||
      Buffer.byteLength(JSON.stringify(c)) > 65536 ||
      (c['kind'] === 'answer' &&
        (typeof c['questionId'] !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(c['questionId'])))
    )
      throw new LauncherError('command_invalid');
    return c as unknown as Command;
  }
  async function run() {
    while (!stopped && !closing.signal.aborted) {
      try {
        const response = await poll.call('/task/commands', undefined, pollClosing.signal);
        if (stopped) return;
        if (response['command'] === null) continue;
        const c = command(response['command']);
        const text = c.kind === 'answer' ? `[question:${c.questionId ?? ''}]\n${c.text}` : c.text;
        const disposition = await options.harness.steer({ commandId: c.commandId, text });
        if (c.kind === 'answer' && disposition === 'accepted')
          options.onAnswerAdmitted?.(c.questionId ?? '');
        await post('/task/commands/ack', {
          taskId: c.taskId,
          attemptId: c.attemptId,
          commandId: c.commandId,
          disposition,
        });
      } catch (error) {
        if (stopped || closing.signal.aborted) return;
        if (
          error instanceof LauncherError &&
          error.status &&
          [400, 403, 404, 409].includes(error.status)
        )
          return;
        // Bounded backoff after connection/store loss. No native retry here:
        // redelivery goes back through steer and its durable local journal.
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            closing.signal.removeEventListener('abort', finish);
            resolve();
          };
          const timer = setTimeout(finish, 250);
          closing.signal.addEventListener('abort', finish, { once: true });
          if (closing.signal.aborted) finish();
        });
      }
    }
  }
  return {
    start() {
      running ??= run();
    },
    receipt(event: Extract<TaskHarnessEvent, { type: 'receipt' }>) {
      if (stopped || receipts.size >= 128) return;
      const receiptId = `receipt_${createHash('sha256')
        .update(JSON.stringify([event.commandId, event.disposition]))
        .digest('hex')}`;
      receipts.set(receiptId, {
        taskId: options.identity.taskId,
        attemptId: options.identity.attemptId,
        commandId: event.commandId,
        receiptId,
        disposition: event.disposition,
      });
      flushReceipts();
    },
    stop() {
      return (stopping ??= (async () => {
        stopped = true;
        // Close only intake first. A command already handed to steer owns a
        // disposition ACK even if the harness result settles at the same time.
        pollClosing.abort();
        poll.close();
        const drainDeadline = setTimeout(() => {
          closing.abort();
          writes.close();
        }, 15_000);
        try {
          await running;
        } finally {
          clearTimeout(drainDeadline);
          closing.abort();
          writes.close();
        }
        clearTimeout(retryTimer);
        flushReceipts();
        // Drain the bounded receipt attempt before the terminal report.
        await receiptFlight;
        receiptClosing.abort();
        receiptClient.close();
      })());
    },
  };
}
