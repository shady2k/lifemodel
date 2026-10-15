import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { IOwnerMessageIntake } from '../ports/owner-message-intake.js';
import type { CreatureStateReader } from '../ports/creature-state.js';
import type { TranscriptReader, TranscriptRow } from '../ports/transcript.js';

const UUID_V7 =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';
const WINDOW_MS = 60_000;
const SENDS_PER_WINDOW = 60;
const MAX_RATE_KEYS = 10_000;
const MAX_PAGE_SIZE = 50;
const MAX_STREAM_QUEUE = 100;
const MAX_STREAMS_PER_SESSION = 4;
const STREAM_MAX_AGE_MS = 15 * 60_000;
const STATE_POLL_MS = 250;
const HEARTBEAT_MS = 15_000;
const SESSION_COOKIE_NAME = 'lm_session';

export interface WebServerOptions {
  allowedOrigin: string;
  intake: IOwnerMessageIntake;
  transcript: TranscriptReader;
  creatureState: CreatureStateReader;
  logger: Pick<FastifyBaseLogger, 'info'>;
  bodyLimit?: number;
}

interface MessageBody {
  id: string;
  text: string;
  replyTo?: string;
}

interface StreamEvent {
  event: 'message' | 'state';
  data: TranscriptRow | Awaited<ReturnType<CreatureStateReader['readCreatureState']>>;
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
  let allowed: URL;
  try {
    allowed = new URL(options.allowedOrigin);
  } catch {
    throw new Error('allowedOrigin must be an absolute HTTP origin');
  }
  if (allowed.origin !== options.allowedOrigin || allowed.protocol !== 'http:')
    throw new Error('allowedOrigin must be an exact HTTP origin');

  const server = Fastify({
    bodyLimit: options.bodyLimit ?? 100 * 1024,
    ajv: { customOptions: { removeAdditional: false } },
  });
  const rates = new Map<string, { start: number; count: number }>();
  const activeStreams = new Map<string, number>();
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

  server.get<{ Querystring: { before?: string; limit?: string } }>(
    '/api/transcript',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const limit = request.query.limit === undefined ? MAX_PAGE_SIZE : Number(request.query.limit);
      const before = request.query.before;
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > MAX_PAGE_SIZE ||
        (before !== undefined && !/^(0|[1-9][0-9]*)$/.test(before))
      ) {
        return reply.code(400).send({ error: 'invalid_query' });
      }
      try {
        return await options.transcript.readTranscript({
          ...(before === undefined ? {} : { before }),
          limit,
        });
      } catch {
        return reply.code(400).send({ error: 'invalid_query' });
      }
    }
  );

  server.get<{ Querystring: { after?: string } }>('/api/events', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const lastEventId = request.headers['last-event-id'];
    const after =
      typeof lastEventId === 'string' && lastEventId.length > 0 ? lastEventId : request.query.after;
    if (after === undefined || !/^(0|[1-9][0-9]*)$/.test(after))
      return reply.code(400).send({ error: 'invalid_cursor' });

    const session = getSessionKey(request.headers.cookie, request.ip);
    const streamCount = activeStreams.get(session) ?? 0;
    if (streamCount >= MAX_STREAMS_PER_SESSION)
      return reply.code(429).send({ error: 'too_many_streams' });
    activeStreams.set(session, streamCount + 1);
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();

    const abort = new AbortController();
    const queue = new BoundedQueue<StreamEvent>();
    let previousState: string | null = null;
    let ended = false;
    const cleanup = () => {
      if (ended) return;
      ended = true;
      abort.abort();
      queue.close();
      clearInterval(stateTimer);
      clearInterval(heartbeatTimer);
      clearTimeout(maxAgeTimer);
      const remaining = (activeStreams.get(session) ?? 1) - 1;
      if (remaining <= 0) activeStreams.delete(session);
      else activeStreams.set(session, remaining);
      if (!response.writableEnded) response.end();
    };
    response.on('close', cleanup);

    const publishState = async () => {
      try {
        const state = await options.creatureState.readCreatureState();
        const key =
          state === null
            ? 'null'
            : JSON.stringify({
                state: state.state,
                epoch: state.epoch,
                publishedAt: state.publishedAt,
              });
        if (key !== previousState) {
          previousState = key;
          if (!queue.push({ event: 'state', data: state })) cleanup();
        }
      } catch {
        previousState = 'unavailable';
        if (!queue.push({ event: 'state', data: null })) cleanup();
      }
    };
    const stateTimer = setInterval(() => void publishState(), STATE_POLL_MS);
    const heartbeatTimer = setInterval(() => {
      if (!ended && !response.write(': heartbeat\n\n')) response.once('drain', () => undefined);
    }, HEARTBEAT_MS);
    const maxAgeTimer = setTimeout(cleanup, STREAM_MAX_AGE_MS);
    void (async () => {
      let iterator: AsyncIterator<TranscriptRow> | undefined;
      try {
        await publishState();
        if (ended) return;
        iterator = options.transcript.watchTranscript(after, abort.signal)[Symbol.asyncIterator]();
        while (!abort.signal.aborted) {
          const next = await iterator.next();
          if (next.done) break;
          if (!queue.push({ event: 'message', id: next.value.sequence, data: next.value })) {
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

  server.post<{ Body: MessageBody }>('/api/messages', { schema }, async (request, reply) => {
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
      if (result.status === 'accepted' || result.status === 'duplicate')
        return await reply.code(202).send({ streamId: result.streamId });
      if (result.status === 'reply_not_found')
        return await reply.code(400).send({ reason: result.status });
      return await reply.code(409).send({ reason: result.status });
    } catch {
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

  server.setErrorHandler((error: unknown, request, reply) => {
    const details = error as { validation?: unknown; statusCode?: number };
    if (details.validation || details.statusCode === 413) {
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
  const firstCookie = cookie
    ?.split(';')
    .map((part) => part.trim())
    .find(Boolean);
  return firstCookie ?? `client:${ip}`;
}

function isAllowedOrigin(origin: string, allowedOrigin: string): boolean {
  try {
    const parsed = new URL(origin);
    return (
      parsed.origin === allowedOrigin &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.pathname === '/' &&
      parsed.search === '' &&
      parsed.hash === ''
    );
  } catch {
    return false;
  }
}
