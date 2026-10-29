/**
 * One trace span per model call (lifemodel-d4t8).
 *
 * These checks run the REAL provider - the AI SDK, its OpenAI-compatible
 * transport and the product's own proxy fetch - against a local HTTP fake
 * gateway, so the recorded span is read off the wire that actually left: the
 * call id header, the response model, the slot header, the endpoint's own
 * usage object and the serialized request's prefix parts.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VercelAIProvider } from '../../../src/plugins/providers/vercel-ai-provider.js';
import { MODEL_CALL_HEADER } from '../../../src/config/model-endpoint.js';
import { withCaller, withTraceContext } from '../../../src/core/trace-context.js';
import type { CompletionRequest } from '../../../src/llm/provider.js';
import type { TraceRecord } from '../../../src/ports/observability.js';
import {
  ModelCallTrace,
  modelCallAttributes,
  type ModelCallSpanSink,
} from '../../../src/llm/model-call-span.js';
import { createTestLogger } from '../../helpers/test-logger.js';

interface SeenRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface FakeGateway {
  baseUrl: string;
  requests: SeenRequest[];
  close(): Promise<void>;
}

function createFakeGateway(
  answer: (request: SeenRequest, response: ServerResponse) => void
): Promise<FakeGateway> {
  const requests: SeenRequest[] = [];
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

/** Record what the provider writes, and answer as a real writer would. */
function recorder(accept = true): { records: TraceRecord[]; sink: ModelCallSpanSink } {
  const records: TraceRecord[] = [];
  return {
    records,
    sink: {
      enqueue: (record: TraceRecord) => {
        if (accept) records.push(record);
        return accept;
      },
    },
  };
}

function answerWith(
  usage: Record<string, unknown> | undefined,
  headers: Record<string, string> = {}
): (request: SeenRequest, response: ServerResponse) => void {
  return (_request, response) => {
    const body = JSON.stringify({
      id: 'chatcmpl-fake',
      object: 'chat.completion',
      created: 1,
      model: 'served-model-2026',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'answer' }, finish_reason: 'stop' },
      ],
      ...(usage === undefined ? {} : { usage }),
    });
    response.writeHead(200, {
      ...headers,
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
    });
    response.end(body);
  };
}

const FULL_USAGE = {
  prompt_tokens: 1200,
  completion_tokens: 180,
  total_tokens: 1380,
  prompt_tokens_details: { cached_tokens: 1024 },
  completion_tokens_details: { reasoning_tokens: 64 },
};

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

function providerFor(baseUrl: string, sink: ModelCallSpanSink, effort?: 'low'): VercelAIProvider {
  // An http:// endpoint on loopback: no proxy in the environment may route it.
  for (const name of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY'])
    delete process.env[name];
  return new VercelAIProvider(
    {
      baseUrl,
      fastModel: 'fast-model',
      smartModel: 'smart-model',
      motorModel: 'motor-model',
      ...(effort ? { smartReasoningEffort: effort } : {}),
    },
    createTestLogger('silent'),
    sink
  );
}

const REQUEST: CompletionRequest = {
  role: 'smart',
  messages: [
    { role: 'system', content: 'you are the agent' },
    { role: 'user', content: 'earlier question' },
    { role: 'assistant', content: 'earlier answer' },
    { role: 'user', content: 'hello' },
  ],
  tools: [{ type: 'function', function: { name: 'core.tools', description: 'Describe tools' } }],
  maxTokens: 256,
  temperature: 0.3,
};

function spanOf(records: TraceRecord[]) {
  expect(records).toHaveLength(1);
  const record = records[0];
  if (!record || record.kind !== 'span') throw new Error('no span was recorded');
  return record.span;
}

describe('model call spans', () => {
  it('records one span per call with the GenAI usage names, the slot and the call id it sent', async () => {
    const gateway = await gatewayWith(answerWith(FULL_USAGE, { 'x-lifemodel-slot': 'primary' }));
    const { records, sink } = recorder();

    await providerFor(gateway.baseUrl, sink).complete(REQUEST);

    const span = spanOf(records);
    expect(span.component).toBe('llm');
    expect(span.status).toBe('ok');
    expect(span.endedAt).not.toBeNull();
    expect(span.attrs).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'openai',
      'gen_ai.request.model': 'smart-model',
      'gen_ai.request.max_tokens': 256,
      'gen_ai.request.temperature': 0.3,
      'gen_ai.response.model': 'served-model-2026',
      'gen_ai.response.id': 'chatcmpl-fake',
      'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.usage.input_tokens': 1200,
      'gen_ai.usage.cache_read.input_tokens': 1024,
      'gen_ai.usage.output_tokens': 180,
      'gen_ai.usage.reasoning.output_tokens': 64,
      'lifemodel.role': 'smart',
      'lifemodel.slot': 'primary',
      'lifemodel.http.status': 200,
      'lifemodel.attempt': 1,
      'lifemodel.message_count': 4,
      'lifemodel.tool_count': 1,
      'span.name': 'chat smart-model',
    });
    // The call id the gateway received is the one the span records.
    expect(gateway.requests[0]?.headers[MODEL_CALL_HEADER]).toBe(span.attrs['lifemodel.call_id']);
    expect(gateway.requests[0]?.headers['x-lifemodel-call']).toMatch(/^call_[0-9a-f-]{36}$/);
    // No prompt or answer text: the prefix parts are a hash and a length.
    const serialized = JSON.stringify(span.attrs);
    expect(serialized).not.toContain('hello');
    expect(serialized).not.toContain('you are the agent');
    expect(serialized).not.toContain('answer');
    expect(span.attrs['lifemodel.prefix.system.hash']).toMatch(/^[0-9a-f]{16}$/);
    expect(span.attrs['lifemodel.prefix.system.size']).toBeGreaterThan(0);
    expect(span.attrs['lifemodel.prefix.tools.hash']).toMatch(/^[0-9a-f]{16}$/);
    expect(span.attrs['lifemodel.prefix.history.hash']).toMatch(/^[0-9a-f]{16}$/);
    expect(span.attrs['lifemodel.prefix.context.hash']).toMatch(/^[0-9a-f]{16}$/);
  });

  it('keeps an unreported cache and reasoning count absent instead of zero', async () => {
    const gateway = await gatewayWith(answerWith({ prompt_tokens: 40, completion_tokens: 7 }));
    const { records, sink } = recorder();

    await providerFor(gateway.baseUrl, sink).complete(REQUEST);

    const attrs = spanOf(records).attrs;
    expect(attrs['gen_ai.usage.input_tokens']).toBe(40);
    expect(attrs['gen_ai.usage.output_tokens']).toBe(7);
    expect(attrs).not.toHaveProperty('gen_ai.usage.cache_read.input_tokens');
    expect(attrs).not.toHaveProperty('gen_ai.usage.reasoning.output_tokens');
  });

  it('records a reported zero cache read and reasoning count as zero, not absent', async () => {
    const gateway = await gatewayWith(
      answerWith({
        prompt_tokens: 1200,
        completion_tokens: 180,
        total_tokens: 1380,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      })
    );
    const { records, sink } = recorder();

    await providerFor(gateway.baseUrl, sink).complete(REQUEST);

    // A reported miss is the main cache diagnostic: it must read 0, not "-".
    const attrs = spanOf(records).attrs;
    expect(attrs['gen_ai.usage.cache_read.input_tokens']).toBe(0);
    expect(attrs['gen_ai.usage.reasoning.output_tokens']).toBe(0);
    expect(attrs['gen_ai.usage.input_tokens']).toBe(1200);
    expect(attrs['gen_ai.usage.output_tokens']).toBe(180);
  });

  it('falls back to positive SDK counts only when the wire usage was not seen', () => {
    // The transport could not read a usage object at all: the SDK's own zero
    // is then indistinguishable from a missing count, so only positives count.
    const unseen = new ModelCallTrace({});
    unseen.observeUsage({
      inputTokens: 40,
      outputTokens: 7,
      inputTokenDetails: { cacheReadTokens: 0 },
      outputTokenDetails: { reasoningTokens: 0 },
    });
    const unseenAttrs = modelCallAttributes(unseen);
    expect(unseenAttrs['gen_ai.usage.input_tokens']).toBe(40);
    expect(unseenAttrs['gen_ai.usage.output_tokens']).toBe(7);
    expect(unseenAttrs).not.toHaveProperty('gen_ai.usage.cache_read.input_tokens');
    expect(unseenAttrs).not.toHaveProperty('gen_ai.usage.reasoning.output_tokens');

    // With the wire as witness, the same zeros are a reported miss.
    const seen = new ModelCallTrace({});
    seen.observeWireUsage({
      prompt_tokens: 40,
      completion_tokens: 7,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    });
    seen.observeUsage({
      inputTokens: 40,
      outputTokens: 7,
      inputTokenDetails: { cacheReadTokens: 0 },
      outputTokenDetails: { reasoningTokens: 0 },
    });
    expect(modelCallAttributes(seen)).toMatchObject({
      'gen_ai.usage.cache_read.input_tokens': 0,
      'gen_ai.usage.reasoning.output_tokens': 0,
    });
  });

  it('starts its own trace instead of joining the untraced caller context', async () => {
    const gateway = await gatewayWith(answerWith(FULL_USAGE));
    const first = recorder();
    const second = recorder();

    // A caller with no trace context at all only carries a caller name, and
    // withCaller names its trace 'untraced': one ever-growing trace otherwise.
    const run = (sink: ModelCallSpanSink) =>
      withCaller('messageComposer', () => providerFor(gateway.baseUrl, sink).complete(REQUEST));
    await run(first.sink);
    await run(second.sink);

    const one = spanOf(first.records);
    const two = spanOf(second.records);
    expect(one.traceId).toBe(one.attrs['lifemodel.call_id']);
    expect(two.traceId).toBe(two.attrs['lifemodel.call_id']);
    expect(one.traceId).not.toBe('untraced');
    expect(one.traceId).not.toBe(two.traceId);
    expect(one.parentSpanId).toBeNull();
  });

  it('keeps the sent body and the call result when a recorder throws', async () => {
    const gateway = await gatewayWith(answerWith(FULL_USAGE));
    const spyRequest = vi
      .spyOn(ModelCallTrace.prototype, 'observeRequest')
      .mockImplementation(() => {
        throw new Error('recorder exploded');
      });
    const spyUsage = vi.spyOn(ModelCallTrace.prototype, 'observeUsage').mockImplementation(() => {
      throw new Error('recorder exploded');
    });
    const spyResponse = vi
      .spyOn(ModelCallTrace.prototype, 'observeResponse')
      .mockImplementation(() => {
        throw new Error('recorder exploded');
      });
    try {
      const answer = await providerFor(gateway.baseUrl, recorder().sink, 'low').complete(REQUEST);

      expect(answer.content).toBe('answer');
      // The repaired tool set and the configured effort still went out.
      const sent = JSON.parse(gateway.requests[0]?.body ?? '{}');
      expect(sent.reasoning_effort).toBe('low');
      expect(sent.tools).toHaveLength(1);
      expect(sent.messages).toHaveLength(4);
    } finally {
      spyRequest.mockRestore();
      spyUsage.mockRestore();
      spyResponse.mockRestore();
    }
  });

  it('records the reasoning effort exactly as it went out, and nothing when none was sent', async () => {
    const gateway = await gatewayWith(answerWith(FULL_USAGE));
    const withEffort = recorder();
    const withoutEffort = recorder();

    await providerFor(gateway.baseUrl, withEffort.sink, 'low').complete(REQUEST);
    await providerFor(gateway.baseUrl, withoutEffort.sink).complete(REQUEST);

    expect(spanOf(withEffort.records).attrs['lifemodel.request.reasoning_effort']).toBe('low');
    expect(JSON.parse(gateway.requests[0]?.body ?? '{}').reasoning_effort).toBe('low');
    expect(spanOf(withoutEffort.records).attrs).not.toHaveProperty(
      'lifemodel.request.reasoning_effort'
    );
    expect(JSON.parse(gateway.requests[1]?.body ?? '{}')).not.toHaveProperty('reasoning_effort');
  });

  it('records a failing endpoint with its status and a code, never the error text', async () => {
    const gateway = await gatewayWith((_request, response) => {
      const body = JSON.stringify({ error: { message: 'upstream broke for hello' } });
      response.writeHead(500, {
        'content-type': 'application/json',
        'x-lifemodel-slot': 'reserve',
        'content-length': String(Buffer.byteLength(body)),
      });
      response.end(body);
    });
    const { records, sink } = recorder();

    await expect(providerFor(gateway.baseUrl, sink).complete(REQUEST)).rejects.toThrow();

    const span = spanOf(records);
    expect(span.status).toBe('failed');
    expect(span.attrs).toMatchObject({
      'lifemodel.http.status': 500,
      'lifemodel.slot': 'reserve',
      'lifemodel.error_code': 'http_500',
      'gen_ai.request.model': 'smart-model',
    });
    expect(JSON.stringify(span.attrs)).not.toContain('upstream broke');
  });

  it('hangs the call under the turn trace when there is one and starts its own when there is none', async () => {
    const gateway = await gatewayWith(answerWith(FULL_USAGE));
    const inTurn = recorder();
    const alone = recorder();

    await withTraceContext(
      { traceId: 'turn-1', spanId: 'sig_1', triggerType: 'user_message' },
      () => providerFor(gateway.baseUrl, inTurn.sink).complete(REQUEST)
    );
    await providerFor(gateway.baseUrl, alone.sink).complete(REQUEST);

    const inTurnSpan = spanOf(inTurn.records);
    expect(inTurnSpan.traceId).toBe('turn-1');
    expect(inTurnSpan.parentSpanId).toBe('sig_1');
    expect(inTurnSpan.attrs['lifemodel.trigger_type']).toBe('user_message');
    const aloneSpan = spanOf(alone.records);
    expect(aloneSpan.traceId).toBe(aloneSpan.attrs['lifemodel.call_id']);
    expect(aloneSpan.parentSpanId).toBeNull();
    expect(aloneSpan.attrs).not.toHaveProperty('lifemodel.trigger_type');
  });

  it('names the changed prefix part between two turns in one chat', async () => {
    const gateway = await gatewayWith(answerWith(FULL_USAGE));
    const first = recorder();
    const second = recorder();
    const secondRequest: CompletionRequest = {
      ...REQUEST,
      messages: [
        { role: 'system', content: 'you are the agent' },
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: 'earlier answer' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'a first answer' },
        { role: 'user', content: 'a second message' },
      ],
    };

    await providerFor(gateway.baseUrl, first.sink).complete(REQUEST);
    await providerFor(gateway.baseUrl, second.sink).complete(secondRequest);

    const before = spanOf(first.records).attrs;
    const after = spanOf(second.records).attrs;
    expect(after['lifemodel.prefix.system.hash']).toBe(before['lifemodel.prefix.system.hash']);
    expect(after['lifemodel.prefix.tools.hash']).toBe(before['lifemodel.prefix.tools.hash']);
    expect(after['lifemodel.prefix.history.hash']).not.toBe(
      before['lifemodel.prefix.history.hash']
    );
    expect(after['lifemodel.prefix.context.hash']).not.toBe(
      before['lifemodel.prefix.context.hash']
    );
  });

  it('never delays or fails a call for a full or throwing trace queue', async () => {
    const gateway = await gatewayWith(answerWith(FULL_USAGE));
    const throwing: ModelCallSpanSink = {
      enqueue: () => {
        throw new Error('store exploded');
      },
    };

    const response = await providerFor(gateway.baseUrl, recorder(false).sink).complete(REQUEST);
    expect(response.content).toBe('answer');
    await expect(providerFor(gateway.baseUrl, throwing).complete(REQUEST)).resolves.toMatchObject({
      content: 'answer',
    });
    await expect(
      providerFor(gateway.baseUrl, recorder().sink).complete({ ...REQUEST, role: 'smart' })
    ).resolves.toBeTruthy();
  });

  it('records a refused call that never reached the endpoint', async () => {
    const { records, sink } = recorder();
    const provider = new VercelAIProvider(
      { baseUrl: 'http://127.0.0.1:9/v1', fastModel: 'fast-model' },
      createTestLogger('silent'),
      sink
    );

    await expect(provider.complete({ ...REQUEST, role: 'smart' })).rejects.toThrow(/smart/);

    const span = spanOf(records);
    expect(span.status).toBe('failed');
    expect(span.attrs['lifemodel.error_code']).toBe('configuration');
    expect(span.attrs).not.toHaveProperty('lifemodel.http.status');
  });
});
