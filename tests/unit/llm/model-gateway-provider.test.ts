/**
 * The core's provider in front of the platform's model gateway (ADR-013 D2,
 * D4, B-02).
 *
 * These checks run the REAL provider - the AI SDK, its OpenAI-compatible
 * transport and the product's own proxy fetch - against a local HTTP fake
 * gateway, so what is asserted is the wire, not a doubled SDK: one attempt per
 * completion, its timeout aborting the request itself, and no upstream
 * activity after a reported timeout.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VercelAIProvider } from '../../../src/plugins/providers/vercel-ai-provider.js';
import { createLLMAdapter } from '../../../src/layers/cognition/llm-adapter.js';
import { DEFAULT_ROLE_MODEL, LLMError } from '../../../src/llm/provider.js';
import { createTestLogger } from '../../helpers/test-logger.js';

interface SeenRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface FakeGateway {
  /** `http://127.0.0.1:<port>/v1`, the gateway's OpenAI-compatible base. */
  baseUrl: string;
  requests: SeenRequest[];
  /** Resolves when the client's socket to the current request closes. */
  closed: Promise<void>;
  close(): Promise<void>;
}

function createFakeGateway(
  answer: (request: SeenRequest, response: ServerResponse) => void
): Promise<FakeGateway> {
  const requests: SeenRequest[] = [];
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      const seen: SeenRequest = {
        method: request.method ?? '',
        path: request.url ?? '',
        headers: request.headers,
        body,
      };
      requests.push(seen);
      response.on('close', markClosed);
      answer(seen, response);
    });
  });
  return new Promise<FakeGateway>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('the fake gateway did not bind a port');
      resolve({
        baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
        requests,
        closed,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}

function answerOnce(text: string) {
  return (_request: SeenRequest, response: ServerResponse): void => {
    const body = JSON.stringify({
      id: 'chatcmpl-fake',
      object: 'chat.completion',
      created: 1,
      model: 'fake-model',
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    });
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
    });
    response.end(body);
  };
}

const gateways: FakeGateway[] = [];
afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
});

async function gatewayWith(
  answer: (request: SeenRequest, response: ServerResponse) => void
): Promise<FakeGateway> {
  const gateway = await createFakeGateway(answer);
  gateways.push(gateway);
  return gateway;
}

function providerFor(baseUrl: string): VercelAIProvider {
  // An http:// endpoint on loopback: no proxy in the environment may route it.
  for (const name of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY'])
    delete process.env[name];
  return new VercelAIProvider(
    { baseUrl, fastModel: 'fast-model', smartModel: 'smart-model', motorModel: 'motor-model' },
    createTestLogger('silent')
  );
}

const REQUEST = {
  role: 'fast' as const,
  messages: [{ role: 'user' as const, content: 'hello' }],
};

describe('the core provider in front of the model gateway', () => {
  it('refuses an unpinned blank role before sending HTTP', async () => {
    const gateway = await gatewayWith(answerOnce('hello'));
    const provider = new VercelAIProvider({ baseUrl: gateway.baseUrl }, createTestLogger('silent'));
    await expect(provider.complete({ ...REQUEST, role: 'smart' })).rejects.toThrow(/smart.*model/i);
    expect(gateway.requests).toHaveLength(0);
  });

  it('rejects duplicate tool-call ids immediately with zero HTTP requests and zero timers', async () => {
    const gateway = await gatewayWith(answerOnce('hello'));
    const provider = providerFor(gateway.baseUrl);
    vi.useFakeTimers();
    try {
      const call = {
        id: 'duplicate',
        type: 'function' as const,
        function: { name: 'test', arguments: '{}' },
      };
      await expect(
        provider.complete({
          ...REQUEST,
          messages: [{ role: 'assistant', content: null, tool_calls: [call, call] }],
        })
      ).rejects.toThrow(/Duplicate tool_call.id/);
      expect(gateway.requests).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('makes exactly one HTTP attempt per completion and sends no Authorization', async () => {
    const gateway = await gatewayWith(answerOnce('hello'));
    const provider = providerFor(gateway.baseUrl);

    const response = await provider.complete(REQUEST);

    expect(response.content).toBe('hello');
    expect(gateway.requests).toHaveLength(1);
    const [request] = gateway.requests;
    expect(request?.method).toBe('POST');
    expect(request?.path).toBe('/v1/chat/completions');
    expect(request?.headers['authorization']).toBeUndefined();
    expect(JSON.parse(request?.body ?? '{}')).toMatchObject({
      model: 'fast-model',
      messages: [{ role: 'user', content: 'hello' }],
    });
    // Not a streaming request: one request, one complete JSON answer.
    expect(JSON.parse(request?.body ?? '{}').stream).not.toBe(true);
  });

  it('asks the pinned gateway for `default` on a role no model is named for', async () => {
    const gateway = await gatewayWith(answerOnce('hello'));
    for (const name of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY'])
      delete process.env[name];
    // A base URL alone: the settings name no model for any role (ADR-013 D2).
    const provider = new VercelAIProvider(
      { baseUrl: gateway.baseUrl, useGatewayDefault: true },
      createTestLogger('silent')
    );

    await provider.complete({ ...REQUEST, role: 'smart' });

    expect(JSON.parse(gateway.requests[0]?.body ?? '{}').model).toBe(DEFAULT_ROLE_MODEL);
    expect(DEFAULT_ROLE_MODEL).toBe('default');
  });

  it('does not retry a failed completion: one attempt, one error', async () => {
    const gateway = await gatewayWith((_request, response) => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'upstream broke' } }));
    });
    const provider = providerFor(gateway.baseUrl);

    await expect(provider.complete(REQUEST)).rejects.toBeInstanceOf(LLMError);
    expect(gateway.requests).toHaveLength(1);
  });

  it('aborts the HTTP request when the wait for the first byte times out', async () => {
    const gateway = await gatewayWith(() => {
      // Accepted, and never answered: the first-byte wait.
    });
    const provider = providerFor(gateway.baseUrl);

    const completion = provider.complete({ ...REQUEST, timeoutMs: 100 });
    await expect(completion).rejects.toThrow(/did not answer within 100 ms/);
    // The abort reached the gateway's own socket, not just the SDK's promise.
    await gateway.closed;
    expect(gateway.requests).toHaveLength(1);
  });

  it('aborts the HTTP request when the response body stops arriving', async () => {
    const gateway = await gatewayWith((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"id":"chatcmpl-partial","object":"chat.completion",');
      // The rest of the body never arrives.
    });
    const provider = providerFor(gateway.baseUrl);

    const completion = provider.complete({ ...REQUEST, timeoutMs: 150 });
    await expect(completion).rejects.toThrow(/did not answer within 150 ms/);
    await gateway.closed;
    expect(gateway.requests).toHaveLength(1);
  });

  it('starts no attempt after a reported timeout', async () => {
    const gateway = await gatewayWith(() => {
      // The first attempt never answers.
    });
    const provider = providerFor(gateway.baseUrl);

    await expect(provider.complete({ ...REQUEST, timeoutMs: 100 })).rejects.toThrow(
      /did not answer within/
    );
    await gateway.closed;
    // Nothing new arrives on the gateway: the reported timeout ended the turn.
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]?.path).toBe('/v1/chat/completions');
  });

  it('names a simple completion conversation through the adapter on the wire', async () => {
    const gateway = await gatewayWith(answerOnce('hello'));
    const provider = providerFor(gateway.baseUrl);
    const adapter = createLLMAdapter(provider, createTestLogger('silent'), { role: 'fast' });

    const answer = await adapter.complete(
      { systemPrompt: 's', userPrompt: 'u', sessionId: 'rcpt_ab12cd34' },
      { maxTokens: 16 }
    );
    await adapter.complete({ systemPrompt: 's', userPrompt: 'u' }, { maxTokens: 16 });

    expect(answer).toBe('hello');
    expect(gateway.requests[0]?.headers['x-lifemodel-session']).toBe('rcpt_ab12cd34');
    expect(gateway.requests[1]?.headers['x-lifemodel-session']).toBeUndefined();
    // A simple completion sends no tools and no Authorization.
    expect(JSON.parse(gateway.requests[0]?.body ?? '{}').tools).toBeUndefined();
  });

  it('names the turn conversation in one request header and none when it has none', async () => {
    const gateway = await gatewayWith(answerOnce('hello'));
    const provider = providerFor(gateway.baseUrl);

    await provider.complete({ ...REQUEST, sessionId: 'rcpt_ab12cd34' });
    await provider.complete(REQUEST);

    expect(gateway.requests).toHaveLength(2);
    expect(gateway.requests[0]?.headers['x-lifemodel-session']).toBe('rcpt_ab12cd34');
    expect(gateway.requests[1]?.headers['x-lifemodel-session']).toBeUndefined();
    expect(gateway.requests[0]?.headers['authorization']).toBeUndefined();
  });
});
