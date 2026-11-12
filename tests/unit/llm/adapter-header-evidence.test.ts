import { describe, expect, it, vi } from 'vitest';
import { LLMAdapter } from '../../../src/layers/cognition/llm-adapter.js';
import { LLMError, type LLMProvider } from '../../../src/llm/provider.js';
import { createTestLogger, recordingLogger, type RecordedLog } from '../../helpers/test-logger.js';

const marker = 'UPSTREAM_PROVIDER_PRIVATE_1234567';
describe('cognition adapter header evidence', () => {
  it.each(['success', 'tools-error', 'simple-error'])(
    'never logs upstream provider values: %s',
    async (mode) => {
      const logs: RecordedLog[] = [];
      const complete = vi.fn();
      if (mode === 'success')
        complete.mockResolvedValue({
          model: 'test',
          content: 'ok',
          finishReason: 'stop',
          upstreamProvider: marker,
        });
      else
        complete.mockRejectedValue(
          new LLMError('refused', 'endpoint', {
            statusCode: 500,
            retryable: true,
            upstreamProvider: marker,
          })
        );
      const adapter = new LLMAdapter(
        { complete } as unknown as LLMProvider,
        recordingLogger(createTestLogger('silent'), logs)
      );
      const result =
        mode === 'simple-error'
          ? adapter.complete({ systemPrompt: 'system', userPrompt: 'hello' })
          : adapter.completeWithTools({
              messages: [{ role: 'user', content: 'hello' }],
              tools: [],
            });
      if (mode === 'success') await expect(result).resolves.toMatchObject({ content: 'ok' });
      else await expect(result).rejects.toBeInstanceOf(LLMError);
      expect(logs.length).toBeGreaterThan(0);
      expect(JSON.stringify(logs)).not.toContain(marker);
    }
  );
});
