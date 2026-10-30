/** Disposable task traces. Never shares the terminal client's socket or retry queue. */
import { createTaskContentScrubber } from './task-content-scrub.js';
import { TaskJsonClient, type TaskEndpoint } from './task-launcher-http.js';
import type { TaskHarnessEvent } from './task-harness.js';
type Span = Extract<TaskHarnessEvent, { type: 'trace' }>['span'];

export function createTaskTraceChannel(options: {
  endpoint: TaskEndpoint;
  env: NodeJS.ProcessEnv;
  identity: { taskId: string; attemptId: string; launchId: string };
  traceId: string;
  timeoutMs?: number;
}) {
  const client = new TaskJsonClient(options.endpoint, options.timeoutMs ?? 1500, 0);
  const queue: Span[] = [];
  const scrub = createTaskContentScrubber(options.env);
  let active = false;
  let stopped = false;
  let finishing = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let count = 0;
  let dropped = 0;
  async function drain() {
    if (active || stopped) return;
    active = true;
    try {
      while (queue.length && !stopped) {
        const span = queue.shift();
        if (!span) break;
        try {
          const cleaned = await scrub(span);
          await client.call('/task/trace', {
            ...options.identity,
            span: { ...cleaned, traceId: options.traceId },
          });
        } catch {
          dropped++;
        }
      }
    } finally {
      active = false;
      if (finishing) {
        clearTimeout(closeTimer);
        client.close();
      }
    }
  }
  return {
    enqueue(span: Span): void {
      try {
        if (
          stopped ||
          finishing ||
          ++count > 2048 ||
          queue.length >= 128 ||
          Buffer.byteLength(JSON.stringify(span)) > 30000
        ) {
          dropped++;
          return;
        }
        // Detach from mutable harness objects before async scrubbing/HTTP.
        queue.push(JSON.parse(JSON.stringify(span)) as Span);
        void drain();
      } catch {
        dropped++;
      }
    },
    get droppedCount() {
      return dropped;
    },
    close(): void {
      finishing = true;
      // Terminal report is already settled. Allow queued observations to finish
      // independently, but never retain the process/socket beyond one second.
      if (!active && !queue.length) {
        client.close();
        return;
      }
      closeTimer = setTimeout(() => {
        stopped = true;
        dropped += queue.length;
        queue.length = 0;
        client.close();
      }, 1000);
      closeTimer.unref();
    },
  };
}
