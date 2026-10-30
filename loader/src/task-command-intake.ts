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
  harness: Pick<TaskHarness, 'steer' | 'intakeReady'>;
  diagnostic?: (level: 'warn' | 'error', code: string, status?: number) => void;
  onFatal?: () => void;
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
  let receiptDelay = 250;
  const diagnostic = (level: 'warn' | 'error', code: string, error?: unknown) => {
    const status = error instanceof LauncherError ? error.status : undefined;
    if (options.diagnostic) options.diagnostic(level, code, status);
    else
      process.stderr.write(
        `${JSON.stringify({ level, component: 'task-command-intake', code, status })}\n`
      );
  };
  const deterministic = (error: unknown) =>
    error instanceof LauncherError &&
    ((error.status !== undefined &&
      error.status >= 400 &&
      error.status < 500 &&
      ![408, 429].includes(error.status)) ||
      ['command_invalid', 'command_ack_invalid', 'response_invalid', 'response_too_large'].includes(
        error.code
      ));
  function delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted) finish();
    });
  }
  function flushReceipts(): void {
    if (receiptFlight || retryTimer || receiptClosing.signal.aborted || !receipts.size) return;
    clearTimeout(retryTimer);
    let completed = false;
    receiptFlight = (async () => {
      for (const [id, receipt] of receipts) {
        try {
          const stored = await receiptClient.call(
            '/task/commands/receipt',
            receipt,
            receiptClosing.signal
          );
          if (stored['stored'] !== true) throw new LauncherError('command_ack_invalid');
          receipts.delete(id);
          receiptDelay = 250;
        } catch (error) {
          if (!deterministic(error)) throw error;
          receipts.delete(id);
          diagnostic('warn', 'command_receipt_dropped', error);
        }
      }
      completed = true;
    })()
      .catch(() => {
        if (!stopped) {
          retryTimer = setTimeout(() => {
            retryTimer = undefined;
            flushReceipts();
          }, receiptDelay);
          receiptDelay = Math.min(receiptDelay * 2, 5000);
        }
      })
      .finally(() => {
        receiptFlight = undefined;
        // A receipt can arrive after the iterator finishes but before this
        // promise releases ownership. Its receipt() call saw an active flight.
        if (completed) flushReceipts();
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
    // No poll, and therefore no irrevocable rejected ACK, before native intake.
    let cancelReady: (() => void) | undefined;
    await Promise.race([
      options.harness.intakeReady,
      new Promise<void>((resolve) => {
        cancelReady = resolve;
        pollClosing.signal.addEventListener('abort', cancelReady, { once: true });
        if (pollClosing.signal.aborted) resolve();
      }),
    ]);
    if (cancelReady) pollClosing.signal.removeEventListener('abort', cancelReady);
    let retryDelay = 250;
    while (!stopped && !closing.signal.aborted) {
      try {
        const response = await poll.call('/task/commands', undefined, pollClosing.signal);
        if (stopped) return;
        if (response['command'] === null) {
          retryDelay = 250;
          continue;
        }
        const c = command(response['command']);
        const text = c.kind === 'answer' ? `[question:${c.questionId ?? ''}]\n${c.text}` : c.text;
        const disposition = await options.harness.steer({
          commandId: c.commandId,
          text,
          kind: c.kind,
        });
        if (c.kind === 'answer' && disposition === 'accepted')
          options.onAnswerAdmitted?.(c.questionId ?? '');
        await post('/task/commands/ack', {
          taskId: c.taskId,
          attemptId: c.attemptId,
          commandId: c.commandId,
          disposition,
        });
        retryDelay = 250;
      } catch (error) {
        if (closing.signal.aborted) return;
        if (deterministic(error)) {
          diagnostic('error', 'command_intake_failed', error);
          options.onFatal?.();
          return;
        }
        if (stopped) return;
        // Replayed IDs rejoin the journal; never retry native admission directly.
        await delay(retryDelay, closing.signal);
        retryDelay = Math.min(retryDelay * 2, 5000);
      }
    }
  }
  return {
    start() {
      running ??= run().catch((error: unknown) => {
        if (stopped) return;
        diagnostic('error', 'command_intake_failed', error);
        options.onFatal?.();
      });
    },
    receipt(event: Extract<TaskHarnessEvent, { type: 'receipt' }>) {
      if (receiptClosing.signal.aborted) return;
      if (receipts.size >= 128) {
        diagnostic('warn', 'command_receipt_capacity');
        return;
      }
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
        retryTimer = undefined;
        flushReceipts();
        // Drain the bounded receipt attempt before the terminal report.
        while (receiptFlight) await receiptFlight;
        receiptClosing.abort();
        receiptClient.close();
      })());
    },
  };
}
