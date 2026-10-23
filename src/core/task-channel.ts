/** Task-only TLS ingress. No artifact bytes, cognition, or owner-intake capacity. */
import { createServer, type Server } from 'node:https';
import type { ServerResponse, IncomingMessage } from 'node:http';
import type { TLSSocket } from 'node:tls';
import type { Socket } from 'node:net';
import type { PlatformSettingsValues } from '../config/platform-settings.js';
import { platformSettingSpecs, validatePlatformValue } from '../config/platform-settings.js';
import { TaskChannelError, validateTaskChannelFrame } from '../ports/task-channel.js';
import type { TaskChannelFrame, TaskChannelAck, TaskChannelProof } from '../ports/task-channel.js';
import type { Logger } from '../types/logger.js';

interface ChannelOptions {
  tls: {
    cert: string | Buffer;
    key: string | Buffer;
    read?: () => Promise<{ cert: string | Buffer; key: string | Buffer }>;
  };
  settings: PlatformSettingsValues;
  mailbox: {
    append(
      frame: TaskChannelFrame,
      proof: TaskChannelProof,
      signal?: AbortSignal
    ): Promise<TaskChannelAck>;
  };
  identity: { verify(token: string, signal?: AbortSignal): Promise<TaskChannelProof> };
  logger: Logger;
  onStored?: () => void;
}
interface Work {
  taskId: string;
  run(): Promise<void>;
  cancelled(): boolean;
}

export function createTaskChannel(options: ChannelOptions): {
  server: Server;
  stop(deadline: number): Promise<void>;
} {
  const settings = { ...options.settings };
  for (const spec of platformSettingSpecs) {
    if (!spec.key.startsWith('tasks.channel.')) continue;
    if (!validatePlatformValue(spec.key, settings[spec.key]).ok)
      throw new TaskChannelError(500, 'channel_config');
  }
  const frameLimit = settings['tasks.channel.maxFrameBytes'];
  const timeoutMs = settings['tasks.channel.ackTimeoutMs'];
  const workerLimit = Math.min(
    settings['tasks.channel.workers'],
    settings['tasks.channel.sqlConnections']
  );
  const sockets = new Set<Socket>();
  const counters = new Map<Socket, { frames: number; bytes: number }>();
  const controllers = new Set<AbortController>();
  const queues = new Map<string, Work[]>();
  const activeTasks = new Set<string>();
  const ready: string[] = [];
  let active = 0;
  let buffered = 0;
  let closed = false;
  const logger = options.logger.child({ component: 'task-channel' });

  function schedule(): void {
    while (!closed && active < workerLimit && ready.length) {
      const taskId = ready.shift();
      if (!taskId || activeTasks.has(taskId)) continue;
      const queue = queues.get(taskId);
      const work = queue?.shift();
      if (!work) {
        queues.delete(taskId);
        continue;
      }
      if (work.cancelled()) {
        if (queue?.length) ready.push(taskId);
        else queues.delete(taskId);
        continue;
      }
      active++;
      activeTasks.add(taskId);
      // One frame from this task, then move the task to the tail of the pass.
      void work.run().finally(() => {
        active--;
        activeTasks.delete(taskId);
        if (queues.get(taskId)?.length) ready.push(taskId);
        else queues.delete(taskId);
        schedule();
      });
    }
  }
  function send(res: ServerResponse, status: number, body: unknown): void {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...(status === 429 ? { 'retry-after': '1' } : {}),
      ...(status !== 200 ? { connection: 'close' } : {}),
    });
    res.end(JSON.stringify(body));
  }
  function refuse(res: ServerResponse, status: number, code: string): void {
    logger.warn({ status, code }, 'Task channel request refused');
    send(res, status, { code });
  }
  function receive(req: IncomingMessage, res: ServerResponse): void {
    req.on('error', () => undefined);
    res.on('error', () => undefined);
    if (closed) {
      refuse(res, 503, 'channel_stopped');
      return;
    }
    if (req.method !== 'POST' || req.url !== '/task/events') {
      refuse(res, 404, 'route_absent');
      return;
    }
    if (req.headers['content-encoding'] || req.headers['content-type'] !== 'application/json') {
      refuse(res, 400, 'invalid_request');
      return;
    }
    const length = req.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > frameLimit)) {
      refuse(res, 413, 'frame_too_large');
      return;
    }
    const socket = req.socket;
    const count = counters.get(socket) ?? { frames: 0, bytes: 0 };
    // Reserve the entire bounded frame BEFORE intake; slow/chunked bodies cannot
    // escape the process or connection memory budgets.
    if (
      count.frames >= settings['tasks.channel.maxUnackedFrames'] ||
      count.bytes + frameLimit > settings['tasks.channel.maxUnackedBytes'] ||
      buffered + frameLimit > settings['tasks.channel.maxBufferedBytes']
    ) {
      refuse(res, 429, 'channel_saturated');
      return;
    }
    count.frames++;
    count.bytes += frameLimit;
    if (!counters.has(socket)) socket.once('close', () => counters.delete(socket));
    counters.set(socket, count);
    buffered += frameLimit;
    const controller = new AbortController();
    controllers.add(controller);
    const signal = controller.signal;
    const parts: Buffer[] = [];
    let bytes = 0;
    let released = false;
    let queuedWork: Work | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      if (queuedWork) {
        const queue = queues.get(queuedWork.taskId);
        const index = queue?.indexOf(queuedWork) ?? -1;
        if (queue && index >= 0) queue.splice(index, 1);
        if (queue?.length === 0) {
          queues.delete(queuedWork.taskId);
          const readyIndex = ready.indexOf(queuedWork.taskId);
          if (readyIndex >= 0) ready.splice(readyIndex, 1);
        }
        queuedWork = undefined;
      }
      count.frames--;
      count.bytes -= frameLimit;
      buffered -= frameLimit;
      controllers.delete(controller);
      parts.length = 0;
      controller.abort();
    };
    res.once('finish', release);
    res.once('close', release);
    req.once('aborted', release);
    timer = setTimeout(() => {
      refuse(res, 504, 'ack_timeout');
      release();
      // A peer that does not read ACKs never holds a worker or socket forever.
      socket.destroy();
    }, timeoutMs);
    req.on('data', (chunk: Buffer) => {
      if (signal.aborted) return;
      bytes += chunk.length;
      if (bytes > frameLimit) {
        refuse(res, 413, 'frame_too_large');
        parts.length = 0;
      } else parts.push(chunk);
    });
    req.once('end', () => {
      if (signal.aborted || res.writableEnded) return;
      let frame: TaskChannelFrame;
      try {
        frame = validateTaskChannelFrame(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)))
        );
      } catch {
        refuse(res, 400, 'invalid_frame');
        return;
      } finally {
        parts.length = 0;
      }
      const authorization = req.headers.authorization;
      const authCount = req.rawHeaders.filter(
        (value, index) => index % 2 === 0 && value.toLowerCase() === 'authorization'
      ).length;
      if (
        authCount !== 1 ||
        typeof authorization !== 'string' ||
        !/^Bearer [^\s]+$/.test(authorization)
      ) {
        refuse(res, 403, 'identity_denied');
        return;
      }
      const token = authorization.slice(7);
      const work: Work = {
        taskId: frame.taskId,
        cancelled: () => signal.aborted,
        run: async () => {
          try {
            signal.throwIfAborted();
            const proof = await options.identity.verify(token, signal);
            signal.throwIfAborted();
            let ack: TaskChannelAck;
            try {
              ack = await options.mailbox.append(frame, proof, signal);
            } finally {
              // A disconnect can race COMMIT. Replay must not depend on the ACK.
              options.onStored?.();
            }
            signal.throwIfAborted();
            // The committed mailbox row is the ACK boundary, not Signal emission.
            send(res, 200, ack);
          } catch (error) {
            if (signal.aborted) return;
            const safe =
              error instanceof TaskChannelError
                ? error
                : new TaskChannelError(503, 'channel_unavailable');
            refuse(res, safe.status, safe.code);
          }
        },
      };
      queuedWork = work;
      const queue = queues.get(frame.taskId) ?? [];
      queue.push(work);
      queues.set(frame.taskId, queue);
      if (!activeTasks.has(frame.taskId) && !ready.includes(frame.taskId)) ready.push(frame.taskId);
      schedule();
    });
  }
  const server = createServer(
    {
      cert: options.tls.cert,
      key: options.tls.key,
      minVersion: 'TLSv1.2',
      maxHeaderSize: 20 * 1024,
    },
    receive
  );
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleReload(): void {
    if (closed || !options.tls.read) return;
    reloadTimer = setTimeout(() => {
      void options.tls
        .read?.()
        .then((leaf) => {
          if (leaf && !closed) server.setSecureContext(leaf);
        })
        .catch(() => {
          logger.warn({ code: 'certificate_reload_failed' }, 'Task channel TLS reload failed');
        })
        .finally(scheduleReload);
    }, 60_000);
    reloadTimer.unref();
  }
  scheduleReload();
  server.on('error', () => undefined);
  server.on('tlsClientError', () => undefined);
  server.on('clientError', (_error, socket) => {
    socket.destroy();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => {
      sockets.delete(socket);
    });
  });
  server.on('secureConnection', (socket: TLSSocket) => {
    socket.on('error', () => undefined);
  });
  server.headersTimeout = timeoutMs;
  server.requestTimeout = timeoutMs;
  server.keepAliveTimeout = timeoutMs;
  server.setTimeout(timeoutMs, (socket) => {
    socket.destroy();
  });
  let stopping: Promise<void> | undefined;
  return {
    server,
    stop: (deadline) =>
      (stopping ??= (async () => {
        closed = true;
        clearTimeout(reloadTimer);
        queues.clear();
        ready.length = 0;
        for (const controller of controllers) controller.abort();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
          server.close(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      })()),
  };
}
