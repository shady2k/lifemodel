/** Task-only TLS ingress. No artifact bytes, cognition, or owner-intake capacity. */
import { createServer, type Server } from 'node:https';
import { createTaskChannelScheduler, type Work } from './task-channel-scheduler.js';
import { createHash } from 'node:crypto';
import { createTaskCommandChannel } from './task-command-channel.js';
import type { ServerResponse, IncomingMessage } from 'node:http';
import type { TLSSocket } from 'node:tls';
import type { Socket } from 'node:net';
import type { PlatformSettingsValues } from '../config/platform-settings.js';
import { platformSettingSpecs, validatePlatformValue } from '../config/platform-settings.js';
import {
  TaskChannelError,
  validateTaskChannelFrame,
  validateTaskTraceFrame,
} from '../ports/task-channel.js';
import type {
  TaskChannelFrame,
  TaskCommandMailbox,
  TaskTraceFrame,
  TaskChannelAck,
  TaskChannelProof,
  TaskBriefing,
  TaskLaunchIdentity,
} from '../ports/task-channel.js';
import type { Logger } from '../types/logger.js';

interface ChannelOptions {
  tls: {
    cert: string | Buffer;
    key: string | Buffer;
    read?: () => Promise<{ cert: string | Buffer; key: string | Buffer }>;
  };
  settings: PlatformSettingsValues;
  mailbox: Partial<TaskCommandMailbox> & {
    readIdentity?(proof: TaskChannelProof, signal?: AbortSignal): Promise<TaskLaunchIdentity>;
    readBriefing?(proof: TaskChannelProof, signal?: AbortSignal): Promise<TaskBriefing>;
    readTraceAuthority?(proof: TaskChannelProof, signal?: AbortSignal): Promise<TaskBriefing>;
    append(
      frame: TaskChannelFrame,
      proof: TaskChannelProof,
      signal?: AbortSignal
    ): Promise<TaskChannelAck>;
  };
  identity: { verify(token: string, signal?: AbortSignal): Promise<TaskChannelProof> };
  logger: Logger;
  onStored?: () => void;
  onTrace?: (frame: TaskTraceFrame, briefing: TaskBriefing) => void;
  readTraceAuthority?: (proof: TaskChannelProof, signal: AbortSignal) => Promise<TaskBriefing>;
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
  const traceCounts = new Map<string, { count: number; expires: number }>();
  const controllers = new Set<AbortController>();
  let buffered = 0;
  let traceBuffered = 0;
  let pending = 0;
  let pendingTraces = 0;
  let closed = false;
  const logger = options.logger.child({ component: 'task-channel' });

  // Independent task-only reservations. Authentication never occupies a mailbox
  // worker. The token key only serializes repeated credentials before verification;
  // it is not trusted as an identity and no positive proof is cached.
  const authentication = createTaskChannelScheduler(2, () => closed);
  const mailbox = createTaskChannelScheduler(workerLimit, () => closed);
  const traceAuthentication = createTaskChannelScheduler(1, () => closed);
  const traceMailbox = createTaskChannelScheduler(1, () => closed);
  const commands = createTaskCommandChannel({
    mailbox: {
      ...options.mailbox,
      readBriefing: (proof, signal) => {
        if (!options.mailbox.readBriefing) throw new TaskChannelError(503, 'channel_unavailable');
        return options.mailbox.readBriefing(proof, signal);
      },
    },
    identity: options.identity,
    frameLimit,
    maxBufferedBytes: settings['tasks.channel.maxBufferedBytes'],
    maxUnackedFrames: settings['tasks.channel.maxUnackedFrames'],
    maxUnackedBytes: settings['tasks.channel.maxUnackedBytes'],
    authentication,
    mailboxScheduler: mailbox,
    reserveBytes: (bytes) => {
      if (buffered + bytes > settings['tasks.channel.maxBufferedBytes']) return false;
      buffered += bytes;
      return true;
    },
    releaseBytes: (bytes) => {
      buffered -= bytes;
    },
    onRefused: (status, code, route) => {
      logger.warn({ status, code, route }, 'Task command request refused');
    },
  });

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
  function refuse(
    res: ServerResponse,
    status: number,
    code: string,
    context: { route: string; taskId?: string; traceId?: string }
  ): void {
    logger.warn({ status, code, ...context }, 'Task channel request refused');
    send(res, status, { code });
  }
  function receive(req: IncomingMessage, res: ServerResponse): void {
    if (commands.receive(req, res)) return;
    req.socket.setTimeout(timeoutMs);
    // Never log a raw URL: unknown paths and query strings can carry secrets.
    const route =
      (req.method === 'POST' && ['/task/trace', '/task/events'].includes(req.url ?? '')) ||
      (req.method === 'GET' && ['/task/identity', '/task/briefing'].includes(req.url ?? ''))
        ? `${req.method ?? ''} ${req.url ?? ''}`
        : 'unknown';
    let diagnosticContext: { taskId?: string; traceId?: string } = {};
    const rejectRequest = (status: number, code: string) => {
      refuse(res, status, code, { route, ...diagnosticContext });
    };
    req.on('error', () => undefined);
    res.on('error', () => undefined);
    if (closed) {
      rejectRequest(503, 'channel_stopped');
      return;
    }
    const read =
      req.method === 'GET' && (req.url === '/task/identity' || req.url === '/task/briefing');
    const trace = req.method === 'POST' && req.url === '/task/trace';
    if (!read && !trace && (req.method !== 'POST' || req.url !== '/task/events')) {
      rejectRequest(404, 'route_absent');
      return;
    }
    if (
      read &&
      (req.headers['transfer-encoding'] !== undefined ||
        (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0'))
    ) {
      rejectRequest(400, 'invalid_request');
      return;
    }
    if (
      req.headers['content-encoding'] ||
      (!read && req.headers['content-type'] !== 'application/json')
    ) {
      rejectRequest(400, 'invalid_request');
      return;
    }
    const length = req.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > frameLimit)) {
      rejectRequest(413, 'frame_too_large');
      return;
    }
    const capacity = Math.min(
      read ? 1_048_576 : frameLimit,
      settings['tasks.channel.maxUnackedBytes'],
      settings['tasks.channel.maxBufferedBytes']
    );
    // Fixed-length frames reserve their actual wire size. Chunked requests reserve
    // the entire admissible allowance and are cut off at that allowance.
    // Reads reserve their response allowance in the same bounded queue.
    const reservedBytes = read
      ? capacity
      : length === undefined
        ? capacity
        : Math.max(1, Number(length));
    if (reservedBytes > capacity) {
      rejectRequest(413, 'frame_too_large');
      return;
    }
    const socket = req.socket;
    const count = counters.get(socket) ?? { frames: 0, bytes: 0 };
    // Reserve BEFORE intake. In addition to byte bounds, at most 64 requests
    // (the tested default full-frame process capacity) may await any stage.
    if (
      (trace ? pendingTraces >= 2 : pending >= 64) ||
      count.frames >= settings['tasks.channel.maxUnackedFrames'] ||
      count.bytes + reservedBytes > settings['tasks.channel.maxUnackedBytes'] ||
      (trace ? traceBuffered : buffered) + reservedBytes >
        settings['tasks.channel.maxBufferedBytes']
    ) {
      rejectRequest(429, 'channel_saturated');
      return;
    }
    count.frames++;
    count.bytes += reservedBytes;
    if (trace) pendingTraces++;
    else pending++;
    if (!counters.has(socket)) socket.once('close', () => counters.delete(socket));
    counters.set(socket, count);
    if (trace) traceBuffered += reservedBytes;
    else buffered += reservedBytes;
    const controller = new AbortController();
    controllers.add(controller);
    const signal = controller.signal;
    const parts: Buffer[] = [];
    let bytes = 0;
    let released = false;
    let queuedWork: Work | undefined;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      if (queuedWork) {
        authentication.remove(queuedWork);
        mailbox.remove(queuedWork);
        traceAuthentication.remove(queuedWork);
        traceMailbox.remove(queuedWork);
        queuedWork = undefined;
      }
      count.frames--;
      count.bytes -= reservedBytes;
      if (trace) traceBuffered -= reservedBytes;
      else buffered -= reservedBytes;
      if (trace) pendingTraces--;
      else pending--;
      controllers.delete(controller);
      parts.length = 0;
      controller.abort();
    };
    res.once('finish', release);
    res.once('close', release);
    req.once('aborted', release);
    const timer = setTimeout(() => {
      rejectRequest(504, 'ack_timeout');
      release();
      // A peer that does not read ACKs never holds a worker or socket forever.
      socket.destroy();
    }, timeoutMs);
    req.on('data', (chunk: Buffer) => {
      if (signal.aborted) return;
      bytes += chunk.length;
      if (bytes > reservedBytes) {
        rejectRequest(413, 'frame_too_large');
        parts.length = 0;
      } else parts.push(chunk);
    });
    req.once('end', () => {
      if (signal.aborted || res.writableEnded) return;
      let frame: TaskChannelFrame | undefined;
      let traceFrame: TaskTraceFrame | undefined;
      try {
        if (trace)
          traceFrame = validateTaskTraceFrame(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)))
          );
        else if (!read)
          frame = validateTaskChannelFrame(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)))
          );
      } catch {
        rejectRequest(400, 'invalid_frame');
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
        rejectRequest(403, 'identity_denied');
        return;
      }
      const token = authorization.slice(7);
      const fail = (error: unknown) => {
        if (signal.aborted) return;
        const safe =
          error instanceof TaskChannelError
            ? error
            : new TaskChannelError(503, 'channel_unavailable');
        rejectRequest(safe.status, safe.code);
      };
      const work: Work = {
        taskId: createHash('sha256').update(token).digest('hex'),
        cancelled: () => signal.aborted,
        run: async () => {
          try {
            signal.throwIfAborted();
            const proof = await options.identity.verify(token, signal);
            signal.throwIfAborted();
            // Before storage succeeds these are diagnostic input, not authority.
            // Log only canonical generated locator shapes, never arbitrary text
            // that a verified pod could place in the more permissive wire IDs.
            const taskId = traceFrame?.taskId ?? frame?.taskId;
            const traceId = traceFrame?.span.traceId;
            if (taskId && /^task_[0-9a-f]{64}$/.test(taskId)) diagnosticContext.taskId = taskId;
            if (
              traceId &&
              /^(?:task_[0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(
                traceId
              )
            )
              diagnosticContext.traceId = traceId;
            const stored: Work = {
              // Kubernetes verifies the Job UID freshly. Different frame IDs,
              // Pod credentials and token rotations cannot create extra shares.
              taskId: proof.jobUid,
              cancelled: () => signal.aborted,
              run: async () => {
                try {
                  signal.throwIfAborted();
                  if (read) {
                    const operation =
                      req.url === '/task/identity'
                        ? options.mailbox.readIdentity?.bind(options.mailbox)
                        : options.mailbox.readBriefing?.bind(options.mailbox);
                    if (!operation) throw new TaskChannelError(503, 'channel_unavailable');
                    const result = await operation(proof, signal);
                    diagnosticContext = {
                      taskId: result.taskId,
                      ...('traceId' in result ? { traceId: result.traceId as string } : {}),
                    };
                    signal.throwIfAborted();
                    // Bound response work independently of frame limits. Never log content.
                    if (Buffer.byteLength(JSON.stringify(result)) > reservedBytes)
                      throw new TaskChannelError(503, 'channel_unavailable');
                    send(res, 200, result);
                  } else if (trace) {
                    const traceAuthority =
                      options.readTraceAuthority ??
                      options.mailbox.readTraceAuthority?.bind(options.mailbox);
                    if (!traceFrame || !traceAuthority)
                      throw new TaskChannelError(503, 'channel_unavailable');
                    // Same live won-claim authority, without terminal's exclusive row locks.
                    const briefing = await traceAuthority(proof, signal);
                    diagnosticContext = { taskId: briefing.taskId, traceId: briefing.traceId };
                    if (
                      briefing.taskId !== traceFrame.taskId ||
                      briefing.attemptId !== traceFrame.attemptId ||
                      briefing.launchId !== traceFrame.launchId ||
                      briefing.traceId !== traceFrame.span.traceId
                    )
                      throw new TaskChannelError(403, 'identity_mismatch');
                    const span = traceFrame.span;
                    if (
                      (span.component === 'task' && span.spanId !== briefing.launchId) ||
                      (span.component !== 'task' &&
                        (!span.spanId.startsWith(`${briefing.launchId}_`) ||
                          (span.parentSpanId !== briefing.launchId &&
                            !span.parentSpanId?.startsWith(`${briefing.launchId}_`))))
                    )
                      throw new TaskChannelError(400, 'invalid_frame');
                    const now = Date.now();
                    for (const [key, value] of traceCounts)
                      if (value.expires < now) traceCounts.delete(key);
                    const budget = traceCounts.get(briefing.launchId) ?? {
                      count: 0,
                      expires: now + 86400000,
                    };
                    // Memory is bounded independently of the number of presented IDs.
                    if (
                      budget.count >= 2048 ||
                      (!traceCounts.has(briefing.launchId) && traceCounts.size >= 1024)
                    ) {
                      send(res, 200, { accepted: false });
                      return;
                    }
                    budget.count++;
                    traceCounts.set(briefing.launchId, budget);
                    try {
                      options.onTrace?.(traceFrame, briefing);
                    } catch {
                      /* disposable */
                    }
                    send(res, 200, { accepted: true });
                  } else {
                    if (!frame) throw new TaskChannelError(400, 'invalid_frame');
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
                  }
                } catch (error) {
                  fail(error);
                }
              },
            };
            queuedWork = stored;
            (trace ? traceMailbox : mailbox).add(stored);
          } catch (error) {
            fail(error);
          }
        },
      };
      queuedWork = work;
      (trace ? traceAuthentication : authentication).add(work);
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
        commands.stop();
        clearTimeout(reloadTimer);
        authentication.clear();
        mailbox.clear();
        traceAuthentication.clear();
        traceMailbox.clear();
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
