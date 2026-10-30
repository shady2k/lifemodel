/** Best-effort bounded session capture, separate socket from control and terminal. */
import { TaskJsonClient, type TaskEndpoint } from './task-launcher-http.js';
import { createTaskContentScrubber } from './task-content-scrub.js';
import type { TaskTranscriptEntry } from './task-harness.js';
export function createTaskTranscriptChannel(options: {
  endpoint: TaskEndpoint;
  env: NodeJS.ProcessEnv;
  identity: { taskId: string; attemptId: string };
  nextSequence: () => number;
}) {
  const client = new TaskJsonClient(options.endpoint, 1000, 0);
  const scrub = createTaskContentScrubber(options.env);
  const queue: { entry: TaskTranscriptEntry; sequence: number }[] = [];
  const ids = new Set<string>();
  let flight: Promise<void> | undefined;
  let closed = false;
  let dropped = 0;
  const drain = () => {
    if (flight || closed) return;
    flight = (async () => {
      while (queue.length && !closed) {
        const next = queue.shift();
        if (!next) break;
        try {
          const entry = await scrub(next.entry);
          const frame = {
            taskId: options.identity.taskId,
            attemptId: options.identity.attemptId,
            direction: 'task_to_core',
            messageId: entry.id,
            sequence: next.sequence,
            kind: 'transcript',
            payload: entry,
          };
          // Lost ACK replays the identical scrubbed frame, never a fresh ID.
          for (let pass = 0; pass < 2; pass++) {
            try {
              await client.call('/task/events', frame);
              break;
            } catch {
              if (pass === 1) dropped++;
            }
          }
        } catch {
          dropped++;
        }
      }
    })().finally(() => {
      flight = undefined;
      if (queue.length && !closed) drain();
    });
  };
  return {
    enqueue(entry: TaskTranscriptEntry) {
      try {
        if (closed || ids.has(entry.id)) return;
        if (
          ids.size >= 1024 ||
          queue.length >= 64 ||
          Buffer.byteLength(JSON.stringify(entry)) > 8192
        ) {
          dropped++;
          return;
        }
        ids.add(entry.id);
        queue.push({
          entry: JSON.parse(JSON.stringify(entry)) as TaskTranscriptEntry,
          sequence: options.nextSequence(),
        });
        drain();
      } catch {
        dropped++;
      }
    },
    get droppedCount() {
      return dropped;
    },
    async close() {
      // Never let capture determine the task outcome or hold completion unbounded.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          flight,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 2000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        closed = true;
        queue.length = 0;
        client.close();
      }
    },
  };
}
