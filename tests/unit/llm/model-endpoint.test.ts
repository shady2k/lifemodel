/**
 * The model endpoint, through `createLLMProvider`'s public entry
 * (lifemodel-q4x.4.1, criterion: "lifemodel started with that config builds its
 * provider for the endpoint and roles").
 *
 * The provider is exercised the way lifemodel uses it - `complete()` with a
 * role - and the model that reaches the OpenAI-compatible client is what is
 * asserted, because the model per role IS the configuration. The AI SDK and the
 * endpoint's HTTP client are the only things doubled: no request leaves the
 * machine.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createLLMProvider } from '../../../src/core/container.js';
import { LLMError, type LLMProvider, type ModelRole } from '../../../src/llm/provider.js';
import { createTestLogger, recordingLogger, type RecordedLog } from '../../helpers/test-logger.js';

// The endpoint's client, captured: which model was asked for, and on which
// base URL. Nothing is sent anywhere.
const mocks = vi.hoisted(() => {
  const chat = vi.fn((modelId: string) => ({ modelId }));
  const createOpenAI = vi.fn((options: { baseURL?: string; apiKey?: string }) => ({
    chat,
    options,
  }));
  return { chat, createOpenAI };
});
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: mocks.createOpenAI }));
vi.mock('ai', () => ({
  generateText: vi.fn().mockResolvedValue({
    text: 'ok',
    toolCalls: [],
    finishReason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    response: { id: 'resp_1' },
  }),
  jsonSchema: (schema: unknown) => schema,
}));

/** The lines of one provider build, kept in memory (no transport, no file). */
let lines: RecordedLog[] = [];

function logger(): ReturnType<typeof createTestLogger> {
  return recordingLogger(createTestLogger('silent'), lines);
}

/** The model the endpoint client was asked for, per role. */
async function modelFor(provider: LLMProvider, role: ModelRole | undefined): Promise<string> {
  mocks.chat.mockClear();
  await provider.complete({
    messages: [{ role: 'user', content: 'hello' }],
    ...(role === undefined ? {} : { role }),
  });
  const asked = mocks.chat.mock.calls.at(-1)?.[0];
  if (asked === undefined) throw new Error('the endpoint client was never asked for a model');
  return asked;
}

const COMPLETE = {
  baseUrl: 'http://127.0.0.1:1234/v1',
  fastModel: 'fast-small',
  smartModel: 'smart-big',
  motorModel: 'motor-mid',
};

describe('createLLMProvider: the endpoint and the roles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lines = [];
    delete process.env['OPENROUTER_API_KEY'];
  });

  it('builds the endpoint provider and asks it for the model of the role', async () => {
    const provider = createLLMProvider({ endpoint: COMPLETE }, logger());

    expect(provider).not.toBeNull();
    expect(provider?.name).toBe('endpoint');
    expect(await modelFor(provider as LLMProvider, 'fast')).toBe('fast-small');
    expect(await modelFor(provider as LLMProvider, 'smart')).toBe('smart-big');
    expect(await modelFor(provider as LLMProvider, 'motor')).toBe('motor-mid');
    // The endpoint is called with its own base URL and no key of ours.
    expect(mocks.createOpenAI.mock.calls.at(-1)?.[0]?.baseURL).toBe('http://127.0.0.1:1234/v1');
  });

  it('names the role it cannot serve instead of guessing a model', async () => {
    // A config file written by hand, naming only the fast model. The endpoint
    // serves that role; the settings interface would never save this shape.
    const provider = createLLMProvider(
      { endpoint: { ...COMPLETE, smartModel: null, motorModel: null } },
      logger()
    );
    expect(provider).not.toBeNull();

    await expect(
      (provider as LLMProvider).complete({
        messages: [{ role: 'user', content: 'hello' }],
        role: 'smart',
      })
    ).rejects.toThrow(LLMError);
  });

  it('is not built at all when the endpoint has a base URL and no model', () => {
    const provider = createLLMProvider(
      { endpoint: { baseUrl: 'http://127.0.0.1:1234/v1' } },
      logger()
    );
    expect(provider).toBeNull();
  });

  it('starts without a provider when nothing is configured (the first start)', () => {
    expect(createLLMProvider(undefined, logger())).toBeNull();
    expect(createLLMProvider({}, logger())).toBeNull();
    expect(
      createLLMProvider(
        { endpoint: { baseUrl: null, fastModel: null, smartModel: null, motorModel: null } },
        logger()
      )
    ).toBeNull();
  });

  it('builds ONE provider: a separately keyed OpenRouter surface is not accepted as config', async () => {
    // The old surface declared a key and per-OpenRouter models beside the
    // endpoint and constructed a second provider from them. The type has one
    // field left (`endpoint`), and the refusal is typed, not only behavioral:
    // this is what keeps the key out of lifemodel, Agency Vault injects it.
    const provider = createLLMProvider(
      {
        endpoint: COMPLETE,
        // @ts-expect-error - the keyed OpenRouter surface is gone from the type,
        // so this line is a compile error and cannot come back silently.
        openRouterApiKey: 'a-key-lifemodel-must-not-hold',
      },
      logger()
    );
    expect(provider?.name).toBe('endpoint');
    expect(await modelFor(provider as LLMProvider, 'smart')).toBe('smart-big');
  });
});
