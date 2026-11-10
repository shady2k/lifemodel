import { createServer } from 'node:http';
import pino from 'pino';
import { setConversationLogger } from '../../../src/core/logger.js';
import { describe, expect, it } from 'vitest';
import { VercelAIProvider } from '../../../src/plugins/providers/vercel-ai-provider.js';
import { LLMError } from '../../../src/llm/provider.js';
import { createTestLogger, recordingLogger, type RecordedLog } from '../../helpers/test-logger.js';
import {
  createExchangeCapture,
  type CaptureRow,
} from '../../../loader/src/model-exchange-capture.js';

const markers = ['NON2XX_PRIVATE_abcdefghijklmnopq', 'BAD2XX_PRIVATE_abcdefghijklmnopq'];

describe('core provider failure evidence (ADR-016 L03)', () => {
  it.each([
    { name: 'Error', statusCode: 408, text: 'private', expected: 408, retryable: true },
    { name: 'AbortError', text: 'private', expected: undefined, retryable: true },
    { name: 'Error', text: 'rate limit private', expected: 429, retryable: true },
    { name: 'Error', text: 'private 503', expected: 503, retryable: true },
    {
      name: 'Error',
      text: 'private',
      body: JSON.stringify({
        error: { metadata: { raw: JSON.stringify({ error: { message: 'private rate limit' } }) } },
      }),
      expected: 429,
      retryable: true,
    },
    { name: 'Error', text: 'private', expected: undefined, retryable: false },
  ])('preserves retry classification for $name / $expected', (test) => {
    const provider = new VercelAIProvider({ baseUrl: 'http://127.0.0.1/v1' });
    const error = Object.assign(new Error(test.text), {
      name: test.name,
      statusCode: test.statusCode,
      responseBody: test.body,
    });
    // Exercise the classifier boundary with error shapes the real SDK emits.
    const mapped = (
      provider as unknown as { mapAIErrorToLLMError(error: unknown): LLMError }
    ).mapAIErrorToLLMError(error);
    expect(mapped.statusCode).toBe(test.expected);
    expect(mapped.retryable).toBe(test.retryable);
    expect(mapped.message).not.toContain('private');
  });

  it('keeps successful completion logging unchanged', async () => {
    const logs: RecordedLog[] = [];
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id: 'success',
            object: 'chat.completion',
            created: 1,
            model: 'test-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'ordinary answer' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          })
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw Error('No test listener');
      const provider = new VercelAIProvider(
        { baseUrl: `http://127.0.0.1:${String(address.port)}/v1`, fastModel: 'test-model' },
        recordingLogger(createTestLogger('silent'), logs)
      );
      expect(
        (await provider.complete({ role: 'fast', messages: [{ role: 'user', content: 'hello' }] }))
          .content
      ).toBe('ordinary answer');
      expect(logs.find((line) => line.msg === 'AI SDK generateText response')).toMatchObject({
        level: 'debug',
        obj: { textLength: 15, finishReason: 'stop' },
      });
      expect(logs.filter((line) => line.level === 'error')).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each([400, 429, 500, 200])(
    'keeps a rejected HTTP %i body out of logs and errors',
    async (status) => {
      const marker = markers[status === 200 ? 1 : 0]!;
      expect(marker).toHaveLength(32);
      for (const enabled of [false, true]) {
        const logs: RecordedLog[] = [];
        const rows: CaptureRow[] = [];
        const conversation: string[] = [];
        setConversationLogger(
          pino(
            { level: 'trace' },
            {
              write: (line: string) => {
                conversation.push(line);
              },
            }
          )
        );
        const capture = createExchangeCapture({
          context: () => ({
            setting: { until: enabled ? new Date(Date.now() + 60_000).toISOString() : null },
            secrets: [],
            secretHeaders: [],
          }),
          write: async (row) => {
            rows.push(row);
          },
        });
        const body = JSON.stringify(
          status === 200
            ? { choices: [{ message: { role: 'assistant', content: { private: marker } } }] }
            : {
                error: {
                  message: marker,
                  metadata: {
                    raw: JSON.stringify({ error: { message: marker } }),
                    provider_name: marker,
                  },
                },
                metadata: { provider_name: marker },
              }
        );
        const server = createServer((request, response) => {
          request.resume();
          request.on('end', () => {
            const attempt = capture.begin({
              callId: String(request.headers['x-lifemodel-call-id'] ?? 'call'),
              attempt: 1,
              slot: 'primary',
              taskId: null,
              sessionId: 'chat',
              inbound: { method: 'POST', path: '/v1/chat/completions', headers: {}, body: '' },
              upstream: { method: 'POST', url: 'http://example.test', headers: {}, body: '' },
            });
            attempt?.response(status, {});
            attempt?.chunk(Buffer.from(body));
            attempt?.finish();
            response.writeHead(status, { 'content-type': 'application/json' });
            response.end(body);
          });
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        try {
          const address = server.address();
          if (!address || typeof address === 'string') throw Error('No test listener');
          const provider = new VercelAIProvider(
            {
              baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
              fastModel: 'test-model',
            },
            recordingLogger(createTestLogger('silent'), logs)
          );
          const error = await provider
            .complete({ role: 'fast', messages: [{ role: 'user', content: 'hello' }] })
            .catch((cause: unknown) => cause);
          expect(error).toBeInstanceOf(LLMError);
          const failure = error as LLMError;
          expect(failure.message).not.toContain(marker);
          expect(failure.statusCode).toBe(status);
          expect(failure.retryable).toBe(status === 429 || status === 500);
          expect(JSON.stringify(logs)).not.toContain(marker);
          expect(conversation.join('')).not.toContain(marker);
          expect(failure.upstreamProvider).not.toBe(marker);
          expect(logs.find((line) => line.msg === '🤖 LLM request failed')).toMatchObject({
            level: 'error',
            obj: {
              requestId: expect.any(String),
              statusCode: status,
              errorType: 'LLMError',
              retryable: failure.retryable,
            },
          });
          expect(logs.find((line) => line.msg === 'AI SDK generateText failed')?.obj).toMatchObject(
            {
              statusCode: status,
              errorName: expect.any(String),
              retryable: failure.retryable,
            }
          );
          if (enabled) {
            await expect.poll(() => rows.length).toBe(1);
            expect(JSON.stringify(rows)).toContain(marker);
          } else {
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(rows).toEqual([]);
          }
        } finally {
          capture.close();
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      }
    }
  );
});
