import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MinimalOpenAIChatTool } from '../../src/llm/tool-schema.js';
import type { CompletionRequest, Message } from '../../src/llm/provider.js';
import { VercelAIProvider } from '../../src/plugins/providers/vercel-ai-provider.js';
import { generateText } from 'ai';

vi.mock('ai', () => ({ generateText: vi.fn() }));
vi.mock('@openrouter/ai-sdk-provider', () => ({ createOpenRouter: () => () => ({}) }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: () => () => ({}) }));

describe('VercelAIProvider', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('includes minimal tools with permissive inputSchema', async () => {
    const provider = new VercelAIProvider({ apiKey: 'test' });
    const tools: MinimalOpenAIChatTool[] = [
      {
        type: 'function',
        function: { name: 'core.tools', description: 'Describe tools' },
      },
    ];

    const converted = (provider as unknown as { convertTools: (t: unknown) => unknown }).convertTools(
      tools
    ) as Record<string, { description: string; inputSchema: () => Promise<unknown> }>;

    expect(converted['core.tools']).toBeTruthy();
    expect(converted['core.tools']?.description).toBe('Describe tools');
    const schema = await converted['core.tools']?.inputSchema();
    expect(schema).toMatchObject({ type: 'object', additionalProperties: true });
  });

  it('does not crash when generateText returns undefined toolCalls', async () => {
    const provider = new VercelAIProvider({ apiKey: 'test' });

    (generateText as unknown as { mockResolvedValue: (value: unknown) => void }).mockResolvedValue({
      text: 'ok',
      toolCalls: undefined,
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      response: { id: 'resp_1' },
    });

    const request: CompletionRequest = {
      messages: [{ role: 'user', content: 'hello' }],
    };

    await expect(provider.complete(request)).resolves.toBeTruthy();
  });

  it('applies parallel_tool_calls for local providers', () => {
    const provider = new VercelAIProvider({ baseUrl: 'http://localhost:1234', model: 'test' });
    const request: CompletionRequest = {
      messages: [],
      parallelToolCalls: false,
    };

    const providerOptions = (
      provider as unknown as {
        buildProviderOptions: (modelId: string, overrides: Record<string, unknown>, req: unknown) => {
          openai?: Record<string, unknown>;
        } | undefined;
      }
    ).buildProviderOptions('test', {}, request);

    expect(providerOptions?.openai?.['parallel_tool_calls']).toBe(false);
  });

  it('uses tool_name fallback when tool_calls are not present in history', () => {
    const provider = new VercelAIProvider({ baseUrl: 'http://localhost:1234', model: 'test' });
    const messages: Message[] = [
      {
        role: 'tool',
        content: '{"ok":true}',
        tool_call_id: 'call_1',
        tool_name: 'core_memory',
      },
    ];

    const converted = (
      provider as unknown as { convertMessages: (m: Message[]) => { content: unknown }[] }
    ).convertMessages(messages);

    const content = converted[0]?.content as Record<string, unknown>[];
    expect(content[0]?.['toolName']).toBe('core_memory');
  });

  it('uses provider-specific cache control key', () => {
    const provider = new VercelAIProvider({ baseUrl: 'http://localhost:1234', model: 'test' });
    const messages = [
      {
        role: 'system',
        content: [
          {
            type: 'text',
            text: 'hello',
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
    ] as unknown as Message[];

    const converted = (
      provider as unknown as { convertMessages: (m: Message[]) => { content: unknown }[] }
    ).convertMessages(messages);

    const parts = converted[0]?.content as Record<string, unknown>[];
    const providerOptions = parts[0]?.['providerOptions'] as Record<string, unknown>;
    expect(providerOptions?.['openai']).toEqual({ cacheControl: { type: 'ephemeral' } });
  });
});
