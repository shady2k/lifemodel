import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { IOwnerMessageIntake } from '../ports/owner-message-intake.js';

const UUID_V7 =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';
const WINDOW_MS = 60_000;
const SENDS_PER_WINDOW = 60;
const MAX_RATE_KEYS = 10_000;

export interface WebServerOptions {
  allowedOrigin: string;
  intake: IOwnerMessageIntake;
  logger: Pick<FastifyBaseLogger, 'info'>;
  bodyLimit?: number;
}

interface MessageBody {
  id: string;
  text: string;
  replyTo?: string;
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
