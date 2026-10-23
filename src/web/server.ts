import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { IOwnerMessageIntake } from '../ports/owner-message-intake.js';
import type { CreatureStateReader } from '../ports/creature-state.js';
import type { TranscriptReader, TranscriptRow } from '../ports/transcript.js';
import type {
  CreatureStateEvent,
  InstanceResponse,
  MessageAcceptedResponse,
  MessageInput,
  ModelStatusEvent,
  TranscriptEvent,
  TranscriptMessage,
  TranscriptPage as WebTranscriptPage,
} from './contract.js';
import type { ModelStatusSource } from './model-status.js';
import type { AttachmentAuthorizer } from '../ports/message-attachment.js';
import {
  ARTIFACT_ID,
  ArtifactUnavailableError,
  validArtifactRange,
  type TaskArtifactReader,
  type OwnerDownloadSessions,
} from '../ports/task-artifact-download.js';
import { Transform } from 'node:stream';

const UUID_V7 =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';
const WINDOW_MS = 60_000;
const SENDS_PER_WINDOW = 60;
const MAX_RATE_KEYS = 10_000;
const MAX_PAGE_SIZE = 50;
const MAX_STREAM_QUEUE = 100;
const MAX_STREAMS_PER_SESSION = 4;
const STREAM_MAX_AGE_MS = 15 * 60_000;
/**
 * A stream slot is leased in the shared store, so the bound holds across web
 * module instances. The lease is only good while its stream renews it: a
 * connection that dies without releasing it — a closed tab, a killed or
 * restarted module — frees its slot within one renewal window instead of
 * blocking the owner for the whole stream age.
 *
 * The stream holds a local deadline taken from its last confirmed lease. A
 * renewal that errors, times out or lands after that deadline never moves it,
 * so a module that cannot reach the store — a replica-specific outage — ends
 * its streams at the deadline instead of streaming on a slot the store may
 * already have handed to another replica.
 */
const STREAM_LEASE_TTL_MS = 15_000;
/** A renewal every third of the lease's life, never slower than the ADR's 5 s. */
const LEASE_RENEW_RATIO = 3;
const LEASE_RENEW_MAX_MS = 5_000;
const LEASE_RENEW_TIMEOUT_MS = 500;
const STATE_POLL_MS = 250;
const HEARTBEAT_MS = 15_000;
const SESSION_COOKIE_NAME = '__Host-lm_session';

export interface WebRuntimeMetrics {
  intakeFailures: number;
  sseLag: number;
  reconnects: number;
}

export interface WebServerOptions {
  allowedOrigin: string;
  instanceName: string;
  appDirectory: string;
  runtimeMetrics: WebRuntimeMetrics;
  intake: IOwnerMessageIntake;
  transcript: TranscriptReader;
  creatureState: CreatureStateReader;
  /**
   * The gateway's health, polled once for every client of this module
   * (ADR-013 D6). It is independent of the core's snapshot and is part of the
   * stream's change key, so a status change alone pushes an update.
   */
  modelStatus: ModelStatusSource;
  logger: Pick<FastifyBaseLogger, 'info'>;
  bodyLimit?: number;
  attachments?: {
    authorizer: AttachmentAuthorizer;
    reader: TaskArtifactReader;
    sessions: OwnerDownloadSessions;
    /** Recheck idle transfers too; bytes always require a fresh session proof. */
    sessionCheckMs?: number;
  };
  /** The ADR's 15 minutes; a test shortens it to watch a stream end on its own. */
  streamMaxAgeMs?: number;
  /** The lease's life; a test shortens it to watch a lapsed stream end. */
  streamLeaseTtlMs?: number;
}

interface StreamEvent {
  event: 'message' | 'state' | 'model';
  data: TranscriptMessage | CreatureStateEvent | ModelStatusEvent | null;
  id?: string;
}

class BoundedQueue<T> {
  private values: T[] = [];
  private waiter: ((value: T | undefined) => void) | undefined;
  closed = false;

  push(value: T): boolean {
    if (this.closed) return false;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter(value);
      return true;
    }
    if (this.values.length >= MAX_STREAM_QUEUE) {
      this.close();
      return false;
    }
    this.values.push(value);
    return true;
  }

  next(): Promise<T | undefined> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve(value);
    if (this.closed) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  close(): void {
    this.closed = true;
    this.waiter?.(undefined);
    this.waiter = undefined;
  }
}

export function createWebServer(options: WebServerOptions): FastifyInstance {
  if (!options.allowedOrigin) throw new Error('allowedOrigin is required');
  if (!options.instanceName) throw new Error('instanceName is required');
  if (!options.appDirectory) throw new Error('appDirectory is required');
  if (!options.runtimeMetrics) throw new Error('runtimeMetrics is required');
  let allowed: URL;
  try {
    allowed = new URL(options.allowedOrigin);
  } catch {
    throw new Error('allowedOrigin must be an absolute HTTPS origin');
  }
  if (
    allowed.origin !== options.allowedOrigin ||
    options.allowedOrigin !== `https://${options.instanceName}.local` ||
    allowed.protocol !== 'https:' ||
    allowed.hostname !== `${options.instanceName}.local`
  )
    throw new Error('allowedOrigin must be an exact HTTPS origin');

  const server = Fastify({
    bodyLimit: options.bodyLimit ?? 100 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  const appDirectory = path.resolve(options.appDirectory);
  const streamMaxAgeMs = options.streamMaxAgeMs ?? STREAM_MAX_AGE_MS;
  const streamLeaseTtlMs = options.streamLeaseTtlMs ?? STREAM_LEASE_TTL_MS;
  if (!Number.isFinite(streamLeaseTtlMs) || streamLeaseTtlMs <= 0)
    throw new Error('streamLeaseTtlMs must be a positive number of milliseconds');
  const leaseRenewMs = Math.max(
    1,
    Math.min(Math.floor(streamLeaseTtlMs / LEASE_RENEW_RATIO), LEASE_RENEW_MAX_MS)
  );
  const rates = new Map<string, { start: number; count: number }>();
  const activeStreams = new Map<string, number>();
  let statusReaders = 0;
  const schema = {
    body: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'text'],
      properties: {
        id: { type: 'string', pattern: UUID_V7 },
        text: { type: 'string', minLength: 1, maxLength: 16 * 1024 },
        replyTo: { type: 'string', pattern: '^[1-9][0-9]*$' },
      },
    },
  } as const;

  const csp =
    "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; img-src 'self'; connect-src 'self'";
  server.addHook('onRequest', async (request, reply) => {
    if (request.method === 'POST' && request.url.split('?')[0] === '/api/messages') {
      const origin = request.headers.origin;
      if (!origin || origin === 'null' || !isAllowedOrigin(origin, options.allowedOrigin))
        return reply
          .code(403)
          .header('Cache-Control', 'no-store')
          .send({ error: 'forbidden_origin' });
    }
  });
  server.addHook('onSend', async (_request, reply) => {
    if (!reply.hasHeader('Content-Security-Policy')) reply.header('Content-Security-Policy', csp);
    if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
  });
  let artifactTransfers = 0;
  const artifactLifecycles = new Set<AbortController>();
  server.addHook('preClose', async () => {
    for (const lifecycle of artifactLifecycles) lifecycle.abort();
  });
  server.get<{ Params: { artifactId: string } }>(
    '/api/attachments/:artifactId',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const downloads = options.attachments;
      if (!downloads) return reply.code(503).send({ error: 'artifact_not_available' });
      const lifecycle = new AbortController();
      artifactLifecycles.add(lifecycle);
      request.raw.on('error', () => undefined);
      reply.raw.on('error', () => undefined);
      let timer: ReturnType<typeof setInterval> | undefined;
      const finish = () => {
        artifactLifecycles.delete(lifecycle);
        lifecycle.abort();
        if (timer) clearInterval(timer);
      };
      reply.raw.once('close', finish);
      const deadline = setTimeout(() => {
        lifecycle.abort();
        reply.raw.destroy();
      }, 15 * 60_000);
      deadline.unref();
      let handedOff = false;
      let slot = false;
      try {
        const authenticated = await downloads.sessions.verify(
          request.headers.cookie,
          lifecycle.signal
        );
        if (!authenticated) return reply.code(401).send({ error: 'session_expired' });
        const id = request.params.artifactId;
        // Reject encoded IDs as well as traversal; only one canonical opaque ID enters storage.
        if (!ARTIFACT_ID.test(id) || request.raw.url !== `/api/attachments/${id}`)
          return reply.code(404).send({ error: 'artifact_not_available' });
        const attachment = await downloads.authorizer.findAttachment(id);
        if (!attachment) return reply.code(404).send({ error: 'artifact_not_available' });
        const range = request.headers.range;
        if (range !== undefined && !validArtifactRange(range))
          return reply.code(416).send({ error: 'invalid_range' });
        if (artifactTransfers >= 8)
          return reply.code(503).send({ error: 'artifact_not_available' });
        artifactTransfers += 1;
        slot = true;
        const opened = await downloads.reader.openTaskArtifact(id, range, lifecycle.signal);
        opened.body.on('error', () => undefined);
        if (
          lifecycle.signal.aborted ||
          opened.body.destroyed ||
          opened.body.errored ||
          opened.size !== attachment.size
        ) {
          opened.body.destroy();
          throw new ArtifactUnavailableError(503);
        }
        const safeTypes = new Set([
          'application/octet-stream',
          'application/pdf',
          'application/zip',
          'text/plain',
          'text/csv',
          'application/json',
          'image/png',
          'image/jpeg',
          'image/webp',
        ]);
        reply.header(
          'Content-Type',
          safeTypes.has(attachment.contentType)
            ? attachment.contentType
            : 'application/octet-stream'
        );
        const escapedName = encodeURIComponent(attachment.name).replace(
          /[!'()*]/g,
          (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
        );
        reply.header(
          'Content-Disposition',
          `attachment; filename="download"; filename*=UTF-8''${escapedName}`
        );
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header('Content-Security-Policy', 'sandbox');
        reply.header('Accept-Ranges', 'bytes');
        reply.header('Content-Length', opened.end - opened.start + 1);
        if (opened.partial)
          reply.header('Content-Range', `bytes ${opened.start}-${opened.end}/${opened.size}`);
        reply.code(opened.partial ? 206 : 200);
        let checking = false;
        const stop = () => {
          opened.body.destroy();
          guarded.destroy(new Error('artifact_not_available'));
        };
        const guarded = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            // A current loader proof gates every outgoing chunk, including after logout.
            void downloads.sessions.verify(request.headers.cookie, lifecycle.signal).then(
              (valid) =>
                callback(valid ? null : new Error('session_expired'), valid ? chunk : undefined),
              () => callback(new Error('owner_auth_unavailable'))
            );
          },
        });
        guarded.on('error', () => undefined);
        opened.body.on('error', (error) => guarded.destroy(error));
        opened.body.once('close', () => {
          if (!opened.body.readableEnded) guarded.destroy(new Error('artifact_incomplete'));
        });
        guarded.once('close', () => {
          opened.body.destroy();
          finish();
        });
        lifecycle.signal.addEventListener('abort', stop, { once: true });
        timer = setInterval(() => {
          if (checking) return;
          checking = true;
          void downloads.sessions
            .verify(request.headers.cookie, lifecycle.signal)
            .then((valid) => {
              if (!valid) stop();
            }, stop)
            .finally(() => {
              checking = false;
            });
        }, downloads.sessionCheckMs ?? 5_000);
        timer.unref();
        const cleanup = () => {
          clearTimeout(deadline);
          if (slot) {
            artifactTransfers -= 1;
            slot = false;
          }
          lifecycle.signal.removeEventListener('abort', stop);
          finish();
        };
        guarded.once('close', cleanup);
        handedOff = true;
        opened.body.pipe(guarded);
        return reply.send(guarded);
      } catch (error) {
        return reply
          .code(error instanceof ArtifactUnavailableError ? error.status : 503)
          .send({ error: 'artifact_not_available' });
      } finally {
        if (!handedOff) {
          clearTimeout(deadline);
          if (slot) artifactTransfers -= 1;
          finish();
        }
      }
    }
  );

  server.get('/api/instance', async (_request, reply) => {
    const instance: InstanceResponse = {
      name: options.instanceName,
      loaderUrl: `https://boot-${options.instanceName}.local/`,
    };
    return reply.code(200).send(instance);
  });
  server.get('/*', async (request, reply) => {
    const requested = request.url.split('?')[0] ?? '/';
    let relative: string;
    try {
      relative = requested === '/' ? 'index.html' : decodeURIComponent(requested.slice(1));
    } catch {
      return reply.code(404).send({ error: 'not_found' });
    }
    const filename = path.resolve(appDirectory, relative);
    if (filename !== appDirectory && !filename.startsWith(`${appDirectory}${path.sep}`))
      return reply.code(404).send({ error: 'not_found' });
    let body: Buffer;
    let servedPath = filename;
    try {
      body = await readFile(filename);
    } catch {
      if (requested.startsWith('/api/') || path.extname(requested))
        return reply.code(404).send({ error: 'not_found' });
      servedPath = path.join(appDirectory, 'index.html');
      try {
        body = await readFile(servedPath);
      } catch {
        return reply.code(404).send({ error: 'not_found' });
      }
    }
    const ext = path.extname(servedPath);
    const contentTypes: Record<string, string> = {
      '.css': 'text/css; charset=utf-8',
      '.html': 'text/html; charset=utf-8',
      '.ico': 'image/x-icon',
      '.jpeg': 'image/jpeg',
      '.jpg': 'image/jpeg',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.webp': 'image/webp',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
    };
    reply.header('Content-Type', contentTypes[ext] ?? 'application/octet-stream');
    const assetPath = path.relative(appDirectory, servedPath).split(path.sep).join('/');
    if (assetPath.startsWith('assets/') && /-[A-Za-z0-9_-]{8,}\./.test(path.basename(servedPath)))
      reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    return reply.send(body);
  });

  server.get<{ Querystring: { before?: string; after?: string; limit?: string } }>(
    '/api/transcript',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const limit = request.query.limit === undefined ? MAX_PAGE_SIZE : Number(request.query.limit);
      const before = request.query.before;
      const after = request.query.after;
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > MAX_PAGE_SIZE ||
        (before !== undefined && after !== undefined) ||
        (before !== undefined && !/^(0|[1-9][0-9]*)$/.test(before)) ||
        (after !== undefined && !/^(0|[1-9][0-9]*)$/.test(after))
      ) {
        return reply.code(400).send({ error: 'invalid_query' });
      }
      try {
        const page = await options.transcript.readTranscript({
          ...(before === undefined ? {} : { before }),
          ...(after === undefined ? {} : { after }),
          limit,
        });
        return { messages: page.rows, cursor: page.cursor } satisfies WebTranscriptPage;
      } catch {
        return reply.code(400).send({ error: 'invalid_query' });
      }
    }
  );

  server.get<{ Querystring: { after?: string } }>('/api/events', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const lastEventId = request.headers['last-event-id'];
    if (typeof lastEventId === 'string' && lastEventId.length > 0)
      options.runtimeMetrics.reconnects += 1;
    const after =
      typeof lastEventId === 'string' && lastEventId.length > 0
        ? lastEventId
        : (request.query.after ?? '0');
    if (!/^(0|[1-9][0-9]*)$/.test(after)) return reply.code(400).send({ error: 'invalid_cursor' });

    const session = getSessionKey(request.headers.cookie, request.ip);
    const streamCount = activeStreams.get(session) ?? 0;
    if (streamCount >= MAX_STREAMS_PER_SESSION)
      return await reply.code(429).send({ error: 'too_many_streams' });
    activeStreams.set(session, streamCount + 1);
    let statusReaderReleased = false;
    const releaseStatusReader = () => {
      if (statusReaderReleased) return;
      statusReaderReleased = true;
      statusReaders = Math.max(0, statusReaders - 1);
      if (statusReaders === 0) options.modelStatus.stop();
    };
    statusReaders += 1;
    if (statusReaders === 1) options.modelStatus.start();

    // The stream's own deadline starts before lease acquisition.
    const lifecycle = new AbortController();
    let leaseId: string | null = null;
    let ended = false;
    let handedOff = false;
    let renewTimer: ReturnType<typeof setInterval> | undefined;
    let leaseDeadline = 0;
    let leaseDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const queue = new BoundedQueue<StreamEvent>();
    const admissionDeadline = Date.now() + streamMaxAgeMs;
    const admissionTimer = setTimeout(() => {
      lifecycle.abort();
    }, streamMaxAgeMs);
    const releaseBounded = async () => {
      const heldLeaseId = leaseId;
      if (!heldLeaseId) return;
      leaseId = null;
      await withTimeout(
        options.transcript.releaseStreamLease(session, heldLeaseId),
        new AbortController().signal,
        500
      ).catch(() => undefined);
    };
    const closeLifecycle = () => {
      if (ended) return;
      ended = true;
      lifecycle.abort();
      queue.close();
      clearTimeout(admissionTimer);
      if (renewTimer !== undefined) clearInterval(renewTimer);
      renewTimer = undefined;
      if (leaseDeadlineTimer !== undefined) clearTimeout(leaseDeadlineTimer);
      leaseDeadlineTimer = undefined;
      const remaining = (activeStreams.get(session) ?? 1) - 1;
      if (remaining <= 0) activeStreams.delete(session);
      else activeStreams.set(session, remaining);
      releaseStatusReader();
      void releaseBounded();
    };
    const onRequestClose = () => {
      if (!handedOff) closeLifecycle();
    };
    reply.raw.once('close', onRequestClose);
    const remainingAdmission = () => Math.max(0, admissionDeadline - Date.now());
    // The lease's life is measured from before the acquisition, so a slow
    // acquisition never extends it beyond what the store was asked for.
    const acquireExpiry = Date.now() + streamLeaseTtlMs;
    try {
      const acquire = options.transcript.acquireStreamLease(session, acquireExpiry);
      void acquire
        .then((value) => {
          if (value && (ended || lifecycle.signal.aborted)) {
            leaseId = value;
            void releaseBounded();
          }
        })
        .catch(() => undefined);
      const lease = await withTimeout(
        acquire,
        lifecycle.signal,
        Math.min(1_000, remainingAdmission())
      );
      if (!lease) {
        closeLifecycle();
        return await reply.code(429).send({ error: 'too_many_streams' });
      }
      leaseId = lease;
      // If acquisition settled after disconnect/timeout, immediately retire its lease.
      if (ended || lifecycle.signal.aborted) {
        closeLifecycle();
        await releaseBounded();
        return await reply.code(503).send({ error: 'stream_unavailable' });
      }
      try {
        const latest = await withTimeout(
          options.transcript.readTranscript({ after, limit: 1 }),
          lifecycle.signal,
          Math.min(1_000, remainingAdmission())
        );
        options.runtimeMetrics.sseLag =
          latest.cursor === null ? 0 : Math.max(0, Number(BigInt(latest.cursor) - BigInt(after)));
      } catch {
        // Lag is optional; it cannot change successful lease admission.
        options.runtimeMetrics.sseLag = 0;
      }
      if (ended || lifecycle.signal.aborted) {
        closeLifecycle();
        return await reply.code(503).send({ error: 'stream_unavailable' });
      }
    } catch {
      options.runtimeMetrics.sseLag = 0;
      closeLifecycle();
      return await reply.code(503).send({ error: 'stream_unavailable' });
    }
    clearTimeout(admissionTimer);

    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Content-Security-Policy': csp,
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();

    const abort = lifecycle;
    let previousState: string | null = null;
    let stateReadInFlight = false;
    let stateFreshnessTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (ended) return;
      closeLifecycle();
      clearInterval(stateTimer);
      clearInterval(heartbeatTimer);
      if (stateFreshnessTimer) clearTimeout(stateFreshnessTimer);
      clearTimeout(maxAgeTimer);
      if (!response.writableEnded) response.end();
    };
    handedOff = true;
    reply.raw.removeListener('close', onRequestClose);
    response.on('close', cleanup);
    /**
     * Holds the stream to the last lease the store confirmed. Only an
     * acquisition or a renewal the store answered calls this, so no error, no
     * timeout and no late answer can keep a stream past its lease: at the
     * deadline the stream ends, and the page reconnects and is admitted afresh.
     */
    const holdLeaseDeadline = (expiresAt: number) => {
      if (ended) return;
      leaseDeadline = expiresAt;
      if (leaseDeadlineTimer !== undefined) clearTimeout(leaseDeadlineTimer);
      leaseDeadlineTimer = setTimeout(
        () => {
          leaseDeadlineTimer = undefined;
          if (ended) return;
          if (Date.now() >= leaseDeadline) cleanup();
          else holdLeaseDeadline(leaseDeadline);
        },
        Math.max(0, expiresAt - Date.now())
      );
    };
    holdLeaseDeadline(acquireExpiry);
    const renewLease = async () => {
      const heldLeaseId = leaseId;
      if (!heldLeaseId || ended) return;
      const expiresAt = Date.now() + streamLeaseTtlMs;
      try {
        const stillHeld = await withTimeout(
          options.transcript.renewStreamLease(session, heldLeaseId, expiresAt),
          new AbortController().signal,
          LEASE_RENEW_TIMEOUT_MS
        );
        // A lease the store no longer holds would let this stream run uncounted.
        // It ends here, and the page reconnects and is admitted afresh.
        if (!stillHeld) {
          cleanup();
          return;
        }
        holdLeaseDeadline(expiresAt);
      } catch {
        // A store that cannot answer keeps the stream only to the lease it last
        // confirmed: the deadline timer ends the stream when that runs out.
      }
    };
    renewTimer = setInterval(() => {
      void renewLease();
    }, leaseRenewMs);

    let previousModelStatus: string | null = null;
    const publishModelStatus = () => {
      // The status is read from the poller's cache, so a hanging gateway can
      // never delay this loop; nothing is sent before the first answer.
      if (!options.modelStatus.settled()) return;
      const status = options.modelStatus.read();
      const key = JSON.stringify(status);
      if (key === previousModelStatus) return;
      previousModelStatus = key;
      if (!queue.push({ event: 'model', data: status })) cleanup();
    };
    const publishUnavailable = () => {
      previousState = 'unavailable';
      if (!queue.push({ event: 'state', data: null })) cleanup();
    };
    const publishState = (): Promise<void> => {
      if (ended || stateReadInFlight) return Promise.resolve();
      stateReadInFlight = true;
      let settled = false;
      let resolveFreshness!: () => void;
      const freshness = new Promise<void>((resolve) => {
        resolveFreshness = resolve;
      });
      stateFreshnessTimer = setTimeout(() => {
        if (!settled && !ended) publishUnavailable();
        resolveFreshness();
      }, STATE_POLL_MS);
      const read = options.creatureState
        .readCreatureState()
        .then((state) => {
          if (ended || settled) return;
          if (state === null) {
            publishUnavailable();
            return;
          }
          const webState: CreatureStateEvent = {
            state: state.state,
            epoch: String(state.epoch),
            publishedAt: new Date(state.publishedAt).toISOString(),
          };
          const key = JSON.stringify(webState);
          if (key !== previousState) {
            previousState = key;
            const stateEvent: Extract<TranscriptEvent, { type: 'state' }> = {
              type: 'state',
              data: webState,
            };
            if (!queue.push({ event: stateEvent.type, data: stateEvent.data })) cleanup();
          }
        })
        .catch(() => {
          if (!ended && !settled) publishUnavailable();
        })
        .finally(() => {
          settled = true;
          if (stateFreshnessTimer) clearTimeout(stateFreshnessTimer);
          stateFreshnessTimer = undefined;
          stateReadInFlight = false;
          resolveFreshness();
        });
      return Promise.race([read, freshness]);
    };
    const stateTimer = setInterval(() => {
      void publishState();
      publishModelStatus();
    }, STATE_POLL_MS);
    const heartbeatTimer = setInterval(() => {
      if (!ended && !response.write(': heartbeat\n\n')) response.once('drain', () => undefined);
    }, HEARTBEAT_MS);
    const maxAgeTimer = setTimeout(cleanup, Math.max(0, admissionDeadline - Date.now()));
    void (async () => {
      let iterator: AsyncIterator<TranscriptRow> | undefined;
      try {
        await publishState();
        if (ended) return;
        publishModelStatus();
        iterator = options.transcript.watchTranscript(after, abort.signal)[Symbol.asyncIterator]();
        while (!abort.signal.aborted) {
          const next = await iterator.next();
          if (next.done) break;
          const messageEvent: Extract<TranscriptEvent, { type: 'message' }> = {
            type: 'message',
            data: next.value satisfies TranscriptMessage,
          };
          if (
            !queue.push({
              event: messageEvent.type,
              id: messageEvent.data.sequence,
              data: messageEvent.data,
            })
          ) {
            cleanup();
            return;
          }
        }
      } catch {
        cleanup();
      } finally {
        await iterator?.return?.();
      }
    })();
    void (async () => {
      while (!ended) {
        const event = await queue.next();
        if (!event || ended) break;
        const frame = `${event.id === undefined ? '' : `id: ${event.id}\n`}event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
        if (!response.write(frame))
          await new Promise<void>((resolve) => response.once('drain', resolve));
      }
      cleanup();
    })();
  });

  server.post<{ Body: MessageInput }>('/api/messages', { schema }, async (request, reply) => {
    const origin = request.headers.origin;
    if (!origin || origin === 'null' || !isAllowedOrigin(origin, options.allowedOrigin)) {
      options.logger.info(
        { requestId: request.id, result: 'origin_refused' },
        'Owner message intake'
      );
      return reply
        .code(403)
        .header('Cache-Control', 'no-store')
        .send({ error: 'forbidden_origin' });
    }
    const body = request.body;
    if (!body.text.trim() || Buffer.byteLength(body.text, 'utf8') > 16 * 1024) {
      options.logger.info(
        { requestId: request.id, clientId: body.id, result: 'invalid_body' },
        'Owner message intake'
      );
      return reply.code(400).header('Cache-Control', 'no-store').send({ error: 'invalid_body' });
    }
    const now = Date.now();
    const rate = rates.get(request.ip);
    if (rate && now - rate.start < WINDOW_MS && rate.count >= SENDS_PER_WINDOW) {
      options.logger.info(
        { requestId: request.id, clientId: body.id, result: 'rate_limited' },
        'Owner message intake'
      );
      return reply.code(429).header('Cache-Control', 'no-store').send({ error: 'rate_limited' });
    }
    if (!rate || now - rate.start >= WINDOW_MS) {
      if (rates.size >= MAX_RATE_KEYS) rates.delete(rates.keys().next().value as string);
      rates.set(request.ip, { start: now, count: 1 });
    } else rate.count += 1;

    try {
      const result = await options.intake.acceptOwnerMessage(body.id, body.text, body.replyTo);
      options.logger.info(
        { requestId: request.id, clientId: body.id, result: result.status },
        'Owner message intake'
      );
      reply.header('Cache-Control', 'no-store');
      if (result.status === 'accepted' || result.status === 'duplicate') {
        const accepted: MessageAcceptedResponse = { streamId: result.streamId };
        return await reply.code(202).send(accepted);
      }
      if (result.status === 'reply_not_found')
        return await reply.code(400).send({ reason: result.status });
      return await reply.code(409).send({ reason: result.status });
    } catch {
      options.runtimeMetrics.intakeFailures += 1;
      options.logger.info(
        { requestId: request.id, clientId: body.id, result: 'receipt_failure' },
        'Owner message intake'
      );
      return reply
        .code(503)
        .header('Cache-Control', 'no-store')
        .send({ error: 'intake_unavailable' });
    }
  });

  server.addHook('onClose', () => {
    // Safety net: no stream may leave the shared poll running after the module stops.
    options.modelStatus.stop();
  });

  server.setErrorHandler((error: unknown, request, reply) => {
    const details = error as { validation?: unknown; statusCode?: number };
    if (
      details.validation ||
      (details.statusCode !== undefined && details.statusCode >= 400 && details.statusCode < 500)
    ) {
      options.logger.info(
        { requestId: request.id, result: 'invalid_body' },
        'Owner message intake'
      );
      return reply
        .code(details.statusCode === 413 ? 413 : 400)
        .header('Cache-Control', 'no-store')
        .send({ error: 'invalid_body' });
    }
    return reply.code(500).header('Cache-Control', 'no-store').send({ error: 'internal_error' });
  });
  return server;
}

function getSessionKey(cookie: string | undefined, ip: string): string {
  const sessionCookie = cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`));
  return sessionCookie ?? `client:${ip}`;
}

function withTimeout<T>(promise: Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
  if (signal.aborted || timeoutMs <= 0) return Promise.reject(new Error('operation timed out'));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('operation timed out'));
    }, timeoutMs);
    const abort = () => {
      reject(new Error('operation timed out'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(cleanup);
  });
}

function isAllowedOrigin(origin: string, allowedOrigin: string): boolean {
  // Match a serialized HTTPS origin before URL parsing; WHATWG URL repairs malformed slashes.
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(origin)) return false;
  try {
    const parsed = new URL(origin);
    const allowed = new URL(allowedOrigin);
    // Uppercase hosts and explicit :443 are the same canonical origin.
    return parsed.origin === allowed.origin && parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
