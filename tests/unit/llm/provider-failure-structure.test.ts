import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { VercelAIProvider } from '../../../src/plugins/providers/vercel-ai-provider.js';
import { createTestLogger, recordingLogger, type RecordedLog } from '../../helpers/test-logger.js';

// Debug request summaries intentionally retain previews. Failure diagnostics must not.
describe('provider failure structure', () => {
  it.each([400, 500, 200])('logs structure and identifiers only for HTTP %i', async (status) => {
    const chat = 'CHAT_PRIVATE_abcdefghijklmnopqrs';
    const header = 'HEADER_PRIVATE_abcdefghijklmnopq';
    const urlMarker = 'URL_PRIVATE_abcdefghijklmnopqrst';
    const logs: RecordedLog[] = [];
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(status, {
          'content-type': 'application/json',
          'x-private-detail': header,
          'x-request-id': header,
          'request-id': header,
          'x-openrouter-provider': header,
        });
        response.end(
          JSON.stringify(status === 200 ? { invalid: true } : { error: { message: 'refused' } })
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw Error('No listener');
      const provider = new VercelAIProvider(
        {
          baseUrl: `http://127.0.0.1:${String(address.port)}/${urlMarker}?private=${urlMarker}`,
          fastModel: 'test-model',
        },
        recordingLogger(createTestLogger('silent'), logs)
      );
      await expect(
        provider.complete({
          role: 'fast',
          messages: [
            { role: 'system', content: chat },
            { role: 'user', content: chat },
          ],
        })
      ).rejects.toThrow();
      const failures = logs.filter((line) => ['warn', 'error', 'fatal'].includes(line.level));
      expect(JSON.stringify(failures)).not.toContain(chat);
      expect(JSON.stringify(failures)).not.toContain(header);
      expect(JSON.stringify(failures)).not.toContain(urlMarker);
      // Header values never enter even the debug diagnostics.
      expect(JSON.stringify(logs)).not.toContain(header);
      const failure = logs.find((line) => line.msg === 'AI SDK generateText failed');
      expect(failure).toMatchObject({
        level: 'error',
        obj: {
          durationMs: expect.any(Number),
          model: 'test-model',
          requestId: expect.any(String),
          statusCode: status,
          httpStatus: status,
          errorName: expect.any(String),
          retryable: status === 500,
          messageCount: 2,
          messages: [
            { role: 'system', contentType: 'string' },
            { role: 'user', contentType: 'string' },
          ],
          responseHeaderNames: expect.arrayContaining([
            'content-type',
            'x-private-detail',
            'x-request-id',
          ]),
          requestHost: `127.0.0.1:${String(address.port)}`,
          hasTools: false,
          toolCount: 0,
        },
      });
      expect(failure?.obj.messages).toEqual([
        { role: 'system', contentType: 'string' },
        { role: 'user', contentType: 'string' },
      ]);
      expect(failure?.obj).not.toHaveProperty('responseHeaders');
      expect(failure?.obj).not.toHaveProperty('responseRequestId');
      expect(failure?.obj).not.toHaveProperty('requestUrl');
      expect(
        logs
          .filter((line) => JSON.stringify(line).includes(chat))
          .every((line) => ['debug', 'trace'].includes(line.level))
      ).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
