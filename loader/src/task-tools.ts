/** Launcher-owned bounded report relay. The stdio child has no runtime credentials. */
import { createServer, type Socket } from 'node:net';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TaskQuestionState } from './task-harness.js';
import { TASK_MCP_SHIM } from './task-mcp-shim.js';
import { LauncherError } from './task-launcher-http.js';

export interface TaskMcpServer {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
}
export async function createTaskTools(options: {
  workDirectory: string;
  report(kind: 'step' | 'question', text: string, messageId: string): Promise<void>;
  diagnostic?: (code: string) => void;
}) {
  const directory = join(options.workDirectory, '.launcher');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = join(directory, 'tools.sock');
  const sockets = new Set<Socket>();
  const calls = new Map<string, { content: string; flight: Promise<unknown> }>();
  const listeners = new Set<() => void>();
  let questionId: string | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  let reporting = false;
  function notify() {
    for (const wake of listeners) wake();
  }
  const question: TaskQuestionState = {
    isOpen: () => questionId !== undefined,
    waitForChange: (signal) =>
      new Promise<void>((resolve) => {
        const finish = () => {
          listeners.delete(finish);
          signal.removeEventListener('abort', finish);
          resolve();
        };
        listeners.add(finish);
        signal.addEventListener('abort', finish, { once: true });
        if (signal.aborted) finish();
      }),
  };
  const server = createServer((socket) => {
    if (closed || sockets.size >= 4) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
    socket.setTimeout(15_000, () => socket.destroy());
    let data = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (data.length > 8192) {
        socket.destroy();
        return;
      }
      const end = data.indexOf(10);
      if (end < 0) return;
      socket.pause(); // One request per connection; no unbounded request queue.
      socket.setTimeout(0); // The report owns its deadline once the request is read.

      void (async () => {
        const input = JSON.parse(data.subarray(0, end).toString()) as Record<string, unknown>;
        const { id, kind, text } = input;
        if (
          Object.keys(input).sort().join(',') !== 'id,kind,text' ||
          typeof id !== 'string' ||
          !/^[a-f0-9]{64}$/.test(id) ||
          (kind !== 'step' && kind !== 'question') ||
          typeof text !== 'string' ||
          !text.trim() ||
          Buffer.byteLength(text) > 1024 ||
          /[\r\n\0]/.test(text)
        )
          throw new Error('invalid_report');
        const content = JSON.stringify([kind, text]);
        const previous = calls.get(id);
        if (previous) {
          if (previous.content !== content) throw new Error('report_conflict');
          return previous.flight;
        }
        if (calls.size >= 1024) throw new Error('report_capacity');
        if (kind === 'question' && questionId !== undefined) throw new Error('question_open');
        if (reporting) throw new Error('report_busy');
        const messageId = `msg_${randomUUID()}`;
        if (kind === 'question') {
          questionId = messageId;
          notify();
        }
        reporting = true;
        const flight = options
          .report(kind, text, messageId)
          .then(() => ({ messageId, ...(kind === 'question' ? { questionId: messageId } : {}) }))
          .catch((error: unknown) => {
            const refused =
              error instanceof LauncherError &&
              error.status !== undefined &&
              error.status >= 400 &&
              error.status < 500 &&
              error.status !== 429;
            if (kind === 'question') {
              if (refused) {
                questionId = undefined;
                notify();
              } else options.diagnostic?.('task_tool_question_retained');
            }
            throw new Error(refused ? 'report_unavailable' : 'report_uncertain');
          })
          .finally(() => {
            reporting = false;
          });
        // Retain every call identity; only an ambiguous failure keeps its question reserved.
        // Retrying this call never creates a different immutable frame.
        calls.set(id, { content, flight });
        return flight;
      })().then(
        (result) => socket.end(JSON.stringify({ result }) + '\n'),
        (error: unknown) => {
          const code =
            error instanceof Error &&
            [
              'invalid_report',
              'report_conflict',
              'report_capacity',
              'report_busy',
              'question_open',
              'report_unavailable',
              'report_uncertain',
            ].includes(error.message)
              ? error.message
              : 'invalid_report';
          options.diagnostic?.(`task_tool_${code}`);
          socket.end(JSON.stringify({ error: code }) + '\n');
        }
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  server.on('error', () => undefined);
  await chmod(path, 0o600);
  return {
    mcpServers: [
      {
        name: 'task',
        command: '/usr/bin/env',
        args: ['-i', '/usr/bin/python3', '-c', TASK_MCP_SHIM, path],
        env: [],
      },
    ] satisfies TaskMcpServer[],
    question,
    answerAdmitted(id: string) {
      if (id === questionId) {
        questionId = undefined;
        notify();
      }
    },
    close() {
      closing ??= (async () => {
        closed = true;
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) =>
          server.close(() => {
            resolve();
          })
        );
        await rm(path, { force: true });
        notify();
      })();
      return closing;
    },
  };
}
