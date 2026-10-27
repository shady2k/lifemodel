/** Outbound command polls have their own bounded reservations, never event workers. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { TaskCommandMailbox, TaskMailbox, TaskChannelProof } from '../ports/task-channel.js';
import {
  TaskChannelError,
  validateTaskCommandAck,
  validateTaskCommandReceipt,
} from '../ports/task-channel.js';

const POLL_MS = 25_000;
// Both native adapters allow 5 s for admission. Include journal/network margin.
export const TASK_COMMAND_ACK_TIMEOUT_MS = 10_000;
export function createTaskCommandChannel(options: {
  mailbox: Partial<TaskCommandMailbox> & Pick<TaskMailbox, 'readBriefing'>;
  identity: { verify(token: string, signal?: AbortSignal): Promise<TaskChannelProof> };
  frameLimit: number;
  maxBufferedBytes: number;
  maxUnackedFrames: number;
  maxUnackedBytes: number;
  workers: number;
  onRefused?: (status: number, code: string, route: string) => void;
}) {
  const controllers = new Set<AbortController>();
  const polls = new Set<string>();
  const sockets = new WeakMap<Socket, { frames: number; bytes: number }>();
  let buffered = 0;
  let active = 0;
  let closed = false;
  // Short operations only. Fail closed rather than build an unbounded SQL/auth queue.
  async function operation<T>(run: () => Promise<T>): Promise<T> {
    if (active >= options.workers) throw new TaskChannelError(429, 'channel_unavailable');
    active++;
    try {
      return await run();
    } finally {
      active--;
    }
  }
  function send(res: ServerResponse, status: number, body: unknown) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...(status === 429 ? { 'retry-after': '1' } : {}),
    });
    res.end(JSON.stringify(body));
  }
  return {
    stop() {
      closed = true;
      for (const controller of controllers) controller.abort();
    },
    receive(req: IncomingMessage, res: ServerResponse): boolean {
      const poll = req.method === 'GET' && req.url === '/task/commands';
      const ack = req.method === 'POST' && req.url === '/task/commands/ack';
      const receipt = req.method === 'POST' && req.url === '/task/commands/receipt';
      if (!poll && !ack && !receipt) return false;
      const route = poll
        ? 'GET /task/commands'
        : ack
          ? 'POST /task/commands/ack'
          : 'POST /task/commands/receipt';
      const refuse = (status: number, code: string) => {
        options.onRefused?.(status, code, route);
        send(res, status, { code });
      };
      req.on('error', () => undefined);
      res.on('error', () => undefined);
      if (closed) {
        refuse(503, 'stopped');
        return true;
      }
      const authorization = req.headers.authorization;
      const authCount = req.rawHeaders.filter(
        (v, i) => i % 2 === 0 && v.toLowerCase() === 'authorization'
      ).length;
      if (
        authCount !== 1 ||
        typeof authorization !== 'string' ||
        !/^Bearer [^\s]+$/.test(authorization)
      ) {
        refuse(403, 'identity_denied');
        return true;
      }
      const length = req.headers['content-length'];
      if (
        req.headers['content-encoding'] ||
        (poll
          ? req.headers['transfer-encoding'] !== undefined ||
            (length !== undefined && length !== '0')
          : req.headers['content-type'] !== 'application/json')
      ) {
        refuse(400, 'invalid_input');
        return true;
      }
      const capacity = Math.min(
        options.frameLimit,
        options.maxUnackedBytes,
        options.maxBufferedBytes
      );
      const reservation = poll
        ? capacity
        : length === undefined
          ? capacity
          : Math.max(1, Number(length));
      if (
        !Number.isSafeInteger(reservation) ||
        reservation < 1 ||
        reservation > capacity ||
        (length !== undefined && !/^\d+$/.test(length))
      ) {
        refuse(413, 'invalid_frame');
        return true;
      }
      const socketCount = sockets.get(req.socket) ?? { frames: 0, bytes: 0 };
      if (
        controllers.size >= 32 ||
        buffered + reservation > options.maxBufferedBytes ||
        socketCount.frames >= options.maxUnackedFrames ||
        socketCount.bytes + reservation > options.maxUnackedBytes
      ) {
        refuse(429, 'channel_unavailable');
        return true;
      }
      socketCount.frames++;
      socketCount.bytes += reservation;
      sockets.set(req.socket, socketCount);
      buffered += reservation;
      const controller = new AbortController();
      controllers.add(controller);
      const signal = controller.signal;
      // Poll sockets may be idle longer than ordinary frame ACKs.
      req.socket.setTimeout(poll ? 30_000 : TASK_COMMAND_ACK_TIMEOUT_MS + 1000);
      let key: string | undefined;
      let released = false;
      let wake: (() => void) | undefined;
      const unsubscribe = options.mailbox.subscribeCommands?.(() => wake?.());
      const release = () => {
        if (released) return;
        released = true;
        clearTimeout(timer);
        unsubscribe?.();
        controller.abort();
        wake?.();
        controllers.delete(controller);
        buffered -= reservation;
        socketCount.frames--;
        socketCount.bytes -= reservation;
        if (key) polls.delete(key);
      };
      const timer = setTimeout(
        () => {
          if (poll) send(res, 200, { command: null });
          else refuse(504, 'ack_timeout');
          release();
        },
        poll ? POLL_MS : TASK_COMMAND_ACK_TIMEOUT_MS
      );
      res.once('finish', release);
      res.once('close', release);
      req.once('aborted', release);
      const parts: Buffer[] = [];
      let bytes = 0;
      req.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > reservation) {
          refuse(413, 'invalid_frame');
          parts.length = 0;
        } else if (!signal.aborted) parts.push(chunk);
      });
      req.once('end', () => {
        void (async () => {
          signal.throwIfAborted();
          const token = authorization.slice(7);
          const verify = () =>
            operation(() =>
              options.identity.verify(token, AbortSignal.any([signal, AbortSignal.timeout(5000)]))
            );
          let proof = await verify();
          signal.throwIfAborted();
          if (!poll) {
            const parsed: unknown = JSON.parse(
              new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))
            );
            parts.length = 0;
            if (ack) {
              const input = validateTaskCommandAck(parsed);
              const acknowledgeCommand = options.mailbox.acknowledgeCommand;
              if (!acknowledgeCommand) throw new TaskChannelError(503, 'channel_unavailable');
              await operation(() => acknowledgeCommand(input, proof, signal));
            } else {
              const input = validateTaskCommandReceipt(parsed);
              const recordCommandReceipt = options.mailbox.recordCommandReceipt;
              if (!recordCommandReceipt) throw new TaskChannelError(503, 'channel_unavailable');
              await operation(() => recordCommandReceipt(input, proof, signal));
            }
            signal.throwIfAborted();
            send(res, 200, { stored: true });
            return;
          }
          const briefing = await operation(() => options.mailbox.readBriefing(proof, signal));
          signal.throwIfAborted();
          key = JSON.stringify([briefing.taskId, briefing.attemptId]);
          if (polls.has(key)) {
            key = undefined;
            throw new TaskChannelError(429, 'channel_unavailable');
          }
          polls.add(key);
          const pollCommand = options.mailbox.pollCommand;
          if (!pollCommand) throw new TaskChannelError(503, 'channel_unavailable');
          while (!signal.aborted) {
            // Subscribe BEFORE the read: a commit during the read cannot be lost.
            let notified = false;
            let resolveWait: (() => void) | undefined;
            wake = () => {
              notified = true;
              resolveWait?.();
            };
            const command = await operation(() => pollCommand(proof, signal));
            signal.throwIfAborted();
            if (command) {
              if (Buffer.byteLength(JSON.stringify({ command })) > reservation)
                throw new TaskChannelError(413, 'invalid_frame');
              send(res, 200, { command });
              return;
            }
            // Every read COMMIT and pool release happens before waiting here.
            if (!notified)
              await new Promise<void>((resolve) => {
                resolveWait = resolve;
                const recheck = setTimeout(resolve, 1000);
                const previous = resolveWait;
                resolveWait = () => {
                  clearTimeout(recheck);
                  previous();
                };
                if (notified || signal.aborted) resolveWait();
              });
            signal.throwIfAborted();
            proof = await verify(); // no positive Kubernetes authority cache after a wait
          }
        })().catch((error: unknown) => {
          if (signal.aborted) return;
          const safe =
            error instanceof TaskChannelError
              ? error
              : new TaskChannelError(
                  error instanceof SyntaxError ? 400 : 503,
                  error instanceof SyntaxError ? 'invalid_frame' : 'channel_unavailable'
                );
          refuse(safe.status, safe.code);
        });
      });
      return true;
    },
  };
}
